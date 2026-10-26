// repo: dashboard/calendar — month grid event-span query (dashboard_calendar).
use crate::error::{db as dberr, AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;

use super::dateord::{days_in_month, ord_to_ymd, NaiveYmd};
use super::ensure_workspace;
use crate::repo::schedule::rrule;

// ── dashboard_calendar ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CalendarItem {
    pub note_id: String,
    pub folder_id: String,
    pub title: String,
    /// "event" = single-day / point on event axis (no end triple at all); "span" = has an end
    /// triple (multi-day period, or same-day span). Dashboard Wave 2 (2026-08-01): the old
    /// separate "due" kind is gone — due_at merged into end_*. Dashboard Wave 3 (2026-08-01): the
    /// calendar grid renders every item neutrally (no urgency/deadline coloring) — the pin/red-dot
    /// treatment for a past-due `remind`-flagged note lives only on the board (BoardCard.tsx), not
    /// here (see calendarLayout.ts, which has no deadline gate anymore).
    pub kind: String,
    /// Inclusive start of the visible slice clipped to the requested month (YYYY-MM-DD).
    pub span_start: String,
    /// Inclusive end of the visible slice clipped to the requested month (YYYY-MM-DD).
    pub span_end: String,
    /// Raw event-axis fields (for client labels).
    pub year: i64,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub end_year: Option<i64>,
    pub end_month: Option<i64>,
    pub end_day: Option<i64>,
    /// "HH:MM" 시작 시각. NULL 이면 **종일**이고, 하루뷰(DayDetailPanel)의 분기 기준이 정확히
    /// 이 필드다(docs/PLAN-schedule-system.md §6.2). 월 그리드 셀은 시각을 그리지 않는다.
    pub start_time: Option<String>,
    /// "HH:MM" 종료 시각. 다일 스팬에서는 **마지막 날**의 시각이라 같은 날 안에서만 길이로 쓸 수
    /// 있다(§1.3 I3 과 같은 전제).
    pub end_time: Option<String>,
    /// 반복 규칙에서 전개된 회차. 반복이 아닌 항목에는 붙지 않는다(§2.3: 새 필드는 전부 optional).
    /// 지금은 배지를 붙이지 않고 실어만 둔다(§6.3).
    pub is_occurrence: Option<bool>,
    /// "알려줘" opt-in 플래그(2026-09-08 오너: 연간 뷰가 알림 있는 날에 폴더색 점을 찍는다).
    /// 이 항목을 낳은 note_dates 행의 remind 다(대표는 notes.remind 와 같은 값 — 투영이므로).
    /// 긴급도/마감 취급이 아니다 — 달력의 중립 원칙(DASHBOARD.md §2)은 그대로고, 이건 사용자가
    /// 직접 켠 플래그를 있는 그대로 보여주는 것뿐이다.
    pub remind: bool,
    /// 이 항목을 낳은 `note_dates` 행 id — position 0 이면 노트 자신의 사건 축(notes.* 투영),
    /// 아니면 관련 날짜. 달력 카드가 노트로 가지 않고 그 행을 바로 고치는 손잡이이자, 항목의
    /// 렌더 키다(한 노트의 관련 날짜 둘이 같은 날에 겹칠 수 있어 note_id 로는 못 가른다).
    pub date_id: String,
    /// 0 = 대표(사건 축), 그 외 = 관련 날짜. `kind` 는 event/span 만 말하므로(2026-09-10 §D4:
    /// "extra" 은퇴), 관련 날짜인지는 이 필드가 말한다.
    pub position: i64,
    /// 알림 시점(분 전). NULL = 정시.
    pub remind_offset_min: Option<i64>,
    /// 저장된 반복 규칙 — 회차 항목이면 그 회차를 낳은 규칙. 카드 요약 줄이 "매주 화" 를 쓴다.
    pub rrule: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CalendarResult {
    pub year: i64,
    pub month: i64,
    pub items: Vec<CalendarItem>,
}

/// Notes whose event span intersects the given calendar month.
///
/// Placement rules for partial precision (documented + tested):
/// - year only (month NULL): treated as whole year → Jan 1 .. Dec 31 of that year.
/// - year+month (day NULL): treated as whole month → 1st .. last day of that month.
/// - full day: single day (or span to end_* if set).
/// - end_* present: multi-day span; clipped to [month_start, month_end] in the response.
///
/// Dashboard Wave 2 (2026-08-01): due_at is gone — a former "independent due badge" is now just
/// this note's end_*, so it necessarily rides the same event-span row (end_* already feeds the
/// MIN/MAX month-key pushdown below); no separate OR-branch is needed anymore.
pub fn calendar(conn: &Connection, workspace_id: &str, year: i64, month: i64) -> AppResult<CalendarResult> {
    ensure_workspace(conn, workspace_id)?;
    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!(
            "month out of range (1..12): {month}"
        )));
    }
    let month_start = NaiveYmd {
        y: year,
        m: month as u32,
        d: 1,
    };
    let month_end = NaiveYmd {
        y: year,
        m: month as u32,
        d: days_in_month(year, month as u32),
    };
    let ms = month_start.to_ord();
    let me = month_end.to_ord();

    // SCALABILITY.md §0: don't load the whole workspace and filter in Rust — push the month
    // intersection into SQL. A note's "month key" (year*12 + month-1) mirrors resolve_start's
    // month.unwrap_or(1) and resolve_end's month.unwrap_or(12) defaulting exactly (day never
    // changes which month a date falls in, so month-key intersection is equivalent to the
    // day-precision intersection event_span_ords computes below — not an approximation).
    //
    // 2026-08-09 (V43): 그 MIN/MAX/CASE 식을 **인라인 술어에서 생성 컬럼으로** 옮겼다
    // (notes.span_month_lo / span_month_hi). 식은 글자 그대로 같지만 — MIN/MAX 가
    // event_span_ords 의 `if end < start` swap 을 그대로 흉내내는 것까지 — 술어가 순수 컬럼
    // 비교라 sargable 해져 idx_notes_span_month 를 탄다. 예전 형태는 표현식 술어라 달을 넘길
    // 때마다 notes 풀스캔이었다.
    //
    // rrule 분기도 OR 에서 **별도 쿼리**로 뽑았다: OR 한쪽만 인덱스를 타면 플래너가 결국 전체를
    // 훑기 때문에, `rrule IS NOT NULL` 부분 인덱스(idx_notes_rrule_span)로 소수 행만 따로 읽는다.
    let target_key = year * 12 + (month - 1);

    let mut items = Vec::new();

    // (1) 반복 없는 노트 — 스팬이 이 달과 겹치는 것만.
    let mut stmt = conn.prepare(SPAN_SQL).map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, target_key], map_cal_row)
        .map_err(dberr)?;
    for row in rows {
        push_row(&mut items, &row.map_err(dberr)?, ms, me);
    }

    // (2) 반복 노트 — seed 가 10년 전 한 달에만 걸려 있어도 이 달에 회차가 떨어지므로 스팬
    // 교집합으로 거를 수 없다(§6.3). 시작이 이 달 이전이기만 하면 후보로 올리고 실제 컷은
    // rrule 전개(UNTIL 포함)가 한다. 여기서 쓰는 하한은 예전의 "시작 월키"가 아니라
    // span_month_lo(= MIN(시작, 종료)) 인데, lo <= 시작 이므로 후보 집합은 **상위집합**이고,
    // 새로 딸려오는 행(시작이 이 달보다 뒤인 스왑 행)은 expand 가 seed 이전 날짜를 만들지 않아
    // 회차 0개가 된다 — 결과는 동치다.
    let mut stmt = conn.prepare(RRULE_SQL).map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, target_key], map_cal_row)
        .map_err(dberr)?;
    for row in rows {
        push_occurrences(&mut items, &row.map_err(dberr)?, ms, me);
    }

    // (3) 관련 날짜(note_dates position≠0, GRILL-2026-09-07 D2) — 2026-09-10 §D4 이후로는
    // (1)/(2) 와 **완전히 같은 경로**다: 행을 CalRow 로 읽어 반복이면 push_occurrences, 아니면
    // push_row. 예전 경로는 nd.year/month/day 한 점만 읽고 start_time 을 None 으로 못 박아
    // 시각·기간·부분 정밀도·반복 넷이 전부 빠져 있었다(§1.1). year/month/day/end_* 는 이제
    // 노트의 사건 축이 아니라 **이 행 자신의** 트리플이다 — 그래야 라벨/시간축이 맞는다.
    let mut stmt = conn.prepare(EXTRA_DATES_SQL).map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, target_key], map_cal_row)
        .map_err(dberr)?;
    for row in rows {
        let row = row.map_err(dberr)?;
        if row.rrule.is_some() {
            push_occurrences(&mut items, &row, ms, me);
        } else {
            push_row(&mut items, &row, ms, me);
        }
    }

    items.sort_by(|a, b| {
        a.span_start
            .cmp(&b.span_start)
            .then_with(|| a.note_id.cmp(&b.note_id))
            // 같은 노트의 관련 날짜 둘이 같은 날에 겹칠 수 있다 — 실행마다 순서가 흔들리지
            // 않도록 행 id 까지 내려간다(정렬은 전순서여야 한다).
            .then_with(|| a.date_id.cmp(&b.date_id))
    });

    Ok(CalendarResult {
        year,
        month,
        items,
    })
}

