// repo: data_location — 저장 위치 조회/점검/이동 (PLAN-2026-09-28-onboarding-rebuild.md §6 D1~D5).
//
// 일반 로컬 폴더는 전부 옮긴다(D2) — DB 는 SQLite 온라인 백업 API(살아있는 WAL 상태와 무관하게
// 일관 스냅샷, db::snapshot_backup 과 동일 기법) + 복사본 PRAGMA integrity_check, 나머지는 파일 복사.
// 클라우드 동기화 폴더(OneDrive 등)는 DB 는 로컬에 두고 첨부·백업만 옮긴다(D3) — 살아있는
// SQLite(WAL)를 동기화 클라이언트가 조각조각 올리면 깨진 DB 가 된다(SQLite 공식 경고, 두 PC 동시
// 사용은 한쪽을 덮는다). 원본은 어느 경우든 지우지 않는다(실패 시 복구 가능) — 실제 전환은 포인터
// 파일을 다음 부팅이 읽을 때 일어난다(D4, db::set_dir_overrides).
use crate::db;
use crate::error::{db as dberr, io, AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const POINTER_FILE: &str = "data_location.json";

/// 기본 앱 데이터 폴더에 두는 고정점 — 위치를 옮겨도 다음 부팅이 항상 여기서 찾는다(§6 구현 계약).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Pointer {
    pub root: Option<PathBuf>,
    pub attachments: Option<PathBuf>,
    pub backups: Option<PathBuf>,
}

pub fn pointer_path(default_data_dir: &Path) -> PathBuf {
    default_data_dir.join(POINTER_FILE)
}

/// 지금 실효 적용 중인 저장 레이아웃 — 커맨드 레이어가 `db::attachments_dir`/`backups_dir`
/// (override-aware, 부팅 시 세팅된 OnceLock 반영)로 만들어 `apply()` 에 넘긴다. `apply()` 자체는
/// 그 OnceLock 을 절대 읽지 않는다 — 프로세스 전역이라 테스트에서 세팅할 수 없으므로(파일 하단
/// 테스트 모듈 경고 참고), split(D3) 상태를 흉내 내려면 이 구조체 필드에 임의 경로를 직접
/// 채워 넣는 것만이 유일한 방법이다(REVIEW #1).
pub struct Layout {
    pub data_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub backups_dir: PathBuf,
}

/// 파일이 없으면 조용히 기본값(전부 None) — "지금까지처럼 기본 위치"는 정상 상태라 경고가
/// 아니다. 있는데 못 읽거나 파싱이 깨지면(외부 편집·디스크 오류) pointer_root_missing 과 같은
/// 급으로 diag error + notify_user 를 남기고(REVIEW #4 — 사용자가 위치 이동이 조용히 원복된
/// 걸 알아야 한다) 그래도 기본값으로 폴백한다 — 절대 패닉하지 않는다.
pub fn read_pointer(default_data_dir: &Path) -> Pointer {
    let path = pointer_path(default_data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Pointer::default(),
        Err(e) => {
            crate::diag::error("data_location", "pointer_unreadable", format!("{e}"));
            crate::diag::notify_user("data_location", "pointer_unreadable", &[("error", format!("{e}"))]);
            return Pointer::default();
        }
    };
    match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            crate::diag::error("data_location", "pointer_corrupt", format!("{e}"));
            crate::diag::notify_user("data_location", "pointer_corrupt", &[("error", format!("{e}"))]);
            Pointer::default()
        }
    }
}

/// temp 파일에 쓰고 최종 이름으로 rename — 쓰는 도중 크래시해도 포인터는 "이전 그대로" 아니면
/// "새 값 그대로"만 존재한다(REVIEW #4). std::fs::rename 은 Windows(MoveFileExW+REPLACE_EXISTING)
/// /Unix(rename(2)) 모두 목적지가 이미 있어도 원자적으로 덮어쓰므로 remove-then-rename 은 불필요.
fn write_pointer(default_data_dir: &Path, pointer: &Pointer) -> AppResult<()> {
    let json = serde_json::to_string_pretty(pointer).map_err(|e| AppError::Io(e.to_string()))?;
    let tmp_path = default_data_dir.join(format!("{POINTER_FILE}.tmp-{}", crate::util::new_id()));
    std::fs::write(&tmp_path, json).map_err(io)?;
    std::fs::rename(&tmp_path, pointer_path(default_data_dir)).map_err(io)
}

