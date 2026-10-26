// repo::ai::oauth — OpenRouter OAuth PKCE("로그인해서 붙이기").
//
// 사용자가 대시보드에서 키를 복사해 오는 대신 브라우저 로그인 한 번으로 **사용자 소유** API 키를
// 받아온다. OpenRouter 가 서드파티 앱용으로 문서화한 경로이고 클라이언트 등록이 필요 없다
// (https://openrouter.ai/docs/guides/overview/auth/oauth). 받은 키는 결국 settings.ai_api_key 에
// 들어가므로 **보관 위치와 보안 등급은 손으로 붙여넣던 때와 같다** — 바뀌는 건 UX 뿐이다.
//
// 왜 다른 프로바이더에는 같은 걸 안 하는가(2026-09 확인):
//   - Anthropic: 소비자 플랜 OAuth 토큰의 서드파티 사용을 약관으로 금지(2026-02-19 명문화,
//     04-04 과금 집행). API 키만 허용.
//   - Google: Gemini CLI OAuth 에서 개인/AI Pro/Ultra 티어를 아예 내렸다(2026-06-18). 남은 건
//     Code Assist Standard/Enterprise(조직 GCP 계정)뿐.
//   - OpenAI: 금지하진 않았지만 서드파티용 클라이언트 등록 경로가 없어 Codex CLI 의 client_id 를
//     빌려 쓰는 형태뿐이고, 그 토큰은 chat/completions 가 아니라 Codex 백엔드에만 먹힌다 —
//     transport.rs 의 provider 테이블에 완전히 다른 arm 이 하나 더 필요해진다. 그래서 안 한다.
//
// 리스너는 sync_server::ingest 와 같은 모양(127.0.0.1 고정 + axum)이되 **원샷**이다: 코드 하나를
// 받거나 CALLBACK_TIMEOUT 이 지나면 abort 한다. 포트를 0(임의)으로 잡는 이유도 그것 — 고정
// 포트였다면 두 번째 시도가 첫 시도의 잔여 리스너에 막힌다.
use crate::error::{io as ioerr, AppError, AppResult};
use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, Mutex};

const AUTH_URL: &str = "https://openrouter.ai/auth";
const KEYS_URL: &str = "https://openrouter.ai/api/v1/auth/keys";

/// 브라우저에서 로그인(중간에 가입까지)을 끝낼 시간. 여기서 끊는 건 사용자의 인내심이 아니라
/// **리스너의 수명**이다 — 프런트에는 취소 버튼이 따로 있고, 이 상한은 사용자가 브라우저 탭을
/// 그냥 닫아버렸을 때 포트를 영원히 붙들고 있지 않게 하는 backstop 이다.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

/// 승인이 끝나지 않았을 때의 단일 메시지 — 시간 초과든 리스너가 먼저 죽었든 사용자가 할 일은
/// "버튼을 다시 누른다" 하나뿐이라 원인을 갈라 보여줄 이유가 없다.
const NOT_AUTHORIZED: &str = "OpenRouter authorization did not complete — try connecting again";

/// 콜백 탭에 남는 페이지. ponytail: 로케일을 넘기지 않는다 — 앱으로 돌아오면 곧바로 닫는
/// 일회용 탭이라 ko/en/fr 세 벌을 배선할 값이 없다. 문구가 늘어날 일이 생기면 그때 locale 을
/// 인자로 받으면 된다.
const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Brise</title><body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh\"><p>Connected to Brise. You can close this tab.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Brise</title><body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh\"><p>No authorization code received. Return to Brise and try again.</p>";

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
}

/// 코드를 한 번만 보내고 닫히는 채널. `Option` 인 이유는 사용자가 콜백 URL 을 새로고침해
/// 핸들러가 두 번 돌아도 두 번째에는 보낼 sender 가 없어야 하기 때문(oneshot 은 소비된다).
type CodeSender = Arc<Mutex<Option<oneshot::Sender<String>>>>;

async fn callback(State(tx): State<CodeSender>, Query(q): Query<CallbackQuery>) -> Html<&'static str> {
    match q.code.filter(|c| !c.trim().is_empty()) {
        Some(code) => {
            if let Some(tx) = tx.lock().await.take() {
                let _ = tx.send(code);
            }
            Html(DONE_PAGE)
        }
        None => Html(FAILED_PAGE),
    }
}

/// PKCE 쌍. verifier 는 uuid v4 두 개(=hex 64자)라 RFC 7636 의 43~128자 unreserved 범위 안에
/// 들어가고, 새 난수 의존성을 들이지 않는다. challenge 는 base64url(sha256(verifier)) — 패딩을
/// 빼야 하고(URL_SAFE_NO_PAD), 그래야 쿼리 파라미터로 그대로 나간다.
fn pkce_pair() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// 인증 URL 조립. 직접 문자열을 이어붙이지 않는 이유는 callback_url 의 `://` 와 `/` 가 쿼리
/// 값으로 들어갈 때 퍼센트 인코딩돼야 하기 때문 — `Url::parse_with_params` 가 그걸 해준다.
fn auth_url(redirect: &str, challenge: &str) -> AppResult<reqwest::Url> {
    reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("callback_url", redirect),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|e| AppError::Io(e.to_string()))
}

