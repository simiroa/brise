mod common;

use brise_lib::commands::{ai, AppState};
use brise_lib::repo::{attachments, notes};

fn action(action_id: &str, kind: ai::AiPlanActionKind, payload: ai::AiPlanActionPayload) -> ai::AiPlanAction {
    ai::AiPlanAction { action_id: action_id.to_string(), kind, payload }
}

fn approved_scope(state: &AppState, folder_ids: Vec<String>, note_ids: &[String]) -> (String, ai::AiPlanScope) {
    let conn = state.db.lock();
    let workspace_id: String = conn.query_row(
        "SELECT workspace_id FROM folders WHERE id=?1", [&folder_ids[0]], |row| row.get(0),
    ).unwrap();
    let mut scope = ai::AiPlanScope { folder_ids, ..Default::default() };
    for note_id in note_ids {
        let summary = notes::note_summary(&conn, note_id).unwrap();
        scope.note_revisions.insert(note_id.clone(), summary.updated_at);
        scope.note_folder_ids.insert(note_id.clone(), summary.folder_id);
    }
    (workspace_id, scope)
}

/// A rejected metadata proposal is all-or-nothing: title/tags/links must not leak through
/// before a later validation failure (here an invalid coordinate pair) is reported.
#[test]
fn apply_organize_rolls_back_every_field_when_any_field_is_invalid() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = state.db.lock();
        let note = notes::create(&mut conn, &ctx.folder_id, Some("Before".into()), Some(1900)).unwrap();
        notes::set_tags(&mut conn, &note.note.id, vec!["old".into()]).unwrap();
        note.note.id
    };

    let err = ai::ai_apply_organize_inner(
        note_id.clone(), Some("After".into()), None, Some(vec!["new".into()]),
        Some("Seoul".into()), Some(91.0), Some(127.0),
        Some(vec!["https://example.test/source".into()]), None, None, None, &state,
    ).unwrap_err();
    assert!(matches!(err, brise_lib::error::AppError::Validation(_)));

    let conn = state.db.lock();
    let note = notes::note_summary(&conn, &note_id).unwrap();
    assert_eq!(note.title, "Before");
    assert_eq!(note.tag_names, vec!["old"]);
    assert_eq!(note.region, None);
    assert!(attachments::load_for_note(&conn, &note_id).unwrap().is_empty());
}

/// Link suggestions are a set, including URLs that already existed before the AI apply.
#[test]
fn apply_organize_deduplicates_source_urls() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = state.db.lock();
        let note = notes::create(&mut conn, &ctx.folder_id, Some("Note".into()), Some(1900)).unwrap();
        attachments::add_link(&mut conn, &note.note.id, "https://example.test/a", "https://example.test/a").unwrap();
        note.note.id
    };

    let applied = ai::ai_apply_organize_inner(
        note_id.clone(), None, None, None, None, None, None,
        Some(vec!["https://example.test/a".into(), "https://example.test/a".into(), "https://example.test/b".into()]),
        None, None, None, &state,
    ).unwrap();
    assert_eq!(applied.applied, vec!["attachments"]);

    let conn = state.db.lock();
    let links = attachments::load_for_note(&conn, &note_id).unwrap();
    assert_eq!(links.iter().filter_map(|a| a.url.as_deref()).collect::<Vec<_>>(), vec!["https://example.test/a", "https://example.test/b"]);
}

/// A merge validates every input before it mutates. An invalid destination cannot leave a
/// partial merged note or trash either source.
#[test]
fn plan_merge_failure_leaves_sources_and_no_partial_merge() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let (left, right) = {
        let mut conn = state.db.lock();
        let left = notes::create(&mut conn, &ctx.folder_id, Some("Left".into()), Some(1900)).unwrap().note.id;
        let right = notes::create(&mut conn, &ctx.folder_id, Some("Right".into()), Some(1900)).unwrap().note.id;
        (left, right)
    };

    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[left.clone(), right.clone()]);
    let results = ai::ai_apply_plan_inner(
        workspace_id, scope, "execution-merge-fail".into(),
        vec![action("merge-1", ai::AiPlanActionKind::MergeNotes, ai::AiPlanActionPayload {
            source_note_ids: Some(vec![left.clone(), right.clone()]),
            title: Some("Merged".into()), body_md: Some("Combined".into()),
            folder_id: Some("missing-folder".into()), ..Default::default()
        })], &state,
    ).unwrap();
    assert_eq!(results[0].status, ai::AiPlanActionStatus::Failed);

    let conn = state.db.lock();
    let left_deleted: Option<String> = conn.query_row("SELECT deleted_at FROM notes WHERE id=?1", [&left], |r| r.get(0)).unwrap();
    let right_deleted: Option<String> = conn.query_row("SELECT deleted_at FROM notes WHERE id=?1", [&right], |r| r.get(0)).unwrap();
    assert!(left_deleted.is_none());
    assert!(right_deleted.is_none());
    let merged: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title='Merged'", [], |r| r.get(0)).unwrap();
    assert_eq!(merged, 0);
}

