// repo: taxonomy — 워크스페이스별 사용자 확장 지역/시대 (Wave 14, commands/workspaces.yaml 확장).
// 내장 프리셋(korea/france)의 지역/시대 목록은 src/lib/eras.ts 에 하드코딩된 상수라 DB에 없다 —
// 여기 저장되는 행은 전부 "사용자가 추가한" 항목이다. 프론트가 두 출처(내장 상수 + 이 목록)를
// 합쳐서 렌더링하고, 삭제 버튼은 이 테이블 유래 행에만 보여준다(내장 프리셋은 코드 상수라
// 애초에 지울 대상이 아니다 — owner 결정, service 문서 참조).
//
// 워크스페이스 삭제 시 CASCADE로 함께 삭제된다(migrations.rs V8_SQL). notes.region 은 이 테이블을
// 참조하는 FK가 아니라 독립된 자유 텍스트 컬럼이므로, 여기서 지역을 삭제해도 그 지역명을 쓰던
// 노트의 region 값은 그대로 남는다(고아 참조가 아니라 "그 값을 제안 목록에서 더는 보여주지
// 않을 뿐" — 노트 손상 없음).
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::folders::active_workspace_id;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RegionEntry {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EraEntry {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub from_year: i64,
    pub to_year: i64,
    pub position: i64,
}

/// notes.year 와 동일한 유효 범위 (specs/db/schemas/notes.sql CHECK).
const YEAR_MIN: i64 = -9999;
const YEAR_MAX: i64 = 9999;

fn resolve_ws(conn: &Connection, workspace_id: Option<String>) -> AppResult<String> {
    match workspace_id {
        Some(id) => Ok(id),
        None => active_workspace_id(conn),
    }
}

fn workspace_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    conn.query_row("SELECT 1 FROM workspaces WHERE id=?1", [id], |_| Ok(true))
        .optional()
        .map_err(dberr)
        .map(|o| o.unwrap_or(false))
}

// ── shared (id, workspace_id, name, position) CRUD — regions/statuses only. Eras has 2 extra
// columns (from_year/to_year) and its own ORDER BY, so it keeps its own list/add below; `remove`
// is identical shape (delete + tombstone) so eras shares `remove_named`. `table` is always a
// `&'static str` literal from call sites in this file (never user input), so format!-ing it into
// SQL carries no injection risk.
fn list_named(conn: &Connection, table: &'static str, workspace_id: Option<String>) -> AppResult<Vec<(String, String, String, i64)>> {
    let ws = resolve_ws(conn, workspace_id)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, workspace_id, name, position FROM {table}
             WHERE workspace_id=?1 ORDER BY position, name COLLATE NOCASE"
        ))
        .map_err(dberr)?;
    let rows = stmt
        .query_map([&ws], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

fn next_position(conn: &Connection, table: &'static str, ws: &str) -> AppResult<i64> {
    conn.query_row(
        &format!("SELECT COALESCE(MAX(position)+1, 0) FROM {table} WHERE workspace_id=?1"),
        [ws],
        |r| r.get(0),
    )
    .map_err(dberr)
}

/// `case_insensitive`는 기존 동작 차이를 보존한다 — 리전은 대소문자 구분 중복 검사, 상태는
/// COLLATE NOCASE (드리프트 아니라 이미 있던 차이).
fn name_exists(conn: &Connection, table: &'static str, ws: &str, name: &str, case_insensitive: bool) -> AppResult<bool> {
    let sql = if case_insensitive {
        format!("SELECT 1 FROM {table} WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE")
    } else {
        format!("SELECT 1 FROM {table} WHERE workspace_id=?1 AND name=?2")
    };
    conn.query_row(&sql, params![ws, name], |_| Ok(true))
        .optional()
        .map_err(dberr)
        .map(|o| o.unwrap_or(false))
}

fn insert_named(conn: &Connection, table: &'static str, id: &str, ws: &str, name: &str, position: i64, now: &str) -> AppResult<()> {
    conn.execute(
        &format!("INSERT INTO {table}(id, workspace_id, name, position, created_at) VALUES (?1,?2,?3,?4,?5)"),
        params![id, ws, name, position, now],
    )
    .map_err(dberr)?;
    Ok(())
}

/// regions/eras 공용 삭제 — DELETE + tombstone. statuses는 삭제 전 notes.status 초기화가 추가로
/// 필요해 자체 구현을 유지한다(remove_status 참조).
fn remove_named(conn: &mut Connection, table: &'static str, entity_label: &str, id: &str) -> AppResult<()> {
    let tx = conn.transaction().map_err(dberr)?;
    let n = tx
        .execute(&format!("DELETE FROM {table} WHERE id=?1"), [id])
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("{entity_label} not found: {id}")));
    }
    crate::repo::tombstone::record_tombstone(&tx, table, id)?;
    tx.commit().map_err(dberr)?;
    Ok(())
}

