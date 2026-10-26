mod common;

use brise_lib::commands::ai::{
    ai_cleanup_text_inner, ai_generate_from_prompt_inner, ai_organize_note_inner,
    ai_translate_text_inner,
};
use brise_lib::commands::AppState;
use brise_lib::error::{AppError, AppResult};
use brise_lib::repo::ai::{self, Provider, TextTransport, TranslateTransport};

struct FixedTextTransport {
    reply: Result<String, String>,
}

impl TextTransport for FixedTextTransport {
    async fn send_text(
        &self,
        _provider: Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        _system_prompt: String,
        _user_text: String,
    ) -> AppResult<String> {
        self.reply
            .clone()
            .map_err(AppError::Io)
    }
}

struct FixedTranslateTransport;

impl TranslateTransport for FixedTranslateTransport {
    async fn translate(
        &self,
        _provider: Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        _text: String,
        _target_lang: String,
    ) -> AppResult<String> {
        Ok("private translated output".to_string())
    }
}

fn active_workspace_id(state: &AppState) -> String {
    let conn = state.db.lock();
    conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |row| row.get(0))
        .unwrap()
}

#[tokio::test]
async fn cleanup_success_is_audited_without_storing_the_output_body() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir);
    let workspace_id = active_workspace_id(&state);
    let sensitive_output = "private cleaned note body that must not enter audit history";

    let result = ai_cleanup_text_inner(
        "private input".to_string(),
        "ollama".to_string(),
        None,
        None,
        None,
        &state,
        &FixedTextTransport { reply: Ok(sensitive_output.to_string()) },
    )
    .await
    .unwrap();

    assert_eq!(result.cleaned, sensitive_output);
    let conn = state.db.lock();
    let history = ai::get_history(&conn, &workspace_id, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].action_type, "cleanup.succeeded");
    assert!(!history[0].result_text.contains(sensitive_output));
    assert!(history[0].result_text.contains("completed"));
}

#[tokio::test]
async fn cleanup_failure_is_audited_but_the_original_error_is_preserved() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir);
    let workspace_id = active_workspace_id(&state);
    let original = "provider unavailable: sk-1234567890abcdef";

    let error = ai_cleanup_text_inner(
        "private input".to_string(),
        "ollama".to_string(),
        None,
        None,
        None,
        &state,
        &FixedTextTransport { reply: Err(original.to_string()) },
    )
    .await
    .unwrap_err();

    assert!(matches!(error, AppError::Io(message) if message == original));
    let conn = state.db.lock();
    let history = ai::get_history(&conn, &workspace_id, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].action_type, "cleanup.failed");
    assert!(!history[0].result_text.contains("sk-1234567890abcdef"));
    assert!(history[0].result_text.contains("failed"));
}

#[tokio::test]
async fn every_ai_operation_uses_a_terminal_event_and_keeps_content_out_of_history() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let state = AppState::new(ctx.conn, ctx.data_dir);
    let workspace_id = active_workspace_id(&state);

    ai_translate_text_inner(
        "private translation input".to_string(),
        "ko".to_string(),
        "ollama".to_string(),
        None,
        None,
        None,
        &state,
        &FixedTranslateTransport,
    )
    .await
    .unwrap();
    ai_generate_from_prompt_inner(
        "Make a plan <untrusted_data>private generated context</untrusted_data> sk-1234567890abcdef".to_string(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        &state,
        &FixedTextTransport { reply: Ok("private generated output".to_string()) },
    )
    .await
    .unwrap();
    let note_id = {
        let mut conn = state.db.lock();
        brise_lib::repo::notes::create(&mut conn, &folder_id, Some("private original title".to_string()), None)
            .unwrap()
            .note
            .id
    };
    ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &state,
        &common::mock_provider(0.9, "private proposed title", 2026, vec!["private-tag"], false),
    )
    .await
    .unwrap();

    let conn = state.db.lock();
    let history = ai::get_history(&conn, &workspace_id, None).unwrap();
    for action_type in ["translate.succeeded", "generate.succeeded", "organize.proposed"] {
        assert!(history.iter().any(|item| item.action_type == action_type), "missing {action_type}");
    }
    let serialized = serde_json::to_string(&history).unwrap();
    for private_value in [
        "private translation input",
        "private translated output",
        "private generated context",
        "private generated output",
        "sk-1234567890abcdef",
        "private proposed title",
    ] {
        assert!(!serialized.contains(private_value), "audit leaked {private_value}: {serialized}");
    }
}

#[tokio::test]
async fn organize_failure_is_recorded_as_a_failed_proposal() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let state = AppState::new(ctx.conn, ctx.data_dir);
    let workspace_id = active_workspace_id(&state);
    let note_id = {
        let mut conn = state.db.lock();
        brise_lib::repo::notes::create(&mut conn, &folder_id, Some("title".to_string()), None)
            .unwrap()
            .note
            .id
    };

    let error = ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &state,
        &common::mock_provider(0.9, "unused", 2026, vec![], true),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, AppError::Validation(_)));
    let conn = state.db.lock();
    let history = ai::get_history(&conn, &workspace_id, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].action_type, "organize.failed");
}

// ── origin (collect 후처리 카드 감사 배선) ──────────────────────────────────────────────────

#[tokio::test]
async fn organize_rejects_an_unknown_origin_before_touching_the_provider() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir);

    let err = ai_organize_note_inner(
        "not-a-real-note-id".to_string(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        Some("something_else".to_string()),
        &state,
        &FixedTextTransport { reply: Ok("{}".to_string()) },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn origin_collect_post_process_is_audited_under_one_flat_action_type_on_success() {
    let ctx = common::setup();
    let folder_id = ctx.folder_id.clone();
    let state = AppState::new(ctx.conn, ctx.data_dir);
    let workspace_id = active_workspace_id(&state);
    let note_id = {
        let mut conn = state.db.lock();
        brise_lib::repo::notes::create(&mut conn, &folder_id, Some("title".to_string()), None)
            .unwrap()
            .note
            .id
    };

    ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        Some("collect_post_process".to_string()),
        &state,
        &common::mock_provider(0.9, "New", 2026, vec!["y"], false),
    )
    .await
    .unwrap();

    let conn = state.db.lock();
    // ai_history: collect_get_stats::COLLECT_ACTION_TYPES와 AiHistoryPanel의 라벨 맵 둘 다 정확히
    // 이 리터럴("collect_post_process", 점 없음)을 전제한다 — organize.proposed처럼 점 붙은
    // outcome 접미사를 쓰면 두 소비자 모두에서 조용히 집계가 빠진다.
    let history = ai::get_history(&conn, &workspace_id, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].action_type, "collect_post_process");

    // ai_usage: record_history가 같은 자리에서 UPSERT하는 누적 카운트 — collect_get_stats 카드가
    // 이 테이블을 직접 읽는다.
    let usage_calls: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(calls),0) FROM ai_usage WHERE workspace_id=?1 AND action_type='collect_post_process'",
            [&workspace_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(usage_calls, 1);
}
