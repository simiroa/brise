// DB 부트스트랩: open(WAL) → (필요 시) PRAGMA quick_check → 마이그레이션/시드 → 백업 회전 3개 (R3)
// 상세 리스크: specs/service/reliability.yaml
//
// quick_check 는 전체 DB 파일을 읽는다(1.3GB에서 20s+). 매 부팅 강제 스캔은 UI 스레드를 막는다.
// 대신 정상 종료 마커(brise.clean-shutdown)가 있으면 스킵하고, 크래시/강제 종료 뒤에만 스캔한다.
pub mod migrations;

use crate::error::{db, io, AppError, AppResult};
use crate::util::new_id;
use rusqlite::{Connection, MAIN_DB};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DB_FILE: &str = "brise.db";
pub const BACKUPS_DIR: &str = "backups";
pub const ATTACHMENTS_DIR: &str = "attachments";
// Wave 13: 워크스페이스 배경 이미지 — attachments/ 와 형제 디렉토리로 별도 관리한다. attachments/
// 밑에 두면 orphan_cleanup(attachments::orphan_cleanup)이 note_id 가 아닌 하위 디렉토리를 전부
// 고아로 오인해 앱 재시작마다 삭제해버린다 — 반드시 분리된 루트를 쓴다.
pub const WORKSPACE_BG_DIR: &str = "workspace_bg";
pub const EMOJI_DIR: &str = "emoji";
/// pptx→pdf 파생 캐시. attachments/ 밑이 아니라 형제 루트인 이유는 workspace_bg 와 같다 —
/// orphan_cleanup 이 note_id 아닌 하위 디렉토리를 고아로 오인하고, 백업·내보내기가
/// attachments/ 를 통째로 훑기 때문(파생물은 백업 대상이 아니다).
pub const SLIDE_CACHE_DIR: &str = "slide_previews";
/// 정상 종료 시 data_dir 에 기록. 다음 부팅에서 존재하면 이전 세션이 깨끗이 끝났다는 뜻.
pub const CLEAN_SHUTDOWN_MARKER: &str = "brise.clean-shutdown";
const KEEP_BACKUPS: usize = 3;

// PLAN-2026-09-28-onboarding-rebuild.md §6 — 저장 위치 이동(D3: 클라우드 동기화 폴더는 DB 는
// 로컬에 두고 첨부·백업만 옮긴다)의 재정의 지점. 부팅 때 한 번(repo::data_location::read_pointer
// 결과로) `set_dir_overrides` 가 세팅하고, 이 두 함수의 호출자 79곳은 그대로 둔다 — 재정의가
// 없으면(OnceLock 미설정 또는 값이 None) 지금과 동일하게 `data_dir.join(...)`. 테스트에서는
// 절대 호출하지 않는다 — 프로세스 전역 static이라 한 번 세팅되면 같은 바이너리의 다른 테스트에도
// 새어나간다(테스트는 늘 override 없는 기본 경로만 검증한다).
static ATTACHMENTS_OVERRIDE: OnceLock<Option<PathBuf>> = OnceLock::new();
static BACKUPS_OVERRIDE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 부팅 시 1회만 호출(lib.rs::setup). 이미 세팅돼 있으면 무시(OnceLock 은 재설정 불가 — 프로세스
/// 수명 동안 한 번만 뜻이 맞다, 재적용은 재시작으로 한다: PLAN §6 D4).
pub fn set_dir_overrides(attachments: Option<PathBuf>, backups: Option<PathBuf>) {
    let _ = ATTACHMENTS_OVERRIDE.set(attachments);
    let _ = BACKUPS_OVERRIDE.set(backups);
}

pub fn attachments_dir(data_dir: &Path) -> PathBuf {
    if let Some(Some(p)) = ATTACHMENTS_OVERRIDE.get() {
        return p.clone();
    }
    data_dir.join(ATTACHMENTS_DIR)
}

pub fn workspace_bg_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(WORKSPACE_BG_DIR)
}

pub fn emoji_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(EMOJI_DIR)
}

pub fn slide_cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SLIDE_CACHE_DIR)
}

pub fn backups_dir(data_dir: &Path) -> PathBuf {
    if let Some(Some(p)) = BACKUPS_OVERRIDE.get() {
        return p.clone();
    }
    data_dir.join(BACKUPS_DIR)
}

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

/// 연결을 열고 WAL·외래키·busy_timeout 및 성능 PRAGMA를 설정한다.
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path).map_err(db)?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(db)?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(db)?;
    conn.pragma_update(None, "busy_timeout", 5000).map_err(db)?;
    // WAL + NORMAL: 앱 크래시는 안전; OS/전원 상실 시에만 마지막 트랜잭션 손실 가능.
    // 키 입력마다 쓰는 앱에서 FULL fsync 는 기본값으로 부적절하다.
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(db)?;
    // 음수 = KiB (페이지 수가 아님). 64 MB — 라이브 DB ~80 MB 대비 기본 8 MB 는 부족.
    conn.pragma_update(None, "cache_size", -65536).map_err(db)?;
    conn.pragma_update(None, "mmap_size", 268435456i64).map_err(db)?;
    conn.pragma_update(None, "temp_store", "MEMORY").map_err(db)?;
    Ok(conn)
}

/// 이미 있는 DB 파일을 **읽기 전용**으로 연다 — 채팅 근거 검색처럼 전역 쓰기 잠금(`AppState::db`)을
/// 쥘 필요 없는 무거운 읽기용(commands::AppState::with_read). 파일을 만들거나 마이그레이션하지 않으며,
/// `journal_mode` 는 건드리지 않는다(WAL 은 파일에 영속돼 있다 — 읽기 연결이 바꾸려 들면 안 된다).
/// WAL 이므로 이 연결은 쓰기 연결과 서로 기다리지 않고, 마지막으로 **커밋된** 상태를 본다.
pub fn open_read_only(path: &Path) -> AppResult<Connection> {
    use rusqlite::OpenFlags;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(db)?;
    conn.pragma_update(None, "busy_timeout", 5000).map_err(db)?;
    conn.pragma_update(None, "query_only", true).map_err(db)?;
    // 쓰기 연결과 같은 캐시 크기 — 검색 지연이 연결을 옮겼다고 달라지지 않게.
    conn.pragma_update(None, "cache_size", -65536).map_err(db)?;
    conn.pragma_update(None, "mmap_size", 268435456i64).map_err(db)?;
    conn.pragma_update(None, "temp_store", "MEMORY").map_err(db)?;
    // 열기 자체는 게으르다 — 스키마를 한 번 읽어 파일이 실제 SQLite DB 인지 여기서 확인한다.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(db)?;
    Ok(conn)
}

