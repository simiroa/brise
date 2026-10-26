// repo: note_summary_row — NoteSummary 를 만드는 24컬럼 SELECT 목록과 위치 기반 행 매핑의
// 단일 정의(PLAN-2026-09-13-separation-of-concerns.md §4-c/§4-k 이월 후보).
//
// 같은 컬럼 목록 + 같은 `r.get(0..23)` 사다리가 네 곳에 복붙돼 있었다 —
// notes::note_summary, notes::note_summaries_map_internal, note_query::query, folders::list.
// 24개가 전부 String/Option/i64 라 인덱스가 한 칸 밀려도 타입이 맞아 **컴파일러가 못 잡는다**:
// 커밋 c288004e(content_locked 컬럼 추가)가 네 곳을 전부 손으로 고쳐야 했던 이유다.
// 컬럼 인덱스는 이 파일에 한 벌만 존재한다.
//
// 네 호출부의 차이는 후처리뿐이다(태그/이미지를 채우는지, region_names 를 대표 지역으로
// 시드하는지, 삭제·아카이브 필터를 어떻게 거는지). 그래서 여기서는 "기본 매핑"까지만 만들고
// 파생 필드는 비워 둔 채 호출부가 각자 채운다.

use crate::models::NoteSummary;
use rusqlite::Row;

/// SELECT 컬럼 목록(접두 없음). 순서가 곧 [`map_summary_base`] 의 인덱스 0..23 이다 —
/// 컬럼을 더하거나 옮길 때는 반드시 두 곳을 함께 고친다.
pub const SUMMARY_COLS: &str = "id, folder_id, title, year, is_favorite, exported_at, region, \
     status, icon, lat, lng, created_at, updated_at, month, day, end_year, end_month, end_day, \
     remind, start_time, end_time, remind_offset_min, rrule, content_locked";