/// Retrying the same client-generated execution/action pair never creates a second note.
#[test]
fn plan_action_retry_is_idempotent() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let request = || vec![action("create-1", ai::AiPlanActionKind::CreateNote, ai::AiPlanActionPayload {
        folder_id: Some(ctx.folder_id.clone()), title: Some("Created once".into()), body_md: Some("Body".into()), ..Default::default()
    })];

    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[]);
    let first = ai::ai_apply_plan_inner(workspace_id.clone(), scope.clone(), "execution-retry".into(), request(), &state).unwrap();
    assert_eq!(first[0].status, ai::AiPlanActionStatus::Applied);
    let created_id = first[0].note_id.clone().unwrap();
    let second = ai::ai_apply_plan_inner(workspace_id, scope, "execution-retry".into(), request(), &state).unwrap();
    assert_eq!(second[0].status, ai::AiPlanActionStatus::AlreadyApplied);
    assert_eq!(second[0].note_id.as_deref(), Some(created_id.as_str()));

    let conn = state.db.lock();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title='Created once'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

/// Failed receipts are audit records, not a permanent lock. An identical payload can retry after
/// a transient external failure is removed; a corrected payload must use a new action id.
#[test]
fn failed_plan_action_can_retry_with_the_identical_payload_after_transient_failure() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    {
        let conn = state.db.lock();
        conn.execute(
            "CREATE TRIGGER fail_first_retry BEFORE INSERT ON ai_plan_action_receipts
             WHEN NEW.execution_id = 'execution-failed-retry' AND NEW.status = 'applied'
             BEGIN SELECT RAISE(ABORT, 'temporary receipt failure'); END;",
            [],
        ).unwrap();
    }
    let request = || vec![action("create-retry", ai::AiPlanActionKind::CreateNote, ai::AiPlanActionPayload {
        folder_id: Some(ctx.folder_id.clone()), title: Some("Recovered".into()), body_md: Some("Now valid".into()), ..Default::default()
    })];
    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[]);
    let failed = ai::ai_apply_plan_inner(workspace_id.clone(), scope.clone(), "execution-failed-retry".into(), request(), &state).unwrap();
    assert_eq!(failed[0].status, ai::AiPlanActionStatus::Failed);
    {
        let conn = state.db.lock();
        conn.execute("DROP TRIGGER fail_first_retry", []).unwrap();
    }
    let recovered = ai::ai_apply_plan_inner(workspace_id, scope, "execution-failed-retry".into(), request(), &state).unwrap();
    assert_eq!(recovered[0].status, ai::AiPlanActionStatus::Applied);
    let conn = state.db.lock();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title='Recovered'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

/// Plan mutations preserve the same activity semantics as the standard note commands: a merge
/// creates one note event and soft-deleting each source records a separate delete event.
#[test]
fn plan_merge_records_create_and_source_delete_activity() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let (left, right) = {
        let mut conn = state.db.lock();
        let left = notes::create(&mut conn, &ctx.folder_id, Some("Activity left".into()), Some(1900)).unwrap().note.id;
        let right = notes::create(&mut conn, &ctx.folder_id, Some("Activity right".into()), Some(1900)).unwrap().note.id;
        (left, right)
    };
    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[left.clone(), right.clone()]);
    let results = ai::ai_apply_plan_inner(
        workspace_id, scope, "execution-activity".into(),
        vec![action("merge-activity", ai::AiPlanActionKind::MergeNotes, ai::AiPlanActionPayload {
            source_note_ids: Some(vec![left.clone(), right.clone()]),
            title: Some("Activity merge".into()), body_md: Some("Merged body".into()),
            folder_id: Some(ctx.folder_id.clone()), ..Default::default()
        })], &state,
    ).unwrap();
    let merged_id = results[0].note_id.as_ref().unwrap();
    let conn = state.db.lock();
    let events: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT kind, note_id FROM activity_log ORDER BY created_at ASC").unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert!(events.iter().any(|(kind, id)| kind == "create" && id.as_deref() == Some(merged_id)));
    assert!(events.iter().any(|(kind, id)| kind == "delete" && id.as_deref() == Some(left.as_str())));
    assert!(events.iter().any(|(kind, id)| kind == "delete" && id.as_deref() == Some(right.as_str())));
}

/// A receipt is bound to the exact approved payload. Reusing an action id with different content
/// must be rejected, not interpreted as an idempotent retry.
#[test]
fn plan_receipt_rejects_a_changed_payload() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[]);
    let first = vec![action("same-action", ai::AiPlanActionKind::CreateNote, ai::AiPlanActionPayload {
        folder_id: Some(ctx.folder_id.clone()), title: Some("Original".into()), body_md: Some("A".into()), ..Default::default()
    })];
    ai::ai_apply_plan_inner(workspace_id.clone(), scope.clone(), "execution-hash".into(), first, &state).unwrap();
    let changed = vec![action("same-action", ai::AiPlanActionKind::CreateNote, ai::AiPlanActionPayload {
        folder_id: Some(ctx.folder_id.clone()), title: Some("Changed".into()), body_md: Some("B".into()), ..Default::default()
    })];
    let err = ai::ai_apply_plan_inner(workspace_id, scope, "execution-hash".into(), changed, &state).unwrap_err();
    assert!(matches!(err, brise_lib::error::AppError::Conflict(_)));
}

