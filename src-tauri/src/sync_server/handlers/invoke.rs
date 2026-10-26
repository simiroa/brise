// POST /api/v1/invoke — 앱의 Tauri 커맨드 중 `http:true` 인 것(dispatch.gen.rs)을 HTTP 로 여는 일반
// 표면. 웹 클라이언트의 거의 모든 쓰기가 여기로 온다. 호출 앞뒤의 원격 전용 가드(설정 키 차단 ·
// ai_* 레이트리밋/키 오버라이드 제거 · 응답 비밀 제거)는 remote_policy.rs / ai_rate_limit.rs 에 있고,
// 이 파일은 그것들을 올바른 순서로 엮는다.
use super::auth::{authorized, unauthorized, TokenQuery};
use super::remote_policy::{
    client_id, is_ai_command, is_remote_blocked_settings_key, strip_remote_ai_overrides, strip_secret_settings_from_response,
};
use super::responses::{command_error_response, error_response};
use super::ServerState;
use crate::sync_server::dispatch;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct InvokeBody {
    cmd: String,
    #[serde(default = "empty_json_object")]
    args: serde_json::Value,
}

fn empty_json_object() -> serde_json::Value {
    serde_json::json!({})
}

/// POST /api/v1/invoke {"cmd": "<name>", "args": {...}} — the generic HTTP surface for the app's
/// Tauri command set (dispatch.gen.rs, generated from specs/commands/*.yaml `http:true` commands).
/// Error shape is uniform {"error": "<string>"} per the coordinated contract (specs/commands/
/// sync.yaml, docs/CLIENT-RULES.md §2 addendum) — deliberately NOT the finer NotFound->404/
/// Validation->400 mapping the REST-ish endpoints use (responses.rs::app_error_response): unknown cmd is 404,
/// a bad-args deserialize failure is 400, and any AppError from the command itself is 500 (409 for
/// CONFLICT) with an additive "code" field — see command_error_response.
pub(super) async fn invoke(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<InvokeBody>,
) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    // settings_set is the one http:true command whose `entries` map could otherwise be used to
    // flip sync_enabled/sync_token/sync_port (server lifecycle — same policy sync_set_enabled/
    // sync_regenerate_token being http:false is supposed to enforce) OR ai_provider/ai_endpoint/
    // ai_api_key/ai_enabled. That second class matters just as much: a leaked sync_token would
    // otherwise let an attacker point the owner's OWN later local AI actions at an attacker-
    // controlled endpoint (or flip ai_enabled on) — a persistent exfil channel that survives
    // sync-token regeneration, since it lives in a *different* setting. A generated dispatch arm
    // has no room for a command-specific carve-out, so it's enforced here instead.
    if body.cmd == "settings_set" {
        if let Some(bad) = body
            .args
            .get("entries")
            .and_then(|v| v.as_object())
            .and_then(|entries| entries.keys().find(|k| is_remote_blocked_settings_key(k)))
        {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!(
                    "settings_set: '{bad}' cannot be changed over the remote API \
                     (docs/CLIENT-RULES.md §2)"
                ),
            );
        }
    }
    // ai_* 커맨드 보수적 rate limit — 원격 invoke 경로만(로컬 Tauri IPC는 이 핸들러 자체를 타지
    // 않는다). 이상 패턴 감지용 — 사람이 정상 사용하는 한 도달 불가한 상한이라 429 자체가
    // 곧 신호다 — diag 로 흔적을 남긴다(SECURITY-REVIEW-2026-08-04.md #2/#3).
    if is_ai_command(&body.cmd) && !state.ai_rate_limiter.try_acquire() {
        crate::diag::warn("sync", "ai_rate_limit_exceeded", format!("cmd={}", body.cmd));
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded for AI commands over the remote API — try again later",
        );
    }
    let mut args = body.args;
    // P2 보안(SECURITY-REVIEW-2026-08-04.md #2/#3): 원격 invoke 로 들어온 ai_* 커맨드는 호출자가
    // 임의의 endpoint/api_key 를 실어 보낼 수 있다 — repo 층은 이 값이 없으면 저장된 설정으로
    // 자동 폴백하므로(ai_test_connection 등), 여기서 지우기만 하면 나머지는 기존 폴백 경로가
    // 처리한다. 로컬 Tauri IPC(desktop webview)는 이 함수 자체를 거치지 않는다.
    strip_remote_ai_overrides(&body.cmd, &mut args);
    let Some(app) = state.app_handle.clone() else {
        // Real production path always has an app_handle (lib.rs wires it at boot). None only
        // happens in the None-app_handle test/dev harness (sync_server/tests.rs calls start(..., None)) —
        // there is no live app to dispatch a Tauri command against.
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "sync server has no live app handle — /api/v1/invoke unavailable in this harness",
        );
    };
    // 이 경로로 들어온 쓰기는 "remote"(폰) 다 — 커맨드가 부르는 crate::events::publish 가 이
    // 스코프를 읽어 origin 을 찍는다. 여기서 직접 publish 하지 않는 것이 핵심이다(커맨드가 이미
    // 낸다 — 둘 다 하면 이중 emit). crate::events 헤더 주석이 규칙 SSOT.
    let client = client_id(&headers);
    match crate::events::scope_remote(client, dispatch::dispatch(&app, &body.cmd, args)).await {
        Ok(mut v) => {
            strip_secret_settings_from_response(&body.cmd, &mut v);
            Json(v).into_response()
        }
        Err(dispatch::DispatchError::UnknownCommand) => {
            error_response(StatusCode::NOT_FOUND, format!("unknown command: {}", body.cmd))
        }
        Err(dispatch::DispatchError::BadArgs(msg)) => error_response(StatusCode::BAD_REQUEST, msg),
        Err(dispatch::DispatchError::Command(e)) => command_error_response(e),
    }
}
