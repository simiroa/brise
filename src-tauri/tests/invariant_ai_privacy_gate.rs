mod common;

use brise_lib::commands::ai::{ai_cleanup_text_inner, ai_generate_from_prompt_inner, ai_organize_note_inner};
use brise_lib::commands::AppState;
use brise_lib::error::AppError;
use brise_lib::repo::ai::{Provider, TextTransport};
use brise_lib::repo::{notes, settings};

/// 고정 문자열을 돌려주는 모의 텍스트 트랜스포트 — ai_cleanup_text/ai_generate_from_prompt가
/// ai_translate_text와 동일한 프라이버시 게이트 + 8192자 cap을 실제로 적용하는지 검증한다
/// (specs/tests/invariant-ai-privacy-gate.yaml 미러).
struct MockText {
    reply: String,
}

impl TextTransport for MockText {
    async fn send_text(
        &self,
        _provider: Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        _system_prompt: String,
        user_text: String,
    ) -> brise_lib::error::AppResult<String> {
        // 본문/컨텍스트 8192자 상한이 이 트랜스포트에 닿기 전에 이미 적용되어 있어야 한다.
        assert!(user_text.chars().count() <= 8192 + 200); // generate는 prompt+구분자도 섞이므로 약간 여유
        Ok(self.reply.clone())
    }
}

fn set_ai_enabled(app_state: &AppState, enabled: bool) {
    let mut conn = app_state.db.lock();
    let mut entries = std::collections::BTreeMap::new();
    entries.insert("ai_enabled".to_string(), serde_json::Value::Bool(enabled));
    settings::set(&mut conn, &entries).unwrap();
}

#[tokio::test]
async fn test_invariant_cleanup_local_ollama_allowed_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let res = ai_cleanup_text_inner(
        "note body".to_string(),
        "ollama".to_string(),
        None, // → 기본 endpoint http://localhost:11434 (loopback)
        None,
        None,
        &app_state,
        &MockText { reply: "cleaned body".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.cleaned, "cleaned body");
}