/// ?1 = workspace_id, ?2 = 조회 달의 월키. 두 쿼리 모두 상수로 두는 이유는 계획 회귀 테스트
/// (calendar_queries_ride_the_span_month_indexes)가 **같은 문자열**을 EXPLAIN 하기 위해서다.
/// 워크스페이스 스코프는 `JOIN folders` 가 아니라 semi-join 이고, 인덱스는 `INDEXED BY` 로
/// 못 박는다 — 둘 다 SCALABILITY.md §3 의 기존 판례를 그대로 따른 것이다:
/// - 조인 형태면 플래너가 folders 를 바깥 루프로 잡고 `idx_notes_folder` 로 안쪽을 훑는다.
///   단일 노트북 UI 에서 그건 곧 전체 노트 스캔이다(note_query/attachment_query 와 같은 함정).
/// - semi-join 으로 바꿔도 `folder_id = ?` 는 여전히 **등가 제약**이라, 통계가 없는 부팅 직후의
///   플래너는 스팬 **범위** 제약보다 그쪽을 싸게 본다(실측: 여전히 idx_notes_folder 선택).
///   `INDEXED BY idx_attachments_created`(attachment_query.rs)가 같은 이유로 붙어 있다.
/// 부분 인덱스라 `deleted_at IS NULL AND archived_at IS NULL` 은 여기서 뺄 수 없다 — 빼면
/// INDEXED BY 가 prepare 단계에서 실패한다(계약이 컴파일타임처럼 드러나는 셈).
/// 세 쿼리 모두 이 컬럼 순서로 내려온다(map_cal_row). 마지막 셋(date_id/position/
/// remind_offset_min)이 2026-09-10 §D4 가 더한 것이고, 노트 경로는 position 0 행의 id 를
/// 서브쿼리로 붙인다 — `idx_note_dates_note_id` 를 탄다(노트당 행 수가 소수라 점 조회다).
const SPAN_SQL: &str = "SELECT n.id, n.folder_id, n.title, n.year, n.month, n.day,
        n.end_year, n.end_month, n.end_day,
        n.start_time, n.end_time, n.rrule, n.remind,
        (SELECT id FROM note_dates WHERE note_id = n.id AND position = 0), 0, n.remind_offset_min
 FROM notes n INDEXED BY idx_notes_span_month
 -- W7-f: dashboard surface — archived notes hidden (search_notes still returns them).
 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
   AND n.span_month_hi >= ?2 AND n.span_month_lo <= ?2
   AND n.rrule IS NULL
   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)";

const RRULE_SQL: &str = "SELECT n.id, n.folder_id, n.title, n.year, n.month, n.day,
        n.end_year, n.end_month, n.end_day,
        n.start_time, n.end_time, n.rrule, n.remind,
        (SELECT id FROM note_dates WHERE note_id = n.id AND position = 0), 0, n.remind_offset_min
 FROM notes n INDEXED BY idx_notes_rrule_span
 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
   AND n.rrule IS NOT NULL
   AND n.span_month_lo <= ?2
   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)";

