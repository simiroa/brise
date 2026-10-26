// 캔버스 플러그인은 2026-09-28 에 코드에서 제거됐다(테이블 canvas_pages/canvas_page_items/
// canvas_page_edges 와 디스크의 attachments/canvas_pages/ 는 휴면으로 남는다 — 마이그레이션 없음).
// 이 파일에 남은 것은 두 가지뿐이다:
//
// 1. **휴면 spaces/space_items 전용** — SPACE_IMAGE_ROOT + identity_copy_pairs/remapped_copy_pairs/
//    remap_source_id 3종 + dormant_orphan_cleanup. 살아있는 노트북 백업/복원 기능(transfer/bundle.rs,
//    transfer/import/mod.rs)이 옛 번들을 왕복시키려고 쓴다.
// 2. **휴면 canvas_pages 보존** — CANVAS_PAGE_IMAGE_ROOT 는 attachments::orphan_cleanup 이 이 디렉토리를
//    노트 첨부로 오인해 치우지 않게 하는 예약 루트로만 남고, migrate_active_page_dirs 는 V66 이전에서
//    바로 올라오는 설치본의 디스크 경로를 V66 이 재작성한 source_id 와 맞춰 둔다.
//
// 두 루트를 섞으면 안 된다.
use crate::db;
use crate::error::{io, AppResult};
use crate::repo::attachments::thumb_rel_for;
use crate::repo::paths::safe_rel;
use crate::repo::transfer::export::SpaceItemRow;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// dormant-only: 휴면 spaces/space_items(노트북 백업/복원, transfer/bundle.rs)가 계속 쓰는 구
/// attachments 루트. orphan_cleanup(attachments::orphan_cleanup) must skip this dir (it is not
/// a note_id). 절대 CANVAS_PAGE_IMAGE_ROOT 와 합치거나 이 값 자체를 바꾸지 않는다 — 바꾸면
/// 디스크 파일과 spaces/space_items 행의 source_id 접두가 어긋난다.
pub const SPACE_IMAGE_ROOT: &str = "spaces";

/// 휴면 캔버스 페이지(canvas_pages/canvas_page_items) 이미지의 attachments 루트.
/// orphan_cleanup(attachments::orphan_cleanup) must skip this dir (it is not a note_id).
// ponytail: 캔버스 플러그인 제거(2026-09-28) 뒤 이 디렉토리는 어떤 스윕도 건드리지 않는다 — 활성판
// orphan_cleanup 을 지웠고, 예약 루트라 첨부 스윕도 건너뛴다. 데이터를 정말 버리기로 하면 테이블
// DROP 마이그레이션과 함께 이 디렉토리를 지우고 이 상수를 뺀다.
pub const CANVAS_PAGE_IMAGE_ROOT: &str = "canvas_pages";

/// dormant-only (spaces/space_items 노트북 백업/복원 전용 — transfer/bundle.rs, transfer/
/// import/mod.rs 가 소비).
///
/// Rewrite `spaces/{old_space_id}/file` through a space-id remap. Unmapped ids stay
/// as-is so the row survives as a broken-image tombstone instead of being dropped.
pub fn remap_source_id(source_id: &str, space_map: &HashMap<String, String>) -> String {
    let Some((first, rest)) = source_id.split_once('/') else {
        return source_id.to_string();
    };
    if first != SPACE_IMAGE_ROOT {
        return source_id.to_string();
    }
    let Some((old_id, file)) = rest.split_once('/') else {
        return source_id.to_string();
    };
    match space_map.get(old_id) {
        Some(new_id) => format!("{SPACE_IMAGE_ROOT}/{new_id}/{file}"),
        None => source_id.to_string(),
    }
}

fn file_and_thumb(rel: &str) -> [String; 2] {
    [rel.to_string(), thumb_rel_for(rel)]
}

/// dormant-only (spaces/space_items 노트북 백업/복원 전용 — SpaceItemRow 자체가 그 스키마).
///
/// (src_rel, dst_rel) pairs for identity copy (merge/replace/export).
pub fn identity_copy_pairs(items: &[SpaceItemRow]) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for item in items.iter().filter(|i| i.kind == "image") {
        let Some(rel) = item.source_id.as_deref() else {
            continue;
        };
        for r in file_and_thumb(rel) {
            pairs.push((r.clone(), r));
        }
    }
    pairs
}

/// dormant-only (spaces/space_items 노트북 백업/복원 전용 — SpaceItemRow 자체가 그 스키마).
///
/// (src_rel, dst_rel) pairs when space ids (and therefore source_id prefixes) remap.
/// Built from the original items + space-id map so zip-order of remapped rows cannot
/// scramble files if items were inserted grouped by space.
pub fn remapped_copy_pairs(
    orig: &[SpaceItemRow],
    space_map: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for item in orig.iter().filter(|i| i.kind == "image") {
        let Some(src) = item.source_id.as_deref() else {
            continue;
        };
        let dst = remap_source_id(src, space_map);
        for (s, d) in file_and_thumb(src).into_iter().zip(file_and_thumb(&dst)) {
            pairs.push((s, d));
        }
    }
    pairs
}

