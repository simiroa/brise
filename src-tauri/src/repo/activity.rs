// repo: activity_log — device-local audit trail (commands/activity.yaml, migration v33).
// Records note create/delete/edit/restore/import events. NOT a version-history store and NOT
// mixed with "reopen closed tab" (that's settings kv recent_closed_tabs). Shape mirrors
// ai_history: workspace_id FK CASCADE, note_id nullable with no FK so delete/purge leave the
// event row intact. Device-local: excluded from export/sync by construction (no export path
// reads this table; every command is http:false).
//
// Retention (owner-fixed ceiling — no unbounded growth):
//   ACTIVITY_RETENTION_DAYS (7) OR ACTIVITY_MAX_ROWS (2000 per workspace), whichever first.
// Prune runs in the same transaction as every insert (same pattern as note_snapshots prune).
use crate::error::{db as dberr, AppResult};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

/// Max age for activity_log rows. Older rows are deleted on every insert. Named const so the
/// ceiling is greppable — bump here only (pair with ACTIVITY_MAX_ROWS; either can fire first).
pub const ACTIVITY_RETENTION_DAYS: i64 = 7;
/// Max rows kept per workspace. Insert-time prune drops oldest beyond this. Named const so the
/// ceiling is greppable — bump here only (pair with ACTIVITY_RETENTION_DAYS).
pub const ACTIVITY_MAX_ROWS: i64 = 2000;

pub const KIND_CREATE: &str = "create";
pub const KIND_DELETE: &str = "delete";
pub const KIND_EDIT: &str = "edit";
pub const KIND_RESTORE: &str = "restore";
pub const KIND_IMPORT: &str = "import";
/// PLAN-2026-09-04-local-import §2.1 — 수집 러너가 한 run(added>0)마다 남기는 요약 한 줄
/// ("<소스명> N건"). note_id는 항상 None(여러 노트를 한 run이 건드릴 수 있어 하나로 못 좁힌다).
pub const KIND_COLLECT: &str = "collect";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    pub id: String,
    pub workspace_id: String,
    pub note_id: Option<String>,
    pub kind: String,
    pub summary: String,
    pub payload: Option<String>,
    pub created_at: String,
    /// Current live title when the note still exists and is not soft-deleted; None otherwise.
    /// Summary always keeps the name-at-event-time for deleted/purged notes.
    pub note_title: Option<String>,
    /// True when note_id points at a non-soft-deleted note that still exists.
    pub note_alive: bool,
}

/// "제목·본문이 모두 빈 노트" 판정 SQL 조각 — `notes` 별칭이 **`n`** 인 쿼리 안에서만 쓴다.
/// 활동 목록(`list`)과 브리핑 최근 작업 노트(`repo::briefing::recent_notes`)가 같은 판정을 공유한다 — 한쪽만 고치면
/// 활동 패널엔 숨는 빈 노트가 브리핑 카드엔 뜨는(또는 그 반대) 어긋남이 생긴다.
pub(crate) const EMPTY_NOTE_SQL: &str = "(TRIM(n.title) IN ('', 'Untitled Note') AND NOT EXISTS (
                   SELECT 1 FROM sections s
                   WHERE s.note_id = n.id AND TRIM(s.body_md) NOT IN ('', '<p></p>')
                 ))";

