// GET /api/v1/events (SSE) — 폰/브라우저 클라이언트가 "데이터가 바뀌었다" 통지를 실시간으로 받는
// 채널. 구독 대상은 서버 자신의 채널이 아니라 프로세스 전역 버스(crate::events)다.
use super::auth::{authorized, unauthorized, TokenQuery};
use super::ServerState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};

/// GET /api/v1/events (SSE) 동시 구독자 상한 — 버그 있는 재시도 루프나 유출된 토큰이 소켓을
/// 무한정 소진하지 못하게 막는 상한. 개인용 베타(사실상 1~2 클라이언트)라 8은 넉넉한 여유.
const MAX_SSE_SUBSCRIBERS: usize = 8;

/// events()의 스트림 state에 함께 실려 다니다가, 클라이언트가 끊겨 스트림 자체가 drop될 때
/// (unfold의 상태 튜플이 drop되는 시점) 카운터를 되돌리는 가드. 읽는 필드가 아니라 Drop 이 목적이다.
struct SseSlotGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for SseSlotGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// GET /api/v1/events (SSE) — 전역 버스(crate::events)의 프레임을 그대로 중계한다. 데스크톱 IPC
/// 쓰기·폰의 invoke 쓰기·손으로 쓴 REST 쓰기(notes.rs::emit_remote_write)가 모두 그 버스로 모이고,
/// 프레임 이름은 payload 의 `event` 필드("remote-note-write" · "pet-chat-updated" ·
/// "attachment-meta-*" 등)다. 서버는 Bearer 와 `?token=` 둘 다 받지만 EventSource 는 헤더를 못
/// 실으므로 브라우저 클라이언트는 쿼리로 보낸다.
pub(super) async fn events(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    use std::sync::atomic::Ordering;
    let prev = state.sse_subscribers.fetch_add(1, Ordering::SeqCst);
    if prev >= MAX_SSE_SUBSCRIBERS {
        state.sse_subscribers.fetch_sub(1, Ordering::SeqCst);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("too many concurrent sync clients (max {MAX_SSE_SUBSCRIBERS})"),
        )
            .into_response();
    }
    // 전역 버스 구독 — 서버 자신의 채널이 아니라 crate::events 다. 이게 데스크톱 IPC 쓰기가
    // 폰까지 도달하는 유일한 경로다(예전엔 서버 안에서만 만든 채널이라 커맨드 계층의 쓰기는
    // 구조적으로 SSE에 닿을 수 없었다).
    let rx = crate::events::subscribe();
    let guard = SseSlotGuard(state.sse_subscribers.clone());
    // guard travels inside the stream's own state tuple so it's dropped (and decrements the
    // counter) exactly when the stream itself ends — client disconnect, not before.
    let shutdown = state.shutdown.clone();
    let stream = futures_util::stream::unfold((rx, guard, shutdown), |(mut rx, guard, mut shutdown)| async move {
        loop {
            let recv = tokio::select! {
                r = rx.recv() => r,
                _ = shutdown.changed() => return None,
            };
            match recv {
                // P0 fix: without .event(...) axum defaults every frame to the unnamed "message"
                // SSE type, so the frontend's addEventListener("remote-note-write", ...) never
                // fires — the payload's own `"event":"remote-note-write"` JSON field is not the
                // same thing as the SSE wire-level `event:` line. Name the frame explicitly.
                Ok(payload) => {
                    // 프레임 이름 = payload 의 `event` 필드(crate::events 가 항상 넣는다). 없거나
                    // 파싱 불가면 기존 계약("remote-note-write")으로 폴백.
                    let name = serde_json::from_str::<serde_json::Value>(&payload)
                        .ok()
                        .and_then(|v| v.get("event").and_then(|e| e.as_str()).map(str::to_owned))
                        .unwrap_or_else(|| "remote-note-write".to_string());
                    let ev = SseEvent::default().event(name).data(payload);
                    return Some((Ok::<_, std::convert::Infallible>(ev), (rx, guard, shutdown)));
                }
                // A slow subscriber missed some events — the stream itself is still healthy, just
                // skip the gap and keep reading (retrying on the same receiver, not ending it).
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}
