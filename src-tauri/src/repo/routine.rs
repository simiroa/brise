use crate::error::{db as dberr, AppError, AppResult};
use crate::models::{
    RoutineDay, RoutineHistoryResult, RoutineTodayItem, RoutineTodayResult, RoutineToggleResult,
};
use crate::repo::dashboard::dateord::{days_in_month, ord_to_ymd, NaiveYmd};
use crate::repo::schedule::rrule;
use crate::util::{now_iso, today_ymd_local};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};

pub const ROUTINE_HISTORY_MAX_DAYS: i64 = 400;

fn parse_iso_date(s: &str) -> Option<NaiveYmd> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some(NaiveYmd { y, m, d })
}

pub fn toggle(
    conn: &Connection,
    note_id: &str,
    occur_on: &str,
    done: bool,
) -> AppResult<RoutineToggleResult> {
    if parse_iso_date(occur_on).is_none() {
        return Err(AppError::Validation("invalid occur_on date format (expected YYYY-MM-DD)".to_string()));
    }

    let note_exists: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            [note_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);

    if !note_exists {
        return Err(AppError::NotFound("note not found".to_string()));
    }

    if done {
        let done_at = now_iso();
        conn.execute(
            "INSERT OR REPLACE INTO routine_completions (note_id, occur_on, done_at) VALUES (?1, ?2, ?3)",
            params![note_id, occur_on, done_at],
        )
        .map_err(dberr)?;
    } else {
        conn.execute(
            "DELETE FROM routine_completions WHERE note_id = ?1 AND occur_on = ?2",
            params![note_id, occur_on],
        )
        .map_err(dberr)?;
    }

    Ok(RoutineToggleResult {
        note_id: note_id.to_string(),
        occur_on: occur_on.to_string(),
        done,
    })
}

