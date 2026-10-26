// 커맨드: search (commands/search.yaml)
use super::AppState;
use crate::error::AppError;
use crate::repo::search::{self, SearchResult};
use tauri::State;

/// async 인 이유(L-5): sync 커맨드는 Tauri 가 메인 스레드에서 돌려 검색이 도는 동안 다른 IPC 가 전부 줄을 섰다.
/// 본체는 그대로 — 읽기 연결(`with_read`)은 tokio 워커에서 돈다.
#[tauri::command(rename_all = "snake_case")]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: String,
    year_from: Option<i64>,
    year_to: Option<i64>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<SearchResult, AppError> {
    // 읽기 연결에서 돈다(Wave D3) — 검색이 도는 동안 자동 저장 등 쓰기 커맨드가 전역 `db` 잠금을 기다리지 않게.
    // search::search 는 읽기만 한다(활성 노트북 조회 포함). 클로저 안에서 `state.db` 를 다시 잡지 않는다(잠금 순서 db → read).
    state.with_read(|conn| search::search(conn, &query, year_from, year_to, workspace_id, limit))
}
