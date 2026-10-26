// 불변성: 워크스페이스 격리와 안전 삭제
// specs/tests/invariant-workspaces.yaml 1:1
mod common;
use brise_lib::error::AppError;
use brise_lib::repo::{folders, notes, settings, taxonomy, workspaces};

#[test]
fn isolation_folder_list() {
    let mut ctx = common::setup();
    // A = 기본 워크스페이스 (ctx.folder_id 는 A 의 기본 폴더).
    let a_id = folders::active_workspace_id(&ctx.conn).unwrap();
    notes::create(&mut ctx.conn, &ctx.folder_id, Some("A-note".into()), None).unwrap();

    let b = workspaces::create(&mut ctx.conn, "B").unwrap();
    let b_folder_id = folders::list(&ctx.conn, Some(b.id.clone())).unwrap().folders[0]
        .id
        .clone();
    notes::create(&mut ctx.conn, &b_folder_id, Some("B-note".into()), None).unwrap();

    let a_list = folders::list(&ctx.conn, Some(a_id)).unwrap();
    assert!(a_list.folders.iter().all(|f| f.id != b_folder_id));
    assert!(!a_list
        .notes_by_folder
        .values()
        .flatten()
        .any(|n| n.title == "B-note"));

    let b_list = folders::list(&ctx.conn, Some(b.id)).unwrap();
    assert!(!b_list
        .notes_by_folder
        .values()
        .flatten()
        .any(|n| n.title == "A-note"));
}

#[test]
fn last_workspace_undeletable() {
    let mut ctx = common::setup();
    let a_id = folders::active_workspace_id(&ctx.conn).unwrap();
    let err = workspaces::delete(&mut ctx.conn, &ctx.data_dir, &a_id).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    assert_eq!(common::count(&ctx.conn, "workspaces"), 1);
}

#[test]
fn delete_cascades_and_cleans_fts() {
    let mut ctx = common::setup();
    let b = workspaces::create(&mut ctx.conn, "B").unwrap();
    let b_folder_id = folders::list(&ctx.conn, Some(b.id.clone())).unwrap().folders[0]
        .id
        .clone();
    let mut note_ids = Vec::new();
    for i in 0..2 {
        let d = notes::create(&mut ctx.conn, &b_folder_id, Some(format!("B{i}")), None).unwrap();
        assert!(common::fts_has(&ctx.conn, &d.note.id));
        note_ids.push(d.note.id.clone());
    }

    let deleted = workspaces::delete(&mut ctx.conn, &ctx.data_dir, &b.id).unwrap();
    assert_eq!(deleted, 2);

    for nid in &note_ids {
        assert!(!common::fts_has(&ctx.conn, nid));
    }
    assert_eq!(common::count(&ctx.conn, "notes"), 0);
    assert_eq!(common::count(&ctx.conn, "sections"), 0);
    assert_eq!(common::count(&ctx.conn, "notes_fts"), 0);
}

#[test]
fn delete_active_falls_back() {
    let mut ctx = common::setup();
    let a_id = folders::active_workspace_id(&ctx.conn).unwrap();
    let b = workspaces::create(&mut ctx.conn, "B").unwrap();

    let mut entries = std::collections::BTreeMap::new();
    entries.insert(
        "active_workspace_id".to_string(),
        serde_json::json!(b.id.clone()),
    );
    settings::set(&mut ctx.conn, &entries).unwrap();
    assert_eq!(folders::active_workspace_id(&ctx.conn).unwrap(), b.id);

    workspaces::delete(&mut ctx.conn, &ctx.data_dir, &b.id).unwrap();

    assert_eq!(folders::active_workspace_id(&ctx.conn).unwrap(), a_id);
    // folder_list() 정상 동작 (활성 워크스페이스 폴백 반영).
    let list = folders::list(&ctx.conn, None).unwrap();
    assert!(!list.folders.is_empty());
}

#[test]
fn create_seeds_default_folder() {
    let mut ctx = common::setup();
    let c = workspaces::create(&mut ctx.conn, "C").unwrap();
    let list = folders::list(&ctx.conn, Some(c.id)).unwrap();
    assert_eq!(list.folders.len(), 1);
    assert_eq!(list.folders[0].name, "Notes");
}

// Wave 13: 배경 이미지 설정 → 교체(고아 정리) → 해제. 실제 파일 시스템 상태(workspace_bg/{id}/
// 안의 파일 개수)까지 검증해 "교체 시 이전 파일이 정리되는지"를 눈속임 없이 확인한다.
#[test]
fn bg_image_set_replace_and_clear() {
    let mut ctx = common::setup();
    let e = workspaces::create(&mut ctx.conn, "E").unwrap();
    assert_eq!(e.bg_image_path, None);

    let external = ctx.tmp.path().join("external");
    let file1 = common::make_external_file(&external, "one.png", b"one");
    let file2 = common::make_external_file(&external, "two.jpg", b"two-two");

    let updated = workspaces::set_bg_image(
        &mut ctx.conn,
        &ctx.data_dir,
        &e.id,
        file1.to_str().unwrap(),
    )
    .unwrap();
    assert!(updated.bg_image_path.is_some());
    let ws_bg_dir = brise_lib::db::workspace_bg_dir(&ctx.data_dir).join(&e.id);
    assert_eq!(count_files(&ws_bg_dir), 1);

    let updated2 = workspaces::set_bg_image(
        &mut ctx.conn,
        &ctx.data_dir,
        &e.id,
        file2.to_str().unwrap(),
    )
    .unwrap();
    assert_ne!(updated.bg_image_path, updated2.bg_image_path);
    // 교체 후에는 이전 파일이 정리되어 정확히 1개만 남는다 (고아 없음).
    assert_eq!(count_files(&ws_bg_dir), 1);

    let cleared = workspaces::clear_bg_image(&mut ctx.conn, &ctx.data_dir, &e.id).unwrap();
    assert_eq!(cleared.bg_image_path, None);
    assert_eq!(count_files(&ws_bg_dir), 0);
}

