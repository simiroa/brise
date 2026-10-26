// 동기화(beta) HTTP 핸들러 — /api/v1/* 7개(읽기: ping · notes 목록 · attachments 파일 · events,
// 쓰기: invoke · checklist 토글 · attachments 업로드) + 웹 클라이언트 정적 서빙(/app). 읽기
// 전용이 아니다. 노트 생성/수정/단건 조회 REST(POST/PUT/GET /api/v1/notes/{id})는 없고
// POST /api/v1/invoke 로 간다. 인증은 매 요청 authorized() 로 확인한다(미들웨어 대신 —
// 엔드포인트가 7개뿐이라 헬퍼 호출 한 줄이 미들웨어의 Request/Next 배관보다 더 짧고 읽기 쉽다).
//
// 이 파일은 **배선**만 갖는다 — ServerState · 라우트 표(build_router) · 본문 크기 상한. 라우트별
// 구현은 handlers/ 아래 관심사 단위로 나뉜다:
//
//   auth.rs           토큰 인증 판정(sync · ingest 서버 공용) + 로그용 토큰 마스킹 + `?token=` 쿼리
//   responses.rs      에러 응답 모양(REST 평문 / invoke JSON) — 합치지 않는다
//   ping.rs           GET  /api/v1/ping
//   notes.rs          GET  /api/v1/notes · POST /api/v1/notes/{id}/checklist (+ 쓰기 공용 가드·통지)
//   attachments.rs    GET  /api/v1/attachments/{note}/{*file} · POST /api/v1/notes/{id}/attachments
//   invoke.rs         POST /api/v1/invoke
//   remote_policy.rs  원격 invoke 가 하면 안 되는 것(설정 키 차단 · AI 키 오버라이드 제거 · 응답 비밀 제거)
//   ai_rate_limit.rs  원격 ai_* 커맨드 토큰 버킷
//   sse.rs            GET  /api/v1/events (SSE)
//   web_client.rs     /app 정적 서빙 + 구형 `/` · `/m` 리다이렉트
//
// 핸들러가 쓰는 항목은 전부 `pub(super)` 라 handlers 밖에서는 아래 `pub(crate) use` 로 다시 내보낸
// 것만 보인다(mod.rs · ingest.rs · 테스트가 쓰는 경로를 옛 위치 그대로 유지한다).
//
// DB 접근: **읽기 전용 REST 경로**(notes · attachments · ping 등)는 매 요청마다 독립 커넥션을 db::open() 으로
// 새로 연다(repo/transfer/backup.rs::auto_backup_run 과 동일한 패턴) — 앱의 AppState.db 뮤텍스를 건드리지
// 않아 메인 IPC 커맨드 큐와 경합하지 않는다. WAL 모드라 다중 리더는 항상 안전.
// **예외 — POST /api/v1/invoke(invoke.rs)**: dispatch.gen.rs 가 데스크톱 커맨드 함수를 그대로 부르므로
// `AppState.db` 전역 뮤텍스를 잡는다(R-6: 이 헤더가 "절대 건드리지 않는다"고 적혀 있던 것은 틀렸다).
// 폰이 보낸 쓰기·무거운 커맨드는 데스크톱 자동 저장과 같은 잠금 앞에 줄을 선다.
// ponytail: 요청마다 새 커넥션(+PRAGMA 재설정)은 폴링 빈도가 낮은 개인용 베타 기능에는 무시할
// 비용이다 — 동시 다중 기기가 자주 폴링하게 되면 커넥션 풀로 승격.
mod ai_rate_limit;
mod attachments;
mod auth;
mod invoke;
mod notes;
mod ping;
mod remote_policy;
mod responses;
mod sse;
mod web_client;

pub(crate) use ai_rate_limit::AiRateLimiter;
pub(crate) use auth::{redact_token_in_text, token_authorized};
// invoke.rs 가 쓰는 건 responses 경로 그대로다 — 이 재수출은 drill3_tests 가 옛 경로로 부르기 위한 것.
#[cfg(test)]
pub(crate) use responses::command_error_response;

use axum::routing::{get, post};
use axum::Router;
use std::path::PathBuf;

