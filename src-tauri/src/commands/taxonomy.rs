// 커맨드: taxonomy — 워크스페이스별 사용자 확장 지역/시대 (commands/workspaces.yaml 확장, Wave 14)
use super::AppState;
use crate::error::AppError;
use crate::repo::taxonomy::{self, EraEntry, RegionEntry, StatusEntry};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct RegionList {
    pub regions: Vec<RegionEntry>,
}

#[derive(Serialize)]
pub struct EraList {
    pub eras: Vec<EraEntry>,
}

#[derive(Serialize)]
pub struct StatusList {
    pub statuses: Vec<StatusEntry>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_region_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<RegionList, AppError> {
    let conn = state.db.lock();
    let regions = taxonomy::list_regions(&conn, workspace_id)?;
    Ok(RegionList { regions })
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_region_add(
    state: State<AppState>,
    workspace_id: Option<String>,
    name: String,
) -> Result<RegionEntry, AppError> {
    let mut conn = state.db.lock();
    let entry = taxonomy::add_region(&mut conn, workspace_id, &name)?;
    crate::events::publish(None, false); // 워크스페이스 분류 변경 — coarse.
    Ok(entry)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_region_remove(state: State<AppState>, id: String) -> Result<super::Deleted, AppError> {
    let mut conn = state.db.lock();
    taxonomy::remove_region(&mut conn, &id)?;
    crate::events::publish(None, false);
    Ok(super::Deleted { deleted: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_era_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<EraList, AppError> {
    let conn = state.db.lock();
    let eras = taxonomy::list_eras(&conn, workspace_id)?;
    Ok(EraList { eras })
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_era_add(
    state: State<AppState>,
    workspace_id: Option<String>,
    name: String,
    from_year: i64,
    to_year: i64,
) -> Result<EraEntry, AppError> {
    let mut conn = state.db.lock();
    let entry = taxonomy::add_era(&mut conn, workspace_id, &name, from_year, to_year)?;
    crate::events::publish(None, false);
    Ok(entry)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_era_remove(state: State<AppState>, id: String) -> Result<super::Deleted, AppError> {
    let mut conn = state.db.lock();
    taxonomy::remove_era(&mut conn, &id)?;
    crate::events::publish(None, false);
    Ok(super::Deleted { deleted: true })
}

// Wave 15: 워크스페이스별 사용자 확장 노트 상태 — region/era 와 동일한 모양(commands/workspaces.yaml).
#[tauri::command(rename_all = "snake_case")]
pub fn workspace_status_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<StatusList, AppError> {
    let conn = state.db.lock();
    let statuses = taxonomy::list_statuses(&conn, workspace_id)?;
    Ok(StatusList { statuses })
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_status_add(
    state: State<AppState>,
    workspace_id: Option<String>,
    name: String,
) -> Result<StatusEntry, AppError> {
    let mut conn = state.db.lock();
    let entry = taxonomy::add_status(&mut conn, workspace_id, &name)?;
    crate::events::publish(None, false);
    Ok(entry)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_status_rename(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<StatusEntry, AppError> {
    let mut conn = state.db.lock();
    let entry = taxonomy::rename_status(&mut conn, &id, &name)?;
    crate::events::publish(None, false);
    Ok(entry)
}

#[tauri::command(rename_all = "snake_case")]
pub fn workspace_status_remove(state: State<AppState>, id: String) -> Result<super::Deleted, AppError> {
    let mut conn = state.db.lock();
    taxonomy::remove_status(&mut conn, &id)?;
    crate::events::publish(None, false);
    Ok(super::Deleted { deleted: true })
}
