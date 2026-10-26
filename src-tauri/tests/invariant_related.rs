// 불변성: 관련 노트 스코어링 (Wave 7 P30 + 신호 확장) — 백링크/사건날짜/공통첨부(신규, 가산)와
// 태그 중첩 가중치/연도 근접(기존, 하위 유지) 타이브레이크
// specs/tests/invariant-related.yaml 1:1
mod common;
use brise_lib::repo::{attachments, notes};

#[test]
fn tag_overlap_ranks_higher() {
    let mut ctx = common::setup();
    let source =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Source".into()), Some(1000)).unwrap();
    notes::set_tags(
        &mut ctx.conn,
        &source.note.id,
        vec!["war".into(), "dynasty".into()],
    )
    .unwrap();

    // X: 태그 2개 공유 + 연도 원거리(year term = 0) → score = 2*10 + 0 = 20
    let x = notes::create(&mut ctx.conn, &ctx.folder_id, Some("X".into()), Some(1900)).unwrap();
    notes::set_tags(
        &mut ctx.conn,
        &x.note.id,
        vec!["war".into(), "dynasty".into()],
    )
    .unwrap();

    // Y: 태그 공유 0 + 연도차 1(year term = max(0, 10 - 1/10) = 10) → score = 0 + 10 = 10.
    // 일부러 source(1000)와 정확히 같은 해가 아니라 1년 차이로 둔다 — 정확히 같았다면 신규
    // event_date_match 신호(+30, 중간 티어)가 붙어 이 시나리오의 취지(하위 티어 안에서
    // 태그 중첩 vs 연도 근접 비교)와 신규 신호가 뒤섞이게 된다.
    let y = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Y".into()), Some(999)).unwrap();
    notes::set_tags(&mut ctx.conn, &y.note.id, vec!["unrelated".into()]).unwrap();

    let related = notes::related(&ctx.conn, &source.note.id, 5).unwrap();
    let ids: Vec<&str> = related.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        ids[0], x.note.id,
        "tag overlap (score 20) must outrank max year proximity alone (score 10)"
    );
    let x_pos = ids.iter().position(|&i| i == x.note.id).unwrap();
    let y_pos = ids.iter().position(|&i| i == y.note.id).unwrap();
    assert!(x_pos < y_pos);
}

#[test]
fn year_proximity_tiebreak() {
    let mut ctx = common::setup();
    let source =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Source".into()), Some(2000)).unwrap();

    // A: 태그 공유 0, 연도 완전 일치 → score = 10
    let a = notes::create(&mut ctx.conn, &ctx.folder_id, Some("A".into()), Some(2000)).unwrap();
    // B: 태그 공유 0, 연도차 50 → score = max(0, 10 - 50/10) = 5 (> 0, HAVING 컷오프를 통과해야
    // "동점(0) 상황의 타이브레이크"가 아니라 "둘 다 score>0인 상태에서 더 가까운 연도가 먼저"를
    // 검증하는 테스트로 남는다 — 완전히 무관한(score=0) 노트가 배제되는 것은
    // unrelated_note_is_excluded 가 별도로 검증한다.
    let b = notes::create(&mut ctx.conn, &ctx.folder_id, Some("B".into()), Some(1950)).unwrap();

    let related = notes::related(&ctx.conn, &source.note.id, 5).unwrap();
    let ids: Vec<&str> = related.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        ids[0], a.note.id,
        "with equal (zero) tag overlap, closer year must rank first"
    );
    let a_pos = ids.iter().position(|&i| i == a.note.id).unwrap();
    let b_pos = ids.iter().position(|&i| i == b.note.id).unwrap();
    assert!(a_pos < b_pos);
}

