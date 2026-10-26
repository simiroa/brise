// 불변성: FTS 인덱스는 항상 notes/sections/sources/tags 와 동기 상태
// specs/tests/invariant-fts-sync.yaml 시나리오 1:1
mod common;
use brise_lib::repo::{notes, search, sources};

const FULL_FROM: i64 = 900;
const FULL_TO: i64 = 1960;

fn search_ids(ctx: &common::Ctx, q: &str) -> Vec<String> {
    let r = search::search(&ctx.conn, q, Some(FULL_FROM), Some(FULL_TO), None, None).unwrap();
    r.results.into_iter().map(|n| n.id).collect()
}

#[test]
fn create_then_search() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Imjin War".into()), Some(1592))
        .unwrap();
    let ids = search_ids(&ctx, "Imjin");
    assert_eq!(ids.len(), 1);
    assert_eq!(ids[0], d.note.id);
}

#[test]
fn repo_create_keeps_live_notes_and_fts_counts_equal() {
    let mut ctx = common::setup();
    for title in ["First imported note", "Second imported note", "Third imported note"] {
        notes::create(&mut ctx.conn, &ctx.folder_id, Some(title.into()), None).unwrap();
    }

    let live_notes: i64 = ctx
        .conn
        .query_row(
            "SELECT count(*) FROM notes WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let indexed_notes: i64 = ctx
        .conn
        .query_row("SELECT count(*) FROM notes_fts", [], |row| row.get(0))
        .unwrap();

    assert_eq!(live_notes, indexed_notes);
}

#[test]
fn section_edit_reflected() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let section_id = d.sections[0].id.clone();
    brise_lib::repo::sections::update(
        &mut ctx.conn,
        &section_id,
        None,
        Some("거북선 turtle ship".into()),
        None,
    )
    .unwrap();
    let ids = search_ids(&ctx, "turtle");
    assert!(ids.contains(&d.note.id));
}

#[test]
fn source_add_reflected() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    sources::add_text(&mut ctx.conn, &d.note.id, "HUNMIN.txt", "훈민정음 서문").unwrap();
    let ids = search_ids(&ctx, "훈민정음");
    assert!(ids.contains(&d.note.id));
}

#[test]
fn tag_change_reflected() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    notes::set_tags(&mut ctx.conn, &d.note.id, vec!["Hangul".into()]).unwrap();
    assert!(search_ids(&ctx, "Hangul").contains(&d.note.id));
    notes::set_tags(&mut ctx.conn, &d.note.id, vec![]).unwrap();
    assert!(!search_ids(&ctx, "Hangul").contains(&d.note.id));
}

// Trash: notes::delete는 이제 소프트 삭제다 — notes 행은 남지만 FTS 색인에서는 여전히
// 제거되어야 한다(휴지통 노트가 검색에 새어나가면 안 되므로).
#[test]
fn delete_purges_fts() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Ghost".into()), None).unwrap();
    notes::delete(&mut ctx.conn, &d.note.id).unwrap();
    assert_eq!(search_ids(&ctx, "Ghost").len(), 0);
    assert!(!common::fts_has(&ctx.conn, &d.note.id));
}

// P1 회귀 (Wave 16): notes_fts가 unicode61이던 시절, 공백으로 구분된 CJK 어절은 통짜 토큰
// 하나로 취급돼 어절 중간 부분 문자열을 못 찾았다 — 본문에 "세종대왕"이 있어도 "종대"로
// 검색하면 미매치. trigram 토크나이저(migrations.rs V10)는 3글자 시퀀스 단위 인덱싱이라
// 어절 어디든 부분 문자열 매치가 된다. 강력한 증거는 src/db/migrations.rs 의 lib 테스트
// (test_v10_trigram_migration_korean_substring_regression) — 이 통합 테스트는 실제 repo 레이어
// (sections::update -> fts_upsert) 경유 경로까지 동일 동작을 확인한다.
#[test]
fn korean_mid_word_substring_reflected() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let section_id = d.sections[0].id.clone();
    brise_lib::repo::sections::update(
        &mut ctx.conn,
        &section_id,
        None,
        Some("조선의 4대 왕 세종대왕은 한글을 창제했다.".into()),
        None,
    )
    .unwrap();
    // trigram MATCH는 3글자 미만 쿼리를 인덱싱할 수 없으므로(build_match_query 참고) 회귀 쿼리는
    // 3글자 이상이어야 한다. "종대왕"은 "세종대왕은"의 진짜 중간(시작도 끝도 아닌) 부분 문자열.
    assert!(search_ids(&ctx, "종대왕").contains(&d.note.id));
    // "대왕은"은 어절 끝+조사 쪽 부분 문자열.
    assert!(search_ids(&ctx, "대왕은").contains(&d.note.id));
}

// 영문 검색 무회귀: trigram 전환 후에도 완전한 단어 검색과 여러 단어 AND 시맨틱스가 그대로
// 동작해야 한다 (build_match_query가 '*' 접두 대신 구문 리터럴 AND로 바뀐 것의 회귀 확인).
#[test]
fn english_keyword_search_no_regression() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Sejong the Great".into()), Some(1443))
        .unwrap();
    assert!(search_ids(&ctx, "Sejong").contains(&d.note.id));
    assert!(search_ids(&ctx, "Sejong Great").contains(&d.note.id));
    assert!(!search_ids(&ctx, "Sejong Missing").contains(&d.note.id));
}

// Wave PERF (L-6): 맵 행이 없는 상태(새 노트 또는 미색인)에서의 FTS 연산 무회귀.
// V95 불변식에 따라 맵 행이 없으면 fts 행도 없으므로 스캔/경고 없이 정상 진행/폴백되어야 한다.
#[test]
fn unindexed_note_fts_operations_behave_correctly() {
    let mut ctx = common::setup();
    let tx = ctx.conn.transaction().unwrap();

    // 1) 맵에 없는 임의 note_id 에 대해 fts_update_title 은 false 반환 (fts_upsert 로 폴백해야 함)
    let updated = brise_lib::repo::fts::fts_update_title(&tx, "non_existent_note", "New Title").unwrap();
    assert!(!updated);

    // 2) 맵에 없는 임의 note_id 에 대해 fts_delete 는 에러 없이 완료 (no-op)
    brise_lib::repo::fts::fts_delete(&tx, "non_existent_note").unwrap();

    tx.commit().unwrap();
}

#[test]
fn fts_upsert_without_prior_map_row_indexes_cleanly() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Brand New".into()), Some(2026)).unwrap();
    assert!(common::fts_has(&ctx.conn, &d.note.id));

    // 매핑과 fts 행을 강제로 삭제하여 "새 노트 첫 fts_upsert / import" 상태를 모사
    {
        let tx = ctx.conn.transaction().unwrap();
        tx.execute("DELETE FROM notes_bigram_map WHERE note_id = ?1", [&d.note.id]).unwrap();
        tx.execute("DELETE FROM notes_fts WHERE note_id = ?1", [&d.note.id]).unwrap();
        // 맵 행이 없는 상태에서 fts_upsert 호출 -> 정상적으로 행과 매핑을 생성해야 함
        brise_lib::repo::fts::fts_upsert(&tx, &d.note.id).unwrap();
        tx.commit().unwrap();
    }

    assert!(search_ids(&ctx, "Brand New").contains(&d.note.id));
    assert!(common::fts_has(&ctx.conn, &d.note.id));
}