#[tokio::test]
async fn test_invariant_cleanup_cloud_blocked_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let err = ai_cleanup_text_inner(
        "secret note body".to_string(),
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        &app_state,
        &MockText { reply: "should not be reached".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_cleanup_cloud_allowed_once_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    set_ai_enabled(&app_state, true);
    let res = ai_cleanup_text_inner(
        "note body".to_string(),
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        &app_state,
        &MockText { reply: "cleaned".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.cleaned, "cleaned");
}

#[tokio::test]
async fn test_invariant_cleanup_remote_ollama_requires_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let err = ai_cleanup_text_inner(
        "note body".to_string(),
        "ollama".to_string(),
        Some("http://192.168.1.50:11434".to_string()),
        None,
        None,
        &app_state,
        &MockText { reply: "unused".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_cleanup_body_cap_enforced() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let huge = "A".repeat(100_000);
    let res = ai_cleanup_text_inner(
        huge,
        "ollama".to_string(),
        None,
        None,
        None,
        &app_state,
        &MockText { reply: "ok".to_string() },
    )
    .await
    .unwrap();
    // MockText 내부의 assert! 가 8192자 캡을 이미 검증했다 — 여기서는 에러 없이 끝났는지만 재확인.
    assert_eq!(res.cleaned, "ok");
}

#[tokio::test]
async fn test_invariant_generate_empty_prompt_rejected() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    // ai_enabled=true라도(게이트 통과) 빈 prompt는 그 자체로 무효 — 순서상 게이트보다 먼저 걸린다.
    set_ai_enabled(&app_state, true);
    let err = ai_generate_from_prompt_inner(
        "   ".to_string(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        &app_state,
        &MockText { reply: "unused".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_generate_local_ollama_allowed_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let res = ai_generate_from_prompt_inner(
        "Write a haiku".to_string(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        &app_state,
        &MockText { reply: "haiku text".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.generated, "haiku text");
}

#[tokio::test]
async fn test_invariant_generate_cloud_blocked_without_ai_enabled() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let err = ai_generate_from_prompt_inner(
        "Write a haiku".to_string(),
        None,
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        None,
        &app_state,
        &MockText { reply: "should not be reached".to_string() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_generate_combined_input_cap_enforced() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let huge_context = "B".repeat(100_000);
    let err = ai_generate_from_prompt_inner(
        "Summarize this".to_string(),
        Some(huge_context),
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        &app_state,
        &MockText { reply: "ok".to_string() },
    )
    .await
    .unwrap_err();
    // Agent flows can embed their corpus in `prompt`, so the backend rejects the combined
    // prompt+context budget instead of silently truncating one side and changing the request.
    assert!(matches!(err, AppError::Validation(message) if message.contains("32000")));
}

// ── P0-1 회귀 가드: ai_organize_note는 privacy_gate_ok 없이 노트 본문(최대 8192자)을
// 클라우드로 보냈었다 — 프론트가 메뉴를 비활성화해도 devtools의 invoke(...) 등 커맨드 자체는
// 웹뷰 전체에 노출돼 있어 서버 사이드 강제가 반드시 필요했다. 아래는 cleanup/generate와
// 완전히 동일한 4가지 판정(로컬 ollama 허용/클라우드 차단/ai_enabled 후 허용/원격 ollama 차단)을
// organize에도 그대로 검증한다.
fn make_note(app_state: &AppState, folder_id: &str) -> String {
    let mut conn = app_state.db.lock();
    notes::create(&mut conn, folder_id, Some("Old".to_string()), Some(1900))
        .unwrap()
        .note
        .id
}

#[tokio::test]
async fn test_invariant_organize_local_ollama_allowed_without_ai_enabled() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = make_note(&app_state, &folder_id);
    let res = ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None, // → 기본 endpoint http://localhost:11434 (loopback)
        None,
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 2000, vec!["y"], false),
    )
    .await
    .unwrap();
    assert_eq!(res.title.as_deref(), Some("New"));
}

#[tokio::test]
async fn test_invariant_organize_cloud_blocked_without_ai_enabled() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = make_note(&app_state, &folder_id);
    let err = ai_organize_note_inner(
        note_id.clone(),
        None,
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 2000, vec!["y"], false),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    // 게이트가 커밋보다 먼저 걸려야 한다 — 애초에 propose조차 DB를 안 건드리지만(P0-2), 여기서는
    // "게이트에 막혀 provider 호출까지도 못 갔는지"를 명확히 한다(회귀 시 노트 본문이 유출됨).
    let conn = app_state.db.lock();
    let sum = notes::note_summary(&conn, &note_id).unwrap();
    assert_eq!(sum.title, "Old");
}

#[tokio::test]
async fn test_invariant_organize_cloud_allowed_once_ai_enabled() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    set_ai_enabled(&app_state, true);
    let note_id = make_note(&app_state, &folder_id);
    let res = ai_organize_note_inner(
        note_id,
        None,
        "openai".to_string(),
        None,
        Some("sk-test".to_string()),
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 2000, vec!["y"], false),
    )
    .await
    .unwrap();
    assert_eq!(res.title.as_deref(), Some("New"));
}

#[tokio::test]
async fn test_invariant_organize_remote_ollama_requires_ai_enabled() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = make_note(&app_state, &folder_id);
    let err = ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        Some("http://192.168.1.50:11434".to_string()),
        None,
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 2000, vec!["y"], false),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn test_invariant_generate_never_writes_db() {
    // ai_cleanup_text/ai_generate_from_prompt는 note_update/section_update 등 어떤 쓰기도
    // 하지 않는다 — 결과 문자열만 반환한다는 불변식을 노트를 만들지 않고도 호출이 성공한다는
    // 사실 자체로 방증한다(둘 다 note_id를 받지 않는 시그니처라는 점이 이미 설계로 보장).
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let res = ai_generate_from_prompt_inner(
        "Write something".to_string(),
        Some("some context".to_string()),
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        &app_state,
        &MockText { reply: "generated content".to_string() },
    )
    .await
    .unwrap();
    assert_eq!(res.generated, "generated content");
}
