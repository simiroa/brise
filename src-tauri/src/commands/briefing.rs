// Commands: briefing_* (specs/commands/briefing.yaml) — 브리핑 창 전용 조회·쓰기. Thin wrapper over repo::briefing.
use super::AppState;
use crate::error::AppError;
use crate::models::RecentCollected;
use crate::repo::briefing::{self, BlockCreated, NoteQuote, RecentWorkNote};
use crate::repo::folders;
use serde::Serialize;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn briefing_recent_collected(
    state: State<AppState>,
    workspace_id: Option<String>,
    since: Option<String>,
    limit: Option<i64>,
) -> Result<RecentCollected, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    briefing::recent_collected(&conn, &ws, since.as_deref(), limit.unwrap_or(4), chrono::Utc::now())
}

#[derive(Serialize)]
pub struct BriefingRecentNotesOutput {
    pub items: Vec<RecentWorkNote>,
}

/// 브리핑 "최근 작업 노트" — 활동 기록(create/edit) 기준 노트별 마지막 작업 시각(repo::briefing::recent_notes).
// sync-ok: activity_log 는 노트북당 7일·2000행 상한 — GROUP BY 한 번 + notes/folders PK 조인, LIMIT ≤20.
#[tauri::command(rename_all = "snake_case")]
pub fn briefing_recent_notes(
    state: State<AppState>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<BriefingRecentNotesOutput, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let items = briefing::recent_notes(&conn, &ws, limit.unwrap_or(5))?;
    Ok(BriefingRecentNotesOutput { items })
}

/// 시간축에서 끌어 만든 일정 하나 = 받은편지함 노트 하나(PLAN-2026-10-19-briefing-rewrite §4.1). 검증·받은편지함·
/// 노트+시각 한 트랜잭션은 repo::briefing::block_create 가 소유한다. 발행은 note_create 와 같이 created=true —
/// 본 창 트리·달력이 remote-note-write 로 새 노트를 안다.
// sync-ok: 노트 한 개 생성 — note_create(동기)와 같은 무게(설정 읽기 1 + 노트·섹션·FTS·날짜 행 한 트랜잭션).
#[tauri::command(rename_all = "snake_case")]
pub fn briefing_block_create(
    state: State<AppState>,
    workspace_id: Option<String>,
    day: String,
    start_time: String,
    end_time: String,
    title: String,
) -> Result<BlockCreated, AppError> {
    let mut conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let created = briefing::block_create(&mut conn, &ws, &day, &start_time, &end_time, &title)?;
    drop(conn);
    crate::events::publish(Some(&created.note_id), true);
    Ok(created)
}

#[derive(Serialize)]
pub struct BriefingNoteQuoteOutput {
    pub quote: Option<NoteQuote>,
}

/// 문구 팩 '내 노트 인용'(PLAN §6). async + 읽기 연결(`with_read`) — 후보 풀(최근 2000개)을 읽는 동안 메인 스레드와
/// 쓰기 잠금을 붙잡지 않는다(SCALABILITY.md §3, 브리핑 창이 열릴 때마다 한 번 돈다).
#[tauri::command(rename_all = "snake_case")]
pub async fn briefing_note_quote(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    exclude_note_id: Option<String>,
) -> Result<BriefingNoteQuoteOutput, AppError> {
    let quote = state.with_read(|conn| {
        let ws = match workspace_id {
            Some(w) => w,
            None => folders::active_workspace_id(conn)?,
        };
        briefing::note_quote(conn, &ws, exclude_note_id.as_deref())
    })?;
    Ok(BriefingNoteQuoteOutput { quote })
}
