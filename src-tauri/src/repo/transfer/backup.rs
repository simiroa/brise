// repo: backup — docs/SYNC.md Phase 0 옵션 0 "백업/복원 완성": DB + 첨부 통짜 zip 왕복.
// export_all(brise-bundle.json)과 달리 byte-exact 스냅샷이다. 단 device_id 는 예외로 복원 시
// 재생성한다 — device_id 는 "데이터"가 아니라 "이 설치본"의 식별자라(G3), zip을 다른 기기에
// 복원(이사/복사)했을 때 원본과 복원본이 같은 id를 공유하면 Phase 2 동기화의 충돌 귀속 축이
// 깨진다. 같은 기기 복구에서 id가 새로 생기는 건 무해하다(아직 아무것도 참조 안 함).
// 출처 추적은 manifest.json의 device_id(백업을 만든 기기)로 남는다.
use crate::db::{self, migrations};
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::util::{new_id, now_iso};
use rusqlite::{Connection, OptionalExtension, MAIN_DB};
use serde::Serialize;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

#[derive(Debug, Serialize)]
pub struct BackupResult {
    pub backup_path: String,
    pub size_bytes: i64,
    /// 이 zip 에 **담기지 않은** 참조 첨부(attachments.ext_path)의 수. 참조 첨부의 원본은 앱 폴더
    /// 밖에 있고 이 백업은 attachments/ 디렉토리만 담으므로 원래부터 빠진다 — 그 사실을 UI 가
    /// 말할 수 있게 세어서 올려보낸다("복원했는데 파일이 없다"를 백업 시점에 미리 알리는 것).
    pub excluded_reference_count: i64,
}

#[derive(Debug, Serialize)]
pub struct RestoreResult {
    /// 스왑 직전에 찍은 현재 상태의 안전 스냅샷 경로(backups/ 안) — 복원이 실수였어도 되돌릴 수 있다.
    pub backup_path: String,
    pub note_count: i64,
}

/// 사람이 읽는 참고용 메타데이터. 복원 로직은 이 파일을 파싱하지 않는다 — 스키마 호환성 판정은
/// brise.db 자체의 schema_migrations 에서 직접 읽는다(신뢰 경계는 DB, 메타는 안내용).
#[derive(Debug, Serialize)]
struct Manifest {
    schema_version: i64,
    app_version: String,
    created_at: String,
    device_id: String,
}

fn read_device_id(conn: &Connection) -> AppResult<String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='device_id'", [], |r| r.get(0))
        .optional()
        .map_err(dberr)?;
    Ok(raw
        .and_then(|v| serde_json::from_str::<String>(&v).ok())
        .unwrap_or_default())
}

/// backup_create 가 데이터 폴더에 잠깐 만드는 스테이징 DB 의 이름 접두사 — `{접두사}{uuid}.db`
/// (+ SQLite 가 붙이는 `-wal`/`-shm`/`-journal`). 만드는 쪽과 부팅 청소(cleanup_stale_staging)가
/// **같은 상수**를 봐야 이름이 갈려 청소가 헛도는 일이 없다.
const STAGING_PREFIX: &str = "brise.backup-staging-";
const STAGING_SUFFIXES: [&str; 4] = [".db", ".db-wal", ".db-shm", ".db-journal"];

fn is_backup_staging_name(name: &str) -> bool {
    name.starts_with(STAGING_PREFIX) && STAGING_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// 백업 도중 앱이 끝나면(트레이 종료·업데이트 설치·크래시·부팅 직후 닫는 벤치) backup_create 끝의
/// 스테이징 삭제까지 못 가서 DB 전체 크기의 파일이 데이터 폴더에 남고, 그걸 치우는 경로가 없었다
/// (실측: perf 폴더에 174MB 짜리 7개). 부팅 때 한 번, 이 프로세스의 어떤 백업보다도 **먼저** 불러서
/// 지난 실행의 잔해만 지운다 — 호출 순서는 lib.rs setup 이 보장한다.
///
/// 데이터 폴더 **바로 아래**(재귀 없음)의 `brise.backup-staging-*.db{,-wal,-shm,-journal}` **파일만**
/// 지운다. brise.db·부팅 스냅샷(brise-*.db)·auto-*.zip·복원 스테이징 등은 이름 규칙에 걸리지 않는다.
pub fn cleanup_stale_staging(data_dir: &Path) {
    let entries = match std::fs::read_dir(data_dir) {
        Ok(entries) => entries,
        Err(e) => {
            crate::diag::warn("backup", "stale_staging_scan_failed", format!("{e}"));
            return;
        }
    };
    let mut removed = 0u64;
    let mut removed_bytes = 0u64;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue };
        if !is_backup_staging_name(name) {
            continue;
        }
        // file_type 은 링크를 따라가지 않는다 — 같은 이름의 폴더·심볼릭 링크는 건드리지 않는다.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {
                removed += 1;
                removed_bytes += len;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // 함정 11: 전체 경로는 남기지 않는다 — 파일 이름(uuid)만.
            Err(e) => crate::diag::warn("backup", "stale_staging_remove_failed", format!("{name}: {e}")),
        }
    }
    if removed > 0 {
        crate::diag::warn(
            "backup",
            "stale_staging_removed",
            format!("files={removed} bytes={removed_bytes}"),
        );
    }
}

/// 전체 백업 — brise.db 스냅샷(온라인 백업 API, WAL 찢어짐 없음) + attachments/ + workspace_bg/ 를
/// 하나의 zip 으로 스트리밍한다(첨부 전체를 임시 디렉토리에 복사하지 않음).
pub fn backup_create(conn: &Connection, data_dir: &Path, dest_path: &Path) -> AppResult<BackupResult> {
    // 라이브 커넥션 위의 파일을 직접 복사하면 WAL 미체크포인트분이 빠져 찢어진 스냅샷이 될 수
    // 있다 — db::snapshot_backup 과 동일하게 온라인 백업 API로 별도 파일에 먼저 만든다.
    let staging_id = new_id();
    let staging_db = data_dir.join(format!("{STAGING_PREFIX}{staging_id}.db"));
    // dest 를 우리가 만들기(truncate) 시작한 뒤에만 실패 잔해를 지운다 — 그 전 실패면 dest 는 남의 파일일 수 있다.
    let dest_created = std::cell::Cell::new(false);
    let partial_path = {
        let mut os = dest_path.as_os_str().to_owned();
        os.push(".partial");
        PathBuf::from(os)
    };
    let write_result = (|| -> AppResult<i64> {
        // L-10: conn.backup() 은 100페이지씩 쪼개 복사하는데, 다른 커넥션이 쓰기를 커밋할 때마다
        // SQLite 온라인 백업이 처음부터 다시 시작(restart)된다.
        // Backup::new()?.step(-1) 로 단일 단계에 전체를 복사하여(단일 읽기 트랜잭션, WAL 은 쓰기 허용)
        // 백그라운드 쓰기 루프 중에도 재시작 없이 한 번에 일관된 스냅샷을 뜬다.
        let excluded_reference_count: i64;
        {
            let mut staged_conn = Connection::open(&staging_db).map_err(dberr)?;
            let backup = rusqlite::backup::Backup::new_with_names(conn, MAIN_DB, &mut staged_conn, MAIN_DB).map_err(dberr)?;
            backup.step(-1).map_err(dberr)?;
            drop(backup);

            // export.rs::is_secret_setting_key 와 동일한 이유(export.rs 주석 참고) — 이 zip은
            // 사용자가 어디든 들고 다니는 파일이라 API 키가 평문으로 실리면 그대로 유출이다. 전체
            // 백업이라도 시크릿만은 마크다운 번들 export와 같은 원칙을 따른다(byte-exact는 "사용자
            // 데이터"에 한정 — device_id처럼 로컬 전용인 값은 실어도 되지만 시크릿은 안 된다).
            // 참조 첨부 개수는 **zip 에 실제로 들어가는 그 스냅샷**에서 센다(라이브 conn 이 아니라).
            excluded_reference_count = staged_conn
                .query_row(
                    "SELECT COUNT(*) FROM attachments WHERE ext_path IS NOT NULL",
                    [],
                    |r| r.get(0),
                )
                .map_err(dberr)?;
            let secret_keys: Vec<String> = staged_conn
                .prepare("SELECT key FROM settings")
                .map_err(dberr)?
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(dberr)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(dberr)?
                .into_iter()
                .filter(|k| super::export::is_secret_setting_key(k))
                .collect();
            for key in secret_keys {
                staged_conn
                    .execute("DELETE FROM settings WHERE key=?1", [&key])
                    .map_err(dberr)?;
            }
            drop(staged_conn);
            for ext in ["-wal", "-shm"] {
                let sidecar = data_dir.join(format!("{STAGING_PREFIX}{staging_id}.db{ext}"));
                if sidecar.exists() {
                    std::fs::remove_file(&sidecar).map_err(io)?;
                }
            }
        }

        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        // R-5: 최종 이름에 바로 쓰지 않는다 — 쓰다 죽으면 잘린 auto-*.zip 이 "최신 백업"으로 보인다. `.partial` 에 쓰고 끝나면 rename.
        let file = std::fs::File::create(&partial_path).map_err(io)?;
        dest_created.set(true);
        let mut zip = zip::ZipWriter::new(file);
        // DB·JSON 은 Deflate, 첨부(이미 압축된 이미지·오디오가 대부분)는 Stored — L-1: 압축 CPU 가 삭제·백업 시간의 대부분이었다.
        let opts = SimpleFileOptions::default();
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        let manifest = Manifest {
            schema_version: migrations::current_version(conn)?,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            created_at: now_iso(),
            device_id: read_device_id(conn)?,
        };
        zip.start_file("manifest.json", opts)
            .map_err(|e| AppError::Io(format!("zip write error: {e}")))?;
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| AppError::Io(format!("manifest serialize error: {e}")))?;
        std::io::Write::write_all(&mut zip, manifest_json.as_bytes()).map_err(io)?;

        zip.start_file(db::DB_FILE, opts)
            .map_err(|e| AppError::Io(format!("zip write error: {e}")))?;
        let mut db_file = std::fs::File::open(&staging_db).map_err(io)?;
        std::io::copy(&mut db_file, &mut zip).map_err(io)?;
        drop(db_file);

        zip_add_dir(&mut zip, &db::attachments_dir(data_dir), "attachments", stored)?;
        zip_add_dir(&mut zip, &db::workspace_bg_dir(data_dir), "workspace_bg", stored)?;

        zip.finish()
            .map_err(|e| AppError::Io(format!("zip finalize error: {e}")))?;
        std::fs::rename(&partial_path, dest_path).map_err(io)?;
        Ok(excluded_reference_count)
    })();

    // NotFound 는 정상(스테이징을 만들기도 전에 실패). 그 밖의 실패는 남긴다 — 여기서 못 지운 잔해는
    // 다음 부팅의 cleanup_stale_staging 이 치운다.
    if let Err(e) = std::fs::remove_file(&staging_db) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::diag::warn("backup", "staging_cleanup_failed", format!("{e}"));
        }
    }
    if write_result.is_err() && dest_created.get() {
        // ZipWriter 의 Drop 은 finish() 를 불러 '열리는 불완전 zip'을 남긴다 — 실패하면 `.partial` 을 통째로 지운다(R-5 부터
        // 최종 이름에는 쓰지 않으므로 사용자의 기존 파일은 건드리지 않는다). 지울 수 없으면 진단에 남긴다.
        if let Err(e) = std::fs::remove_file(&partial_path) {
            crate::diag::warn("backup", "partial_zip_cleanup_failed", format!("{e}"));
        }
    }
    let excluded_reference_count = write_result?;

    let size_bytes = std::fs::metadata(dest_path).map_err(io)?.len() as i64;
    Ok(BackupResult {
        backup_path: dest_path.to_string_lossy().to_string(),
        size_bytes,
        excluded_reference_count,
    })
}

