// repo: note_tags — 태그 테이블 관심사(name/color/note_tags 조인·전체교체). notes.rs에서
// 순수 추출(R4, note_query 분리 선례를 따름). 동작 변경 없음 — `pub use crate::repo::note_tags::*;`
// 로 notes.rs에서 그대로 재수출되어 호출부는 바뀌지 않는다.
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::fts;
use crate::util::{new_id, now_iso};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use std::collections::{HashMap, HashSet};

/// 노트의 태그명 목록 (이름 오름차순).
pub fn tag_names(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN note_tags nt ON nt.tag_id = t.id
             WHERE nt.note_id = ?1 ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([note_id], |r| r.get::<_, String>(0))
        .map_err(dberr)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(dberr)?);
    }
    Ok(out)
}

/// N+1 배치 헬퍼: 여러 note_id의 (tag_id, tag_name) 쌍을 단일 쿼리로 묶어 HashMap(note_id -> Vec)
/// 반환한다 — 모바일 웹 클라이언트 GET /api/v1/notes(sync_server::handlers::notes_list)가 노트별로
/// tag_names()를 반복 호출하지 않도록 하기 위한 용도(그 배치는 이름만 주고 id가 없어 이 목적에는
/// 못 쓴다). name COLLATE NOCASE 오름차순 — tag_names()/note_summaries_map과 동일한 정렬 관례.
pub fn tag_refs_for_ids(
    conn: &Connection,
    note_ids: &[String],
) -> AppResult<HashMap<String, Vec<(String, String)>>> {
    let mut out: HashMap<String, Vec<(String, String)>> = HashMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT nt.note_id, t.id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
             WHERE nt.note_id IN ({placeholders}) ORDER BY t.name COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let binds: Vec<Value> = chunk.iter().map(|s| Value::Text(s.clone())).collect();
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(dberr)?;
        for row in rows {
            let (note_id, tag_id, tag_name) = row.map_err(dberr)?;
            out.entry(note_id).or_default().push((tag_id, tag_name));
        }
    }
    Ok(out)
}

/// 워크스페이스 스코프 태그별 노트 수 — 사이드바 TagsFilter / TitleBar allTags 용.
/// Scale Phase 1: 클라가 notesByFolder 를 O(N) 평탄화하던 것을 단일 GROUP BY 로 대체.
/// soft-delete 노트는 제외(클라가 folder_list 에서 못 보는 노트와 동일). 결과 태그 수가
/// SQLite 변수 상한(~32k) 을 넘을 일은 현실적으로 없어 IN-CHUNK 불필요.
/// W7-f: 아카이브 노트도 제외 — 이 카운트는 트리 필터 칩(TagsFilter)이 쓰므로 트리에서 실제로
/// 보이는 노트 집합과 맞아야 한다(folder_list/note_query 기본 경로와 동일 posture). 아카이브
/// 전용 태그가 있으면 그 태그는 칩 목록에서 사라진다 — 이미 휴지통 전용 태그에 대해서도 같은
/// 동작이었으므로 새 회귀는 아니다.
pub fn tag_counts(conn: &Connection, workspace_id: &str) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name, COUNT(*)
             FROM note_tags nt
             JOIN tags t ON t.id = nt.tag_id
             JOIN notes n ON n.id = nt.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
             GROUP BY t.id, t.name
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(dberr)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(dberr)?);
    }
    Ok(out)
}

/// Wave 5a: 워크스페이스 스코프 태그별 color_hue 맵.
/// NULL이 아닌 color_hue를 가진 태그만 (name, hue) 쌍으로 반환.
/// W7-f: tag_counts와 동일하게 아카이브 노트도 제외 — 기존에도 휴지통 전용 태그는 색을 잃는
/// 동작이었으므로(deleted_at 제외가 이미 그 결과를 냈다) 대칭으로 둔다. 유일한 부작용은 오직
/// 아카이브 노트에만 달린 태그를 그 노트를 검색으로 열어 볼 때 칩 색이 빠질 수 있다는 것 —
/// 트리/검색 결과 태그칩 렌더가 hue 미스를 무색 처리로 이미 감당하므로 크래시나 데이터 손실은
/// 없다.
pub fn tag_colors(conn: &Connection, workspace_id: &str) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT t.name, t.color_hue
             FROM note_tags nt
             JOIN tags t ON t.id = nt.tag_id
             JOIN notes n ON n.id = nt.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
               AND t.color_hue IS NOT NULL
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(dberr)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(dberr)?);
    }
    Ok(out)
}

