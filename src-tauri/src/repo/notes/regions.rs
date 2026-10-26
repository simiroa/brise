// repo::notes::regions — note_regions table (경유지). Pure extraction from notes.rs
// (리팩토링 웨이브 C, following note_query.rs's Wave A-4 precedent). Behaviour unchanged;
// tests live here with the table. Separate table, separate per-row tombstone/transaction
// discipline (docs/SYNC.md §8.1), and its own NoteRegion model — no shared constants/types
// with the rest of the notes core beyond `create`/`note_summary` used by tests below.
use crate::error::{db as dberr, AppError, AppResult};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

// Wave 4: 다중 지역
/// docs/SYNC.md §8.1: note_regions 자체엔 updated_at 이 없으므로(G1 미확장), 경유지 추가 사실을
/// LWW 가 보게 하는 유일한 수단은 소속 노트의 updated_at 을 같이 올리는 것 — sections::create 와
/// 동일한 패턴(자식 행 변경 → 부모 notes 행도 touch). 그래서 `&Connection` 대신 트랜잭션이 필요하다.
pub fn region_add(conn: &mut Connection, note_id: &str, name: &str, lat: f64, lng: f64, position: i64) -> AppResult<String> {
    let id = new_id();
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO note_regions(id, note_id, name, lat, lng, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, note_id, name, lat, lng, position, now],
    )
    .map_err(dberr)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now, note_id],
    )
    .map_err(dberr)?;
    tx.commit().map_err(dberr)?;
    Ok(id)
}

/// 삭제는 tombstone 을 남긴다 — note_regions 는 UPDATE 경로가 없는 INSERT+DELETE 전용 테이블이라
/// (migrations.rs 의 G1/G2 주석이 말하는 attachments/workspace_regions 와 같은 부류) 삭제 사실을
/// 다른 기기로 전파할 유일한 수단이 deleted_rows 다. 없으면 한 기기에서 지운 경유지가 동기화
/// 후 되살아난다. 소속 노트의 updated_at 도 같은 트랜잭션에서 올린다(region_add 와 동일 이유 —
/// docs/SYNC.md §8.1). 반환값은 소속 note_id — 커맨드 계층이 그 노트만 콕 집어 갱신 이벤트를 낼 수
/// 있게 한다(없으면 전체 갱신으로 뭉개야 한다).
pub fn region_remove(conn: &mut Connection, id: &str) -> AppResult<Option<String>> {
    let note_id: Option<String> = conn
        .query_row("SELECT note_id FROM note_regions WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(dberr)?;
    let Some(note_id) = note_id else { return Ok(None) };
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("DELETE FROM note_regions WHERE id = ?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "note_regions", id)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now_iso(), note_id],
    )
    .map_err(dberr)?;
    tx.commit().map_err(dberr)?;
    Ok(Some(note_id))
}

pub fn regions_list(conn: &Connection, note_id: &str) -> AppResult<Vec<crate::models::NoteRegion>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, name, lat, lng, position FROM note_regions WHERE note_id = ?1 ORDER BY position ASC, created_at ASC",
        )
        .map_err(dberr)?;
    let regions = stmt
        .query_map([note_id], |row| {
            Ok(crate::models::NoteRegion {
                id: row.get(0)?,
                note_id: row.get(1)?,
                name: row.get(2)?,
                lat: row.get(3)?,
                lng: row.get(4)?,
                position: row.get(5)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(regions)
}

/// 경유지 순서 재배치 — section_reorder 와 동일 계약(ordered_ids 가 해당 노트 경유지 집합과
/// 정확히 일치해야 함). position 만 0..n-1 로 다시 쓴다. docs/SYNC.md §8.1: note_regions 자체엔
/// 아직 updated_at 이 없어(G1 미확장) 행 단위 LWW 대상은 아니지만, 소속 노트의 updated_at 을
/// 같이 올려(잔여 리스크 3 수정) LWW 가 "이 노트에 뭔가 바뀌었다"는 신호는 받게 한다 —
/// region_add/region_remove 와 동일한 처리.
pub fn region_reorder(conn: &mut Connection, note_id: &str, ordered_ids: &[String]) -> AppResult<bool> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    let current: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM note_regions WHERE note_id=?1")
            .map_err(dberr)?;
        let rows: Vec<String> = stmt
            .query_map([note_id], |r| r.get::<_, String>(0))
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        rows
    };
    let mut a = current.clone();
    a.sort();
    let mut b = ordered_ids.to_vec();
    b.sort();
    if a != b {
        return Err(AppError::Validation(
            "ordered_ids does not match note regions".to_string(),
        ));
    }
    let tx = conn.transaction().map_err(dberr)?;
    for (pos, rid) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE note_regions SET position=?1 WHERE id=?2 AND note_id=?3",
            params![pos as i64, rid, note_id],
        )
        .map_err(dberr)?;
    }
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now_iso(), note_id],
    )
    .map_err(dberr)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// 경유지 위치 이동(드래그) — note_regions 는 본래 INSERT+DELETE 전용 테이블이었지만(위
