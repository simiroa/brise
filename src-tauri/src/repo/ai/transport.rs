// repo::ai::transport — HTTP 왕복 실제 구현: post_chat + provider별 URL/인증/payload/응답 파싱
// 테이블, deadline-aware 재시도, 상태 코드 분류(check_ai_status) + mask_secrets. R1-c에서
// provider별 8개 함수 복붙을 테이블화한 결과물이 R4에서 그대로 이 파일로 이동했다. mod.rs의
// RealTransport/RealTranslateTransport/RealTextTransport/test_connection이 여기 함수들을 호출한다.
use super::{
    call_log, Provider, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_FALLBACK_MODEL, DEFAULT_GEMINI_MODEL,
    DEFAULT_MINIMAX_MODEL, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL,
};
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::time::{Duration, Instant};

/// A user-visible text operation (including its retry and optional model fallback) may not keep
/// the UI waiting forever. Individual HTTP clients can have shorter timeouts, but this is the
/// final wall-clock guard around the whole operation.
pub(super) const TEXT_OPERATION_DEADLINE: Duration = Duration::from_secs(45);

/// A background post-process (collect::summary, run on a spawned thread / runner rather than
/// blocking a user-facing action) doesn't have a human staring at a spinner, so it can afford a
/// much longer wall-clock budget than TEXT_OPERATION_DEADLINE — Ollama cold starts and large
/// Gemma prompts routinely exceed 45s (PLAN-2026-09-04-local-import §2.4).
pub(super) const BACKGROUND_OPERATION_DEADLINE: Duration = Duration::from_secs(120);

/// Vision uploads need more room than text, while still sharing one operation-wide deadline.
pub(super) const VISION_OPERATION_DEADLINE: Duration = Duration::from_secs(75);

/// 오디오 전사는 업로드(최대 ~19MB base64)+모델 처리라 비전(75s)보다 길다. 이 안에서 재시도 1회가
/// 가능하도록(RETRY_DELAY 5s) HTTP 클라이언트 타임아웃(mod.rs RealAudioTransport, 90s)보다 넉넉히 잡는다.
pub(super) const AUDIO_OPERATION_DEADLINE: Duration = Duration::from_secs(120);

const RETRY_DELAY: Duration = Duration::from_secs(5);

/// 시간 초과 판정의 **유일한** 기준 문자열. AppError::Io 는 원인을 타입으로 구분하지 않으므로
/// 호출자(commands::pet 의 스크린샷 요약 상태)가 메시지를 매칭한다 — 그 리터럴이 여기서 갈라져
/// 나가면 판정이 조용히 죽는다. 생산 코드·판정·테스트가 전부 이 상수를 쓴다.
/// repo::ai 밖에서는 `crate::repo::ai::DEADLINE_EXCEEDED` 로 재수출된다(mod.rs).
pub const DEADLINE_EXCEEDED: &str =
    "AI operation deadline exceeded before a retry or fallback could finish";

fn deadline_error() -> AppError {
    AppError::Io(DEADLINE_EXCEEDED.to_string())
}

/// 취소 판정의 **유일한** 기준 문자열 — `DEADLINE_EXCEEDED`와 같은 자세(호출자가 메시지로 갈라
/// outcome을 정한다, `AppError` 가 원인을 타입으로 구분하지 않으므로). `repo::ai` 밖에서는
/// `crate::repo::ai::CALL_CANCELLED` 로 재수출된다(mod.rs).
pub const CALL_CANCELLED: &str = "AI call was cancelled by the user";

fn cancelled_error() -> AppError {
    AppError::Io(CALL_CANCELLED.to_string())
}

/// PLAN-2026-09-05 §3 C-5 2단계 — 진짜 취소. `call_log::cancel(id)`가 신호를 보낸 토큰과 실제
/// 작업 future(`fut`)를 경합시킨다. 취소가 먼저 오면 `fut`를 그 자리에서 drop 한다(진행 중이던
/// reqwest 커넥션이 끊긴다). 호출부(mod.rs 의 두 Real transport)가 이걸로 `with_model_fallback_until`
/// **전체**(재시도+폴백)를 감싼다 — 그 함수 **안쪽**에서 select 하면 취소된 뒤에도 폴백 모델로
/// 한 번 더 나가버린다. `token`이 None이면(이미 취소됐거나 상한 초과로 링에서 밀려난 극단
/// 상황) select 없이 그냥 `fut`를 기다린다 — 취소 기능의 부재가 실 호출을 막지 않는다.
/// `biased`: 두 브랜치가 같은 폴 타이밍에 동시에 준비돼도(테스트처럼) 취소가 이긴다.
pub(super) async fn run_cancellable<T, Fut>(
    token: Option<std::sync::Arc<tokio::sync::Notify>>,
    fut: Fut,
) -> AppResult<T>
where
    Fut: std::future::Future<Output = AppResult<T>>,
{
    match token {
        Some(notify) => {
            tokio::select! {
                biased;
                _ = notify.notified() => Err(cancelled_error()),
                r = fut => r,
            }
        }
        None => fut.await,
    }
}

async fn within_deadline<T, Fut>(deadline: Instant, future: Fut) -> AppResult<T>
where
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(deadline_error());
    }
    tokio::time::timeout(remaining, future)
        .await
        .map_err(|_| deadline_error())?
}

pub(super) const AUDIO_CLIENT_TIMEOUT_MIN_SECS: u64 = 30;
pub(super) const AUDIO_CLIENT_TIMEOUT_MAX_SECS: u64 = 105;

/// 인라인 base64 크기(최대 ~19MB)에 비례하여 클라이언트 타임아웃을 조정한다.
/// 최소 30초, 최대 105초로 전체 AUDIO_OPERATION_DEADLINE(120초) 이내를 엄격히 유지한다.
pub(super) fn audio_client_timeout_secs(inline_base64_bytes: usize) -> u64 {
    let add_secs = (inline_base64_bytes as u64) / 250_000;
    (AUDIO_CLIENT_TIMEOUT_MIN_SECS + add_secs).clamp(AUDIO_CLIENT_TIMEOUT_MIN_SECS, AUDIO_CLIENT_TIMEOUT_MAX_SECS)
}

/// 오디오 호출 전용 재시도 판별 — 빠른 실패(429 또는 5xx 서버 에러)만 1회 재시도하고,
/// 클라이언트 타임아웃·데드라인 초과·사용자 취소 등은 절대 재시도하지 않는다 (M-3).
pub(super) fn is_audio_retryable(e: &AppError) -> bool {
    match e {
        AppError::Io(msg) => {
            if msg.contains("timed out") || msg.contains("timeout") || msg == DEADLINE_EXCEEDED || msg == CALL_CANCELLED {
                return false;
            }
            msg.contains("(retryable)") || msg.contains("status 429") || (msg.contains("status 5") && msg.contains("request failed"))
        }
        _ => false,
    }
}

async fn execute_with_retry_until<F, Fut, T, P>(deadline: Instant, should_retry: P, f: F) -> AppResult<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
    P: Fn(&AppError) -> bool,
{
    match within_deadline(deadline, f()).await {
        Ok(v) => Ok(v),
        Err(e) if should_retry(&e) => {
            // Wait 5s and retry once, but never let the sleep spill past the operation budget.
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(deadline_error());
            }
            // timeout drops the sleep when the shared deadline wins, so a retry can never
            // start on a scheduler tick just after the budget was exhausted.
            if tokio::time::timeout(remaining, tokio::time::sleep(RETRY_DELAY))
                .await
                .is_err()
            {
                return Err(deadline_error());
            }
            within_deadline(deadline, f()).await
        }
        Err(e) => Err(e),
    }
}

/// 폴백 모델 선택(순수 함수). 설정값(`ai_model_fallback`)이 있으면 그것, 없고 gemini 면
/// 오너가 고정한 조합의 아랫단(gemini-3.1-flash-lite → gemma-4-31b), 그 외에는 폴백 없음.
/// 이미 그 모델로 부른 경우(primary == 후보)도 None — 같은 모델 재시도는 deadline-aware retry 의
/// 몫이지 폴백이 아니다.
pub(super) fn resolve_fallback_model(
    provider: &Provider,
    configured: Option<&str>,
    primary: &str,
) -> Option<String> {
    let candidate = configured
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| match provider {
            Provider::Gemini => Some(DEFAULT_GEMINI_FALLBACK_MODEL.to_string()),
            _ => None,
        })?;
    (candidate != primary).then_some(candidate)
}

/// 폴백 모델을 **쓰지 않게** 하는 `fallback_model` 인자 — 기본 모델 자신을 폴백으로 넘기면
/// `resolve_fallback_model` 의 `candidate != primary` 가 거짓이 되어 폴백이 없어진다(`None` 은 Gemini 에서
/// 기본 폴백으로 풀리므로 "없음"이 아니다). 오디오처럼 폴백 모델이 입력을 받지 못하는 호출이 쓴다.
pub(super) fn no_fallback_arg(provider: &Provider, model_opt: &Option<String>) -> Option<String> {
    Some(
        model_opt
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| default_model(provider).to_string()),
    )
}

