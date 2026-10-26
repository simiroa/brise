// 불변성: 노트 진행 상태(status) — 내장 상태는 삭제 불가(코드 상수), 커스텀 상태는
// 사용자가 추가/삭제 가능하고 삭제 시 참조하던 노트는 상태 없음(NULL)으로 되돌아간다.
// specs/tests/invariant-status.yaml 1:1
mod common;
use brise_lib::error::AppError;
use brise_lib::repo::{notes, taxonomy};

#[test]
fn new_note_has_no_status() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();
    assert_eq!(d.note.status, None, "a note with no status set must render cleanly (None)");
}

#[test]
fn set_and_clear_built_in_status() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();

    let updated = notes::set_status(&mut ctx.conn, &d.note.id, Some("in_progress".into())).unwrap();
    assert_eq!(updated.status, Some("in_progress".to_string()));

    let updated = notes::set_status(&mut ctx.conn, &d.note.id, Some("exported".into())).unwrap();
    assert_eq!(updated.status, Some("exported".to_string()));

    let updated = notes::set_status(&mut ctx.conn, &d.note.id, Some("done".into())).unwrap();
    assert_eq!(updated.status, Some("done".to_string()));

    // Explicit clear via None — the dedicated setter's whole point (note_update's Option<String>
    // means "omitted = unchanged" and could never express this).
    let updated = notes::set_status(&mut ctx.conn, &d.note.id, None).unwrap();
    assert_eq!(updated.status, None);
}

#[test]
fn unknown_status_rejected() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();
    let err = notes::set_status(&mut ctx.conn, &d.note.id, Some("not-a-real-status".into())).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn custom_status_add_list_remove() {
    let mut ctx = common::setup();
    let created = taxonomy::add_status(&mut ctx.conn, None, "Relecture").unwrap();
    assert_eq!(created.name, "Relecture");

    let list = taxonomy::list_statuses(&ctx.conn, None).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, created.id);

    taxonomy::remove_status(&mut ctx.conn, &created.id).unwrap();
    let list = taxonomy::list_statuses(&ctx.conn, None).unwrap();
    assert!(list.is_empty());
}

#[test]
fn custom_status_name_cannot_collide_with_builtin() {
    let mut ctx = common::setup();
    // Case-insensitive collision with a built-in key must be rejected — built-ins are code
    // constants (not removable), so a custom status must never be able to shadow one.
    let err = taxonomy::add_status(&mut ctx.conn, None, "Done").unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    let err = taxonomy::add_status(&mut ctx.conn, None, "In_Progress").unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn custom_status_name_cannot_duplicate_case_insensitively() {
    let mut ctx = common::setup();
    taxonomy::add_status(&mut ctx.conn, None, "Archivé").unwrap();
    let err = taxonomy::add_status(&mut ctx.conn, None, "archivé").unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[test]
fn removing_custom_status_clears_notes_that_reference_it() {
    let mut ctx = common::setup();
    let custom = taxonomy::add_status(&mut ctx.conn, None, "Relecture").unwrap();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();
    let updated = notes::set_status(&mut ctx.conn, &d.note.id, Some(custom.id.clone())).unwrap();
    assert_eq!(updated.status, Some(custom.id.clone()));

    taxonomy::remove_status(&mut ctx.conn, &custom.id).unwrap();

    let reloaded = notes::note_summary(&ctx.conn, &d.note.id).unwrap();
    assert_eq!(
        reloaded.status, None,
        "deleting a custom status must not leave notes with a dangling reference"
    );
}

#[test]
fn remove_unknown_status_not_found() {
    let mut ctx = common::setup();
    let err = taxonomy::remove_status(&mut ctx.conn, "nope").unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)));
}

#[test]
fn status_scoped_to_workspace() {
    // A status id that belongs to a *different* workspace must not validate for this note's
    // workspace — mirrors region/era workspace isolation (test_v8_workspace_taxonomy...).
    let mut ctx = common::setup();
    let other_ws = brise_lib::repo::workspaces::create(&mut ctx.conn, "Other").unwrap();
    let foreign_status = taxonomy::add_status(&mut ctx.conn, Some(other_ws.id.clone()), "Foreign").unwrap();

    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();
    let err = notes::set_status(&mut ctx.conn, &d.note.id, Some(foreign_status.id)).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}
