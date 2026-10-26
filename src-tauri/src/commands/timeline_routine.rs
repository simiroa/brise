// Commands: timeline_routine (specs/commands/timeline_routines.yaml) — 시간축 배경 루틴.
// Thin Tauri IPC wrappers over repo::timeline_routine. **`commands::routine`(캔버스 위젯의
// 노트-연결 습관 체크트래커)와는 다른 커맨드 패밀리다 — 혼동 금지.**
use super::AppState;
use crate::error::AppError;
use crate::models::TimelineRoutine;
use crate::repo::{folders, timeline_routine};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct TimelineRoutineListResult {
    pub routines: Vec<TimelineRoutine>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn timeline_routine_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<TimelineRoutineListResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    Ok(TimelineRoutineListResult {
        routines: timeline_routine::list(&conn, &ws)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn timeline_routine_create(
    state: State<AppState>,
    workspace_id: Option<String>,
    title: String,
    weekday_mask: i64,
    start_time: String,
    end_time: String,
    color_hue: Option<i64>,
    skip_holidays: Option<bool>,
) -> Result<TimelineRoutine, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    timeline_routine::create(
        &conn,
        &ws,
        &title,
        weekday_mask,
        &start_time,
        &end_time,
        color_hue,
        skip_holidays.unwrap_or(false),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn timeline_routine_update(
    state: State<AppState>,
    id: String,
    title: Option<String>,
    weekday_mask: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    color_hue: Option<i64>,
    skip_holidays: Option<bool>,
) -> Result<TimelineRoutine, AppError> {
    let conn = state.db.lock();
    // color_hue는 이 커맨드의 유일한 호출부(TimelineRoutineSection 편집 폼)가 저장마다 항상
    // 채워 보내므로(색 없음=null도 명시적으로 온다) collect_source_update의 target_folder_id와
    // 같은 "항상 Some" 자세다 — repo 층의 Some(None)="지움"/None="안 건드림" 구분 중 후자는
    // 이 경로에서 아직 안 쓰이지만, 다른 호출자가 생기면 그대로 쓸 수 있게 repo API는 남겨둔다.
    // skip_holidays는 그대로 통과시킨다 — None(생략)="안 건드림"이 repo::update의 기존 단순
    // 필드(title 등)와 같은 뜻이라 여기서 unwrap_or 로 값을 지어내면 안 된다(create 쪽과 다름).
    timeline_routine::update(
        &conn,
        &id,
        title.as_deref(),
        weekday_mask,
        start_time.as_deref(),
        end_time.as_deref(),
        Some(color_hue),
        skip_holidays,
    )
}

#[derive(Serialize)]
pub struct TimelineRoutineDeleteResult {
    pub ok: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn timeline_routine_delete(
    state: State<AppState>,
    id: String,
) -> Result<TimelineRoutineDeleteResult, AppError> {
    let conn = state.db.lock();
    let ok = timeline_routine::delete(&conn, &id)?;
    Ok(TimelineRoutineDeleteResult { ok })
}
