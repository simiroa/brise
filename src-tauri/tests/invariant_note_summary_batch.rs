// 불변성: N+1 배치 헬퍼(note_summaries_map/note_summaries_for_ids) 등가성
//
// 성능 리팩터(repo/notes.rs, repo/search.rs): note_summary()를 루프 안에서
// 반복 호출하던 자리(검색 결과 조립, 관련 노트)를 배치 헬퍼(3쿼리 고정)로
// 대체했다. 이 파일은 "행동 보존"의 실질적 안전망이다 — 배치 경로가 단수형 note_summary()를
// 같은 순서로 루프 호출했을 때와 바이트 단위로 동일한 결과(같은 id, 같은 순서, 같은
// tag_names, 같은 has_image)를 내는지 검증한다.
mod common;
use brise_lib::repo::{attachments, notes, search};

const TAG_POOL: [&str; 5] = ["war", "dynasty", "art", "politics", "trade"];

/// 20개 노트를 태그/이미지 조합을 다양하게 섞어 시딩하고, 생성된 id 목록을 반환한다.
fn seed_notes(ctx: &mut common::Ctx) -> Vec<String> {
    let mut ids = Vec::new();
    for i in 0..20 {
        let d = notes::create(
            &mut ctx.conn,
            &ctx.folder_id,
            Some(format!("Note {i}")),
            Some(1000 + i as i64),
        )
        .unwrap();
        let id = d.note.id.clone();

        // 태그: 인덱스별로 서로 다른 부분집합 (일부 노트는 태그 없음 — 싱귤러 경로의
        // "미존재 시 빈 tag_names" 케이스도 함께 커버).
        let mut tags: Vec<String> = Vec::new();
        for (j, t) in TAG_POOL.iter().enumerate() {
            if (i + j) % 3 == 0 {
                tags.push(t.to_string());
            }
        }
        if !tags.is_empty() {
            notes::set_tags(&mut ctx.conn, &id, tags).unwrap();
        }

        // 이미지: 3의 배수 인덱스에만 첨부 (일부는 이미지 없음 — has_image=false 케이스도 커버).
        if i % 3 == 0 {
            let ext = common::make_external_file(
                &ctx.tmp.path().join("ext"),
                &format!("img{i}.png"),
                b"img",
            );
            attachments::add_file(&mut ctx.conn, &ctx.data_dir, &id, ext.to_str().unwrap())
                .unwrap();
        }

        ids.push(id);
    }
    ids
}

#[test]
fn batch_matches_singular_loop_20_notes() {
    let mut ctx = common::setup();
    let ids = seed_notes(&mut ctx);

    // 순서 보존 검증: 입력 순서를 일부러 뒤섞는다. 배치 쿼리 자체의 행 순서(예: notes 테이블의
    // 자연 순서)에 의존해 결과를 만들면 이 테스트가 실패해야 한다 — 반드시 `ids`가 정의하는
    // 순서를 그대로 따라야 한다.
    let mut shuffled = ids.clone();
    shuffled.reverse();
    shuffled.swap(2, 15);
    shuffled.swap(0, 19);

    // 기대값: 단수형 note_summary()를 shuffled 순서 그대로 루프 호출(리팩터 이전 동작 그대로).
    let expected: Vec<_> = shuffled
        .iter()
        .map(|id| notes::note_summary(&ctx.conn, id).unwrap())
        .collect();

    // 실제값: 배치 헬퍼.
    let actual = notes::note_summaries_for_ids(&ctx.conn, &shuffled).unwrap();

    assert_eq!(actual.len(), expected.len());
    assert_eq!(
        actual, expected,
        "batch helper must be byte-identical to the singular note_summary loop, including order"
    );

    // 필드별로도 명시적으로 재확인 (회귀 시 어떤 필드가 깨졌는지 바로 드러나도록).
    for (a, e) in actual.iter().zip(expected.iter()) {
        assert_eq!(a.id, e.id);
        assert_eq!(
            a.tag_names, e.tag_names,
            "tag_names ordering must match COLLATE NOCASE ascending, same as the singular path"
        );
        assert_eq!(a.has_image, e.has_image);
        assert_eq!(a.title, e.title);
        assert_eq!(a.year, e.year);
        assert_eq!(a.folder_id, e.folder_id);
        assert_eq!(a.exported_at, e.exported_at);
        assert_eq!(a.region, e.region);
        assert_eq!(a.status, e.status);
    }
}

#[test]
fn missing_id_is_omitted_not_erroring() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Solo".into()), Some(1500)).unwrap();
    let real_id = d.note.id.clone();
    let fake_id = "does-not-exist".to_string();

    let ids = vec![fake_id, real_id.clone()];
    let out = notes::note_summaries_for_ids(&ctx.conn, &ids).unwrap();
    assert_eq!(out.len(), 1, "nonexistent id must be silently omitted, not erroring");
    assert_eq!(out[0].id, real_id);
}

