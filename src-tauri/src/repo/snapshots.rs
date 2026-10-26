// repo: note_snapshots — editor autosave cache (commands/snapshots.yaml, migration v31).
// Owner spec: "에디터에 1분마다 스냅샷처럼 자동저장하고 30분은 저장되도록" — a rolling local
// working cache captured while a note is open, NOT a version-history feature. One row per
// capture; capture() prunes anything older than 30 minutes for that note in the same call, so a
// note pinned open all day still only ever holds ~30 rows (SNAPSHOT_WINDOW_MINUTES below).
//
// payload is a JSON array of PayloadSection {section_id, title, kind, body_md} — title/kind mirror
// sections.name/sections.kind (repo::sections::Section), body_md is the section's markdown.
// Device-local: excluded from export/import bundles and the sync HTTP surface by construction —
// no export/sync code path reads this table, and every command below is http:false
// (specs/commands/snapshots.yaml).
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::{fts, sections};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// ponytail: 30분 고정 — 사용자 설정 가능한 값이 아니다(owner spec 그대로). 1분 주기(프론트
/// 스케줄러) 기준 노트당 최대 ~30행. 늘리려면 이 상수만 바꾸면 된다(윈도우가 곧 상한).
const SNAPSHOT_WINDOW_MINUTES: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayloadSection {
    pub section_id: String,
    pub title: String,
    pub kind: String,
    pub body_md: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotMeta {
    pub id: String,
    pub taken_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotListItem {
    pub id: String,
    pub taken_at: String,
    pub section_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotDetail {
    pub id: String,
    pub note_id: String,
    pub taken_at: String,
    pub sections: Vec<PayloadSection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreResult {
    pub note_id: String,
    pub updated_at: String,
    /// 스냅샷 시점에도 있었고 지금도 있는 섹션 — body_md만 되돌린다(이름/kind는 건드리지 않음).
    pub restored_count: i64,
    /// 스냅샷 시점엔 있었지만 지금은 없는 섹션 — title/kind/body_md 그대로 새로 만든다.
    pub recreated_count: i64,
    /// 지금은 있지만 스냅샷엔 없던 섹션 — 그대로 둔다(개수만 보고).
    pub extra_count: i64,
    /// 복원 직전 현재 상태를 찍어둔 안전 스냅샷 id — 복원도 되돌릴 수 있게.
    pub safety_snapshot_id: String,
}

fn cutoff_iso(minutes: i64) -> String {
    use chrono::SecondsFormat;
    (chrono::Utc::now() - chrono::Duration::minutes(minutes)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn note_exists(conn: &Connection, note_id: &str) -> AppResult<bool> {
    conn.query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)
        .map(|o| o.unwrap_or(false))
}

/// capture()/restore() 공용 코어 — 현재 섹션들을 payload로 찍어 한 행 insert하고, 그 노트의
/// 30분 지난 행을 같은 호출 안에서 정리한다(별도 백그라운드 잡 없음, owner spec). restore()가
/// 복원 직전 안전 스냅샷을 찍을 때도 이 함수를 그대로 재사용한다(중복 없음).
fn capture_internal(tx: &Transaction, note_id: &str) -> AppResult<SnapshotMeta> {
    if !note_exists(tx, note_id)? {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    let secs = sections::load_for_note(tx, note_id)?;
    let payload: Vec<PayloadSection> = secs
        .into_iter()
        .map(|s| PayloadSection { section_id: s.id, title: s.name, kind: s.kind, body_md: s.body_md })
        .collect();
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| AppError::Db(format!("snapshot payload serialize error: {e}")))?;
    let id = new_id();
    let taken_at = now_iso();
    tx.execute(
        "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES (?1, ?2, ?3, ?4)",
        params![id, note_id, taken_at, payload_json],
    )
    .map_err(dberr)?;
    tx.execute(
        "DELETE FROM note_snapshots WHERE note_id=?1 AND taken_at < ?2",
        params![note_id, cutoff_iso(SNAPSHOT_WINDOW_MINUTES)],
    )
    .map_err(dberr)?;
    Ok(SnapshotMeta { id, taken_at })
}

pub fn capture(conn: &mut Connection, note_id: &str) -> AppResult<SnapshotMeta> {
    let tx = conn.transaction().map_err(dberr)?;
    let meta = capture_internal(&tx, note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(meta)
}

/// note_id가 존재하지 않거나 스냅샷이 없어도 그냥 빈 목록 — sections::load_for_note와 동일한
/// 관례(존재 검증은 쓰기 경로에만).
pub fn list(conn: &Connection, note_id: &str) -> AppResult<Vec<SnapshotListItem>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, taken_at, payload FROM note_snapshots
             WHERE note_id=?1 ORDER BY taken_at DESC",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([note_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, taken_at, payload_json) = row.map_err(dberr)?;
        let section_count = serde_json::from_str::<Vec<PayloadSection>>(&payload_json)
            .map(|v| v.len() as i64)
            .unwrap_or(0);
        out.push(SnapshotListItem { id, taken_at, section_count });
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<SnapshotDetail> {
    let (note_id, taken_at, payload_json): (String, String, String) = conn
        .query_row(
            "SELECT note_id, taken_at, payload FROM note_snapshots WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("snapshot not found: {id}")))?;
    let sections: Vec<PayloadSection> = serde_json::from_str(&payload_json)
        .map_err(|e| AppError::Db(format!("snapshot payload parse error: {e}")))?;
    Ok(SnapshotDetail { id: id.to_string(), note_id, taken_at, sections })
}

/// 스냅샷 시점 섹션 본문으로 되돌린다. 되돌리기 전에 "지금" 상태를 안전 스냅샷으로 먼저 찍어
/// (capture_internal 재사용) 복원 자체도 항상 되돌릴 수 있게 한다. 매치는 section_id 기준 —
/// 지금도 있으면 body_md만 교체(이름/kind는 사용자가 그 사이 바꿨을 수 있으니 안 건드림), 지금
/// 없으면 title/kind/body_md 그대로 새로 만든다(위치는 뒤에 이어붙임). 스냅샷에 없던 지금의
/// 섹션은 그대로 둔다 — 개수만 보고한다.
pub fn restore(conn: &mut Connection, id: &str) -> AppResult<RestoreResult> {
    let tx = conn.transaction().map_err(dberr)?;
    let (note_id, payload_json): (String, String) = tx
        .query_row(
            "SELECT note_id, payload FROM note_snapshots WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("snapshot not found: {id}")))?;
    let snapshot_sections: Vec<PayloadSection> = serde_json::from_str(&payload_json)
        .map_err(|e| AppError::Db(format!("snapshot payload parse error: {e}")))?;

    let safety = capture_internal(&tx, &note_id)?;

    let current: Vec<(String, i64)> = {
        let mut stmt = tx
            .prepare("SELECT id, position FROM sections WHERE note_id=?1")
            .map_err(dberr)?;
        let rows = stmt
            .query_map([&note_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    let current_ids: HashSet<&str> = current.iter().map(|(id, _)| id.as_str()).collect();
    let mut next_pos = current.iter().map(|(_, p)| *p).max().unwrap_or(-1) + 1;
    let snapshot_ids: HashSet<&str> = snapshot_sections.iter().map(|s| s.section_id.as_str()).collect();

    let now = now_iso();
    let mut restored_count = 0i64;
    let mut recreated_count = 0i64;
    for sec in &snapshot_sections {
        if current_ids.contains(sec.section_id.as_str()) {
            crate::repo::sections::write_body_tx(&tx, &note_id, &sec.section_id, &sec.body_md, &now)?;
            restored_count += 1;
        } else {
            tx.execute(
                "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![new_id(), note_id, sec.title, sec.body_md, next_pos, now, sec.kind],
            )
            .map_err(dberr)?;
            next_pos += 1;
            recreated_count += 1;
        }
    }
    let extra_count = current_ids.iter().filter(|id| !snapshot_ids.contains(*id)).count() as i64;

    tx.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", params![now, note_id])
        .map_err(dberr)?;
    fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;

    // QA8 Wave 4A — snapshot restore is a first-class activity event (immediate, not tied to
    // the 60s capture cadence). Payload carries the restored snapshot id for drill-down.
    let title = crate::repo::activity::note_title(conn, &note_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| note_id.clone());
    let payload = serde_json::json!({ "snapshot_id": id }).to_string();
    crate::repo::activity::record_for_note(
        conn,
        &note_id,
        crate::repo::activity::KIND_RESTORE,
        &title,
        Some(&payload),
    );

    Ok(RestoreResult {
        note_id,
        updated_at: now,
        restored_count,
        recreated_count,
        extra_count,
        safety_snapshot_id: safety.id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup_db() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        // ON DELETE CASCADE(노트 삭제 시 note_snapshots 정리)는 foreign_keys pragma가 켜져 있어야
        // 발동한다 — repo::notes::tests::setup_db와 동일 패턴.
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('note1', ?1, 'title', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind)
             VALUES ('sec1', 'note1', 'Overview', 'hello', 0, ?1, 'text')",
            params![now],
        )
        .unwrap();
        (conn, "note1".to_string())
    }

    #[test]
    fn capture_stores_current_sections_and_returns_meta() {
        let (mut conn, note_id) = setup_db();
        let meta = capture(&mut conn, &note_id).unwrap();
        assert!(!meta.id.is_empty());

        let list = list(&conn, &note_id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].section_count, 1);

        let detail = get(&conn, &meta.id).unwrap();
        assert_eq!(detail.sections.len(), 1);
        assert_eq!(detail.sections[0].section_id, "sec1");
        assert_eq!(detail.sections[0].title, "Overview");
        assert_eq!(detail.sections[0].body_md, "hello");
        assert_eq!(detail.sections[0].kind, "text");
    }

    #[test]
    fn capture_prunes_snapshots_older_than_30_minutes_for_that_note() {
        let (mut conn, note_id) = setup_db();
        // 40분 전 행을 직접 심는다(시간 조작 대신 — advisor 권고: raw SQL로 오래된 taken_at).
        let old_taken_at = (chrono::Utc::now() - chrono::Duration::minutes(40))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES ('old1', ?1, ?2, '[]')",
            params![note_id, old_taken_at],
        )
        .unwrap();
        // 20분 전(윈도우 안) 행도 심어서 살아남는지 함께 확인.
        let recent_taken_at = (chrono::Utc::now() - chrono::Duration::minutes(20))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES ('recent1', ?1, ?2, '[]')",
            params![note_id, recent_taken_at],
        )
        .unwrap();

        capture(&mut conn, &note_id).unwrap();

        let ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM note_snapshots WHERE note_id=?1 ORDER BY taken_at").unwrap();
            let rows = stmt.query_map([&note_id], |r| r.get::<_, String>(0)).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        assert!(!ids.contains(&"old1".to_string()), "40-minute-old snapshot must be pruned: {ids:?}");
        assert!(ids.contains(&"recent1".to_string()), "20-minute-old snapshot is inside the window, must survive");
    }

    #[test]
    fn capture_note_not_found() {
        let (mut conn, _note_id) = setup_db();
        let err = capture(&mut conn, "nope");
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn restore_round_trip_matched_recreated_and_extra() {
        let (mut conn, note_id) = setup_db();
        let snap = capture(&mut conn, &note_id).unwrap(); // captures sec1="hello"

        // Mutate after the snapshot: change sec1's body, delete-and-recreate isn't possible (last
        // section), so add sec2 (this is the "extra, not in the snapshot" case) and change sec1.
        conn.execute(
            "UPDATE sections SET body_md='edited after snapshot' WHERE id='sec1'",
            [],
        )
        .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind)
             VALUES ('sec2', ?1, 'Extra', 'not in snapshot', 1, ?2, 'text')",
            params![note_id, now],
        )
        .unwrap();
        // Simulate a section deleted after the snapshot but recreated with a NEW id at restore —
        // easier: craft a snapshot payload with a section_id that no longer exists.
        conn.execute(
            "UPDATE note_snapshots SET payload=?1 WHERE id=?2",
            params![
                serde_json::to_string(&vec![
                    PayloadSection { section_id: "sec1".into(), title: "Overview".into(), kind: "text".into(), body_md: "hello".into() },
                    PayloadSection { section_id: "gone-sec".into(), title: "Vanished".into(), kind: "text".into(), body_md: "was here".into() },
                ]).unwrap(),
                snap.id,
            ],
        )
        .unwrap();

        let result = restore(&mut conn, &snap.id).unwrap();
        assert_eq!(result.restored_count, 1, "sec1 matched -> body restored");
        assert_eq!(result.recreated_count, 1, "gone-sec didn't exist -> recreated");
        assert_eq!(result.extra_count, 1, "sec2 exists now but wasn't in the snapshot -> left alone, just counted");

        let sec1_body: String = conn.query_row("SELECT body_md FROM sections WHERE id='sec1'", [], |r| r.get(0)).unwrap();
        assert_eq!(sec1_body, "hello", "sec1 body_md must be restored");

        let sec2_body: String = conn.query_row("SELECT body_md FROM sections WHERE id='sec2'", [], |r| r.get(0)).unwrap();
        assert_eq!(sec2_body, "not in snapshot", "extra section must be left untouched");

        let recreated: (String, String, String) = conn
            .query_row(
                "SELECT name, body_md, kind FROM sections WHERE note_id=?1 AND name='Vanished'",
                [&note_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(recreated, ("Vanished".to_string(), "was here".to_string(), "text".to_string()));
    }

    #[test]
    fn restore_captures_a_pre_restore_safety_snapshot() {
        let (mut conn, note_id) = setup_db();
        let snap = capture(&mut conn, &note_id).unwrap(); // sec1="hello"
        conn.execute("UPDATE sections SET body_md='changed before restore' WHERE id='sec1'", []).unwrap();

        let before_count = list(&conn, &note_id).unwrap().len();
        let result = restore(&mut conn, &snap.id).unwrap();
        let after = list(&conn, &note_id).unwrap();

        assert_eq!(after.len(), before_count + 1, "restore must add exactly one safety snapshot");
        assert_ne!(result.safety_snapshot_id, snap.id);
        let safety = get(&conn, &result.safety_snapshot_id).unwrap();
        assert_eq!(
            safety.sections[0].body_md, "changed before restore",
            "safety snapshot must capture the state right before the restore overwrote it"
        );

        // The safety snapshot is itself restorable — undoing the restore works.
        let undo = restore(&mut conn, &result.safety_snapshot_id).unwrap();
        assert_eq!(undo.restored_count, 1);
        let sec1_body: String = conn.query_row("SELECT body_md FROM sections WHERE id='sec1'", [], |r| r.get(0)).unwrap();
        assert_eq!(sec1_body, "changed before restore", "undo of the restore must bring the pre-restore edit back");
    }

    #[test]
    fn restore_not_found() {
        let (mut conn, _note_id) = setup_db();
        let err = restore(&mut conn, "nope");
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn note_snapshots_cascade_deleted_when_note_is_deleted() {
        let (mut conn, note_id) = setup_db();
        capture(&mut conn, &note_id).unwrap();
        capture(&mut conn, &note_id).unwrap();
        assert_eq!(list(&conn, &note_id).unwrap().len(), 2);

        conn.execute("DELETE FROM notes WHERE id=?1", [&note_id]).unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_snapshots WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "ON DELETE CASCADE must remove the note's snapshots");
    }
}