// ── regions ─────────────────────────────────────────────────────────────────

pub fn list_regions(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<RegionEntry>> {
    Ok(list_named(conn, "workspace_regions", workspace_id)?
        .into_iter()
        .map(|(id, workspace_id, name, position)| RegionEntry { id, workspace_id, name, position })
        .collect())
}

pub fn add_region(conn: &mut Connection, workspace_id: Option<String>, name: &str) -> AppResult<RegionEntry> {
    let ws = resolve_ws(conn, workspace_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("region name is empty".to_string()));
    }
    if !workspace_exists(conn, &ws)? {
        return Err(AppError::NotFound(format!("workspace not found: {ws}")));
    }
    if name_exists(conn, "workspace_regions", &ws, name, false)? {
        return Err(AppError::Conflict(format!("region already exists: {name}")));
    }
    let id = new_id();
    let now = now_iso();
    let position = next_position(conn, "workspace_regions", &ws)?;
    insert_named(conn, "workspace_regions", &id, &ws, name, position, &now)?;
    Ok(RegionEntry {
        id,
        workspace_id: ws,
        name: name.to_string(),
        position,
    })
}

/// 지역 제거 — 이 지역명을 쓰는 노트가 있어도 notes.region 은 독립 자유 텍스트라 그대로 남는다.
pub fn remove_region(conn: &mut Connection, id: &str) -> AppResult<()> {
    remove_named(conn, "workspace_regions", "region", id)
}

// ── eras ────────────────────────────────────────────────────────────────────

