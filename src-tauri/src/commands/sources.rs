// 커맨드: sources (commands/sources.yaml)
use super::{AppState, Deleted};
use crate::error::AppError;
use crate::models::Source;
use crate::repo::sources;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn source_add_text(
    state: State<AppState>,
    note_id: String,
    name: String,
    body: String,
) -> Result<Source, AppError> {
    let mut conn = state.db.lock();
    let source = sources::add_text(&mut conn, &note_id, &name, &body)?;
    crate::events::publish(Some(&note_id), false);
    Ok(source)
}

#[tauri::command(rename_all = "snake_case")]
pub fn source_add_file(
    state: State<AppState>,
    note_id: String,
    file_path: String,
    original_policy: Option<String>,
) -> Result<Source, AppError> {
    let mut conn = state.db.lock();
    let default_policy = crate::repo::settings::get_all(&conn)
        .ok()
        .and_then(|map| map.get("source_original_policy").and_then(|v| v.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| "ask".to_string());
    
    let policy = original_policy.unwrap_or(default_policy);
    let source = sources::add_file(&mut conn, &state.data_dir, &note_id, &file_path, Some(&policy))?;
    crate::events::publish(Some(&note_id), false);
    Ok(source)
}

#[tauri::command(rename_all = "snake_case")]
pub fn source_rename(state: State<AppState>, id: String, name: String) -> Result<Source, AppError> {
    let mut conn = state.db.lock();
    let source = sources::rename(&mut conn, &id, &name)?;
    crate::events::publish(None, false); // source id 만 알고 note_id 는 모른다 — coarse.
    Ok(source)
}

#[tauri::command(rename_all = "snake_case")]
pub fn source_delete(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let mut conn = state.db.lock();
    let deleted = sources::delete(&mut conn, &id)?;
    crate::events::publish(None, false); // 위와 동일 — coarse.
    Ok(Deleted { deleted })
}
