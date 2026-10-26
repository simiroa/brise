// 커맨드: activity_log — 기기 로컬 활동 이력 (commands/activity.yaml, http:false).
use super::AppState;
use crate::error::AppError;
use crate::repo::activity::{self, ActivityItem};
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn activity_list(
    state: State<AppState>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ActivityItem>, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(id) => id,
        None => crate::repo::folders::active_workspace_id(&conn)?,
    };
    activity::list(&conn, &ws, limit)
}
