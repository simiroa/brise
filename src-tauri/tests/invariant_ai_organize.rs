mod common;

use brise_lib::commands::{ai, AppState};
use brise_lib::repo::notes;

/// P0-2 회귀 가드: ai_organize_note는 propose-only다 — DB를 절대 건드리지 않는다.
/// 커밋은 오직 ai_apply_organize(사용자가 확인 모달에서 Apply를 눌렀을 때만 호출됨)가 한다.
/// 이 테스트는 propose 직후 DB가 그대로인지, apply 이후에만 반영되는지를 각 시나리오마다
/// 명시적으로 확인한다.
#[tokio::test]
async fn test_invariant_ai_organize() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());

    let note_id = {
        let mut conn = app_state.db.lock();
        let note = notes::create(&mut conn, &ctx.folder_id, Some("Old".to_string()), Some(1900)).unwrap();
        notes::set_tags(&mut conn, &note.note.id, vec!["x".to_string()]).unwrap();
        note.note.id
    };

    // Scenario 1: propose-never-commits — even a high-confidence proposal must leave the DB
    // untouched. This is the regression guard for P0-2 (the old code auto-committed here when
    // confidence >= 0.5, before the "confirm" modal even appeared).
    let res1 = ai::ai_organize_note_inner(
        note_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 1443, vec!["hangul"], false),
    ).await.unwrap();
    assert_eq!(res1.title.as_deref(), Some("New"));
    assert_eq!(res1.year, Some(1443));
    assert_eq!(res1.tag_names, Some(vec!["hangul".to_string()]));
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.title, "Old", "propose must not commit — DB should still hold the pre-proposal value");
        assert_eq!(sum.year, 1900);
        assert_eq!(sum.tag_names, vec!["x"]);
    }

    // Scenario 2: apply-commits-the-proposal — ai_apply_organize is the ONLY path that writes,
    // and it commits exactly the values the frontend passes back from the proposal (which is
    // what the user saw and clicked Apply on).
    let apply1 = ai::ai_apply_organize_inner(
        note_id.clone(),
        res1.title.clone(),
        res1.year,
        res1.tag_names.clone(),
        res1.region.clone(),
        res1.lat,
        res1.lng,
        res1.source_urls.clone(),
        res1.folder_id.clone(),
        None,
        None,
        &app_state,
    ).unwrap();
    assert_eq!(apply1.applied.len(), 3);
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.title, "New");
        assert_eq!(sum.year, 1443);
        assert_eq!(sum.tag_names, vec!["hangul"]);
    }

    // Scenario 3: body-ignored-even-when-changed — the provider interface doesn't even return a
    // body, so this is structurally impossible; verify sections.body_md survives both propose
    // AND apply untouched.
    let res3 = ai::ai_organize_note_inner(
        note_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New2", 1444, vec!["hangul2"], false),
    ).await.unwrap();
    {
        let conn = app_state.db.lock();
        let detail = notes::note_detail(&conn, &note_id).unwrap();
        assert_eq!(detail.sections[0].body_md, "");
    }
    let apply3 = ai::ai_apply_organize_inner(
        note_id.clone(),
        res3.title.clone(),
        res3.year,
        res3.tag_names.clone(),
        res3.region.clone(),
        res3.lat,
        res3.lng,
        res3.source_urls.clone(),
        res3.folder_id.clone(),
        None,
        None,
        &app_state,
    ).unwrap();
    assert_eq!(apply3.applied.len(), 3);
    {
        let conn = app_state.db.lock();
        let detail = notes::note_detail(&conn, &note_id).unwrap();
        assert_eq!(detail.sections[0].body_md, "");
    }

    // Scenario 4: malformed-response-rejected — propose itself errors; nothing was ever
    // committed for this call (there's nothing to apply).
    let err = ai::ai_organize_note_inner(
        note_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &common::mock_provider(0.9, "New", 1443, vec!["hangul"], true),
    ).await.unwrap_err();
    assert!(matches!(err, brise_lib::error::AppError::Validation(_)));
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.title, "New2"); // unchanged from Scenario 3's apply
        assert_eq!(sum.year, 1444);
        assert_eq!(sum.tag_names, vec!["hangul2"]);
    }

    // Scenario 5: body-cap-enforced — the outbound body sent to the provider is capped at
    // 8192 chars, independent of the propose/apply split. DB stays untouched until apply runs.
    let huge_id = {
        let mut conn = app_state.db.lock();
        let note = notes::create(&mut conn, &ctx.folder_id, Some("Huge".to_string()), Some(2000)).unwrap();
        let long_body = "A".repeat(100_000);
        brise_lib::repo::sections::update(&mut conn, &note.sections[0].id, None, Some(long_body), None).unwrap();
        note.note.id
    };

    struct TruncatingMock;
    impl brise_lib::repo::ai::TextTransport for TruncatingMock {
        async fn send_text(
            &self,
            _provider: brise_lib::repo::ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            body_md: String,
        ) -> brise_lib::error::AppResult<String> {
            assert!(body_md.chars().count() <= 8192 + 20);
            assert!(body_md.ends_with("…[truncated]"));
            let proposal = brise_lib::repo::ai::AiProposal {
                title: Some("Huge".to_string()),
                year: Some(2000),
                tags: Some(vec![]),
                region: None,
                folder: None,
                lat: None,
                lng: None,
                source_urls: None,
                confidence: 0.9,
            };
            Ok(serde_json::to_string(&proposal).unwrap())
        }
    }

    let res5 = ai::ai_organize_note_inner(
        huge_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &TruncatingMock,
    ).await.unwrap();
    assert_eq!(res5.title.as_deref(), Some("Huge"));
    assert_eq!(res5.year, Some(2000));
    // Proposal happens to match the note's existing values, but that must not matter for
    // propose — it never writes regardless of whether the values would be a no-op.
    let apply5 = ai::ai_apply_organize_inner(
        huge_id.clone(),
        res5.title.clone(),
        res5.year,
        res5.tag_names.clone(),
        res5.region.clone(),
        res5.lat,
        res5.lng,
        res5.source_urls.clone(),
        res5.folder_id.clone(),
        None,
        None,
        &app_state,
    ).unwrap();
    assert!(apply5.applied.is_empty()); // title/year already equal, tags empty->empty: genuine no-op

    // Scenario 6: apply rejects an out-of-range year and the whole transaction is voided —
    // title is NOT partially applied either (single-tx invariant carried over from before the
    // propose/apply split).
    let err6 = ai::ai_apply_organize_inner(
        note_id.clone(),
        Some("ShouldFail".to_string()),
        Some(99999),
        Some(vec!["test".to_string()]),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        &app_state,
    ).unwrap_err();
    assert!(matches!(err6, brise_lib::error::AppError::Validation(_)));
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.title, "New2"); // still unchanged from Scenario 3's apply
    }
}

