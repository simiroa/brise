// 시간축 루틴 — specs/db/schemas/timeline_routines.sql, specs/commands/timeline_routines.yaml.
// 노트에 묶이지 않는, 매주 같은 요일·시각에 달력 시간축을 채우는 배경 블록("출퇴근" 등).
// **`repo::routine`(캔버스 위젯의 노트-연결 습관 체크트래커, `routine_completions`)와는 다른
// 개념이다 — 이름이 비슷하니 혼동 금지.** v1 범위: 예외일 없음, 알림 연동 없음(SSOT: 위 SQL
// 파일 헤더 주석).
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::TimelineRoutine;
use crate::repo::schedule::parse_hhmm_min;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};

fn row_to_routine(row: &rusqlite::Row) -> rusqlite::Result<TimelineRoutine> {
    Ok(TimelineRoutine {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        weekday_mask: row.get(3)?,
        start_time: row.get(4)?,
        end_time: row.get(5)?,
        color_hue: row.get(6)?,
        skip_holidays: row.get::<_, i64>(7)? != 0,
        position: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const SELECT_COLUMNS: &str = "id, workspace_id, title, weekday_mask, start_time, end_time, color_hue, skip_holidays, position, created_at, updated_at";

/// `position` asc — Settings 카드 목록·시간축 필터가 같은 순서로 본다.
pub fn list(conn: &Connection, workspace_id: &str) -> AppResult<Vec<TimelineRoutine>> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM timeline_routines WHERE workspace_id=?1 ORDER BY position ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt
        .query_map([workspace_id], row_to_routine)
        .map_err(dberr)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(dberr)
}

fn get(conn: &Connection, id: &str) -> AppResult<Option<TimelineRoutine>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM timeline_routines WHERE id=?1");
    conn.query_row(&sql, [id], row_to_routine)
        .optional()
        .map_err(dberr)
}

/// note_date_add 의 next_position 관례와 같다 — 이 workspace 기존 루틴 중 MAX(position)+1,
/// 항상 맨 뒤(append). 첫 루틴은 0.
fn next_position(conn: &Connection, workspace_id: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM timeline_routines WHERE workspace_id=?1",
        [workspace_id],
        |r| r.get(0),
    )
    .map_err(dberr)
}