// Wave 13: 워크스페이스 삭제 시 배경 이미지 디렉토리도 정리되어야 한다 — attachments/ 와
// 분리된 루트(workspace_bg/)라 workspaces::delete 가 이를 명시적으로 지워야 한다.
#[test]
fn bg_image_cleanup_on_delete() {
    let mut ctx = common::setup();
    let f = workspaces::create(&mut ctx.conn, "F").unwrap();
    let external = ctx.tmp.path().join("external");
    let file = common::make_external_file(&external, "bg.png", b"bg-bytes");
    workspaces::set_bg_image(&mut ctx.conn, &ctx.data_dir, &f.id, file.to_str().unwrap()).unwrap();

    let ws_bg_dir = brise_lib::db::workspace_bg_dir(&ctx.data_dir).join(&f.id);
    assert!(ws_bg_dir.exists());

    workspaces::delete(&mut ctx.conn, &ctx.data_dir, &f.id).unwrap();
    assert!(!ws_bg_dir.exists());
}

// Wave 14: 사용자 확장 지역 — 추가 시 트림되고, 목록에 순서(position)대로 나타난다.
#[test]
fn region_add_list_roundtrip() {
    let mut ctx = common::setup();
    let g = workspaces::create(&mut ctx.conn, "G").unwrap();
    let added = taxonomy::add_region(&mut ctx.conn, Some(g.id.clone()), "  Sokcho  ").unwrap();
    assert_eq!(added.name, "Sokcho");
    assert_eq!(added.position, 0);

    let list = taxonomy::list_regions(&ctx.conn, Some(g.id)).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Sokcho");
}

// Wave 14: 같은 워크스페이스 안에서 대소문자만 다른 이름은 중복으로 거부된다.
#[test]
fn region_add_duplicate_rejected() {
    let mut ctx = common::setup();
    let g = workspaces::create(&mut ctx.conn, "G").unwrap();
    taxonomy::add_region(&mut ctx.conn, Some(g.id.clone()), "Sokcho").unwrap();
    let err = taxonomy::add_region(&mut ctx.conn, Some(g.id), "sokcho").unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

// Wave 14: 지역은 워크스페이스 스코프 — 다른 워크스페이스에 추가한 지역이 새어나오지 않는다.
#[test]
fn region_scoped_per_workspace() {
    let mut ctx = common::setup();
    let g = workspaces::create(&mut ctx.conn, "G").unwrap();
    let h = workspaces::create(&mut ctx.conn, "H").unwrap();
    taxonomy::add_region(&mut ctx.conn, Some(h.id), "Sokcho").unwrap();

    let g_list = taxonomy::list_regions(&ctx.conn, Some(g.id)).unwrap();
    assert!(g_list.is_empty());
}

// Wave 14: 지역 제거는 목록에서만 사라진다 — 그 지역명을 이미 쓰고 있던 노트의 region 은
// 독립 자유 텍스트 컬럼이라 그대로 남아야 한다(노트 손상 방지, owner 결정).
#[test]
fn region_remove_does_not_corrupt_notes() {
    let mut ctx = common::setup();
    let region = taxonomy::add_region(&mut ctx.conn, None, "Temp").unwrap();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("N".into()), None).unwrap();
    notes::set_region(&mut ctx.conn, &d.note.id, Some("Temp".into())).unwrap();

    taxonomy::remove_region(&mut ctx.conn, &region.id).unwrap();

    let detail = notes::note_detail(&ctx.conn, &d.note.id).unwrap();
    assert_eq!(detail.note.region.as_deref(), Some("Temp"));
    let remaining = taxonomy::list_regions(&ctx.conn, None).unwrap();
    assert!(remaining.is_empty());
}

// Wave 14: 사용자 확장 시대 — to_year <= from_year 는 거부된다.
#[test]
fn era_add_validates_range() {
    let mut ctx = common::setup();
    let err = taxonomy::add_era(&mut ctx.conn, None, "Test Era", 1500, 1400).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn era_add_list_roundtrip() {
    let mut ctx = common::setup();
    taxonomy::add_era(&mut ctx.conn, None, "Test Era", 1400, 1500).unwrap();
    let list = taxonomy::list_eras(&ctx.conn, None).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Test Era");
    assert_eq!(list[0].from_year, 1400);
    assert_eq!(list[0].to_year, 1500);
}

// Wave 14: 워크스페이스 삭제 시 그 워크스페이스가 추가한 지역/시대도 CASCADE로 함께 사라진다
// (고아 방지 — migrations.rs V8_SQL ON DELETE CASCADE).
#[test]
fn taxonomy_cascade_on_workspace_delete() {
    let mut ctx = common::setup();
    let g = workspaces::create(&mut ctx.conn, "G").unwrap();
    taxonomy::add_region(&mut ctx.conn, Some(g.id.clone()), "X").unwrap();
    taxonomy::add_era(&mut ctx.conn, Some(g.id.clone()), "Y", 1, 2).unwrap();

    workspaces::delete(&mut ctx.conn, &ctx.data_dir, &g.id).unwrap();

    let region_count: i64 = ctx
        .conn
        .query_row(
            "SELECT COUNT(*) FROM workspace_regions WHERE workspace_id=?1",
            [&g.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(region_count, 0);
    let era_count: i64 = ctx
        .conn
        .query_row(
            "SELECT COUNT(*) FROM workspace_eras WHERE workspace_id=?1",
            [&g.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(era_count, 0);
}

fn count_files(dir: &std::path::Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir).unwrap().count()
}