// ── Wave (FOLDER INFERENCE / EDITABLE METADATA PROMPT) — propose/apply integration ─────────────

/// A note-content mock that also proposes a folder by name, so the resolve-and-apply path can be
/// exercised end to end (repo/ai.rs's resolve_folder_name unit tests already cover the pure
/// matching logic in isolation).
struct FolderMock {
    folder: Option<String>,
}

impl brise_lib::repo::ai::TextTransport for FolderMock {
    async fn send_text(
        &self,
        _provider: brise_lib::repo::ai::Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        _system_prompt: String,
        _body_md: String,
    ) -> brise_lib::error::AppResult<String> {
        let proposal = brise_lib::repo::ai::AiProposal {
            title: None,
            year: None,
            tags: None,
            region: None,
            folder: self.folder.clone(),
            lat: None,
            lng: None,
            source_urls: None,
            confidence: 0.9,
        };
        Ok(serde_json::to_string(&proposal).unwrap())
    }
}

/// Folder inference end to end: propose resolves the model's chosen name against the workspace's
/// real folders, and apply moves the note through the SAME repo::notes::update path desktop's
/// "폴더로 이동" uses (proven here by relying on its folder-existence validation, which a
/// hand-rolled UPDATE would skip — see repo/notes.rs::update).
#[tokio::test]
async fn test_folder_inference_propose_resolves_and_apply_moves_via_shared_update_path() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());

    let target_folder = {
        let mut conn = app_state.db.lock();
        brise_lib::repo::folders::create(&mut conn, "Archive", None, None, None, None).unwrap()
    };
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };

    let res = ai::ai_organize_note_inner(
        note_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &FolderMock { folder: Some("Archive".to_string()) },
    ).await.unwrap();

    assert_eq!(res.folder_id.as_deref(), Some(target_folder.id.as_str()));
    assert_eq!(res.folder_name.as_deref(), Some("Archive"));

    // propose-only: DB must not have moved yet.
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.folder_id, ctx.folder_id, "propose must not move the note");
    }

    let applied = ai::ai_apply_organize_inner(
        note_id.clone(), None, None, None, None, None, None, None,
        res.folder_id.clone(),
        None,
        None,
        &app_state,
    ).unwrap();
    assert!(applied.applied.contains(&"folder".to_string()));
    let updated_at_after_move = {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.folder_id, target_folder.id, "apply must move the note to the resolved folder");
        sum.updated_at
    };

    // No-op re-apply: proposing the folder the note is ALREADY in must not be reported as
    // "applied" (specs/commands/ai.yaml's applied contract: only genuinely changed fields) and
    // must not bump updated_at — notes::update (unlike apply_ai_organize's title/year path)
    // doesn't diff before writing, so the command layer has to do it, or every no-op AI apply
    // would spuriously outrank a real edit made on another device under client-LWW sync.
    let noop_applied = ai::ai_apply_organize_inner(
        note_id.clone(), None, None, None, None, None, None, None,
        Some(target_folder.id.clone()),
        None,
        None,
        &app_state,
    ).unwrap();
    assert!(!noop_applied.applied.contains(&"folder".to_string()), "moving to the CURRENT folder must not be reported as applied");
    {
        let conn = app_state.db.lock();
        let sum = notes::note_summary(&conn, &note_id).unwrap();
        assert_eq!(sum.folder_id, target_folder.id);
        assert_eq!(sum.updated_at, updated_at_after_move, "a no-op folder apply must not bump updated_at (sync LWW)");
    }

    // Bogus folder_id: repo::notes::update validates existence (NOT_FOUND) — a hand-rolled UPDATE
    // would silently accept any string instead, which is exactly the shortcut the owner's brief
    // forbade ("do NOT hand-roll an UPDATE").
    let err = ai::ai_apply_organize_inner(
        note_id.clone(), None, None, None, None, None, None, None,
        Some("does-not-exist".to_string()),
        None,
        None,
        &app_state,
    ).unwrap_err();
    assert!(matches!(err, brise_lib::error::AppError::NotFound(_)));
}