/// lib.rs::setup 이 부팅 시 한 번 계산하는 실효 데이터 루트.
///
/// 포인터의 root 가 존재하지 않는 폴더를 가리키면(외장 드라이브 분리 등) — 부팅을 막는 네이티브
/// 다이얼로그 대신 **기본 위치로 폴백** 쪽을 택했다: 여기서는 포인터 파일 자체를 되돌려 쓰지
/// 않으므로, 그 폴더가 다시 붙으면 다음 부팅이 다시 찾는다. 그 사이 사용자는 빈 기본 DB로라도
/// 앱을 계속 쓸 수 있다(원본 데이터는 그대로 남아 있어 복구 가능) — 결정 기록: PLAN §6.
pub fn effective_data_dir(default_data_dir: &Path, pointer: &Pointer) -> PathBuf {
    match &pointer.root {
        Some(root) if root.is_dir() => root.clone(),
        Some(root) => {
            crate::diag::error("data_location", "pointer_root_missing", root.display().to_string());
            crate::diag::notify_user(
                "data_location",
                "pointer_root_missing",
                &[("path", root.display().to_string())],
            );
            default_data_dir.to_path_buf()
        }
        None => default_data_dir.to_path_buf(),
    }
}

// ---- 클라우드 폴더 판정(D3, Windows 우선) — 오탐이면 사용자가 다른 폴더를 고르면 된다뿐이라
// 안전한 방향(분리 이동)으로 치우친 저비용 휴리스틱. 실제 env/파일 조회는 여기서, 판단 자체는
// match_cloud_provider (순수 함수, 아래) 가 맡는다 — 단위테스트가 실제 env/디스크를 건드리지
// 않고 케이스를 돌릴 수 있게.
fn under(path: &Path, root: &Path) -> bool {
    !root.as_os_str().is_empty() && (path == root || path.starts_with(root))
}

fn match_cloud_provider(
    path: &Path,
    onedrive_roots: &[PathBuf],
    dropbox_roots: &[PathBuf],
    icloud_root: Option<&Path>,
) -> Option<&'static str> {
    for root in onedrive_roots {
        if under(path, root) {
            return Some("onedrive");
        }
    }
    for root in dropbox_roots {
        if under(path, root) {
            return Some("dropbox");
        }
    }
    if let Some(root) = icloud_root {
        if under(path, root) {
            return Some("icloud");
        }
    }
    // Google Drive 는 전용 API 가 없어 경로 문자열 힌트만으로 판정한다(내 드라이브/공유
    // 드라이브/DriveFS 마운트 — Google Drive 데스크톱 클라이언트가 실제로 쓰는 이름들).
    let s = path.to_string_lossy();
    if s.contains("My Drive") || s.contains("내 드라이브") || s.contains("Shared drives") || s.contains("DriveFS") {
        return Some("google_drive");
    }
    None
}

/// Dropbox info.json — %APPDATA%/Dropbox/info.json 또는 %LOCALAPPDATA%/Dropbox/info.json,
/// `{ "personal": { "path": "..." }, "business": { "path": "..." } }`. 없거나 파싱에 실패하면
/// 빈 목록(클라우드 아님으로 처리) — best-effort 휴리스틱이라 실패를 에러로 올리지 않는다.
fn dropbox_roots_from_env() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Ok(base) = std::env::var(var) else { continue };
        let info_path = Path::new(&base).join("Dropbox").join("info.json");
        let Ok(text) = std::fs::read_to_string(&info_path) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        for key in ["personal", "business"] {
            if let Some(p) = json.get(key).and_then(|v| v.get("path")).and_then(|v| v.as_str()) {
                roots.push(PathBuf::from(p));
            }
        }
    }
    roots
}