/// Wave 5a: 태그 색상 설정 — name으로 태그를 찾아 color_hue 업데이트.
/// color_hue가 None이면 리셋(NULL). 0..359 범위를 직접 검증한다.
pub fn tag_set_color(conn: &mut Connection, name: &str, color_hue: Option<i64>) -> AppResult<bool> {
    if let Some(h) = color_hue {
        if !(0..=359).contains(&h) {
            return Err(AppError::Validation(format!(
                "color_hue out of range (0..359): {h}"
            )));
        }
    }
    let n = conn
        .execute(
            "UPDATE tags SET color_hue=?1, updated_at=?2 WHERE name=?3 COLLATE NOCASE",
            params![color_hue, now_iso(), name],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("tag not found: {name}")));
    }
    Ok(true)
}

/// 태그명 정규화: trim, 빈 항목 제거, 대소문자 무시 중복 제거(첫 등장 유지).
/// `set_tags`/`apply_ai_organize` 공용 — 두 곳 모두 동일한 규칙을 쓴다.
pub(crate) fn normalize_tag_names(tag_names_in: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for raw in tag_names_in {
        let t = raw.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if !seen.iter().any(|s| s.eq_ignore_ascii_case(&t)) {
            seen.push(t);
        }
    }
    seen
}

/// 노트의 note_tags 를 (이미 정규화된) `tag_names` 로 전체 교체 — 없는 태그명은 자동 생성,
/// 고아 태그 정리까지 수행한다. `set_tags`/`apply_ai_organize` 공용.
/// FTS 갱신은 호출부 책임(호출 시점·조건이 서로 달라 여기 포함하지 않는다 — 이 함수는
/// 트랜잭션을 열거나 커밋하지도 않는다: 호출부가 관리하는 tx 를 그대로 받아 쓴다).
pub(crate) fn replace_note_tags(tx: &Transaction, note_id: &str, tag_names: &[String]) -> AppResult<()> {
    // note_tags 전체 교체(항상 delete+reinsert) — 태그 목록이 실제로 안 바뀐 호출에서도 모든
    // (note_id, tag_id) 쌍이 지워졌다 다시 생긴다. 그래서 tombstone 은 delete 직후가 아니라
    // *재삽입까지 끝난 뒤*, "이번에도 살아남지 못한" 쌍에 대해서만 기록한다 — 안 그러면 값이
    // 그대로인 저장에서도 살아있는 쌍을 "삭제됨"으로 잘못 tombstone 해 동기화 시 부활 버그의
    // 반대(멀쩡한 행이 다른 기기에서 지워짐)를 만든다.
    let old_tag_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT tag_id FROM note_tags WHERE note_id=?1")
            .map_err(dberr)?;
        let rows = stmt
            .query_map([note_id], |r| r.get::<_, String>(0))
            .map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    tx.execute("DELETE FROM note_tags WHERE note_id=?1", [note_id])
        .map_err(dberr)?;
    let now = now_iso();
    let mut new_tag_ids: Vec<String> = Vec::with_capacity(tag_names.len());
    for name in tag_names {
        // tags 는 name COLLATE NOCASE UNIQUE — 존재하면 재사용.
        let tag_id: String = match tx
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| r.get(0),
            )
            .optional()
            .map_err(dberr)?
        {
            Some(existing) => existing,
            None => {
                let new = new_id();
                tx.execute(
                    "INSERT INTO tags(id, name, updated_at) VALUES (?1, ?2, ?3)",
                    params![new, name, now],
                )
                .map_err(dberr)?;
                new
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )
        .map_err(dberr)?;
        new_tag_ids.push(tag_id);
    }
    // G2: 재삽입되지 않고(=이번 교체로 실제로 떨어져 나간) 쌍만 명시적 삭제(CASCADE 아님)로
    // tombstone 한다. "{note_id}:{tag_id}" 를 id로 쓴다.
    for tag_id in &old_tag_ids {
        if !new_tag_ids.contains(tag_id) {
            crate::repo::tombstone::record_tombstone(tx, "note_tags", &format!("{note_id}:{tag_id}"))?;
        }
    }
    // 고아 태그 정리 — 명시적 삭제(CASCADE 아님)이므로 각 태그를 직접 tombstone 한다.
    let orphan_tag_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)")
            .map_err(dberr)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    tx.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )
    .map_err(dberr)?;
    for tag_id in &orphan_tag_ids {
        crate::repo::tombstone::record_tombstone(tx, "tags", tag_id)?;
    }
    Ok(())
}