/// "제안 없음" is a first-class outcome: the model can simply not include a folder, and no
/// folder_id/folder_name is fabricated.
#[tokio::test]
async fn test_folder_inference_no_proposal_is_valid_outcome() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };

    let res = ai::ai_organize_note_inner(
        note_id, None, "ollama".to_string(), None, None, None, None, None,
        &app_state,
        &FolderMock { folder: None },
    ).await.unwrap();

    assert_eq!(res.folder_id, None);
    assert_eq!(res.folder_name, None);
}

/// An invented/unmatched folder name is dropped server-side rather than guessed at.
#[tokio::test]
async fn test_folder_inference_unmatched_name_is_dropped_not_guessed() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };

    let res = ai::ai_organize_note_inner(
        note_id, None, "ollama".to_string(), None, None, None, None, None,
        &app_state,
        &FolderMock { folder: Some("Totally Made Up Folder".to_string()) },
    ).await.unwrap();

    assert_eq!(res.folder_id, None);
    assert_eq!(res.folder_name, None);
}

/// A mock that records the exact system_prompt string it received, so the "backend format
/// contract + user guidance" composition (repo/ai.rs::compose_organize_system_prompt) can be
/// asserted end to end through the command layer (custom_prompt param), not just at the pure
/// function level.
struct PromptCapturingMock {
    seen: std::sync::Mutex<Option<String>>,
}

impl brise_lib::repo::ai::TextTransport for PromptCapturingMock {
    async fn send_text(
        &self,
        _provider: brise_lib::repo::ai::Provider,
        _endpoint: String,
        _api_key: Option<String>,
        _model_opt: Option<String>,
        system_prompt: String,
        _body_md: String,
    ) -> brise_lib::error::AppResult<String> {
        *self.seen.lock().unwrap() = Some(system_prompt);
        let proposal = brise_lib::repo::ai::AiProposal {
            title: None, year: None, tags: None, region: None, folder: None,
            lat: None, lng: None, source_urls: None, confidence: 0.5,
        };
        Ok(serde_json::to_string(&proposal).unwrap())
    }
}

/// custom_prompt (settings "메타데이터" 프리셋) is appended as guidance — the fixed OUTPUT
/// CONTRACT (JSON field names) always survives verbatim in what's actually sent.
#[tokio::test]
async fn test_custom_prompt_is_composed_as_guidance_not_a_schema_replacement() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };
    let mock = PromptCapturingMock { seen: std::sync::Mutex::new(None) };

    ai::ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        Some("연대기적 사실을 최우선으로 판단해줘".to_string()),
        None,
        &app_state,
        &mock,
    ).await.unwrap();

    let seen = mock.seen.lock().unwrap().clone().unwrap();
    assert!(seen.contains("STRICT JSON"), "format contract must survive verbatim: {seen}");
    assert!(seen.contains("연대기적 사실을 최우선으로 판단해줘"), "custom guidance must be appended: {seen}");
}