/// 모델을 바꿔 볼 가치가 있는 실패인가. Io = 네트워크/429/5xx(check_ai_status 분류),
/// Validation 중에서는 "그 모델이 없다/못 받는다"에 해당하는 404·400 만 — 401/403(키 문제)은
/// 모델을 바꿔도 똑같이 실패한다.
fn is_fallback_worthy(e: &AppError) -> bool {
    match e {
        AppError::Io(_) => true,
        AppError::Validation(msg) => msg.contains("status 404") || msg.contains("status 400"),
        _ => false,
    }
}

/// 기본 모델로 호출(+1회 재시도) → 재시도할 만한 실패면 폴백 모델로 **딱 한 번** 더. 폴백은
/// 재시도하지 않는다. 하나의 deadline이 primary, retry sleep/retry, fallback 전체에 공유된다.
/// 주입 가능한 duration 덕분에 실제 5초 대기 없이도 전체 시간 상한을 검증할 수 있다.
#[allow(dead_code)]
pub(super) async fn with_model_fallback_until<F, Fut, T>(
    provider: &Provider,
    model_opt: Option<String>,
    configured_fallback: Option<String>,
    deadline_budget: Duration,
    f: F,
) -> AppResult<T>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    with_model_fallback_until_policy(
        provider,
        model_opt,
        configured_fallback,
        deadline_budget,
        |e| matches!(e, AppError::Io(_)),
        f,
    )
    .await
}

pub(super) async fn with_model_fallback_until_policy<F, Fut, T, P>(
    provider: &Provider,
    model_opt: Option<String>,
    configured_fallback: Option<String>,
    deadline_budget: Duration,
    should_retry: P,
    f: F,
) -> AppResult<T>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
    P: Fn(&AppError) -> bool,
{
    let deadline = Instant::now() + deadline_budget;
    let primary = model_opt
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model(provider).to_string());
    let err = match execute_with_retry_until(deadline, &should_retry, || f(primary.clone())).await {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    if !is_fallback_worthy(&err) {
        return Err(err);
    }
    match resolve_fallback_model(provider, configured_fallback.as_deref(), &primary) {
        Some(fallback) => within_deadline(deadline, f(fallback)).await,
        None => Err(err),
    }
}

/// PLAN-2026-09-05 §3 C-4 — 실 프로바이더 호출 네 곳(`RealTextTransport::send_text`/
/// `send_json`(Gemini/Ollama 네이티브 스키마 오버라이드)/`RealVisionTransport::send_vision`/
/// `RealTranslateTransport::translate`)이 각자 복제하고 있던 "attempts/last_model 추적 →
/// `call_log::begin` → `run_cancellable(with_model_fallback_until(...))` → `call_log::finish`"
/// 뼈대를 여기 하나로 접는다. `op`은 호출부가 트레잇 시그니처만으로는 알 수 없는 값을 명시할
/// 때만 쓴다(vision이 `Some("vision")`을 넘기는 것처럼) — 그 외(caller/note_id/request_id, 그리고
/// text/organize/translate/cleanup/generate의 op)는 `call_log::begin`이 task-local `CALL_CTX`
/// (`commands::ai`가 `with_call_ctx`로 세팅)에서 채운다. `call`은 재시도/폴백 한 시도마다 실제
/// 모델 이름을 받아 HTTP 왕복 한 번을 수행하고 원문 문자열을 돌려준다 — `send_json`은 이 문자열을
/// 자기 파서(`parse_json_object_lenient`)로 한 번 더 해석한다.
#[allow(clippy::too_many_arguments)]
pub(super) async fn logged_call<F, Fut>(
    op: Option<String>,
    provider: &Provider,
    model_opt: Option<String>,
    fallback_model: Option<String>,
    deadline: Duration,
    request_text: &str,
    call: F,
) -> AppResult<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<String>>,
{
    logged_call_validated(op, provider, model_opt, fallback_model, deadline, request_text, call, |_| Ok(())).await
}

/// `logged_call` + 응답 검증. D7(docs/AUDIT-2026-09-26-fallback-observability.md): `send_json` 은
/// 응답 문자열을 받아온 **뒤** JSON 으로 해석하는데, 예전엔 그 해석이 `logged_call` 밖이라 해석이
/// 실패해도 call_log 엔 이미 "ok" 로 적혀 있었다(유일한 감시 장치가 성공이라고 말하던 결함).
///
/// `validate` 는 재시도/폴백 루프가 **끝난 뒤** 딱 한 번 돈다 — 클로저 안에서 해석해 실패를
/// `AppError::Io` 로 올리면 재시도(5초 대기)·폴백 모델까지 붙어, 프런트의 자체 복구 루프
/// (runAiAction 최대 3회)와 곱해져 실패 한 번에 호출이 여러 배로 불어난다. 기록만 바로잡고 재시도
/// 정책은 건드리지 않는다. 검증 실패는 outcome "error" + 받은 응답의 길이·앞부분(디버깅용)을 남긴다.
#[allow(clippy::too_many_arguments)]
pub(super) async fn logged_call_validated<F, Fut, V>(
    op: Option<String>,
    provider: &Provider,
    model_opt: Option<String>,
    fallback_model: Option<String>,
    deadline: Duration,
    request_text: &str,
    call: F,
    validate: V,
) -> AppResult<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<String>>,
    V: FnOnce(&str) -> AppResult<()>,
{
    let primary_model = model_opt
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model(provider).to_string());
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let last_model = std::sync::Arc::new(std::sync::Mutex::new(primary_model.clone()));
    let is_audio = op.as_deref() == Some("audio_transcribe");
    let call_id = call_log::begin(
        op,
        None,
        super::provider_log_label(provider),
        primary_model.clone(),
        None,
        request_text.len(),
        call_log::capture_head(request_text),
    );
    // §3 C-5 2단계: begin() 직후, 요청을 보내기 전에 취소 토큰을 받아둔다 — 이 사이에
    // ai_cancel_call이 이미 와도(극단적으로 빠른 취소) notify_one의 permit이 저장돼 있어
    // 놓치지 않는다(call_log::Ring::cancel 주석).
    let cancel_token = call_log::token(&call_id);
    let started = Instant::now();

    let attempts_ref = attempts.clone();
    let last_model_ref = last_model.clone();
    // 재시도/폴백 루프(with_model_fallback_until) 전체를 감싸 select 한다 — 안쪽에서 감쌌다면
    // 취소 뒤에도 폴백 모델로 한 번 더 나갔을 것이다(run_cancellable 주석).
    let result = run_cancellable(
        cancel_token,
        with_model_fallback_until_policy(
            provider,
            model_opt,
            fallback_model,
            deadline,
            move |e| {
                if is_audio {
                    is_audio_retryable(e)
                } else {
                    matches!(e, AppError::Io(_))
                }
            },
            move |model| {
                attempts_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                *last_model_ref.lock().unwrap() = model.clone();
                call(model)
            },
        ),
    )
    .await;

    let duration_ms = started.elapsed().as_millis() as i64;
    let attempts_n = attempts.load(std::sync::atomic::Ordering::Relaxed);
    let fallback_used = *last_model.lock().unwrap() != primary_model;
    if let Ok(response_text) = &result {
        if let Err(e) = validate(response_text) {
            call_log::finish(
                &call_id,
                attempts_n,
                fallback_used,
                duration_ms,
                Some(response_text.len()),
                "error",
                Some(e.to_string()),
                call_log::capture_head(response_text),
            );
            return Err(e);
        }
    }
    match &result {
        Ok(response_text) => call_log::finish(
            &call_id,
            attempts_n,
            fallback_used,
            duration_ms,
            Some(response_text.len()),
            "ok",
            None,
            call_log::capture_head(response_text),
        ),
        Err(e) => {
            let outcome = if matches!(e, AppError::Io(msg) if msg == DEADLINE_EXCEEDED) {
                "deadline"
            } else if matches!(e, AppError::Io(msg) if msg == CALL_CANCELLED) {
                "cancelled"
            } else {
                "error"
            };
            call_log::finish(&call_id, attempts_n, fallback_used, duration_ms, None, outcome, Some(e.to_string()), None);
        }
    }
    result
}