/// dormant-only: spaces/space_items(노트북 백업/복원 전용)를 SPACE_IMAGE_ROOT 기준으로만 청소한다.
/// canvas_pages/ 는 절대 보지 않는다(각 세대는 자기 루트만 — 다른 세대의 파일을 건드리지 않는다).
/// 삭제 금지(P0, docs/AUDIT-2026-09-26-fallback-observability.md §1) — 고아 판정된 디렉토리는
/// repo::orphan_hold 보관함으로 옮긴다.
pub fn dormant_orphan_cleanup(conn: &Connection, data_dir: &Path) -> AppResult<()> {
    let root = db::attachments_dir(data_dir).join(SPACE_IMAGE_ROOT);
    if !root.exists() {
        return Ok(());
    }
    let known: HashSet<String> = {
        let mut set = HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT id FROM spaces") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for id in rows.flatten() {
                    set.insert(id);
                }
            }
        }
        set
    };
    for entry in std::fs::read_dir(&root).map_err(io)? {
        let entry = entry.map_err(io)?;
        if !entry.path().is_dir() {
            continue;
        }
        let space_id = entry.file_name().to_string_lossy().to_string();
        if !known.contains(&space_id) {
            let still_ref: bool = conn
                .query_row(
                    "SELECT 1 FROM space_items WHERE kind = 'image' AND source_id LIKE ?1 LIMIT 1",
                    [format!("{}/{}/%", SPACE_IMAGE_ROOT, space_id)],
                    |_| Ok(true),
                )
                .optional()
                .unwrap_or(None)
                .unwrap_or(false);
            if !still_ref {
                let _ = crate::repo::orphan_hold::move_to_holding(
                    data_dir,
                    SPACE_IMAGE_ROOT,
                    &space_id,
                    &entry.path(),
                );
            }
        }
    }
    Ok(())
}