pub fn cloud_provider(path: &Path) -> Option<String> {
    let onedrive_roots: Vec<PathBuf> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .map(PathBuf::from)
        .collect();
    let dropbox_roots = dropbox_roots_from_env();
    let icloud_root = std::env::var("USERPROFILE").ok().map(|h| Path::new(&h).join("iCloudDrive"));
    match_cloud_provider(path, &onedrive_roots, &dropbox_roots, icloud_root.as_deref())
        .map(|s| s.to_string())
}

/// 폴더가 있으면 그 안에, 없으면(새로 만들어질 폴더) 상위 폴더에 프로브 파일을 써 본다.
fn is_writable(dir: &Path) -> bool {
    let probe_dir = if dir.exists() {
        dir.to_path_buf()
    } else {
        match dir.parent() {
            Some(p) if p.exists() => p.to_path_buf(),
            _ => return false,
        }
    };
    let probe = probe_dir.join(format!(".brise-write-probe-{}", crate::util::new_id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn dir_size(dir: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0i64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += dir_size(&path);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len() as i64;
        }
    }
    total
}

/// 지금 위치(DB + attachments/ + backups/)가 차지하는 총 바이트 — 옮길 대상 크기.
pub fn current_data_bytes(current_data_dir: &Path) -> i64 {
    dir_size(&db::attachments_dir(current_data_dir))
        + dir_size(&db::backups_dir(current_data_dir))
        + std::fs::metadata(db::db_path(current_data_dir)).map(|m| m.len() as i64).unwrap_or(0)
}

pub struct Inspection {
    pub cloud_provider: Option<String>,
    pub writable: bool,
    pub has_existing_data: bool,
    pub free_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    pub current_data_bytes: i64,
}

/// 후보 폴더 점검 — 아무것도 바꾸지 않는다(적용은 `apply`).
pub fn inspect(path: &Path, current_data_dir: &Path) -> Inspection {
    // fs4 는 존재하는 경로가 필요하다 — 아직 없는(만들어질) 폴더는 상위 폴더 기준으로 본다
    // (disk_free_bytes 와 같은 관례, repo/settings.rs).
    let stat_base: PathBuf = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf())
    };
    let free_bytes = fs4::available_space(&stat_base).ok().map(|v| v as i64);
    let total_bytes = fs4::total_space(&stat_base).ok().map(|v| v as i64);
    Inspection {
        cloud_provider: cloud_provider(path),
        writable: is_writable(path),
        has_existing_data: path.join(db::DB_FILE).exists(),
        free_bytes,
        total_bytes,
        current_data_bytes: current_data_bytes(current_data_dir),
    }
}

/// 존재하는 가장 가까운 조상까지만 canonicalize 하고 남은 구성요소를 그대로 붙인다.
/// `target` 이 아직 없는(새로 만들 폴더) 경로면 `std::fs::canonicalize` 는 그냥 실패하는데,
/// 그러면 원본 비-정규화 문자열이 남아 다른 쪽(존재해서 정규화된, Windows 라면 `\\?\` 접두가
/// 붙은)과 컴포넌트 비교가 틀어진다(REVIEW #5) — "아직 없는 폴더도 안쪽 판정은 정확해야 한다"가
/// 계약이라 상위만 정규화하고 나머지는 이어붙인다.
fn canonicalize_lenient(path: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(path) {
        return c;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        tail.push(cur.file_name().unwrap_or_default().to_os_string());
        if let Ok(mut base) = std::fs::canonicalize(parent) {
            for part in tail.iter().rev() {
                base.push(part);
            }
            return base;
        }
        cur = parent;
    }
    path.to_path_buf()
}

/// `target` 이 `current` 와 같거나 그 안쪽인지 — Windows 는 대소문자를 구분하지 않는
/// 파일시스템이라 컴포넌트를 대소문자 무시로 비교한다(REVIEW #5).
fn path_is_same_or_inside(target: &Path, current: &Path) -> bool {
    let target_parts: Vec<_> = target.components().collect();
    let current_parts: Vec<_> = current.components().collect();
    if current_parts.len() > target_parts.len() {
        return false;
    }
    current_parts.iter().zip(target_parts.iter()).all(|(c, t)| {
        c.as_os_str().to_string_lossy().to_lowercase() == t.as_os_str().to_string_lossy().to_lowercase()
    })
}