/// `alias` 를 붙인 컬럼 목록 (`summary_cols("n")` → `n.id, n.folder_id, …`) —
/// JOIN 을 끼고 읽는 호출부(note_query, folders::list)용.
pub fn summary_cols(alias: &str) -> String {
    SUMMARY_COLS
        .split(", ")
        .map(|c| format!("{alias}.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 행 → NoteSummary 기본 매핑. 네 호출부가 공통으로 시작하는 값만 채운다.
/// `has_image`/`tag_names`/`region_names`/`snippet` 은 파생 필드라 비워 두고, 필요한 호출부가
/// 자기 후처리에서 채운다 (models.rs 주석: region_names 는 note_summaries_map 만 실제로 채운다).
pub fn map_summary_base(r: &Row<'_>) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        title: r.get(2)?,
        year: r.get(3)?,
        is_favorite: r.get::<_, i64>(4)? != 0,
        exported_at: r.get(5)?,
        region: r.get(6)?,
        status: r.get(7)?,
        icon: r.get(8)?,
        lat: r.get(9)?,
        lng: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        month: r.get(13)?,
        day: r.get(14)?,
        end_year: r.get(15)?,
        end_month: r.get(16)?,
        end_day: r.get(17)?,
        remind: r.get::<_, i64>(18)? != 0,
        start_time: r.get(19)?,
        end_time: r.get(20)?,
        remind_offset_min: r.get(21)?,
        rrule: r.get(22)?,
        content_locked: r.get::<_, i64>(23)? != 0,
        has_image: false,
        tag_names: Vec::new(),
        region_names: Vec::new(),
        snippet: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{folders, note_query, notes};
    use rusqlite::Connection;

    const NOTE_ID: &str = "note-char";

    /// 24컬럼 전부에 서로 다른 값을 심은 노트 1건 — 불리언은 true/false 둘 다,
    /// Option 컬럼은 Some/None 둘 다 나오게 골랐다. 인덱스가 한 칸이라도 밀리면 값이 바뀐다.
    /// 반환: (conn, folder_id, workspace_id)
    fn seed() -> (Connection, String, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let (folder_id, ws): (String, String) = conn
            .query_row("SELECT id, workspace_id FROM folders LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        conn.execute(
            "INSERT INTO notes (id, folder_id, title, year, is_favorite, exported_at, region,
                                status, icon, lat, lng, created_at, updated_at, month, day,
                                end_year, end_month, end_day, remind, start_time, end_time,
                                remind_offset_min, rrule, content_locked)
             VALUES (?1, ?2, '특성화 노트', 1999, 1, NULL, 'Lyon',
                     'in_progress', NULL, 45.75, NULL, '2020-01-02T03:04:05Z', '2021-02-03T04:05:06Z', 7, NULL,
                     2001, 12, NULL, 0, '08:15', NULL,
                     30, NULL, 1)",
            rusqlite::params![NOTE_ID, &folder_id],
        )
        .unwrap();
        (conn, folder_id, ws)
    }

    /// 네 경로가 공통으로 만들어야 하는 값 — 리터럴로 못 박는다.
    /// region_names 만 경로마다 다르므로 여기 넣지 않고 호출부에서 따로 단언한다.
    fn assert_expected(s: &NoteSummary, folder_id: &str) {
        assert_eq!(s.id, NOTE_ID);
        assert_eq!(s.folder_id, folder_id);
        assert_eq!(s.title, "특성화 노트");
        assert_eq!(s.year, 1999);
        assert!(s.is_favorite);
        assert_eq!(s.exported_at, None);
        assert_eq!(s.region.as_deref(), Some("Lyon"));
        assert_eq!(s.status.as_deref(), Some("in_progress"));
        assert_eq!(s.icon, None);
        assert_eq!(s.lat, Some(45.75));
        assert_eq!(s.lng, None);
        assert_eq!(s.created_at, "2020-01-02T03:04:05Z");
        assert_eq!(s.updated_at, "2021-02-03T04:05:06Z");
        assert_eq!(s.month, Some(7));
        assert_eq!(s.day, None);
        assert_eq!(s.end_year, Some(2001));
        assert_eq!(s.end_month, Some(12));
        assert_eq!(s.end_day, None);
        assert!(!s.remind);
        assert_eq!(s.start_time.as_deref(), Some("08:15"));
        assert_eq!(s.end_time, None);
        assert_eq!(s.remind_offset_min, Some(30));
        assert_eq!(s.rrule, None);
        assert!(s.content_locked);
        assert!(!s.has_image);
        assert!(s.tag_names.is_empty());
        assert_eq!(s.snippet, None);
    }

    /// 특성화 테스트: NoteSummary 를 만드는 네 경로가 같은 행을 **같은 필드 값**으로 읽는다.
    /// 컬럼 인덱스가 한 칸 밀리는 회귀(c288004e 류)를 네 경로 모두에서 잡는다.
    #[test]
    fn all_four_summary_paths_map_the_same_24_columns() {
        let (conn, folder_id, ws) = seed();

        // 1) 단수형 — 태그/이미지를 실제로 조회해 채운다.
        let single = notes::note_summary(&conn, NOTE_ID).unwrap();
        assert_expected(&single, &folder_id);
        assert!(single.region_names.is_empty(), "단수형은 region_names 를 채우지 않는다");

        // 2) 배치 맵 — 유일하게 region_names 를 대표 지역으로 시드한다.
        let map = notes::note_summaries_map(&conn, &[NOTE_ID.to_string()]).unwrap();
        let batch = map.get(NOTE_ID).expect("배치 경로도 같은 노트를 돌려준다");
        assert_expected(batch, &folder_id);
        assert_eq!(batch.region_names, vec!["Lyon".to_string()]);

        // 3) note_query — 서버측 필터를 마친 경로, region_names 는 빈 값.
        let page = note_query::query(
            &conn,
            note_query::NoteQuery { workspace_id: Some(ws.clone()), ..Default::default() },
        )
        .unwrap();
        let queried = page.notes.iter().find(|n| n.id == NOTE_ID).expect("note_query 가 노트를 돌려준다");
        assert_expected(queried, &folder_id);
        assert!(queried.region_names.is_empty());

        // 4) folder_list 경량 트리.
        let tree = folders::list(&conn, Some(ws)).unwrap();
        let in_tree = tree
            .notes_by_folder
            .get(&folder_id)
            .and_then(|v| v.iter().find(|n| n.id == NOTE_ID))
            .expect("트리에도 같은 노트가 있다");
        assert_expected(in_tree, &folder_id);
        assert!(in_tree.region_names.is_empty());
    }

    /// 컬럼 목록 자체를 리터럴로 못 박는다 — 리팩터 전 네 곳이 쓰던 순서 그대로여야 하고,
    /// 접두 버전도 그 순서를 보존해야 한다(줄 이음 `\` 뒤 여백이 새어 들어가면 토큰에 공백이
    /// 붙어 여기서 걸린다).
    #[test]
    fn summary_cols_pins_the_24_columns_in_order() {
        const EXPECTED: [&str; 24] = [
            "id", "folder_id", "title", "year", "is_favorite", "exported_at", "region", "status",
            "icon", "lat", "lng", "created_at", "updated_at", "month", "day", "end_year",
            "end_month", "end_day", "remind", "start_time", "end_time", "remind_offset_min",
            "rrule", "content_locked",
        ];
        assert_eq!(SUMMARY_COLS.split(", ").collect::<Vec<_>>(), EXPECTED);
        assert_eq!(
            summary_cols("n").split(", ").collect::<Vec<_>>(),
            EXPECTED.iter().map(|c| format!("n.{c}")).collect::<Vec<_>>(),
        );
    }
}