fn cutoff_iso(days: i64) -> String {
    use chrono::SecondsFormat;
    (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Resolve workspace_id for a note via its folder. Works for soft-deleted notes too (row still
/// present). Returns None only when the note row itself is gone (purged).
pub fn workspace_id_for_note(conn: &Connection, note_id: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT f.workspace_id FROM notes n
         JOIN folders f ON f.id = n.folder_id
         WHERE n.id = ?1",
        [note_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(dberr)
}

pub fn note_title(conn: &Connection, note_id: &str) -> AppResult<Option<String>> {
    conn.query_row("SELECT title FROM notes WHERE id = ?1", [note_id], |r| r.get::<_, String>(0))
        .optional()
        .map_err(dberr)
}

/// Insert one activity row and prune age + count ceilings in the same transaction. Best-effort
/// callers (create/delete/edit paths) should ignore Err so a log failure never blocks the main
/// write — but tests call this directly and assert Ok.
pub fn record(
    conn: &mut Connection,
    workspace_id: &str,
    note_id: Option<&str>,
    kind: &str,
    summary: &str,
    payload: Option<&str>,
) -> AppResult<ActivityItem> {
    let tx = conn.transaction().map_err(dberr)?;
    let id = new_id();
    let created_at = now_iso();
    tx.execute(
        "INSERT INTO activity_log (id, workspace_id, note_id, kind, summary, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, workspace_id, note_id, kind, summary, payload, created_at],
    )
    .map_err(dberr)?;

    // Age prune first, then count prune — either ceiling can fire; both run so neither is skipped.
    tx.execute(
        "DELETE FROM activity_log WHERE workspace_id = ?1 AND created_at < ?2",
        params![workspace_id, cutoff_iso(ACTIVITY_RETENTION_DAYS)],
    )
    .map_err(dberr)?;
    tx.execute(
        "DELETE FROM activity_log WHERE workspace_id = ?1 AND id NOT IN (
           SELECT id FROM activity_log WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2
         )",
        params![workspace_id, ACTIVITY_MAX_ROWS],
    )
    .map_err(dberr)?;

    tx.commit().map_err(dberr)?;

    // Fresh read for note_alive / note_title (note may already be gone for delete events).
    // W7-f: note_alive intentionally stays deleted_at-only (archived_at not checked) — an
    // archived note is still a normal, fully navigable note (only hidden from passive browsing
    // surfaces), so activity entries about it should still resolve "alive" and stay clickable.
    let (note_title, note_alive) = match note_id {
        Some(nid) => {
            let row: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT title, deleted_at FROM notes WHERE id = ?1",
                    [nid],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(dberr)?;
            match row {
                Some((title, deleted_at)) => (Some(title), deleted_at.is_none()),
                None => (None, false),
            }
        }
        None => (None, false),
    };

    Ok(ActivityItem {
        id,
        workspace_id: workspace_id.to_string(),
        note_id: note_id.map(|s| s.to_string()),
        kind: kind.to_string(),
        summary: summary.to_string(),
        payload: payload.map(|s| s.to_string()),
        created_at,
        note_title,
        note_alive,
    })
}

/// Transaction-aware activity write for compound domain operations. It keeps the same retention
/// guarantees as `record`, but lets an AI plan action commit its mutation, receipt, AI audit and
/// user-facing activity atomically.
pub(crate) fn record_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    note_id: Option<&str>,
    kind: &str,
    summary: &str,
    payload: Option<&str>,
) -> AppResult<()> {
    let id = new_id();
    let created_at = now_iso();
    tx.execute(
        "INSERT INTO activity_log (id, workspace_id, note_id, kind, summary, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, workspace_id, note_id, kind, summary, payload, created_at],
    )
    .map_err(dberr)?;
    tx.execute(
        "DELETE FROM activity_log WHERE workspace_id = ?1 AND created_at < ?2",
        params![workspace_id, cutoff_iso(ACTIVITY_RETENTION_DAYS)],
    )
    .map_err(dberr)?;
    tx.execute(
        "DELETE FROM activity_log WHERE workspace_id = ?1 AND id NOT IN (
           SELECT id FROM activity_log WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2
         )",
        params![workspace_id, ACTIVITY_MAX_ROWS],
    )
    .map_err(dberr)?;
    Ok(())
}

/// Convenience: resolve workspace from note, record, ignore missing note/ws. Never fails the
/// caller's main path — swallows errors after best-effort logging attempt.
pub fn record_for_note(
    conn: &mut Connection,
    note_id: &str,
    kind: &str,
    summary: &str,
    payload: Option<&str>,
) {
    let Ok(Some(ws)) = workspace_id_for_note(conn, note_id) else {
        return;
    };
    let _ = record(conn, &ws, Some(note_id), kind, summary, payload);
}

/// List newest-first for a workspace. Default limit 200, hard cap 500.
pub fn list(
    conn: &Connection,
    workspace_id: &str,
    limit: Option<i64>,
) -> AppResult<Vec<ActivityItem>> {
    let lim = limit.unwrap_or(200).clamp(1, 500);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT a.id, a.workspace_id, a.note_id, a.kind, a.summary, a.payload, a.created_at,
                    n.title, n.deleted_at
             FROM activity_log a
             LEFT JOIN notes n ON n.id = a.note_id
             WHERE a.workspace_id = ?1
               -- 제목·본문이 모두 빈 노트의 줄은 소음이라 숨긴다(휴지통 여부 무관 — 조회 시점 판정이라
               -- 내용이 생기면 줄이 그대로 다시 보인다).
               -- 조회 한 곳에서 거른다: 기록 경로가 여럿(create/edit/delete/AI)이라 쓰기 쪽 가드는 새기 쉽다.
               -- ponytail: 완전 삭제된 노트(n 없음)는 내용을 알 수 없어 줄이 남는다 — n.id 가드가 그 NULL 을 막는다.
               AND NOT (n.id IS NOT NULL AND {EMPTY_NOTE_SQL})
             ORDER BY a.created_at DESC
             LIMIT ?2"
        ))
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, lim], |r| {
            let note_id: Option<String> = r.get(2)?;
            let live_title: Option<String> = r.get(7)?;
            let deleted_at: Option<String> = r.get(8)?;
            // W7-f: same posture as record()'s note_alive above — archived_at not checked.
            let note_alive = note_id.is_some() && live_title.is_some() && deleted_at.is_none();
            Ok(ActivityItem {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                note_id,
                kind: r.get(3)?,
                summary: r.get(4)?,
                payload: r.get(5)?,
                created_at: r.get(6)?,
                note_title: live_title,
                note_alive,
            })
        })
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        // note_title: live title when join hits (alive or soft-deleted); None when purged.
        // note_alive gates "open note" on the frontend. Summary always holds name-at-event-time.
        out.push(row.map_err(dberr)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;

    fn setup() -> (rusqlite::Connection, String, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        (conn, ws_id, folder_id)
    }

    #[test]
    fn delete_note_leaves_delete_event_row_no_fk() {
        let (mut conn, ws, folder_id) = setup();
        let detail = notes::create(&mut conn, &folder_id, Some("Doomed".into()), None).unwrap();
        let note_id = detail.note.id.clone();

        // Soft-delete wires a KIND_DELETE row (summary = title at delete time).
        notes::delete(&mut conn, &note_id).unwrap();
        // Hard-purge removes the notes row — an ON DELETE CASCADE FK would wipe activity_log too.
        notes::purge(&mut conn, std::path::Path::new("."), &note_id).unwrap();

        let items = list(&conn, &ws, Some(50)).unwrap();
        let delete_ev = items
            .iter()
            .find(|i| i.kind == KIND_DELETE && i.note_id.as_deref() == Some(note_id.as_str()));
        assert!(
            delete_ev.is_some(),
            "delete event must survive note purge (no FK on note_id): {items:?}"
        );
        assert!(!delete_ev.unwrap().note_alive);
        assert_eq!(delete_ev.unwrap().summary, "Doomed");
        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn retention_prunes_rows_older_than_7_days() {
        let (mut conn, ws, _folder) = setup();
        let old = (chrono::Utc::now() - chrono::Duration::days(8))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO activity_log(id, workspace_id, note_id, kind, summary, payload, created_at)
             VALUES ('old1', ?1, NULL, 'create', 'old', NULL, ?2)",
            params![ws, old],
        )
        .unwrap();
        // Recent row to prove we don't wipe everything.
        let recent = (chrono::Utc::now() - chrono::Duration::days(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO activity_log(id, workspace_id, note_id, kind, summary, payload, created_at)
             VALUES ('recent1', ?1, NULL, 'create', 'recent', NULL, ?2)",
            params![ws, recent],
        )
        .unwrap();

        record(&mut conn, &ws, None, KIND_CREATE, "trigger", None).unwrap();

        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM activity_log WHERE workspace_id=?1")
                .unwrap();
            let rows = stmt.query_map([&ws], |r| r.get::<_, String>(0)).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        assert!(!ids.contains(&"old1".to_string()), "8-day-old row must be pruned: {ids:?}");
        assert!(ids.contains(&"recent1".to_string()), "1-day-old row must survive");
    }

    #[test]
    fn retention_prunes_beyond_2000_rows() {
        let (mut conn, ws, _folder) = setup();
        // Insert ACTIVITY_MAX_ROWS + 50 raw rows with ascending timestamps, then one record()
        // which should leave at most ACTIVITY_MAX_ROWS.
        let base = chrono::Utc::now() - chrono::Duration::hours(1);
        for i in 0..(ACTIVITY_MAX_ROWS + 50) {
            let ts = (base + chrono::Duration::milliseconds(i))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            conn.execute(
                "INSERT INTO activity_log(id, workspace_id, note_id, kind, summary, payload, created_at)
                 VALUES (?1, ?2, NULL, 'edit', ?3, NULL, ?4)",
                params![format!("row{i}"), ws, format!("s{i}"), ts],
            )
            .unwrap();
        }
        record(&mut conn, &ws, None, KIND_CREATE, "cap", None).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity_log WHERE workspace_id=?1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            count <= ACTIVITY_MAX_ROWS,
            "must prune to ≤{ACTIVITY_MAX_ROWS}, got {count}"
        );
        // Newest (the record() we just made) must be present.
        let top = list(&conn, &ws, Some(1)).unwrap();
        assert_eq!(top[0].summary, "cap");
    }

    #[test]
    fn workspace_delete_cascades_activity_log() {
        let (mut conn, ws, _folder_id) = setup();
        record(
            &mut conn,
            &ws,
            None,
            KIND_IMPORT,
            "Imported 3 notes",
            None,
        )
        .unwrap();
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity_log WHERE workspace_id=?1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        assert!(before >= 1);

        // Application forbids deleting the last workspace, so plant a spare first. Raw DELETE
        // (FK ON) is enough to prove activity_log's workspace_id CASCADE — same path
        // workspaces::delete takes after its own pre-checks.
        let now = now_iso();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws-spare', 'Spare', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute("DELETE FROM workspaces WHERE id=?1", [&ws]).unwrap();
        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity_log WHERE workspace_id=?1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 0, "workspace delete must CASCADE activity_log rows");
    }

    #[test]
    fn list_hides_rows_of_empty_untitled_notes() {
        let (mut conn, ws, folder_id) = setup();
        let trashed = notes::create(&mut conn, &folder_id, None, None).unwrap();
        notes::delete(&mut conn, &trashed.note.id).unwrap();
        let live_empty = notes::create(&mut conn, &folder_id, None, None).unwrap();
        let kept = notes::create(&mut conn, &folder_id, Some("Keep".into()), None).unwrap();
        let items = list(&conn, &ws, Some(50)).unwrap();
        for gone in [&trashed.note.id, &live_empty.note.id] {
            assert!(items.iter().all(|i| i.note_id.as_deref() != Some(gone.as_str())), "{items:?}");
        }
        assert!(items.iter().any(|i| i.note_id.as_deref() == Some(kept.note.id.as_str())));
    }

    #[test]
    fn create_wire_records_create_event() {
        let (mut conn, ws, folder_id) = setup();
        let detail = notes::create(&mut conn, &folder_id, Some("Fresh".into()), None).unwrap();
        let items = list(&conn, &ws, Some(10)).unwrap();
        let found = items.iter().any(|i| {
            i.kind == KIND_CREATE
                && i.note_id.as_deref() == Some(detail.note.id.as_str())
                && i.summary.contains("Fresh")
        });
        assert!(found, "create must record an activity event: {items:?}");
    }
}