/// 공간(Space)→캔버스(Canvas) 개명(V66)의 첨부 디렉토리 1회 이관. V66 은 canvas_page_items.
/// source_id 를 이미 `canvas_pages/{id}/...` 접두로 재작성했지만, 디스크의 실제 파일은
/// 여전히 구 루트 `attachments/spaces/{id}/` 에 남아 있다 — db::bootstrap() 이 마이그레이션
/// 직후 한 번 호출해 그 디렉토리들만 `attachments/canvas_pages/{id}/` 로 옮긴다.
///
/// **절대 spaces/ 디렉토리 자체를 일괄(통째로) 옮기지 않는다** — 휴면 spaces/space_items
/// (노트북 백업/복원 기능)가 여전히 그 루트를 쓰므로, 지금 canvas_pages 테이블에 실제로
/// 존재하는 id만 DB 조회 기반으로 선별 이동한다. 각 id의 존재 여부로 게이팅한다: 이미
/// 옮겨졌으면(대상 존재) 또는 애초에 이미지가 없었으면(원본 부재) 조용히 스킵 — 멱등이라
/// 매 부팅 다시 불러도 안전하고, 도중에 중단돼도 다음 부팅에 남은 것만 마저 옮긴다. 실패는
/// best-effort(개별 id 단위 rename 은 OS 레벨에서 원자적이라 집합 전체만 부분 실패 가능) —
/// 부팅을 막지 않는다.
pub fn migrate_active_page_dirs(conn: &Connection, data_dir: &Path) {
    let old_root = db::attachments_dir(data_dir).join(SPACE_IMAGE_ROOT);
    if !old_root.exists() {
        return;
    }
    let ids: Vec<String> = {
        let Ok(mut stmt) = conn.prepare("SELECT id FROM canvas_pages") else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
            return;
        };
        rows.flatten().collect()
    };
    for id in ids {
        let src = old_root.join(&id);
        if !src.is_dir() {
            continue; // 이 페이지엔 이미지가 없었다 — 옮길 게 없다.
        }
        let Ok(dst_rel) = safe_rel(&format!("{CANVAS_PAGE_IMAGE_ROOT}/{id}")) else {
            continue;
        };
        let dst = db::attachments_dir(data_dir).join(dst_rel);
        if dst.exists() {
            continue; // 이미 이관됨(재부팅 재시도 경로) — 멱등.
        }
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&src, &dst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;

    fn setup() -> (Connection, tempfile::TempDir) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        (conn, tmp)
    }

    /// canvas_pages 행을 직접 심는다 — repo 는 지워졌고 테이블만 휴면으로 남았다.
    fn insert_dormant_page(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO canvas_pages (id, title, position, created_at, updated_at) VALUES (?1, 'C', 0, '', '')",
            [id],
        )
        .unwrap();
    }

    /// 캔버스 플러그인 제거(2026-09-28) 뒤 canvas_pages/ 는 휴면 데이터다 — 행이 있든 없든 어떤
    /// 스윕도 옮기거나 지우면 안 된다(예약 루트라 노트 첨부 고아로도 안 본다).
    #[test]
    fn attachment_sweep_leaves_dormant_canvas_pages_dir_alone() {
        let (conn, tmp) = setup();
        let att_root = db::attachments_dir(tmp.path());
        insert_dormant_page(&conn, "live-page");
        for id in ["live-page", "ghost-page-id"] {
            let dir = att_root.join(CANVAS_PAGE_IMAGE_ROOT).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("pic.png"), b"x").unwrap();
        }

        crate::repo::attachments::orphan_cleanup(&conn, tmp.path()).unwrap();

        for id in ["live-page", "ghost-page-id"] {
            assert!(
                att_root.join(CANVAS_PAGE_IMAGE_ROOT).join(id).join("pic.png").is_file(),
                "dormant canvas_pages/{id}/ must survive the attachment sweep"
            );
        }
    }

    #[test]
    fn dormant_orphan_cleanup_moves_dead_space_dir_to_holding_not_delete() {
        // dormant_orphan_cleanup 은 spaces 테이블 기준으로만 청소한다 — canvas_pages 테이블은
        // 비어 있어도 무관하다는 것 자체가 "두 세대가 분리돼 있다"는 불변식의 일부.
        let (conn, tmp) = setup();
        let att_root = db::attachments_dir(tmp.path());
        let ghost = att_root.join(SPACE_IMAGE_ROOT).join("ghost-space-id");
        std::fs::create_dir_all(&ghost).unwrap();
        std::fs::write(ghost.join("leftover.png"), b"y").unwrap();

        dormant_orphan_cleanup(&conn, tmp.path()).unwrap();
        assert!(!ghost.exists(), "dead space dir must be collected from its live location");

        let held = crate::repo::orphan_hold::hold_dir(tmp.path());
        let batch = std::fs::read_dir(&held)
            .unwrap()
            .next()
            .expect("dormant_orphan_cleanup must have created a holding batch")
            .unwrap()
            .path();
        let moved = batch.join(SPACE_IMAGE_ROOT).join("ghost-space-id").join("leftover.png");
        assert!(moved.is_file(), "dead space dir must be moved to holding, not deleted: {}", moved.display());
    }

    /// V66 첨부 이관: 활성(canvas_pages) id 의 구 spaces/{id}/ 디렉토리는 canvas_pages/{id}/ 로
    /// 옮겨지고, 휴면(spaces 테이블) id 의 spaces/{id}/ 는 절대 건드리지 않는다 — 두 세대가
    /// attachments/spaces/ 루트를 공유하던 시절의 흔적이라, 일괄 이동하면 아직 살아있는
    /// 노트북 백업/복원 기능(spaces/space_items)이 조용히 깨진다. 두 번 실행해도 멱등.
    #[test]
    fn migrate_active_page_dirs_moves_only_active_ids_and_is_idempotent() {
        let (conn, tmp) = setup();
        let att_root = db::attachments_dir(tmp.path());

        // 활성: canvas_pages 행 + 구 루트(spaces/{id}/)에 파일.
        insert_dormant_page(&conn, "page-1");
        let active_old_dir = att_root.join(SPACE_IMAGE_ROOT).join("page-1");
        std::fs::create_dir_all(&active_old_dir).unwrap();
        std::fs::write(active_old_dir.join("pic.png"), b"active").unwrap();

        // 휴면: spaces 테이블 행 + 같은 구 루트 밑에 별도 디렉토리.
        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, created_at, updated_at) VALUES ('sp-dormant', ?1, 'S', 0, '', '')",
            [&ws_id],
        )
        .unwrap();
        let dormant_old_dir = att_root.join(SPACE_IMAGE_ROOT).join("sp-dormant");
        std::fs::create_dir_all(&dormant_old_dir).unwrap();
        std::fs::write(dormant_old_dir.join("pic.png"), b"dormant").unwrap();

        migrate_active_page_dirs(&conn, tmp.path());

        // 활성 id 는 새 루트로 옮겨졌다.
        let active_new_dir = att_root.join(CANVAS_PAGE_IMAGE_ROOT).join("page-1");
        assert!(active_new_dir.join("pic.png").is_file(), "active page dir must move to canvas_pages/");
        assert!(!active_old_dir.exists(), "old spaces/{{id}}/ must be gone after move");

        // 휴면 id 는 구 루트에 그대로 남는다 — 절대 건드리지 않는다.
        assert!(dormant_old_dir.join("pic.png").is_file(), "dormant space dir must stay under spaces/");

        // 두 번째 호출은 멱등 — 아무것도 바뀌지 않는다(이미 옮겨진 활성 dir, 여전히 그대로인 휴면 dir).
        migrate_active_page_dirs(&conn, tmp.path());
        assert!(active_new_dir.join("pic.png").is_file());
        assert!(dormant_old_dir.join("pic.png").is_file());
    }

    #[test]
    fn remap_source_id_rewrites_space_prefix() {
        let mut map = HashMap::new();
        map.insert("old".into(), "new".into());
        assert_eq!(
            remap_source_id("spaces/old/a.png", &map),
            "spaces/new/a.png"
        );
        assert_eq!(
            remap_source_id("spaces/missing/a.png", &map),
            "spaces/missing/a.png"
        );
        assert_eq!(remap_source_id("note-id-not-a-path", &map), "note-id-not-a-path");
    }

}