#[derive(Deserialize)]
struct KeyResponse {
    key: String,
}

/// 인가 코드 → 사용자 소유 API 키. 실패 본문은 되돌리지 않는다(코드가 그대로 메아리쳐 로그에
/// 남을 수 있다) — 상태 코드만 알려주고 사용자는 버튼을 다시 누르면 된다.
async fn exchange(code: &str, verifier: &str) -> AppResult<String> {
    let res = super::transport::build_client(30)?
        .post(KEYS_URL)
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": verifier,
            "code_challenge_method": "S256",
        }))
        .send()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let status = res.status();
    if !status.is_success() {
        return Err(AppError::Io(format!(
            "OpenRouter key exchange failed with status {status} — the authorization code may have expired"
        )));
    }
    let body = res.text().await.map_err(|e| AppError::Io(e.to_string()))?;
    let parsed: KeyResponse = serde_json::from_str(&body).map_err(|e| AppError::Io(e.to_string()))?;
    if parsed.key.trim().is_empty() {
        return Err(AppError::Io("OpenRouter returned an empty key".to_string()));
    }
    Ok(parsed.key)
}

/// 브라우저를 열고 콜백을 기다렸다가 키를 돌려준다. 설정에 쓰지는 않는다 — 프런트가 기존
/// settings_set 경로로 저장한다(입력칸 상태도 같이 갱신해야 하므로 어차피 값을 알아야 한다).
pub async fn connect(app: &tauri::AppHandle) -> AppResult<String> {
    let (verifier, challenge) = pkce_pair();
    let (tx, rx) = oneshot::channel();

    let std_listener =
        std::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).map_err(ioerr)?;
    std_listener.set_nonblocking(true).map_err(ioerr)?;
    let port = std_listener.local_addr().map_err(ioerr)?.port();
    let state: CodeSender = Arc::new(Mutex::new(Some(tx)));
    let router = Router::new().route("/callback", get(callback)).with_state(state);

    let server = tauri::async_runtime::spawn(async move {
        // from_std 는 활성 Tokio reactor 가 있는 스레드에서만 된다 — ingest::start 와 같은 이유로
        // 변환을 스폰된 블록 안에서 한다.
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                crate::diag::error("oauth", "listener_setup_failed", format!("{e}"));
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            crate::diag::error("oauth", "serve_failed", format!("{e}"));
        }
    });

    let url = match auth_url(&format!("http://127.0.0.1:{port}/callback"), &challenge) {
        Ok(u) => u,
        Err(e) => {
            server.abort();
            return Err(e);
        }
    };
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        server.abort();
        return Err(AppError::Io(format!("failed to open the browser: {e}")));
    }

    let received = tokio::time::timeout(CALLBACK_TIMEOUT, rx).await;
    // 원샷: 코드를 받았든 시간이 다 됐든 여기서 포트를 놓는다.
    server.abort();
    let code = received
        .map_err(|_| AppError::Io(NOT_AUTHORIZED.to_string()))?
        .map_err(|_| AppError::Io(NOT_AUTHORIZED.to_string()))?;

    exchange(&code, &verifier).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// challenge 가 실제로 base64url-nopad(sha256(verifier)) 인지. 여기가 어긋나면 OpenRouter 가
    /// 교환을 거부해 흐름 전체가 조용히 죽는데, 네트워크를 타야만 알 수 있게 된다.
    #[test]
    fn challenge_is_base64url_sha256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
        assert!(!challenge.contains('='), "패딩이 남으면 쿼리 파라미터로 나갈 수 없다: {challenge}");
        assert!(
            !challenge.contains('+') && !challenge.contains('/'),
            "URL-safe 알파벳이어야 한다: {challenge}"
        );
    }

    /// RFC 7636 의 code_verifier 제약: 43~128자, unreserved 문자만.
    #[test]
    fn verifier_fits_pkce_constraints() {
        let (verifier, _) = pkce_pair();
        assert!((43..=128).contains(&verifier.len()), "len={}", verifier.len());
        assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn pkce_pair_is_fresh_each_call() {
        assert_ne!(pkce_pair().0, pkce_pair().0);
    }

    /// callback_url 은 퍼센트 인코딩돼서 들어가야 한다 — 날것으로 이어붙이면 `http://127.0.0.1:…`
    /// 의 `:`·`/` 때문에 OpenRouter 가 콜백을 잘못 파싱한다.
    #[test]
    fn auth_url_encodes_callback_and_declares_s256() {
        let url = auth_url("http://127.0.0.1:51423/callback", "chal-123").unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["callback_url"], "http://127.0.0.1:51423/callback");
        assert_eq!(q["code_challenge"], "chal-123");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(url.query().unwrap().contains("http%3A%2F%2F127.0.0.1"), "{url}");
    }
}