#[test]
fn map_variant_keys_by_id_and_empty_input_is_empty() {
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Solo".into()), Some(1500)).unwrap();
    let id = d.note.id.clone();

    let map = notes::note_summaries_map(&ctx.conn, &[id.clone()]).unwrap();
    assert_eq!(map.len(), 1);
    assert_eq!(map.get(&id).unwrap().id, id);

    let empty = notes::note_summaries_map(&ctx.conn, &[]).unwrap();
    assert!(empty.is_empty());
    let empty_vec = notes::note_summaries_for_ids(&ctx.conn, &[]).unwrap();
    assert!(empty_vec.is_empty());
}

/// repo/notes.rs::related 호출부 — related()가 내부적으로 배치 헬퍼를 쓰도록 바뀐 뒤에도
/// 반환되는 각 NoteSummary 값이 단수형 note_summary()로 직접 조회한 값과 완전히 같아야 한다.
#[test]
fn related_values_match_singular_note_summary() {
    let mut ctx = common::setup();
    let source =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Source".into()), Some(1000)).unwrap();
    notes::set_tags(&mut ctx.conn, &source.note.id, vec!["war".into(), "dynasty".into()]).unwrap();

    for i in 0..5 {
        let d = notes::create(
            &mut ctx.conn,
            &ctx.folder_id,
            Some(format!("Rel{i}")),
            Some(1000 + i),
        )
        .unwrap();
        notes::set_tags(&mut ctx.conn, &d.note.id, vec!["war".into()]).unwrap();
        if i % 2 == 0 {
            let ext = common::make_external_file(
                &ctx.tmp.path().join("ext"),
                &format!("rel{i}.png"),
                b"img",
            );
            attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap())
                .unwrap();
        }
    }

    let related = notes::related(&ctx.conn, &source.note.id, 10).unwrap();
    assert!(!related.is_empty());
    for r in &related {
        let singular = notes::note_summary(&ctx.conn, &r.id).unwrap();
        assert_eq!(r, &singular, "related()'s batched summary must match the singular lookup");
    }
}

/// repo/search.rs::search (keyword 경로) — order_ids_by_year 순서를 그대로 보존하면서 배치
/// 조립해야 한다. 태그/이미지가 섞인 노트에 대해 각 결과가 단수형 note_summary()와 일치하는지,
/// 그리고 전체 순서가 연도 오름차순인지 확인한다.
#[test]
fn search_keyword_results_match_singular_loop_and_break_ties_by_year() {
    let mut ctx = common::setup();
    let mut expected_years: Vec<(i64, String)> = Vec::new();
    for i in 0..8 {
        // 서로 다른 연도를 부여해 정렬 순서를 명확히 한다.
        let year = 1000 + (i * 13);
        let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some(format!("Hist{i}")), Some(year))
            .unwrap();
        notes::set_tags(&mut ctx.conn, &d.note.id, vec!["war".into()]).unwrap();
        if i % 2 == 0 {
            let ext = common::make_external_file(
                &ctx.tmp.path().join("ext"),
                &format!("hist{i}.png"),
                b"img",
            );
            attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap())
                .unwrap();
        }
        expected_years.push((year, d.note.id));
    }
    expected_years.sort_by(|a, b| a.0.cmp(&b.0));
    let expected_ids: Vec<String> = expected_years.into_iter().map(|(_, id)| id).collect();

    // FULL_SPAN(900..1960) 과 동일한 리터럴 — year 술어 자체를 생략하는 경로를 태운다.
    let result = search::search(&ctx.conn, "war", Some(900), Some(1960), None, None).unwrap();
    let actual_ids: Vec<String> = result.results.iter().map(|n| n.id.clone()).collect();
    // 키워드 경로는 **관련도(bm25)순**이 원칙이다(repo/search.rs 주석 — year 경로와 기준이
    // 다르다). 이 노트들은 같은 태그 하나만 가져 bm25 가 전부 동점이므로, 여기서 보는 것은
    // "동점일 때 연도순으로 결정적으로 깨지는가"다. 예전엔 동점 구간이 사실상 임의(id 인덱스)
    // 순이라 같은 질의가 실행마다 다른 순서를 냈다.
    assert_eq!(actual_ids, expected_ids, "tied keyword hits must break by year, deterministically");

    for note in &result.results {
        let singular = notes::note_summary(&ctx.conn, &note.id).unwrap();
        assert_eq!(note, &singular, "batched search result must match the singular lookup");
    }
}