pub fn list_eras(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<EraEntry>> {
    let ws = resolve_ws(conn, workspace_id)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, from_year, to_year, position FROM workspace_eras
             WHERE workspace_id=?1 ORDER BY position, from_year",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([&ws], |r| {
            Ok(EraEntry {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                from_year: r.get(3)?,
                to_year: r.get(4)?,
                position: r.get(5)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

pub fn add_era(
    conn: &mut Connection,
    workspace_id: Option<String>,
    name: &str,
    from_year: i64,
    to_year: i64,
) -> AppResult<EraEntry> {
    let ws = resolve_ws(conn, workspace_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("era name is empty".to_string()));
    }
    if from_year < YEAR_MIN || from_year > YEAR_MAX || to_year < YEAR_MIN || to_year > YEAR_MAX {
        return Err(AppError::Validation(format!(
            "era year out of range ({YEAR_MIN}..{YEAR_MAX})"
        )));
    }
    if to_year <= from_year {
        return Err(AppError::Validation(
            "era to_year must be greater than from_year".to_string(),
        ));
    }
    if !workspace_exists(conn, &ws)? {
        return Err(AppError::NotFound(format!("workspace not found: {ws}")));
    }
    let id = new_id();
    let now = now_iso();
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position)+1, 0) FROM workspace_eras WHERE workspace_id=?1",
            [&ws],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    conn.execute(
        "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, ws, name, from_year, to_year, position, now],
    )
    .map_err(dberr)?;
    Ok(EraEntry {
        id,
        workspace_id: ws,
        name: name.to_string(),
        from_year,
        to_year,
        position,
    })
}

pub fn remove_era(conn: &mut Connection, id: &str) -> AppResult<()> {
    remove_named(conn, "workspace_eras", "era", id)
}

// ── statuses (Wave 15) ─────────────────────────────────────────────────────
// 노트 진행 상태. 내장 3종("작성중"/"내보냄"/"완료")은 이 테이블의 행이 아니라 코드 상수로만
// 존재한다(regions/eras 의 "내장 프리셋은 상수, 사용자 추가분만 테이블" 원칙과 동일) — 그래서
// "내장 상태는 삭제 불가"가 별도 방어 로직 없이 자연히 성립한다. 라벨/색상은 프론트
// (src/lib/status.ts)가 소유하고, 여기서는 커스텀 상태 이름이 내장 키와 충돌하지 않도록
// 검증하는 데만 이 목록을 쓴다.
pub const BUILT_IN_STATUSES: [&str; 3] = ["in_progress", "exported", "done"];

#[derive(Debug, Clone, Serialize)]
pub struct StatusEntry {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
}

pub fn list_statuses(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<StatusEntry>> {
    Ok(list_named(conn, "workspace_statuses", workspace_id)?
        .into_iter()
        .map(|(id, workspace_id, name, position)| StatusEntry { id, workspace_id, name, position })
        .collect())
}

/// 커스텀 상태 추가 — 내장 상태명 및 같은 워크스페이스의 기존 커스텀 상태명과 대소문자 무시
/// 충돌 시 VALIDATION(DB UNIQUE 위반을 그대로 노출하지 않고 사람이 읽을 수 있는 메시지로).
pub fn add_status(conn: &mut Connection, workspace_id: Option<String>, name: &str) -> AppResult<StatusEntry> {
    let ws = resolve_ws(conn, workspace_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("status name is empty".to_string()));
    }
    if !workspace_exists(conn, &ws)? {
        return Err(AppError::NotFound(format!("workspace not found: {ws}")));
    }
    if BUILT_IN_STATUSES.iter().any(|b| b.eq_ignore_ascii_case(name)) {
        return Err(AppError::Validation(format!(
            "\"{name}\" collides with a built-in status"
        )));
    }
    if name_exists(conn, "workspace_statuses", &ws, name, true)? {
        return Err(AppError::Conflict(format!("status already exists: {name}")));
    }
    let id = new_id();
    let now = now_iso();
    let position = next_position(conn, "workspace_statuses", &ws)?;
    insert_named(conn, "workspace_statuses", &id, &ws, name, position, &now)?;
    Ok(StatusEntry {
        id,
        workspace_id: ws,
        name: name.to_string(),
        position,
    })
}

/// 커스텀 상태 이름 변경 — 검증은 add_status 와 동일(빈 이름/내장 충돌/NOCASE 중복). 노트는
/// 상태를 id 로 참조하므로 notes 는 건드리지 않는다. 자기 자신의 대소문자만 바꾸는 rename 은
/// 허용(NOCASE 중복 검사에서 자기 행을 제외).
/// ponytail: workspace_statuses 에는 updated_at 컬럼이 없어 별도 bump 없음 — 병합(hash_merge)은
/// name COLLATE NOCASE 존재 여부로만 판단하므로, 원격에 옛 이름이 남아 있으면 재수입될 수 있다.
/// 이름 변경을 동기화로 전파하려면 컬럼 추가 + 병합 규칙 확장이 필요(add/remove 도 동일한 천장).
pub fn rename_status(conn: &mut Connection, id: &str, name: &str) -> AppResult<StatusEntry> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("status name is empty".to_string()));
    }
    if BUILT_IN_STATUSES.iter().any(|b| b.eq_ignore_ascii_case(name)) {
        return Err(AppError::Validation(format!(
            "\"{name}\" collides with a built-in status"
        )));
    }
    let (ws, position): (String, i64) = conn
        .query_row(
            "SELECT workspace_id, position FROM workspace_statuses WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("status not found: {id}")))?;
    let conflict: bool = conn
        .query_row(
            "SELECT 1 FROM workspace_statuses WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE AND id<>?3",
            params![ws, name, id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if conflict {
        return Err(AppError::Conflict(format!("status already exists: {name}")));
    }
    conn.execute(
        "UPDATE workspace_statuses SET name=?1 WHERE id=?2",
        params![name, id],
    )
    .map_err(dberr)?;
    Ok(StatusEntry {
        id: id.to_string(),
        workspace_id: ws,
        name: name.to_string(),
        position,
    })
}

/// 커스텀 상태 삭제 — 이 상태를 참조하던 노트는 status=NULL 로 되돌린다(고아 참조 방지, folder
/// 삭제 시 하위 정리와 동일한 관례). 단일 트랜잭션.
pub fn remove_status(conn: &mut Connection, id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM workspace_statuses WHERE id=?1", [id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("status not found: {id}")));
    }
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("UPDATE notes SET status=NULL WHERE status=?1", [id])
        .map_err(dberr)?;
    tx.execute("DELETE FROM workspace_statuses WHERE id=?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "workspace_statuses", id)?;
    tx.commit().map_err(dberr)?;
    Ok(())
}

/// `status`(내장 키 또는 workspace_statuses.id)가 주어진 워크스페이스에서 유효한지 검증.
/// None 은 언제나 유효(상태 해제) — repo/notes.rs::set_status 가 저장 전에 호출한다.
pub fn validate_status_for_workspace(
    conn: &Connection,
    workspace_id: &str,
    status: &Option<String>,
) -> AppResult<()> {
    let Some(s) = status else { return Ok(()) };
    if BUILT_IN_STATUSES.contains(&s.as_str()) {
        return Ok(());
    }
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM workspace_statuses WHERE id=?1 AND workspace_id=?2",
            params![s, workspace_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if exists {
        Ok(())
    } else {
        Err(AppError::Validation(format!("unknown status: {s}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;

    fn setup_db() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        (conn, ws)
    }

    #[test]
    fn rename_status_roundtrip() {
        let (mut conn, ws) = setup_db();
        let s = add_status(&mut conn, Some(ws.clone()), "Draft").unwrap();
        let renamed = rename_status(&mut conn, &s.id, "  Revu  ").unwrap();
        assert_eq!(renamed.id, s.id);
        assert_eq!(renamed.name, "Revu");
        assert_eq!(renamed.position, s.position);
        let listed = list_statuses(&conn, Some(ws)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Revu");
        assert_eq!(listed[0].id, s.id);
    }

    #[test]
    fn rename_status_to_builtin_rejected() {
        let (mut conn, ws) = setup_db();
        let s = add_status(&mut conn, Some(ws), "Draft").unwrap();
        // 내장 키와 대소문자 무시 충돌 — add_status 와 동일 규칙.
        assert!(matches!(
            rename_status(&mut conn, &s.id, "DONE"),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            rename_status(&mut conn, &s.id, "in_progress"),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn rename_status_nocase_conflict_rejected() {
        let (mut conn, ws) = setup_db();
        let a = add_status(&mut conn, Some(ws.clone()), "Alpha").unwrap();
        let b = add_status(&mut conn, Some(ws), "Beta").unwrap();
        assert!(matches!(
            rename_status(&mut conn, &b.id, "alpha"),
            Err(AppError::Conflict(_))
        ));
        // 자기 자신의 대소문자만 바꾸는 rename 은 충돌이 아니다.
        let re = rename_status(&mut conn, &a.id, "ALPHA").unwrap();
        assert_eq!(re.name, "ALPHA");
    }

    #[test]
    fn rename_status_missing_id_not_found() {
        let (mut conn, _ws) = setup_db();
        assert!(matches!(
            rename_status(&mut conn, "no-such-id", "X"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn rename_status_empty_name_rejected() {
        let (mut conn, ws) = setup_db();
        let s = add_status(&mut conn, Some(ws), "Draft").unwrap();
        assert!(matches!(
            rename_status(&mut conn, &s.id, "   "),
            Err(AppError::Validation(_))
        ));
    }
}