pub fn today(conn: &Connection, workspace_id: &str) -> AppResult<RoutineTodayResult> {
    let ws_exists: bool = conn
        .query_row(
            "SELECT 1 FROM workspaces WHERE id = ?1",
            [workspace_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);

    if !ws_exists {
        return Err(AppError::NotFound("workspace not found".to_string()));
    }

    let (ty, tm, td) = today_ymd_local();
    let today_ymd = NaiveYmd {
        y: ty,
        m: tm as u32,
        d: td as u32,
    };
    let today_iso = today_ymd.to_iso();

    // Query candidate recurring notes in workspace
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.year, n.month, n.day, n.rrule, n.start_time
             FROM notes n
             JOIN folders f ON n.folder_id = f.id
             WHERE f.workspace_id = ?1
               AND n.deleted_at IS NULL
               AND n.archived_at IS NULL
               AND n.rrule IS NOT NULL
               AND n.year IS NOT NULL
               AND n.month IS NOT NULL
               AND n.day IS NOT NULL",
        )
        .map_err(dberr)?;

    struct Candidate {
        id: String,
        title: String,
        seed: NaiveYmd,
        rrule_str: String,
        start_time: Option<String>,
    }

    let candidates: Vec<Candidate> = stmt
        .query_map([workspace_id], |row| {
            let y: i64 = row.get(2)?;
            let m: u32 = row.get(3)?;
            let d: u32 = row.get(4)?;
            Ok(Candidate {
                id: row.get(0)?,
                title: row.get(1)?,
                seed: NaiveYmd { y, m, d },
                rrule_str: row.get(5)?,
                start_time: row.get(6)?,
            })
        })
        .map_err(dberr)?
        .filter_map(|r| r.ok())
        .collect();

    let mut active_today: Vec<(String, String, Option<String>)> = Vec::new();
    let mut active_ids: HashSet<String> = HashSet::new();

    for c in candidates {
        if let Ok(parts) = rrule::parse(&c.rrule_str) {
            let (occurs, _) = rrule::expand(&parts, c.seed, today_ymd, today_ymd);
            if !occurs.is_empty() {
                active_ids.insert(c.id.clone());
                active_today.push((c.id, c.title, c.start_time));
            }
        }
    }

    // Query completions for today
    let mut completed_set: HashSet<String> = HashSet::new();
    if !active_ids.is_empty() {
        let mut comp_stmt = conn
            .prepare(
                "SELECT note_id FROM routine_completions WHERE occur_on = ?1",
            )
            .map_err(dberr)?;
        let rows = comp_stmt
            .query_map([&today_iso], |row| row.get::<_, String>(0))
            .map_err(dberr)?;
        for r in rows.flatten() {
            completed_set.insert(r);
        }
    }

    // Sort active routines by start_time asc (nulls last) then title
    active_today.sort_by(|a, b| {
        match (&a.2, &b.2) {
            (Some(ta), Some(tb)) => ta.cmp(tb).then_with(|| a.1.cmp(&b.1)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.1.cmp(&b.1),
        }
    });

    let items = active_today
        .into_iter()
        .map(|(id, title, time)| {
            let done = completed_set.contains(&id);
            RoutineTodayItem {
                note_id: id,
                title,
                done,
                time,
            }
        })
        .collect();

    Ok(RoutineTodayResult { items })
}

pub fn history(
    conn: &Connection,
    workspace_id: &str,
    from_str: &str,
    to_str: &str,
) -> AppResult<RoutineHistoryResult> {
    let ws_exists: bool = conn
        .query_row(
            "SELECT 1 FROM workspaces WHERE id = ?1",
            [workspace_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);

    if !ws_exists {
        return Err(AppError::NotFound("workspace not found".to_string()));
    }

    let from_ymd = parse_iso_date(from_str)
        .ok_or_else(|| AppError::Validation("invalid from date format (expected YYYY-MM-DD)".to_string()))?;
    let to_ymd = parse_iso_date(to_str)
        .ok_or_else(|| AppError::Validation("invalid to date format (expected YYYY-MM-DD)".to_string()))?;

    let from_ord = from_ymd.to_ord();
    let to_ord = to_ymd.to_ord();
    let total_days = to_ord - from_ord + 1;

    if total_days < 1 {
        return Err(AppError::Validation("from date cannot be after to date".to_string()));
    }
    if total_days > ROUTINE_HISTORY_MAX_DAYS {
        return Err(AppError::Validation(format!(
            "range ({} days) exceeds maximum of {} days",
            total_days, ROUTINE_HISTORY_MAX_DAYS
        )));
    }

    // Query candidate recurring notes in workspace
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.year, n.month, n.day, n.rrule
             FROM notes n
             JOIN folders f ON n.folder_id = f.id
             WHERE f.workspace_id = ?1
               AND n.deleted_at IS NULL
               AND n.archived_at IS NULL
               AND n.rrule IS NOT NULL
               AND n.year IS NOT NULL
               AND n.month IS NOT NULL
               AND n.day IS NOT NULL",
        )
        .map_err(dberr)?;

    let mut due_map: HashMap<String, i64> = HashMap::new();

    let rows = stmt
        .query_map([workspace_id], |row| {
            let y: i64 = row.get(1)?;
            let m: u32 = row.get(2)?;
            let d: u32 = row.get(3)?;
            let rrule_str: String = row.get(4)?;
            Ok((NaiveYmd { y, m, d }, rrule_str))
        })
        .map_err(dberr)?;

    for r in rows.flatten() {
        let (seed, rrule_str) = r;
        if let Ok(parts) = rrule::parse(&rrule_str) {
            let (occurs, _) = rrule::expand(&parts, seed, from_ymd, to_ymd);
            for occ in occurs {
                let iso = occ.to_iso();
                *due_map.entry(iso).or_insert(0) += 1;
            }
        }
    }

    // Query done completions count grouped by occur_on
    let mut done_stmt = conn
        .prepare(
            "SELECT rc.occur_on, count(*)
             FROM routine_completions rc
             JOIN notes n ON rc.note_id = n.id
             JOIN folders f ON n.folder_id = f.id
             WHERE f.workspace_id = ?1
               AND n.deleted_at IS NULL
               AND rc.occur_on >= ?2
               AND rc.occur_on <= ?3
             GROUP BY rc.occur_on",
        )
        .map_err(dberr)?;

    let mut done_map: HashMap<String, i64> = HashMap::new();
    let done_rows = done_stmt
        .query_map(params![workspace_id, from_str, to_str], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(dberr)?;

    for r in done_rows.flatten() {
        done_map.insert(r.0, r.1);
    }

    let mut days: Vec<RoutineDay> = Vec::with_capacity(total_days as usize);
    for ord in from_ord..=to_ord {
        let ymd = ord_to_ymd(ord);
        let iso = ymd.to_iso();
        let done = done_map.get(&iso).copied().unwrap_or(0);
        let due = due_map.get(&iso).copied().unwrap_or(0);
        days.push(RoutineDay {
            date: iso,
            done,
            due,
        });
    }

    Ok(RoutineHistoryResult {
        days,
        from: from_str.to_string(),
        to: to_str.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup() -> (Connection, String, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, created_at)
             VALUES ('f1', ?1, 'Default', 0, '2026-08-01T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, month, day, rrule, created_at, updated_at)
             VALUES ('n1', 'f1', 'Daily Exercise', 2026, 8, 1, 'FREQ=DAILY', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();

        (conn, ws_id, "n1".to_string())
    }

    #[test]
    fn test_routine_toggle_idempotent() {
        let (conn, _, note_id) = setup();

        let r1 = toggle(&conn, &note_id, "2026-08-16", true).unwrap();
        assert!(r1.done);

        let r2 = toggle(&conn, &note_id, "2026-08-16", true).unwrap();
        assert!(r2.done);

        let r3 = toggle(&conn, &note_id, "2026-08-16", false).unwrap();
        assert!(!r3.done);

        let r4 = toggle(&conn, &note_id, "2026-08-16", false).unwrap();
        assert!(!r4.done);
    }

    #[test]
    fn test_routine_today() {
        let (conn, ws_id, note_id) = setup();

        let (ty, tm, td) = today_ymd_local();
        let today_iso = format!("{:04}-{:02}-{:02}", ty, tm, td);

        let res1 = today(&conn, &ws_id).unwrap();
        assert_eq!(res1.items.len(), 1);
        assert_eq!(res1.items[0].note_id, note_id);
        assert!(!res1.items[0].done);

        toggle(&conn, &note_id, &today_iso, true).unwrap();
        let res2 = today(&conn, &ws_id).unwrap();
        assert_eq!(res2.items.len(), 1);
        assert!(res2.items[0].done);
    }

    #[test]
    fn test_routine_history() {
        let (conn, ws_id, note_id) = setup();

        toggle(&conn, &note_id, "2026-08-10", true).unwrap();
        toggle(&conn, &note_id, "2026-08-12", true).unwrap();

        let hist = history(&conn, &ws_id, "2026-08-10", "2026-08-12").unwrap();
        assert_eq!(hist.days.len(), 3);

        assert_eq!(hist.days[0].date, "2026-08-10");
        assert_eq!(hist.days[0].done, 1);
        assert_eq!(hist.days[0].due, 1);

        assert_eq!(hist.days[1].date, "2026-08-11");
        assert_eq!(hist.days[1].done, 0);
        assert_eq!(hist.days[1].due, 1);

        assert_eq!(hist.days[2].date, "2026-08-12");
        assert_eq!(hist.days[2].done, 1);
        assert_eq!(hist.days[2].due, 1);
    }

    #[test]
    fn test_routine_history_max_days_validation() {
        let (conn, ws_id, _) = setup();
        let err = history(&conn, &ws_id, "2024-01-01", "2026-08-16").unwrap_err();
        match err {
            AppError::Validation(_) => {}
            _ => panic!("expected Validation error for exceeding max days"),
        }
    }
}