/// 마이그레이션 직후 부팅 위생: 빈 DB 에서 `ANALYZE notes` 가 남긴 zero-row sqlite_stat1
/// (`stat = '0'` 또는 `'0 …'`) 을 제거하고 플래너 캐시를 리로드한다.
///
/// 불변식: sqlite_stat1 은 정확하거나 부재해야 하며, 절대 zero-row 통계를 담으면 안 된다.
/// V19/V20 이 빈 DB 에서 ANALYZE 한 뒤 갱신되지 않아 플래너가 인덱스 range scan 을
/// 거의 공짜로 착각하는 결함을 고친다. 멱등·저비용이므로 매 부팅 실행이 맞고,
/// 실패해도 부팅을 막지 않는다.
///
/// 의도적으로 넓게 지운다 — 참인 zero-row(예: 휴지통이 비어 idx_notes_deleted 가 실제로 0행)도
/// 같이 지워진다. 둘을 구분하려면 인덱스별 실제 행 수를 세야 하는데, 비대칭이 크다:
/// 참인 0 을 잃으면 그 인덱스만 기본 추정으로 떨어지고(부분 인덱스는 여전히 술어에 매치),
/// 거짓인 0 을 남기면 검색이 62초가 된다(docs/SCALABILITY.md 참조). 좁히지 말 것.
pub fn scrub_zero_row_stats(conn: &Connection) {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return;
    }
    if let Err(e) = conn.execute(
        "DELETE FROM sqlite_stat1 WHERE stat = '0' OR stat LIKE '0 %'",
        [],
    ) {
        crate::diag::warn("db", "stat_scrub_failed", format!("{e}"));
        return;
    }
    // DELETE 만으로는 플래너 캐시가 갱신되지 않는다. ANALYZE sqlite_schema 는
    // 테이블 본문을 재스캔하지 않고 stats 를 리로드한다.
    if let Err(e) = conn.execute("ANALYZE sqlite_schema", []) {
        crate::diag::warn("db", "stat_analyze_failed", format!("{e}"));
    }
}

/// PRAGMA quick_check — 손상 감지 (R3).
pub fn quick_check(conn: &Connection) -> AppResult<()> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(db)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(AppError::Db(format!("quick_check failed: {result}")))
    }
}

/// 정상 앱 종료 시 호출. 다음 부팅에서 quick_check 를 건너뛸 수 있게 마커를 남긴다.
pub fn mark_clean_shutdown(data_dir: &Path) {
    let path = data_dir.join(CLEAN_SHUTDOWN_MARKER);
    if let Err(e) = std::fs::write(&path, b"1") {
        crate::diag::warn(
            "db",
            "clean_marker_write_failed",
            format!("{}: {e}", CLEAN_SHUTDOWN_MARKER),
        );
    }
}

/// 부팅 시 마커를 소비한다(존재하면 제거하고 true). 이번 세션이 중간에 죽으면 다음 부팅은
/// 마커가 없어 dirty 로 취급되어 다시 quick_check 한다.
pub fn take_clean_shutdown_marker(data_dir: &Path) -> bool {
    let path = data_dir.join(CLEAN_SHUTDOWN_MARKER);
    if !path.exists() {
        return false;
    }
    if let Err(e) = std::fs::remove_file(&path) {
        // 삭제 실패 시 매 부팅 skip 하면 안 되므로 dirty 로 취급.
        crate::diag::warn(
            "db",
            "clean_marker_remove_failed",
            format!("{}: {e} — treating as dirty boot", CLEAN_SHUTDOWN_MARKER),
        );
        return false;
    }
    true
}

/// override(D3 클라우드 분리) 디렉토리가 지금 이 순간 안 닿아도(동기화 클라이언트가 아직 폴더를
/// 안 만들었거나 드라이브가 안 붙음) 부팅을 막지 않는다 — DB 는 로컬 그대로라 정상 동작 가능
/// (REVIEW-2026-09-28 §6 #2). 로컬 기본(override 없음) 디렉토리 생성 실패는 여전히 치명적이다
/// (디스크 자체 문제 — 옛 동작 그대로).
/// 반환값: 실제로 존재하게 됐는지(true) / override라 못 만들고 건너뛰었는지(false).
fn ensure_dir_all_boot(dir: &Path, is_override: bool, kind: &str) -> AppResult<bool> {
    match std::fs::create_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if is_override => {
            crate::diag::error("db", "override_dir_unreachable", format!("{kind}: {}: {e}", dir.display()));
            crate::diag::notify_user(
                "db",
                "override_dir_unreachable",
                &[("kind", kind.to_string()), ("path", dir.display().to_string())],
            );
            Ok(false)
        }
        Err(e) => Err(io(e)),
    }
}