/// 태그 전체 교체 — 없는 태그명은 자동 생성, 고아 태그 정리, FTS upsert.
pub fn set_tags(conn: &mut Connection, id: &str, tag_names_in: Vec<String>) -> AppResult<Vec<String>> {
    let _ = crate::repo::notes::note_summary(conn, id)?;
    let seen = normalize_tag_names(tag_names_in);

    let tx = conn.transaction().map_err(dberr)?;
    replace_note_tags(&tx, id, &seen)?;
    fts::fts_upsert(&tx, id)?;
    tx.commit().map_err(dberr)?;

    tag_names(conn, id)
}

fn find_tag(conn: &Connection, name: &str) -> AppResult<Option<(String, String)>> {
    conn.query_row(
        "SELECT id, name FROM tags WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(dberr)
}

fn note_ids_for_tag(conn: &Connection, tag_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT note_id FROM note_tags WHERE tag_id=?1")
        .map_err(dberr)?;
    let rows = stmt
        .query_map([tag_id], |r| r.get::<_, String>(0))
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

fn fts_upsert_notes<I, S>(tx: &Transaction, note_ids: I) -> AppResult<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for id in note_ids {
        fts::fts_upsert(tx, id.as_ref())?;
    }
    Ok(())
}

fn rename_tag_in_place(conn: &mut Connection, tag_id: &str, new_name: &str) -> AppResult<i64> {
    let tx = conn.transaction().map_err(dberr)?;
    let note_ids = note_ids_for_tag(&tx, tag_id)?;
    tx.execute(
        "UPDATE tags SET name=?1, updated_at=?2 WHERE id=?3",
        params![new_name, now_iso(), tag_id],
    )
    .map_err(dberr)?;
    fts_upsert_notes(&tx, &note_ids)?;
    tx.commit().map_err(dberr)?;
    Ok(note_ids.len() as i64)
}

/// 태그명 전역 교체. `to` 가 이미 있으면(NOCASE) [`tag_merge`] 와 같다.
/// 같은 태그의 대소문자만 바꾸는 이름 변경은 in-place UPDATE.
/// `affected` = 태그 목록이 실제로 바뀐 노트 수.
pub fn tag_rename(conn: &mut Connection, from: &str, to: &str) -> AppResult<i64> {
    let from = from.trim();
    let to = to.trim();
    if from.is_empty() || to.is_empty() {
        return Err(AppError::Validation("tag name must not be empty".into()));
    }
    let (from_id, from_name) = find_tag(conn, from)?
        .ok_or_else(|| AppError::NotFound(format!("tag not found: {from}")))?;
    if let Some((to_id, _)) = find_tag(conn, to)? {
        if to_id == from_id {
            if from_name == to {
                return Ok(0);
            }
            return rename_tag_in_place(conn, &from_id, to);
        }
        return tag_merge(conn, vec![from.to_string()], to);
    }
    rename_tag_in_place(conn, &from_id, to)
}

/// 여러 태그를 `to` 로 합친다. `to` 가 없으면 만든다. `from` 중 `to` 와 NOCASE 동등한 항목은 건너뛴다.
/// 없는 `from` 태그는 NOT_FOUND. `affected` = 태그 목록이 실제로 바뀐 노트 수.
pub fn tag_merge(conn: &mut Connection, from: Vec<String>, to: &str) -> AppResult<i64> {
    let to = to.trim();
    if to.is_empty() {
        return Err(AppError::Validation("tag merge target must not be empty".into()));
    }
    if from.is_empty() {
        return Err(AppError::Validation("tag merge source must not be empty".into()));
    }
    let from = normalize_tag_names(from);
    if from.is_empty() {
        return Err(AppError::Validation("tag merge source must not be empty".into()));
    }
    let from: Vec<String> = from
        .into_iter()
        .filter(|n| !n.eq_ignore_ascii_case(to))
        .collect();
    if from.is_empty() {
        return Ok(0);
    }

    let mut from_ids: Vec<String> = Vec::with_capacity(from.len());
    for name in &from {
        match find_tag(conn, name)? {
            Some((id, _)) => from_ids.push(id),
            None => return Err(AppError::NotFound(format!("tag not found: {name}"))),
        }
    }

    let tx = conn.transaction().map_err(dberr)?;
    let now = now_iso();
    let to_id: String = match find_tag(&tx, to)? {
        Some((id, _)) => id,
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO tags(id, name, updated_at) VALUES (?1, ?2, ?3)",
                params![id, to, now],
            )
            .map_err(dberr)?;
            id
        }
    };

    let mut affected: HashSet<String> = HashSet::new();
    for from_id in &from_ids {
        if from_id == &to_id {
            continue;
        }
        let note_ids = note_ids_for_tag(&tx, from_id)?;
        for nid in &note_ids {
            affected.insert(nid.clone());
        }
        tx.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id)
             SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2",
            params![to_id, from_id],
        )
        .map_err(dberr)?;
        tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [from_id])
            .map_err(dberr)?;
        for note_id in &note_ids {
            crate::repo::tombstone::record_tombstone(
                &tx,
                "note_tags",
                &format!("{note_id}:{from_id}"),
            )?;
        }
        tx.execute("DELETE FROM tags WHERE id=?1", [from_id])
            .map_err(dberr)?;
        crate::repo::tombstone::record_tombstone(&tx, "tags", from_id)?;
    }

    fts_upsert_notes(&tx, &affected)?;
    tx.commit().map_err(dberr)?;
    Ok(affected.len() as i64)
}

