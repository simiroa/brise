// P0 (docs/AUDIT-2026-09-26-fallback-observability.md §1): DB 손상 → 최신 백업으로 자동 복구 →
// 그 옛(복구된) DB 기준으로 고아 첨부/캔버스 이미지 디렉토리를 청소하던 경로가 remove_dir_all 로
// **삭제**했다. 백업 스냅샷은 하루 1회뿐이라, 스냅샷 이후 만든 노트는 DB엔 없지만 파일은 있는
// "고아처럼 보이는 생존자"가 된다 — 청소가 매 부팅 돈다는 점 때문에 복구 부팅 한 번만 건너뛰는
// 건 해법이 아니다(다음 부팅에 결국 지운다). 유일한 안전한 설계는 "고아 청소는 절대 지우지 않는다"
// — 대신 attachments/·spaces/ 밖의 보관함으로 옮긴다. 이 모듈이 그 이동 + (지연) 회수 정리를
// 양쪽 스윕(repo::attachments::orphan_cleanup, repo::canvas_page_image::dormant_orphan_cleanup)이
// 공유하는 한 곳에 모은다.
//
// 보관함은 attachments/ 의 **형제**(data_dir 바로 아래)다 — attachments/ 안에 두면 다음 스윕이
// 보관함 자체를 다시 스캔해 고아로 오인한다(db/mod.rs 의 workspace_bg/slide_previews 와 같은 이유).
// 형제 위치인 덕에 attachments_dir(data_dir) 만 훑는 다른 모든 경로(zip 백업, export/import,
// dir_sizes 사용량 집계)도 손대지 않고 자연히 제외된다 — 확인한 지점은 파일 하단 주석 참고.
use crate::error::{io, AppResult};
use crate::util::new_id;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use std::path::{Path, PathBuf};

/// attachments/·workspace_bg/ 와 형제인 보관 루트. 이름 자체가 "청소 대상 아님"을 말한다 —
/// orphan_cleanup(attachments::orphan_cleanup)이 note_id 로 오인해 재귀 청소하지 않도록 스캔
/// 루트(attachments_dir) 바깥에 둔다.
pub const HOLD_DIR: &str = "orphaned";

/// 보관 배치 디렉토리 이름 포맷 — 초 단위. purge_stale 이 이 포맷으로 되파싱해 나이를 판정한다.
const BATCH_FORMAT: &str = "%Y%m%d-%H%M%S";

/// 보관 배치를 그대로 두는 기간. 이보다 오래된 배치만, 그리고 격리(quarantine) DB 파일이 하나도
/// 없을 때만 purge_stale 이 지운다.
const RETENTION_DAYS: i64 = 30;

pub fn hold_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(HOLD_DIR)
}

fn current_batch_name() -> String {
    Utc::now().format(BATCH_FORMAT).to_string()
}