// ── Settings redesign (Données ②): 사용자 설정 자동 전체 백업 ─────────────────────────────
// db/mod.rs 의 부팅시 DB-only 스냅샷(brise-*.db, KEEP_BACKUPS=3, snapshot_backup/rotate_backups)
// 은 R3 손상 복구 안전망이고 그대로 둔다 — bootstrap()의 자동 복구(restore_from_backup)가 그
// 파일명 패턴에 의존하기 때문(newest_backup 이 "brise-"+".db" 만 본다). 이 아래는 완전히 별개의,
// 사용자가 스케줄을 고르는 전체(zip) 백업이라 파일명 접두사를 다르게 써서(auto-*.zip) 두 회전이
// 서로의 파일을 절대 건드리지 않는다.
const AUTO_BACKUP_PREFIX: &str = "auto-";

/// `.zip` 으로 끝나야 하므로 쓰는 중인 `auto-*.zip.partial` 은 자연히 제외된다(R-5) — 최신 판정·회전 모두 이 규칙을 쓴다.
fn is_auto_backup_name(name: &str) -> bool {
    name.starts_with(AUTO_BACKUP_PREFIX) && name.ends_with(".zip")
}

/// backups/ 안의 auto-*.zip 중 가장 최신(파일명이 고정 폭 타임스탬프라 사전순 최댓값 = 최신).
pub fn newest_auto_backup(backups: &Path) -> Option<PathBuf> {
    std::fs::read_dir(backups)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(is_auto_backup_name).unwrap_or(false))
        .max()
}

/// 순수 함수(파일 I/O 없음) — 상한 없는 스케줄 판단을 테스트하기 쉽게 분리했다.
/// interval="off" 는 항상 false. 최신 백업이 없으면(첫 실행) off 가 아닌 한 항상 true.
pub fn auto_backup_due(
    newest_mtime: Option<std::time::SystemTime>,
    interval: &str,
    now: std::time::SystemTime,
) -> bool {
    if interval == "off" {
        return false;
    }
    let Some(mtime) = newest_mtime else { return true };
    let days = if interval == "daily" { 1 } else { 7 }; // "weekly" 및 알 수 없는 값은 주간 취급
    let elapsed = now.duration_since(mtime).unwrap_or_default();
    elapsed >= std::time::Duration::from_secs(days * 24 * 3600)
}

/// backups/ 의 auto-*.zip 만 최신 `keep`개 남기고 삭제한다 — brise-*.db(R3)나 사용자가 임의로
/// 저장한 zip(백업 대상 폴더로 backups/ 를 고른 경우)은 이름 패턴이 달라 건드리지 않는다.
pub fn rotate_auto_backups(backups: &Path, keep: usize) -> AppResult<()> {
    rotate_prefixed_zips(backups, AUTO_BACKUP_PREFIX, keep)
}

fn rotate_prefixed_zips(backups: &Path, prefix: &str, keep: usize) -> AppResult<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(backups)
        .map_err(io)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(".zip"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.len() > keep {
        for old in &files[..files.len() - keep] {
            std::fs::remove_file(old).map_err(io)?;
        }
    }
    Ok(())
}

/// 스케줄 자동 백업 1회 실행 + 회전. 독립 커넥션을 새로 연다 — 호출자(부팅 백그라운드 스레드
/// 또는 "지금 백업" 커맨드) 어느 쪽도 앱의 공유 state.db 락을 전체 zip 쓰기 시간만큼 쥐고 있으면
/// 안 된다(WAL 모드라 동시 읽기 커넥션은 안전).
pub fn auto_backup_run(data_dir: &Path, keep: usize) -> AppResult<BackupResult> {
    let mut conn = match db::open(&db::db_path(data_dir)) {
        Ok(c) => c,
        Err(e) => {
            // U7(AUDIT-2026-09-26-fallback-observability.md) — db::open 자체가 여기서 실패하면
            // `?`로 바로 빠져나가 아래 record_auto_backup_error 를 전혀 못 지나서, 이 실패가
            // backup_auto_last_error 설정 키에 한 번도 안 남았다(db/mod.rs 의 catch-all eprintln
            // 뿐이었다). 방금 연 게 실패했으니 같은 커넥션으로 설정을 쓸 방법은 없다 — 한 번 더
            // 열어보고(성공하면 그걸로 기록), 그마저 안 되면 설정 기록은 포기하되 diag 는
            // 무조건 남긴다(사용자가 설정 화면 밖에서도 원인을 알 수 있게).
            if let Ok(mut retry_conn) = db::open(&db::db_path(data_dir)) {
                record_auto_backup_error(&mut retry_conn, Some(&e));
            }
            crate::diag::error("backup", "auto_backup_open_failed", format!("{e}"));
            return Err(e);
        }
    };
    // 리스크 감사 A: db::open 성공 이후의 모든 실패(디렉토리 생성/zip 생성/회전)를 클로저로
    // 감싸 하나의 지점에서 기록한다 — 예전엔 backup_create 실패만 반영되고 create_dir_all/
    // rotate_auto_backups 실패는 기록 없이 새어나갔다.
    let result = (|| -> AppResult<BackupResult> {
        let backups = db::backups_dir(data_dir);
        std::fs::create_dir_all(&backups).map_err(io)?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%6f");
        let dest = backups.join(format!("{AUTO_BACKUP_PREFIX}{stamp}.zip"));
        let r = backup_create(&conn, data_dir, &dest)?;
        rotate_auto_backups(&backups, keep)?;
        Ok(r)
    })();
    // 실패가 eprintln! 한 줄로 사라지던 것을 설정 키에 기록해 설정 화면에서 발견 가능하게 한다.
    // 성공하면 이전 실패 기록을 비운다(silent-forever 방지).
    record_auto_backup_error(&mut conn, result.as_ref().err());
    result
}

