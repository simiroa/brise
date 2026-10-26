// 커맨드: note_snapshots — 에디터 자동저장 캐시 (commands/snapshots.yaml, http:false 전부).
use super::AppState;
use crate::error::AppError;
use crate::repo::snapshots::{self, RestoreResult, SnapshotDetail, SnapshotListItem, SnapshotMeta};
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn note_snapshot_capture(state: State<AppState>, note_id: String) -> Result<SnapshotMeta, AppError> {
    let mut conn = state.db.lock();
    snapshots::capture(&mut conn, &note_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_snapshot_list(state: State<AppState>, note_id: String) -> Result<Vec<SnapshotListItem>, AppError> {
    let conn = state.db.lock();
    snapshots::list(&conn, &note_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_snapshot_get(state: State<AppState>, id: String) -> Result<SnapshotDetail, AppError> {
    let conn = state.db.lock();
    snapshots::get(&conn, &id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_snapshot_restore(state: State<AppState>, id: String) -> Result<RestoreResult, AppError> {
    let mut conn = state.db.lock();
    let result = snapshots::restore(&mut conn, &id)?;
    crate::events::publish(Some(&result.note_id), false);
    Ok(result)
}
