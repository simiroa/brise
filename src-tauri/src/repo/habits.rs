// 브리핑 습관 — specs/db/schemas/habits.sql, specs/commands/habits.yaml (PLAN-2026-09-30-briefing).
// 시간 없이 날짜별로 체크한다. `timeline_routine`(시간축 반복 블록)·`routine`(노트-연결 반복 체크)와
// 별개 — 혼동 금지. 날짜는 전부 로컬일 'YYYY-MM-DD' 문자열이고 서버는 시계를 보지 않는다.
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::{Habit, HabitDay, HabitHistory, HabitHistoryDay, HabitWeek, HabitWeekRow};
use crate::util::{new_id, now_iso};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

const SELECT_COLUMNS: &str =
    "id, workspace_id, title, icon, hue, weekday_mask, position, archived_at, created_at, time_of_day";

fn row_to_habit(row: &rusqlite::Row) -> rusqlite::Result<Habit> {
    Ok(Habit {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        icon: row.get(3)?,
        hue: row.get(4)?,
        weekday_mask: row.get(5)?,
        position: row.get(6)?,
        archived_at: row.get(7)?,
        created_at: row.get(8)?,
        time_of_day: row.get(9)?,
    })
}

/// 보관되지 않은 습관, position asc(동률은 created_at·id 로 고정 — 실행마다 흔들리지 않게).
pub fn list(conn: &Connection, workspace_id: &str) -> AppResult<Vec<Habit>> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM habits WHERE workspace_id=?1 AND archived_at IS NULL
         ORDER BY position ASC, created_at ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt.query_map([workspace_id], row_to_habit).map_err(dberr)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(dberr)
}

fn get(conn: &Connection, id: &str) -> AppResult<Option<Habit>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM habits WHERE id=?1");
    conn.query_row(&sql, [id], row_to_habit).optional().map_err(dberr)
}

fn validate_mask(mask: i64) -> AppResult<()> {
    if (1..=127).contains(&mask) {
        Ok(())
    } else {
        Err(AppError::Validation(format!("weekday_mask out of range (1..127): {mask}")))
    }
}

fn validate_time_of_day(v: &str) -> AppResult<()> {
    if matches!(v, "any" | "morning" | "evening") {
        Ok(())
    } else {
        Err(AppError::Validation(format!("time_of_day must be any|morning|evening: {v}")))
    }
}

fn clean_title(title: &str) -> AppResult<String> {
    let t = title.trim();
    if t.is_empty() {
        return Err(AppError::Validation("title must not be empty".to_string()));
    }
    Ok(t.to_string())
}

/// 'YYYY-MM-DD' 만 받는다. chrono 는 "2026-9-1" 도 받아주므로 문자열 왕복이 같은지까지 본다.
fn parse_day(day: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .filter(|d| d.format("%Y-%m-%d").to_string() == day)
        .ok_or_else(|| AppError::Validation(format!("invalid day (YYYY-MM-DD): {day}")))
}