const PRE_DELETE_PREFIX: &str = "pre-delete-";
const PRE_DELETE_KEEP: usize = 3;

/// 노트북 삭제 직전 강제 전체 백업(pre-delete-*.zip, 최신 3개 회전). auto-* 와 접두사가 달라
/// 서로의 회전이 건드리지 않는다. 독립 커넥션 — 호출자는 공유 db 락을 쥐지 않은 채 불러야 한다.
/// 실패하면 Err — 호출자는 삭제를 중단해야 한다.
pub fn pre_delete_backup(data_dir: &Path) -> AppResult<BackupResult> {
    let conn = db::open(&db::db_path(data_dir))?;
    let backups = db::backups_dir(data_dir);
    std::fs::create_dir_all(&backups).map_err(io)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%6f");
    let dest = backups.join(format!("{PRE_DELETE_PREFIX}{stamp}.zip"));
    let r = backup_create(&conn, data_dir, &dest)?;
    rotate_prefixed_zips(&backups, PRE_DELETE_PREFIX, PRE_DELETE_KEEP)?;
    Ok(r)
}

/// backup_auto_last_error 설정 키에 마지막 자동 백업 실패를 기록(또는 성공 시 비움).
/// 쓰기 실패는 호출자에겐 삼킨다(이 기록 자체가 백업 성패를 좌우해선 안 된다, best-effort
/// 진단 정보) — 대신 diag::warn 으로 남겨 완전히 새지는 않게 한다(U7).
fn record_auto_backup_error(conn: &mut Connection, err: Option<&AppError>) {
    let value = match err {
        Some(e) => format!("{}: {e}", now_iso()),
        None => String::new(),
    };
    let mut entries = std::collections::BTreeMap::new();
    entries.insert("backup_auto_last_error".to_string(), serde_json::Value::String(value));
    if let Err(e) = crate::repo::settings::set(conn, &entries) {
        crate::diag::warn("backup", "last_error_write_failed", format!("{e}"));
    }
}

/// 상태 커맨드(backup_auto_status)용 — 가장 최근 auto 백업의 mtime 을 ISO 문자열로.
pub fn auto_backup_last(data_dir: &Path) -> Option<String> {
    let backups = db::backups_dir(data_dir);
    let p = newest_auto_backup(&backups)?;
    let mtime = std::fs::metadata(&p).ok()?.modified().ok()?;
    let dt: chrono::DateTime<chrono::Utc> = mtime.into();
    Some(dt.to_rfc3339())
}

fn zip_add_dir(
    zip: &mut zip::ZipWriter<std::fs::File>,
    dir: &Path,
    prefix: &str,
    opts: SimpleFileOptions,
) -> AppResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        let path = entry.path();
        let zip_path = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        if path.is_dir() {
            zip_add_dir(zip, &path, &zip_path, opts)?;
        } else {
            zip.start_file(&zip_path, opts)
                .map_err(|e| AppError::Io(format!("zip write error: {e}")))?;
            let mut f = std::fs::File::open(&path).map_err(io)?;
            std::io::copy(&mut f, zip).map_err(io)?;
        }
    }
    Ok(())
}

/// 검증 통과 후 스왑에 쓸 준비된(스테이징) 경로들. 이 셋이 모두 채워진 뒤에야 라이브 상태를 건드린다.
/// backup_restore(zip 에서)와 db_reset(빈 DB 로 — reset.rs)이 같이 쓴다.
pub(super) struct Staged {
    pub(super) db_path: PathBuf,
    pub(super) att_path: PathBuf,
    pub(super) bg_path: PathBuf,
}

/// 라이브 attachments/ 와 **같은 부모** 아래의 형제 경로 — 스테이징·옛 첨부 자리는 여기 둔다.
/// 저장 위치 재정의(db::set_dir_overrides)로 attachments/ 가 data_dir 밖(다른 볼륨)에 있으면
/// data_dir 쪽 자리로는 rename 이 볼륨을 건너 실패한다. 재정의가 없으면 부모 = data_dir 그대로.
pub(super) fn attachments_sibling(data_dir: &Path, name: &str) -> PathBuf {
    let live = db::attachments_dir(data_dir);
    live.parent().unwrap_or(data_dir).join(name)
}

/// zip → 스테이징 디렉토리/파일. 실패 시 스테이징 잔여물을 정리하고 에러를 반환한다 — 이 함수가
/// 끝나기 전까지는 라이브 DB/attachments/workspace_bg 를 전혀 건드리지 않는다(import.rs replace
/// 모드의 "복사 먼저, 커밋은 나중" 순서와 동일한 이유 — 실패해도 기존 상태가 100% 그대로여야 한다).
fn stage_from_zip(data_dir: &Path, zip_path: &Path, cur_schema: i64) -> AppResult<Staged> {
    let id = new_id();
    let staged_db = data_dir.join(format!("brise.restore-incoming-{id}.db"));
    let staged_att = attachments_sibling(data_dir, &format!("attachments.incoming-{id}"));
    let staged_bg = data_dir.join(format!("workspace_bg.incoming-{id}"));

    let result = (|| -> AppResult<()> {
        let file = std::fs::File::open(zip_path).map_err(io)?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| AppError::Validation(format!("invalid backup zip: {e}")))?;

        // Zip-slip 가드(R5): 모든 항목이 자기 트리 안에 머무는지 라이브 상태를 건드리기 전에
        // 통째로 먼저 검사한다. attachments::safe_rel 과 동일한 검증(paths.rs)을 재사용.
        for i in 0..archive.len() {
            let entry = archive
                .by_index(i)
                .map_err(|e| AppError::Validation(format!("zip read error: {e}")))?;
            let name = entry.name();
            if !name.ends_with('/') {
                crate::repo::paths::safe_rel(name)?;
            }
        }

        // attachments/workspace_bg 는 비어 있어도 항상 존재해야 한다(db::bootstrap 의 불변식과
        // 동일) — zip에 해당 prefix 항목이 하나도 없어도(빈 첨부 라이브러리, 또는 그 기능이 없던
        // 구버전 백업) 스왑 단계의 rename 대상이 있어야 하므로 미리 만들어 둔다.
        std::fs::create_dir_all(&staged_att).map_err(io)?;
        std::fs::create_dir_all(&staged_bg).map_err(io)?;

        let db_idx = archive.index_for_name(db::DB_FILE).ok_or_else(|| {
            AppError::Validation(format!("backup zip is missing {}", db::DB_FILE))
        })?;
        {
            let mut entry = archive
                .by_index(db_idx)
                .map_err(|e| AppError::Validation(format!("zip error: {e}")))?;
            let mut out = std::fs::File::create(&staged_db).map_err(io)?;
            std::io::copy(&mut entry, &mut out).map_err(io)?;
        }

        // 스키마 호환성 + 손상 여부 — bootstrap 이 복구 후 항상 재검증하는 것과 같은 이유
        // (백업 자체도 손상됐을 수 있다). 여기서 걸러야 라이브 상태를 건드리지 않는다.
        {
            let tmp_conn = Connection::open(&staged_db).map_err(dberr)?;
            let backup_schema = migrations::current_version(&tmp_conn)?;
            let qc = db::quick_check(&tmp_conn);
            drop(tmp_conn);
            for ext in ["-wal", "-shm"] {
                let sidecar = data_dir.join(format!("brise.restore-incoming-{id}.db{ext}"));
                if sidecar.exists() {
                    std::fs::remove_file(&sidecar).map_err(io)?;
                }
            }
            qc?;
            // backup_schema==0 은 schema_migrations 테이블 자체가 없는 파일 — Brise DB가 아닌
            // 임의의 sqlite 파일이 brise.db 자리에 들어와도 통과시키면 안 된다(fail-closed).
            // 신버전 백업은 이 앱이 모르는 마이그레이션을 요구할 수 있어 거부(원칙: 옵션 0 설계).
            if backup_schema < 1 || backup_schema > cur_schema {
                return Err(AppError::Validation(format!(
                    "backup schema version {backup_schema} is not compatible with this app's schema {cur_schema} \
                     (older is fine — newer requires updating the app first)"
                )));
            }
        }

        // 첨부/배경 이미지를 스테이징 디렉토리로 스트리밍(라이브 트리는 아직 미동).
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| AppError::Validation(format!("zip error: {e}")))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let (base, rel) = if let Some(rel) = name.strip_prefix("attachments/") {
                (&staged_att, rel)
            } else if let Some(rel) = name.strip_prefix("workspace_bg/") {
                (&staged_bg, rel)
            } else {
                continue; // brise.db / manifest.json / 알 수 없는 최상위 항목 — 트리 복사 대상 아님
            };
            if rel.is_empty() {
                continue;
            }
            let safe = crate::repo::paths::safe_rel(rel)?;
            let dest = base.join(&safe);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            let mut out = std::fs::File::create(&dest).map_err(io)?;
            std::io::copy(&mut entry, &mut out).map_err(io)?;
        }

        Ok(())
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&staged_db);
        let _ = std::fs::remove_dir_all(&staged_att);
        let _ = std::fs::remove_dir_all(&staged_bg);
        return Err(e);
    }

    Ok(Staged {
        db_path: staged_db,
        att_path: staged_att,
        bg_path: staged_bg,
    })
}

