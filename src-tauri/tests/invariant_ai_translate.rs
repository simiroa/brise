mod common;

use brise_lib::commands::ai::ai_translate_text_inner;
use brise_lib::commands::AppState;
use brise_lib::error::AppError;
use brise_lib::repo::ai::{Provider, TranslateTransport};
use brise_lib::repo::settings;

/// 고정 문자열을 돌려주는 모의 번역 트랜스포트 — 호출 인자를 기록해 프라이버시 게이트/캡이
/// 실제로 적용됐는지 검증한다.
struct MockTranslate {
    reply: String,
}

impl TranslateTransport for MockTranslate {
    async fn translate(
        &self,
        _provider: Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        text: String,
        _target_lang: String,
    ) -> brise_lib::error::AppResult<String> {
        // 본문 8192자 상한(+ 절단 표시자)이 이 트랜스포트에 닿기 전에 이미 적용되어 있어야 한다.
        assert!(text.chars().count() <= 8192 + 20);
        Ok(self.reply.clone())
    }
}

#[tokio::test]
async fn test_invariant_ai_translate_local_ollama_allowed_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    // ai_enabled 는 기본값 false (default_settings) — 로컬 loopback ollama 는 그래도 허용되어야 한다.
    let res = ai_translate_text_inner(
        "Bonjour le monde".to_string(),
        "en".to_string(),
        "ollama".to_string(),
        None, // → 기본 endpoint http://localhost:11434 (loopback)
        None,
        None,
        &app_state,
        &MockTranslate { reply: "Hello world".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.translated, "Hello world");
}

#[tokio::test]
async fn test_invariant_ai_translate_cloud_blocked_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    // ai_enabled=false(기본) 상태에서 클라우드 프로바이더는 거부되어야 한다 — 노트 본문이
    // 사용자 동의 없이 제3자로 나가는 것을 막는 R11 프라이버시 게이트.
    let err = ai_translate_text_inner(
        "secret note content".to_string(),
        "fr".to_string(),
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        &app_state,
        &MockTranslate { reply: "should not be reached".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_ai_translate_cloud_allowed_once_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    {
        let mut conn = app_state.db.lock();
        let mut entries = std::collections::BTreeMap::new();
        entries.insert("ai_enabled".to_string(), serde_json::Value::Bool(true));
        settings::set(&mut conn, &entries).unwrap();
    }
    let res = ai_translate_text_inner(
        "note content".to_string(),
        "fr".to_string(),
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        &app_state,
        &MockTranslate { reply: "contenu de la note".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.translated, "contenu de la note");
}

#[tokio::test]
async fn test_invariant_ai_translate_remote_ollama_requires_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    // ollama 라도 loopback 이 아닌(원격) 엔드포인트면 클라우드와 동일하게 ai_enabled 를 요구한다.
    let err = ai_translate_text_inner(
        "note content".to_string(),
        "en".to_string(),
        "ollama".to_string(),
        Some("http://192.168.1.50:11434".to_string()),
        None,
        None,
        &app_state,
        &MockTranslate { reply: "unused".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_ai_translate_body_cap_enforced() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let huge = "A".repeat(100_000);
    let res = ai_translate_text_inner(
        huge,
        "en".to_string(),
        "ollama".to_string(),
        None,
        None,
        None,
        &app_state,
        &MockTranslate { reply: "ok".to_string() },
    )
    .await
    .unwrap();
    // MockTranslate 내부의 assert! 가 8192자 캡을 이미 검증했다 — 여기서는 호출 자체가
    // 에러 없이 끝났는지(=캡이 VALIDATION 이 아니라 truncation 으로 처리됐는지)만 재확인.
    assert_eq!(res.translated, "ok");
}
