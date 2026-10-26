// repo: workspaces — commands/workspaces.yaml (Wave 3A)
// 전환(switch)은 settings_set { active_workspace_id } 로 수행 — folders::active_workspace_id
// 가 미존재 id 를 첫 워크스페이스로 폴백하므로 안전 (specs/commands/workspaces.yaml 참조).
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::repo::folders;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// Wave 13: 워크스페이스 배경 이미지 — 첨부(200MB)보다 훨씬 작은 한도로 충분하다.
const MAX_BG_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20MB

#[derive(Debug, Clone, Serialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub folder_count: i64,
    pub note_count: i64,
    /// Wave 13: 워크스페이스 배경 이미지 — data_dir/workspace_bg/ 기준 상대경로. NULL=미설정.
    pub bg_image_path: Option<String>,
    /// 워크스페이스 아이콘 키 — src/lib/noteIcons.ts NOTE_ICONS[].key. NULL = 기본(그리드) 아이콘.
    pub icon: Option<String>,
}

// Trash: note_count 는 워크스페이스 카드에 노출되는 숫자이므로 휴지통 노트를 세면 안 된다.
const SELECT_ONE: &str = "SELECT w.id, w.name, w.created_at,
        (SELECT COUNT(*) FROM folders f WHERE f.workspace_id = w.id),
        (SELECT COUNT(*) FROM notes n JOIN folders f ON f.id = n.folder_id
         WHERE f.workspace_id = w.id AND n.deleted_at IS NULL),
        w.bg_image_path, w.icon
     FROM workspaces w WHERE w.id = ?1";

fn row_to_workspace(r: &rusqlite::Row) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        folder_count: r.get(3)?,
        note_count: r.get(4)?,
        bg_image_path: r.get(5)?,
        icon: r.get(6)?,
    })
}

pub fn load_workspace(conn: &Connection, id: &str) -> AppResult<Workspace> {
    conn.query_row(SELECT_ONE, [id], row_to_workspace)
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("workspace not found: {id}")))
}

/// 전체 워크스페이스 + 활성 id (settings.active_workspace_id 폴백 반영).
pub fn list(conn: &Connection) -> AppResult<(Vec<Workspace>, String)> {
    let active_id = folders::active_workspace_id(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT w.id, w.name, w.created_at,
                    (SELECT COUNT(*) FROM folders f WHERE f.workspace_id = w.id),
                    (SELECT COUNT(*) FROM notes n JOIN folders f ON f.id = n.folder_id
                     WHERE f.workspace_id = w.id AND n.deleted_at IS NULL),
                    w.bg_image_path, w.icon
             FROM workspaces w ORDER BY w.created_at",
        )
        .map_err(dberr)?;
    let workspaces: Vec<Workspace> = stmt
        .query_map([], row_to_workspace)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    Ok((workspaces, active_id))
}

/// 워크스페이스 생성 + 기본 폴더 "Notes" 시드 (migrations::seed 와 동일 패턴), 단일 트랜잭션.
pub fn create(conn: &mut Connection, name: &str) -> AppResult<Workspace> {
    create_with_settings(conn, name, None)
}

/// `copy_settings_from` = 새 노트북 만들기 창의 "설정만 현재 노트북에서 복사"(PLAN-2026-09-19-
/// notebook-settings §7 Q4). None 이면 설정 행 없음 = 전부 기본값(오너 결정). 원본이 없는 id 면
/// 복사할 행이 없을 뿐 — 실패시키지 않는다(창이 열린 사이 원본이 지워진 경우).
pub fn create_with_settings(
    conn: &mut Connection,
    name: &str,
    copy_settings_from: Option<&str>,
) -> AppResult<Workspace> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("workspace name is empty".to_string()));
    }
    let now = now_iso();
    let id = new_id();
    let folder_id = new_id();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO workspaces(id, name, created_at) VALUES (?1, ?2, ?3)",
        params![id, name, now],
    )
    .map_err(dberr)?;
    tx.execute(
        "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
         VALUES (?1, ?2, ?3, 0, 1, ?4)",
        params![folder_id, id, "Notes", now],
    )
    .map_err(dberr)?;
    if let Some(from) = copy_settings_from {
        crate::repo::settings::copy_notebook_settings(&tx, from, &id)?;
    }
    tx.commit().map_err(dberr)?;
    load_workspace(conn, &id)
}

pub fn rename(conn: &mut Connection, id: &str, name: &str) -> AppResult<Workspace> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("workspace name is empty".to_string()));
    }
    let now = now_iso();
    let n = conn
        .execute(
            "UPDATE workspaces SET name=?1, updated_at=?2 WHERE id=?3",
            params![name, now, id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("workspace not found: {id}")));
    }
    load_workspace(conn, id)
}

/// 워크스페이스 아이콘(icon key) 설정/해제. 빈/공백 입력은 해제(NULL=기본 그리드 아이콘)로
/// 정규화한다. 키 유효성은 프론트 팔레트가 보장하므로 자유 문자열로 저장(repo::notes::set_icon 과 동일).
pub fn set_icon(conn: &mut Connection, id: &str, icon: Option<&str>) -> AppResult<Workspace> {
    let icon = icon.map(|s| s.trim()).filter(|s| !s.is_empty());
    let n = conn
        .execute(
            "UPDATE workspaces SET icon=?1, updated_at=?2 WHERE id=?3",
            params![icon, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("workspace not found: {id}")));
    }
    load_workspace(conn, id)
}