fn parse_batch_name(name: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(name, BATCH_FORMAT)
        .ok()
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

/// dest 가 이미 있으면(같은 초 안에 같은 id 가 두 번 격리되는 드문 경우) 유니크 접미사를 붙인다 —
/// 절대 덮어쓰지 않는다(덮어쓰면 먼저 격리된 쪽이 사라져 이동판 삭제나 다름없어진다).
fn unique_dest(dest: PathBuf) -> PathBuf {
    if !dest.exists() {
        return dest;
    }
    loop {
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let candidate = dest.with_file_name(format!("{name}-{}", new_id()));
        if !candidate.exists() {
            return candidate;
        }
    }
}

/// 고아로 판정된 디렉토리 하나를 `<data_dir>/orphaned/<YYYYMMDD-HHMMSS>/<category>/<id>` 로
/// **이동**한다(삭제 아님). `category` 는 attachments::ATTACHMENTS_DIR 또는
/// canvas_page_image::SPACE_IMAGE_ROOT 같은 문자열 상수를 그대로 쓴다(캔버스 플러그인 제거
/// 2026-09-28 뒤 CANVAS_PAGE_IMAGE_ROOT 는 휴면 — 어떤 스윕도 그 디렉토리를 옮기지 않는다).
///
/// 이동이 실패하면(크로스 디바이스, 파일 잠금 등) 원본을 제자리에 남기고 에러만 반환한다 —
/// **절대 삭제로 대체하지 않는다.** rename 은 원자적이라 실패 시 부분 상태가 생기지 않는다.
/// 호출자는 기존 "청소 실패가 부팅을 막으면 안 된다" 관례대로 `let _ =` 로 받는다.
pub fn move_to_holding(data_dir: &Path, category: &str, id: &str, src: &Path) -> AppResult<()> {
    let dest_dir = hold_dir(data_dir).join(current_batch_name()).join(category);
    std::fs::create_dir_all(&dest_dir).map_err(io)?;
    let dest = unique_dest(dest_dir.join(id));
    std::fs::rename(src, &dest).map_err(io)
}

/// 보관함 안의 오래된 배치를 지운다 — RETENTION_DAYS 보다 오래된 배치만, 그리고 data_dir 에
/// brise.corrupt-*.db 격리 파일이 하나라도 있으면 **전부 건너뛴다**(사용자가 복구 조사를 위해
/// 옛 파일을 찾아볼 수도 있는 창이라, 바로 그 순간에 회수 경로를 지우면 안 된다).
///
/// 이름을 못 읽는(포맷이 안 맞는) 배치 디렉토리는 나이를 알 수 없으니 그대로 둔다 — 지우지
/// 못하는 쪽으로 fail-safe.
pub fn purge_stale(data_dir: &Path) -> AppResult<()> {
    if crate::db::quarantine_exists(data_dir) {
        return Ok(());
    }
    let root = hold_dir(data_dir);
    if !root.exists() {
        return Ok(());
    }
    let cutoff = Utc::now() - Duration::days(RETENTION_DAYS);
    for entry in std::fs::read_dir(&root).map_err(io)? {
        let entry = entry.map_err(io)?;
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(ts) = parse_batch_name(&name) {
            if ts < cutoff {
                // purge 는 청소 스윕과 달리 진짜 삭제가 목적이다(30일 + 격리 파일 없음이라는
                // 이중 조건을 이미 통과한 뒤) — best-effort 로 남기되 실패해도 다음 부팅에 재시도된다.
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_to_holding_moves_not_copies_and_stays_readable() {
        let data_dir = tempfile::tempdir().unwrap();
        let src = data_dir.path().join("attachments").join("ghost-note");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("photo.png"), b"orphan bytes").unwrap();

        move_to_holding(data_dir.path(), "attachments", "ghost-note", &src).unwrap();

        assert!(!src.exists(), "original location must be gone (moved, not copied)");
        let held = hold_dir(data_dir.path());
        let batch = std::fs::read_dir(&held)
            .unwrap()
            .next()
            .expect("a batch dir must exist")
            .unwrap()
            .path();
        let moved = batch.join("attachments").join("ghost-note").join("photo.png");
        assert_eq!(std::fs::read(&moved).unwrap(), b"orphan bytes", "content must survive the move");
    }

    #[test]
    fn move_to_holding_never_deletes_on_failure() {
        // rename 의 목적지 부모를 파일로 막아 create_dir_all 이 실패하게 만든다 — 실패해도
        // 원본은 그대로 남아야 한다(삭제 폴백 금지).
        let data_dir = tempfile::tempdir().unwrap();
        let src = data_dir.path().join("attachments").join("note1");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("f.txt"), b"keep me").unwrap();

        // orphaned/ 자리를 파일로 선점 — 그 밑에 배치 디렉토리를 만들 수 없다.
        std::fs::write(hold_dir(data_dir.path()), b"not a directory").unwrap();

        let err = move_to_holding(data_dir.path(), "attachments", "note1", &src);
        assert!(err.is_err(), "create_dir_all must fail with orphaned/ occupied by a file");
        assert!(src.join("f.txt").is_file(), "source must be untouched after a failed move");
    }

    #[test]
    fn purge_stale_removes_old_batches_but_keeps_recent_ones() {
        let data_dir = tempfile::tempdir().unwrap();
        let held = hold_dir(data_dir.path());
        let old_batch = held.join("20200101-000000").join("attachments").join("old-note");
        let recent_batch = held.join(current_batch_name()).join("attachments").join("new-note");
        std::fs::create_dir_all(&old_batch).unwrap();
        std::fs::create_dir_all(&recent_batch).unwrap();
        std::fs::write(old_batch.join("f.txt"), b"old").unwrap();
        std::fs::write(recent_batch.join("f.txt"), b"new").unwrap();

        purge_stale(data_dir.path()).unwrap();

        assert!(!held.join("20200101-000000").exists(), "batch older than 30 days must be purged");
        assert!(recent_batch.join("f.txt").is_file(), "recent batch must survive");
    }

    #[test]
    fn purge_stale_skips_everything_while_a_quarantine_file_exists() {
        // 이것이 바로 P0 시나리오다: 복구 직후엔 brise.corrupt-*.db 가 살아있고, 그 사이엔
        // 오래된 배치라도(사용자가 아직 복구를 조사 중일 수 있으니) 절대 지우면 안 된다.
        let data_dir = tempfile::tempdir().unwrap();
        std::fs::write(data_dir.path().join("brise.corrupt-abc123.db"), b"quarantined").unwrap();
        let held = hold_dir(data_dir.path());
        let old_batch = held.join("20200101-000000").join("attachments").join("old-note");
        std::fs::create_dir_all(&old_batch).unwrap();
        std::fs::write(old_batch.join("f.txt"), b"old").unwrap();

        purge_stale(data_dir.path()).unwrap();

        assert!(
            held.join("20200101-000000").exists(),
            "purge must be skipped entirely while a corrupt-db quarantine file exists"
        );
    }

    #[test]
    fn purge_stale_leaves_unparseable_batch_names_alone() {
        let data_dir = tempfile::tempdir().unwrap();
        let held = hold_dir(data_dir.path());
        let weird = held.join("not-a-timestamp");
        std::fs::create_dir_all(&weird).unwrap();

        purge_stale(data_dir.path()).unwrap();

        assert!(weird.exists(), "unparseable batch name must be left alone, not guessed at");
    }
}