#[derive(Clone)]
pub(crate) struct ServerState {
    pub data_dir: PathBuf,
    pub token: String,
    /// POST /api/v1/invoke 가 커맨드를 디스패치할 대상. None 은 AppHandle 없이 도는 통합
    /// 테스트(sync_server/tests.rs, start() 를 직접 호출)용 — 그 경로는 503(디스패치엔 살아있는
    /// AppHandle이 필요, dispatch.gen.rs 참고). 웹뷰 emit 은 여기가 아니라 crate::events 가
    /// 전역 핸들로 한다(쓰기 통지의 단일 초크포인트).
    pub app_handle: Option<tauri::AppHandle>,
    /// 현재 열려있는 GET /api/v1/events 구독자 수 — MAX_SSE_SUBSCRIBERS 상한 강제용(sse.rs).
    /// Arc<AtomicUsize>라 ServerState 를 Clone(axum State) 해도 카운터는 하나만 공유된다.
    pub sse_subscribers: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// 서버가 멈추면(토글-off·토큰 재발급 = serve 태스크 abort) 송신 쪽이 drop 되어 `changed()` 가
    /// Err 로 깨어난다 — 이미 열려 있는 SSE 연결이 옛 토큰으로 살아남지 못하게 한다(abort 는 이미
    /// accept 된 연결 태스크를 죽이지 않는다. 2026-10-06 토큰 재발급 드릴에서 실측).
    pub shutdown: tokio::sync::watch::Receiver<()>,
    /// 원격 invoke 경로의 ai_* 커맨드 전용 토큰 버킷(invoke.rs) — Arc라 Clone(axum State) 해도
    /// 버킷 상태는 하나만 공유된다.
    pub ai_rate_limiter: std::sync::Arc<AiRateLimiter>,
}

/// axum's implicit default (when no DefaultBodyLimit layer is set at all) happens to also be 2MB —
/// pinning it explicitly here means that stays true on purpose, not by accident of the framework's
/// current default. Fine for every route except the attachment upload endpoint, which needs
/// its own larger per-route override (ATTACHMENT_UPLOAD_MAX_BYTES) since note bodies/checklist
/// toggles have no legitimate reason to be anywhere near this large.
const DEFAULT_BODY_LIMIT_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn build_router(state: ServerState) -> Router {
    let compressed_routes = Router::new()
        .route("/", get(web_client::redirect_to_app))
        .route("/m", get(web_client::redirect_to_app))
        .route("/api/v1/ping", get(ping::ping))
        .route("/api/v1/notes", get(notes::notes_list))
        .route("/api/v1/notes/{note_id}/checklist", post(notes::note_checklist_toggle))
        // route-level layer wins over the router-level DEFAULT_BODY_LIMIT_BYTES below (axum:
        // the DefaultBodyLimit closest to the handler applies) — this endpoint needs the larger
        // attachments::ATTACHMENT_UPLOAD_MAX_BYTES cap, everything else stays at the small default.
        .route(
            "/api/v1/notes/{note_id}/attachments",
            post(attachments::attachment_upload)
                .layer(axum::extract::DefaultBodyLimit::max(attachments::ATTACHMENT_UPLOAD_MAX_BYTES)),
        )
        .route("/api/v1/invoke", post(invoke::invoke))
        .route("/api/v1/events", get(sse::events))
        .route("/app", get(web_client::app_index))
        .route("/app/{*path}", get(web_client::app_asset))
        // gzip/br response compression — DefaultPredicate (tower_http::compression::CompressionLayer::new()'s
        // default) already skips text/event-stream (SSE), images, and gRPC by content-type, so /api/v1/events
        // doesn't need to be routed around this layer separately — sync_server/tests.rs's
        // events_stream_delivers_remote_note_write_on_a_write test is the proof this doesn't buffer/break SSE.
        .layer(tower_http::compression::CompressionLayer::new());

    Router::new()
        .merge(compressed_routes)
        // Keep attachments out of response compression (C3): video/audio/PDF are already compressed;
        // gzipping drops Accept-Ranges and Content-Length (tower-http removes ACCEPT_RANGES when compressing).
        .route("/api/v1/attachments/{note_id}/{*file}", get(attachments::attachment_file))
        .layer(axum::extract::DefaultBodyLimit::max(DEFAULT_BODY_LIMIT_BYTES))
        .with_state(state)
}

// 아래 테스트는 기능 카탈로그(specs/features/sync.yaml F-SY01 · notes.yaml F-N04)가 **이 파일을
// verify 경로로, 테스트 이름으로** 인용하는 것들이다(scripts/check-features.mjs 가 이름과 expect
// 리터럴을 이 파일에서 찾는다). 이동·개명하려면 카탈로그를 같이 고쳐야 한다. 같은 규칙의 나머지
// 단위 테스트는 각 모듈 파일(auth.rs · remote_policy.rs · ai_rate_limit.rs · attachments.rs)에 있다.
#[cfg(test)]
mod tests {
    use super::attachments::guess_mime;
    use super::auth::authorized;
    use super::remote_policy::{is_remote_blocked_settings_key, strip_secret_settings_from_response};
    use super::*;
    use crate::repo;
    use axum::http::HeaderMap;