/// `sk-…`/Google `AIza…`/`Bearer …`/`api_key=…` 패턴을 지운다. 세 정규식은 history.rs::summarize_error_for_history
/// 등이 쓰는 변형과 동일 — 여기 하나로 통일하고 키 이름 보존 여부만 `key_replacement`로 갈린다
/// (history 는 `$1=***` 로 어떤 키였는지 남기고, 여기 `mask_secrets`(HTTP 응답 본문 스니펫)는
/// 통째로 `***`).
fn scrub_secrets(input: &str, key_replacement: &str) -> String {
    use std::sync::OnceLock;
    static RE_SK: OnceLock<regex::Regex> = OnceLock::new();
    static RE_GOOGLE: OnceLock<regex::Regex> = OnceLock::new();
    static RE_BEARER: OnceLock<regex::Regex> = OnceLock::new();
    static RE_KEY: OnceLock<regex::Regex> = OnceLock::new();

    let re_sk = RE_SK.get_or_init(|| regex::Regex::new(r"sk-[A-Za-z0-9_-]{8,}").unwrap());
    // Google API 키(AIza + 35자) — 2026-10-19: 프로브 실패 본문(403 'Consumer ... has been suspended' 류)이 진단에 남게 되며 추가.
    let re_google = RE_GOOGLE.get_or_init(|| regex::Regex::new(r"AIza[0-9A-Za-z_-]{35}").unwrap());
    let re_bearer = RE_BEARER.get_or_init(|| regex::Regex::new(r"(?i)Bearer\s+\S+").unwrap());
    let re_key = RE_KEY.get_or_init(|| regex::Regex::new(r"(?i)(api[-_]?key|token)\s*[=:]\s*\S+").unwrap());

    let s0 = re_google.replace_all(input, "***");
    let s1 = re_sk.replace_all(&s0, "***");
    let s2 = re_bearer.replace_all(&s1, "***");
    re_key.replace_all(&s2, key_replacement).into_owned()
}

// pub(super): repo::ai::call_log(형제 서브모듈)가 로그 파일에 쓰기 전에 에러 메시지를 이걸로
// 반드시 통과시킨다(PLAN-2026-09-05 §3 C-3) — 키가 디버그 로그 파일로 새면 안 된다.
pub(super) fn mask_secrets(input: &str) -> String {
    scrub_secrets(input, "***")
}

/// history.rs 전용 — 키 이름은 남기고 값만 지운다(`$1=***`), 감사 로그에서 "무슨 설정이
/// 새려 했는지"는 알아야 하기 때문.
pub(crate) fn mask_secrets_keep_key(input: &str) -> String {
    scrub_secrets(input, "$1=***")
}

/// propose/translate 계열 프로바이더 HTTP 응답의 상태 코드를 검사한다 — `*_ping` 함수들과
/// 달리 여기서는 실패를 삼키지 않고 명확한 원인(상태 코드 + 본문 일부)을 담아 반환해야 한다.
/// 분류 기준(execute_with_retry가 재시도하는 변형은 AppError::Io뿐이므로 그것에 맞춘다):
/// - 429(rate limit), 5xx(서버 오류): 일시적일 가능성이 높으므로 AppError::Io → 재시도됨.
/// - 401/403/400 등 나머지 클라이언트 오류: 재시도해도 같은 응답이 반복될 뿐이므로
///   AppError::Validation → 재시도되지 않고, 원인(예: API 키)을 바로 안내한다.
pub(crate) fn check_ai_status(provider_label: &str, status: reqwest::StatusCode, body: &str) -> AppResult<()> {
    if status.is_success() {
        return Ok(());
    }
    let masked_body = mask_secrets(body);
    let snippet: String = masked_body.chars().take(300).collect();
    let code = status.as_u16();
    if code == 429 || status.is_server_error() {
        return Err(AppError::Io(format!(
            "{provider_label} request failed with status {status} (retryable): {snippet}"
        )));
    }
    let hint = match code {
        401 => " — check your API key",
        403 => " — check your API key / permissions",
        400 => " — check request parameters (model name, payload)",
        _ => "",
    };
    Err(AppError::Validation(format!(
        "{provider_label} request failed with status {status}{hint}: {snippet}"
    )))
}

/// 요청 전송 단계의 reqwest 오류 분류 (AUDIT-2026-09-05-ai-guard-friction §2-2).
/// 연결 거부·DNS 실패(`is_connect`)는 밀리초 안에 확정되는 실패라 5초 뒤 다시 시도해도 같다 —
/// `execute_with_retry_until`이 재시도하는 `AppError::Io`가 아니라 `Validation`으로 돌려 즉시
/// 사용자에게 알린다(프런트 `aiErrorKind`가 "unreachable"로 분류해 설정 열기 버튼을 붙인다).
/// 타임아웃·본문 수신 오류 등 나머지는 일시적일 수 있어 현행대로 `Io`(재시도 대상).
fn map_send_error(e: reqwest::Error) -> AppError {
    if e.is_connect() {
        AppError::Validation(format!("could not connect to AI endpoint: {e}"))
    } else if e.is_timeout() {
        AppError::Io(format!("request timed out: {e}"))
    } else {
        AppError::Io(e.to_string())
    }
}

pub(super) fn build_client(timeout_secs: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| AppError::Io(e.to_string()))
}

pub(super) fn default_model(provider: &Provider) -> &'static str {
    match provider {
        Provider::Ollama => DEFAULT_OLLAMA_MODEL,
        Provider::OpenAI => DEFAULT_OPENAI_MODEL,
        Provider::Claude => DEFAULT_CLAUDE_MODEL,
        Provider::Gemini => DEFAULT_GEMINI_MODEL,
        Provider::Minimax => DEFAULT_MINIMAX_MODEL,
        Provider::OpenRouter => DEFAULT_OPENROUTER_MODEL,
    }
}

/// provider별 상태검사 라벨 — MiniMax는 Anthropic 호환 API를 그대로 타므로(예전 claude_propose/
/// claude_translate 재사용 경로), 에러 메시지도 이전과 동일하게 "claude"로 남긴다(사용자에게 보이는
/// 문자열이라 드리프트를 피하려고 기존 동작 그대로 유지).
fn provider_label(provider: &Provider) -> &'static str {
    match provider {
        Provider::Ollama => "ollama",
        Provider::OpenAI => "openai",
        Provider::OpenRouter => "openrouter",
        Provider::Claude | Provider::Minimax => "claude",
        Provider::Gemini => "gemini",
    }
}

fn chat_url(provider: &Provider, endpoint: &str, model: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    match provider {
        Provider::Ollama => format!("{base}/api/chat"),
        Provider::OpenAI | Provider::OpenRouter => format!("{base}/chat/completions"),
        Provider::Claude | Provider::Minimax => format!("{base}/messages"),
        Provider::Gemini => format!("{base}/models/{model}:generateContent"),
    }
}

fn apply_auth(req: reqwest::RequestBuilder, provider: &Provider, api_key: &str) -> reqwest::RequestBuilder {
    match provider {
        Provider::Ollama => req,
        Provider::OpenAI | Provider::OpenRouter => req.bearer_auth(api_key),
        Provider::Claude | Provider::Minimax => {
            req.header("x-api-key", api_key).header("anthropic-version", "2023-06-01")
        }
        Provider::Gemini => req.header("x-goog-api-key", api_key),
    }
}

fn response_content(provider: &Provider, v: &Value) -> AppResult<String> {
    let is_truncated = match provider {
        Provider::Ollama => false,
        Provider::OpenAI | Provider::OpenRouter => {
            v["choices"][0]["finish_reason"].as_str() == Some("length")
        }
        Provider::Claude | Provider::Minimax => {
            v["stop_reason"].as_str() == Some("max_tokens")
        }
        Provider::Gemini => {
            v["candidates"][0]["finishReason"].as_str() == Some("MAX_TOKENS")
        }
    };
    if is_truncated {
        return Err(AppError::Validation(
            "AI response was truncated (exceeded maximum output tokens)".to_string(),
        ));
    }
    let text = match provider {
        Provider::Ollama => v["message"]["content"].as_str(),
        Provider::OpenAI | Provider::OpenRouter => v["choices"][0]["message"]["content"].as_str(),
        Provider::Claude | Provider::Minimax => v["content"][0]["text"].as_str(),
        Provider::Gemini => v["candidates"][0]["content"]["parts"][0]["text"].as_str(),
    };
    match text {
        Some(s) if !s.trim().is_empty() => Ok(s.to_string()),
        _ => Err(AppError::Io(format!(
            "AI response from {} is empty",
            provider_label(provider)
        ))),
    }
}

/// propose(JSON 모드)/translate·cleanup·generate(평문) 공용 HTTP 왕복 — URL suffix, auth 헤더,
/// 응답 JSON 포인터만 provider별로 다르고 나머지(상태 검사 + mask_secrets + JSON 파싱)는 이전엔
/// `{provider}_propose`/`{provider}_translate` 8개 함수에 그대로 복붙돼 있었다.
pub(super) async fn post_chat(
    client: &reqwest::Client,
    provider: &Provider,
    endpoint: &str,
    api_key: &str,
    model: &str,
    payload: Value,
) -> AppResult<String> {
    let url = chat_url(provider, endpoint, model);
    let res = apply_auth(client.post(&url), provider, api_key)
        .json(&payload)
        .send()
        .await
        .map_err(map_send_error)?;
    let status = res.status();
    let text = res.text().await.map_err(|e| AppError::Io(e.to_string()))?;
    check_ai_status(provider_label(provider), status, &text)?;
    let v: Value = serde_json::from_str(&text).map_err(|e| AppError::Io(e.to_string()))?;
    response_content(provider, &v)
}

