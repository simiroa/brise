// 커맨드: workspaces (commands/workspaces.yaml)
use super::AppState;
use crate::error::AppError;
use crate::repo::workspaces::{self, Workspace};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
pub struct WorkspaceList {
    pub workspaces: Vec<Workspace>,
    pub active_id: String,
}

#[derive(Serialize)]
pub struct WorkspaceDeleteResult {
    pub deleted_note_count: i64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_list(state: State<AppState>) -> Result<WorkspaceList, AppError> {
    let conn = state.db.lock();
    let (workspaces, active_id) = workspaces::list(&conn)?;
    Ok(WorkspaceList {
        workspaces,
        active_id,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_create(
    state: State<AppState>,
    name: String,
    copy_settings_from: Option<String>,
) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    let ws = workspaces::create_with_settings(&mut conn, &name, copy_settings_from.as_deref())?;
    crate::events::publish(None, false); // 워크스페이스 단위 변경 — 노트 하나로 좁힐 수 없다.
    Ok(ws)
}

/// 노트북 복제 — 노트·설정까지 통째로(repo::transfer::import::duplicate_notebook). 활성 노트북은 바꾸지 않는다.
#[tauri::command(rename_all = "snake_case")]
pub fn workspace_duplicate(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    let new_id = crate::repo::transfer::import::duplicate_notebook(&mut conn, &state.data_dir, &id, &name)?;
    crate::events::publish(None, false);
    workspaces::load_workspace(&conn, &new_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_rename(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    let ws = workspaces::rename(&mut conn, &id, &name)?;
    crate::events::publish(None, false);
    Ok(ws)
}

/// async + spawn_blocking 인 이유(L-1): 삭제 직전 전체 zip 백업(DB + 모든 첨부)이 메인 스레드에서 돌아 창이 멈췄다.
#[tauri::command(rename_all = "snake_case")]
pub async fn workspace_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkspaceDeleteResult, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    let deleted_note_count =
        tauri::async_runtime::spawn_blocking(move || delete_with_backup(&db, &data_dir, &id))
            .await
            .map_err(|e| AppError::Io(format!("workspace delete worker failed: {e}")))??;
    crate::events::publish(None, false);
    Ok(WorkspaceDeleteResult { deleted_note_count })
}

/// 삭제 직전 전체 zip 백업을 강제하고(db 락 밖, 별도 커넥션), 실패하면 삭제하지 않는다.
fn delete_with_backup(
    db: &Mutex<Connection>,
    data_dir: &Path,
    id: &str,
) -> Result<i64, AppError> {
    crate::repo::transfer::backup::pre_delete_backup(data_dir)?;
    let mut conn = db.lock();
    workspaces::delete(&mut conn, data_dir, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_aborts_when_backup_fails() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let ws = workspaces::create_with_settings(&mut conn, "victim", None).unwrap();
        // backups/ 자리에 파일을 놓아 백업을 확실히 실패시킨다.
        std::fs::remove_dir_all(crate::db::backups_dir(data_dir.path())).unwrap();
        std::fs::write(crate::db::backups_dir(data_dir.path()), b"not a dir").unwrap();

        let db = Mutex::new(conn);
        assert!(delete_with_backup(&db, data_dir.path(), &ws.id).is_err());
        assert!(workspaces::load_workspace(&db.lock(), &ws.id).is_ok(), "백업 실패 시 삭제되면 안 된다");

        // 정상 경로: 백업 생성 후 삭제.
        std::fs::remove_file(crate::db::backups_dir(data_dir.path())).unwrap();
        std::fs::create_dir_all(crate::db::backups_dir(data_dir.path())).unwrap();
        delete_with_backup(&db, data_dir.path(), &ws.id).unwrap();
        assert!(workspaces::load_workspace(&db.lock(), &ws.id).is_err());
        let has_zip = std::fs::read_dir(crate::db::backups_dir(data_dir.path()))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("pre-delete-"));
        assert!(has_zip);
    }
}

/// 아래 3개(set_bg_image/clear_bg_image/set_icon)는 일부러 crate::events::publish 를 부르지
/// 않는다 — 데스크톱 배경/아이콘 치장이라 다른 기기가 보는 데이터가 바뀌지 않는다
/// (notes.rs::folder_set_open 과 같은 부류).
#[tauri::command(rename_all = "snake_case")]
pub fn workspace_set_bg_image(
    state: State<AppState>,
    id: String,
    file_path: String,
) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    workspaces::set_bg_image(&mut conn, &state.data_dir, &id, &file_path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_clear_bg_image(state: State<AppState>, id: String) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    workspaces::clear_bg_image(&mut conn, &state.data_dir, &id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_set_icon(
    state: State<AppState>,
    id: String,
    icon: Option<String>,
) -> Result<Workspace, AppError> {
    let mut conn = state.db.lock();
    workspaces::set_icon(&mut conn, &id, icon.as_deref())
}

#[derive(Serialize)]
pub struct WorkspaceBgBaseDir {
    pub base: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_bg_base_dir(state: State<AppState>) -> Result<WorkspaceBgBaseDir, AppError> {
    let dir = crate::db::workspace_bg_dir(&state.data_dir);
    Ok(WorkspaceBgBaseDir {
        base: dir.to_string_lossy().to_string(),
    })
}