    fn state(token: &str) -> ServerState {
        ServerState {
            data_dir: PathBuf::from("."),
            token: token.to_string(),
            app_handle: None,
            sse_subscribers: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            shutdown: tokio::sync::watch::channel(()).1,
            ai_rate_limiter: std::sync::Arc::new(AiRateLimiter::new()),
        }
    }

    /// 분류(kind_from_ext)와 서빙 mime(guess_mime)이 한 쌍이다 — audio 로 분류된 확장자가
    /// octet-stream 으로 나가면 폰 `<audio>` 가 재생을 못 하고, image 로 분류된 heic/heif 도 마찬가지.
    #[test]
    fn kind_and_guess_mime_stay_in_sync_for_media() {
        for ext in ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "weba", "opus"] {
            assert_eq!(repo::attachments::kind_from_ext(ext), "audio", "{ext}");
            assert!(guess_mime(ext).starts_with("audio/"), "{ext} -> {}", guess_mime(ext));
        }
        for ext in ["heic", "heif", "jpg", "png"] {
            assert_eq!(repo::attachments::kind_from_ext(ext), "image", "{ext}");
            assert!(guess_mime(ext).starts_with("image/"), "{ext} -> {}", guess_mime(ext));
        }
        assert_eq!(guess_mime("WEBA"), "audio/webm");
    }

    #[test]
    fn query_param_token_must_match_exactly() {
        let s = state("secret123");
        assert!(authorized(&s, &HeaderMap::new(), Some("secret123")));
        assert!(!authorized(&s, &HeaderMap::new(), Some("wrong")));
        assert!(!authorized(&s, &HeaderMap::new(), None));
    }

    #[test]
    fn redact_token_in_text_masks_query_values() {
        let raw = "GET /api/v1/notes?token=super-secret-uuid&limit=10";
        let red = redact_token_in_text(raw);
        assert!(!red.contains("super-secret-uuid"));
        assert!(red.contains("token=REDACTED"));
        assert!(red.contains("limit=10"));

        let encoded = "path?token%3DabcDEF&x=1";
        let red2 = redact_token_in_text(encoded);
        assert!(!red2.contains("abcDEF"));
        assert!(red2.contains("REDACTED"));
    }

    /// The settings_set remote denylist must cover both the sync_* prefix (pre-existing)
    /// and the four AI provider keys (new — a leaked sync_token could otherwise become a
    /// persistent exfil channel by repointing the owner's later local AI actions at an attacker
    /// endpoint). A normal, unrelated setting key must NOT be blocked.
    #[test]
    fn remote_blocked_settings_keys_cover_sync_prefix_and_ai_provider_keys() {
        for key in ["sync_enabled", "sync_token", "sync_port", "ai_provider", "ai_endpoint", "ai_api_key", "ai_provider_creds", "ai_enabled"] {
            assert!(is_remote_blocked_settings_key(key), "{key} must be blocked from remote settings_set");
        }
        // 이 기기에서 실행·쓰기가 일어나는 경로 설정 — 원격이 바꾸면 코드 실행/파일 쓰기 위치가 넘어간다.
        for key in ["soffice_path", "capture_screenshot_dir"] {
            assert!(is_remote_blocked_settings_key(key), "{key} points at this machine's filesystem and must be blocked from remote settings_set");
        }
        for key in ["theme", "ai_model", "accent", "font_scale"] {
            assert!(!is_remote_blocked_settings_key(key), "{key} is not a lifecycle/AI-provider setting and must remain changeable remotely");
        }
    }

    /// settings_get_all's response must have secret-typed keys stripped, and ONLY those —
    /// a normal setting must survive untouched. Directly exercises the same is_secret_setting_key
    /// predicate export/backup use, so this also catches drift if a new secret key is added there
    /// without a corresponding HTTP-response fix here.
    #[test]
    fn strip_secret_settings_removes_only_secret_keys_from_settings_get_all_response() {
        let mut v = serde_json::json!({
            "settings": {
                "sync_token": "leak-me-not",
                "ai_api_key": "sk-leak-me-not",
                "ai_provider_creds": { "openai": { "api_key": "sk-stashed-leak" } },
                "theme": "dark",
                "ai_provider": "openai",
            }
        });
        strip_secret_settings_from_response("settings_get_all", &mut v);
        let settings = v["settings"].as_object().unwrap();
        assert!(!settings.contains_key("sync_token"));
        assert!(!settings.contains_key("ai_api_key"));
        assert!(!settings.contains_key("ai_provider_creds"));
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["ai_provider"], "openai");
    }
}