/// Revisions are rechecked in the write transaction. A note edited after review is returned as
/// failed/stale, and the approved plan never overwrites that edit.
#[test]
fn stale_plan_update_is_failed_without_overwriting_the_note() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = state.db.lock();
        notes::create(&mut conn, &ctx.folder_id, Some("Before".into()), Some(1900)).unwrap().note.id
    };
    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[note_id.clone()]);
    {
        let conn = state.db.lock();
        // Use an explicit later revision instead of relying on millisecond clock resolution.
        conn.execute(
            "UPDATE notes SET title='User changed this', updated_at='2999-01-01T00:00:00.000Z' WHERE id=?1",
            [&note_id],
        ).unwrap();
    }
    let result = ai::ai_apply_plan_inner(
        workspace_id, scope, "execution-stale".into(),
        vec![action("update-stale", ai::AiPlanActionKind::UpdateNote, ai::AiPlanActionPayload {
            note_id: Some(note_id.clone()), title: Some("AI overwrite".into()), ..Default::default()
        })], &state,
    ).unwrap();
    assert_eq!(result[0].status, ai::AiPlanActionStatus::Failed);
    assert!(result[0].error.as_deref().is_some_and(|message| message.contains("stale")));
    let conn = state.db.lock();
    assert_eq!(notes::note_summary(&conn, &note_id).unwrap().title, "User changed this");
}

/// A late SQL failure after title/tag work has begun rolls every metadata write back. This guards
/// the transaction boundary itself rather than only an early validation branch.
#[test]
fn organize_late_attachment_failure_rolls_back_prior_metadata() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let note_id = {
        let mut conn = state.db.lock();
        let note = notes::create(&mut conn, &ctx.folder_id, Some("Original".into()), Some(1900)).unwrap();
        notes::set_tags(&mut conn, &note.note.id, vec!["old".into()]).unwrap();
        conn.execute(
            "CREATE TRIGGER abort_ai_link BEFORE INSERT ON attachments
             WHEN NEW.url = 'https://example.test/late-failure'
             BEGIN SELECT RAISE(ABORT, 'forced attachment failure'); END;",
            [],
        ).unwrap();
        note.note.id
    };
    assert!(ai::ai_apply_organize_inner(
        note_id.clone(), Some("Must not persist".into()), None, Some(vec!["new".into()]),
        None, None, None, Some(vec!["https://example.test/late-failure".into()]), None, None, None, &state,
    ).is_err());
    let conn = state.db.lock();
    let note = notes::note_summary(&conn, &note_id).unwrap();
    assert_eq!(note.title, "Original");
    assert_eq!(note.tag_names, vec!["old"]);
}

/// Receipt insertion is deliberately inside the merge transaction. A failure there must leave
/// both sources live and no destination note, even though the destination was created first.
#[test]
fn merge_receipt_failure_rolls_back_destination_and_source_deletes() {
    let ctx = common::setup();
    let state = AppState::new(ctx.conn, ctx.data_dir.clone());
    let (left, right) = {
        let mut conn = state.db.lock();
        let left = notes::create(&mut conn, &ctx.folder_id, Some("Receipt left".into()), Some(1900)).unwrap().note.id;
        let right = notes::create(&mut conn, &ctx.folder_id, Some("Receipt right".into()), Some(1900)).unwrap().note.id;
        conn.execute(
            "CREATE TRIGGER abort_plan_receipt BEFORE INSERT ON ai_plan_action_receipts
             WHEN NEW.execution_id = 'execution-receipt-failure' AND NEW.status = 'applied'
             BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END;",
            [],
        ).unwrap();
        (left, right)
    };
    let (workspace_id, scope) = approved_scope(&state, vec![ctx.folder_id.clone()], &[left.clone(), right.clone()]);
    let result = ai::ai_apply_plan_inner(
        workspace_id, scope, "execution-receipt-failure".into(),
        vec![action("merge-receipt", ai::AiPlanActionKind::MergeNotes, ai::AiPlanActionPayload {
            source_note_ids: Some(vec![left.clone(), right.clone()]), title: Some("Receipt merge".into()),
            body_md: Some("Body".into()), folder_id: Some(ctx.folder_id.clone()), ..Default::default()
        })], &state,
    ).unwrap();
    assert_eq!(result[0].status, ai::AiPlanActionStatus::Failed);
    let conn = state.db.lock();
    let live_sources: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE id IN (?1, ?2) AND deleted_at IS NULL", [&left, &right], |row| row.get(0)).unwrap();
    let merged: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title='Receipt merge'", [], |row| row.get(0)).unwrap();
    assert_eq!(live_sources, 2);
    assert_eq!(merged, 0);
}