/// ?1 = workspace_id, ?2 = 조회 달의 월키 — 노트 경로와 **같은 파라미터, 같은 CalRow 모양**이다
/// (2026-09-10 §D4). `nd.position != 0` — position=0(대표)은 notes.* 로 투영되어 이미 (1)/(2)
/// 가 다루고, 여기서 또 잡히면 같은 항목이 두 번 나온다.
///
/// 월 교집합 술어는 notes.span_month_lo/hi 생성 컬럼 식을 **인라인으로 그대로 옮긴 것**이다
/// (migrations.rs V43_SQL — MIN/MAX 가 event_span_ords 의 swap 을 흉내내는 것까지 동일).
/// 반복 행은 노트 경로의 RRULE_SQL 과 같은 이유로 hi 제약을 걸지 않는다: seed 가 몇 년 전이어도
/// 이 달에 회차가 떨어지므로 실제 컷은 rrule 전개가 한다.
///
/// ponytail: note_dates 에는 생성 컬럼도 부분 인덱스도 없어 이 술어는 sargable 하지 않다 —
/// 관련 날짜가 노트당 소수라 전체 스캔이 여전히 싸기 때문이다. 관련 날짜가 수만 건이 되면
/// notes 가 V43 에서 한 것과 똑같이 span_month_lo/hi 생성 컬럼 + 부분 인덱스를 얹으면 된다.
const EXTRA_DATES_SQL: &str = "SELECT nd.note_id, n.folder_id, n.title, nd.year, nd.month, nd.day,
        nd.end_year, nd.end_month, nd.end_day,
        nd.start_time, nd.end_time, nd.rrule, nd.remind,
        nd.id, nd.position, nd.remind_offset_min
 FROM note_dates nd
 JOIN notes n ON n.id = nd.note_id
 JOIN folders f ON f.id = n.folder_id
 WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
   AND nd.position != 0
   AND MIN(nd.year * 12 + COALESCE(nd.month, 1) - 1,
           CASE WHEN nd.end_year IS NOT NULL THEN nd.end_year * 12 + COALESCE(nd.end_month, 12) - 1
                ELSE nd.year * 12 + COALESCE(nd.month, 12) - 1 END) <= ?2
   AND (nd.rrule IS NOT NULL
        OR MAX(nd.year * 12 + COALESCE(nd.month, 1) - 1,
               CASE WHEN nd.end_year IS NOT NULL THEN nd.end_year * 12 + COALESCE(nd.end_month, 12) - 1
                    ELSE nd.year * 12 + COALESCE(nd.month, 12) - 1 END) >= ?2)";

fn map_cal_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CalRow> {
    Ok(CalRow {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        title: r.get(2)?,
        year: r.get(3)?,
        month: r.get(4)?,
        day: r.get(5)?,
        end_year: r.get(6)?,
        end_month: r.get(7)?,
        end_day: r.get(8)?,
        start_time: r.get(9)?,
        end_time: r.get(10)?,
        rrule: r.get(11)?,
        remind: r.get::<_, i64>(12)? != 0,
        // 불변식(§7-2)상 모든 노트에 position 0 행이 있지만, 그게 깨진 DB 가 달력 조회 전체를
        // 죽이지는 않게 한다 — 그 항목만 손잡이 없는 채로 그려진다.
        date_id: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
        position: r.get(14)?,
        remind_offset_min: r.get(15)?,
        is_occurrence: None,
    })
}

#[derive(Clone)]
struct CalRow {
    id: String,
    folder_id: String,
    title: String,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    rrule: Option<String>,
    remind: bool,
    date_id: String,
    position: i64,
    remind_offset_min: Option<i64>,
    /// DB 컬럼이 아니다 — push_occurrences 가 회차마다 세우는 파생 플래그. 회차도 결국
    /// push_row 를 지나므로(항목 생성 지점이 하나여야 한다) 행에 실어 나른다.
    is_occurrence: Option<bool>,
}

/// 행 하나 → 이 달에 걸릴 때만 항목 하나. **세 결과 집합(대표·반복 회차·관련 날짜)이 모두 여기를
/// 지난다** — kind 의 event/span 규칙이 한 곳에만 있으라고(2026-09-10 §D4).
fn push_row(items: &mut Vec<CalendarItem>, row: &CalRow, ms: i64, me: i64) {
    let Some((start, end)) = event_span_ords(row) else {
        return;
    };
    if start > me || end < ms {
        return;
    }
    items.push(CalendarItem {
        note_id: row.id.clone(),
        folder_id: row.folder_id.clone(),
        title: row.title.clone(),
        kind: if start == end && row.end_year.is_none() { "event".into() } else { "span".into() },
        span_start: ord_to_ymd(start.max(ms)).to_iso(),
        span_end: ord_to_ymd(end.min(me)).to_iso(),
        year: row.year,
        month: row.month,
        day: row.day,
        end_year: row.end_year,
        end_month: row.end_month,
        end_day: row.end_day,
        start_time: row.start_time.clone(),
        end_time: row.end_time.clone(),
        is_occurrence: row.is_occurrence,
        remind: row.remind,
        date_id: row.date_id.clone(),
        position: row.position,
        remind_offset_min: row.remind_offset_min,
        rrule: row.rrule.clone(),
    });
}

/// 반복 노트의 seed — 시작 트리플이 연월일 풀 정밀도일 때만. `set_schedule` 의 I4 가 저장 시점에
/// 이걸 강제하지만, 손상된 행이 조회를 죽이지 않도록 여기서도 확인한다.
fn seed_ymd(row: &CalRow) -> Option<NaiveYmd> {
    let (m, d) = (row.month?, row.day?);
    if !(1..=12).contains(&m) {
        return None;
    }
    let (m, d) = (m as u32, d as u32);
    if d < 1 || d > days_in_month(row.year, m) {
        return None;
    }
    Some(NaiveYmd { y: row.year, m, d })
}