/// 이동 대상(현재 위치에서 override-aware 한 실효 첨부/백업 디렉토리) 하나를 새 위치로 복사한다.
/// 있으면 통째로 복사, 아직 없으면(예: 첫 부팅 직후라 backups/ 가 안 생겼을 때) 빈 폴더만 만든다
/// — D2/D3 두 분기가 완전히 같은 모양이라 공유한다.
fn copy_effective_dir(src: &Path, dest: &Path) -> AppResult<()> {
    if src.exists() {
        crate::repo::transfer::reset::copy_dir_all(src, dest)
    } else {
        std::fs::create_dir_all(dest).map_err(io)
    }
}

/// D2/D3 적용 — 복사만 하고 원본은 남긴다. 반환값은 split(true=D3 첨부·백업만 이동) 여부.
/// 실제 전환(경로 재정의)은 이 함수가 쓰는 포인터 파일을 다음 부팅이 읽을 때 일어난다(D4).
pub fn apply(conn: &Connection, default_data_dir: &Path, layout: &Layout, target: &Path) -> AppResult<bool> {
    let canon_target = canonicalize_lenient(target);
    let canon_current = canonicalize_lenient(&layout.data_dir);
    if path_is_same_or_inside(&canon_target, &canon_current) {
        return Err(AppError::Validation(
            "선택한 폴더가 현재 저장 위치와 같거나 그 안쪽입니다.".to_string(),
        ));
    }
    if !is_writable(target) {
        return Err(AppError::Validation("선택한 폴더에 쓸 수 없습니다.".to_string()));
    }
    if target.join(db::DB_FILE).exists() {
        return Err(AppError::Validation(
            "선택한 폴더에 이미 다른 브리즈 데이터가 있습니다.".to_string(),
        ));
    }

    let mut pointer = read_pointer(default_data_dir);

    if cloud_provider(target).is_some() {
        // D3: DB 는 그대로, 첨부·백업만 이동.
        let new_att = target.join(db::ATTACHMENTS_DIR);
        let new_backups = target.join(db::BACKUPS_DIR);
        copy_effective_dir(&layout.attachments_dir, &new_att)?;
        copy_effective_dir(&layout.backups_dir, &new_backups)?;
        pointer.attachments = Some(new_att);
        pointer.backups = Some(new_backups);
        write_pointer(default_data_dir, &pointer)?;
        Ok(true)
    } else {
        // D2: 전부 옮긴다 — DB 는 온라인 백업 API(일관 스냅샷) + 복사본 PRAGMA integrity_check
        // (quick_check 보다 철저한 전체 검증 — 이건 딱 한 번, 이사할 때만 하는 비용이라 아깝지 않다).
        std::fs::create_dir_all(target).map_err(io)?;
        let new_db = target.join(db::DB_FILE);
        conn.backup(rusqlite::MAIN_DB, &new_db, None).map_err(dberr)?;
        {
            let check_conn = Connection::open(&new_db).map_err(dberr)?;
            let result: String = check_conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .map_err(dberr)?;
            if result != "ok" {
                return Err(AppError::Db(format!("copied database failed integrity_check: {result}")));
            }
        }

        // 첨부·백업은 override-aware 실효 경로에서 옮긴다 — D3 로 분리해 둔 채 D2 를 다시 걸면
        // data_dir/attachments 의 로컬 잔여물(분리 이후로 갱신이 끊긴 stale 복사본)이 아니라
        // 지금 실제로 쓰이고 있는 폴더(클라우드 쪽일 수 있다)가 옮겨져야 한다(REVIEW #1).
        copy_effective_dir(&layout.attachments_dir, &target.join(db::ATTACHMENTS_DIR))?;
        copy_effective_dir(&layout.backups_dir, &target.join(db::BACKUPS_DIR))?;

        // workspace_bg/emoji/slide_previews/canvas_pages(휴면)/diag 로그 등 data_dir 최상위의
        // 나머지 전부 — 브리즈DB(및 -wal/-shm)·포인터 파일·위에서 이미 옮긴 attachments/backups
        // 만 빼고 구조 보존 복사한다(허용 목록을 두면 새 디렉토리가 생길 때마다 여기도 잊고 안
        // 고쳐 조용히 데이터를 두고 가게 된다 — §6 구현 계약 "anything else"). attachments/
        // backups 를 여기서도 또 건드리면 방금 위에서 복사한 실효 버전을 로컬 top-level의
        // stale 버전으로 덮어써버리므로 반드시 제외한다.
        let db_wal = format!("{}-wal", db::DB_FILE);
        let db_shm = format!("{}-shm", db::DB_FILE);
        for entry in std::fs::read_dir(&layout.data_dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == db::DB_FILE
                || name_str == db_wal
                || name_str == db_shm
                || name_str == POINTER_FILE
                || name_str == db::ATTACHMENTS_DIR
                || name_str == db::BACKUPS_DIR
            {
                continue;
            }
            let dest = target.join(&name);
            if entry.file_type().map_err(io)?.is_dir() {
                crate::repo::transfer::reset::copy_dir_all(&entry.path(), &dest)?;
            } else {
                std::fs::copy(entry.path(), &dest).map_err(io)?;
            }
        }
        pointer.root = Some(target.to_path_buf());
        // 새 root 아래서 attachments/backups 는 자연히 join() 으로 해석된다 — 분리 재정의는 무의미.
        pointer.attachments = None;
        pointer.backups = None;
        write_pointer(default_data_dir, &pointer)?;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ db::set_dir_overrides 는 이 파일에서 절대 호출하지 않는다 — 파일 상단 OnceLock 주석 참고
    // (프로세스 전역 static, 테스트 격리 불가). 아래 테스트는 모두 override 없는 기본 경로만 본다.

    #[test]
    fn read_pointer_defaults_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = read_pointer(dir.path());
        assert!(p.root.is_none() && p.attachments.is_none() && p.backups.is_none());
    }

    #[test]
    fn write_then_read_pointer_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = Pointer {
            root: Some(PathBuf::from("D:/brise-data")),
            attachments: None,
            backups: None,
        };
        write_pointer(dir.path(), &pointer).unwrap();
        let read_back = read_pointer(dir.path());
        assert_eq!(read_back.root, pointer.root);
    }

    // 실제 cloud_provider() 는 실행 머신의 env(OneDrive 등)/Dropbox info.json 을 본다 — 이
    // 프로세스가 실제로 OneDrive 아래에서 개발 중이면 값이 있을 수 있어 픽스처 경로로 직접
    // 단위테스트하면 실행 환경에 따라 흔들린다. 판정 로직 자체는 순수 함수 match_cloud_provider
    // 로 분리해 그것만 단위테스트한다(§6 구현 계약 "순수 매처 단위테스트").
    #[test]
    fn match_cloud_provider_detects_onedrive_root() {
        let root = PathBuf::from("/Users/x/OneDrive");
        let target = root.join("brise-data");
        assert_eq!(match_cloud_provider(&target, &[root], &[], None), Some("onedrive"));
    }

    #[test]
    fn match_cloud_provider_detects_dropbox_root() {
        let root = PathBuf::from("/Users/x/Dropbox");
        let target = root.join("brise-data");
        assert_eq!(match_cloud_provider(&target, &[], &[root], None), Some("dropbox"));
    }

    #[test]
    fn match_cloud_provider_detects_icloud_root() {
        let root = PathBuf::from("/Users/x/iCloudDrive");
        let target = root.join("brise-data");
        assert_eq!(match_cloud_provider(&target, &[], &[], Some(&root)), Some("icloud"));
    }

    #[test]
    fn match_cloud_provider_detects_google_drive_by_substring() {
        let target = PathBuf::from("/Users/x/Google Drive/My Drive/brise-data");
        assert_eq!(match_cloud_provider(&target, &[], &[], None), Some("google_drive"));
    }

    #[test]
    fn match_cloud_provider_detects_google_drive_korean_substring() {
        let target = PathBuf::from("/Users/x/구글드라이브/내 드라이브/brise-data");
        assert_eq!(match_cloud_provider(&target, &[], &[], None), Some("google_drive"));
    }

    #[test]
    fn match_cloud_provider_none_for_plain_local_folder() {
        let target = PathBuf::from("/Users/x/Documents/brise-data");
        assert_eq!(match_cloud_provider(&target, &[], &[], None), None);
    }

    #[test]
    fn match_cloud_provider_requires_a_real_ancestor_not_just_a_name_prefix() {
        // "/Users/x/OneDrive-old" 는 "/Users/x/OneDrive" 로 시작하는 문자열이지만 그 자식
        // 경로가 아니다 — 컴포넌트 단위(starts_with)로만 판정해야 오탐이 없다.
        let root = PathBuf::from("/Users/x/OneDrive");
        let target = PathBuf::from("/Users/x/OneDrive-old/brise-data");
        assert_eq!(match_cloud_provider(&target, &[root], &[], None), None);
    }

    #[test]
    fn read_pointer_warns_but_falls_back_to_default_when_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(pointer_path(dir.path()), b"not json").unwrap();
        let p = read_pointer(dir.path());
        assert!(p.root.is_none() && p.attachments.is_none() && p.backups.is_none());
    }

    #[test]
    fn effective_data_dir_falls_back_to_default_when_root_missing() {
        let default_dir = tempfile::tempdir().unwrap();
        let missing = default_dir.path().join("nope-does-not-exist");
        let pointer = Pointer { root: Some(missing), attachments: None, backups: None };
        let resolved = effective_data_dir(default_dir.path(), &pointer);
        assert_eq!(resolved, default_dir.path());
    }

    #[test]
    fn effective_data_dir_uses_root_when_it_exists() {
        let default_dir = tempfile::tempdir().unwrap();
        let root_dir = tempfile::tempdir().unwrap();
        let pointer = Pointer { root: Some(root_dir.path().to_path_buf()), attachments: None, backups: None };
        assert_eq!(effective_data_dir(default_dir.path(), &pointer), root_dir.path());
    }

    #[test]
    fn inspect_reports_has_existing_data_and_writable_for_plain_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new-location");
        std::fs::create_dir_all(&target).unwrap();
        let current = tempfile::tempdir().unwrap();
        let insp = inspect(&target, current.path());
        assert!(insp.writable);
        assert!(!insp.has_existing_data);
        assert_eq!(insp.cloud_provider, None);

        std::fs::write(target.join(db::DB_FILE), b"existing").unwrap();
        let insp2 = inspect(&target, current.path());
        assert!(insp2.has_existing_data);
    }

    /// override 없는 기본 상황의 Layout — db::attachments_dir/backups_dir 는 OnceLock 이
    /// 미설정이면 그냥 data_dir.join(...)이므로, 이걸로 만들면 옛 "current_data_dir 하나만
    /// 받던" 시절의 apply() 호출과 동일하다.
    fn default_layout(data_dir: &Path) -> Layout {
        Layout {
            data_dir: data_dir.to_path_buf(),
            attachments_dir: db::attachments_dir(data_dir),
            backups_dir: db::backups_dir(data_dir),
        }
    }

    #[test]
    fn apply_rejects_target_inside_current_data_dir() {
        let current = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let target = current.path().join("subfolder");
        std::fs::create_dir_all(&target).unwrap();
        let default_dir = tempfile::tempdir().unwrap();
        let err = apply(&conn, default_dir.path(), &default_layout(current.path()), &target).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // REVIEW #5 — canonicalize() 는 존재하는 경로가 필요해서, 아직 만들어지지 않은 target 은
    // 예전 코드에서 원본(비정규화) 문자열로 폴백했다. current_data_dir 은 항상 존재해서
    // canonicalize 가 성공하고(Windows 라면 `\\?\` 접두가 붙는다) 두 문자열이 전혀 다른 모양이
    // 돼 starts_with 가 뚫렸다 — 아직 없는 하위 폴더를 골라도 거부되지 않았다.
    #[test]
    fn apply_rejects_nonexistent_target_nested_inside_current_data_dir() {
        let current = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        // 실제로 만들지 않는다 — "새 폴더" 다이얼로그 흐름과 같다(inspect() 의 is_writable 관례).
        let target = current.path().join("not-yet-created").join("nested");
        let default_dir = tempfile::tempdir().unwrap();
        let err = apply(&conn, default_dir.path(), &default_layout(current.path()), &target).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn apply_rejects_target_with_existing_brise_db() {
        let current = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join(db::DB_FILE), b"other library").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let default_dir = tempfile::tempdir().unwrap();
        let err =
            apply(&conn, default_dir.path(), &default_layout(current.path()), other.path()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn apply_local_folder_copies_db_and_attachments_and_writes_root_pointer() {
        let current = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(current.path()).unwrap();
        std::fs::write(db::attachments_dir(current.path()).join("photo.jpg"), b"fake image").unwrap();

        let default_dir = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let new_root = target.path().join("brise-data");

        let split =
            apply(&conn, default_dir.path(), &default_layout(current.path()), &new_root).unwrap();
        assert!(!split, "일반 로컬 폴더는 분리 이동이 아니어야 한다(D2)");
        assert!(new_root.join(db::DB_FILE).exists());
        assert!(new_root.join(db::ATTACHMENTS_DIR).join("photo.jpg").exists());
        // 원본은 남아 있어야 한다(§6 D2 "원본은 남긴다").
        assert!(current.path().join(db::DB_FILE).exists());

        let pointer = read_pointer(default_dir.path());
        assert_eq!(pointer.root, Some(new_root));
        assert!(pointer.attachments.is_none() && pointer.backups.is_none());
    }

    // §6 구현 계약 "anything else under data_dir" — 허용 목록이 아니라 제외 목록이어야
    // slide_previews/canvas_pages 처럼 나중에 생기는 디렉토리도 저절로 옮겨진다. -wal/-shm/
    // 포인터 파일은 여전히 빠져야 한다(같은 폴더에 포인터가 이미 있는 경우 — D3 로 분리해 둔
    // 뒤 다시 D2 로 전체 이동하면 default_data_dir == current_data_dir 라 실제로 벌어지는 상황).
    #[test]
    fn apply_full_move_copies_arbitrary_extra_dirs_but_excludes_wal_shm_and_pointer() {
        // 실제 라이브 WAL 커넥션의 -wal/-shm 을 직접 건드리면 그 커넥션 자체가 위험해지므로,
        // 여기서는 conn 을 in-memory 로 두고(백업 API 자체 동작만 필요) current_data_dir 에는
        // 순수 파일들만 손으로 놓는다 — 이 테스트가 보는 건 apply() 의 복사 제외 목록 로직이다.
        let current = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        std::fs::write(current.path().join(db::DB_FILE), b"placeholder").unwrap();
        std::fs::write(current.path().join(format!("{}-wal", db::DB_FILE)), b"wal").unwrap();
        std::fs::write(current.path().join(format!("{}-shm", db::DB_FILE)), b"shm").unwrap();
        write_pointer(current.path(), &Pointer::default()).unwrap();
        // 허용 목록에 없던 디렉토리(예: slide_previews) — 제외 목록 방식이어야 옮겨진다.
        let extra_dir = current.path().join("slide_previews");
        std::fs::create_dir_all(&extra_dir).unwrap();
        std::fs::write(extra_dir.join("cache.pdf"), b"pdf").unwrap();

        let target = tempfile::tempdir().unwrap();
        let new_root = target.path().join("brise-data");
        // default_data_dir == current_data_dir: 포인터가 이미 같은 폴더에 있는 상황(D3 로
        // 분리해 둔 뒤 다시 D2 로 전체 이동하는 재이동 시나리오에서 실제로 벌어진다).
        let split =
            apply(&conn, current.path(), &default_layout(current.path()), &new_root).unwrap();
        assert!(!split);

        assert!(
            new_root.join("slide_previews").join("cache.pdf").exists(),
            "제외 목록 밖 디렉토리도 옮겨져야 한다"
        );
        assert!(!new_root.join(format!("{}-wal", db::DB_FILE)).exists());
        assert!(!new_root.join(format!("{}-shm", db::DB_FILE)).exists());
        assert!(!new_root.join(POINTER_FILE).exists());
    }

    // REVIEW #1 — D3(클라우드 분리)로 첨부가 이미 다른 폴더에 있는 상태에서 D2(전체 로컬 이동)를
    // 걸면, 분리 이후 새로 추가된 첨부는 로컬 top-level attachments/ 에는 없고 "실효" 폴더(여기서는
    // 분리를 흉내 낸 별도 temp 폴더)에만 있다. Layout 을 통해 그 실효 폴더를 넘기면 D2 가 그걸
    // 옮겨야 하고, 로컬에 남은 stale attachments/ 로 덮어쓰면 안 된다.
    #[test]
    fn apply_full_move_after_split_moves_effective_attachments_not_stale_local_copy() {
        let current = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(current.path()).unwrap();
        // 로컬 top-level attachments/ 는 분리 이전의 stale 사진만 있다.
        std::fs::write(db::attachments_dir(current.path()).join("stale.jpg"), b"stale").unwrap();

        // D3 로 분리된 "실효" 첨부/백업 폴더 — 분리 이후 추가된 사진은 여기에만 있다.
        let cloud = tempfile::tempdir().unwrap();
        let effective_att = cloud.path().join("attachments");
        let effective_backups = cloud.path().join("backups");
        std::fs::create_dir_all(&effective_att).unwrap();
        std::fs::create_dir_all(&effective_backups).unwrap();
        std::fs::write(effective_att.join("new-after-split.jpg"), b"new").unwrap();

        let layout = Layout {
            data_dir: current.path().to_path_buf(),
            attachments_dir: effective_att,
            backups_dir: effective_backups,
        };

        let target = tempfile::tempdir().unwrap();
        let new_root = target.path().join("brise-data");
        let default_dir = tempfile::tempdir().unwrap();
        let split = apply(&conn, default_dir.path(), &layout, &new_root).unwrap();
        assert!(!split, "일반 로컬 폴더는 D2 다");

        assert!(
            new_root.join(db::ATTACHMENTS_DIR).join("new-after-split.jpg").exists(),
            "분리 이후 실효 폴더에 추가된 첨부가 옮겨져야 한다"
        );
        assert!(
            !new_root.join(db::ATTACHMENTS_DIR).join("stale.jpg").exists(),
            "로컬에 남은 stale top-level attachments/ 가 실효 버전을 덮어쓰면 안 된다"
        );

        let pointer = read_pointer(default_dir.path());
        assert!(pointer.root.is_some());
        assert!(
            pointer.attachments.is_none() && pointer.backups.is_none(),
            "D2 후에는 root-only 로 되돌아가야 한다"
        );
    }

    #[test]
    fn apply_cloud_folder_splits_attachments_and_backups_but_keeps_db_local() {
        let current = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(current.path()).unwrap();
        std::fs::write(db::attachments_dir(current.path()).join("photo.jpg"), b"fake image").unwrap();

        let default_dir = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        // OneDrive/Dropbox/iCloud 판정은 실행 머신의 실제 env(OneDrive 등)를 읽는다(위
        // match_cloud_provider_* 순수함수 테스트 주석 참고) — 이 프로세스가 실제로 그런 env를
        // 갖는지는 머신마다 다르므로, apply() 를 통한 통합 테스트는 env 와 무관하게 경로
        // 문자열만으로 판정하는 Google Drive 힌트를 쓴다(cloud_provider() 자체가 이 경로만은
        // env 없이도 항상 감지한다 — 흔들리지 않는다).
        let cloud_root = target.path().join("Google Drive").join("My Drive").join("Brise");
        std::fs::create_dir_all(&cloud_root).unwrap();

        let split =
            apply(&conn, default_dir.path(), &default_layout(current.path()), &cloud_root).unwrap();
        assert!(split, "Google Drive 경로는 분리 이동이어야 한다(D3)");
        assert!(cloud_root.join(db::ATTACHMENTS_DIR).join("photo.jpg").exists());
        // DB 는 옮기지 않는다 — cloud_root 안에 brise.db 가 생기면 안 된다.
        assert!(!cloud_root.join(db::DB_FILE).exists());

        let pointer = read_pointer(default_dir.path());
        assert!(pointer.root.is_none(), "D3 는 root 를 바꾸지 않는다(DB 는 로컬 유지)");
        assert_eq!(pointer.attachments, Some(cloud_root.join(db::ATTACHMENTS_DIR)));
        assert_eq!(pointer.backups, Some(cloud_root.join(db::BACKUPS_DIR)));
    }
}