/// translate/cleanup/generate 공용 평문 payload. claude max_tokens는 이전 claude_translate와
/// 동일하게 4096(propose 경로의 claude_messages_payload는 1024 — 용도가 다르므로 값도 다르다).
fn provider_text_payload(provider: &Provider, model: &str, sys: &str, text: &str) -> Value {
    match provider {
        Provider::Ollama => serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": text}
            ],
            "stream": false
        }),
        Provider::OpenAI | Provider::OpenRouter => serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": text}
            ]
        }),
        Provider::Claude | Provider::Minimax => serde_json::json!({
            "model": model,
            "system": sys,
            "messages": [
                {"role": "user", "content": text}
            ],
            "max_tokens": 4096
        }),
        Provider::Gemini => gemini_text_payload(model, sys, text),
    }
}

/// 이미지 1장 + 지시문 → 평문. provider 별로 **이미지 파트의 모양만** 다르고 나머지(시스템
/// 지시를 사용자 파트와 섞지 않는다는 경계, 상태 검사, 응답 포인터)는 텍스트 경로와 완전히
/// 같으므로 post_chat/response_content 를 그대로 재사용한다.
/// `image_base64` 는 접두사 없는 raw base64, `mime` 은 "image/jpeg" 같은 미디어 타입.
fn provider_vision_payload(
    provider: &Provider,
    model: &str,
    sys: &str,
    text: &str,
    image_base64: &str,
    mime: &str,
) -> Value {
    match provider {
        // Ollama 의 멀티모달은 messages[].images(순수 base64 배열) — content 는 텍스트 그대로.
        Provider::Ollama => serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": text, "images": [image_base64]}
            ],
            "stream": false
        }),
        Provider::OpenAI | Provider::OpenRouter => serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": sys},
                {"role": "user", "content": [
                    {"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": format!("data:{mime};base64,{image_base64}")}}
                ]}
            ]
        }),
        Provider::Claude | Provider::Minimax => serde_json::json!({
            "model": model,
            "system": sys,
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": image_base64}},
                    {"type": "text", "text": text}
                ]}
            ],
            "max_tokens": 1024
        }),
        Provider::Gemini => serde_json::json!({
            "systemInstruction": {"parts": [{"text": sys}]},
            "contents": [{"role": "user", "parts": [
                {"inline_data": {"mime_type": mime, "data": image_base64}},
                {"text": text}
            ]}],
            // 텍스트 경로와 같은 이유로 thinking 끔 — 화면 한 장 요약에 사고 토큰이 필요 없다.
            "generationConfig": gemini_generation_config(model)
        }),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn provider_send_vision(
    client: &reqwest::Client,
    provider: &Provider,
    endpoint: &str,
    api_key: &str,
    model: &str,
    sys: &str,
    text: &str,
    image_base64: &str,
    mime: &str,
) -> AppResult<String> {
    let payload = provider_vision_payload(provider, model, sys, text, image_base64, mime);
    post_chat(client, provider, endpoint, api_key, model, payload).await
}

/// 오디오 1개 + 지시문 → 평문(전사). 오디오 `inline_data` 를 받는 것은 Gemini 뿐이다 — 다른
/// provider 는 요청을 **보내기 전에** 명확히 실패한다(오디오를 엉뚱한 payload 로 보내 모호한 4xx 를
/// 받지 않게). 실패 문구는 `AUDIO_UNSUPPORTED_PROVIDER` 한 곳이 기준이다(프런트가 안정 코드로 매칭).
pub const AUDIO_UNSUPPORTED_PROVIDER: &str =
    "audio_unsupported_provider: audio transcription requires the Gemini provider";

fn provider_audio_payload(
    provider: &Provider,
    model: &str,
    sys: &str,
    text: &str,
    audio_base64: &str,
    mime: &str,
) -> AppResult<Value> {
    match provider {
        // 이미지용 inline_data 와 같은 모양 — 파트의 mime_type 만 audio/*.
        Provider::Gemini => Ok(serde_json::json!({
            "systemInstruction": {"parts": [{"text": sys}]},
            "contents": [{"role": "user", "parts": [
                {"inline_data": {"mime_type": mime, "data": audio_base64}},
                {"text": text}
            ]}],
            "generationConfig": gemini_generation_config(model)
        })),
        _ => Err(AppError::Validation(AUDIO_UNSUPPORTED_PROVIDER.to_string())),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn provider_send_audio(
    client: &reqwest::Client,
    provider: &Provider,
    endpoint: &str,
    api_key: &str,
    model: &str,
    sys: &str,
    text: &str,
    audio_base64: &str,
    mime: &str,
) -> AppResult<String> {
    let payload = provider_audio_payload(provider, model, sys, text, audio_base64, mime)?;
    post_chat(client, provider, endpoint, api_key, model, payload).await
}

pub(super) async fn provider_send_text(
    client: &reqwest::Client,
    provider: &Provider,
    endpoint: &str,
    api_key: &str,
    model: &str,
    sys: &str,
    text: &str,
) -> AppResult<String> {
    let payload = provider_text_payload(provider, model, sys, text);
    post_chat(client, provider, endpoint, api_key, model, payload).await
}

/// 구조화(JSON) 응답 payload — 네이티브 JSON 모드가 있는 provider만 여기서 갈린다. Gemini는
/// `responseMimeType`+`responseSchema`(2026-09-05 실측: legacy `generateContent`가 Gemma에도
/// 받아준다 — gemini_generation_config가 이미 Gemma에서 thinkingConfig를 비우므로 그 값을 베이스로
/// 병합), Ollama는 `"format":"json"` 한 줄. 나머지(Claude/OpenRouter/Minimax)는 네이티브 모드가
/// 없어 평문 payload 그대로 — 스키마 지시는 호출자가 시스템 프롬프트에 이미 얹었다.
pub(super) fn provider_json_payload(provider: &Provider, model: &str, sys: &str, text: &str, schema: &Value) -> Value {
    match provider {
        Provider::Gemini => {
            let mut payload = gemini_text_payload(model, sys, text);
            let mut gen_config = gemini_generation_config(model);
            gen_config["responseMimeType"] = Value::from("application/json");
            gen_config["responseSchema"] = schema.clone();
            payload["generationConfig"] = gen_config;
            payload
        }
        Provider::Ollama => {
            let mut payload = provider_text_payload(provider, model, sys, text);
            payload["format"] = Value::from("json");
            payload
        }
        _ => provider_text_payload(provider, model, sys, text),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn provider_send_json(
    client: &reqwest::Client,
    provider: &Provider,
    endpoint: &str,
    api_key: &str,
    model: &str,
    sys: &str,
    text: &str,
    schema: &Value,
) -> AppResult<String> {
    let payload = provider_json_payload(provider, model, sys, text, schema);
    post_chat(client, provider, endpoint, api_key, model, payload).await
}

/// 번역/정리/생성 공용 텍스트 요청 payload — 위와 동일한 이유로 thinking 끔(JSON 스키마는
/// 해당 없음, 응답이 순수 텍스트라서). 시스템 지시는 systemInstruction, 사용자 텍스트는 contents.
fn gemini_text_payload(model: &str, system_prompt: &str, user_text: &str) -> Value {
    serde_json::json!({
        "systemInstruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": gemini_generation_config(model)
    })
}

/// Gemini 계열 generationConfig — thinking 은 끈다(응답이 순수 텍스트라 사고 토큰이 낭비). 단 Gemma
/// 모델(gemma-4-31b-it 등, 오너 고정 폴백)은 thinkingConfig 자체를 400 으로 거부하므로
/// ("Thinking budget is not supported for this model", 2026-09-05 실측) 비워 보낸다 — 이걸 안 가르면
/// Gemma 폴백은 영원히 한 번도 성공하지 못한다.
fn gemini_generation_config(model: &str) -> Value {
    if model.trim().to_ascii_lowercase().starts_with("gemma") {
        serde_json::json!({})
    } else {
        serde_json::json!({ "thinkingConfig": { "thinkingBudget": 0 } })
    }
}

pub(super) async fn ollama_models(client: &reqwest::Client, endpoint: &str) -> AppResult<Vec<String>> {
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let res = client.get(&url).send().await.map_err(|e| AppError::Io(e.to_string()))?;
    let text = res.text().await.map_err(|e| AppError::Io(e.to_string()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| AppError::Io(e.to_string()))?;
    let mut models = vec![];
    if let Some(arr) = v["models"].as_array() {
        for m in arr {
            if let Some(name) = m["name"].as_str() {
                models.push(name.to_string());
            }
        }
    }
    Ok(models)
}

/// ping류는 propose/translate와 별개 트랙: 실패해도 mask_secrets/재시도가 필요 없는 단순 상태
/// 확인이라(원래 ollama_ping/openai_ping/claude_ping/gemini_ping/anthropic_compat_ping 5개 함수)
/// check_ai_status 대신 이 얇은 헬퍼만 공유한다. ollama는 원래도 상태를 검사하지 않았다(연결만
/// 되면 성공 취급) — 그 동작 그대로 유지.
pub(super) fn ping_status_ok(status: reqwest::StatusCode, body: &str) -> AppResult<()> {
    if !status.is_success() {
        let masked = mask_secrets(body);
        let trimmed = masked.split_whitespace().collect::<Vec<_>>().join(" ");
        let summary: String = trimmed.chars().take(200).collect();
        if summary.is_empty() {
            return Err(AppError::Io(format!("status: {status}")));
        }
        return Err(AppError::Io(format!("status: {status}: {summary}")));
    }
    Ok(())
}

pub(super) async fn provider_ping(client: &reqwest::Client, provider: &Provider, endpoint: &str, api_key: &str, model: &str) -> AppResult<()> {
    let base = endpoint.trim_end_matches('/');
    match provider {
        Provider::Ollama => {
            client.get(format!("{base}/api/tags")).send().await.map_err(|e| AppError::Io(e.to_string()))?;
            Ok(())
        }
        Provider::OpenAI | Provider::OpenRouter => {
            let res = client.get(format!("{base}/models")).bearer_auth(api_key).send().await.map_err(|e| AppError::Io(e.to_string()))?;
            let status = res.status();
            let body = if !status.is_success() { res.text().await.unwrap_or_default() } else { String::new() };
            ping_status_ok(status, &body)
        }
        Provider::Claude | Provider::Minimax => {
            let payload = serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1
            });
            let res = client.post(format!("{base}/messages"))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&payload)
                .send().await.map_err(|e| AppError::Io(e.to_string()))?;
            let status = res.status();
            let body = if !status.is_success() { res.text().await.unwrap_or_default() } else { String::new() };
            ping_status_ok(status, &body)
        }
        Provider::Gemini => {
            let payload = serde_json::json!({
                "contents": [{"parts": [{"text": "ping"}]}],
                "generationConfig": {"maxOutputTokens": 1}
            });
            let res = client.post(format!("{base}/models/{model}:generateContent"))
                .header("x-goog-api-key", api_key)
                .json(&payload)
                .send().await.map_err(|e| AppError::Io(e.to_string()))?;
            let status = res.status();
            let body = if !status.is_success() { res.text().await.unwrap_or_default() } else { String::new() };
            ping_status_ok(status, &body)
        }
    }
}

#[cfg(test)]
mod status_classification_tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn success_status_passes_through() {
        assert!(check_ai_status("openai", StatusCode::OK, "{}").is_ok());
    }

    #[test]
    fn rate_limit_429_is_retryable_io_error() {
        let err = check_ai_status("openai", StatusCode::TOO_MANY_REQUESTS, "rate limited").unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "429 should map to AppError::Io so execute_with_retry retries it, got {err:?}");
    }

    #[test]
    fn server_error_5xx_is_retryable_io_error() {
        let err = check_ai_status("claude", StatusCode::INTERNAL_SERVER_ERROR, "oops").unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "5xx should map to AppError::Io so execute_with_retry retries it, got {err:?}");

        let err = check_ai_status("claude", StatusCode::SERVICE_UNAVAILABLE, "down").unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }

    #[test]
    fn unauthorized_401_is_non_retried_with_key_hint() {
        let err = check_ai_status("openai", StatusCode::UNAUTHORIZED, "invalid_api_key").unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("API key"), "expected API key hint, got: {msg}");
                assert!(msg.contains("401"));
            }
            other => panic!("401 should map to AppError::Validation (not retried), got {other:?}"),
        }
    }

    #[test]
    fn forbidden_403_is_non_retried() {
        let err = check_ai_status("gemini", StatusCode::FORBIDDEN, "denied").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "403 should not be retried, got {err:?}");
    }

    #[test]
    fn bad_request_400_is_non_retried() {
        let err = check_ai_status("gemini", StatusCode::BAD_REQUEST, "bad model").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "400 should not be retried, got {err:?}");
    }

    #[test]
    fn check_ai_status_masks_sensitive_patterns() {
        let raw_body = "Error response echo: sk-1234567890abcdef and Bearer my_secret_token and api_key=secret_key_value";
        let err = check_ai_status("openai", StatusCode::BAD_REQUEST, raw_body).unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("sk-1234567890abcdef"));
        assert!(!msg.contains("my_secret_token"));
        assert!(!msg.contains("secret_key_value"));
        assert!(msg.contains("***"));
    }

    #[test]
    fn ping_status_ok_includes_body_summary_for_403() {
        let err = ping_status_ok(StatusCode::FORBIDDEN, "API key expired or invalid sk-1234567890abcdef").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("403"));
        assert!(msg.contains("API key expired"));
        assert!(!msg.contains("sk-1234567890abcdef"), "keys must be masked: {msg}");
    }

    #[test]
    fn mask_secrets_hides_bare_google_api_keys() {
        // 실행할 때 조립한다 — 키 모양 리터럴이 저장소에 있으면 비밀 탐지기(푸시 보호)에 걸린다.
        let key = format!("AIza{}", "Sy0123456789abcdefghijklmnopqrstuvw");
        assert_eq!(key.len(), 39);
        let masked = mask_secrets(&format!("Permission denied: key {key} has been suspended"));
        assert!(!masked.contains(&key), "{masked}");
        assert!(masked.contains("***"));
    }
}