/// Wave 1C: notebook tag vocabulary is injected into the system prompt (prefer existing tags,
/// max 3 new, total ≤6). Fresh notebook with no tags still builds a valid empty-vocab prompt.
#[tokio::test]
async fn test_tag_vocabulary_injected_into_organize_system_prompt() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());

    // Seed: two notes so "shared" is most frequent, then create the note we organize.
    let note_id = {
        let mut conn = app_state.db.lock();
        let a = notes::create(&mut conn, &ctx.folder_id, Some("A".into()), Some(1000)).unwrap();
        let b = notes::create(&mut conn, &ctx.folder_id, Some("B".into()), Some(1100)).unwrap();
        notes::set_tags(&mut conn, &a.note.id, vec!["shared".into(), "alpha".into()]).unwrap();
        notes::set_tags(&mut conn, &b.note.id, vec!["shared".into(), "beta".into()]).unwrap();
        notes::create(&mut conn, &ctx.folder_id, Some("Target".into()), Some(1200))
            .unwrap()
            .note
            .id
    };

    let mock = PromptCapturingMock {
        seen: std::sync::Mutex::new(None),
    };
    ai::ai_organize_note_inner(
        note_id.clone(),
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &mock,
    )
    .await
    .unwrap();

    let seen = mock.seen.lock().unwrap().clone().unwrap();
    assert!(seen.contains("notebook vocabulary"), "tag vocab rule must appear: {seen}");
    assert!(seen.contains("\"shared\""), "frequent tag must appear: {seen}");
    assert!(seen.contains("\"alpha\""), "{seen}");
    assert!(seen.contains("\"beta\""), "{seen}");
    assert!(seen.contains("at most 3 new tags"), "{seen}");
    assert!(seen.contains("not exceed 6 tags"), "{seen}");
}

/// Wave 1C: empty notebook (no tags yet) still produces a valid organize prompt.
#[tokio::test]
async fn test_empty_tag_vocab_still_builds_organize_prompt() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Fresh".into()), Some(1000))
            .unwrap()
            .note
            .id
    };
    let mock = PromptCapturingMock {
        seen: std::sync::Mutex::new(None),
    };
    ai::ai_organize_note_inner(
        note_id,
        None,
        "ollama".to_string(),
        None,
        None,
        None,
        None,
        None,
        &app_state,
        &mock,
    )
    .await
    .unwrap();

    let seen = mock.seen.lock().unwrap().clone().unwrap();
    assert!(seen.contains("STRICT JSON"), "contract must still be present: {seen}");
    assert!(
        seen.contains("No existing notebook tags yet"),
        "empty-vocab rule: {seen}"
    );
    assert!(!seen.contains("notebook vocabulary:"));
}

/// ai_excluded=true 폴더의 노트는 propose 단계에서 즉시 거부된다 — 모델 호출조차 나가지 않는다
/// (PromptCapturingMock이 아무것도 못 봤어야 함).
#[tokio::test]
async fn test_ai_excluded_folder_rejects_organize_before_calling_the_model() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        brise_lib::repo::folders::set_exclusions(&mut conn, &ctx.folder_id, false, true).unwrap();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };
    let mock = PromptCapturingMock { seen: std::sync::Mutex::new(None) };

    let err = ai::ai_organize_note_inner(
        note_id, None, "ollama".to_string(), None, None, None, None, None,
        &app_state,
        &mock,
    ).await.unwrap_err();

    assert!(matches!(err, brise_lib::error::AppError::Validation(_)));
    assert!(mock.seen.lock().unwrap().is_none(), "excluded folder must never reach the model");
}

/// Absent custom_prompt: existing behavior unchanged — only the fixed contract is sent (no
/// "Additional guidance" section at all).
#[tokio::test]
async fn test_absent_custom_prompt_sends_only_the_fixed_contract() {
    let ctx = common::setup();
    let app_state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = app_state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Note".to_string()), Some(1900)).unwrap().note.id
    };
    let mock = PromptCapturingMock { seen: std::sync::Mutex::new(None) };

    ai::ai_organize_note_inner(
        note_id, None, "ollama".to_string(), None, None, None, None, None,
        &app_state,
        &mock,
    ).await.unwrap();

    let seen = mock.seen.lock().unwrap().clone().unwrap();
    assert!(!seen.contains("Additional guidance"));
}
