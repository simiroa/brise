// repo: dashboard/timeline — year-window note items + era bands (dashboard_timeline).
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::taxonomy;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::ensure_workspace;

// ── dashboard_timeline ───────────────────────────────────────────────────────

pub const TIMELINE_ITEM_CAP: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineNoteItem {
    pub note_id: String,
    pub title: String,
    /// "point" or "bar".
    pub kind: String,
    pub year: i64,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub end_year: Option<i64>,
    pub end_month: Option<i64>,
    pub end_day: Option<i64>,
    /// Dashboard swimlanes (2026-08-01): the folder axis lanes key off. Already joined via
    /// `folders f` in the timeline() query — one extra SELECT column, no new join.
    pub folder_id: String,
}

/// Dashboard swimlanes (2026-08-01): (folder_id, year) → count. Was year-only; extended with
/// folder_id so the capped path can still render one density histogram per lane instead of a
/// single workspace-wide row. Bars count only at their *start* year (unchanged from before).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineYearBucket {
    pub folder_id: String,
    pub year: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineEra {
    pub id: String,
    pub name: String,
    pub from_year: i64,
    pub to_year: i64,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineResult {
    pub from_year: i64,
    pub to_year: i64,
    /// Full items when `capped == false`; empty when over cap (see year_buckets).
    pub items: Vec<TimelineNoteItem>,
    /// Year-level aggregation when `capped == true`; empty otherwise.
    pub year_buckets: Vec<TimelineYearBucket>,
    pub eras: Vec<TimelineEra>,
    /// Always reported (no silent cap).
    pub total_matched: i64,
    pub cap: i64,
    pub capped: bool,
}

pub fn timeline(
    conn: &Connection,
    workspace_id: &str,
    from_year: i64,
    to_year: i64,
) -> AppResult<TimelineResult> {
    timeline_capped(conn, workspace_id, from_year, to_year, TIMELINE_ITEM_CAP)
}

/// `timeline` 본체. `cap` 을 인자로 받는 이유는 테스트가 캡 초과 경로(집계 다운그레이드)를
/// TIMELINE_ITEM_CAP+1 = 2001 개 노트를 심지 않고 검증하기 위해서다 — 예전에는 그래서 집계
/// 함수를 Vec 위에서 따로 단위 테스트했는데, 집계가 SQL 로 내려간 지금은 DB 를 거쳐야만
/// 의미가 있다.
fn timeline_capped(
    conn: &Connection,
    workspace_id: &str,
    from_year: i64,
    to_year: i64,
    cap: usize,
) -> AppResult<TimelineResult> {
    ensure_workspace(conn, workspace_id)?;
    if from_year > to_year {
        return Err(AppError::Validation(format!(
            "from_year ({from_year}) > to_year ({to_year})"
        )));
    }

    // Event intersects [from_year, to_year]:
    // start_year = year, end_year_eff = COALESCE(end_year, year)
    // intersects if start_year <= to_year AND end_year_eff >= from_year
    // (No NULLS FIRST — not portable across SQLite builds; order is good enough for the canvas.)
    //
    // SCALABILITY.md §0 (2026-08-09): 캡을 **SQL LIMIT** 으로 내렸다. 예전에는 매치 전량을 Rust
    // Vec 으로 materialize 한 뒤 2000 을 세었기 때문에, 프론트가 전 범위를 요청하는 이 화면에서
    // 비용이 그대로 코퍼스 크기였다. `cap + 1` 행만 받아 "초과했나"를 판정하고, 초과했으면
    // 아이템을 버리고 집계 쿼리로 갈아탄다(HashMap 전량 카운트 제거).
    let mut stmt = conn.prepare(ITEMS_SQL).map_err(dberr)?;

    let rows: Vec<TimelineNoteItem> = stmt
        .query_map(
            params![workspace_id, from_year, to_year, cap as i64 + 1],
            |r| {
                let year: i64 = r.get(2)?;
                let end_year: Option<i64> = r.get(5)?;
                let kind = if end_year.is_some() {
                    "bar".to_string()
                } else {
                    "point".to_string()
                };
                Ok(TimelineNoteItem {
                    note_id: r.get(0)?,
                    title: r.get(1)?,
                    kind,
                    year,
                    month: r.get(3)?,
                    day: r.get(4)?,
                    end_year,
                    end_month: r.get(6)?,
                    end_day: r.get(7)?,
                    folder_id: r.get(8)?,
                })
            },
        )
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    let capped = rows.len() > cap;

    let (items, year_buckets, total_matched) = if capped {
        let buckets = year_buckets_query(conn, workspace_id, from_year, to_year)?;
        let total = buckets.iter().map(|b| b.count).sum();
        (Vec::new(), buckets, total)
    } else {
        let total = rows.len() as i64;
        (rows, Vec::new(), total)
    };

    let eras_raw = taxonomy::list_eras(conn, Some(workspace_id.to_string()))?;
    let eras = eras_raw
        .into_iter()
        .filter(|e| e.from_year <= to_year && e.to_year >= from_year)
        .map(|e| TimelineEra {
            id: e.id,
            name: e.name,
            from_year: e.from_year,
            to_year: e.to_year,
            position: e.position,
        })
        .collect();

    Ok(TimelineResult {
        from_year,
        to_year,
        items,
        year_buckets,
        eras,
        total_matched,
        cap: TIMELINE_ITEM_CAP as i64,
        capped,
    })
}

/// 워크스페이스 스코프가 `JOIN folders` 가 아니라 semi-join 인 이유는 calendar.rs 의 SPAN_SQL
/// 주석과 같다(플래너가 folders 를 바깥 루프로 잡으면 단일 노트북에서 전체 노트 스캔).
/// `f.id` 대신 `n.folder_id` 를 그대로 내보낸다 — 조인 조건이 `f.id = n.folder_id` 였으므로 값은
/// 동일하고, 이제 folders 를 읽지 않아도 된다.
/// ?1 workspace_id · ?2 from_year · ?3 to_year · ?4 LIMIT(cap+1).
const ITEMS_SQL: &str = "SELECT n.id, n.title, n.year, n.month, n.day,
        n.end_year, n.end_month, n.end_day, n.folder_id
 FROM notes n
 WHERE n.deleted_at IS NULL
   -- W7-f: dashboard surface — archived notes hidden (search_notes still returns them).
   AND n.archived_at IS NULL
   AND n.year <= ?3
   AND COALESCE(n.end_year, n.year) >= ?2
   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
 ORDER BY n.year ASC, n.id ASC
 LIMIT ?4";

/// 캡 초과 응답의 `year_buckets` — 예전에는 전량 Vec 을 Rust HashMap 으로 세었다. 같은 결과를
/// GROUP BY 로 만든다: (folder, 시작 연도) 별 카운트, 연도 → 폴더 순 정렬. 다년 bar 는 여전히
/// **시작 연도에만** 1 을 더한다(GROUP BY n.year 가 곧 시작 연도이므로 자동). 범위 안에 행이
/// 없는 폴더는 그냥 나타나지 않는다.
fn year_buckets_query(
    conn: &Connection,
    workspace_id: &str,
    from_year: i64,
    to_year: i64,
) -> AppResult<Vec<TimelineYearBucket>> {
    let mut stmt = conn
        .prepare(
            "SELECT n.folder_id, n.year, COUNT(*)
             FROM notes n
             WHERE n.deleted_at IS NULL
               AND n.archived_at IS NULL
               AND n.year <= ?3
               AND COALESCE(n.end_year, n.year) >= ?2
               AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
             GROUP BY n.folder_id, n.year
             ORDER BY n.year ASC, n.folder_id ASC",
        )
        .map_err(dberr)?;
    let buckets = stmt
        .query_map(params![workspace_id, from_year, to_year], |r| {
            Ok(TimelineYearBucket {
                folder_id: r.get(0)?,
                year: r.get(1)?,
                count: r.get(2)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    Ok(buckets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{notes, taxonomy};
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn ws_and_folder(conn: &Connection) -> (String, String) {
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        (ws, folder)
    }

    // ── timeline ───────────────────────────────────────────────────────────

    #[test]
    fn timeline_points_and_bars_and_eras() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let p = notes::create_with_timestamp(
            &mut conn,
            &folder,
            Some("Point".into()),
            Some(1800),
            Some(6),
            Some(1),
            None,
            None,
        )
        .unwrap();
        let b = notes::create_with_timestamp(
            &mut conn,
            &folder,
            Some("Bar".into()),
            Some(1794),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        notes::set_event_end(&mut conn, &b.note.id, Some(1796), None, None).unwrap();
        taxonomy::add_era(&mut conn, Some(ws.clone()), "Revolutionary", 1789, 1799).unwrap();

        let tl = timeline(&conn, &ws, 1790, 1810).unwrap();
        assert!(!tl.capped);
        assert_eq!(tl.cap, TIMELINE_ITEM_CAP as i64);
        assert!(tl.items.iter().any(|i| i.note_id == p.note.id && i.kind == "point"));
        assert!(tl.items.iter().any(|i| i.note_id == b.note.id && i.kind == "bar"));
        assert_eq!(tl.eras.len(), 1);
        assert_eq!(tl.eras[0].name, "Revolutionary");
    }

    #[test]
    fn timeline_under_cap_keeps_full_items() {
        // Small workspace: capped=false, full items returned (no year_buckets downgrade).
        // The capped=true branch (downgrade to year_buckets) is covered by the
        // timeline_capped(..., cap) tests below — they force the cap with a handful of rows
        // instead of inserting TIMELINE_ITEM_CAP+1 into a DB fixture on every test pass.
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        for i in 0..5 {
            notes::create_with_timestamp(
                &mut conn,
                &folder,
                Some(format!("n{i}")),
                Some(1900 + i),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }
        let tl = timeline(&conn, &ws, 1900, 1910).unwrap();
        assert!(!tl.capped);
        assert!(tl.year_buckets.is_empty());
        assert_eq!(tl.total_matched, 5);
        assert_eq!(tl.items.len(), 5);
    }

    /// 캡 초과 경로: 아이템은 비고, year_buckets 가 (폴더, 시작 연도) 카운트를 연도 → 폴더 순으로
    /// 싣고, total_matched 는 캡이 아니라 **전체 매치 수**다. 예전에는 Rust HashMap 집계를 Vec 위에서
    /// 단위 테스트했는데 집계가 GROUP BY 로 내려갔으므로 DB 를 거쳐 검증한다(cap 을 낮춰 2001행
    /// 픽스처를 피한다). 같은 연도의 서로 다른 폴더가 하나로 합쳐지지 않는 것, 범위 안에 행이 없는
    /// 폴더가 나타나지 않는 것까지 한 테스트에서 본다.
    #[test]
    fn timeline_capped_downgrades_to_folder_year_buckets() {
        let mut conn = setup_db();
        let (ws, folder_a) = ws_and_folder(&conn);
        let folder_b = crate::repo::folders::create(&mut conn, "B", Some(ws.clone()), None, None, None)
            .unwrap()
            .id;
        // 범위 안에 한 행도 없는 폴더 — 버킷에 나타나면 안 된다.
        let folder_empty = crate::repo::folders::create(&mut conn, "Empty", Some(ws.clone()), None, None, None)
            .unwrap()
            .id;

        let mk = |conn: &mut Connection, folder: &str, year: i64| {
            notes::create_with_timestamp(conn, folder, Some("n".into()), Some(year), None, None, None, None)
                .unwrap();
        };
        mk(&mut conn, &folder_a, 1900);
        mk(&mut conn, &folder_a, 1900);
        mk(&mut conn, &folder_b, 1900);
        mk(&mut conn, &folder_a, 1950);

        let tl = timeline_capped(&conn, &ws, 1800, 2000, 3).unwrap();
        assert!(tl.capped);
        assert!(tl.items.is_empty(), "캡 초과면 실아이템은 싣지 않는다");
        assert_eq!(tl.total_matched, 4, "캡이 아니라 전체 매치 수");
        assert_eq!(tl.cap, TIMELINE_ITEM_CAP as i64, "cap 필드는 공개 상수 그대로");
        // 정렬은 연도 → folder_id(문자열). 폴더 id 는 uuid 라 a/b 의 상대 순서가 실행마다 다르므로
        // 기대값도 같은 규칙으로 만든다.
        let mut same_year = vec![
            TimelineYearBucket { folder_id: folder_a.clone(), year: 1900, count: 2 },
            TimelineYearBucket { folder_id: folder_b.clone(), year: 1900, count: 1 },
        ];
        same_year.sort_by(|x, y| x.folder_id.cmp(&y.folder_id));
        let mut expected = same_year;
        expected.push(TimelineYearBucket { folder_id: folder_a.clone(), year: 1950, count: 1 });
        assert_eq!(tl.year_buckets, expected);
        assert!(
            !tl.year_buckets.iter().any(|b| b.folder_id == folder_empty),
            "범위 안에 행이 없는 폴더는 나타나지 않는다"
        );

        // 캡 경계: 매치 수 == cap 이면 아직 초과가 아니다(LIMIT cap+1 이 cap+1 행을 못 받는다).
        let tl = timeline_capped(&conn, &ws, 1800, 2000, 4).unwrap();
        assert!(!tl.capped);
        assert_eq!(tl.items.len(), 4);
        assert_eq!(tl.total_matched, 4);
    }

    /// 계획 회귀: 아이템 쿼리는 `idx_notes_year_alive` 를 **연도 순서 그대로** 타야 한다 —
    /// 그래야 LIMIT 이 조기 종료로 이어지고(정렬용 임시 B-tree 없음) 비용이 캡에 비례한다.
    /// (`n.id` 타이브레이크만 마지막 항에서 정렬되는 건 허용 — 연도 그룹 단위로 흘러가므로
    /// 조기 종료가 유지된다.)
    #[test]
    fn timeline_items_query_walks_the_year_index() {
        let conn = setup_db();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {ITEMS_SQL}"))
            .unwrap();
        let detail: Vec<String> = stmt
            .query_map(params!["ws", 0i64, 0i64, 1i64], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let plan = detail.join(" | ");
        println!("timeline items plan: {plan}");
        assert!(
            plan.contains("idx_notes_year_alive"),
            "연도 인덱스를 타야 LIMIT 이 조기 종료된다: {plan}"
        );
    }

    #[test]
    fn timeline_capped_bar_counts_only_at_its_start_year() {
        // 다년 bar 는 시작 연도에만 1 — 종료 연도나 중간 연도에는 세지 않는다.
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let b = notes::create_with_timestamp(
            &mut conn, &folder, Some("Bar".into()), Some(1794), None, None, None, None,
        )
        .unwrap();
        notes::set_event_end(&mut conn, &b.note.id, Some(1830), None, None).unwrap();
        notes::create_with_timestamp(
            &mut conn, &folder, Some("p".into()), Some(1800), None, None, None, None,
        )
        .unwrap();

        let tl = timeline_capped(&conn, &ws, 1700, 1900, 1).unwrap();
        assert!(tl.capped);
        assert_eq!(
            tl.year_buckets,
            vec![
                TimelineYearBucket { folder_id: folder.clone(), year: 1794, count: 1 },
                TimelineYearBucket { folder_id: folder.clone(), year: 1800, count: 1 },
            ]
        );
    }
}