#[cfg(test)]
mod fallback_model_tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn gemini_falls_back_to_owner_pinned_model_when_unset() {
        assert_eq!(
            resolve_fallback_model(&Provider::Gemini, None, DEFAULT_GEMINI_MODEL).as_deref(),
            Some(DEFAULT_GEMINI_FALLBACK_MODEL)
        );
        assert_eq!(
            resolve_fallback_model(&Provider::Gemini, Some("  "), DEFAULT_GEMINI_MODEL).as_deref(),
            Some(DEFAULT_GEMINI_FALLBACK_MODEL)
        );
    }

    #[test]
    fn configured_fallback_wins_for_every_provider() {
        assert_eq!(
            resolve_fallback_model(&Provider::Gemini, Some("gemini-3.6-flash"), "gemini-3.1-flash-lite").as_deref(),
            Some("gemini-3.6-flash")
        );
        assert_eq!(
            resolve_fallback_model(&Provider::OpenAI, Some("gpt-4o-mini"), "gpt-4o").as_deref(),
            Some("gpt-4o-mini")
        );
    }

    #[test]
    fn no_fallback_without_config_outside_gemini() {
        for p in [Provider::Ollama, Provider::OpenAI, Provider::Claude, Provider::Minimax] {
            assert_eq!(resolve_fallback_model(&p, None, "m"), None, "{p:?} 는 설정이 있어야 폴백한다");
        }
    }

    #[test]
    fn never_falls_back_to_the_model_that_just_failed() {
        assert_eq!(
            resolve_fallback_model(&Provider::Gemini, None, DEFAULT_GEMINI_FALLBACK_MODEL),
            None
        );
        assert_eq!(resolve_fallback_model(&Provider::OpenAI, Some("gpt-4o"), "gpt-4o"), None);
    }

    #[test]
    fn only_retryable_and_model_shaped_failures_trigger_the_fallback() {
        assert!(is_fallback_worthy(&check_ai_status("gemini", StatusCode::TOO_MANY_REQUESTS, "rate").unwrap_err()));
        assert!(is_fallback_worthy(&check_ai_status("gemini", StatusCode::INTERNAL_SERVER_ERROR, "oops").unwrap_err()));
        assert!(is_fallback_worthy(&check_ai_status("gemini", StatusCode::NOT_FOUND, "model not found").unwrap_err()));
        assert!(is_fallback_worthy(&check_ai_status("gemini", StatusCode::BAD_REQUEST, "unknown model").unwrap_err()));
        // 키 문제는 모델을 바꿔도 그대로다 — 폴백으로 낭비하지 않는다.
        assert!(!is_fallback_worthy(&check_ai_status("gemini", StatusCode::UNAUTHORIZED, "bad key").unwrap_err()));
        assert!(!is_fallback_worthy(&check_ai_status("gemini", StatusCode::FORBIDDEN, "denied").unwrap_err()));
    }

    #[tokio::test]
    async fn model_not_found_retries_once_with_the_fallback_then_stops() {
        use std::sync::Mutex;
        let seen: Mutex<Vec<String>> = Mutex::new(vec![]);
        let out = with_model_fallback_until(&Provider::Gemini, None, None, TEXT_OPERATION_DEADLINE, |model| {
            let seen = &seen;
            async move {
                seen.lock().unwrap().push(model.clone());
                if model == DEFAULT_GEMINI_MODEL {
                    check_ai_status("gemini", StatusCode::NOT_FOUND, "no such model")?;
                }
                Ok(model)
            }
        })
        .await
        .unwrap();
        assert_eq!(out, DEFAULT_GEMINI_FALLBACK_MODEL);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![DEFAULT_GEMINI_MODEL.to_string(), DEFAULT_GEMINI_FALLBACK_MODEL.to_string()],
            "기본 모델 1회 + 폴백 1회, 루프 없음"
        );
    }

    /// MIG-3: 오디오는 폴백 모델을 쓰지 않는다 — 기본 모델이 폴백 대상 오류(400)로 실패해도 모델은 하나뿐.
    #[tokio::test]
    async fn no_fallback_arg_keeps_audio_on_a_single_model() {
        use std::sync::Mutex;
        for model_opt in [None, Some("gemini-custom".to_string())] {
            let seen: Mutex<Vec<String>> = Mutex::new(vec![]);
            let fb = no_fallback_arg(&Provider::Gemini, &model_opt);
            let err = with_model_fallback_until(&Provider::Gemini, model_opt, fb, TEXT_OPERATION_DEADLINE, |model| {
                let seen = &seen;
                async move {
                    seen.lock().unwrap().push(model);
                    check_ai_status("gemini", StatusCode::BAD_REQUEST, "audio rejected")?;
                    Ok(String::new())
                }
            })
            .await
            .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)));
            assert_eq!(seen.lock().unwrap().len(), 1, "모델 이름은 하나만 쓰인다");
        }
    }

    #[tokio::test]
    async fn auth_failure_never_reaches_the_fallback() {
        use std::sync::Mutex;
        let seen: Mutex<Vec<String>> = Mutex::new(vec![]);
        let err = with_model_fallback_until(&Provider::Gemini, None, None, TEXT_OPERATION_DEADLINE, |model| {
            let seen = &seen;
            async move {
                seen.lock().unwrap().push(model);
                check_ai_status("gemini", StatusCode::UNAUTHORIZED, "bad key")?;
                Ok(String::new())
            }
        })
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// One wall-clock budget covers the retry sleep and the fallback attempt.  Keeping this
    /// test at the transport seam means it cannot accidentally be replaced by per-request
    /// client timeouts that add up beyond the operation deadline.
    #[tokio::test]
    async fn deadline_stops_retry_sleep_before_a_second_attempt() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let calls = Arc::new(AtomicUsize::new(0));
        let err = with_model_fallback_until(
            &Provider::OpenAI,
            Some("primary".to_string()),
            Some("fallback".to_string()),
            Duration::from_millis(20),
            |model| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err::<String, _>(AppError::Io(format!("{model} unavailable")))
                }
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Io(message) if message.contains("deadline")));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "deadline cancels the retry sleep and fallback");
    }

    #[tokio::test]
    async fn deadline_also_bounds_the_fallback_attempt() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let calls = Arc::new(AtomicUsize::new(0));
        let err = with_model_fallback_until(
            &Provider::OpenAI,
            Some("primary".to_string()),
            Some("fallback".to_string()),
            Duration::from_millis(20),
            |model| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if model == "primary" {
                        return Err(AppError::Validation("openai request failed with status 404".to_string()));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Ok::<String, AppError>(model)
                }
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Io(message) if message.contains("deadline")));
        assert_eq!(calls.load(Ordering::SeqCst), 2, "fallback starts, but cannot exceed the shared deadline");
    }
}