/// 태그를 모든 노트에서 떼고 태그 행을 지운다. 없는 이름 → NOT_FOUND.
/// `affected` = 태그 목록이 실제로 바뀐 노트 수.
pub fn tag_delete(conn: &mut Connection, name: &str) -> AppResult<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("tag name must not be empty".into()));
    }
    let (tag_id, _) = find_tag(conn, name)?
        .ok_or_else(|| AppError::NotFound(format!("tag not found: {name}")))?;

    let tx = conn.transaction().map_err(dberr)?;
    let note_ids = note_ids_for_tag(&tx, &tag_id)?;
    tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [&tag_id])
        .map_err(dberr)?;
    for note_id in &note_ids {
        crate::repo::tombstone::record_tombstone(
            &tx,
            "note_tags",
            &format!("{note_id}:{tag_id}"),
        )?;
    }
    tx.execute("DELETE FROM tags WHERE id=?1", [&tag_id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "tags", &tag_id)?;
    fts_upsert_notes(&tx, &note_ids)?;
    tx.commit().map_err(dberr)?;
    Ok(note_ids.len() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::folders;
    use crate::repo::notes::{create, delete};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    /// Wave 5a: test setting tag color persists, color map returns it, and out-of-range hue returns VALIDATION.
    #[test]
    fn test_tag_set_color_and_colors() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        let n = create(&mut conn, &folder_id, Some("Tag Color Note".into()), Some(2026)).unwrap();
        set_tags(&mut conn, &n.note.id, vec!["rust".into(), "tauri".into()]).unwrap();

        // 1. Initial tag_colors is empty (no hue set)
        let colors = tag_colors(&conn, &ws_id).unwrap();
        assert!(colors.is_empty());

        // 2. Set valid color hue (200) for "rust" tag
        assert!(tag_set_color(&mut conn, "rust", Some(200)).is_ok());
        let colors = tag_colors(&conn, &ws_id).unwrap();
        let map: HashMap<String, i64> = colors.into_iter().collect();
        assert_eq!(map.get("rust"), Some(&200));
        assert_eq!(map.get("tauri"), None);

        // 3. Reset color hue (None)
        assert!(tag_set_color(&mut conn, "rust", None).is_ok());
        let colors = tag_colors(&conn, &ws_id).unwrap();
        assert!(colors.is_empty());

        // 4. Out-of-range hue (< 0 or > 359) returns AppError::Validation
        let err_low = tag_set_color(&mut conn, "rust", Some(-1)).unwrap_err();
        match err_low {
            AppError::Validation(msg) => assert!(msg.contains("out of range")),
            other => panic!("expected Validation error, got {other:?}"),
        }
        let err_high = tag_set_color(&mut conn, "rust", Some(360)).unwrap_err();
        match err_high {
            AppError::Validation(msg) => assert!(msg.contains("out of range")),
            other => panic!("expected Validation error, got {other:?}"),
        }
    }

    /// Scale Phase 1: tag_counts — 빈/단일/공유/soft-delete 제외 + 클라 집계와 동등성.
    #[test]
    fn test_tag_counts_aggregate() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        // 빈 워크스페이스(시드 노트에 태그 없음) → 빈 결과.
        let empty = tag_counts(&conn, &ws_id).unwrap();
        assert!(empty.is_empty(), "no tags yet: {empty:?}");

        let a = create(&mut conn, &folder_id, Some("A".into()), Some(1000)).unwrap();
        let b = create(&mut conn, &folder_id, Some("B".into()), Some(1100)).unwrap();
        let c = create(&mut conn, &folder_id, Some("C".into()), Some(1200)).unwrap();
        set_tags(&mut conn, &a.note.id, vec!["alpha".into(), "shared".into()]).unwrap();
        set_tags(&mut conn, &b.note.id, vec!["shared".into()]).unwrap();
        set_tags(&mut conn, &c.note.id, vec!["beta".into()]).unwrap();

        let counts = tag_counts(&conn, &ws_id).unwrap();
        let map: HashMap<String, i64> = counts.iter().cloned().collect();
        assert_eq!(map.get("alpha"), Some(&1));
        assert_eq!(map.get("beta"), Some(&1));
        assert_eq!(map.get("shared"), Some(&2), "two notes share the tag");
        // 이름 정렬 (COLLATE NOCASE).
        let names: Vec<&str> = counts.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "shared"]);

        // soft-delete 된 노트의 태그는 카운트에서 빠진다.
        delete(&mut conn, &a.note.id).unwrap();
        let after = tag_counts(&conn, &ws_id).unwrap();
        let map: HashMap<String, i64> = after.iter().cloned().collect();
        assert_eq!(map.get("alpha"), None, "alpha only on soft-deleted note");
        assert_eq!(map.get("shared"), Some(&1), "shared drops from 2 to 1");
        assert_eq!(map.get("beta"), Some(&1));

        // 클라 집계(note_tags_index 평탄화)와 동등 — TagsFilter 가 하던 것과 동일 시맨틱.
        let tags_by_note = folders::note_tags_index(&conn, Some(ws_id.clone())).unwrap();
        let mut client: HashMap<String, i64> = HashMap::new();
        for names in tags_by_note.values() {
            for tg in names {
                *client.entry(tg.clone()).or_insert(0) += 1;
            }
        }
        let server: HashMap<String, i64> = tag_counts(&conn, &ws_id).unwrap().into_iter().collect();
        assert_eq!(server, client, "tag_counts must match client flatten of note_tags_index");
    }

    // G2: 태그 전체 교체(set_tags)로 고아가 된 태그는 명시적 DELETE(CASCADE 아님)이므로 개별
    // tombstone 이 필요하다 — 같은 id 가 재생성 후 다시 고아가 되면 deleted_at 이 갱신되는지
    // (INSERT OR REPLACE) 도 함께 검증한다.
    #[test]
    fn test_orphan_tag_cleanup_tombstones_and_redelete_refreshes_deleted_at() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Tag Note".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &n.note.id, vec!["solo".into()]).unwrap();
        let tag_id: String = conn
            .query_row("SELECT id FROM tags WHERE name='solo'", [], |r| r.get(0))
            .unwrap();

        // 태그를 떼어내면(빈 목록으로 교체) 고아가 되어 정리된다.
        set_tags(&mut conn, &n.note.id, vec![]).unwrap();
        let first_deleted_at: String = conn
            .query_row(
                "SELECT deleted_at FROM deleted_rows WHERE tbl='tags' AND id=?1",
                [&tag_id],
                |r| r.get(0),
            )
            .unwrap();

        // 같은 id 로 재생성(예: 재-import 복원 시나리오) 후 다시 고아로 만들어 재삭제 경로를
        // 재현한다.
        std::thread::sleep(std::time::Duration::from_millis(5));
        conn.execute("INSERT INTO tags(id, name) VALUES (?1, 'solo-again')", [&tag_id])
            .unwrap();
        set_tags(&mut conn, &n.note.id, vec!["solo-again".into()]).unwrap();
        set_tags(&mut conn, &n.note.id, vec![]).unwrap();

        let second_deleted_at: String = conn
            .query_row(
                "SELECT deleted_at FROM deleted_rows WHERE tbl='tags' AND id=?1",
                [&tag_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            second_deleted_at > first_deleted_at,
            "re-delete must refresh deleted_at"
        );

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='tags' AND id=?1",
                [&tag_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    // Regression: replace_note_tags always does a full delete+reinsert of note_tags, even when
    // the tag list passed to set_tags is unchanged. Tombstoning right after the DELETE (before the
    // reinsert) would wrongly mark a still-live (note_id, tag_id) pair as deleted. It must only be
    // tombstoned if it doesn't survive the reinsert.
    #[test]
    fn test_set_tags_noop_does_not_tombstone_surviving_note_tags_pair() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Stable Tags Note".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &n.note.id, vec!["kept".into()]).unwrap();
        let tag_id: String = conn
            .query_row("SELECT id FROM tags WHERE name='kept'", [], |r| r.get(0))
            .unwrap();

        // Re-saving the exact same tag list must not tombstone the pair that's still there.
        set_tags(&mut conn, &n.note.id, vec!["kept".into()]).unwrap();

        let pair_id = format!("{}:{}", n.note.id, tag_id);
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_tags' AND id=?1",
                [&pair_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            tombstoned, 0,
            "a note_tags pair that survives the replace must not be tombstoned"
        );
        // The pair (and the tag) must still actually be there.
        let still_linked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_tags WHERE note_id=?1 AND tag_id=?2",
                params![n.note.id, tag_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_linked, 1);
    }

    fn folder_and_ws(conn: &Connection) -> (String, String) {
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        (folder_id, ws_id)
    }

    fn fts_tag_names(conn: &Connection, note_id: &str) -> String {
        conn.query_row(
            "SELECT tag_names FROM notes_fts WHERE note_id=?1",
            [note_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn search_hits(conn: &Connection, q: &str) -> Vec<String> {
        crate::repo::search::search(
            conn,
            q,
            Some(crate::repo::search::FULL_SPAN_FROM),
            Some(crate::repo::search::FULL_SPAN_TO),
            None,
            None,
        )
        .unwrap()
        .results
        .into_iter()
        .map(|n| n.id)
        .collect()
    }

    fn tag_row_count(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM tags WHERE name=?1 COLLATE NOCASE",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// rename unique: alpha→beta; tag_counts/search/FTS 모두 beta 만 반영.
    #[test]
    fn test_tag_rename_unique() {
        let mut conn = setup_db();
        let (folder_id, ws_id) = folder_and_ws(&conn);
        let n = create(&mut conn, &folder_id, Some("Rename Unique".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &n.note.id, vec!["alpha".into()]).unwrap();

        let affected = tag_rename(&mut conn, "alpha", "beta").unwrap();
        assert_eq!(affected, 1);
        assert_eq!(tag_names(&conn, &n.note.id).unwrap(), vec!["beta"]);
        assert_eq!(tag_row_count(&conn, "alpha"), 0);
        assert_eq!(tag_row_count(&conn, "beta"), 1);

        let counts: HashMap<String, i64> = tag_counts(&conn, &ws_id).unwrap().into_iter().collect();
        assert_eq!(counts.get("alpha"), None);
        assert_eq!(counts.get("beta"), Some(&1));

        assert!(search_hits(&conn, "beta").contains(&n.note.id));
        assert!(!search_hits(&conn, "alpha").contains(&n.note.id));
        assert_eq!(fts_tag_names(&conn, &n.note.id), "beta");
    }

    /// rename = merge: A has old, B has new → both have new only; old row gone; FTS updated.
    #[test]
    fn test_tag_rename_is_merge_when_target_exists() {
        let mut conn = setup_db();
        let (folder_id, _) = folder_and_ws(&conn);
        let a = create(&mut conn, &folder_id, Some("Note A".into()), Some(1000)).unwrap();
        let b = create(&mut conn, &folder_id, Some("Note B".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &a.note.id, vec!["old".into()]).unwrap();
        set_tags(&mut conn, &b.note.id, vec!["new".into()]).unwrap();
        let old_id: String = conn
            .query_row("SELECT id FROM tags WHERE name='old'", [], |r| r.get(0))
            .unwrap();

        let affected = tag_rename(&mut conn, "old", "new").unwrap();
        assert_eq!(affected, 1, "only A's tag list changes; B already has new");
        assert_eq!(tag_names(&conn, &a.note.id).unwrap(), vec!["new"]);
        assert_eq!(tag_names(&conn, &b.note.id).unwrap(), vec!["new"]);
        assert_eq!(tag_row_count(&conn, "old"), 0);
        assert_eq!(tag_row_count(&conn, "new"), 1);

        assert_eq!(fts_tag_names(&conn, &a.note.id), "new");
        assert_eq!(fts_tag_names(&conn, &b.note.id), "new");
        assert!(search_hits(&conn, "new").contains(&a.note.id));
        assert!(!search_hits(&conn, "old").contains(&a.note.id));

        let tombstoned_tag: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='tags' AND id=?1",
                [&old_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned_tag, 1);
        let pair_id = format!("{}:{}", a.note.id, old_id);
        let tombstoned_pair: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_tags' AND id=?1",
                [&pair_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned_pair, 1);
    }

    /// merge many: three tags onto one; notes with both don't duplicate; affected count correct.
    #[test]
    fn test_tag_merge_many() {
        let mut conn = setup_db();
        let (folder_id, ws_id) = folder_and_ws(&conn);
        let a = create(&mut conn, &folder_id, Some("Merge A".into()), Some(1000)).unwrap();
        let b = create(&mut conn, &folder_id, Some("Merge B".into()), Some(1000)).unwrap();
        let c = create(&mut conn, &folder_id, Some("Merge C".into()), Some(1000)).unwrap();
        // A has two sources (must not duplicate dest); B already has dest + a source; C has the third.
        set_tags(&mut conn, &a.note.id, vec!["red".into(), "green".into()]).unwrap();
        set_tags(&mut conn, &b.note.id, vec!["green".into(), "omega".into()]).unwrap();
        set_tags(&mut conn, &c.note.id, vec!["blue".into()]).unwrap();

        let affected = tag_merge(
            &mut conn,
            vec!["red".into(), "green".into(), "blue".into()],
            "omega",
        )
        .unwrap();
        assert_eq!(affected, 3);
        assert_eq!(tag_names(&conn, &a.note.id).unwrap(), vec!["omega"]);
        assert_eq!(tag_names(&conn, &b.note.id).unwrap(), vec!["omega"]);
        assert_eq!(tag_names(&conn, &c.note.id).unwrap(), vec!["omega"]);
        assert_eq!(tag_row_count(&conn, "red"), 0);
        assert_eq!(tag_row_count(&conn, "green"), 0);
        assert_eq!(tag_row_count(&conn, "blue"), 0);
        assert_eq!(tag_row_count(&conn, "omega"), 1);

        let counts: HashMap<String, i64> = tag_counts(&conn, &ws_id).unwrap().into_iter().collect();
        assert_eq!(counts.get("red"), None);
        assert_eq!(counts.get("green"), None);
        assert_eq!(counts.get("blue"), None);
        assert_eq!(counts.get("omega"), Some(&3));

        for id in [&a.note.id, &b.note.id, &c.note.id] {
            assert_eq!(fts_tag_names(&conn, id), "omega");
            assert!(search_hits(&conn, "omega").contains(id));
            assert!(!search_hits(&conn, "red").contains(id));
        }
    }

    /// delete: removes from all notes; orphan tag gone; FTS empty; search by old name misses.
    #[test]
    fn test_tag_delete() {
        let mut conn = setup_db();
        let (folder_id, ws_id) = folder_and_ws(&conn);
        let a = create(&mut conn, &folder_id, Some("Del A".into()), Some(1000)).unwrap();
        let b = create(&mut conn, &folder_id, Some("Del B".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &a.note.id, vec!["gone".into(), "keep".into()]).unwrap();
        set_tags(&mut conn, &b.note.id, vec!["gone".into()]).unwrap();
        let gone_id: String = conn
            .query_row("SELECT id FROM tags WHERE name='gone'", [], |r| r.get(0))
            .unwrap();

        let affected = tag_delete(&mut conn, "gone").unwrap();
        assert_eq!(affected, 2);
        assert_eq!(tag_names(&conn, &a.note.id).unwrap(), vec!["keep"]);
        assert!(tag_names(&conn, &b.note.id).unwrap().is_empty());
        assert_eq!(tag_row_count(&conn, "gone"), 0);

        let counts: HashMap<String, i64> = tag_counts(&conn, &ws_id).unwrap().into_iter().collect();
        assert_eq!(counts.get("gone"), None);
        assert_eq!(counts.get("keep"), Some(&1));

        let fts_a = fts_tag_names(&conn, &a.note.id);
        assert!(!fts_a.split_whitespace().any(|t| t.eq_ignore_ascii_case("gone")));
        assert!(fts_a.split_whitespace().any(|t| t.eq_ignore_ascii_case("keep")));
        assert_eq!(fts_tag_names(&conn, &b.note.id), "");
        assert!(!search_hits(&conn, "gone").contains(&a.note.id));
        assert!(!search_hits(&conn, "gone").contains(&b.note.id));

        let tombstoned_tag: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='tags' AND id=?1",
                [&gone_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned_tag, 1);
        let pair_a = format!("{}:{}", a.note.id, gone_id);
        let pair_b = format!("{}:{}", b.note.id, gone_id);
        for pair in [pair_a, pair_b] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_tags' AND id=?1",
                    [&pair],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "note_tags pair {pair} must be tombstoned");
        }
    }

    /// empty from/to/name → Validation.
    #[test]
    fn test_tag_rename_merge_delete_validation() {
        let mut conn = setup_db();
        for err in [
            tag_rename(&mut conn, "", "x").unwrap_err(),
            tag_rename(&mut conn, "x", "").unwrap_err(),
            tag_rename(&mut conn, "  ", "x").unwrap_err(),
            tag_rename(&mut conn, "x", "  ").unwrap_err(),
            tag_merge(&mut conn, vec![], "x").unwrap_err(),
            tag_merge(&mut conn, vec!["".into()], "x").unwrap_err(),
            tag_merge(&mut conn, vec!["x".into()], "").unwrap_err(),
            tag_merge(&mut conn, vec!["x".into()], "  ").unwrap_err(),
            tag_delete(&mut conn, "").unwrap_err(),
            tag_delete(&mut conn, "  ").unwrap_err(),
        ] {
            match err {
                AppError::Validation(_) => {}
                other => panic!("expected Validation, got {other:?}"),
            }
        }
    }

    /// unknown name → NotFound. Missing merge `from` is NOT_FOUND (not skip).
    #[test]
    fn test_tag_rename_merge_delete_not_found() {
        let mut conn = setup_db();
        let (folder_id, _) = folder_and_ws(&conn);
        let n = create(&mut conn, &folder_id, Some("Exists".into()), Some(1000)).unwrap();
        set_tags(&mut conn, &n.note.id, vec!["exists".into()]).unwrap();

        for err in [
            tag_rename(&mut conn, "no-such", "x").unwrap_err(),
            tag_merge(&mut conn, vec!["no-such".into()], "x").unwrap_err(),
            tag_merge(&mut conn, vec!["exists".into(), "no-such".into()], "x").unwrap_err(),
            tag_delete(&mut conn, "no-such").unwrap_err(),
        ] {
            match err {
                AppError::NotFound(_) => {}
                other => panic!("expected NotFound, got {other:?}"),
            }
        }
        // mixed missing must not have mutated the existing tag.
        assert_eq!(tag_names(&conn, &n.note.id).unwrap(), vec!["exists"]);
        assert_eq!(tag_row_count(&conn, "exists"), 1);
    }
}
