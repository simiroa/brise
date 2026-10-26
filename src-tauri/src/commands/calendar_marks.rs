// Commands: calendar_marks (specs/commands/calendar_marks.yaml) — 달력 표시일(공휴일·기념일).
// repo::calendar_marks 위의 얇은 IPC 래퍼. 쓰기마다 "calendar-marks-changed" 를 내서 다른 창(설정 창
// ↔ 본 창)의 표시일 스토어가 다시 읽게 한다 — settings-changed 와 같은 관용구.
use super::AppState;
use crate::error::AppError;
use crate::models::{CalendarMark, CalendarMarkHide, CalendarSource};
use crate::repo::calendar_marks::{self as repo, ImportedMark, MarkFields};
use crate::repo::folders;
use serde::{Deserialize, Serialize};
use tauri::State;

fn ws_or_active(conn: &rusqlite::Connection, workspace_id: Option<String>) -> Result<String, AppError> {
    match workspace_id {
        Some(w) => Ok(w),
        None => folders::active_workspace_id(conn),
    }
}

fn changed() {
    crate::events::emit_desktop("calendar-marks-changed");
}

#[derive(Serialize)]
pub struct CalendarMarksListResult {
    pub sources: Vec<CalendarSource>,
    pub marks: Vec<CalendarMark>,
    pub hides: Vec<CalendarMarkHide>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_marks_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<CalendarMarksListResult, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    let d = repo::list(&conn, &ws)?;
    Ok(CalendarMarksListResult { sources: d.sources, marks: d.marks, hides: d.hides })
}

#[allow(clippy::too_many_arguments)]
fn fields(
    title: String,
    year: Option<i64>,
    month: i64,
    day: i64,
    repeat: String,
    lunar: Option<bool>,
    day_off: Option<bool>,
    color_hue: Option<i64>,
) -> MarkFields {
    MarkFields {
        title,
        year,
        month,
        day,
        repeat,
        lunar: lunar.unwrap_or(false),
        day_off: day_off.unwrap_or(false),
        color_hue,
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn calendar_mark_create(
    state: State<AppState>,
    workspace_id: Option<String>,
    title: String,
    year: Option<i64>,
    month: i64,
    day: i64,
    repeat: String,
    lunar: Option<bool>,
    day_off: Option<bool>,
    color_hue: Option<i64>,
) -> Result<CalendarMark, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    let m = repo::create(&conn, &ws, &fields(title, year, month, day, repeat, lunar, day_off, color_hue))?;
    changed();
    Ok(m)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn calendar_mark_update(
    state: State<AppState>,
    id: String,
    title: String,
    year: Option<i64>,
    month: i64,
    day: i64,
    repeat: String,
    lunar: Option<bool>,
    day_off: Option<bool>,
    color_hue: Option<i64>,
) -> Result<CalendarMark, AppError> {
    let conn = state.db.lock();
    let m = repo::update(&conn, &id, &fields(title, year, month, day, repeat, lunar, day_off, color_hue))?;
    changed();
    Ok(m)
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_mark_delete(state: State<AppState>, id: String) -> Result<super::Okay, AppError> {
    let conn = state.db.lock();
    repo::delete(&conn, &id)?;
    changed();
    Ok(super::Okay { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_mark_set_hidden(
    state: State<AppState>,
    workspace_id: Option<String>,
    source: String,
    iso_day: String,
    hidden: bool,
) -> Result<super::Okay, AppError> {
    let conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    repo::set_hidden(&conn, &ws, &source, &iso_day, hidden)?;
    changed();
    Ok(super::Okay { ok: true })
}

/// 프런트 ics 파서(lib/ical.ts)가 만든 한 줄.
#[derive(Deserialize)]
pub struct ImportedMarkInput {
    pub uid: Option<String>,
    pub title: String,
    pub year: Option<i64>,
    pub month: i64,
    pub day: i64,
    pub repeat: String,
    pub day_off: Option<bool>,
}

#[derive(Serialize)]
pub struct CalendarSourceSaveResult {
    pub source: CalendarSource,
    pub skipped: usize,
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_source_save(
    state: State<AppState>,
    workspace_id: Option<String>,
    source_id: Option<String>,
    name: String,
    url: Option<String>,
    marks: Vec<ImportedMarkInput>,
) -> Result<CalendarSourceSaveResult, AppError> {
    let mut conn = state.db.lock();
    let ws = ws_or_active(&conn, workspace_id)?;
    let rows: Vec<ImportedMark> = marks
        .into_iter()
        .map(|m| ImportedMark {
            uid: m.uid,
            fields: MarkFields {
                title: m.title,
                year: m.year,
                month: m.month,
                day: m.day,
                repeat: m.repeat,
                lunar: false,
                day_off: m.day_off.unwrap_or(false),
                color_hue: None,
            },
        })
        .collect();
    let (source, skipped) =
        repo::save_source(&mut conn, &ws, source_id.as_deref(), &name, url.as_deref(), &rows)?;
    changed();
    Ok(CalendarSourceSaveResult { source, skipped })
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_source_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
) -> Result<CalendarSource, AppError> {
    // 색은 v1 에서 바꾸지 않는다 — Tauri 인자로는 "그대로"와 "지움"(이중 Option)을 가를 수 없다
    // (commands/collect.rs::collect_source_update 주석). 필요해지면 항상-전부-보내기 자세로 붙인다.
    let conn = state.db.lock();
    let s = repo::update_source(&conn, &id, name.as_deref(), enabled, None)?;
    changed();
    Ok(s)
}

#[tauri::command(rename_all = "snake_case")]
pub fn calendar_source_delete(state: State<AppState>, id: String) -> Result<super::Okay, AppError> {
    let mut conn = state.db.lock();
    repo::delete_source(&mut conn, &id)?;
    changed();
    Ok(super::Okay { ok: true })
}

/// `.ics` 구독 주소 하나를 텍스트로 받는다 — 웹뷰 CSP 는 외부 fetch 를 막으므로 Rust 가 한다. 파싱은
/// 하지 않는다(파서는 lib/ical.ts 하나). 사설 주소·리디렉트 가드는 RSS 수집과 같은 함수.
/// 자동 갱신은 없다(오너 결정 D5) — 이 커맨드는 사용자가 누를 때만 불린다.
#[derive(Serialize)]
pub struct CalendarFetchResult {
    pub text: String,
}

/// 공휴일 캘린더는 수십 KB 다 — 개인 일정 캘린더 통째(수 MB)는 받지 않는다.
const ICS_MAX_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command(rename_all = "snake_case")]
pub async fn calendar_fetch_ics(url: String) -> Result<CalendarFetchResult, AppError> {
    // webcal:// 은 구글·애플이 흔히 주는 모양 — 같은 주소의 https 다.
    let url = url.trim();
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    };
    let text = crate::collect::rss::fetch_public_text(&url, "text/calendar, text/plain", ICS_MAX_BYTES).await?;
    if !text.contains("BEGIN:VCALENDAR") {
        return Err(AppError::Validation("not an iCalendar (.ics) file".into()));
    }
    Ok(CalendarFetchResult { text })
}