/// 앱 시작 루틴: 디렉토리 준비 → open → (dirty 시) quick_check → 마이그레이션/시드 → 백업 회전.
/// 반환된 연결은 사용 준비 완료 상태.
pub fn bootstrap(data_dir: &Path) -> AppResult<Connection> {
    std::fs::create_dir_all(data_dir).map_err(io)?;
    let backups_override = matches!(BACKUPS_OVERRIDE.get(), Some(Some(_)));
    let attachments_override = matches!(ATTACHMENTS_OVERRIDE.get(), Some(Some(_)));
    let backups_reachable = ensure_dir_all_boot(&backups_dir(data_dir), backups_override, "backups")?;
    ensure_dir_all_boot(&attachments_dir(data_dir), attachments_override, "attachments")?;
    std::fs::create_dir_all(workspace_bg_dir(data_dir)).map_err(io)?;

    let path = db_path(data_dir);

    // 마커는 open 전에 소비한다. 이번 부팅 도중 크래시하면 다음 부팅이 dirty 가 된다.
    // 이전 세션이 정상 종료했고 라이브 DB 파일이 이미 있으면 quick_check 를 건너뛴다.
    // (신규 DB 생성 경로에서는 파일이 없을 수 있어 skip 해도 무방 — 빈/신규 DB 스캔 비용은 작다.)
    let prev_clean = take_clean_shutdown_marker(data_dir);
    let skip_quick_check = prev_clean && path.exists();

    // 복구 판정은 **파일이 실제로 깨졌을 때만**이다. 예전에는 open/quick_check/migrations 중
    // 무엇이 실패해도 "손상"으로 보고 백업을 덮어썼는데, 마이그레이션 실패는 그 처방이 듣지
    // 않는다 — 백업을 복원해도 같은 마이그레이션을 다시 돌려 또 실패하고, 그 사이 사용자의
    // 작업만 사라진다. 2026-08-19 에 실제로 두 번 일어났다(격리된 두 파일 모두 integrity_check
    // 는 ok 였다: 손상이 아니었다). 그래서 단계를 나눈다:
    //
    //   1단계 open_checked  — open + quick_check. 여기서 실패해야만 손상이고, 복구 대상이다.
    //   2단계 prepare       — 마이그레이션/위생/기기 식별자. 실패해도 백업을 건드리지 않는다.
    //
    // open() 자체가 실패할 수 있다는 점이 중요: journal_mode=WAL PRAGMA 설정은 DB 헤더를 읽어야
    // 해서, 헤더가 깨진 파일이면 quick_check까지 가지도 못하고 open() 에서 바로 에러가 난다.
    // open_checked 가 Err 을 반환하면 그 안에서 만든 Connection 은 함수 반환과 함께 drop 되므로,
    // Windows 에서 뒤이은 rename/copy 가 파일 잠금에 걸리지 않는다.
    let mut conn = match open_checked(&path, skip_quick_check) {
        Ok(conn) => conn,
        Err(open_err) => match restore_from_backup(data_dir) {
            Ok((backup_path, quarantine_name)) => {
                // 복구본은 항상 전체 검증 — 백업 자체도 손상됐을 수 있다.
                let recovered = open_checked(&path, false).map_err(|recover_err| {
                    AppError::Db(format!(
                        "DB가 손상되어 최신 백업({})으로 복구를 시도했지만 그마저 실패했습니다.                          db={}, backups={}. 원본 오류: {open_err}. 복구 후 오류: {recover_err}",
                        backup_path.display(),
                        path.display(),
                        backups_dir(data_dir).display()
                    ))
                })?;
                // P0(AUDIT-2026-09-26-fallback-observability.md §1) — 예전엔 이 복구가 eprintln!
                // 한 줄로만 남아 사용자는 롤백 사실조차 몰랐다(릴리즈 빌드는 콘솔이 없어 그마저
                // 안 보였다). 부팅 시 메인 창이 diag_take_notices 로 이 알림을 가져가 보여준다 —
                // PINNED code="db_restored_from_backup", params={backup, quarantine}(둘 다 파일
                // **이름**만, 다른 웨이브가 이 문자열 그대로에 의존한다. diag.rs 헤더 주석 참고).
                let backup_name =
                    backup_path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
                crate::diag::notify_user(
                    "db",
                    "db_restored_from_backup",
                    &[("backup", backup_name), ("quarantine", quarantine_name.unwrap_or_default())],
                );
                crate::diag::error("db", "restored_from_backup", format!("{open_err}"));
                recovered
            }
            Err(restore_err) => {
                return Err(AppError::Db(format!(
                    "DB가 손상되었고 사용할 수 있는 백업이 없습니다. db={}, backups={}.                      원본 오류: {open_err}. 백업 탐색 오류: {restore_err}",
                    path.display(),
                    backups_dir(data_dir).display()
                )));
            }
        },
    };

    // 여기서 실패하면 그대로 올려보낸다. 스키마를 못 올린 건 파일이 깨진 게 아니라 코드/데이터
    // 문제이므로, 백업으로 되돌려 봐야 같은 자리에서 다시 넘어질 뿐이고 데이터만 잃는다.
    // 부팅은 실패하지만 DB 는 마지막으로 성공한 버전 그대로 남는다(마이그레이션은 건당 트랜잭션).
    prepare(&mut conn)?;

    // 공간(Space)→캔버스(Canvas) 개명(V66) 첨부 디렉토리 1회 이관 — 마이그레이션(스키마/행)
    // 직후, 같은 부팅 시퀀스에서 동기 실행한다. DB 조회 기반(canvas_pages 의 실제 id)으로
    // 개별 디렉토리만 옮기므로 휴면 spaces/space_items(노트북 백업/복원)가 쓰는 나머지
    // attachments/spaces/ 트리는 절대 건드리지 않는다. best-effort — 실패해도 부팅을 막지
    // 않고, 존재 여부 게이팅이라 다음 부팅에 안전하게 재시도된다(repo/canvas_page_image.rs
    // ::migrate_active_page_dirs 주석 참고).
    // ponytail: 캔버스 플러그인은 2026-09-28 에 제거됐지만 이 이관은 남긴다 — V66 이전에서 곧장
    // 올라오는 설치본의 휴면 canvas_pages 데이터가 디스크 경로와 source_id 접두를 맞춰 두도록.
    // 옛 버전 직행 업그레이드를 더는 지원하지 않게 되면 함께 지운다.
    crate::repo::canvas_page_image::migrate_active_page_dirs(&conn, data_dir);

    // R3 + Scale(Phase 0): 정상 부팅 직후 스냅샷 백업 + 회전(최근 3개). 매 부팅 전체 DB 복사는
    // 대형 DB(임베딩 포함 GB급)에서 시작 지연이 코퍼스 크기에 비례하고 디스크를 4배 쓴다 —
    // 하루(UTC) 최대 1개만 스냅샷한다: 백업이 없거나 최신 백업이 오늘 것이 아닐 때만.
    // 무결성 검증(quick_check)은 이전 세션이 비정상 종료했을 때만 부팅 경로에서 수행한다
    // (정상 종료 마커가 있으면 스킵 — 전체 파일 스캔이 UI 를 막지 않게). 복구 후 재검증과
    // 백업 스냅샷 정책은 그대로다.
    // backups_reachable == false 는 override(D3) 폴더가 안 닿는다는 뜻 — 위에서 이미
    // notify_user 로 알렸다. 안 닿는 폴더에 스냅샷을 시도하면 여기서 다시 실패해 결국 부팅이
    // 막히므로, 이 회차는 통째로 건너뛴다(다음 부팅에 폴더가 돌아오면 다시 시도된다).
    let backups = backups_dir(data_dir);
    if backups_reachable {
        let need_snapshot = match newest_backup(&backups) {
            None => true,
            Some(p) => {
                let today = chrono::Utc::now().format("%Y%m%d").to_string();
                // 파일명 "brise-YYYYMMDDT...-suffix.db" 의 날짜 접두사와 오늘을 비교.
                let same_day = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_prefix("brise-"))
                    .map(|rest| rest.starts_with(&today))
                    .unwrap_or(false);
                !same_day
            }
        };
        if need_snapshot {
            snapshot_backup(&conn, &backups)?;
            rotate_backups(&backups, KEEP_BACKUPS)?;
        }
    }

    // Sync Phase 0 G4: 첨부 content_hash 백필 — 기존 파일마다 읽어서 해시하므로 대형 첨부
    // 라이브러리에서는 비용이 있다. 부팅을 막지 않도록 별도 스레드에서, 이 conn 과는 독립된
    // 새 연결(WAL 모드라 동시 읽기/쓰기 가능)로 돌린다. 실패해도 부팅에 영향 없음(best-effort).
    // ponytail: 채울 행이 하나도 없으면(신규 설치·이미 백필 완료) 스레드 자체를 띄우지 않는다 —
    // 두 번째 연결이 잠깐이라도 열려 있으면 이 conn 이 닫힐 때의 자동 WAL 체크포인트("마지막
    // 연결이 닫히면 체크포인트") 조건이 깨진다(테스트에서 실측: 파일 크기가 WAL 에만 남아 작게
    // 유지됨). 실제로 채울 행이 있는 업그레이드 경로에서만 스레드를 띄우면 이 문제가 없다.
    let needs_backfill: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE content_hash IS NULL AND rel_path IS NOT NULL)",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if needs_backfill {
        let data_dir_bg = data_dir.to_path_buf();
        std::thread::spawn(move || match open(&db_path(&data_dir_bg)) {
            Ok(bg_conn) => {
                if let Err(e) =
                    crate::repo::attachments::backfill_content_hashes(&bg_conn, &data_dir_bg)
                {
                    crate::diag::warn("db", "content_hash_backfill_failed", format!("{e}"));
                }
            }
            Err(e) => crate::diag::warn(
                "db",
                "content_hash_backfill_conn_failed",
                format!("{e}"),
            ),
        });
    }

    Ok(conn)
}