/// 전체 복원 — 검증(zip 유효성/스키마 호환성/무결성)을 전부 통과한 뒤에만 라이브 상태를 스왑한다.
/// 스왑 자체는 rename 위주(거의 실패하지 않음)로 좁혀 "검증 실패 = 기존 상태 100% 보존"을 보장한다.
pub fn backup_restore(
    conn: &mut Connection,
    data_dir: &Path,
    zip_path: &Path,
    confirm: &str,
) -> AppResult<RestoreResult> {
    if confirm != "RESTORE" {
        return Err(AppError::Validation("confirm must equal 'RESTORE'".to_string()));
    }
    let cur_schema = migrations::current_version(conn)?;
    // 여기서 실패하면 스테이징 자체가 실패한 것 — 라이브 상태는 전혀 손대지 않았다.
    let staged = stage_from_zip(data_dir, zip_path, cur_schema)?;

    // 안전망: 스왑 직전 현재 라이브 상태를 한 번 더 스냅샷(db_reset 과 동일한 관례) — 사용자가
    // 엉뚱한 zip을 골랐어도 backups/ 에서 되돌릴 수 있다.
    let safety_backup = db::snapshot_backup(conn, &db::backups_dir(data_dir))?;
    // 백업 zip 에는 비밀이 없다(backup_create) — 복원본으로 갈아끼우면 이 설치본의 AI 키·보관함이
    // 사라지므로 스왑 전에 읽어 두었다가 새 DB 에 되돌려 넣는다.
    let secrets = super::import::read_secret_settings(conn)?;

    // sync_token 은 일부러 되돌리지 않는다(swap_live_state 주석 — 복원 뒤 동기화는 꺼진 채 시작). AI 키류만 이월.
    let carry: Vec<_> = secrets.into_iter().filter(|(k, _)| k != "sync_token").collect();
    swap_live_state(conn, data_dir, staged, &safety_backup, &carry, "restore")?;

    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .map_err(dberr)?;

    Ok(RestoreResult {
        backup_path: safety_backup.to_string_lossy().to_string(),
        note_count,
    })
}

/// 스왑의 파일 삭제 단계용 io 에러 변환 — Windows 공유 위반(os error 32)은 다른 연결이 brise.db 를
/// 잡고 있다는 뜻이라, 일반 io 에러 대신 사용자가 할 수 있는 일을 말해 준다.
/// ponytail: 백그라운드 연결(수집 러너·일정/EXIF 워커·동기화 서버 핸들러·자동 백업)은 각자 db::open 을
/// 하고, with_db_file_swap 은 채팅 읽기 연결만 닫는다. 그래서 그들이 열려 있는 순간의 스왑은 Windows 에선
/// 여기서 실패하고(되돌림 경로로 안전), Unix 에선 unlink 된 옛 inode 에 늦은 쓰기가 사라질 수 있다.
/// 천장: 워커가 db::open 전에 확인하는 일시정지(quiesce) 게이트를 스왑 내내 잡으면 해결된다.
fn file_in_use(e: std::io::Error) -> AppError {
    if e.raw_os_error() == Some(32) {
        AppError::Io(format!(
            "the database file is in use by another connection (sync server, collect or a background worker) - turn off sync, wait for running collect jobs and retry ({e})"
        ))
    } else {
        io(e)
    }
}

