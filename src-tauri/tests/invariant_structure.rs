// 불변성: 구조 규칙 — 섹션 최소 1개, 폴더 CASCADE, 첨부 파일 수명
// specs/tests/invariant-structure.yaml 1:1
mod common;
use brise_lib::error::AppError;
use brise_lib::repo::{attachments, folders, notes, sections, sources};

#[test]
fn last_section_undeletable() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let only = d.sections[0].id.clone();
    let err = sections::delete(&mut ctx.conn, &only).unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
    assert_eq!(common::count(&ctx.conn, "sections"), 1);
}

#[test]
fn folder_delete_cascades() {
    let mut ctx = common::setup();
    let f = folders::create(&mut ctx.conn, "Temp", None, None, None, None).unwrap();
    for i in 0..2 {
        let d = notes::create(&mut ctx.conn, &f.id, Some(format!("N{i}")), None).unwrap();
        sections::create(&mut ctx.conn, &d.note.id, Some("Extra".into())).unwrap();
        sources::add_text(&mut ctx.conn, &d.note.id, "s.txt", "body").unwrap();
        notes::set_tags(&mut ctx.conn, &d.note.id, vec!["t".into()]).unwrap();
        let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "a.png", b"img");
        attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap())
            .unwrap();
    }
    let deleted = folders::delete(&mut ctx.conn, &ctx.data_dir, &f.id).unwrap();
    assert_eq!(deleted, 2);
    assert_eq!(common::count(&ctx.conn, "notes"), 0);
    assert_eq!(common::count(&ctx.conn, "sections"), 0);
    assert_eq!(common::count(&ctx.conn, "sources"), 0);
    assert_eq!(common::count(&ctx.conn, "attachments"), 0);
    assert_eq!(common::count(&ctx.conn, "note_tags"), 0);
    assert_eq!(common::count(&ctx.conn, "notes_fts"), 0);
}

#[test]
fn attachment_file_copied_not_referenced() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "doc.txt", b"hello");
    let att =
        attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap())
            .unwrap();
    // 외부 원본 삭제 → 앱 데이터 사본으로도 열려야 한다.
    std::fs::remove_file(&ext).unwrap();
    let target = attachments::open(&ctx.conn, &ctx.data_dir, &att.id);
    assert!(target.is_ok());
}

// Trash: notes::delete(소프트)는 첨부 디렉토리를 보존한다(복구 시 되살아나야 하므로) —
// 완전 삭제(notes::purge, 구 notes::delete의 하드 삭제 로직)만 디렉토리를 지운다.
#[test]
fn note_purge_cleans_attachment_dir() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "x.pdf", b"pdf");
    attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap()).unwrap();
    let dir = brise_lib::db::attachments_dir(&ctx.data_dir).join(&d.note.id);
    assert!(dir.exists());
    notes::purge(&mut ctx.conn, &ctx.data_dir, &d.note.id).unwrap();
    assert!(!dir.exists());
}

// 소프트 삭제는 첨부 디렉토리를 건드리지 않는다 — 복구 가능성을 보존한다.
#[test]
fn note_delete_soft_preserves_attachment_dir() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "x.pdf", b"pdf");
    attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap()).unwrap();
    let dir = brise_lib::db::attachments_dir(&ctx.data_dir).join(&d.note.id);
    assert!(dir.exists());
    notes::delete(&mut ctx.conn, &d.note.id).unwrap();
    assert!(dir.exists(), "soft delete must preserve the attachment dir for restore");
}