/// 1단계 — 파일을 열고 **온전한지만** 본다. 여기서 나는 실패만이 "손상"이며 백업 복구 대상이다.
/// bootstrap 이 최초 시도와 복구 후 재시도에 같은 절차를 쓰려고 분리했다. 실패 시 내부에서 만든
/// Connection 은 이 함수 반환과 함께 drop 되어 파일 핸들이 남지 않는다(rename/copy 에 필요).
///
/// `skip_quick_check`: 이전 세션 정상 종료 시에만 true. 복구 재시도 경로에서는 항상 false.
fn open_checked(path: &Path, skip_quick_check: bool) -> AppResult<Connection> {
    let conn = open(path)?;
    if !skip_quick_check {
        quick_check(&conn)?;
    }
    Ok(conn)
}

/// 2단계 — 스키마를 올리고 부팅 위생을 친다. **손상 판정과 무관하다**: 여기서 실패하면
/// 백업 복구가 아니라 그대로 에러다.
fn prepare(conn: &mut Connection) -> AppResult<()> {
    migrations::run(conn)?;
    // 마이그레이션(특히 V19/V20 ANALYZE)이 빈 테이블에 쓴 zero-row 통계를 걷어낸다.
    scrub_zero_row_stats(conn);
    // Sync Phase 0 G3: 기기 식별자 — 없으면 1회 생성. 저비용(INSERT 1건)이라 부팅 경로에서
    // 동기 실행해도 지연이 없다.
    crate::repo::settings::ensure_device_id(conn)?;
    Ok(())
}

/// backups/ 의 brise-*.db 중 가장 최신 스냅샷 경로. 파일명이 타임스탬프+suffix로 고정 폭
/// 정렬되므로(rotate_backups와 동일한 가정) 사전순 최댓값이 곧 최신이다.
pub fn newest_backup(backups: &Path) -> Option<PathBuf> {
    std::fs::read_dir(backups)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("brise-") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .max()
}

/// 손상된 라이브 DB를 최신 백업으로 교체한다.
/// 순서가 중요: 먼저 의심되는 파일을 `brise.corrupt-<id>.db`로 보존(rename)해 절대 삭제하지
/// 않은 뒤에야 백업을 복사한다 — 복구가 잘못돼도 원본을 조사/수동 구제할 수 있어야 한다.
/// GUI 코드 없음 — bootstrap과 함께 테스트에서 직접 호출되므로 헤드리스로 유지한다(다이얼로그는
/// lib.rs 전용).
///
/// 반환값 두 번째 원소는 격리 파일 **이름**(경로 아님 — diag 알림 params 계약, bootstrap() 의
/// notify_user 호출부 참고) — 라이브 파일이 애초에 없던 극단 상황(직전 open()이 파일을 새로
/// 만들었는데 quick_check만 실패하는 등)에는 격리할 대상이 없어 `None`.
pub fn restore_from_backup(data_dir: &Path) -> AppResult<(PathBuf, Option<String>)> {
    let backups = backups_dir(data_dir);
    let backup = newest_backup(&backups).ok_or_else(|| {
        AppError::Db(format!("백업 스냅샷을 찾을 수 없습니다: {}", backups.display()))
    })?;

    let live = db_path(data_dir);
    let quarantine_name = format!("brise.corrupt-{}.db", new_id());
    let quarantined = if live.exists() {
        std::fs::rename(&live, data_dir.join(&quarantine_name)).map_err(io)?;
        true
    } else {
        false
    };
    // WAL/SHM은 파일 **이름**으로 DB에 묶인다(내용이 아니라 "brise.db-wal"이라는 경로 자체로).
    // 라이브 경로에서 치우지 않으면 재오픈 시 SQLite가 방금 복사해 넣은 백업 위에 옛 WAL을
    // 이어 적용하려 든다. 하지만 **지우면 안 된다** — WAL 에는 아직 체크포인트되지 않은 커밋된
    // 트랜잭션이 들어 있고, 그게 보통 최근 작업 전부다(라이브 WAL 이 4 MB, 본 파일이 1 MB 인
    // 상태가 흔하다). 예전엔 여기서 remove_file 을 불러, 격리본을 남기는 이유였던 "사후 조사·
    // 수동 구제"가 정작 조사할 내용을 잃은 채 이뤄졌다. 2026-08-19 의 격리본 두 개가 모두
    // 이틀 전 상태였던 게 그 자국이다.
    //
    // 지우는 대신 격리본 옆으로 같이 옮긴다: 이름이 brise.corrupt-<id>.db-wal 로 맞아떨어져
    // 격리본을 열면 SQLite 가 그 WAL 을 그대로 이어 붙인다 — 라이브 경로를 비우는 효과는 동일.
    for ext in ["-wal", "-shm"] {
        let sidecar = data_dir.join(format!("{DB_FILE}{ext}"));
        if sidecar.exists() {
            std::fs::rename(&sidecar, data_dir.join(format!("{quarantine_name}{ext}"))).map_err(io)?;
        }
    }
    std::fs::copy(&backup, &live).map_err(io)?;
    Ok((backup, quarantined.then_some(quarantine_name)))
}

