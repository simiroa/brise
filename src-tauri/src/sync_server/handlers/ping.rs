// GET /api/v1/ping — 연결 확인 겸 서버 신원(앱 버전 · 스키마 버전 · 기기 id · 노트북 수).
use super::auth::{authorized, unauthorized, TokenQuery};
use super::responses::{app_error_response, join_error_response};
use super::ServerState;
use crate::db;
use crate::error::{db as dberr, AppResult};
use crate::repo;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
struct PingBody {
    app_version: String,
    schema_version: i64,
    device_id: String,
    /// = 노트북 개수. 키 이름은 폰 클라이언트와의 계약이라 `workspace_count` 로 유지한다.
    workspace_count: i64,
}

pub(super) async fn ping(State(state): State<ServerState>, headers: HeaderMap, Query(q): Query<TokenQuery>) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    let data_dir = state.data_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> AppResult<PingBody> {
        let conn = db::open(&db::db_path(&data_dir))?;
        let schema_version = db::migrations::current_version(&conn)?;
        let device_id = repo::settings::get_all(&conn)?
            .get("device_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // workspaces 테이블 = 노트북 (DB 식별자는 호환성 때문에 개명하지 않는다).
        let workspace_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .map_err(dberr)?;
        Ok(PingBody {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version,
            device_id,
            workspace_count,
        })
    })
    .await;
    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => app_error_response(e),
        Err(e) => join_error_response(e),
    }
}
