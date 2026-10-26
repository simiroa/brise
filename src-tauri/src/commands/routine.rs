// Commands: routine (docs/PLAN-2026-08-16-space-widgets.md §4, §4.3)
// Thin Tauri IPC wrappers over repo::routine.
use super::AppState;
use crate::error::AppError;
use crate::models::{RoutineHistoryResult, RoutineTodayResult, RoutineToggleResult};
use crate::repo::routine;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn routine_toggle(
    state: State<AppState>,
    note_id: String,
    occur_on: String,
    done: bool,
) -> Result<RoutineToggleResult, AppError> {
    let conn = state.db.lock();
    let res = routine::toggle(&conn, &note_id, &occur_on, done)?;
    crate::events::publish(Some(&note_id), false);
    Ok(res)
}

#[tauri::command(rename_all = "snake_case")]
pub fn routine_today(
    state: State<AppState>,
    workspace_id: String,
) -> Result<RoutineTodayResult, AppError> {
    let conn = state.db.lock();
    routine::today(&conn, &workspace_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn routine_history(
    state: State<AppState>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<RoutineHistoryResult, AppError> {
    let conn = state.db.lock();
    routine::history(&conn, &workspace_id, &from, &to)
}