/// 스테이징된 DB·첨부·배경 이미지로 라이브 상태를 통째로 갈아끼운다 — backup_restore 와 db_reset 공용.
/// 성공하면 `*conn` 은 새 라이브 커넥션이다. 호출자는 이미 `safety_backup` 스냅샷을 찍어 뒀어야 한다
/// (실패 시 그걸로 되돌린다). `carry_secrets` 는 새 DB 에 되돌려 넣을 이 설치본의 비밀 설정,
/// `op` 는 에러 메시지용 이름("restore"/"reset").
/// 스왑 자체는 rename 위주(거의 실패하지 않음)로 좁혀 "검증 실패 = 기존 상태 100% 보존"을 보장한다.
pub(super) fn swap_live_state(
    conn: &mut Connection,
    data_dir: &Path,
    staged: Staged,
    safety_backup: &Path,
    carry_secrets: &[(String, String)],
    op: &str,
) -> AppResult<()> {
    // 라이브 커넥션을 놓아야 Windows에서 파일 교체(rename)가 가능하다(핸들이 열려 있으면 실패).
    // 채팅 검색의 읽기 연결도 같은 이유로 호출자가 닫아 둬야 한다(AppState::with_db_file_swap).
    let placeholder = Connection::open_in_memory().map_err(dberr)?;
    let old_conn = std::mem::replace(conn, placeholder);
    drop(old_conn);

    let live_db = db::db_path(data_dir);
    let old_att = attachments_sibling(data_dir, &format!("attachments.old-{}", new_id()));
    let old_bg = data_dir.join(format!("workspace_bg.old-{}", new_id()));
    let live_att = db::attachments_dir(data_dir);
    let live_bg = db::workspace_bg_dir(data_dir);
    let outcome: AppResult<Connection> = (|| {
        for ext in ["-wal", "-shm"] {
            let sidecar = data_dir.join(format!("{}{ext}", db::DB_FILE));
            if sidecar.exists() {
                std::fs::remove_file(&sidecar).map_err(file_in_use)?;
            }
        }
        if live_db.exists() {
            std::fs::remove_file(&live_db).map_err(file_in_use)?;
        }
        std::fs::rename(&staged.db_path, &live_db).map_err(io)?;

        if live_att.exists() {
            std::fs::rename(&live_att, &old_att).map_err(io)?;
        }
        std::fs::rename(&staged.att_path, &live_att).map_err(io)?;
        if live_bg.exists() {
            std::fs::rename(&live_bg, &old_bg).map_err(io)?;
        }
        std::fs::rename(&staged.bg_path, &live_bg).map_err(io)?;

        let mut new_conn = db::open(&live_db)?;
        migrations::run(&mut new_conn)?;
        db::scrub_zero_row_stats(&new_conn);
        // 파일 상단 주석 참고: 복원본은 새 설치본이므로 백업 출처 기기의 device_id 를 버리고
        // 재생성한다(초기화의 빈 DB 엔 애초에 없다 — 같은 줄로 새로 만든다).
        new_conn
            .execute("DELETE FROM settings WHERE key='device_id'", [])
            .map_err(dberr)?;
        crate::repo::settings::ensure_device_id(&new_conn)?;
        // export.rs::is_device_local_setting_key 와 같은 이유(G3 device_id 와 동급) — sync_enabled
        // 는 "이 설치본"의 로컬 서버 on/off 상태다. 복원된 기기가 백업 출처 기기의 sync_enabled=true
        // 를 그대로 이어받아 조용히(사용자가 한 번도 켠 적 없는데) 토큰 있는 서버를 자동 기동하면
        // 안 된다(sync_server::maybe_start_at_boot 는 enabled && token 비어있지 않음을 함께 본다).
        // sync_token 은 backup_create 단계에서 이미 is_secret_setting_key 로 스테이징 사본에서
        // 지워지지만(위 함수 주석), 여기서도 명시적으로 비워 두 경로 중 하나가 바뀌어도 안전하게
        // 한다. 삭제만 하면 settings::get_all() 이 default_settings() 의 false/"" 로 폴백한다 —
        // sync_port 는 민감하지 않으므로(그냥 숫자) device_id/sync_enabled 와 달리 그대로 둔다.
        new_conn
            .execute("DELETE FROM settings WHERE key IN ('sync_enabled', 'sync_token')", [])
            .map_err(dberr)?;
        super::import::restore_secret_settings(&new_conn, carry_secrets)?;
        Ok(new_conn)
    })();

    match outcome {
        Ok(new_conn) => {
            *conn = new_conn;
            // 옛 트리는 새 DB 가 완전히 열린 **뒤에만** 지운다 — 그 전에 지우면 아래 실패 경로가
            // 스냅샷 DB 로 되돌려도 그 DB 가 가리키는 첨부·배경은 이미 사라진 뒤다.
            // 삭제 실패는 스왑을 되돌릴 이유가 아니지만(데이터는 새 자리에 있다), 디스크를 조용히
            // 먹는 잔여물이라 기록은 남긴다(파일 이름만 — 전체 경로 금지).
            for (old, label) in [(&old_att, "attachments.old"), (&old_bg, "workspace_bg.old")] {
                if old.exists() {
                    if let Err(e) = std::fs::remove_dir_all(old) {
                        crate::diag::warn("backup", "old_tree_remove_failed", format!("{op} {label}: {e}"));
                    }
                }
            }
            Ok(())
        }
        Err(e) => {
            // 디렉토리부터 제자리로 — DB 를 아래에서 스냅샷으로 되돌리므로 첨부·배경도 옛 트리여야
            // 짝이 맞는다. old 가 있다는 건 이번 호출의 rename(live → old)이 성공했다는 뜻이고,
            // 그때 live 자리는 비었거나 스테이징 사본이다(지워도 되는 쪽).
            for (old, live, label) in [(&old_att, &live_att, "attachments"), (&old_bg, &live_bg, "workspace_bg")] {
                if !old.exists() {
                    continue;
                }
                let back = (|| -> std::io::Result<()> {
                    if live.exists() {
                        std::fs::remove_dir_all(live)?;
                    }
                    std::fs::rename(old, live)
                })();
                if let Err(re) = back {
                    crate::diag::warn("backup", "tree_rollback_failed", format!("{op} {label}: {re}"));
                }
            }
            // ponytail: 이 지점의 실패(rename/재오픈/마이그레이션)는 이미 검증을 마친 스테이징
            // 파일에 대한 디스크 수준 사고에 가깝다 — conn을 in-memory 로 방치하지 않도록
            // 방금 찍은 안전 스냅샷으로 되돌려 재오픈을 한 번 시도한다. 그마저 실패하면 앱 재시작
            // (bootstrap의 손상 복구 경로)이 실질적 복구 수단이다.
            let _ = std::fs::copy(safety_backup, &live_db);
            if let Ok(mut recovered) = db::open(&live_db) {
                let _ = migrations::run(&mut recovered);
                *conn = recovered;
            }
            // 위 되돌리기마저 실패했으면 기존 트리가 old 자리에 남아 사라진 것처럼 보인다 —
            // 메시지에 경로를 남겨 수동 복구 가능하게 한다.
            let mut msg = format!(
                "{op} failed after replacing files: {e}. Safety snapshot of the previous state: {}",
                safety_backup.display()
            );
            if old_att.exists() {
                msg.push_str(&format!(" Previous attachments preserved at: {}.", old_att.display()));
            }
            if old_bg.exists() {
                msg.push_str(&format!(" Previous workspace_bg preserved at: {}.", old_bg.display()));
            }
            // 스왑 전 단계에서 실패했으면 스테이징 잔여물이 남는다 — 지워도 되는 사본이다.
            let _ = std::fs::remove_file(&staged.db_path); // silent-ok: 이미 rename 됐거나 없는 사본
            let _ = std::fs::remove_dir_all(&staged.att_path); // silent-ok: 같은 이유
            let _ = std::fs::remove_dir_all(&staged.bg_path); // silent-ok: 같은 이유
            Err(AppError::Db(msg))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::util::now_iso;
    use rusqlite::params;

    /// 테스트 전용 zip 빌더 — 임의의(악의적 포함) 항목 이름을 그대로 담는다(start_file_from_path
    /// 와 달리 sanitize 하지 않음 — 그래서 zip-slip 재현에 쓸 수 있다).
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zip, bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn seed_note(conn: &Connection, id: &str, title: &str) {
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status)
             VALUES (?1, ?2, ?3, 2000, 0, NULL, ?4, ?4, NULL, NULL)",
            params![id, folder_id, title, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1, ?2, 'Body', 'original body', 0)",
            params![crate::util::new_id(), id],
        )
        .unwrap();
    }

    #[test]
    fn roundtrip_restores_notes_attachments_and_clears_later_tombstones() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();

        seed_note(&conn, "note1", "Original title");

        // 파일 첨부 — content_hash(G4)까지 채워지는 정식 경로(attachments::add_file)로 추가.
        let src_dir = tempfile::tempdir().unwrap();
        let src_file = src_dir.path().join("photo.png");
        std::fs::write(&src_file, b"original bytes").unwrap();
        let att = crate::repo::attachments::add_file(
            &mut conn,
            data_dir.path(),
            "note1",
            src_file.to_str().unwrap(),
        )
        .unwrap();
        let rel_path = att.rel_path.clone().unwrap();
        let content_hash_before: String = conn
            .query_row(
                "SELECT content_hash FROM attachments WHERE id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();

        // workspace_bg/ 도 attachments/ 와 형제 트리로 왕복되어야 한다(db::WORKSPACE_BG_DIR 참고 —
        // attachments 밑에 두면 orphan_cleanup 오작동).
        let bg_dir = db::workspace_bg_dir(data_dir.path());
        std::fs::create_dir_all(&bg_dir).unwrap();
        std::fs::write(bg_dir.join("ws1.jpg"), b"original bg bytes").unwrap();

        let device_id_before = read_device_id(&conn).unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        let backed_up = backup_create(&conn, data_dir.path(), &zip_path).unwrap();
        assert!(backed_up.size_bytes > 0);

        // 백업 이후 라이브 상태를 어지럽힌다: 제목 변경, 첨부/배경 파일 내용 변경, 새 노트, 새 tombstone.
        conn.execute("UPDATE notes SET title='Mutated title' WHERE id='note1'", [])
            .unwrap();
        std::fs::write(db::attachments_dir(data_dir.path()).join(&rel_path), b"tampered").unwrap();
        std::fs::write(bg_dir.join("ws1.jpg"), b"tampered bg").unwrap();
        seed_note(&conn, "note2", "Should disappear after restore");
        conn.execute(
            "INSERT INTO deleted_rows(tbl, id, deleted_at) VALUES ('notes', 'ghost', ?1)",
            params![now_iso()],
        )
        .unwrap();

        let restored = backup_restore(&mut conn, data_dir.path(), &zip_path, "RESTORE").unwrap();
        assert_eq!(restored.note_count, 1);

        let restored_bg = std::fs::read(db::workspace_bg_dir(data_dir.path()).join("ws1.jpg")).unwrap();
        assert_eq!(restored_bg, b"original bg bytes");

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE id='note1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Original title");

        let note2_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id='note2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note2_count, 0, "note added after backup must not survive restore");

        let tombstone_count: i64 = conn.query_row("SELECT COUNT(*) FROM deleted_rows", [], |r| r.get(0)).unwrap();
        assert_eq!(tombstone_count, 0, "tombstone added after backup must not survive restore");

        let restored_bytes = std::fs::read(db::attachments_dir(data_dir.path()).join(&rel_path)).unwrap();
        assert_eq!(restored_bytes, b"original bytes");

        let content_hash_after: String = conn
            .query_row(
                "SELECT content_hash FROM attachments WHERE id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(content_hash_after, content_hash_before);

        // 복원본은 새 설치본 — device_id 는 존재하되 백업 출처의 것과 달라야 한다(파일 상단 주석).
        let device_id_after = read_device_id(&conn).unwrap();
        assert_ne!(device_id_after, device_id_before, "restore must regenerate device_id");

        drop(conn);
    }

    #[test]
    fn restore_refuses_backup_with_newer_schema_and_leaves_live_state_untouched() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "marker", "Untouched marker");

        // "미래" 스냅샷: 이 앱이 모르는 마이그레이션 버전을 하나 얹은 뒤 온라인 백업 API로 파일을 뜬다.
        let cur = migrations::current_version(&conn).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![cur + 1, now_iso()],
        )
        .unwrap();
        let future_db = data_dir.path().join("future.db");
        conn.backup(MAIN_DB, &future_db, None).unwrap();
        // 방금 얹은 가짜 미래 버전 행은 라이브 conn 에서는 되돌린다(이후 라이브 검증에 영향 없게).
        conn.execute("DELETE FROM schema_migrations WHERE version=?1", params![cur + 1])
            .unwrap();

        let zip_path = data_dir.path().join("future-backup.zip");
        let db_bytes = std::fs::read(&future_db).unwrap();
        make_zip(&zip_path, &[(db::DB_FILE, &db_bytes)]);

        let err = backup_restore(&mut conn, data_dir.path(), &zip_path, "RESTORE").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE id='marker'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Untouched marker", "live state must be untouched after a refused restore");

        drop(conn);
    }

    #[test]
    fn restore_rejects_zip_slip_entry_and_leaves_live_state_untouched() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "marker", "Untouched marker");

        // 유효한 brise.db 스냅샷(스키마는 통과) + 탈출 시도 항목.
        let staging_db = data_dir.path().join("valid.db");
        conn.backup(MAIN_DB, &staging_db, None).unwrap();
        let db_bytes = std::fs::read(&staging_db).unwrap();

        let zip_path = data_dir.path().join("evil-backup.zip");
        make_zip(
            &zip_path,
            &[
                (db::DB_FILE, &db_bytes),
                ("attachments/../../evil.txt", b"pwned"),
            ],
        );

        let err = backup_restore(&mut conn, data_dir.path(), &zip_path, "RESTORE").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // data_dir 한 단계 밖(=attachments/../.. 가 가리키는 자리)에 파일이 새로 생기지 않아야 한다.
        assert!(!data_dir.path().parent().unwrap().join("evil.txt").exists());

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE id='marker'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Untouched marker", "live state must be untouched after a rejected zip-slip restore");

        drop(conn);
    }

    /// export.rs::secret_setting_keys_are_excluded_from_bundle 와 동일한 불변식 — 이 zip은
    /// 사용자가 어디든 들고 다니는 파일이라 API 키가 평문으로 실리면 안 된다(전체 백업이라도).
    #[test]
    fn backup_zip_excludes_secret_settings() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('ai_api_key', ?1)",
            params!["\"sk-super-secret\""],
        )
        .unwrap();
        // 비활성 프로바이더 키 보관함도 같은 비밀이다(export::is_secret_setting_key).
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('ai_provider_creds', ?1)",
            params![r#"{"openai":{"api_key":"sk-stashed-secret"}}"#],
        )
        .unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        backup_create(&conn, data_dir.path(), &zip_path).unwrap();

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut db_bytes = Vec::new();
        std::io::Read::read_to_end(&mut archive.by_name(db::DB_FILE).unwrap(), &mut db_bytes).unwrap();
        let extracted_db = data_dir.path().join("extracted.db");
        std::fs::write(&extracted_db, &db_bytes).unwrap();

        let staged_conn = Connection::open(&extracted_db).unwrap();
        let secret_count: i64 = staged_conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='ai_api_key'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(secret_count, 0, "backup zip must not carry the plaintext API key");
        let stash_count: i64 = staged_conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='ai_provider_creds'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stash_count, 0, "backup zip must not carry the stashed per-provider keys");

        // live conn은 그대로 시크릿을 유지해야 한다(백업은 스테이징 사본만 걸러낸다).
        let live_secret: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='ai_api_key'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live_secret, 1);
        let live_stash: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='ai_provider_creds'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live_stash, 1);

        drop(staged_conn);
        drop(conn);
    }

    /// export.rs::sync_setting_keys_are_device_local 의 백업(byte-exact zip) 대응판 — 백업 자체는
    /// device_id 처럼 sync_enabled/sync_port 를 실어도 되지만(로컬 전용 값, 시크릿 아님), 복원 후에는
    /// device_id 와 마찬가지로 "이 설치본"의 상태로 재설정되어야 한다: sync_enabled=true 를 이어받아
    /// 조용히 서버가 자동 기동하면 안 되고, 토큰은 백업 출처의 것이 아니라 빈 값(다음 활성화 시 재생성)
    /// 이어야 한다.
    #[test]
    fn restore_does_not_preserve_sync_enabled_or_carry_over_the_sync_token() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "marker", "Untouched marker");

        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('sync_enabled', 'true')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('sync_token', '\"source-device-token\"')",
            [],
        )
        .unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        backup_create(&conn, data_dir.path(), &zip_path).unwrap();

        // restore replaces the WHOLE live db file from the zip (rename, not a settings-by-settings
        // merge) — so live-conn state right before restore is irrelevant to what lands afterward.
        // Leaving sync_enabled=true here (matching what's actually in the zip) is what makes this
        // test able to fail: if backup_restore's post-restore DELETE were removed, the byte-exact
        // zip snapshot would carry sync_enabled=true straight through and this assertion would catch it.
        backup_restore(&mut conn, data_dir.path(), &zip_path, "RESTORE").unwrap();

        // Assert absence from the settings TABLE directly, not just settings::get_all()'s
        // default-filled view — a row that was never re-inserted and a row explicitly set to the
        // default value would both read the same through get_all(), but only the former proves
        // backup_restore's DELETE actually ran (see backup_restore's DELETE FROM settings WHERE
        // key IN ('sync_enabled', 'sync_token')).
        let sync_enabled_row: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='sync_enabled'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert_eq!(
            sync_enabled_row, None,
            "restore must delete sync_enabled from the settings table (never leave it =true, which would auto-start a server on the next boot)"
        );
        let sync_token_row: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='sync_token'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert_eq!(
            sync_token_row, None,
            "restore must delete sync_token from the settings table (never carry over the source device's token)"
        );

        // And the app-facing read (settings::get_all, what sync_server::maybe_start_at_boot and
        // commands/sync.rs actually consume) must fall back to the safe defaults.
        let settings = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(settings.get("sync_enabled").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(settings.get("sync_token").and_then(|v| v.as_str()), Some(""));

        drop(conn);
    }

    /// 참조 첨부의 원본은 앱 폴더 밖이라 zip 에 들어가지 않는다 — 그게 "몇 개"인지 결과가
    /// 말해야 사용자가 복원 전에 안다(안 알리면 "복원했는데 파일이 없다" 사고).
    #[test]
    fn backup_counts_reference_attachments_and_leaves_their_originals_out_of_the_zip() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "note1", "With attachments");

        // 앱 폴더 **밖**의 원본 — 참조로 붙인다(mode="ref": 32MB 파일을 만들지 않고 같은 길로 간다).
        let outside = tempfile::tempdir().unwrap();
        let big = outside.path().join("huge-original.bin");
        std::fs::write(&big, b"outside-original-bytes").unwrap();
        let referenced = crate::repo::attachments::add_file_from_disk(
            &mut conn,
            data_dir.path(),
            "note1",
            big.to_str().unwrap(),
            Some("ref"),
        )
        .unwrap();
        assert!(referenced.ext_path.is_some() && referenced.rel_path.is_none());

        // 복사 첨부는 세지 않는다(대조군).
        let small = outside.path().join("small.png");
        std::fs::write(&small, b"copied bytes").unwrap();
        crate::repo::attachments::add_file(&mut conn, data_dir.path(), "note1", small.to_str().unwrap())
            .unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        let result = backup_create(&conn, data_dir.path(), &zip_path).unwrap();
        assert_eq!(result.excluded_reference_count, 1);

        // zip 안에 원본 바이트가 없어야 한다(참조는 "안 담는다"가 의도된 동작).
        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            !names.iter().any(|n| n.ends_with("huge-original.bin")),
            "referenced original must not be in the zip: {names:?}"
        );
        assert!(names.iter().any(|n| n.starts_with("attachments/")), "copied attachment must be in the zip");

        drop(conn);
    }

    #[test]
    fn backup_reports_zero_excluded_references_when_everything_is_copied() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "note1", "Copies only");
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("photo.png");
        std::fs::write(&src, b"copied bytes").unwrap();
        crate::repo::attachments::add_file(&mut conn, data_dir.path(), "note1", src.to_str().unwrap())
            .unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        let result = backup_create(&conn, data_dir.path(), &zip_path).unwrap();
        assert_eq!(result.excluded_reference_count, 0);

        drop(conn);
    }

    /// (e) P0 (docs/AUDIT-2026-09-26-fallback-observability.md §1) 요구사항: 고아 보관함
    /// (repo::orphan_hold, data_dir/orphaned/)은 attachments/ 의 형제 디렉토리라 zip_add_dir 가
    /// attachments_dir/workspace_bg_dir 만 훑는 이 함수는 원래도 이걸 보지 않는다 — 구조가 실제로
    /// 그렇게 되어 있는지, 우연이 아니라 회귀 시 이 테스트가 잡도록 명시적으로 고정한다.
    #[test]
    fn backup_zip_excludes_the_orphan_holding_area() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();

        // 보관함에 실제로 뭔가 있는 상태를 흉내낸다.
        let held = crate::repo::orphan_hold::hold_dir(data_dir.path());
        let batch_dir = held.join("20260101-000000").join("attachments").join("orphaned-note");
        std::fs::create_dir_all(&batch_dir).unwrap();
        std::fs::write(batch_dir.join("secret.png"), b"should not be backed up here").unwrap();

        let zip_path = data_dir.path().join("backup.zip");
        backup_create(&conn, data_dir.path(), &zip_path).unwrap();

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            !names.iter().any(|n| n.contains("orphaned")),
            "backup zip must not contain the orphan holding area: {names:?}"
        );

        drop(conn);
    }

    /// 스왑 도중(첨부는 이미 갈아끼운 뒤) 실패하면 첨부·배경 트리가 모두 제자리로 돌아와야 한다 —
    /// 스냅샷 DB 와 짝이 맞는 옛 파일들이 attachments.old-* 에 버려진 채 남으면 안 된다.
    /// 스테이징 배경 경로를 없는 자리로 줘서 마지막 rename 을 실패시킨다.
    #[test]
    fn swap_failure_mid_way_puts_both_trees_back() {
        let data_dir = tempfile::tempdir().unwrap();
        let dd = data_dir.path();
        let mut conn = db::bootstrap(dd).unwrap();
        std::fs::write(db::attachments_dir(dd).join("keep.txt"), b"att").unwrap();
        std::fs::write(db::workspace_bg_dir(dd).join("bg.png"), b"bg").unwrap();
        let safety = db::snapshot_backup(&conn, &db::backups_dir(dd)).unwrap();

        let staged_db = dd.join("staged.db");
        std::fs::copy(&safety, &staged_db).unwrap();
        let staged_att = dd.join("att.incoming");
        std::fs::create_dir_all(&staged_att).unwrap();
        std::fs::write(staged_att.join("new.txt"), b"new").unwrap();
        let staged = Staged { db_path: staged_db, att_path: staged_att, bg_path: dd.join("missing-bg") };

        assert!(swap_live_state(&mut conn, dd, staged, &safety, &[], "test").is_err());

        assert_eq!(std::fs::read(db::attachments_dir(dd).join("keep.txt")).unwrap(), b"att");
        assert!(!db::attachments_dir(dd).join("new.txt").exists());
        assert_eq!(std::fs::read(db::workspace_bg_dir(dd).join("bg.png")).unwrap(), b"bg");
        let leftovers: Vec<String> = std::fs::read_dir(dd)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.contains(".old-") || n.ends_with(".incoming"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // 실패 경로도 conn 을 스냅샷 DB 로 다시 연다.
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get::<_, i64>(0)).unwrap();
    }

    // ── Settings redesign (Données ②) — 자동 백업 스케줄/회전 ──────────────────────────────

    #[test]
    fn auto_backup_due_respects_off_and_first_run() {
        let now = std::time::SystemTime::now();
        assert!(!auto_backup_due(None, "off", now), "off must never be due, even with no prior backup");
        assert!(auto_backup_due(None, "weekly", now), "no prior backup means due immediately (unless off)");
        assert!(auto_backup_due(None, "daily", now));
    }

    #[test]
    fn auto_backup_due_checks_elapsed_interval() {
        let now = std::time::SystemTime::now();
        let six_hours_ago = now - std::time::Duration::from_secs(6 * 3600);
        let two_days_ago = now - std::time::Duration::from_secs(2 * 24 * 3600);
        let eight_days_ago = now - std::time::Duration::from_secs(8 * 24 * 3600);

        assert!(!auto_backup_due(Some(six_hours_ago), "daily", now), "6h < 1 day");
        assert!(auto_backup_due(Some(two_days_ago), "daily", now), "2d >= 1 day");

        assert!(!auto_backup_due(Some(two_days_ago), "weekly", now), "2d < 7 days");
        assert!(auto_backup_due(Some(eight_days_ago), "weekly", now), "8d >= 7 days");

        assert!(!auto_backup_due(Some(six_hours_ago), "off", now));
    }

    #[test]
    fn rotate_auto_backups_keeps_newest_n_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path();
        for name in [
            "auto-20260101T000000000000.zip",
            "auto-20260201T000000000000.zip",
            "auto-20260301T000000000000.zip", // newest — must survive keep=2
        ] {
            std::fs::write(backups.join(name), b"zip").unwrap();
        }
        // 회전 대상이 아닌 파일들 — 절대 지워지면 안 된다.
        std::fs::write(backups.join("brise-20260101T000000000000-aaaaaaaa.db"), b"snapshot").unwrap();
        std::fs::write(backups.join("brise-backup-2026-01-01.zip"), b"manual").unwrap(); // "auto-" 접두사 아님
        std::fs::write(backups.join("notes.txt"), b"unrelated").unwrap();

        rotate_auto_backups(backups, 2).unwrap();

        let remaining: Vec<String> = std::fs::read_dir(backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(remaining.len(), 5, "kept 2 auto zips + 3 untouched files");
        assert!(!remaining.contains(&"auto-20260101T000000000000.zip".to_string()), "oldest auto zip must be rotated out");
        assert!(remaining.contains(&"auto-20260201T000000000000.zip".to_string()));
        assert!(remaining.contains(&"auto-20260301T000000000000.zip".to_string()));
        assert!(remaining.contains(&"brise-20260101T000000000000-aaaaaaaa.db".to_string()), "R3 db snapshot untouched");
        assert!(remaining.contains(&"brise-backup-2026-01-01.zip".to_string()), "non auto- zip untouched");
    }

    #[test]
    fn newest_auto_backup_ignores_db_snapshots_and_vice_versa() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path();
        std::fs::write(backups.join("brise-20260901T000000000000-ffffffff.db"), b"snapshot").unwrap();
        std::fs::write(backups.join("auto-20260501T000000000000.zip"), b"zip").unwrap();

        let picked_auto = newest_auto_backup(backups).unwrap();
        assert_eq!(picked_auto.file_name().unwrap().to_str().unwrap(), "auto-20260501T000000000000.zip");

        // db/mod.rs::newest_backup must not see the auto zip (later timestamp) as a brise-*.db snapshot.
        let picked_db = db::newest_backup(backups).unwrap();
        assert_eq!(picked_db.file_name().unwrap().to_str().unwrap(), "brise-20260901T000000000000-ffffffff.db");
    }

    #[test]
    fn auto_backup_run_creates_zip_and_rotates() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "note1", "Auto-backed-up title");
        // 자동 백업도 같은 BackupResult 를 쓴다 — 참조 개수가 이 경로에서도 채워지는지 확인.
        let outside = tempfile::tempdir().unwrap();
        let big = outside.path().join("huge-original.bin");
        std::fs::write(&big, b"outside-original-bytes").unwrap();
        crate::repo::attachments::add_file_from_disk(
            &mut conn,
            data_dir.path(),
            "note1",
            big.to_str().unwrap(),
            Some("ref"),
        )
        .unwrap();
        drop(conn);

        let backups = db::backups_dir(data_dir.path());
        // 미리 2개를 채워 keep=2 회전이 실제로 지우는지 확인.
        std::fs::write(backups.join("auto-20200101T000000000000.zip"), b"old1").unwrap();
        std::fs::write(backups.join("auto-20200102T000000000000.zip"), b"old2").unwrap();

        let result = auto_backup_run(data_dir.path(), 2).unwrap();
        assert!(result.size_bytes > 0);
        assert_eq!(result.excluded_reference_count, 1, "자동 백업 경로에서도 참조 개수가 채워져야 한다");

        let auto_zips: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_auto_backup_name(&e.file_name().to_string_lossy()))
            .collect();
        assert_eq!(auto_zips.len(), 2, "keep=2 rotation must hold even right after creating a 3rd");

        assert!(auto_backup_last(data_dir.path()).is_some());

        // 리스크 감사 A: 성공 시 backup_auto_last_error 는 비어 있어야 한다(왕복 확인 —
        // validate_setting 에 arm 이 없으면 이 settings::set 호출이 조용히 실패해 값이 그대로
        // 남는다, CLAUDE.md 함정 #3).
        let conn = db::open(&db::db_path(data_dir.path())).unwrap();
        let settings = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            settings.get("backup_auto_last_error").and_then(|v| v.as_str()),
            Some(""),
        );
    }

    #[test]
    fn auto_backup_run_records_failure_in_settings() {
        // bootstrap 한 정상 DB지만, backups/ 자리에 미리 평범한 파일을 놓아 create_dir_all 이
        // 확실히 실패하게 만든다 — db::open 이후 첫 실패 지점을 결정론적으로 재현한다.
        let data_dir = tempfile::tempdir().unwrap();
        db::bootstrap(data_dir.path()).unwrap();
        // bootstrap 이 이미 backups/ 를 디렉토리로 만들어 두므로(db/mod.rs:143), 파일로 덮어쓰기
        // 전에 지워야 한다 — Windows 는 디렉토리 자리에 파일을 쓰면 PermissionDenied 로 거부한다.
        std::fs::remove_dir_all(db::backups_dir(data_dir.path())).unwrap();
        std::fs::write(db::backups_dir(data_dir.path()), b"not a directory").unwrap();

        let result = auto_backup_run(data_dir.path(), 3);
        assert!(result.is_err(), "create_dir_all must fail with a file occupying backups/");

        let conn = db::open(&db::db_path(data_dir.path())).unwrap();
        let settings = crate::repo::settings::get_all(&conn).unwrap();
        let recorded = settings
            .get("backup_auto_last_error")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(!recorded.is_empty(), "failure must be recorded, not silently swallowed");
    }

    #[test]
    fn auto_backup_run_reports_diag_when_db_open_itself_fails() {
        // U7(AUDIT-2026-09-26-fallback-observability.md) 회귀 가드 — 예전엔 db::open 자체가
        // 실패하면 `?`로 바로 빠져나가 record_auto_backup_error 를 아예 못 지나서 이 실패가
        // backup_auto_last_error 에도, 그 어디에도 안 남았다(db/mod.rs 의 eprintln 뿐). db_path
        // 자리에 디렉토리를 놓아 Connection::open 이 확실히 실패하게 만든다 — 이 경우 재시도
        // open 도 같은 이유로 실패하므로 설정 기록은 못 하지만, diag::error 는 무조건 남아야
        // 한다("settings 는 되면, diag 는 무조건" — 태스크 지시).
        let data_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(db::db_path(data_dir.path())).unwrap();

        let result = auto_backup_run(data_dir.path(), 3);
        assert!(result.is_err(), "Connection::open must fail when the db path is itself a directory");

        let found = crate::diag::recent(500)
            .into_iter()
            .find(|e| e.feature == "backup" && e.code == "auto_backup_open_failed");
        assert!(found.is_some(), "db::open failure inside auto_backup_run must still reach diag");
    }

    /// R-5: 쓰다 죽은 `auto-*.zip.partial` 은 "최신 백업"도, 회전 대상도 아니다.
    #[test]
    fn leftover_partial_is_neither_newest_nor_counted_in_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path();
        std::fs::write(backups.join("auto-20260101T000000000000.zip"), b"zip").unwrap();
        std::fs::write(backups.join("auto-20260201T000000000000.zip"), b"zip").unwrap();
        std::fs::write(backups.join("auto-20260301T000000000000.zip.partial"), b"truncated").unwrap();

        let newest = newest_auto_backup(backups).unwrap();
        assert_eq!(newest.file_name().unwrap().to_str().unwrap(), "auto-20260201T000000000000.zip");

        rotate_auto_backups(backups, 2).unwrap();
        assert!(backups.join("auto-20260101T000000000000.zip").exists(), ".partial 은 keep 개수에 세지 않는다");
        assert!(backups.join("auto-20260301T000000000000.zip.partial").exists(), "회전이 .partial 을 지우지도 않는다");
    }

    /// R-5: 성공하면 `.partial` 이 남지 않고, 실패하면(목적지가 폴더) `.partial` 도 남지 않는다.
    #[test]
    fn backup_create_leaves_no_partial_on_success_or_failure() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        let ok = data_dir.path().join("ok.zip");
        backup_create(&conn, data_dir.path(), &ok).unwrap();
        assert!(ok.is_file());
        assert!(!data_dir.path().join("ok.zip.partial").exists());

        let bad = data_dir.path().join("bad.zip");
        std::fs::create_dir_all(&bad).unwrap(); // rename 이 실패한다
        assert!(backup_create(&conn, data_dir.path(), &bad).is_err());
        assert!(!data_dir.path().join("bad.zip.partial").exists());
    }

    /// L-1: 첨부는 Stored, DB 는 Deflate 로 담긴다 — 그리고 옛 백업(전부 Deflate)도 그대로 복원된다.
    #[test]
    fn attachments_are_stored_and_legacy_deflate_backups_still_restore() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "note1", "Original title");
        let src_dir = tempfile::tempdir().unwrap();
        let src_file = src_dir.path().join("photo.png");
        std::fs::write(&src_file, b"original bytes original bytes original bytes").unwrap();
        let att = crate::repo::attachments::add_file(&mut conn, data_dir.path(), "note1", src_file.to_str().unwrap()).unwrap();
        let rel_path = att.rel_path.clone().unwrap();

        let zip_path = data_dir.path().join("new.zip");
        backup_create(&conn, data_dir.path(), &zip_path).unwrap();

        // 새 zip: attachments/* 는 Stored.
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        {
            let mut ar = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
            let mut saw_att = false;
            for i in 0..ar.len() {
                let mut f = ar.by_index(i).unwrap();
                if f.is_dir() {
                    continue;
                }
                if f.name().starts_with("attachments/") {
                    saw_att = true;
                    assert_eq!(f.compression(), zip::CompressionMethod::Stored);
                }
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut f, &mut buf).unwrap();
                entries.push((f.name().to_string(), buf));
            }
            assert!(saw_att);
        }
        // 옛 형식 재현: 전부 Deflate 로 다시 묶는다.
        let legacy = data_dir.path().join("legacy.zip");
        let borrowed: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        make_zip(&legacy, &borrowed);

        std::fs::write(db::attachments_dir(data_dir.path()).join(&rel_path), b"tampered").unwrap();
        backup_restore(&mut conn, data_dir.path(), &legacy, "RESTORE").unwrap();
        let restored = std::fs::read(db::attachments_dir(data_dir.path()).join(&rel_path)).unwrap();
        assert_eq!(restored, b"original bytes original bytes original bytes");
    }

    /// L-10: 다른 커넥션이 루프에서 커밋하는 동안 백업이 완료되고 integrity_check를 통과한다.
    /// Backup::new()?.step(-1) 단일 단계 복사이므로 중간 커밋으로 인한 restart 루프 없이 완료된다.
    #[test]
    fn backup_create_during_concurrent_writes_completes_and_passes_integrity() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, "note1", "Initial note");

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_clone = stop.clone();
        let db_path = db::db_path(data_dir.path());

        // 백그라운드 스레드에서 다른 커넥션으로 연속적인 커밋 루프를 실행
        let writer = std::thread::spawn(move || {
            let mut writer_conn = db::open(&db_path).unwrap();
            let mut i = 0;
            while !stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                let tx = writer_conn.transaction().unwrap();
                tx.execute(
                    "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                    rusqlite::params![format!("concurrent_key_{}", i % 50), format!("\"val_{}\"", i)],
                )
                .unwrap();
                tx.commit().unwrap();
                i += 1;
                std::thread::yield_now();
            }
            i
        });

        let zip_path = data_dir.path().join("concurrent_backup.zip");
        let result = backup_create(&conn, data_dir.path(), &zip_path);

        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let writes = writer.join().unwrap();
        assert!(writes > 0, "concurrent writes must have occurred");
        assert!(result.is_ok(), "backup_create must succeed during concurrent commits: {:?}", result.err());

        // 백업 zip 안의 brise.db 를 추출하여 PRAGMA integrity_check 검증
        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut db_entry = archive.by_name("brise.db").unwrap();
        let extracted_db_path = data_dir.path().join("extracted_check.db");
        let mut out = std::fs::File::create(&extracted_db_path).unwrap();
        std::io::copy(&mut db_entry, &mut out).unwrap();
        drop(db_entry);
        drop(archive);

        let check_conn = rusqlite::Connection::open(&extracted_db_path).unwrap();
        let integrity: String = check_conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok", "backup DB must pass integrity_check");
    }

    /// 백업 도중 꺼진 실행의 스테이징 잔해(DB 전체 크기)를 부팅 청소가 치운다 — 그리고 **그것만**
    /// 치운다: 라이브 DB·부팅 스냅샷·zip·같은 접두사의 다른 확장자·하위 폴더·같은 이름의 폴더는 그대로.
    #[test]
    fn cleanup_stale_staging_removes_only_top_level_staging_files() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let stale = [
            "brise.backup-staging-x.db",
            "brise.backup-staging-x.db-wal",
            "brise.backup-staging-x.db-shm",
        ];
        for n in stale {
            std::fs::write(d.join(n), b"stale").unwrap();
        }
        let keep = [
            "brise.db",
            "brise-20261001.db",
            "auto-x.zip",
            "brise.backup-staging-x.txt",
        ];
        for n in keep {
            std::fs::write(d.join(n), b"keep").unwrap();
        }
        std::fs::create_dir_all(d.join("backups")).unwrap();
        let nested = d.join("backups").join("brise.backup-staging-y.db");
        std::fs::write(&nested, b"keep").unwrap();
        let dir_named_like_staging = d.join("brise.backup-staging-z.db");
        std::fs::create_dir_all(&dir_named_like_staging).unwrap();

        cleanup_stale_staging(d);

        for n in stale {
            assert!(!d.join(n).exists(), "{n} should be removed");
        }
        for n in keep {
            assert!(d.join(n).exists(), "{n} must not be touched");
        }
        assert!(nested.exists(), "the sweep is not recursive");
        assert!(dir_named_like_staging.is_dir(), "only files are removed");
        let reported = crate::diag::recent(500)
            .into_iter()
            .any(|e| e.feature == "backup" && e.code == "stale_staging_removed");
        assert!(reported, "removal must be recorded in diag");

        // 두 번째 부팅: 남은 게 없으니 조용히 지나간다.
        cleanup_stale_staging(d);
        assert!(d.join("brise.db").exists());
    }
}