/// 반복 노트를 이 달의 회차들로 전개한다(§6.3) — DB 에는 행이 없고 조회 응답에만 존재한다.
///
/// `end_*` 는 반복이 붙어도 여전히 **한 회차의 기간**이다(V42 주석·§3.2). 그래서 각 회차는
/// `[occ, occ + duration_days]` 스팬이고, 월 클리핑은 반복 없는 경로와 글자 그대로 같다.
///
/// §3.4 widen-then-clip: `expand` 는 duration 을 모르는 순수 함수라 "이 달에 걸치기만 하는 회차"
/// (지난달에 시작해 이 달까지 이어지는 것)를 스스로 잡지 못한다 — 하한을 duration 만큼 넓혀
/// 부르고 결과 스팬을 다시 자르는 것이 호출자인 여기의 몫이다.
///
/// 회차의 `year/month/day`(+`end_*`)는 seed 가 아니라 **그 회차의 날짜**로 채운다. 이 필드들은
/// "raw event-axis fields (for client labels)" 이고, 상세 카드가 8월 회차에 1월(seed) 날짜를
/// 찍으면 그냥 틀린 라벨이 된다.
///
/// 저장된 rrule 이 파싱되지 않으면 회차 0개다 — schedule/mod.rs::fire_times 와 같은 자세
/// (손상된 규칙을 "매일"처럼 취급해 엉뚱한 날 그리는 쪽이 더 나쁘다).
fn push_occurrences(items: &mut Vec<CalendarItem>, row: &CalRow, ms: i64, me: i64) {
    let (Some(seed), Some(src)) = (seed_ymd(row), row.rrule.as_deref()) else {
        return;
    };
    let (Ok(parts), Some((s0, e0))) = (rrule::parse(src), event_span_ords(row)) else {
        return;
    };
    let duration = e0 - s0;
    // Widen-then-clip's lower bound must stay finite regardless of a note's raw duration: widening
    // by the full (possibly huge — years-long) duration used to scale expand()'s search range with
    // duration instead of the query window, silently hitting OCCURRENCE_CAP=400 for long-span
    // daily/weekly repeats (the dropped occurrences included ones that actually fall in this
    // month, since expand generates in date order from the widened lower bound). Clamping the
    // widen amount to the window's own length (`me - ms`) bounds the widened range to at most
    // 2x the window (~62 days worst case for a 31-day month) — nowhere near the cap regardless of
    // frequency (see calendar_wide_duration_repeat_never_hits_the_occurrence_cap). Trade-off: an
    // occurrence whose real duration is longer than the window AND starts further back than the
    // window's length before `ms` won't be found — an accepted approximation (recurring events
    // aren't expected to individually span longer than the view window) rather than the unbounded
    // cap-and-silently-drop this replaces.
    let widen = duration.min(me - ms);
    let (dates, capped) = rrule::expand(&parts, seed, ord_to_ymd(ms - widen), ord_to_ymd(me));
    debug_assert!(
        !capped,
        "calendar month-window widen must never reach OCCURRENCE_CAP — widen is bounded by \
         (me - ms), so (hi - lo) can't exceed ~2x a month's length"
    );
    for occ in dates {
        let occ_end = row.end_year.is_some().then(|| ord_to_ymd(occ.to_ord() + duration));
        // 회차도 push_row 를 지난다(§D4: 항목 생성 지점 하나) — 트리플만 그 회차의 것으로
        // 갈아끼운 행을 넘긴다. event_span_ords 가 다시 계산해도 [occ, occ+duration] 그대로다.
        push_row(
            items,
            &CalRow {
                year: occ.y,
                month: Some(occ.m as i64),
                day: Some(occ.d as i64),
                end_year: occ_end.map(|d| d.y),
                end_month: occ_end.map(|d| d.m as i64),
                end_day: occ_end.map(|d| d.d as i64),
                is_occurrence: Some(true),
                ..row.clone()
            },
            ms,
            me,
        );
    }
}

/// Inclusive ordinal day span for a note's event axis. None if unusable.
fn event_span_ords(row: &CalRow) -> Option<(i64, i64)> {
    let start = resolve_start(row.year, row.month, row.day)?;
    let end = if let Some(ey) = row.end_year {
        resolve_end(ey, row.end_month, row.end_day)?
    } else {
        // No end: point expands to full precision unit (year → whole year, month → whole month).
        resolve_end(row.year, row.month, row.day)?
    };
    if end < start {
        return Some((end, start));
    }
    Some((start, end))
}

fn resolve_start(year: i64, month: Option<i64>, day: Option<i64>) -> Option<i64> {
    let m = month.unwrap_or(1) as u32;
    let d = day.unwrap_or(1);
    if !(1..=12).contains(&(m as i64)) {
        return None;
    }
    let max_d = days_in_month(year, m) as i64;
    let d = d.clamp(1, max_d) as u32;
    Some(
        NaiveYmd {
            y: year,
            m,
            d,
        }
        .to_ord(),
    )
}