/// data_dir 에 아직 brise.corrupt-*.db 격리 파일이 남아있는지 — restore_from_backup 이 위에서
/// 만드는 바로 그 이름 패턴. 존재한다는 것은 "손상 복구가 있었고 사용자가 아직 옛 데이터를 조사
/// 하러 올 수도 있는 창"이라는 뜻이라, repo::orphan_hold::purge_stale 이 이 값을 보고 보관함
/// 회수를 통째로 보류한다(§P0 audit — 회수 경로 자체를 그 창에 지우면 안 된다).
pub fn quarantine_exists(data_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name()
            .to_str()
            .map(|n| n.starts_with("brise.corrupt-") && n.ends_with(".db"))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // quick_check/migrations 실패를 실제로 재현하려면 rusqlite가 손상으로 인식할 바이트 배열이
    // 필요해 환경마다 결과가 다를 수 있다 — 대신 bootstrap이 의존하는 두 헬퍼(최신 백업 선택,
    // 의심 파일 보존)를 직접 검증한다. 이 둘이 맞으면 bootstrap의 복구 분기는 파일 I/O만 남는다.

    // ⚠️ bootstrap() 을 override 활성 상태로 통째로 테스트하려면 db::set_dir_overrides 를
    // 불러야 하는데, 이 파일 상단 OnceLock 주석대로 그건 프로세스 전역이라 같은 바이너리의
    // 다른 모든 테스트에 새어나간다 — 절대 안 된다. 대신 bootstrap이 실제로 쓰는 순수 결정
    // 함수(ensure_dir_all_boot)만 override 플래그를 인자로 직접 넣어 테스트한다(REVIEW #2).
    // 실행 머신에 어떤 드라이브 문자가 실제로 있는지 가정하지 않는다("Z: 은 안 붙어 있겠지"는
    // CI/실기마다 흔들린다) — 파일명에 NUL 바이트를 넣어 OS 가 어떤 환경에서도 반드시
    // 거부하게 만든다(Windows CreateDirectoryW/Unix mkdir 둘 다 ERROR_INVALID_NAME 급으로 실패).
    fn always_invalid_path() -> PathBuf {
        PathBuf::from("brise-test-unreachable-9f3c2e\0attachments")
    }

    #[test]
    fn ensure_dir_all_boot_is_non_fatal_when_override_dir_unreachable() {
        let unreachable = always_invalid_path();
        let ok = ensure_dir_all_boot(&unreachable, true, "attachments").unwrap();
        assert!(!ok, "override 폴더가 안 닿으면 false(만들지 못함)만 알리고 에러를 올리지 않아야 한다");
    }

    #[test]
    fn ensure_dir_all_boot_still_fails_when_not_an_override() {
        let unreachable = always_invalid_path();
        let err = ensure_dir_all_boot(&unreachable, false, "attachments").unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }

    #[test]
    fn ensure_dir_all_boot_succeeds_normally_when_writable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("attachments");
        let ok = ensure_dir_all_boot(&target, true, "attachments").unwrap();
        assert!(ok);
        assert!(target.is_dir());
    }

    /// 불변식: 마이그레이션(+ 부팅 위생) 후 sqlite_stat1 에 zero-row 통계가 없어야 한다.
    /// V19/V20 이 빈 notes 에 ANALYZE 하면 `stat` 이 `0` / `0 …` 인 행이 생기며, 위생 없이
    /// 그대로 두면 플래너가 인덱스 range scan 을 공짜로 착각한다.
    #[test]
    fn scrub_zero_row_stats_removes_migration_poison() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).expect("migrations on empty DB");

        // 위생 전: 마이그레이션 ANALYZE 가 zero-row 통계를 남겼는지 확인(테스트 전제).
        // (sqlite_stat1 이 아예 없으면 불변식은 이미 성립 — 그 경우 위생은 no-op.)
        let has_stat1: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if has_stat1 {
            let poisoned: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_stat1 WHERE stat = '0' OR stat LIKE '0 %'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(
                poisoned > 0,
                "precondition: empty-DB migrations should leave zero-row stats (got {poisoned})"
            );
        }

        scrub_zero_row_stats(&conn);

        let zero_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_stat1 WHERE stat = '0' OR stat LIKE '0 %'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(
            zero_rows, 0,
            "sqlite_stat1 must not contain zero-row stats after boot hygiene"
        );
    }

    #[test]
    fn newest_backup_picks_lexicographically_latest_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(BACKUPS_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for name in [
            "brise-20260101T000000000000-aaaaaaaa.db",
            "brise-20260721T090000000000-bbbbbbbb.db", // 최신
            "brise-20260315T120000000000-cccccccc.db",
        ] {
            std::fs::write(backups.join(name), b"snapshot").unwrap();
        }
        // 백업이 아닌 파일은 후보에서 제외되어야 한다.
        std::fs::write(backups.join("not-a-backup.txt"), b"x").unwrap();

        let picked = newest_backup(&backups).unwrap();
        assert_eq!(
            picked.file_name().unwrap().to_str().unwrap(),
            "brise-20260721T090000000000-bbbbbbbb.db"
        );
    }

    #[test]
    fn newest_backup_returns_none_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(BACKUPS_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        assert!(newest_backup(&backups).is_none());
    }

    #[test]
    fn restore_from_backup_preserves_corrupt_file_and_copies_newest_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let backups = backups_dir(data_dir);
        std::fs::create_dir_all(&backups).unwrap();

        // 의심스러운(가짜로 손상된) 라이브 DB.
        let live = db_path(data_dir);
        std::fs::write(&live, b"not a real sqlite file").unwrap();
        // WAL/SHM 잔재도 함께 있다고 가정 — 복구 후 남아있으면 안 된다.
        std::fs::write(data_dir.join(format!("{DB_FILE}-wal")), b"stale wal").unwrap();
        std::fs::write(data_dir.join(format!("{DB_FILE}-shm")), b"stale shm").unwrap();

        // 유효한(것으로 간주하는) 백업 스냅샷.
        let backup_bytes = b"a valid backup snapshot";
        std::fs::write(
            backups.join("brise-20260721T080000000000-deadbeef.db"),
            backup_bytes,
        )
        .unwrap();

        let (restored_from, returned_quarantine_name) = restore_from_backup(data_dir).unwrap();
        assert_eq!(
            restored_from.file_name().unwrap().to_str().unwrap(),
            "brise-20260721T080000000000-deadbeef.db"
        );
        let returned_quarantine_name =
            returned_quarantine_name.expect("라이브 DB가 있었으니 격리 파일 이름을 돌려줘야 한다");

        // 라이브 DB 자리에는 이제 백업 내용이 들어있다.
        assert_eq!(std::fs::read(db_path(data_dir)).unwrap(), backup_bytes);

        // 원래 손상 파일은 삭제되지 않고 brise.corrupt-*.db 로 보존되어야 한다.
        let quarantined: Vec<_> = std::fs::read_dir(data_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("brise.corrupt-") && n.ends_with(".db"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(quarantined.len(), 1, "손상 파일이 정확히 하나 보존되어야 함");
        assert_eq!(
            std::fs::read(quarantined[0].path()).unwrap(),
            b"not a real sqlite file"
        );

        // 옛 WAL/SHM 잔재는 라이브 경로에서 치워져야 재오픈 시 백업 내용을 덮어쓰지 않는다.
        assert!(!data_dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!data_dir.join(format!("{DB_FILE}-shm")).exists());

        // 치운다 = **옮긴다**. 지우면 아직 체크포인트되지 않은 커밋이 통째로 사라져, 격리본을
        // 남기는 이유(사후 조사·수동 구제)가 무의미해진다. 이름이 격리본과 짝이 맞아야
        // SQLite 가 격리본을 열 때 그 WAL 을 그대로 이어 붙인다.
        let quarantine_name = quarantined[0].file_name();
        let quarantine_name = quarantine_name.to_str().unwrap();
        assert_eq!(
            returned_quarantine_name, quarantine_name,
            "restore_from_backup이 돌려주는 이름이 실제 격리 파일 이름과 같아야 한다(diag 알림이 이 값을 그대로 쓴다)"
        );
        assert_eq!(
            std::fs::read(data_dir.join(format!("{quarantine_name}-wal"))).unwrap(),
            b"stale wal",
            "WAL 은 지우지 말고 격리본 옆으로 옮겨야 한다"
        );
        assert_eq!(
            std::fs::read(data_dir.join(format!("{quarantine_name}-shm"))).unwrap(),
            b"stale shm"
        );
    }

    /// 마이그레이션 실패는 **손상이 아니다.** 예전엔 open/quick_check/migrations 중 무엇이
    /// 실패해도 백업을 덮어썼는데, 이 처방은 마이그레이션에는 듣지 않는다 — 복원한 백업도
    /// 같은 마이그레이션을 다시 돌려 또 실패하고, 사이에 사용자의 작업만 사라진다.
    /// 2026-08-19 에 실제로 두 번 일어났고 격리된 두 파일 모두 integrity_check 는 ok 였다.
    #[test]
    fn migration_failure_neither_quarantines_nor_restores() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();

        // 1) 정상 부팅으로 완전히 마이그레이션된 DB + 백업 스냅샷을 만든다.
        drop(bootstrap(data_dir).expect("첫 부팅은 성공해야 한다"));
        let live = db_path(data_dir);
        assert!(newest_backup(&backups_dir(data_dir)).is_some(), "백업이 있어야 시나리오가 성립");

        // 2) 파일은 멀쩡한데 마이그레이션만 실패하는 상태를 만든다: 재실행 시 중복 컬럼 오류로
        //    실패하는 마이그레이션(V60 등)의 기록을 지워 재실행을 유도한다.
        {
            let conn = open(&live).unwrap();
            conn.execute("DELETE FROM schema_migrations WHERE version >= 60", [])
                .unwrap();
        }
        let before = std::fs::read(&live).unwrap().len();

        // 3) 부팅은 실패해야 한다 — 그러나 조용히 데이터를 갈아치우면서 실패하면 안 된다.
        let err = bootstrap(data_dir).expect_err("마이그레이션이 깨졌으니 부팅은 실패해야 한다");
        assert!(
            !err.to_string().contains("손상"),
            "마이그레이션 실패를 손상으로 보고하면 안 된다: {err}"
        );

        let quarantined = std::fs::read_dir(data_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("brise.corrupt-"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(quarantined, 0, "마이그레이션 실패로 격리 파일을 만들면 안 된다");
        assert!(live.exists(), "라이브 DB 는 제자리에 남아야 한다");
        assert_eq!(
            std::fs::read(&live).unwrap().len(),
            before,
            "라이브 DB 가 백업으로 덮어씌워지면 안 된다"
        );
    }

    #[test]
    fn restore_from_backup_errors_when_no_backup_exists() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        std::fs::create_dir_all(backups_dir(data_dir)).unwrap();
        // 라이브 DB는 있지만 backups/ 는 비어있음.
        std::fs::write(db_path(data_dir), b"garbage").unwrap();

        let err = restore_from_backup(data_dir).unwrap_err();
        assert!(matches!(err, AppError::Db(_)));
        // 백업이 없으면 실패해야 하고, 실패했으니 원본을 건드리지 않았어야 한다(아직 격리 전 실패).
        assert!(db_path(data_dir).exists());
    }

    #[test]
    fn bootstrap_recovers_from_corrupt_db_via_backup() {
        // 전역 알림 큐를 take_notices() 로 비우는 테스트는 diag 의 락으로 줄을 선다 — diag.rs 자체
        // 테스트가 병렬로 큐를 비워 이 테스트의 알림을 가져가던 간헐 실패(2026-09-29) 방지.
        let _serial = crate::diag::tests::NOTICE_TEST_LOCK.lock();
        // 통합 시나리오: 정상 DB로 한 번 bootstrap 해 실제 유효한 백업을 만든 뒤, 라이브 DB를
        // 깨뜨리고 다시 bootstrap 하면 자동 복구되어 정상적으로 열려야 한다.
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();

        let conn = bootstrap(data_dir).expect("첫 bootstrap은 정상 성공해야 함");
        drop(conn);
        assert!(newest_backup(&backups_dir(data_dir)).is_some(), "정상 부팅은 백업을 남겨야 함");

        // 라이브 DB를 SQLite가 읽을 수 없는 바이트로 덮어써 손상을 재현.
        std::fs::write(db_path(data_dir), b"\x00\x01totally not a sqlite header").unwrap();
        // 남은 WAL/SHM은 없다고 가정하고 그대로 재부팅.

        let recovered = bootstrap(data_dir).expect("백업이 있으므로 자동 복구되어야 함");
        // 복구된 연결이 정상적으로 마이그레이션된 스키마를 갖는지 확인.
        let ok: String = recovered
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok");

        // 손상됐던 파일이 격리되어 남아있는지 확인.
        let quarantined_names: Vec<String> = std::fs::read_dir(data_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                name.starts_with("brise.corrupt-").then_some(name)
            })
            .collect();
        assert_eq!(quarantined_names.len(), 1, "손상 파일이 격리되어 남아있어야 함");

        // P0(§1) 회귀 가드 — 복구가 diag 알림 대기열에 PINNED code="db_restored_from_backup" 을
        // params={backup, quarantine}(파일 이름만)으로 정확히 남겨야 한다. take_notices()는
        // 전역 큐를 통째로 drain한다 — 이 code 는 이 경로에서만 나오므로 필터링하되, 다른 테스트가
        // 먼저 비워 가지 않도록 함수 첫 줄에서 diag 의 NOTICE_TEST_LOCK 을 잡았다.
        let notices = crate::diag::take_notices();
        let notice = notices
            .iter()
            // 같은 알림을 내는 다른 복구 테스트가 락 없이 병렬로 돌면 큐에 남의 것이 섞인다 — 첫 번째가
            // 아니라 **이 테스트가 격리한 파일 이름**으로 고른다(전체 스위트에서만 실패하던 플레이크).
            .find(|n| {
                n.code == "db_restored_from_backup"
                    && n.params.get("quarantine").map(String::as_str) == Some(quarantined_names[0].as_str())
            })
            .unwrap_or_else(|| {
                let codes: Vec<&str> = notices.iter().map(|n| n.code.as_str()).collect();
                panic!("복구 성공 시 db_restored_from_backup 알림이 큐에 있어야 한다 — 실제 큐: {codes:?}")
            });
        assert_eq!(notice.feature, "db");
        assert_eq!(notice.params.get("quarantine").map(String::as_str), Some(quarantined_names[0].as_str()));
        assert!(notice.params.get("backup").map(|b| b.ends_with(".db")).unwrap_or(false));
    }

    /// 틱 간격은 daily 최소 단위보다 짧아야 하고, 기한 판단은 기존 auto_backup_due 가 맡는다.
    #[test]
    fn auto_backup_tick_is_shorter_than_daily_and_uses_due_check() {
        use crate::repo::transfer::backup::auto_backup_due;
        let now = std::time::SystemTime::now();
        assert!(AUTO_BACKUP_TICK < std::time::Duration::from_secs(24 * 3600));
        // 앱이 계속 떠 있는 상황: 25시간 전 백업이면 다음 틱에 due, 방금 한 백업이면 아님.
        assert!(auto_backup_due(Some(now - std::time::Duration::from_secs(25 * 3600)), "daily", now));
        assert!(!auto_backup_due(Some(now - AUTO_BACKUP_TICK), "daily", now));
    }

    /// interval="off" 는 아무것도 스레드를 띄우지 않고 즉시 반환해야 한다 — 동기적으로 확인
    /// 가능한 유일한 경계(스레드 자체는 백그라운드라 결정론적으로 관찰 불가, 그 판단 로직은
    /// repo/transfer/backup.rs::auto_backup_due 단위테스트가 이미 커버한다).
    #[test]
    fn maybe_spawn_auto_backup_noop_when_interval_off() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = bootstrap(data_dir.path()).unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('backup_auto_interval', '\"off\"')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();

        maybe_spawn_auto_backup(&conn, data_dir.path());

        // 스레드가 떴다면 파일이 생기기까지 시간이 걸리므로, "off"가 진짜 즉시 no-op임을
        // 확인하려면 rotate_backups 처럼 동기 부수효과가 없다는 것만으로 충분 — auto-*.zip 이
        // 하나도 생기지 않았어야 한다(짧게 기다려도 여전히 없음을 확인).
        std::thread::sleep(std::time::Duration::from_millis(200));
        let backups = backups_dir(data_dir.path());
        let any_auto = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("auto-"));
        assert!(!any_auto, "interval=off must never create an auto backup");
    }

    #[test]
    fn take_clean_shutdown_marker_consumes_file() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        assert!(!take_clean_shutdown_marker(data_dir));
        mark_clean_shutdown(data_dir);
        assert!(data_dir.join(CLEAN_SHUTDOWN_MARKER).exists());
        assert!(take_clean_shutdown_marker(data_dir));
        assert!(!data_dir.join(CLEAN_SHUTDOWN_MARKER).exists());
        // 두 번째 호출은 이미 없음.
        assert!(!take_clean_shutdown_marker(data_dir));
    }

    #[test]
    fn bootstrap_skips_quick_check_after_clean_shutdown_marker() {
        // discriminating test:
        // SQLite 헤더(0..100 및 페이지 1)는 온전히 남겨 두어 open() 은 성공하지만,
        // 나중 페이지(페이지 2, offset 4096)를 손상시켜 quick_check 만 실패하는 DB 생성.
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let conn = bootstrap(data_dir).expect("first bootstrap");
        conn.execute("CREATE TABLE t (x TEXT)", []).unwrap();
        for i in 0..100 {
            conn.execute(
                "INSERT INTO t VALUES (?)",
                [format!("row {i} {}", "padding".repeat(50))],
            )
            .unwrap();
        }
        drop(conn);
        assert!(newest_backup(&backups_dir(data_dir)).is_some());

        // offset 4096 (페이지 2) 손상
        let mut bytes = std::fs::read(db_path(data_dir)).unwrap();
        assert!(bytes.len() >= 8192, "DB file must span multiple pages");
        for b in &mut bytes[4096..4296] {
            *b = 0xFF;
        }
        std::fs::write(db_path(data_dir), &bytes).unwrap();

        // open() 은 성공하지만 quick_check 은 실패함을 검증
        let open_conn = open(&db_path(data_dir)).expect("open must succeed because page 1 header is intact");
        assert!(quick_check(&open_conn).is_err(), "quick_check must fail due to corrupted page 2");
        drop(open_conn);

        // Direction 1: clean 마커 존재 → quick_check 스킵되므로 백업 복구 없이 정상 부팅 성공
        mark_clean_shutdown(data_dir);
        let clean_conn = bootstrap(data_dir).expect("clean boot skips quick_check and succeeds");
        drop(clean_conn);

        // quick_check 가 스킵되었으므로 corrupt 격리 파일이 없어야 함 (스킵 입증)
        let quarantined_count = std::fs::read_dir(data_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_str().map(|n| n.starts_with("brise.corrupt-")).unwrap_or(false))
            .count();
        assert_eq!(quarantined_count, 0, "clean boot with marker must skip quick_check and not trigger backup restore");

        // Direction 2: clean 마커 없음 (dirty) → quick_check 실행되어 실패, 백업 복구 경로 진입
        // 다시 offset 4096 손상 재현 (clean_conn 이 WAL 등 갱신했을 수 있으므로)
        let mut bytes = std::fs::read(db_path(data_dir)).unwrap();
        for b in &mut bytes[4096..4296] {
            *b = 0xFF;
        }
        std::fs::write(db_path(data_dir), &bytes).unwrap();
        assert!(!data_dir.join(CLEAN_SHUTDOWN_MARKER).exists());

        let dirty_conn = bootstrap(data_dir).expect("dirty boot fails quick_check and recovers via backup");
        let ok: String = dirty_conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok");

        // quick_check 가 실행되어 실패했으므로 corrupt 격리 파일이 새로 생성되어야 함
        let dirty_quarantined = std::fs::read_dir(data_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_str().map(|n| n.starts_with("brise.corrupt-")).unwrap_or(false))
            .count();
        assert_eq!(dirty_quarantined, 1, "dirty boot must detect corruption via quick_check and quarantine file");
    }

    #[test]
    fn bootstrap_still_recovers_corrupt_db_when_dirty() {
        // dirty 부팅(마커 없음) + open 실패 → 백업 복구. 마커를 남기지 않은 강제 종료 시나리오.
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let conn = bootstrap(data_dir).expect("seed");
        drop(conn);
        // 마커 없음 = dirty.
        assert!(!data_dir.join(CLEAN_SHUTDOWN_MARKER).exists());
        std::fs::write(db_path(data_dir), b"\x00\x01not sqlite").unwrap();
        let recovered = bootstrap(data_dir).expect("dirty boot recovers via backup");
        let ok: String = recovered
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok");
    }

    /// 빈 DB 부팅 단계별 비용 + clean/dirty re-bootstrap 비교. 측정 전용 — 실패하지 않음.
    /// `cargo test -p brise empty_db_bootstrap_phase_breakdown -- --nocapture --ignored`
    #[test]
    #[ignore]
    fn empty_db_bootstrap_phase_breakdown() {
        use std::time::Instant;

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        std::fs::create_dir_all(data_dir).unwrap();
        std::fs::create_dir_all(backups_dir(data_dir)).unwrap();
        std::fs::create_dir_all(attachments_dir(data_dir)).unwrap();
        std::fs::create_dir_all(workspace_bg_dir(data_dir)).unwrap();
        let path = db_path(data_dir);

        // --- first boot (empty / create): open + quick_check + migrations + snapshot ---
        let t0 = Instant::now();
        let mut conn = open(&path).unwrap();
        let open_ms = t0.elapsed().as_millis();

        let t = Instant::now();
        quick_check(&conn).unwrap();
        let quick_check_ms = t.elapsed().as_millis();

        let t = Instant::now();
        migrations::run(&mut conn).unwrap();
        let migrations_ms = t.elapsed().as_millis();

        let t = Instant::now();
        snapshot_backup(&conn, &backups_dir(data_dir)).unwrap();
        let snapshot_ms = t.elapsed().as_millis();

        let t = Instant::now();
        crate::repo::attachments::orphan_cleanup(&conn, data_dir).unwrap();
        let orphan_ms = t.elapsed().as_millis();

        drop(conn);

        // dirty re-bootstrap (no marker) — includes quick_check, may skip snapshot if same day
        let t = Instant::now();
        let conn = bootstrap(data_dir).unwrap();
        let dirty_bootstrap_ms = t.elapsed().as_millis();
        drop(conn);

        // clean re-bootstrap (marker present) — skips quick_check
        mark_clean_shutdown(data_dir);
        let t = Instant::now();
        let conn = bootstrap(data_dir).unwrap();
        let clean_bootstrap_ms = t.elapsed().as_millis();
        drop(conn);

        eprintln!("empty_db phase breakdown (ms):");
        eprintln!("  open={open_ms}");
        eprintln!("  quick_check={quick_check_ms}");
        eprintln!("  migrations+seed={migrations_ms}");
        eprintln!("  snapshot_backup={snapshot_ms}");
        eprintln!("  orphan_cleanup={orphan_ms}");
        eprintln!("  first_path_sum={}", open_ms + quick_check_ms + migrations_ms + snapshot_ms + orphan_ms);
        eprintln!("  dirty_bootstrap(re)={dirty_bootstrap_ms}");
        eprintln!("  clean_bootstrap(re)={clean_bootstrap_ms}");
    }

    /// repo::orphan_hold::purge_stale 이 이 값 하나로 회수 여부를 결정한다 — 이름 패턴이
    /// restore_from_backup 이 실제로 만드는 패턴과 어긋나면 조용히 과다/과소 판정된다.
    #[test]
    fn quarantine_exists_detects_corrupt_db_file_and_ignores_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!quarantine_exists(dir.path()), "empty data_dir must report no quarantine");

        std::fs::write(dir.path().join("brise.db"), b"live").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"unrelated").unwrap();
        assert!(!quarantine_exists(dir.path()), "unrelated files must not count as quarantine");

        std::fs::write(dir.path().join("brise.corrupt-abc123.db"), b"quarantined").unwrap();
        assert!(quarantine_exists(dir.path()), "a brise.corrupt-*.db file must be detected");
    }
}

