// 불변성: 2글자 색인(notes_bigram + notes_bigram_map)은 항상 notes_fts 에서 파생된 그대로다.
// invariant_fts_sync.rs 와 같은 모양 — repo 계층을 거친 쓰기마다(fts.rs 의 네 작성 함수) 색인이 맞는지,
// 그리고 V94 백필이 처음부터 다시 만든 것과 같은지. 설계: specs/db/schemas/fts_bigram.sql.
// V95 부터 매핑 표는 notes_fts 의 모든 행을 rowid 그대로 가리킨다(질문 검색 3자 이상 경로가 쓴다).
mod common;
use brise_lib::repo::{fts, notes, sections, sources};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

/// 색인에서 2글자 낱말 하나로 찾은 note_id 집합(작업 공간·휴지통 필터 없이 — 색인 자체를 본다).
fn index_lookup(conn: &Connection, gram: &str) -> BTreeSet<String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.note_id FROM notes_bigram b JOIN notes_bigram_map m ON m.id = b.rowid
             WHERE notes_bigram MATCH ?1",
        )
        .unwrap();
    let rows = stmt
        .query_map([format!("\"{gram}\"")], |r| r.get::<_, String>(0))
        .unwrap();
    rows.map(Result::unwrap).collect()
}

/// notes_fts 가 말하는 정답: 낱말 → 그 낱말을 2글자 창으로 가진 note_id 집합.
fn expected_from_fts(conn: &Connection) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT note_id, title, body, source_body, tag_names FROM notes_fts")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, [r.get::<_, String>(1)?, r.get(2)?, r.get(3)?, r.get(4)?]))
        })
        .unwrap();
    for row in rows {
        let (id, cols) = row.unwrap();
        let mut grams = BTreeSet::new();
        for c in &cols {
            fts::bigrams_into(c, &mut grams);
        }
        for g in grams {
            out.entry(g).or_default().insert(id.clone());
        }
    }
    out
}

/// 색인 == notes_fts 파생. `extra` 는 지금은 어디에도 없어야 하는 낱말(지워진 옛 창 등).
fn assert_index_matches_fts(conn: &Connection, extra: &[&str]) {
    let expected = expected_from_fts(conn);
    for (gram, ids) in &expected {
        assert_eq!(&index_lookup(conn, gram), ids, "낱말 {gram:?}");
    }
    for g in extra {
        let want = expected.get(*g).cloned().unwrap_or_default();
        assert_eq!(index_lookup(conn, g), want, "옛 낱말 {g:?} 이 색인에 남았다");
    }
    // 매핑 행 == notes_fts 의 (rowid, note_id) 전부 — 창이 없는 행도(V95).
    let pairs = |sql: &str| -> BTreeSet<(i64, String)> {
        let mut st = conn.prepare(sql).unwrap();
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.map(Result::unwrap).collect()
    };
    assert_eq!(
        pairs("SELECT id, note_id FROM notes_bigram_map"),
        pairs("SELECT rowid, note_id FROM notes_fts"),
        "매핑 표 == notes_fts (rowid, note_id)"
    );
    // 색인 행 = 창이 하나라도 있는 노트, 그리고 전부 매핑이 있다(고아 없음).
    let with_grams: BTreeSet<String> = expected.values().flatten().cloned().collect();
    assert_eq!(common::count(conn, "notes_bigram"), with_grams.len() as i64, "색인 행 수");
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes_bigram b WHERE b.rowid NOT IN (SELECT id FROM notes_bigram_map)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphans, 0, "매핑 없는 색인 행");
}

fn note(ctx: &mut common::Ctx, title: &str, body: &str) -> String {
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some(title.into()), Some(2026)).unwrap();
    sections::update(&mut ctx.conn, &d.sections[0].id, None, Some(body.into()), None).unwrap();
    d.note.id
}

#[test]
fn create_indexes_the_note() {
    let mut ctx = common::setup();
    let id = note(&mut ctx, "부산 여행", "커피값만 9월에 10km");
    for g in ["부산", "여행", "커피", "피값", "값만", "9월", "월에", "10", "0k", "km"] {
        assert!(index_lookup(&ctx.conn, g).contains(&id), "{g}");
    }
    assert_index_matches_fts(&ctx.conn, &[]);
}