fn resolve_end(year: i64, month: Option<i64>, day: Option<i64>) -> Option<i64> {
    let m = month.unwrap_or(12) as u32;
    if !(1..=12).contains(&(m as i64)) {
        return None;
    }
    let max_d = days_in_month(year, m);
    let d = match day {
        Some(d) => (d as u32).clamp(1, max_d),
        None => max_d,
    };
    Some(
        NaiveYmd {
            y: year,
            m,
            d,
        }
        .to_ord(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;
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

    // ── calendar ───────────────────────────────────────────────────────────

    #[test]
    fn calendar_clips_span_across_month_boundary() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn,
            &folder,
            Some("War".into()),
            Some(1794),
            Some(12),
            Some(20),
            None,
            None,
        )
        .unwrap();
        notes::set_event_end(&mut conn, &d.note.id, Some(1795), Some(1), Some(10)).unwrap();

        let dec = calendar(&conn, &ws, 1794, 12).unwrap();
        let item = dec
            .items
            .iter()
            .find(|i| i.note_id == d.note.id && i.kind == "span")
            .expect("span in Dec");
        assert_eq!(item.span_start, "1794-12-20");
        assert_eq!(item.span_end, "1794-12-31");

        let jan = calendar(&conn, &ws, 1795, 1).unwrap();
        let item = jan
            .items
            .iter()
            .find(|i| i.note_id == d.note.id && i.kind == "span")
            .expect("span in Jan");
        assert_eq!(item.span_start, "1795-01-01");
        assert_eq!(item.span_end, "1795-01-10");
    }

    #[test]
    fn calendar_year_only_note_hits_every_month() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        // year only: month/day NULL
        let d = notes::create_with_timestamp(
            &mut conn,
            &folder,
            Some("Year only".into()),
            Some(1500),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(d.note.month.is_none());

        let jul = calendar(&conn, &ws, 1500, 7).unwrap();
        let hit = jul.items.iter().find(|i| i.note_id == d.note.id);
        assert!(hit.is_some(), "year-only 1500 must appear in July 1500");
        assert_eq!(hit.unwrap().span_start, "1500-07-01");
        assert_eq!(hit.unwrap().span_end, "1500-07-31");

        let other = calendar(&conn, &ws, 1501, 7).unwrap();
        assert!(!other.items.iter().any(|i| i.note_id == d.note.id));
    }

    /// Dashboard Wave 2 (2026-08-01): due_at is gone. What used to be an "independent due badge"
    /// (kind="due", a separate item unrelated to the event axis) is now literally the note's
    /// end_* — it necessarily rides the *same* event-span item, on whatever month that span
    /// actually intersects (no more fabricated event-year cameo in an unrelated month).
    #[test]
    fn calendar_end_triple_no_longer_produces_a_separate_due_item() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn,
            &folder,
            Some("Deadline-ish".into()),
            Some(2026),
            Some(7),
            Some(1),
            None,
            None,
        )
        .unwrap();
        notes::set_event_end(&mut conn, &d.note.id, Some(2026), Some(7), Some(15)).unwrap();

        let jul = calendar(&conn, &ws, 2026, 7).unwrap();
        let matches: Vec<&CalendarItem> =
            jul.items.iter().filter(|i| i.note_id == d.note.id).collect();
        assert_eq!(matches.len(), 1, "one item per note — no separate due chip");
        assert_eq!(matches[0].kind, "span");
        assert_eq!(matches[0].span_start, "2026-07-01");
        assert_eq!(matches[0].span_end, "2026-07-15");
    }

    #[test]
    fn calendar_month_pushdown_excludes_out_of_month_notes() {
        // calendar() pushes the month-intersection filter into SQL (SCALABILITY.md §0) instead
        // of loading the whole workspace and filtering in Rust. This asserts the *result* is
        // still exactly what row-by-row filtering would produce — the query never returns
        // notes outside the requested month.
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);

        let hit = notes::create_with_timestamp(
            &mut conn, &folder, Some("hit".into()), Some(2000), Some(6), Some(15), None, None,
        )
        .unwrap();
        // Same year, different month — must not appear.
        let miss_month = notes::create_with_timestamp(
            &mut conn, &folder, Some("miss month".into()), Some(2000), Some(1), Some(1), None,
            None,
        )
        .unwrap();
        // Same month/day, different year — must not appear.
        let miss_year = notes::create_with_timestamp(
            &mut conn, &folder, Some("miss year".into()), Some(1999), Some(6), Some(15), None,
            None,
        )
        .unwrap();
        // Span with end_year set but end_month NULL (year-precision end) — resolve_end defaults
        // end_month to 12, so the SQL month-key's ELSE branch must not kick in here (that's only
        // for the *no end_year at all* case): the span should reach December of end_year, not
        // just June (COALESCE(n.end_month, 12) with n.end_year present).
        let end_year_only = notes::create_with_timestamp(
            &mut conn, &folder, Some("end year only".into()), Some(1998), None, None, None, None,
        )
        .unwrap();
        notes::set_event_end(&mut conn, &end_year_only.note.id, Some(2000), None, None).unwrap();

        let result = calendar(&conn, &ws, 2000, 6).unwrap();
        let ids: Vec<&str> = result.items.iter().map(|i| i.note_id.as_str()).collect();
        assert!(ids.contains(&hit.note.id.as_str()));
        assert!(!ids.contains(&miss_month.note.id.as_str()));
        assert!(!ids.contains(&miss_year.note.id.as_str()));
        assert!(
            ids.contains(&end_year_only.note.id.as_str()),
            "span with end_year=2000/end_month=NULL must still reach June 2000 \
             (end resolves to Dec 2000, not Dec 1998)"
        );

        // ...and December (target month = end_year's default-December end) still hits, while
        // the following January does not — pins the COALESCE(end_month, 12) default exactly.
        let dec = calendar(&conn, &ws, 2000, 12).unwrap();
        assert!(dec
            .items
            .iter()
            .any(|i| i.note_id == end_year_only.note.id));
        let next_jan = calendar(&conn, &ws, 2001, 1).unwrap();
        assert!(!next_jan
            .items
            .iter()
            .any(|i| i.note_id == end_year_only.note.id));
    }

    /// V43 (SCALABILITY.md §0): 두 조회 쿼리가 실제로 인덱스를 타는지 — 이 웨이브의 존재 이유가
    /// "달을 넘길 때마다 notes 풀스캔하지 않는다" 이므로 결과가 아니라 **계획**을 고정한다.
    /// (예전 MIN/MAX/CASE 인라인 술어는 어떤 인덱스도 못 타서 여기서 SCAN n 이 나왔다.)
    #[test]
    fn calendar_queries_ride_the_span_month_indexes() {
        let conn = setup_db();
        let plan = |sql: &str| -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let rows: Vec<String> = stmt
                .query_map(params!["ws", 0i64], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows.join(" | ")
        };
        let span = plan(SPAN_SQL);
        println!("calendar span plan: {span}");
        assert!(
            span.contains("idx_notes_span_month"),
            "월 교집합 쿼리가 span 인덱스를 타야 한다: {span}"
        );
        let rrule = plan(RRULE_SQL);
        println!("calendar rrule plan: {rrule}");
        assert!(
            rrule.contains("idx_notes_rrule_span"),
            "반복 쿼리가 rrule 부분 인덱스를 타야 한다: {rrule}"
        );
    }

    /// 경계: 저장된 종료가 시작보다 과거인 행(쓰기 검증이 잡지 못하는 손상/역전 케이스). 생성
    /// 컬럼의 MIN/MAX 가 event_span_ords 의 swap 과 같은 구간을 만들어야 하므로, 두 날짜 **사이의**
    /// 달에서 잡히고 바깥 달에서는 안 잡혀야 한다 — 예전 인라인 MIN/MAX 술어와 동치.
    #[test]
    fn calendar_swapped_end_before_start_still_matches_the_months_between() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let id = notes::create_with_timestamp(
            &mut conn, &folder, Some("역전".into()), Some(2000), Some(6), Some(15), None, None,
        )
        .unwrap()
        .note
        .id;
        // set_event_end 는 start<=end 를 강제하므로 직접 UPDATE (손상 행 재현).
        conn.execute(
            "UPDATE notes SET end_year=1999, end_month=3, end_day=1 WHERE id=?1",
            params![id],
        )
        .unwrap();

        for (y, m) in [(1999, 3), (1999, 12), (2000, 6)] {
            let res = calendar(&conn, &ws, y, m).unwrap();
            assert!(
                res.items.iter().any(|i| i.note_id == id),
                "{y}-{m} 은 [1999-03, 2000-06] 구간 안이라 잡혀야 한다"
            );
        }
        for (y, m) in [(1999, 2), (2000, 7)] {
            let res = calendar(&conn, &ws, y, m).unwrap();
            assert!(
                !res.items.iter().any(|i| i.note_id == id),
                "{y}-{m} 은 구간 밖이라 잡히면 안 된다"
            );
        }
    }

    // ── 시각 필드 · 반복 전개 (W5-5, §6.3) ─────────────────────────────────

    /// 시작 트리플 + (선택) 종료 트리플 + 일정 컬럼을 직접 세운다. 커맨드 경로의 I1~I5 는 W5-1 이
    /// 이미 검증하므로 여기서는 조회 쪽 전개만 본다(schedule/mod.rs 의 테스트 헬퍼와 같은 자세).
    fn sched(
        conn: &mut Connection,
        folder: &str,
        title: &str,
        start: (i64, i64, i64),
        end: Option<(i64, i64, i64)>,
        start_time: Option<&str>,
        rrule: Option<&str>,
    ) -> String {
        let id = notes::create_with_timestamp(
            conn, folder, Some(title.into()), Some(start.0), Some(start.1), Some(start.2), None, None,
        )
        .unwrap()
        .note
        .id;
        conn.execute(
            "UPDATE notes SET end_year=?1, end_month=?2, end_day=?3, start_time=?4, rrule=?5 WHERE id=?6",
            params![
                end.map(|e| e.0),
                end.map(|e| e.1),
                end.map(|e| e.2),
                start_time,
                rrule,
                id
            ],
        )
        .unwrap();
        id
    }

    fn spans(res: &CalendarResult, note_id: &str) -> Vec<(String, String)> {
        res.items
            .iter()
            .filter(|i| i.note_id == note_id)
            .map(|i| (i.span_start.clone(), i.span_end.clone()))
            .collect()
    }

    #[test]
    fn calendar_carries_the_time_fields_and_leaves_is_occurrence_unset() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let timed = sched(&mut conn, &folder, "미팅", (2026, 8, 9), None, Some("09:00"), None);
        conn.execute("UPDATE notes SET end_time='10:30' WHERE id=?1", params![timed]).unwrap();
        let all_day = sched(&mut conn, &folder, "여행", (2026, 8, 1), Some((2026, 8, 12)), None, None);

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let t = aug.items.iter().find(|i| i.note_id == timed).unwrap();
        assert_eq!(t.start_time.as_deref(), Some("09:00"));
        assert_eq!(t.end_time.as_deref(), Some("10:30"));
        assert_eq!(t.is_occurrence, None, "반복이 아닌 항목에는 붙지 않는다");
        let a = aug.items.iter().find(|i| i.note_id == all_day).unwrap();
        assert_eq!(a.start_time, None, "종일 = start_time NULL (하루뷰 분기 기준)");
    }

    #[test]
    fn calendar_carries_the_remind_flag_for_notes_and_extra_dates() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let quiet = sched(&mut conn, &folder, "조용", (2026, 8, 3), None, None, None);
        let loud = sched(&mut conn, &folder, "알림", (2026, 8, 9), None, None, None);
        conn.execute("UPDATE notes SET remind=1 WHERE id=?1", params![loud]).unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        assert!(!aug.items.iter().find(|i| i.note_id == quiet).unwrap().remind);
        assert!(aug.items.iter().find(|i| i.note_id == loud).unwrap().remind, "notes.remind 가 그대로 실린다");
    }

    #[test]
    fn calendar_expands_repeats_into_one_item_per_occurrence() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        // 2026-08-03 은 월요일. 매주 월·수.
        let id = sched(
            &mut conn,
            &folder,
            "스탠드업",
            (2026, 8, 3),
            None,
            Some("10:00"),
            Some("FREQ=WEEKLY;BYDAY=MO,WE"),
        );
        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let days: Vec<String> = spans(&aug, &id).into_iter().map(|(s, _)| s).collect();
        assert_eq!(
            days,
            vec![
                "2026-08-03", "2026-08-05", "2026-08-10", "2026-08-12", "2026-08-17", "2026-08-19",
                "2026-08-24", "2026-08-26", "2026-08-31",
            ]
        );
        assert!(aug.items.iter().filter(|i| i.note_id == id).all(|i| {
            i.is_occurrence == Some(true) && i.kind == "event" && i.start_time.as_deref() == Some("10:00")
        }));
    }

    /// seed 가 조회 달과 무관한 과거 달이어도 회차는 나온다 — SQL 의 스팬 교집합 pushdown 만
    /// 있었다면 후보 자체가 걸러졌을 케이스(이 웨이브에서 OR 분기를 더한 이유).
    #[test]
    fn calendar_finds_occurrences_whose_seed_month_is_years_earlier() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let id = sched(&mut conn, &folder, "월간 보고", (2016, 1, 15), None, Some("14:00"), Some("FREQ=MONTHLY"));
        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        assert_eq!(spans(&aug, &id), vec![("2026-08-15".into(), "2026-08-15".into())]);
        // 회차의 raw 트리플은 seed(2016-01-15)가 아니라 그 회차의 날짜다 — 상세 카드 라벨용.
        let it = aug.items.iter().find(|i| i.note_id == id).unwrap();
        assert_eq!((it.year, it.month, it.day), (2026, Some(8), Some(15)));
    }

    /// §3.4 widen-then-clip: 다일 회차가 **지난달에 시작해** 이 달로 넘어오는 경우. expand 는
    /// duration 을 모르므로 하한을 넓혀 부르는 것이 호출자의 몫이고, 여기서 빠지면 8/1~8/2 가
    /// 통째로 사라진다.
    #[test]
    fn calendar_clips_a_multi_day_occurrence_that_starts_in_the_previous_month() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        // 매월 30일 시작, 3일짜리(30·31·1... 8월이면 7/30~8/1).
        let id = sched(
            &mut conn,
            &folder,
            "정산",
            (2026, 7, 30),
            Some((2026, 8, 1)),
            None,
            Some("FREQ=MONTHLY"),
        );
        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        assert_eq!(
            spans(&aug, &id),
            vec![
                // 7/30 시작 회차의 꼬리 — 월 시작으로 잘려 들어온다.
                ("2026-08-01".into(), "2026-08-01".into()),
                // 8/30 시작 회차 — 월 끝으로 잘린다(9/1 은 9월 조회에서 다시 나온다).
                ("2026-08-30".into(), "2026-08-31".into()),
            ]
        );
        assert!(aug.items.iter().filter(|i| i.note_id == id).all(|i| i.kind == "span"));

        let sep = calendar(&conn, &ws, 2026, 9).unwrap();
        assert_eq!(
            spans(&sep, &id),
            vec![
                ("2026-09-01".into(), "2026-09-01".into()),
                ("2026-09-30".into(), "2026-09-30".into()),
            ]
        );
    }

    /// Regression: a note whose single-occurrence duration is huge (years, not days) must not
    /// widen expand()'s search range past OCCURRENCE_CAP=400. Before the fix, the widen amount
    /// scaled with the note's raw duration instead of the query window's own length, so a
    /// long-span daily repeat could reach the cap and silently drop occurrences that actually
    /// fall in the queried month. Calls push_occurrences directly (not the public calendar()) so
    /// the assertion is about the search range staying bounded, not about how many phantom
    /// overlapping items a deliberately pathological (3-year-long, daily-repeating) note produces.
    /// debug_assert!(!capped) inside push_occurrences also catches any regression here, since
    /// tests run with debug assertions on — this test would panic, not just fail an assert.
    #[test]
    fn calendar_wide_duration_repeat_never_hits_the_occurrence_cap() {
        let ms = NaiveYmd { y: 2026, m: 8, d: 1 }.to_ord();
        let me = NaiveYmd { y: 2026, m: 8, d: 31 }.to_ord();
        let row = CalRow {
            id: "n1".into(),
            folder_id: "f1".into(),
            title: "장기 반복".into(),
            year: 2020,
            month: Some(1),
            day: Some(1),
            end_year: Some(2023), // ~1096-day single-occurrence duration
            end_month: Some(1),
            end_day: Some(1),
            start_time: None,
            end_time: None,
            rrule: Some("FREQ=DAILY".into()),
            remind: false,
            date_id: "d1".into(),
            position: 0,
            remind_offset_min: None,
            is_occurrence: None,
        };
        let mut items = Vec::new();
        push_occurrences(&mut items, &row, ms, me);
        // Worst case for the fixed clamp is ~2x a month's length (window + window); nowhere near
        // OCCURRENCE_CAP=400 regardless of the note's actual (huge) duration.
        assert!(
            items.len() <= 2 * 31,
            "widened search range must stay bounded by the query window, not the note's duration: got {} items",
            items.len()
        );
    }

    #[test]
    fn calendar_repeat_stops_at_until_and_ignores_a_corrupt_rule() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let stops = sched(
            &mut conn,
            &folder,
            "약",
            (2026, 8, 1),
            None,
            Some("08:00"),
            Some("FREQ=DAILY;UNTIL=20260803"),
        );
        let broken = sched(&mut conn, &folder, "손상", (2026, 8, 5), None, None, Some("FREQ=HOURLY"));

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        assert_eq!(spans(&aug, &stops).len(), 3, "UNTIL 은 포함 경계 (8/1·8/2·8/3)");
        assert!(
            spans(&aug, &broken).is_empty(),
            "손상된 규칙은 회차 0개 — '매일'처럼 취급해 엉뚱한 날 그리지 않는다"
        );
    }

    // ── 추가 날짜(note_dates, GRILL-2026-09-07 D2) ───────────────────────────

    /// 관련 날짜 항목만 추린다 — 2026-09-10 §D4 이후 kind 는 event/span 뿐이라("extra" 은퇴)
    /// 관련 날짜인지는 position 이 말한다.
    fn related<'a>(res: &'a CalendarResult, note_id: &str) -> Vec<&'a CalendarItem> {
        res.items
            .iter()
            .filter(|i| i.note_id == note_id && i.position != 0)
            .collect()
    }

    #[test]
    fn calendar_surfaces_note_dates_only_in_their_own_month() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("발표".into()), Some(2026), Some(7), Some(1), None, None,
        )
        .unwrap();
        let id15 = notes::date_add(&mut conn, &d.note.id, 2026, Some(8), Some(15), None, None, None, None, None, false, None, None, None).unwrap();
        notes::date_add(&mut conn, &d.note.id, 2026, Some(8), Some(20), None, None, None, None, None, false, None, None, None).unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let extras = related(&aug, &d.note.id);
        assert_eq!(extras.len(), 2, "8월엔 관련 날짜 2건 모두 나와야 한다");
        let e15 = extras.iter().find(|i| i.span_start == "2026-08-15").unwrap();
        assert_eq!(e15.span_end, "2026-08-15");
        assert_eq!(e15.kind, "event", "한 점짜리 관련 날짜는 대표와 같은 event 규칙을 받는다");
        // 2026-09-07 오너 결정: 라벨 제거 — 관련 날짜는 다른 항목과 마찬가지로 노트 제목으로
        // 표시된다(specs/commands/notes.yaml::note_date_add).
        assert_eq!(e15.title, "발표");
        // §D4: year/month/day 는 이제 **그 행 자신의** 트리플이다(예전엔 노트의 사건 축인 7/1 을
        // 실어 라벨이 틀렸다). 카드가 노트로 가지 않고 고칠 손잡이 date_id 도 함께 온다.
        assert_eq!((e15.year, e15.month, e15.day), (2026, Some(8), Some(15)));
        assert_eq!(e15.date_id, id15);
        let e20 = extras.iter().find(|i| i.span_start == "2026-08-20").unwrap();
        assert_eq!(e20.title, "발표", "같은 노트의 서로 다른 관련 날짜도 같은 제목으로 나온다");
        assert_ne!(e20.date_id, e15.date_id, "행마다 다른 date_id — 렌더 키가 갈린다");

        // 7월(노트의 대표 사건 축이 걸리는 달)에는 관련 날짜 항목이 없다 — 자기 달에만.
        let jul = calendar(&conn, &ws, 2026, 7).unwrap();
        assert!(related(&jul, &d.note.id).is_empty());
        let primary = jul.items.iter().find(|i| i.note_id == d.note.id).unwrap();
        assert_eq!((primary.kind.as_str(), primary.position), ("event", 0));
        assert!(!primary.date_id.is_empty(), "대표 항목도 position 0 행의 id 를 싣는다");

        // 9월에는 아무것도 없다.
        let sep = calendar(&conn, &ws, 2026, 9).unwrap();
        assert!(!sep.items.iter().any(|i| i.note_id == d.note.id));
    }

    // ── §1.1 결함 넷 (2026-09-10 §D4) — 관련 날짜가 노트 경로를 그대로 탄다 ──────────────
    //
    // 넷 다 "EXTRA_DATES_SQL 이 nd.year/month/day 한 점만 읽고 start_time 을 None 으로 하드코딩"
    // 했던 데서 왔다. 아래 넷은 각각 하나씩 고정한다.

    /// 결함 ①: 관련 날짜의 **시각**이 실리지 않아 종일 띠로 가던 것.
    #[test]
    fn calendar_related_date_carries_its_own_times() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("치과".into()), Some(2026), Some(7), Some(1), None, None,
        )
        .unwrap();
        notes::date_add(
            &mut conn, &d.note.id, 2026, Some(8), Some(15), None, None, None,
            Some("14:30".into()), Some("15:00".into()), true, Some(10), None, None,
        )
        .unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let it = related(&aug, &d.note.id)[0];
        assert_eq!(it.start_time.as_deref(), Some("14:30"), "시간축(§6.2)의 분기 기준");
        assert_eq!(it.end_time.as_deref(), Some("15:00"));
        assert!(it.remind, "알림 플래그도 그 행의 것");
        assert_eq!(it.remind_offset_min, Some(10));
    }

    /// 결함 ②: 관련 날짜의 **기간**(end_*)이 하루로 찍히던 것.
    #[test]
    fn calendar_related_date_spans_its_own_end_triple() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("여행".into()), Some(2026), Some(7), Some(1), None, None,
        )
        .unwrap();
        notes::date_add(
            &mut conn, &d.note.id, 2026, Some(8), Some(28), Some(2026), Some(9), Some(3),
            None, None, false, None, None, None,
        )
        .unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let it = related(&aug, &d.note.id)[0];
        assert_eq!(it.kind, "span");
        assert_eq!((it.span_start.as_str(), it.span_end.as_str()), ("2026-08-28", "2026-08-31"));
        // 달을 넘긴 꼬리도 노트 경로와 똑같이 다음 달에서 잘려 나온다(예전엔 8월 하루뿐이었다).
        let sep = calendar(&conn, &ws, 2026, 9).unwrap();
        let tail = related(&sep, &d.note.id)[0];
        assert_eq!((tail.span_start.as_str(), tail.span_end.as_str()), ("2026-09-01", "2026-09-03"));
    }

    /// 결함 ③: **부분 정밀도**(월/일 NULL)가 printf 로 "2026-00-00" 이 되어 아예 빠지던 것.
    #[test]
    fn calendar_related_date_with_partial_precision_covers_its_unit() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("연표".into()), Some(2026), Some(7), Some(1), None, None,
        )
        .unwrap();
        // 연 정밀도(월/일 NULL) + 월 정밀도(일 NULL) — 각각 그 해/그 달 전체를 덮는다.
        notes::date_add(&mut conn, &d.note.id, 1999, None, None, None, None, None, None, None, false, None, None, None).unwrap();
        notes::date_add(&mut conn, &d.note.id, 2026, Some(8), None, None, None, None, None, None, false, None, None, None).unwrap();

        let jul99 = calendar(&conn, &ws, 1999, 7).unwrap();
        let y = related(&jul99, &d.note.id);
        assert_eq!(y.len(), 1, "연 정밀도 관련 날짜는 그 해 아무 달에나 걸린다");
        assert_eq!((y[0].span_start.as_str(), y[0].span_end.as_str()), ("1999-07-01", "1999-07-31"));

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let m = related(&aug, &d.note.id);
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].span_start.as_str(), m[0].span_end.as_str()), ("2026-08-01", "2026-08-31"));

        // 2000년 7월엔 어느 쪽도 걸리지 않는다 — 월키 술어가 실제로 자른다.
        assert!(related(&calendar(&conn, &ws, 2000, 7).unwrap(), &d.note.id).is_empty());
    }

    /// 결함 ④: 관련 날짜의 **반복**(rrule)이 전개되지 않던 것 — RRULE_SQL 은 notes.rrule 만 봤다.
    #[test]
    fn calendar_expands_a_related_dates_rrule() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("스케일링".into()), Some(2026), Some(1), Some(1), None, None,
        )
        .unwrap();
        // 2026-08-04 는 화요일. 매주 화 — seed 달(8월)뿐 아니라 다음 달에도 회차가 떨어져야 한다.
        notes::date_add(
            &mut conn, &d.note.id, 2026, Some(8), Some(4), None, None, None,
            Some("14:30".into()), None, false, None, Some("FREQ=WEEKLY;BYDAY=TU".into()), None,
        )
        .unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        let days: Vec<&str> = related(&aug, &d.note.id).iter().map(|i| i.span_start.as_str()).collect();
        assert_eq!(days, vec!["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25"]);
        assert!(related(&aug, &d.note.id).iter().all(|i| {
            i.is_occurrence == Some(true)
                && i.start_time.as_deref() == Some("14:30")
                && i.rrule.as_deref() == Some("FREQ=WEEKLY;BYDAY=TU")
        }));

        // 9월 — seed 달이 아닌데도 회차가 나온다(예전엔 8월조차 한 점이었다).
        let sep = calendar(&conn, &ws, 2026, 9).unwrap();
        let days: Vec<&str> = related(&sep, &d.note.id).iter().map(|i| i.span_start.as_str()).collect();
        assert_eq!(days, vec!["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]);
    }

    #[test]
    fn calendar_hides_extra_dates_of_archived_or_deleted_notes() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let d = notes::create_with_timestamp(
            &mut conn, &folder, Some("보관됨".into()), Some(2026), Some(7), Some(1), None, None,
        )
        .unwrap();
        notes::date_add(&mut conn, &d.note.id, 2026, Some(8), Some(15), None, None, None, None, None, false, None, None, None).unwrap();
        conn.execute("UPDATE notes SET archived_at='x' WHERE id=?1", [&d.note.id]).unwrap();

        let aug = calendar(&conn, &ws, 2026, 8).unwrap();
        assert!(!aug.items.iter().any(|i| i.note_id == d.note.id));
    }
}