/// region_remove 주석: attachments/workspace_regions 와 같은 부류) 드래그는 예외다. 삭제 후
/// 재생성하면 id 가 바뀌어 프론트의 낙관적 갱신(같은 id 로 좌표만 patch)과 진행 중 드래그
/// 참조가 끊긴다 — 그래서 이 한 필드(lat/lng)만은 region_reorder 의 position 처럼 직접
/// UPDATE 한다. 좌표 검증은 set_location 과 동일 범위(SYNC.md 무관, 순수 데이터 무결성).
/// 소속 노트의 updated_at 도 같은 트랜잭션에서 올려 LWW 가 이동을 본다(region_reorder 와
/// 동일 이유 — SYNC.md §8.1).
pub fn region_move(conn: &mut Connection, id: &str, lat: f64, lng: f64) -> AppResult<String> {
    let note_id: Option<String> = conn
        .query_row("SELECT note_id FROM note_regions WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(dberr)?;
    let note_id = note_id.ok_or_else(|| AppError::NotFound(format!("region not found: {id}")))?;
    if !(-90.0..=90.0).contains(&lat) {
        return Err(AppError::Validation(format!("lat out of range (-90..90): {lat}")));
    }
    if !(-180.0..=180.0).contains(&lng) {
        return Err(AppError::Validation(format!("lng out of range (-180..180): {lng}")));
    }
    let tx = conn.transaction().map_err(dberr)?;
    let now = now_iso();
    tx.execute(
        "UPDATE note_regions SET lat=?1, lng=?2 WHERE id=?3",
        params![lat, lng, id],
    )
    .map_err(dberr)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now, note_id],
    )
    .map_err(dberr)?;
    tx.commit().map_err(dberr)?;
    Ok(note_id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RegionRegistryEntry {
    pub name: String,
    pub lat: f64,
    pub lng: f64,
}

/// PLAN-2026-09-19-date-region-ui.md §P3 Phase A, D7/D8 — 워크스페이스 전체에서 이미 쓰인
/// 지역명 레지스트리. notes.region(대표)와 note_regions.name(경유지)의 합집합에서 이름별로
/// 좌표 하나씩을 뽑는다.
///
/// D8: `ROW_NUMBER() OVER (PARTITION BY name ORDER BY recency DESC, lat, lng)` 로 **같은 행에서**
/// lat/lng 를 함께 고른다 — `MIN(lat), MIN(lng)` 를 따로 집계하면 서로 다른 행의 위도·경도가
/// 섞여 실재한 적 없는 좌표쌍이 나올 수 있다(회귀 금지, 테스트
/// `test_region_registry_picks_paired_coords_not_min_min` 참고). `lat, lng` 를 2차/3차 정렬키로
/// 더한 이유는 순수 동률 방지다 — 같은 이름의 대표/경유지가 같은 `recency`(초 단위 ISO8601)를
/// 가지면 어느 행이 이기는지가 실행마다 흔들릴 수 있는데(이 저장소가 이미 겪은 "검색 결과 순서가
/// 실행마다 흔들리는" 부류의 사고, CLAUDE.md), 그래도 반환되는 좌표쌍 자체는 항상 동률인 두 행
/// 중 하나에서 그대로 온 값이라 D8 이 금지하는 "존재하지 않는 좌표쌍"은 아니다.
///
/// recency 대리자: `note_regions` 자체엔 `updated_at` 컬럼이 없다(docs/SYNC.md §8.1, G1 미확장 —
/// region_add 의 주석 참고). 그래서 경유지 쪽은 소속 노트의 `updated_at` 을 대리자로 쓴다 —
/// `region_add`/`region_move`/`region_reorder` 가 실제로 그 순간 소속 노트의 `updated_at` 을 같이
/// bump 하므로 "이 경유지 행이 최근에 손댄 시각"의 정확한 대리자다. 부작용: 노트 제목/본문만
/// 고쳐도(경유지 자체는 안 건드려도) 그 노트의 경유지들이 더 "최근"으로 재랭크된다 — 정밀한
/// 회귀는 아니지만 언젠가 더 세밀한 축이 필요해지면 note_regions 에 own updated_at 을 추가하는
/// 것이 업그레이드 경로다(ponytail).
///
/// `deleted_at IS NULL` 만 본다 — `archived_at`(아카이브)은 보지 않는다. 아카이브된 노트는
/// 화면에서 숨을 뿐 "이 워크스페이스에 쓰인 지역명"이라는 사실 자체는 바뀌지 않으므로 후보에
/// 남긴다(D7 원문 그대로, 확대 해석 아님).
///
/// 이름 그룹핑은 원문 문자열 그대로다(trim/대소문자 정규화 없음) — 정규화 비교(D9 제외, D12 강도
/// 매칭)는 프런트 regionDisplay.ts::sameRegionName 쪽 책임으로 남겨둔다(여기서 미리 접으면 그
/// 결정이 두 곳에 흩어진다).
pub fn region_registry(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<RegionRegistryEntry>> {
    let ws = match workspace_id {
        Some(id) => id,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    let mut stmt = conn
        .prepare(
            "SELECT name, lat, lng FROM (
                 SELECT name, lat, lng,
                        ROW_NUMBER() OVER (PARTITION BY name ORDER BY recency DESC, lat, lng) AS rn
                 FROM (
                     SELECT n.region AS name, n.lat AS lat, n.lng AS lng, n.updated_at AS recency
                     FROM notes n
                     JOIN folders f ON f.id = n.folder_id
                     WHERE f.workspace_id = ?1
                       AND n.deleted_at IS NULL
                       AND n.region IS NOT NULL
                       AND n.lat IS NOT NULL
                       AND n.lng IS NOT NULL
                     UNION ALL
                     SELECT nr.name AS name, nr.lat AS lat, nr.lng AS lng, n.updated_at AS recency
                     FROM note_regions nr
                     JOIN notes n ON n.id = nr.note_id
                     JOIN folders f ON f.id = n.folder_id
                     WHERE f.workspace_id = ?1
                       AND n.deleted_at IS NULL
                 )
             )
             WHERE rn = 1
             ORDER BY name COLLATE NOCASE",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([&ws], |r| {
            Ok(RegionRegistryEntry {
                name: r.get(0)?,
                lat: r.get(1)?,
                lng: r.get(2)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes::{create, note_summary};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    // D4: region_remove leaves a note_regions tombstone; region_reorder rewrites positions.
    #[test]
    fn test_region_add_remove_tombstone_and_reorder() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Trip".into()), Some(1592)).unwrap();
        let id0 = region_add(&mut conn, &n.note.id, "경주", 35.8562, 129.2247, 0).unwrap();
        let id1 = region_add(&mut conn, &n.note.id, "부산", 35.1796, 129.0756, 1).unwrap();
        let id2 = region_add(&mut conn, &n.note.id, "서울", 37.5665, 126.9780, 2).unwrap();

        // N2-3: region_add must bump the owning note's updated_at (LWW visibility).
        let after_add = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(after_add >= n.note.updated_at);

        // Reorder: 서울 first, then 경주, then 부산.
        let before_reorder = after_add;
        std::thread::sleep(std::time::Duration::from_millis(5));
        region_reorder(&mut conn, &n.note.id, &[id2.clone(), id0.clone(), id1.clone()]).unwrap();
        let after_reorder = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(
            after_reorder > before_reorder,
            "region_reorder must bump notes.updated_at so LWW sees the change"
        );
        let listed = regions_list(&conn, &n.note.id).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].id, id2);
        assert_eq!(listed[0].position, 0);
        assert_eq!(listed[1].id, id0);
        assert_eq!(listed[1].position, 1);
        assert_eq!(listed[2].id, id1);
        assert_eq!(listed[2].position, 2);

        // Remove middle waypoint → tombstone.
        let before_remove = after_reorder;
        std::thread::sleep(std::time::Duration::from_millis(5));
        region_remove(&mut conn, &id0).unwrap();
        let after_remove = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(
            after_remove > before_remove,
            "region_remove must bump notes.updated_at so LWW sees the change"
        );
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_regions' AND id=?1",
                [&id0],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1);
        assert_eq!(regions_list(&conn, &n.note.id).unwrap().len(), 2);

        // ordered_ids mismatch → Validation.
        let err = region_reorder(&mut conn, &n.note.id, &[id2.clone()]).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    /// D4/드래그: region_move updates a waypoint's coords in place (same id — a delete+recreate
    /// would break the frontend's optimistic patch and any in-flight drag reference) and bumps
    /// the owning note's updated_at (region_reorder/region_add 와 동일 계약). Missing id → NotFound.
    #[test]
    fn test_region_move_updates_coords_and_bumps_parent_then_not_found_on_missing_id() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Trip".into()), Some(1592)).unwrap();
        let id0 = region_add(&mut conn, &n.note.id, "경주", 35.8562, 129.2247, 0).unwrap();

        let before = note_summary(&conn, &n.note.id).unwrap().updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let moved_note_id = region_move(&mut conn, &id0, 36.0, 130.0).unwrap();
        assert_eq!(moved_note_id, n.note.id);

        let listed = regions_list(&conn, &n.note.id).unwrap();
        assert_eq!(listed.len(), 1, "move must not add/remove rows — same id, same count");
        assert_eq!(listed[0].id, id0, "id must survive the move (no delete+recreate)");
        assert_eq!(listed[0].lat, 36.0);
        assert_eq!(listed[0].lng, 130.0);

        let after = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(after > before, "region_move must bump notes.updated_at so LWW sees the change");

        let err = region_move(&mut conn, "does-not-exist", 0.0, 0.0).unwrap_err();
        match err {
            AppError::NotFound(_) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    // ── §P3 Phase A (PLAN-2026-09-19-date-region-ui.md, D7/D8) — region_registry ──────────────

    fn workspace_of_folder(conn: &Connection, folder_id: &str) -> String {
        conn.query_row(
            "SELECT workspace_id FROM folders WHERE id=?1",
            [folder_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn set_primary(conn: &Connection, note_id: &str, name: &str, lat: f64, lng: f64) {
        conn.execute(
            "UPDATE notes SET region=?1, lat=?2, lng=?3 WHERE id=?4",
            params![name, lat, lng, note_id],
        )
        .unwrap();
    }

    /// (a): 대표만/경유지만/둘 다 있는 노트가 섞여도 이름별로 정확히 한 행이 나온다 — 같은
    /// 이름("경주")이 서로 다른 노트의 대표와 경유지 양쪽에서 나와도 레지스트리에는 한 번만.
    #[test]
    fn test_region_registry_dedupes_by_name_across_primary_and_waypoints() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id = workspace_of_folder(&conn, &folder_id);

        // Note A: primary region only.
        let a = create(&mut conn, &folder_id, Some("A".into()), Some(2020)).unwrap();
        set_primary(&conn, &a.note.id, "경주", 35.8562, 129.2247);

        // Note B: waypoint only.
        let b = create(&mut conn, &folder_id, Some("B".into()), Some(2020)).unwrap();
        region_add(&mut conn, &b.note.id, "부산", 35.1796, 129.0756, 0).unwrap();

        // Note C: primary "서울" + a waypoint named "경주" — same name as A's primary.
        let c = create(&mut conn, &folder_id, Some("C".into()), Some(2020)).unwrap();
        set_primary(&conn, &c.note.id, "서울", 37.5665, 126.9780);
        region_add(&mut conn, &c.note.id, "경주", 35.8562, 129.2247, 0).unwrap();

        let entries = region_registry(&conn, Some(ws_id)).unwrap();
        let mut names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            vec!["경주", "부산", "서울"],
            "same name from a primary row and a waypoint row must collapse to one registry entry"
        );
    }

    /// (b)/D8 회귀: 같은 이름이 서로 다른 시각에 서로 다른 좌표로 두 번 등장하면, 반환되는
    /// 좌표쌍은 **더 최근 행에서 그대로** 나와야 한다. `MIN(lat)`/`MIN(lng)` 를 각각 집계했다면
    /// (10.0, 170.0)과 (60.0, 20.0) 두 실재 좌표에서 (10.0, 20.0)이라는, 어느 행에도 없던 좌표쌍이
    /// 나왔을 것이다 — 이 테스트는 그 함정을 정확히 걸러낸다.
    #[test]
    fn test_region_registry_picks_paired_coords_not_min_min() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id = workspace_of_folder(&conn, &folder_id);

        let old = create(&mut conn, &folder_id, Some("Old".into()), Some(2020)).unwrap();
        conn.execute(
            "UPDATE notes SET region=?1, lat=?2, lng=?3, updated_at=?4 WHERE id=?5",
            params!["장소", 10.0, 170.0, "2020-01-01T00:00:00Z", old.note.id],
        )
        .unwrap();

        let newer = create(&mut conn, &folder_id, Some("New".into()), Some(2020)).unwrap();
        conn.execute(
            "UPDATE notes SET region=?1, lat=?2, lng=?3, updated_at=?4 WHERE id=?5",
            params!["장소", 60.0, 20.0, "2020-06-01T00:00:00Z", newer.note.id],
        )
        .unwrap();

        let entries = region_registry(&conn, Some(ws_id)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "장소");
        assert_eq!(entries[0].lat, 60.0, "must be the newer row's lat, not MIN(lat) across rows");
        assert_eq!(entries[0].lng, 20.0, "must be the newer row's lng, not MIN(lng) across rows");
        // Sanity: (10.0, 20.0) — what separate MIN/MIN aggregation would have produced — is not a
        // coordinate either real row actually had.
        assert!(!(entries[0].lat == 10.0 && entries[0].lng == 20.0));
    }

    /// (c): 다른 워크스페이스의 같은 이름이 섞이지 않는다.
    #[test]
    fn test_region_registry_scoped_to_workspace() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws1 = workspace_of_folder(&conn, &folder_id);
        let a = create(&mut conn, &folder_id, Some("A".into()), Some(2020)).unwrap();
        set_primary(&conn, &a.note.id, "같은이름", 1.0, 1.0);

        let ws2 = crate::repo::workspaces::create(&mut conn, "Other").unwrap();
        let folder2: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1",
                [&ws2.id],
                |r| r.get(0),
            )
            .unwrap();
        let b = create(&mut conn, &folder2, Some("B".into()), Some(2020)).unwrap();
        set_primary(&conn, &b.note.id, "같은이름", 2.0, 2.0);

        let entries_ws1 = region_registry(&conn, Some(ws1)).unwrap();
        assert_eq!(entries_ws1.len(), 1);
        assert_eq!(entries_ws1[0].lat, 1.0);

        let entries_ws2 = region_registry(&conn, Some(ws2.id)).unwrap();
        assert_eq!(entries_ws2.len(), 1);
        assert_eq!(entries_ws2[0].lat, 2.0);
    }

    /// (d): soft-delete(휴지통) 노트의 대표/경유지 지역명은 후보에서 빠진다.
    #[test]
    fn test_region_registry_excludes_soft_deleted_notes() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id = workspace_of_folder(&conn, &folder_id);

        let alive = create(&mut conn, &folder_id, Some("Alive".into()), Some(2020)).unwrap();
        set_primary(&conn, &alive.note.id, "산 노트", 1.0, 1.0);

        let trashed = create(&mut conn, &folder_id, Some("Trashed".into()), Some(2020)).unwrap();
        set_primary(&conn, &trashed.note.id, "지운 노트", 2.0, 2.0);
        region_add(&mut conn, &trashed.note.id, "지운 경유지", 3.0, 3.0, 0).unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at=?1 WHERE id=?2",
            params![now_iso(), trashed.note.id],
        )
        .unwrap();

        let entries = region_registry(&conn, Some(ws_id)).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"산 노트"));
        assert!(!names.contains(&"지운 노트"));
        assert!(!names.contains(&"지운 경유지"));
    }

    /// workspace_id 생략 시 활성 워크스페이스로 풀린다(taxonomy.rs::resolve_ws 와 동일 계약).
    #[test]
    fn test_region_registry_defaults_to_active_workspace_when_omitted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let a = create(&mut conn, &folder_id, Some("A".into()), Some(2020)).unwrap();
        set_primary(&conn, &a.note.id, "기본지역", 1.0, 1.0);

        let entries = region_registry(&conn, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "기본지역");
    }
}