#[test]
fn body_edit_replaces_old_windows() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("메모".into()), Some(2026)).unwrap();
    let sec = d.sections[0].id.clone();
    sections::update(&mut ctx.conn, &sec, None, Some("해운대 바다".into()), None).unwrap();
    assert!(index_lookup(&ctx.conn, "해운").contains(&d.note.id));
    sections::update(&mut ctx.conn, &sec, None, Some("광안리 야경".into()), None).unwrap();
    assert!(!index_lookup(&ctx.conn, "해운").contains(&d.note.id), "옛 본문 창은 빠져야");
    assert!(index_lookup(&ctx.conn, "광안").contains(&d.note.id));
    assert_index_matches_fts(&ctx.conn, &["해운", "운대", "바다"]);
}

#[test]
fn title_only_update_fast_path_keeps_index_in_sync() {
    let mut ctx = common::setup();
    let id = note(&mut ctx, "제주 일정", "본문은 그대로 커피");
    // 제목만 → notes::update 의 fts_update_title 빠른 경로.
    notes::update(&mut ctx.conn, &id, Some("서울 출장".into()), None, None, None).unwrap();
    assert!(!index_lookup(&ctx.conn, "제주").contains(&id), "옛 제목 창은 빠져야");
    assert!(index_lookup(&ctx.conn, "서울").contains(&id));
    assert!(index_lookup(&ctx.conn, "커피").contains(&id), "본문 창은 남아야");
    assert_index_matches_fts(&ctx.conn, &["제주", "일정"]);
}

#[test]
fn tags_and_sources_are_indexed_and_unindexed() {
    let mut ctx = common::setup();
    let id = note(&mut ctx, "메모", "본문");
    notes::set_tags(&mut ctx.conn, &id, vec!["여행".into(), "Busan".into()]).unwrap();
    let src = sources::add_text(&mut ctx.conn, &id, "a.txt", "광안리 SOURCE").unwrap();
    assert!(index_lookup(&ctx.conn, "여행").contains(&id));
    assert!(index_lookup(&ctx.conn, "bu").contains(&id), "ASCII 는 소문자로");
    assert!(index_lookup(&ctx.conn, "광안").contains(&id));
    notes::set_tags(&mut ctx.conn, &id, vec![]).unwrap();
    sources::delete(&mut ctx.conn, &src.id).unwrap();
    assert!(!index_lookup(&ctx.conn, "여행").contains(&id));
    assert!(!index_lookup(&ctx.conn, "광안").contains(&id));
    assert_index_matches_fts(&ctx.conn, &["여행", "bu", "광안", "so"]);
}

#[test]
fn trash_removes_and_restore_reindexes() {
    let mut ctx = common::setup();
    let id = note(&mut ctx, "지울 노트", "커피 여행");
    notes::delete(&mut ctx.conn, &id).unwrap();
    assert!(index_lookup(&ctx.conn, "커피").is_empty(), "휴지통 노트는 색인에서 빠진다");
    assert_index_matches_fts(&ctx.conn, &["커피", "여행", "지울"]);
    notes::restore(&mut ctx.conn, &id).unwrap();
    assert!(index_lookup(&ctx.conn, "커피").contains(&id));
    assert_index_matches_fts(&ctx.conn, &[]);
}

