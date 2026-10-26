// Commands: dashboard (docs/DASHBOARD.md §4) — thin wrappers over repo::dashboard.
// Wave 3 에는 네이티브 IPC 전용이었으나 2026-08-02 에 http 를 열었다 — 동기화 웹 클라이언트를
// 데스크톱 폭으로 열면 대시보드가 통째로 비어 보이던 원인이 그 http:false 였다.
use super::AppState;
use crate::error::AppError;
use crate::repo::dashboard::dateord::NaiveYmd;
use crate::repo::dashboard::{
    self, BoardResult, CalendarResult, CoverImageResult, GraphResult, TimelineResult, TodoToggleResult,
};
use crate::repo::schedule;
use tauri::State;

/// SCALABILITY.md §3 규칙: 수백 ms 를 쓰는 커맨드는 `async fn` + `spawn_blocking` 이어야 한다.
/// Tauri 는 **동기** 커맨드를 직렬로 돌리므로, DB 를 전혀 안 쓰는 커맨드조차 대시보드 쿼리 뒤에
/// 줄 선다(실측: attachments_base_dir 2ms → 1,837ms). 기준 구현은
/// `commands/attachments.rs::attachment_thumbs`. 여기 셋(board/calendar/timeline)은 대시보드
/// 탭 전환마다 도는 무거운 읽기라 같은 형태를 따른다.
///
/// `State` 는 빌림이라 워커로 못 옮긴다 — DB 핸들만 `Arc::clone` 해서 넘긴다(AppState::db 주석).
fn spawn_db<T, F>(state: &State<'_, AppState>, work: F) -> tauri::async_runtime::JoinHandle<Result<T, AppError>>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
{
    let db = std::sync::Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || work(&db.lock()))
}

fn worker_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io(format!("dashboard worker failed: {e}"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dashboard_board(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<BoardResult, AppError> {
    spawn_db(&state, move |conn| dashboard::board(conn, &workspace_id))
        .await
        .map_err(worker_err)?
}

#[tauri::command(rename_all = "snake_case")]
pub fn todo_toggle(
    state: State<AppState>,
    note_id: String,
    section_id: String,
    line_index: i64,
    expected_checked: bool,
) -> Result<TodoToggleResult, AppError> {
    let mut conn = state.db.lock();
    let result =
        dashboard::todo_toggle(&mut conn, &note_id, &section_id, line_index, expected_checked)?;
    // Same event bus as section_update — open editors reload via remoteNoteWrite.
    crate::events::publish(Some(&result.note_id), false);
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dashboard_calendar(
    state: State<'_, AppState>,
    workspace_id: String,
    year: i64,
    month: i64,
) -> Result<CalendarResult, AppError> {
    spawn_db(&state, move |conn| {
        dashboard::calendar(conn, &workspace_id, year, month)
    })
    .await
    .map_err(worker_err)?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dashboard_timeline(
    state: State<'_, AppState>,
    workspace_id: String,
    from_year: i64,
    to_year: i64,
) -> Result<TimelineResult, AppError> {
    spawn_db(&state, move |conn| {
        dashboard::timeline(conn, &workspace_id, from_year, to_year)
    })
    .await
    .map_err(worker_err)?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dashboard_graph(
    state: State<'_, AppState>,
    workspace_id: String,
    limit: Option<i64>,
) -> Result<GraphResult, AppError> {
    spawn_db(&state, move |conn| dashboard::graph(conn, &workspace_id, limit))
        .await
        .map_err(worker_err)?
}

/// docs/PLAN-schedule-system.md §7.4 — 대시보드 헤더 벨. 판정은 repo::schedule 이 소유하고 여기는
/// "오늘"(서버 로컬 날짜)만 만들어 넘긴다.
#[tauri::command(rename_all = "snake_case")]
pub fn schedule_today(
    state: State<AppState>,
    workspace_id: String,
) -> Result<ScheduleTodayResult, AppError> {
    let conn = state.db.lock();
    let (y, m, d) = crate::util::today_ymd_local();
    let items = schedule::due_today(
        &conn,
        &workspace_id,
        NaiveYmd { y, m: m as u32, d: d as u32 },
    )?;
    Ok(ScheduleTodayResult { items })
}

#[derive(serde::Serialize)]
pub struct ScheduleTodayResult {
    pub items: Vec<schedule::DueReminder>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_cover_image(
    state: State<AppState>,
    note_id: String,
) -> Result<CoverImageResult, AppError> {
    let conn = state.db.lock();
    dashboard::note_cover_image(&conn, &state.data_dir, &note_id)
}

#[derive(serde::Serialize)]
pub struct NoteCoverImagesResult {
    pub items: Vec<CoverImageResult>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_cover_images(
    state: State<AppState>,
    note_ids: Vec<String>,
) -> Result<NoteCoverImagesResult, AppError> {
    let conn = state.db.lock();
    let items = dashboard::note_cover_images(&conn, &state.data_dir, &note_ids)?;
    Ok(NoteCoverImagesResult { items })
}
