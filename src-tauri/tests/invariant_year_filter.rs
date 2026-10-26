// 불변성: 연대 필터는 경계 포함(inclusive), year 오름차순
// specs/tests/invariant-year-filter.yaml 1:1
mod common;
use brise_lib::error::AppError;
use brise_lib::repo::{notes, search};

fn fixture() -> common::Ctx {
    let mut ctx = common::setup();
    for y in [918, 1231, 1443, 1592, 1919, 1945] {
        let title = if y == 1443 { "Hangul" } else { "Note" };
        let d = notes::create(&mut ctx.conn, &ctx.folder_id, Some(title.into()), Some(y)).unwrap();
        if y == 1443 {
            notes::set_tags(&mut ctx.conn, &d.note.id, vec!["Hangul".into()]).unwrap();
        }
    }
    ctx
}

fn years(ctx: &common::Ctx, q: &str, from: i64, to: i64) -> Vec<i64> {
    let r = search::search(&ctx.conn, q, Some(from), Some(to), None, None).unwrap();
    r.results.into_iter().map(|n| n.year).collect()
}

#[test]
fn inclusive_bounds() {
    let ctx = fixture();
    assert_eq!(years(&ctx, "", 918, 1443), vec![918, 1231, 1443]);
}

#[test]
fn empty_range_ok() {
    let ctx = fixture();
    let r = search::search(&ctx.conn, "", Some(1000), Some(1100), None, None).unwrap();
    assert!(r.results.is_empty());
}

#[test]
fn invalid_range_rejected() {
    let ctx = fixture();
    let err = search::search(&ctx.conn, "", Some(1500), Some(1400), None, None).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn query_and_range_intersect() {
    let ctx = fixture();
    // Hangul 노트는 1443 → 900..1000 범위 밖이므로 제외
    assert_eq!(years(&ctx, "Hangul", 900, 1000), Vec::<i64>::new());
}