#[cfg(test)]
mod run_cancellable_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    /// 취소 신호가 먼저 오면(요청은 아직 "진행 중" — sleep으로 요청 대역을 흉내낸다) 결과는
    /// 즉시 취소 에러이고, 원래 작업(sleep 뒤 Ok)의 나머지는 절대 관측되지 않는다 — 실 네트워크
    /// 없이 select 우선순위(취소가 먼저)를 확인한다.
    #[tokio::test]
    async fn cancellation_wins_over_a_slow_in_flight_request() {
        let notify = Arc::new(Notify::new());
        let request_finished = Arc::new(AtomicBool::new(false));
        let request_finished_ref = request_finished.clone();

        notify.notify_one(); // ai_cancel_call이 이미 신호를 보낸 상태를 흉내낸다
        let out = run_cancellable(
            Some(notify),
            async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                request_finished_ref.store(true, Ordering::SeqCst);
                Ok::<&str, AppError>("should not be observed")
            },
        )
        .await;

        assert!(matches!(out, Err(AppError::Io(msg)) if msg == CALL_CANCELLED));
        assert!(
            !request_finished.load(Ordering::SeqCst),
            "the in-flight future must have been dropped, not merely raced and discarded after completing"
        );
    }

    /// 취소 신호가 없으면(토큰 자체가 None — 이미 링에서 밀려난 극단 상황) 원래 작업이 그대로
    /// 끝까지 실행되고 결과가 그대로 전달된다.
    #[tokio::test]
    async fn no_token_runs_the_future_to_completion() {
        let out = run_cancellable(None, async { Ok::<&str, AppError>("done") }).await;
        assert_eq!(out.unwrap(), "done");
    }

    /// 취소 신호가 전혀 오지 않으면 작업이 끝난 결과가 그대로 나온다(select가 있어도 정상
    /// 성공 경로를 바꾸지 않는다).
    #[tokio::test]
    async fn completes_normally_when_never_cancelled() {
        let notify = Arc::new(Notify::new());
        let out = run_cancellable(Some(notify), async { Ok::<&str, AppError>("ok") }).await;
        assert_eq!(out.unwrap(), "ok");
    }
}

#[cfg(test)]
mod logged_call_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // 전역 링(OnceLock, 병렬 테스트 공유)에서 자기 항목만 골라내도록 매 테스트가 고유한 op 태그를
    // 쓴다 — call_log.rs 기존 테스트들의 "provider 접두사로 찾는다" 관례와 같은 이유.
    fn unique_tag(label: &str) -> String {
        format!("{label}-{}", crate::util::new_id())
    }

    #[tokio::test]
    async fn success_leaves_an_ok_entry_with_attempts_and_response_len() {
        let op_tag = unique_tag("logged-call-success");
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();

        let out = logged_call(
            Some(op_tag.clone()),
            &Provider::Ollama,
            None,
            None,
            TEXT_OPERATION_DEADLINE,
            "hello world",
            move |_model| {
                let calls_ref = calls_ref.clone();
                async move {
                    calls_ref.fetch_add(1, Ordering::SeqCst);
                    Ok("response text".to_string())
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(out, "response text");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.op.as_deref() == Some(op_tag.as_str()))
            .expect("logged_call must append a finished entry to the call log");
        assert_eq!(entry.outcome.as_deref(), Some("ok"));
        assert_eq!(entry.attempts, 1);
        assert_eq!(entry.provider, "ollama");
        assert_eq!(entry.prompt_bytes, "hello world".len());
        assert_eq!(entry.response_bytes, Some("response text".len()));
        assert!(!entry.fallback_used);
    }

    #[tokio::test]
    async fn fallback_worthy_failure_falls_back_and_the_entry_is_keyed_by_the_primary_model() {
        let op_tag = unique_tag("logged-call-fallback");

        let out = logged_call(
            Some(op_tag.clone()),
            &Provider::Gemini,
            None,
            None,
            TEXT_OPERATION_DEADLINE,
            "x",
            move |model| async move {
                if model == DEFAULT_GEMINI_MODEL {
                    check_ai_status("gemini", reqwest::StatusCode::NOT_FOUND, "no such model")?;
                }
                Ok(model)
            },
        )
        .await
        .unwrap();

        assert_eq!(out, DEFAULT_GEMINI_FALLBACK_MODEL);

        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.op.as_deref() == Some(op_tag.as_str()))
            .expect("logged_call must append a finished entry");
        assert!(entry.fallback_used);
        assert_eq!(entry.model, DEFAULT_GEMINI_MODEL, "the logged model is the primary attempted, not the fallback");
        assert_eq!(entry.outcome.as_deref(), Some("ok"));
        assert_eq!(entry.attempts, 2, "primary attempt (404, not retried) + one fallback attempt");
    }

    #[tokio::test]
    async fn error_leaves_a_masked_error_entry() {
        let op_tag = unique_tag("logged-call-error");

        let err = logged_call(
            Some(op_tag.clone()),
            &Provider::OpenAI,
            None,
            None,
            TEXT_OPERATION_DEADLINE,
            "x",
            move |_model| async move {
                Err(AppError::Validation(
                    "openai request failed with status 401 — Bearer sk-shouldbemaskedabcdefgh".to_string(),
                ))
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.op.as_deref() == Some(op_tag.as_str()))
            .expect("logged_call must append a finished entry even on failure");
        assert_eq!(entry.outcome.as_deref(), Some("error"));
        assert!(!entry.error.as_deref().unwrap().contains("sk-shouldbemaskedabcdefgh"), "call_log::finish must mask secrets in the stored error");
    }

    // D7(AUDIT-2026-09-26-fallback-observability.md) 회귀 가드 — send_json 의 해석 실패가 call_log
    // 에 "ok" 로 남던 결함. logged_call_validated 는 (1) 실패를 "error" 로 기록하고 (2) 호출자에게
    // 검증 에러를 그대로(Io) 돌려주며 (3) 재시도/폴백을 **추가로 부르지 않는다** — 해석 실패에
    // 5초 재시도·폴백 모델이 붙으면 프런트 복구 루프와 곱해져 호출이 여러 배로 불어난다.
    #[tokio::test]
    async fn validation_failure_is_recorded_as_error_without_retry_or_fallback() {
        let op_tag = unique_tag("logged-call-send-json-parse-failure");
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let calls_ref = calls.clone();

        let err = logged_call_validated(
            Some(op_tag.clone()),
            &Provider::Gemini, // Gemini 는 설정이 없어도 기본 폴백 모델이 있다 — 폴백이 붙는지 보려고.
            None,
            None,
            TEXT_OPERATION_DEADLINE,
            "x",
            move |_model| {
                calls_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                async move { Ok("not json at all, just prose".to_string()) }
            },
            |raw| {
                if raw.trim_start().starts_with('{') {
                    Ok(())
                } else {
                    Err(AppError::Io("no JSON object found in AI response".to_string()))
                }
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "the caller keeps seeing the parser's own error kind");
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1, "no same-model retry, no fallback model");

        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.op.as_deref() == Some(op_tag.as_str()))
            .expect("logged_call_validated must append a finished entry");
        assert_eq!(entry.outcome.as_deref(), Some("error"), "D7: a parse failure must not be recorded as ok");
        assert!(!entry.fallback_used);
    }

    #[tokio::test]
    async fn validation_success_is_recorded_as_ok() {
        let op_tag = unique_tag("logged-call-send-json-parse-ok");
        let text = logged_call_validated(
            Some(op_tag.clone()),
            &Provider::Ollama,
            None,
            None,
            TEXT_OPERATION_DEADLINE,
            "x",
            |_model| async { Ok("{\"a\":1}".to_string()) },
            |raw| if raw.starts_with('{') { Ok(()) } else { Err(AppError::Io("bad".into())) },
        )
        .await
        .unwrap();
        assert_eq!(text, "{\"a\":1}");
        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.op.as_deref() == Some(op_tag.as_str()))
            .unwrap();
        assert_eq!(entry.outcome.as_deref(), Some("ok"));
    }

    // 취소 경로: `call_log::CallCtx.request_id`로 태깅해 이 helper가 begin→run_cancellable→finish
    // 전체 배선을 지나면서도 W-C2의 request_id 취소가 그대로 통한다는 것까지 한 번에 확인한다.
    #[tokio::test]
    async fn cancellation_is_recorded_as_a_cancelled_outcome() {
        let request_id = unique_tag("logged-call-cancel-req");
        let started = Arc::new(tokio::sync::Notify::new());
        let started_ref = started.clone();

        let ctx = call_log::CallCtx { request_id: Some(request_id.clone()), ..Default::default() };
        let fut = call_log::with_call_ctx(
            ctx,
            logged_call(None, &Provider::Ollama, None, None, TEXT_OPERATION_DEADLINE, "cancel-me", move |_model| {
                let started_ref = started_ref.clone();
                async move {
                    started_ref.notify_one();
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    Ok("late".to_string())
                }
            }),
        );

        let request_id_bg = request_id.clone();
        let canceller = tokio::spawn(async move {
            started.notified().await;
            loop {
                if call_log::cancel_by_request_id(&request_id_bg) > 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        });

        let result = fut.await;
        canceller.await.unwrap();

        assert!(matches!(result, Err(AppError::Io(msg)) if msg == CALL_CANCELLED));
        let entry = call_log::recent(300)
            .into_iter()
            .find(|e| e.request_id.as_deref() == Some(request_id.as_str()))
            .expect("finished entry must be in the call log");
        assert_eq!(entry.outcome.as_deref(), Some("cancelled"));
    }
}