pub fn create(
    conn: &Connection,
    workspace_id: &str,
    title: &str,
    icon: Option<&str>,
    hue: Option<i64>,
    weekday_mask: i64,
    time_of_day: Option<&str>,
) -> AppResult<Habit> {
    let ws_exists: bool = conn
        .query_row("SELECT 1 FROM workspaces WHERE id=?1", [workspace_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !ws_exists {
        return Err(AppError::NotFound(format!("workspace not found: {workspace_id}")));
    }
    validate_mask(weekday_mask)?;
    let time_of_day = time_of_day.unwrap_or("any");
    validate_time_of_day(time_of_day)?;
    let title = clean_title(title)?;
    // 보관된 것도 포함해 MAX+1 — 복원 시 다른 습관과 position 이 겹치지 않게.
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM habits WHERE workspace_id=?1",
            [workspace_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO habits(id, workspace_id, title, icon, hue, weekday_mask, position, created_at, time_of_day)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, workspace_id, title, icon, hue, weekday_mask, position, now_iso(), time_of_day],
    )
    .map_err(dberr)?;
    get(conn, &id)?.ok_or_else(|| AppError::Io("habit vanished after insert".to_string()))
}

/// title·weekday_mask·time_of_day·archived 는 None=안 건드림. icon·hue 는 항상 통째 교체(null=지움).
pub fn update(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    icon: Option<&str>,
    hue: Option<i64>,
    weekday_mask: Option<i64>,
    archived: Option<bool>,
    time_of_day: Option<&str>,
) -> AppResult<Habit> {
    let cur = get(conn, id)?.ok_or_else(|| AppError::NotFound(format!("habit not found: {id}")))?;
    let next_title = match title {
        Some(t) => clean_title(t)?,
        None => cur.title,
    };
    let next_mask = weekday_mask.unwrap_or(cur.weekday_mask);
    validate_mask(next_mask)?;
    let next_tod = match time_of_day {
        Some(v) => {
            validate_time_of_day(v)?;
            v.to_string()
        }
        None => cur.time_of_day,
    };
    let next_archived = match archived {
        Some(true) => cur.archived_at.or_else(|| Some(now_iso())), // 이미 보관이면 시각 유지
        Some(false) => None,
        None => cur.archived_at,
    };
    conn.execute(
        "UPDATE habits SET title=?1, icon=?2, hue=?3, weekday_mask=?4, archived_at=?5, time_of_day=?6 WHERE id=?7",
        params![next_title, icon, hue, next_mask, next_archived, next_tod, id],
    )
    .map_err(dberr)?;
    get(conn, id)?.ok_or_else(|| AppError::Io("habit vanished after update".to_string()))
}

/// 체크 이력은 FK CASCADE. id 가 없어도 true(멱등).
pub fn delete(conn: &Connection, id: &str) -> AppResult<bool> {
    conn.execute("DELETE FROM habits WHERE id=?1", [id]).map_err(dberr)?;
    Ok(true)
}

/// ids 의 인덱스가 곧 position. 이 노트북 소속이 아닌 id·중복은 무시하고,
/// 목록에 없는 습관은 상대 순서를 지킨 채 뒤로 민다. 한 트랜잭션.
pub fn reorder(conn: &Connection, workspace_id: &str, ids: &[String]) -> AppResult<()> {
    let mut stmt = conn
        .prepare("SELECT id FROM habits WHERE workspace_id=?1 ORDER BY position ASC, created_at ASC, id ASC")
        .map_err(dberr)?;
    let existing: Vec<String> = stmt
        .query_map([workspace_id], |r| r.get(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let known: HashSet<&String> = existing.iter().collect();
    let mut order: Vec<&String> = Vec::with_capacity(existing.len());
    let mut seen: HashSet<&String> = HashSet::new();
    for id in ids {
        if let Some(k) = known.get(id) {
            if seen.insert(*k) {
                order.push(*k);
            }
        }
    }
    for id in &existing {
        if seen.insert(id) {
            order.push(id);
        }
    }
    let tx = conn.unchecked_transaction().map_err(dberr)?;
    for (i, id) in order.iter().enumerate() {
        tx.execute("UPDATE habits SET position=?1 WHERE id=?2", params![i as i64, id])
            .map_err(dberr)?;
    }
    tx.commit().map_err(dberr)
}

/// 멱등 체크 — done=true 는 행 upsert(최초 done_at 유지), false 는 행 삭제.
pub fn check(conn: &Connection, habit_id: &str, day: &str, done: bool) -> AppResult<bool> {
    parse_day(day)?;
    if get(conn, habit_id)?.is_none() {
        return Err(AppError::NotFound(format!("habit not found: {habit_id}")));
    }
    if done {
        conn.execute(
            "INSERT OR IGNORE INTO habit_checks(habit_id, day, done_at) VALUES (?1, ?2, ?3)",
            params![habit_id, day, now_iso()],
        )
        .map_err(dberr)?;
    } else {
        conn.execute(
            "DELETE FROM habit_checks WHERE habit_id=?1 AND day=?2",
            params![habit_id, day],
        )
        .map_err(dberr)?;
    }
    Ok(done)
}

fn rate(done: i64, scheduled: i64) -> Option<f64> {
    (scheduled > 0).then(|| done as f64 / scheduled as f64)
}

/// 현재 연속 일수 — 기준일부터 거슬러 요일 마스크에 든 날만 센다(쉬는 요일은 끊지도 더하지도 않음).
/// 기준일이 아직 미체크면 어제부터 세어 스트릭을 끊지 않는다. 상한 365일(ponytail: 더 긴 기록은 365 로 자른다 —
/// 조회 창을 고정해 habit_checks PK(habit_id, day) 범위 스캔 한 번으로 끝내려는 것).
const STREAK_CAP_DAYS: i64 = 365;

fn streak(conn: &Connection, habit: &Habit, base: NaiveDate) -> AppResult<i64> {
    let from = (base - Duration::days(STREAK_CAP_DAYS - 1)).format("%Y-%m-%d").to_string();
    let to = base.format("%Y-%m-%d").to_string();
    let mut stmt = conn
        .prepare("SELECT day FROM habit_checks WHERE habit_id=?1 AND day BETWEEN ?2 AND ?3")
        .map_err(dberr)?;
    let days: HashSet<String> = stmt
        .query_map(params![habit.id, from, to], |r| r.get(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let mut n = 0;
    for i in 0..STREAK_CAP_DAYS {
        let d = base - Duration::days(i);
        if habit.weekday_mask & (1 << d.weekday().num_days_from_monday()) == 0 {
            continue;
        }
        if days.contains(&d.format("%Y-%m-%d").to_string()) {
            n += 1;
        } else if i != 0 {
            break;
        }
    }
    Ok(n)
}

/// 습관 7일 창을 습관별로 집계한다(오래된 날 먼저). 보관된 습관은 제외.
/// - `week_start` None = 롤링: 기준일로 끝나는 7일(day-6..day).
/// - `week_start` "monday"|"sunday": 기준일이 속한 주의 첫날..+6일. **기준일 이후(미래) 칸은
///   scheduled=false 로 내려 분모·체크 대상에서 뺀다** — 주 초에 달성률이 0% 로 곤두박질치지 않게.
/// 응답 `today` = 기준일(롤링에선 to 와 같다).
pub fn week(conn: &Connection, workspace_id: &str, day: &str, week_start: Option<&str>) -> AppResult<HabitWeek> {
    let base = parse_day(day)?;
    let first = match week_start {
        None => base - Duration::days(6),
        Some("monday") => base - Duration::days(base.weekday().num_days_from_monday() as i64),
        Some("sunday") => base - Duration::days(base.weekday().num_days_from_sunday() as i64),
        Some(o) => return Err(AppError::Validation(format!("week_start must be monday|sunday: {o}"))),
    };
    let dates: Vec<NaiveDate> = (0..7).map(|i| first + Duration::days(i)).collect();
    let to = dates[6].format("%Y-%m-%d").to_string();
    let from = dates[0].format("%Y-%m-%d").to_string();

    let mut stmt = conn
        .prepare(
            "SELECT c.habit_id, c.day FROM habit_checks c JOIN habits h ON h.id = c.habit_id
             WHERE h.workspace_id=?1 AND c.day BETWEEN ?2 AND ?3",
        )
        .map_err(dberr)?;
    let checked: HashSet<(String, String)> = stmt
        .query_map(params![workspace_id, from, to], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    let (mut total_done, mut total_sched) = (0i64, 0i64);
    let rows = list(conn, workspace_id)?
        .into_iter()
        .map(|habit| -> AppResult<HabitWeekRow> {
            let days: Vec<HabitDay> = dates
                .iter()
                .map(|d| {
                    let s = d.format("%Y-%m-%d").to_string();
                    HabitDay {
                        scheduled: *d <= base && habit.weekday_mask & (1 << d.weekday().num_days_from_monday()) != 0,
                        done: checked.contains(&(habit.id.clone(), s.clone())),
                        day: s,
                    }
                })
                .collect();
            let scheduled_count = days.iter().filter(|d| d.scheduled).count() as i64;
            // 쉬는 요일에 남은 체크는 달성률에 넣지 않는다(분자가 분모보다 커지지 않게).
            let done_count = days.iter().filter(|d| d.scheduled && d.done).count() as i64;
            total_done += done_count;
            total_sched += scheduled_count;
            let streak = streak(conn, &habit, base)?;
            Ok(HabitWeekRow { rate: rate(done_count, scheduled_count), habit, days, done_count, scheduled_count, streak })
        })
        .collect::<AppResult<Vec<_>>>()?;

    Ok(HabitWeek {
        from,
        to,
        today: day.to_string(),
        rows,
        done_count: total_done,
        scheduled_count: total_sched,
        rate: rate(total_done, total_sched),
    })
}

/// habit_history 범위 상한(양끝 포함 일수) — 12주 히트맵(84일)에 넉넉한 여유. 넘으면 VALIDATION.
pub const HISTORY_MAX_DAYS: i64 = 400;

/// 브리핑 "오늘의 습관" 12주 히트맵 — from..to(양끝 포함, 오래된 날 먼저)의 날별 scheduled/done 수.
/// 보관된 습관은 제외. 습관을 만든 날(created_at 의 로컬 날짜) 이전은 scheduled 에 넣지 않는다 — 생성 전 날을 0% 로
/// 칠하지 않게. `week()` 는 이걸 보지 않는다(7일 창·달성률 계약 그대로).
/// ponytail: 생성일 변환은 **이 기기의 시간대**(chrono Local) 기준이다. 다른 시간대로 옮긴 기기·폰과는 경계 하루가
/// 어긋날 수 있다 — habit_checks.day 처럼 생성 로컬일을 저장하거나 클라이언트가 tz 를 넘기면 업그레이드된다.
pub fn history(conn: &Connection, workspace_id: &str, from: &str, to: &str) -> AppResult<HabitHistory> {
    history_in(conn, workspace_id, from, to, &Local)
}

fn history_in<Tz: TimeZone>(conn: &Connection, workspace_id: &str, from: &str, to: &str, tz: &Tz) -> AppResult<HabitHistory> {
    let first = parse_day(from)?;
    let last = parse_day(to)?;
    if first > last {
        return Err(AppError::Validation(format!("from must be <= to: {from} > {to}")));
    }
    let span = (last - first).num_days() + 1;
    if span > HISTORY_MAX_DAYS {
        return Err(AppError::Validation(format!("range too long ({span} days, max {HISTORY_MAX_DAYS})")));
    }

    // (mask, 생성 로컬일). 생성 시각을 못 읽으면 하한 없이 센다(=week 와 같은 자세) + 진단 기록.
    let habits: Vec<(String, i64, Option<NaiveDate>)> = list(conn, workspace_id)?
        .into_iter()
        .map(|h| {
            let since = match DateTime::parse_from_rfc3339(&h.created_at) {
                Ok(t) => Some(t.with_timezone(tz).date_naive()),
                Err(e) => {
                    crate::diag::warn("habits", "history_created_at_unparsed", format!("{e}"));
                    None
                }
            };
            (h.id, h.weekday_mask, since)
        })
        .collect();

    let mut stmt = conn
        .prepare(
            "SELECT c.habit_id, c.day FROM habit_checks c JOIN habits h ON h.id = c.habit_id
             WHERE h.workspace_id=?1 AND h.archived_at IS NULL AND c.day BETWEEN ?2 AND ?3",
        )
        .map_err(dberr)?;
    let checked: HashSet<(String, String)> = stmt
        .query_map(params![workspace_id, from, to], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    let days = (0..span)
        .map(|i| {
            let d = first + Duration::days(i);
            let day = d.format("%Y-%m-%d").to_string();
            let bit = 1 << d.weekday().num_days_from_monday();
            let (mut scheduled, mut done) = (0i64, 0i64);
            for (id, mask, since) in &habits {
                if mask & bit == 0 || since.is_some_and(|s| d < s) {
                    continue;
                }
                scheduled += 1;
                if checked.contains(&(id.clone(), day.clone())) {
                    done += 1;
                }
            }
            HabitHistoryDay { day, scheduled, done }
        })
        .collect();
    Ok(HabitHistory { from: from.to_string(), to: to.to_string(), days })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ws: String = conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0)).unwrap();
        (conn, ws)
    }

    fn checks(conn: &Connection, id: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM habit_checks WHERE habit_id=?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn create_validates_and_appends() {
        let (conn, ws) = setup();
        let a = create(&conn, &ws, "  물 마시기 ", Some("💧"), Some(200), 127, None).unwrap();
        let b = create(&conn, &ws, "독서", None, None, 0b0011111, None).unwrap();
        assert_eq!((a.title.as_str(), a.position, b.position), ("물 마시기", 0, 1));
        assert!(matches!(create(&conn, &ws, "  ", None, None, 127, None), Err(AppError::Validation(_))));
        assert!(matches!(create(&conn, &ws, "x", None, None, 0, None), Err(AppError::Validation(_))));
        assert!(matches!(create(&conn, &ws, "x", None, None, 128, None), Err(AppError::Validation(_))));
        assert!(matches!(create(&conn, "nope", "x", None, None, 127, None), Err(AppError::NotFound(_))));
    }

    #[test]
    fn check_is_idempotent_and_validates() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "운동", None, None, 127, None).unwrap();
        check(&conn, &h.id, "2026-09-30", true).unwrap();
        let first: String = conn
            .query_row("SELECT done_at FROM habit_checks WHERE habit_id=?1", [&h.id], |r| r.get(0))
            .unwrap();
        check(&conn, &h.id, "2026-09-30", true).unwrap();
        assert_eq!(checks(&conn, &h.id), 1);
        let again: String = conn
            .query_row("SELECT done_at FROM habit_checks WHERE habit_id=?1", [&h.id], |r| r.get(0))
            .unwrap();
        assert_eq!(first, again);
        check(&conn, &h.id, "2026-09-30", false).unwrap();
        check(&conn, &h.id, "2026-09-30", false).unwrap();
        assert_eq!(checks(&conn, &h.id), 0);
        for bad in ["2026-9-30", "20260930", "2026-02-30", ""] {
            assert!(matches!(check(&conn, &h.id, bad, true), Err(AppError::Validation(_))), "{bad}");
        }
        assert!(matches!(check(&conn, "nope", "2026-09-30", true), Err(AppError::NotFound(_))));
    }

    #[test]
    fn week_aggregates_scheduled_days_only() {
        let (conn, ws) = setup();
        // 2026-09-30 = 수. 7일 창: 09-24(목) .. 09-30(수).
        let daily = create(&conn, &ws, "매일", None, None, 127, None).unwrap();
        let weekdays = create(&conn, &ws, "평일", None, None, 0b0011111, None).unwrap();
        let archived = create(&conn, &ws, "보관", None, None, 127, None).unwrap();
        update(&conn, &archived.id, None, None, None, None, Some(true), None).unwrap();

        check(&conn, &daily.id, "2026-09-30", true).unwrap();
        check(&conn, &daily.id, "2026-09-29", true).unwrap();
        check(&conn, &daily.id, "2026-09-23", true).unwrap(); // 창 밖
        check(&conn, &weekdays.id, "2026-09-26", true).unwrap(); // 토 — 쉬는 요일이라 집계 제외
        check(&conn, &weekdays.id, "2026-09-25", true).unwrap(); // 금

        let w = week(&conn, &ws, "2026-09-30", None).unwrap();
        assert_eq!((w.from.as_str(), w.to.as_str()), ("2026-09-24", "2026-09-30"));
        assert_eq!(w.rows.len(), 2); // 보관 제외
        let d = &w.rows[0];
        assert_eq!((d.scheduled_count, d.done_count), (7, 2));
        assert_eq!(d.days.len(), 7);
        assert_eq!(d.days[6].day, "2026-09-30");
        assert!(d.days[6].done && !d.days[0].done);
        let p = &w.rows[1];
        assert_eq!((p.scheduled_count, p.done_count), (5, 1)); // 목·금·월·화·수
        assert!(p.days[2].done && !p.days[2].scheduled); // 토: 행은 있으나 비집계
        assert_eq!((w.scheduled_count, w.done_count), (12, 3));
        assert_eq!(w.rate, Some(3.0 / 12.0));
        assert!(matches!(week(&conn, &ws, "bad", None), Err(AppError::Validation(_))));
    }

    #[test]
    fn week_start_window_excludes_future_days() {
        let (conn, ws) = setup();
        // 2026-09-30 = 수. 월요일 시작: 09-28(월)..10-04(일), 분모는 월·화·수 3일.
        let daily = create(&conn, &ws, "매일", None, None, 127, None).unwrap();
        check(&conn, &daily.id, "2026-09-28", true).unwrap();
        check(&conn, &daily.id, "2026-09-27", true).unwrap(); // 지난주 일요일 — 창 밖
        let m = week(&conn, &ws, "2026-09-30", Some("monday")).unwrap();
        assert_eq!((m.from.as_str(), m.to.as_str(), m.today.as_str()), ("2026-09-28", "2026-10-04", "2026-09-30"));
        assert_eq!((m.done_count, m.scheduled_count), (1, 3));
        assert_eq!(m.rows[0].days.len(), 7);
        assert!(!m.rows[0].days[3].scheduled); // 목(미래)
        // 일요일 시작: 09-27(일)..10-03(토), 분모 일·월·화·수 4일, 일요일 체크 포함.
        let s = week(&conn, &ws, "2026-09-30", Some("sunday")).unwrap();
        assert_eq!((s.from.as_str(), s.to.as_str()), ("2026-09-27", "2026-10-03"));
        assert_eq!((s.done_count, s.scheduled_count), (2, 4));
        // 기준일이 주의 첫날이면 그 하루만 분모.
        let first = week(&conn, &ws, "2026-09-28", Some("monday")).unwrap();
        assert_eq!((first.done_count, first.scheduled_count), (1, 1));
        // 일요일 기준 + 월요일 시작 = 지난 월요일이 창 시작(6일 전).
        assert_eq!(week(&conn, &ws, "2026-10-04", Some("monday")).unwrap().from, "2026-09-28");
        assert!(matches!(week(&conn, &ws, "2026-09-30", Some("x")), Err(AppError::Validation(_))));
        // 롤링은 today == to.
        let r = week(&conn, &ws, "2026-09-30", None).unwrap();
        assert_eq!((r.to.as_str(), r.today.as_str()), ("2026-09-30", "2026-09-30"));
    }

    #[test]
    fn week_rate_is_none_without_scheduled_days() {
        let (conn, ws) = setup();
        assert_eq!(week(&conn, &ws, "2026-09-30", None).unwrap().rate, None);
    }

    #[test]
    fn delete_cascades_checks_and_is_idempotent() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "운동", None, None, 127, None).unwrap();
        check(&conn, &h.id, "2026-09-30", true).unwrap();
        assert!(delete(&conn, &h.id).unwrap());
        assert_eq!(checks(&conn, &h.id), 0);
        assert!(delete(&conn, &h.id).unwrap());
    }

    #[test]
    fn update_partial_archive_and_restore() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "운동", Some("x"), Some(10), 127, None).unwrap();
        let u = update(&conn, &h.id, Some("헬스"), Some("y"), None, None, None, None).unwrap();
        assert_eq!((u.title.as_str(), u.icon.as_deref(), u.hue, u.weekday_mask), ("헬스", Some("y"), None, 127));
        assert!(matches!(update(&conn, &h.id, Some(" "), None, None, None, None, None), Err(AppError::Validation(_))));
        assert!(matches!(update(&conn, &h.id, None, None, None, Some(0), None, None), Err(AppError::Validation(_))));
        assert!(matches!(update(&conn, "nope", None, None, None, None, None, None), Err(AppError::NotFound(_))));
        update(&conn, &h.id, None, None, None, None, Some(true), None).unwrap();
        assert!(list(&conn, &ws).unwrap().is_empty());
        update(&conn, &h.id, None, None, None, None, Some(false), None).unwrap();
        assert_eq!(list(&conn, &ws).unwrap().len(), 1);
    }

    #[test]
    fn reorder_sets_positions_and_pushes_unlisted_back() {
        let (conn, ws) = setup();
        create(&conn, &ws, "A", None, None, 127, None).unwrap();
        let b = create(&conn, &ws, "B", None, None, 127, None).unwrap();
        let c = create(&conn, &ws, "C", None, None, 127, None).unwrap();
        reorder(&conn, &ws, &[c.id.clone(), "foreign".into(), b.id.clone(), c.id.clone()]).unwrap();
        let titles: Vec<_> = list(&conn, &ws).unwrap().into_iter().map(|h| h.title).collect();
        assert_eq!(titles, ["C", "B", "A"]);
    }
    #[test]
    fn time_of_day_default_validate_and_keep() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "x", None, None, 127, None).unwrap();
        assert_eq!(h.time_of_day, "any");
        let m = create(&conn, &ws, "y", None, None, 127, Some("morning")).unwrap();
        assert_eq!(m.time_of_day, "morning");
        assert!(matches!(create(&conn, &ws, "z", None, None, 127, Some("noon")), Err(AppError::Validation(_))));
        let u = update(&conn, &m.id, None, None, None, None, None, Some("evening")).unwrap();
        assert_eq!(u.time_of_day, "evening");
        let k = update(&conn, &m.id, Some("y2"), None, None, None, None, None).unwrap(); // 생략 = 유지
        assert_eq!(k.time_of_day, "evening");
        assert!(matches!(update(&conn, &m.id, None, None, None, None, None, Some("x")), Err(AppError::Validation(_))));
    }

    fn streak_of(conn: &Connection, ws: &str, day: &str, mode: Option<&str>) -> i64 {
        week(conn, ws, day, mode).unwrap().rows[0].streak
    }

    #[test]
    fn streak_counts_back_and_skips_unchecked_today() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "매일", None, None, 127, None).unwrap();
        // 09-30 수. 09-26..09-29 체크(4일), 오늘 미체크 → 어제부터 4.
        for d in ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"] {
            check(&conn, &h.id, d, true).unwrap();
        }
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 4);
        check(&conn, &h.id, "2026-09-30", true).unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 5);
        // week_start 모드도 같다(09-26·27 은 월요일 시작 창 밖 — 서버가 창 밖까지 센다).
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", Some("monday")), 5);
        // 끊김: 09-27 해제 → 09-28..30 = 3.
        check(&conn, &h.id, "2026-09-27", false).unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 3);
        // 어제도 오늘도 미체크면 0.
        check(&conn, &h.id, "2026-09-30", false).unwrap();
        check(&conn, &h.id, "2026-09-29", false).unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 0);
    }

    #[test]
    fn streak_skips_rest_days() {
        let (conn, ws) = setup();
        // 평일만. 09-30 수 기준: 수·화·월 체크, 토·일 쉼, 금·목 체크 → 5.
        let h = create(&conn, &ws, "평일", None, None, 0b0011111, None).unwrap();
        for d in ["2026-09-30", "2026-09-29", "2026-09-28", "2026-09-25", "2026-09-24"] {
            check(&conn, &h.id, d, true).unwrap();
        }
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 5);
        // 쉬는 날에 남은 체크는 세지 않는다.
        check(&conn, &h.id, "2026-09-26", true).unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 5);
        // 오늘(수) 체크 해제 → 어제(화)부터 월까지 + 금·목 = 4.
        check(&conn, &h.id, "2026-09-30", false).unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 4);
    }

    #[test]
    fn streak_is_capped_at_365() {
        let (conn, ws) = setup();
        let h = create(&conn, &ws, "매일", None, None, 127, None).unwrap();
        let base = NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..400 {
            let d = (base - Duration::days(i)).format("%Y-%m-%d").to_string();
            tx.execute("INSERT INTO habit_checks(habit_id, day, done_at) VALUES (?1, ?2, 'x')", params![h.id, d]).unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(streak_of(&conn, &ws, "2026-09-30", None), 365);
    }

    #[test]
    fn history_counts_scheduled_from_creation_day_only() {
        let (conn, ws) = setup();
        // 2026-09-28 = 월 .. 2026-10-04 = 일.
        let daily = create(&conn, &ws, "매일", None, None, 127, None).unwrap();
        let weekdays = create(&conn, &ws, "평일", None, None, 0b0011111, None).unwrap();
        let archived = create(&conn, &ws, "보관", None, None, 127, None).unwrap();
        // 생성 시각을 고정 — 매일은 09-30 정오(UTC), 평일은 그 전부터.
        conn.execute("UPDATE habits SET created_at='2026-09-30T12:00:00.000Z' WHERE id=?1", [&daily.id]).unwrap();
        conn.execute("UPDATE habits SET created_at='2026-01-01T00:00:00.000Z' WHERE id IN (?1, ?2)", params![weekdays.id, archived.id]).unwrap();
        update(&conn, &archived.id, None, None, None, None, Some(true), None).unwrap();
        check(&conn, &archived.id, "2026-10-01", true).unwrap(); // 보관 — 집계 제외
        check(&conn, &daily.id, "2026-09-29", true).unwrap(); // 생성 전 체크 — 세지 않는다
        check(&conn, &daily.id, "2026-10-01", true).unwrap();
        check(&conn, &weekdays.id, "2026-10-01", true).unwrap();
        check(&conn, &weekdays.id, "2026-10-03", true).unwrap(); // 토 — 쉬는 요일

        let h = history_in(&conn, &ws, "2026-09-28", "2026-10-04", &chrono::Utc).unwrap();
        assert_eq!((h.from.as_str(), h.to.as_str(), h.days.len()), ("2026-09-28", "2026-10-04", 7));
        let got: Vec<(&str, i64, i64)> = h.days.iter().map(|d| (d.day.as_str(), d.scheduled, d.done)).collect();
        assert_eq!(
            got,
            [
                ("2026-09-28", 1, 0), // 월: 평일만(매일은 아직 없음)
                ("2026-09-29", 1, 0), // 화: 매일의 생성 전 체크는 무시
                ("2026-09-30", 2, 0), // 수: 생성일 당일부터 센다
                ("2026-10-01", 2, 2),
                ("2026-10-02", 2, 0),
                ("2026-10-03", 1, 0), // 토: 매일만, 평일의 체크는 비집계
                ("2026-10-04", 1, 0),
            ]
        );
        // 한 날짜 범위.
        let one = history_in(&conn, &ws, "2026-10-01", "2026-10-01", &chrono::Utc).unwrap();
        assert_eq!(one.days.len(), 1);
    }

    #[test]
    fn history_validates_range() {
        let (conn, ws) = setup();
        for (f, t) in [("bad", "2026-10-01"), ("2026-10-01", "2026-9-30"), ("2026-10-02", "2026-10-01")] {
            assert!(matches!(history(&conn, &ws, f, t), Err(AppError::Validation(_))), "{f}..{t}");
        }
        // 400일 = 통과, 401일 = 거절.
        assert_eq!(history(&conn, &ws, "2026-01-01", "2027-02-04").unwrap().days.len(), 400);
        assert!(matches!(history(&conn, &ws, "2026-01-01", "2027-02-05"), Err(AppError::Validation(_))));
    }
}
