// 에러 응답 모양 — 핸들러 계열마다 모양이 다르고, 그 차이가 클라이언트 계약의 일부라서 하나로
// 합치지 않는다:
//   app_error_response   REST 계열(ping · notes · checklist · attachments) — AppError 종류별
//                        상태코드(404/400/500) + **평문** 본문
//   join_error_response  spawn_blocking 조인 실패(패닉) 공용 — 평문 500
//   error_response · command_error_response
//                        POST /api/v1/invoke 계열 — `{"error": ...}` JSON (command 쪽은 `code` 추가)
// 401 은 auth.rs::unauthorized(평문).
use crate::error::AppError;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

pub(super) fn app_error_response(e: AppError) -> Response {
    let status = match e {
        AppError::NotFound(_) => StatusCode::NOT_FOUND,
        AppError::Validation(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, e.to_string()).into_response()
}

/// spawn_blocking 조인 실패(패닉) 공용 처리.
pub(super) fn join_error_response<E: std::fmt::Display>(e: E) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("worker join error: {e}")).into_response()
}

pub(super) fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

/// 커맨드 자체가 낸 AppError — `{"error"}` 에 **additive `code`**(AppError::code, 데스크톱 IPC 와
/// 같은 값)를 싣는다. 예전엔 전부 500 `{"error"}` 로 평탄화돼 폰이 CONFLICT·NOT_FOUND 를 "서버
/// 고장"과 구분하지 못했다(DRILLS-2026-10-06 d3). 상태는 CONFLICT 만 409, 나머지는 500 그대로 —
/// 404 는 브리지·CLI 가 "HTTP 표면 밖 커맨드"로 읽으므로 도메인 NOT_FOUND 에 쓰지 않는다.
pub(crate) fn command_error_response(e: AppError) -> Response {
    let status = match e {
        AppError::Conflict(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(serde_json::json!({ "error": e.to_string(), "code": e.code() }))).into_response()
}