#[cfg(test)]
mod gemini_payload_tests {
    use super::*;

    #[test]
    fn text_payload_disables_thinking() {
        let payload = gemini_text_payload("gemini-3.1-flash-lite", "SYS", "TEXT");
        assert_eq!(
            payload["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );
        assert!(payload["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("TEXT"));
    }

    /// Gemma 는 thinkingConfig 를 400 으로 거부한다 — 폴백 모델이 실제로 동작하려면 비워 보내야 한다.
    #[test]
    fn gemma_payloads_omit_thinking_config_entirely() {
        let text = gemini_text_payload("gemma-4-31b-it", "SYS", "TEXT");
        assert!(text["generationConfig"].get("thinkingConfig").is_none());
        let vision = provider_vision_payload(&Provider::Gemini, "gemma-4-31b-it", "SYS", "ASK", "AA==", "image/png");
        assert!(vision["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn gemini_text_keeps_system_out_of_user_contents() {
        let payload = gemini_text_payload("gemini-3.1-flash-lite", "SYS_INSTR", "plain user text");
        assert_eq!(
            payload["systemInstruction"]["parts"][0]["text"].as_str().unwrap(),
            "SYS_INSTR"
        );
        let user = payload["contents"][0]["parts"][0]["text"].as_str().unwrap();
        assert_eq!(user, "plain user text");
        assert!(!user.contains("SYS_INSTR"));
    }

    #[test]
    fn ollama_chat_keeps_system_role_separate_from_user() {
        let payload = provider_text_payload(&Provider::Ollama, "m", "SYS_ROLE", "USER_MD");
        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][0]["content"], "SYS_ROLE");
        assert_eq!(payload["messages"][1]["role"], "user");
        assert_eq!(payload["messages"][1]["content"], "USER_MD");
        assert!(!payload["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("SYS_ROLE"));
    }

    #[test]
    fn openai_chat_keeps_system_role_separate_from_user() {
        let payload = provider_text_payload(&Provider::OpenAI, "m", "SYS_ROLE", "USER_MD");
        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][0]["content"], "SYS_ROLE");
        assert_eq!(payload["messages"][1]["role"], "user");
        assert_eq!(payload["messages"][1]["content"], "USER_MD");
        assert!(!payload["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("SYS_ROLE"));
    }

    #[test]
    fn claude_messages_keeps_system_field_separate_from_user() {
        let payload = provider_text_payload(&Provider::Claude, "m", "SYS_ROLE", "USER_MD");
        assert_eq!(payload["system"], "SYS_ROLE");
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][0]["content"], "USER_MD");
        assert!(!payload["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("SYS_ROLE"));
    }

    /// 비전 payload 도 텍스트 경로와 같은 주입 경계를 지킨다: 시스템 계약은 사용자 파트에
    /// 섞이지 않고, 이미지는 provider 별 제자리에 들어간다.
    #[test]
    fn vision_payload_carries_the_image_in_each_provider_slot() {
        let b64 = "AAAA";
        let ollama = provider_vision_payload(&Provider::Ollama, "m", "SYS", "ASK", b64, "image/jpeg");
        assert_eq!(ollama["messages"][1]["images"][0], b64);
        assert_eq!(ollama["messages"][0]["content"], "SYS");

        let openai = provider_vision_payload(&Provider::OpenAI, "m", "SYS", "ASK", b64, "image/jpeg");
        assert_eq!(
            openai["messages"][1]["content"][1]["image_url"]["url"],
            "data:image/jpeg;base64,AAAA"
        );
        assert_eq!(openai["messages"][1]["content"][0]["text"], "ASK");

        let claude = provider_vision_payload(&Provider::Claude, "m", "SYS", "ASK", b64, "image/png");
        assert_eq!(claude["system"], "SYS");
        assert_eq!(claude["messages"][0]["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(claude["messages"][0]["content"][0]["source"]["data"], b64);

        let gemini = provider_vision_payload(&Provider::Gemini, "gemini-3.1-flash-lite", "SYS", "ASK", b64, "image/jpeg");
        assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], "SYS");
        assert_eq!(gemini["contents"][0]["parts"][0]["inline_data"]["data"], b64);
        assert_eq!(gemini["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
    }

    /// 2026-09-05 실측: Gemma는 plain text 모드에서 사고 과정을 답에 흘려버리지만, 이
    /// `responseSchema`/`responseMimeType` 조합은 legacy `generateContent`에서도 통한다.
    #[test]
    fn json_payload_gemini_carries_schema_and_mime_type() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"goal": {"type": "string"}},
            "required": ["goal"]
        });
        let payload = provider_json_payload(&Provider::Gemini, "gemini-3.1-flash-lite", "SYS", "TEXT", &schema);
        assert_eq!(payload["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(payload["generationConfig"]["responseSchema"], schema);
        assert_eq!(payload["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
        assert_eq!(payload["contents"][0]["parts"][0]["text"], "TEXT");
    }

    /// Gemma가 400으로 거부하는 건 thinkingConfig뿐 — responseSchema/responseMimeType은 유지된다.
    #[test]
    fn json_payload_gemma_keeps_schema_but_omits_thinking_config() {
        let schema = serde_json::json!({"type": "object"});
        let payload = provider_json_payload(&Provider::Gemini, "gemma-4-31b-it", "SYS", "TEXT", &schema);
        assert_eq!(payload["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(payload["generationConfig"]["responseSchema"], schema);
        assert!(payload["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn json_payload_ollama_sets_format_json_and_keeps_messages_intact() {
        let schema = serde_json::json!({"type": "object"});
        let payload = provider_json_payload(&Provider::Ollama, "llama3.1", "SYS_ROLE", "USER_MD", &schema);
        assert_eq!(payload["format"], "json");
        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][0]["content"], "SYS_ROLE");
        assert_eq!(payload["messages"][1]["content"], "USER_MD");
    }

    /// Claude/OpenRouter/Minimax는 네이티브 JSON 모드가 없다 — schema 파라미터는 무시되고
    /// 평문 payload 그대로 나가야 한다(스키마 지시는 호출자가 시스템 프롬프트에 얹는다).
    #[test]
    fn json_payload_claude_has_no_native_schema_field() {
        let schema = serde_json::json!({"type": "object"});
        let payload = provider_json_payload(&Provider::Claude, "m", "SYS", "TEXT", &schema);
        assert_eq!(payload, provider_text_payload(&Provider::Claude, "m", "SYS", "TEXT"));
    }
}

#[cfg(test)]
mod map_send_error_tests {
    use super::*;

    #[tokio::test]
    async fn connection_refused_is_not_retryable() {
        // 127.0.0.1:9 (discard) 는 열려 있지 않다 — 로컬 커널이 즉시 RST 를 돌려주므로 네트워크 없이 결정적.
        let client = build_client(5).unwrap();
        let err = client.get("http://127.0.0.1:9/").send().await.map_err(map_send_error).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "connect refusal must not enter the 5s retry loop, got {err:?}");
    }

    #[test]
    fn retryable_io_classification_unchanged_for_status_errors() {
        // map_send_error 는 전송 단계만 다룬다 — 상태 코드 분류(check_ai_status)는 그대로 429/5xx 가 Io.
        let err = check_ai_status("openai", reqwest::StatusCode::TOO_MANY_REQUESTS, "slow down").unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }
}

#[cfg(test)]
mod response_content_tests {
    use super::*;

    #[test]
    fn empty_response_promoted_to_io_error() {
        let empty_gemini = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": ""}]
                }
            }]
        });
        let res = response_content(&Provider::Gemini, &empty_gemini);
        assert!(matches!(res, Err(AppError::Io(_))));

        let whitespace_gemini = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": "   \n  "}]
                }
            }]
        });
        let res = response_content(&Provider::Gemini, &whitespace_gemini);
        assert!(matches!(res, Err(AppError::Io(_))));

