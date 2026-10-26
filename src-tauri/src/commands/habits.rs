// Commands: habit_* (specs/commands/habits.yaml) — 브리핑 습관. Thin Tauri IPC wrappers over repo::habits.
use super::AppState;
use crate::error::AppError;
use crate::models::{Habit, HabitHistory, HabitWeek};
use crate::repo::{folders, habits};
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

fn ws_or_active(conn: &Connection, workspace_id: Option<String>) -> Result<String, AppError> {
    match workspace_id {
        Some(w) => Ok(w),
        None => folders::active_workspace_id(conn),
    }
}

#[derive(Serialize)]
pub struct HabitListResult {
    pub habits: Vec<Habit>,
}

#[derive(Serialize)]
pub struct HabitOkResult {
    pub ok: bool,
}

#[derive(Serialize)]
pub struct HabitCheckResult {
    pub habit_id: String,
    pub day: String,
    pub done: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_list(state: State<AppState>, workspace_id: Option<String>) -> Result<HabitListResult, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    Ok(HabitListResult { habits: habits::list(&conn, &ws)? })
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_create(
    state: State<AppState>,
    workspace_id: Option<String>,
    title: String,
    icon: Option<String>,
    hue: Option<i64>,
    weekday_mask: Option<i64>,
    time_of_day: Option<String>,
) -> Result<Habit, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    habits::create(&conn, &ws, &title, icon.as_deref(), hue, weekday_mask.unwrap_or(127), time_of_day.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_update(
    state: State<AppState>,
    id: String,
    title: Option<String>,
    icon: Option<String>,
    hue: Option<i64>,
    weekday_mask: Option<i64>,
    archived: Option<bool>,
    time_of_day: Option<String>,
) -> Result<Habit, AppError> {
    let conn = state.db.lock();
    // icon/hue 는 항상 통째 교체(null=지움) — timeline_routine_update 의 color_hue 와 같은 자세.
    habits::update(&conn, &id, title.as_deref(), icon.as_deref(), hue, weekday_mask, archived, time_of_day.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_delete(state: State<AppState>, id: String) -> Result<HabitOkResult, AppError> {
    let conn = state.db.lock();
    Ok(HabitOkResult { ok: habits::delete(&conn, &id)? })
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_reorder(
    state: State<AppState>,
    workspace_id: Option<String>,
    ids: Vec<String>,
) -> Result<HabitOkResult, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    habits::reorder(&conn, &ws, &ids)?;
    Ok(HabitOkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_check(
    state: State<AppState>,
    habit_id: String,
    day: String,
    done: bool,
) -> Result<HabitCheckResult, AppError> {
    let conn = state.db.lock();
    let done = habits::check(&conn, &habit_id, &day, done)?;
    Ok(HabitCheckResult { habit_id, day, done })
}

#[tauri::command(rename_all = "snake_case")]
pub fn habit_week(
    state: State<AppState>,
    workspace_id: Option<String>,
    day: String,
    week_start: Option<String>,
) -> Result<HabitWeek, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    habits::week(&conn, &ws, &day, week_start.as_deref())
}

/// 브리핑 "오늘의 습관" 12주 히트맵 — repo::habits::history(날별 scheduled/done, 생성일 이전 제외).
// sync-ok: 범위 ≤400일 × 습관 수(수십) — habit_week 과 같은 무게의 PK·인덱스 조회.
#[tauri::command(rename_all = "snake_case")]
pub fn habit_history(
    state: State<AppState>,
    workspace_id: Option<String>,
    from: String,
    to: String,
) -> Result<HabitHistory, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    habits::history(&conn, &ws, &from, &to)
}