/// HH:MM 형식 + end>start — CHECK 제약(DB)에만 기대지 않는다(그 실패는 rusqlite 에러로 뭉뚱그려져
/// 사용자에게 원인이 안 보인다, CLAUDE.md 참고). weekday_mask 범위(1..127)도 여기서 먼저 본다.
fn validate(weekday_mask: i64, start_time: &str, end_time: &str) -> AppResult<()> {
    if !(1..=127).contains(&weekday_mask) {
        return Err(AppError::Validation(format!(
            "weekday_mask out of range (1..127): {weekday_mask}"
        )));
    }
    let start_min = parse_hhmm_min(start_time).ok_or_else(|| {
        AppError::Validation(format!("invalid start_time format (HH:MM 00:00..23:59): {start_time}"))
    })?;
    let end_min = parse_hhmm_min(end_time).ok_or_else(|| {
        AppError::Validation(format!("invalid end_time format (HH:MM 00:00..23:59): {end_time}"))
    })?;
    if end_min <= start_min {
        return Err(AppError::Validation(
            "end_time must be after start_time".to_string(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    conn: &Connection,
    workspace_id: &str,
    title: &str,
    weekday_mask: i64,
    start_time: &str,
    end_time: &str,
    color_hue: Option<i64>,
    skip_holidays: bool,
) -> AppResult<TimelineRoutine> {
    let ws_exists: bool = conn
        .query_row("SELECT 1 FROM workspaces WHERE id=?1", [workspace_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !ws_exists {
        return Err(AppError::NotFound(format!("workspace not found: {workspace_id}")));
    }
    validate(weekday_mask, start_time, end_time)?;

    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("title must not be empty".to_string()));
    }

    let id = new_id();
    let now = now_iso();
    let position = next_position(conn, workspace_id)?;
    conn.execute(
        "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, color_hue, skip_holidays, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![id, workspace_id, title, weekday_mask, start_time, end_time, color_hue, skip_holidays as i64, position, now],
    )
    .map_err(dberr)?;

    get(conn, &id)?.ok_or_else(|| AppError::Io("timeline routine vanished after insert".to_string()))
}

/// 제공된 필드만 반영 — note_update 와 같은 부분 업데이트 관례. `color_hue` 는 세 값을 구분한다:
/// `None`(필드 자체를 안 건드림) · `Some(None)`(null 로 지움) · `Some(Some(v))`(그 값으로 설정).
/// `skip_holidays`는 나머지 단순 필드(title 등)와 같은 단일 Option — 지우는 개념이 없는 bool이라
/// null/미지정을 구분할 이유가 없다(color_hue처럼 이중 Option을 쓰지 않는다, 과설계 방지).
#[allow(clippy::too_many_arguments)]
pub fn update(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    weekday_mask: Option<i64>,
    start_time: Option<&str>,
    end_time: Option<&str>,
    color_hue: Option<Option<i64>>,
    skip_holidays: Option<bool>,
) -> AppResult<TimelineRoutine> {
    let current = get(conn, id)?.ok_or_else(|| AppError::NotFound(format!("timeline routine not found: {id}")))?;

    let next_title = match title {
        Some(t) => {
            let t = t.trim();
            if t.is_empty() {
                return Err(AppError::Validation("title must not be empty".to_string()));
            }
            t.to_string()
        }
        None => current.title.clone(),
    };
    let next_mask = weekday_mask.unwrap_or(current.weekday_mask);
    let next_start = start_time.unwrap_or(&current.start_time).to_string();
    let next_end = end_time.unwrap_or(&current.end_time).to_string();
    validate(next_mask, &next_start, &next_end)?;
    let next_color = match color_hue {
        Some(v) => v,
        None => current.color_hue,
    };
    let next_skip_holidays = skip_holidays.unwrap_or(current.skip_holidays);

    let now = now_iso();
    conn.execute(
        "UPDATE timeline_routines SET title=?1, weekday_mask=?2, start_time=?3, end_time=?4, color_hue=?5, skip_holidays=?6, updated_at=?7 WHERE id=?8",
        params![next_title, next_mask, next_start, next_end, next_color, next_skip_holidays as i64, now, id],
    )
    .map_err(dberr)?;

    get(conn, id)?.ok_or_else(|| AppError::Io("timeline routine vanished after update".to_string()))
}

/// id 가 없어도 true — note_date_remove 와 같은 멱등 자세(specs/commands/timeline_routines.yaml).
pub fn delete(conn: &Connection, id: &str) -> AppResult<bool> {
    conn.execute("DELETE FROM timeline_routines WHERE id=?1", [id])
        .map_err(dberr)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        (conn, ws_id)
    }

    #[test]
    fn create_assigns_appending_positions() {
        let (conn, ws) = setup();
        let r1 = create(&conn, &ws, "출근", 0b0011111, "09:00", "18:00", Some(200), false).unwrap();
        let r2 = create(&conn, &ws, "헬스", 0b0010101, "19:00", "20:00", None, false).unwrap();
        assert_eq!(r1.position, 0);
        assert_eq!(r2.position, 1);
        assert_eq!(r1.color_hue, Some(200));
        assert_eq!(r2.color_hue, None);
    }

    #[test]
    fn create_rejects_bad_weekday_mask() {
        let (conn, ws) = setup();
        let err = create(&conn, &ws, "출근", 0, "09:00", "18:00", None, false).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err2 = create(&conn, &ws, "출근", 128, "09:00", "18:00", None, false).unwrap_err();
        assert!(matches!(err2, AppError::Validation(_)));
    }

    #[test]
    fn create_rejects_end_not_after_start() {
        let (conn, ws) = setup();
        let err = create(&conn, &ws, "출근", 1, "09:00", "09:00", None, false).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err2 = create(&conn, &ws, "출근", 1, "18:00", "09:00", None, false).unwrap_err();
        assert!(matches!(err2, AppError::Validation(_)));
    }

    #[test]
    fn create_rejects_malformed_time() {
        let (conn, ws) = setup();
        let err = create(&conn, &ws, "출근", 1, "9:00", "18:00", None, false).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn create_persists_skip_holidays() {
        let (conn, ws) = setup();
        let r1 = create(&conn, &ws, "출근", 0b0011111, "09:00", "18:00", None, true).unwrap();
        let r2 = create(&conn, &ws, "헬스", 1, "19:00", "20:00", None, false).unwrap();
        assert!(r1.skip_holidays);
        assert!(!r2.skip_holidays);
        // list()로 다시 읽어도(SELECT 경로) 값이 유지된다.
        let items = list(&conn, &ws).unwrap();
        assert!(items.iter().find(|r| r.id == r1.id).unwrap().skip_holidays);
        assert!(!items.iter().find(|r| r.id == r2.id).unwrap().skip_holidays);
    }

    #[test]
    fn list_orders_by_position() {
        let (conn, ws) = setup();
        create(&conn, &ws, "A", 1, "09:00", "10:00", None, false).unwrap();
        create(&conn, &ws, "B", 1, "11:00", "12:00", None, false).unwrap();
        let items = list(&conn, &ws).unwrap();
        assert_eq!(items.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["A", "B"]);
    }

    #[test]
    fn update_applies_only_provided_fields() {
        let (conn, ws) = setup();
        let created = create(&conn, &ws, "출근", 0b0011111, "09:00", "18:00", Some(10), false).unwrap();
        let updated = update(&conn, &created.id, Some("재택"), None, None, None, None, None).unwrap();
        assert_eq!(updated.title, "재택");
        assert_eq!(updated.weekday_mask, 0b0011111);
        assert_eq!(updated.start_time, "09:00");
        assert_eq!(updated.color_hue, Some(10));
        assert!(!updated.skip_holidays); // None = 안 건드림, 원래 값(false) 그대로.
    }

    #[test]
    fn update_can_clear_color_hue_to_null() {
        let (conn, ws) = setup();
        let created = create(&conn, &ws, "출근", 1, "09:00", "18:00", Some(10), false).unwrap();
        let updated = update(&conn, &created.id, None, None, None, None, Some(None), None).unwrap();
        assert_eq!(updated.color_hue, None);
    }

    #[test]
    fn update_toggles_skip_holidays_and_leaves_it_when_none() {
        let (conn, ws) = setup();
        let created = create(&conn, &ws, "출근", 1, "09:00", "18:00", None, false).unwrap();
        let on = update(&conn, &created.id, None, None, None, None, None, Some(true)).unwrap();
        assert!(on.skip_holidays);
        // None(안 건드림)이면 방금 켠 값이 그대로 남아야 한다 — false로 되돌아가면 안 된다.
        let untouched = update(&conn, &created.id, Some("재택"), None, None, None, None, None).unwrap();
        assert!(untouched.skip_holidays);
        let off = update(&conn, &created.id, None, None, None, None, None, Some(false)).unwrap();
        assert!(!off.skip_holidays);
    }

    #[test]
    fn update_validates_the_merged_time_range() {
        let (conn, ws) = setup();
        let created = create(&conn, &ws, "출근", 1, "09:00", "18:00", None, false).unwrap();
        // 새 end_time 만 주고 그게 기존 start_time 보다 앞이면 거부돼야 한다.
        let err = update(&conn, &created.id, None, None, None, Some("08:00"), None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn update_missing_id_is_not_found() {
        let (conn, _ws) = setup();
        let err = update(&conn, "missing", Some("x"), None, None, None, None, None).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn delete_is_idempotent() {
        let (conn, ws) = setup();
        let created = create(&conn, &ws, "출근", 1, "09:00", "18:00", None, false).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(delete(&conn, &created.id).unwrap());
        assert!(list(&conn, &ws).unwrap().is_empty());
    }
}