/// 워크스페이스 삭제 — folders/notes 는 FK CASCADE. 삭제된 노트 수 반환.
/// FTS 행/첨부 디렉토리도 정리 (folders::delete 와 동일 패턴). 마지막 워크스페이스는 삭제 불가.
/// 삭제 대상이 active 였다면 남은 첫 워크스페이스로 settings.active_workspace_id 갱신 (같은 트랜잭션).
pub fn delete(conn: &mut Connection, data_dir: &std::path::Path, id: &str) -> AppResult<i64> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM workspaces WHERE id=?1", [id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("workspace not found: {id}")));
    }
    let ws_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
        .map_err(dberr)?;
    if ws_count <= 1 {
        return Err(AppError::Validation(
            "cannot delete the last workspace".to_string(),
        ));
    }

    // 삭제될 노트 id 수집 (FTS·첨부 정리용) — folders::delete 패턴과 동일.
    let mut stmt = conn
        .prepare(
            "SELECT n.id FROM notes n JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1",
        )
        .map_err(dberr)?;
    let note_ids: Vec<String> = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let was_active = folders::active_workspace_id(conn)? == id;

    let tx = conn.transaction().map_err(dberr)?;
    for nid in &note_ids {
        crate::repo::fts::fts_delete(&tx, nid)?;
    }
    tx.execute("DELETE FROM workspaces WHERE id=?1", [id])
        .map_err(dberr)?;
    // G2: 이 워크스페이스만 직접 삭제 대상 — CASCADE 로 함께 사라지는 folders/workspace_regions/
    // workspace_eras/workspace_statuses 및 그 아래 notes/sections/... 전부 이 tombstone 하나로
    // 암시된다(repo/tombstone.rs 캐스케이드 규칙).
    crate::repo::tombstone::record_tombstone(&tx, "workspaces", id)?;
    if was_active {
        let remaining: String = tx
            .query_row(
                "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(dberr)?;
        let json = serde_json::to_string(&remaining).unwrap_or_else(|_| "null".to_string());
        tx.execute(
            "INSERT INTO settings(key, value) VALUES ('active_workspace_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )
        .map_err(dberr)?;
    }
    tx.commit().map_err(dberr)?;

    for nid in &note_ids {
        let dir = crate::db::attachments_dir(data_dir).join(nid);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    // Wave 13: 배경 이미지 디렉토리도 정리 — attachments/ 와 분리된 루트라 별도로 지운다.
    let bg_dir = crate::db::workspace_bg_dir(data_dir).join(id);
    if bg_dir.exists() {
        let _ = std::fs::remove_dir_all(&bg_dir);
    }
    Ok(note_ids.len() as i64)
}

/// 워크스페이스 배경 이미지 설정 — attachments::add_file 과 동일한 스트리밍 복사 패턴(R7:
/// 임시명 → rename 원자적 복사). data_dir/workspace_bg/{id}/ 에 저장하고 그 디렉토리 기준
/// 상대경로를 DB에 저장한다. 기존 배경 이미지가 있었다면 교체 후 이전 파일을 정리(고아 방지).
pub fn set_bg_image(
    conn: &mut Connection,
    data_dir: &Path,
    id: &str,
    file_path: &str,
) -> AppResult<Workspace> {
    let existing = load_workspace(conn, id)?; // NotFound 검증 겸 이전 경로 확보

    let src = Path::new(file_path);
    let meta = std::fs::metadata(src).map_err(io)?;
    if meta.len() > MAX_BG_IMAGE_BYTES {
        return Err(AppError::Validation(
            "background image exceeds 20MB limit".to_string(),
        ));
    }
    let orig_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("background")
        .to_string();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    if crate::repo::attachments::kind_from_ext(&ext) != "image" {
        return Err(AppError::Validation(format!(
            "unsupported background image type: {ext}"
        )));
    }

    let ws_dir = crate::db::workspace_bg_dir(data_dir).join(id);
    std::fs::create_dir_all(&ws_dir).map_err(io)?;
    let short = &new_id()[..8];
    let stored_name = format!("{short}-{orig_name}");
    let dest = ws_dir.join(&stored_name);

    // 원자적 복사: 임시명 → rename (R7), attachments::add_file 과 동일 패턴.
    let tmp = ws_dir.join(format!(".tmp-{short}-{orig_name}"));
    std::fs::copy(src, &tmp).map_err(io)?;
    std::fs::rename(&tmp, &dest).map_err(io)?;

    let rel_path = format!("{id}/{stored_name}");
    conn.execute(
        "UPDATE workspaces SET bg_image_path=?1, updated_at=?2 WHERE id=?3",
        params![rel_path, now_iso(), id],
    )
    .map_err(dberr)?;

    // DB 갱신 성공 후에만 이전 파일 삭제 — rel_path 는 DB 유래이므로 attachments::open 과
    // 동일하게 safe_rel 로 workspace_bg/ 밖을 가리키지 않는지 검증 후 삭제.
    if let Some(old_rel) = existing.bg_image_path {
        if let Ok(clean) = super::paths::safe_rel(&old_rel) {
            let old_path = crate::db::workspace_bg_dir(data_dir).join(clean);
            if old_path != dest {
                let _ = std::fs::remove_file(old_path);
            }
        }
    }

    load_workspace(conn, id)
}

/// 워크스페이스 배경 이미지 해제 — 파일 삭제 + 컬럼 NULL.
pub fn clear_bg_image(conn: &mut Connection, data_dir: &Path, id: &str) -> AppResult<Workspace> {
    let existing = load_workspace(conn, id)?;
    conn.execute(
        "UPDATE workspaces SET bg_image_path=NULL, updated_at=?1 WHERE id=?2",
        params![now_iso(), id],
    )
    .map_err(dberr)?;
    if let Some(old_rel) = existing.bg_image_path {
        if let Ok(clean) = super::paths::safe_rel(&old_rel) {
            let old_path = crate::db::workspace_bg_dir(data_dir).join(clean);
            let _ = std::fs::remove_file(old_path);
        }
    }
    load_workspace(conn, id)
}