#[test]
fn clear_all_empties_the_index() {
    let mut ctx = common::setup();
    note(&mut ctx, "하나", "커피");
    note(&mut ctx, "둘", "여행");
    let tx = ctx.conn.transaction().unwrap();
    fts::clear_all(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(common::count(&ctx.conn, "notes_bigram_map"), 0);
    assert_eq!(common::count(&ctx.conn, "notes_bigram"), 0);
    assert!(index_lookup(&ctx.conn, "커피").is_empty());
}

#[test]
fn v94_backfill_on_existing_notes_matches_a_fresh_rebuild() {
    let mut ctx = common::setup();
    let a = note(&mut ctx, "부산 여행", "커피값만 9월에 10km");
    let b = note(&mut ctx, "ÉCOLE", "CRDT는 LWW보다 낫다");
    notes::set_tags(&mut ctx.conn, &b, vec!["여행".into()]).unwrap();
    let gone = note(&mut ctx, "지운 노트", "커피");
    notes::delete(&mut ctx.conn, &gone).unwrap();

    // V94 이전 상태로 되돌린다 — 색인 테이블이 없고 schema_migrations 가 93 까지인 DB.
    ctx.conn
        .execute_batch(
            "DROP TABLE notes_bigram; DROP TABLE notes_bigram_map;
             DELETE FROM schema_migrations WHERE version >= 94;",
        )
        .unwrap();
    assert_eq!(brise_lib::db::migrations::current_version(&ctx.conn).unwrap(), 93);
    brise_lib::db::migrations::run(&mut ctx.conn).unwrap();
    assert!(brise_lib::db::migrations::current_version(&ctx.conn).unwrap() >= 94);
    assert!(index_lookup(&ctx.conn, "여행").is_superset(&[a.clone(), b.clone()].into()));
    assert!(!index_lookup(&ctx.conn, "커피").contains(&gone));
    assert_index_matches_fts(&ctx.conn, &[]);

    // 백필 결과 == 처음부터 다시 만든 결과(그리고 다시 만들어도 같다 — 멱등).
    let snapshot = |conn: &Connection| -> BTreeMap<String, BTreeSet<String>> {
        expected_from_fts(conn).keys().map(|g| (g.clone(), index_lookup(conn, g))).collect()
    };
    let after_migration = snapshot(&ctx.conn);
    let tx = ctx.conn.transaction().unwrap();
    fts::bigram_rebuild_all(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(snapshot(&ctx.conn), after_migration);
    assert_index_matches_fts(&ctx.conn, &[]);
}

#[test]
fn note_without_any_two_char_window_still_gets_a_map_row() {
    let mut ctx = common::setup();
    let id = note(&mut ctx, "a", "- . ,");
    let n: i64 = ctx
        .conn
        .query_row("SELECT COUNT(*) FROM notes_bigram_map WHERE note_id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    assert_index_matches_fts(&ctx.conn, &[]);
}

#[test]
fn v95_realigns_a_v94_era_map_to_notes_fts_rowids() {
    let mut ctx = common::setup();
    let a = note(&mut ctx, "부산 여행", "커피값만 9월에 10km");
    let b = note(&mut ctx, "동기화 방식", "CRDT는 LWW보다 낫다");
    note(&mut ctx, "a", "- . ,");
    // V94 시절 모양으로 흐트러뜨린다 — 매핑 id 가 notes_fts rowid 와 다르고, 창 없는 노트는 매핑이 없다.
    ctx.conn
        .execute_batch(
            "DELETE FROM notes_bigram_map WHERE id NOT IN (SELECT rowid FROM notes_bigram);
             UPDATE notes_bigram_map SET id = id + 1000;
             DELETE FROM schema_migrations WHERE version >= 95;",
        )
        .unwrap();
    assert_eq!(brise_lib::db::migrations::current_version(&ctx.conn).unwrap(), 94);
    brise_lib::db::migrations::run(&mut ctx.conn).unwrap();
    assert!(brise_lib::db::migrations::current_version(&ctx.conn).unwrap() >= 95);
    assert_index_matches_fts(&ctx.conn, &[]);
    assert!(index_lookup(&ctx.conn, "여행").contains(&a));
    assert!(index_lookup(&ctx.conn, "동기").contains(&b));
}

// Wave PERF (L-6): rowid 기반 수정/삭제 후에도 매핑과 색인의 1:1 불변식이 완벽히 유지되는지 검증.
#[test]
fn rowid_mapping_and_bigram_sync_across_updates_and_deletes() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("첫 번째 제목".into()), Some(2026)).unwrap();
    let id = d.note.id.clone();
    let sec_id = d.sections[0].id.clone();
    sections::update(&mut ctx.conn, &sec_id, None, Some("본문 내용 1234".into()), None).unwrap();
    assert_index_matches_fts(&ctx.conn, &[]);

    // 1) 제목만 갱신 (fts_update_title -> rowid 재활용 및 2글자 색인 갱신)
    {
        let tx = ctx.conn.transaction().unwrap();
        let ok = fts::fts_update_title(&tx, &id, "두 번째 제목").unwrap();
        assert!(ok);
        tx.commit().unwrap();
    }
    assert!(index_lookup(&ctx.conn, "번째").contains(&id));
    assert_index_matches_fts(&ctx.conn, &[]);

    // 2) 본문 갱신 (fts_upsert -> 기존 rowid 행 삭제 후 새 rowid 삽입)
    sections::update(&mut ctx.conn, &sec_id, None, Some("수정된 본문 5678".into()), None).unwrap();
    assert_index_matches_fts(&ctx.conn, &[]);

    // 3) 노트 삭제 (fts_delete -> rowid 로 fts, bigram, map 모두 제거)
    notes::delete(&mut ctx.conn, &id).unwrap();
    let map_count: i64 = ctx
        .conn
        .query_row("SELECT COUNT(*) FROM notes_bigram_map WHERE note_id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(map_count, 0, "삭제 후 매핑 표에 남아있지 않아야 함");
    assert_index_matches_fts(&ctx.conn, &[]);
}