/// Bug fix regression: a note with zero shared tags AND a year far enough away that the
/// proximity term is also zero (score == 0) must NOT be returned, even if that means the
/// result list comes back shorter than `limit` (or empty). Before the HAVING cutoff, this
/// note would still be included just to pad out LIMIT, which is what made the "related notes"
/// list look arbitrary.
#[test]
fn unrelated_note_is_excluded() {
    let mut ctx = common::setup();
    let source =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Source".into()), Some(1500)).unwrap();
    notes::set_tags(&mut ctx.conn, &source.note.id, vec!["war".into()]).unwrap();

    // Unrelated: no shared tags, and year_diff = 500 (>= 100) so the year term is also 0.
    // score = 0*10 + max(0, 10 - 500/10) = max(0, 10-50) = 0 → must be excluded entirely.
    let unrelated = notes::create(
        &mut ctx.conn,
        &ctx.folder_id,
        Some("Unrelated".into()),
        Some(2000),
    )
    .unwrap();
    notes::set_tags(&mut ctx.conn, &unrelated.note.id, vec!["cooking".into()]).unwrap();

    let related = notes::related(&ctx.conn, &source.note.id, 5).unwrap();
    let ids: Vec<&str> = related.iter().map(|n| n.id.as_str()).collect();
    assert!(
        !ids.contains(&unrelated.note.id.as_str()),
        "note with score 0 (no shared tags, year_diff >= 100) must not be padded into the result"
    );
    assert!(
        related.is_empty(),
        "with only one candidate note and it being unrelated, the result must be empty, not padded"
    );
}

/// New signals (backlink / same event date / shared attachment) are additive on top of the
/// existing tag/year tier, ranked as: backlink (top, 100) > event date match / shared attachment
/// (mid, 30 / 15) > tag overlap (existing, lower, 10 per tag). Each candidate below isolates one
/// signal, with year kept far from the source (diff >= 100, old year-proximity term = 0) except
/// where the signal being tested is the year/event-date match itself.
#[test]
fn new_signals_rank_above_existing_tag_tier() {
    let mut ctx = common::setup();
    let source =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Source".into()), Some(1000)).unwrap();
    notes::set_tags(&mut ctx.conn, &source.note.id, vec!["war".into()]).unwrap();

    // TAGGY: existing lower tier only — 1 shared tag, year far away → score = 1*10 = 10.
    let taggy =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Taggy".into()), Some(1900)).unwrap();
    notes::set_tags(&mut ctx.conn, &taggy.note.id, vec!["war".into()]).unwrap();

    // BACK: no tags, year far away, but mentions source via an internal-link attachment
    // (backlink) → score = 100 alone, must still outrank everything else here.
    let back =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("Back".into()), Some(1900)).unwrap();
    attachments::add_internal(&mut ctx.conn, &back.note.id, &source.note.id, "ref to source")
        .unwrap();

    // DATE: no tags, exact same year as source and both at year-only precision (month/day unset)
    // → shared precision = year, event_date_match fires → score = 30 (event date) + 10 (old
    // year-proximity max, since year_diff = 0) = 40.
    let date = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Date".into()), Some(1000)).unwrap();

    // FILE: no tags, year far away, shares one attachment (identical bytes → identical
    // content_hash) with source → score = 15 (one shared attachment).
    let file =
        notes::create(&mut ctx.conn, &ctx.folder_id, Some("File".into()), Some(1900)).unwrap();
    let ext_dir = ctx.tmp.path().join("external");
    let shared_path = common::make_external_file(&ext_dir, "shared.txt", b"identical bytes");
    attachments::add_file(
        &mut ctx.conn,
        &ctx.data_dir,
        &source.note.id,
        shared_path.to_str().unwrap(),
    )
    .unwrap();
    attachments::add_file(
        &mut ctx.conn,
        &ctx.data_dir,
        &file.note.id,
        shared_path.to_str().unwrap(),
    )
    .unwrap();

    let related = notes::related(&ctx.conn, &source.note.id, 10).unwrap();
    let pos = |id: &str| related.iter().position(|n| n.id == id).unwrap();

    assert!(
        pos(&back.note.id) < pos(&date.note.id) && pos(&back.note.id) < pos(&file.note.id),
        "backlink (top tier, 100) must outrank the mid-tier signals"
    );
    assert!(
        pos(&date.note.id) < pos(&taggy.note.id) && pos(&file.note.id) < pos(&taggy.note.id),
        "mid-tier signals (event date match, shared attachment) must outrank the existing \
         lower-tier tag-overlap-only signal"
    );
}