/// 온라인 백업 API로 일관된 스냅샷을 backups/에 생성. WAL 상태와 무관하게 정합.
pub fn snapshot_backup(conn: &Connection, backups: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(backups).map_err(io)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%6f");
    let suffix = &uuid::Uuid::new_v4().to_string()[..8];
    let dest = backups.join(format!("brise-{stamp}-{suffix}.db"));
    conn.backup(MAIN_DB, &dest, None).map_err(db)?;
    Ok(dest)
}

/// backups/ 의 brise-*.db 파일을 이름 오름차순 정렬 후 최신 `keep`개만 남기고 삭제.
pub fn rotate_backups(backups: &Path, keep: usize) -> AppResult<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(backups)
        .map_err(io)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("brise-") && n.ends_with(".db"))
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

/// Settings redesign (Données ②): 사용자가 고른 스케줄(backup_auto_interval/keep)에 따라 전체
/// zip 백업(repo/transfer/backup.rs::auto_backup_run)이 필요하면 백그라운드 스레드로 띄운다.
/// 위의 snapshot_backup/rotate_backups(brise-*.db, R3 손상 복구 안전망)와는 별개 시스템이다 —
/// 그건 그대로 둔다.
///
/// bootstrap() 안이 아니라 여기 별도 pub fn 으로 뺀 이유: bootstrap() 은 테스트에서 임시
/// 디렉토리에 반복 호출된다(현재 ~10곳). 기본값이 "weekly" + 새 임시 디렉토리는 auto 백업이
/// 하나도 없으므로 auto_backup_due 가 항상 true 를 반환해, bootstrap() 안에 두면 테스트마다
/// 매번 별도 커넥션을 여는 백그라운드 스레드가 뜬다 — 임시 디렉토리 정리와 경합하고(Windows
/// 파일 잠금), content_hash 백필과 같은 이유로 WAL 체크포인트 불변식도 깨질 수 있다(위 주석
/// 참고). 그래서 실제 앱 부팅 경로에서만, lib.rs 의 setup() 이 bootstrap() 성공 뒤에 호출한다.
pub fn maybe_spawn_auto_backup(conn: &Connection, data_dir: &Path) {
    let settings = crate::repo::settings::get_all(conn).unwrap_or_default();
    let interval = settings
        .get("backup_auto_interval")
        .and_then(|v| v.as_str())
        .unwrap_or("weekly")
        .to_string();
    if interval == "off" {
        return;
    }
    let keep = settings
        .get("backup_auto_keep")
        .and_then(|v| v.as_i64())
        .unwrap_or(3)
        .max(1) as usize;

    let backups = backups_dir(data_dir);
    let newest_mtime = crate::repo::transfer::backup::newest_auto_backup(&backups)
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok());
    if !crate::repo::transfer::backup::auto_backup_due(newest_mtime, &interval, std::time::SystemTime::now()) {
        return;
    }

    let data_dir = data_dir.to_path_buf();
    std::thread::spawn(move || {
        if let Err(e) = crate::repo::transfer::backup::auto_backup_run(&data_dir, keep) {
            crate::diag::warn("backup", "auto_backup_failed", format!("{e}"));
        }
    });
}

/// 앱이 며칠씩 떠 있어도 스케줄(daily/weekly)이 지켜지게 — 부팅 때 한 번만 보던 것을 주기 확인으로.
/// "daily" 의 최소 단위(24h)보다 충분히 짧아야 기한 직후에 잡힌다.
pub const AUTO_BACKUP_TICK: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// 부팅 경로(lib.rs setup) 전용 — bootstrap() 에선 부르지 않는다(maybe_spawn_auto_backup 주석 참고).
/// 매 틱마다 새 커넥션을 열어 설정(간격 변경·off 포함)을 다시 읽고 기한 판단은 기존 로직에 맡긴다.
pub fn start_auto_backup_ticker(data_dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(AUTO_BACKUP_TICK);
        match open(&db_path(&data_dir)) {
            Ok(conn) => maybe_spawn_auto_backup(&conn, &data_dir),
            Err(e) => crate::diag::warn("backup", "auto_backup_tick_open_failed", format!("{e}")),
        }
    });
}