        let missing_parts_gemini = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": []
                }
            }]
        });
        let res = response_content(&Provider::Gemini, &missing_parts_gemini);
        assert!(matches!(res, Err(AppError::Io(_))));

        let empty_claude = serde_json::json!({
            "content": [{"text": ""}]
        });
        let res = response_content(&Provider::Claude, &empty_claude);
        assert!(matches!(res, Err(AppError::Io(_))));

        let valid_gemini = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": "Hello world"}]
                },
                "finishReason": "STOP"
            }]
        });
        assert_eq!(response_content(&Provider::Gemini, &valid_gemini).unwrap(), "Hello world");

        let truncated_gemini = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": "Cut off transcript"}]
                },
                "finishReason": "MAX_TOKENS"
            }]
        });
        let err = response_content(&Provider::Gemini, &truncated_gemini).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("truncated")), "Gemini MAX_TOKENS must be rejected: {err:?}");

        let truncated_claude = serde_json::json!({
            "content": [{"text": "Cut off text"}],
            "stop_reason": "max_tokens"
        });
        let err = response_content(&Provider::Claude, &truncated_claude).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("truncated")), "Claude max_tokens must be rejected: {err:?}");

        let truncated_openai = serde_json::json!({
            "choices": [{
                "message": {"content": "Cut off text"},
                "finish_reason": "length"
            }]
        });
        let err = response_content(&Provider::OpenAI, &truncated_openai).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("truncated")), "OpenAI length finish must be rejected: {err:?}");
    }
}

#[cfg(test)]
mod audio_payload_tests {
    use super::*;

    #[test]
    fn gemini_audio_payload_uses_inline_data_with_audio_mime_and_no_credentials() {
        let p = provider_audio_payload(&Provider::Gemini, "gemini-2.5-flash", "sys", "받아써", "QUJD", "audio/mp4").unwrap();
        let part = &p["contents"][0]["parts"][0]["inline_data"];
        assert_eq!(part["mime_type"], "audio/mp4");
        assert_eq!(part["data"], "QUJD");
        assert_eq!(p["contents"][0]["parts"][1]["text"], "받아써");
        assert!(!p.to_string().to_lowercase().contains("api_key"), "payload 에 자격이 섞이면 안 된다");
    }

    #[test]
    fn non_gemini_providers_fail_before_any_request_with_the_stable_code() {
        for provider in [Provider::OpenAI, Provider::Claude, Provider::Ollama, Provider::OpenRouter, Provider::Minimax] {
            let err = provider_audio_payload(&provider, "m", "s", "t", "QUJD", "audio/mp3").unwrap_err();
            assert!(matches!(&err, AppError::Validation(m) if m.starts_with("audio_unsupported_provider")), "{err}");
        }
    }
}

#[cfg(test)]
mod audio_transport_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn audio_client_timeout_scales_with_size_and_stays_within_deadline() {
        assert_eq!(audio_client_timeout_secs(0), 30);
        assert_eq!(audio_client_timeout_secs(500_000), 32);
        let max_inline_approx = 19 * 1024 * 1024;
        let scaled = audio_client_timeout_secs(max_inline_approx);
        assert!(scaled <= AUDIO_CLIENT_TIMEOUT_MAX_SECS);
        assert!(Duration::from_secs(scaled) < AUDIO_OPERATION_DEADLINE);
        // 클램핑: 거대 크기라도 최대 105초를 초과하지 않는다
        assert_eq!(audio_client_timeout_secs(500 * 1024 * 1024), AUDIO_CLIENT_TIMEOUT_MAX_SECS);
    }

    #[test]
    fn audio_retryable_classification() {
        let fast_429 = check_ai_status("gemini", reqwest::StatusCode::TOO_MANY_REQUESTS, "rate limited").unwrap_err();
        assert!(is_audio_retryable(&fast_429), "429 must be retryable");

        let fast_500 = check_ai_status("gemini", reqwest::StatusCode::INTERNAL_SERVER_ERROR, "server error").unwrap_err();
        assert!(is_audio_retryable(&fast_500), "5xx must be retryable");

        let timeout_err = AppError::Io("request timed out: client timeout".to_string());
        assert!(!is_audio_retryable(&timeout_err), "client timeout must never be retried for audio");

        let deadline_err = AppError::Io(DEADLINE_EXCEEDED.to_string());
        assert!(!is_audio_retryable(&deadline_err), "deadline exceeded must never be retried");

        let cancel_err = AppError::Io(CALL_CANCELLED.to_string());
        assert!(!is_audio_retryable(&cancel_err), "cancelled call must never be retried");

        let auth_err = check_ai_status("gemini", reqwest::StatusCode::UNAUTHORIZED, "bad key").unwrap_err();
        assert!(!is_audio_retryable(&auth_err), "401 must not be retried");
    }

    #[tokio::test]
    async fn audio_logged_call_retries_fast_429_but_never_client_timeout() {
        // 1. 빠른 실패(429)는 1회 재시도하여 성공한다
        let attempts_429 = Arc::new(AtomicUsize::new(0));
        let attempts_429_clone = attempts_429.clone();
        let res = logged_call(
            Some("audio_transcribe".to_string()),
            &Provider::Gemini,
            None,
            transport_no_fallback(),
            Duration::from_secs(10),
            "audio_test",
            move |_model| {
                let cnt = attempts_429_clone.fetch_add(1, Ordering::SeqCst);
                async move {
                    if cnt == 0 {
                        check_ai_status("gemini", reqwest::StatusCode::TOO_MANY_REQUESTS, "slow down")?;
                    }
                    Ok("transcribed audio".to_string())
                }
            },
        )
        .await;
        assert_eq!(res.unwrap(), "transcribed audio");
        assert_eq!(attempts_429.load(Ordering::SeqCst), 2, "429 must have triggered 1 retry");

        // 2. 클라이언트 타임아웃은 절대 재시도하지 않고 1회 시도 후 즉시 에러 반환
        let attempts_timeout = Arc::new(AtomicUsize::new(0));
        let attempts_timeout_clone = attempts_timeout.clone();
        let res = logged_call(
            Some("audio_transcribe".to_string()),
            &Provider::Gemini,
            None,
            transport_no_fallback(),
            Duration::from_secs(10),
            "audio_test",
            move |_model| {
                attempts_timeout_clone.fetch_add(1, Ordering::SeqCst);
                async move {
                    Err(AppError::Io("request timed out: operation timed out".to_string()))
                }
            },
        )
        .await;
        assert!(res.is_err());
        assert_eq!(attempts_timeout.load(Ordering::SeqCst), 1, "client timeout must never retry");
    }

    fn transport_no_fallback() -> Option<String> {
        Some(DEFAULT_GEMINI_MODEL.to_string())
    }
}

