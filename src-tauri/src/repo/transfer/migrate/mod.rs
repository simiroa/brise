// repo: transfer::migrate — 다른 앱 → Brise 마이그레이션 공용 타입 + 커밋 (§2.5
// HANDOFF-calendar-onboarding.md). 포맷별 파서(markdown.rs, 이후 notion.rs/enex.rs)는 전부
// 이 모듈이 정의하는 StagedNote 로 수렴한 뒤 commit_staged() 를 공용으로 쓴다 — 이 파일이
// 다음 슬라이스들이 그대로 베끼는 참조 구현이다.
pub mod enex;
pub mod markdown;
pub mod notion;

use crate::error::AppResult;
use crate::repo::notes;
use rusqlite::Connection;
use serde::Serialize;

/// 포맷 파서가 만든, 아직 DB에 쓰이지 않은 노트 한 건.
pub struct StagedNote {
    pub title: String,
    pub body_md: String,
    pub tag_names: Vec<String>,
    pub year: Option<i64>,
    /// 이미 폴백 체인을 거쳐 해석된 값, ISO8601 UTC "...Z". `commit_staged` 는 그대로
    /// `create_with_timestamp` 에 넘긴다(재해석하지 않음).
    pub created_at: String,
}

#[derive(Debug, Serialize, Default)]
pub struct MigrationResult {
    pub imported: i64,
    pub note_ids: Vec<String>,
    /// 파싱 실패(포맷 파서 단계) + 생성 실패(이 함수 단계) 합계.
    pub skipped: i64,
}

/// 스테이지드 노트를 순서대로 커밋. `create_with_timestamp` 가 노트당 자체 트랜잭션으로
/// 커밋하므로 이 함수는 배치 전체를 감싸는 트랜잭션을 두지 않는다 — 노트 #50 이 실패해도
/// #1~49 는 그대로 남는다(요구사항: 부분 실패가 전체를 롤백시키면 안 됨). 노트 생성이
/// 실패하면 skipped 로 세고 다음 노트로 넘어간다; 태그 설정 실패는 노트 자체가 이미
/// 커밋됐으므로 skipped 에 넣지 않고 조용히 무시한다(태그 없는 노트로 남을 뿐).
pub fn commit_staged(
    conn: &mut Connection,
    folder_id: &str,
    staged: Vec<StagedNote>,
) -> AppResult<MigrationResult> {
    let mut result = MigrationResult::default();
    for note in staged {
        let detail = match notes::create_with_timestamp(
            conn,
            folder_id,
            Some(note.title),
            note.year,
            None, // month: 포맷 파서가 아직 월/일을 추출하지 않는다 — NULL(연도만)로 남는다.
            None, // day
            Some(note.created_at),
            Some(note.body_md),
        ) {
            Ok(d) => d,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if !note.tag_names.is_empty() {
            let _ = notes::set_tags(conn, &detail.note.id, note.tag_names);
        }
        result.note_ids.push(detail.note.id);
        result.imported += 1;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    #[test]
    fn commit_staged_creates_notes_with_tags_and_timestamp() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let staged = vec![StagedNote {
            title: "Imported Note".into(),
            body_md: "# Imported Note\n\nBody".into(),
            tag_names: vec!["obsidian".into(), "imported".into()],
            year: None,
            created_at: "2019-03-04T00:00:00Z".into(),
        }];

        let result = commit_staged(&mut conn, &folder_id, staged).unwrap();
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.note_ids.len(), 1);

        let note = notes::note_summary(&conn, &result.note_ids[0]).unwrap();
        assert_eq!(note.title, "Imported Note");
        assert_eq!(note.created_at, "2019-03-04T00:00:00Z");
        assert_eq!(note.updated_at, "2019-03-04T00:00:00Z");
        assert_eq!(note.year, 1900); // year: None → create()'s existing default, unchanged.
        let mut tags = notes::tag_names(&conn, &result.note_ids[0]).unwrap();
        tags.sort();
        assert_eq!(tags, vec!["imported".to_string(), "obsidian".to_string()]);

        // The imported body must actually land in the Overview section — not be discarded in
        // favor of the empty body create() normally writes for a fresh note (no body_md given).
        let detail = notes::note_detail(&conn, &result.note_ids[0]).unwrap();
        assert_eq!(detail.sections[0].body_md, "# Imported Note\n\nBody");
    }

    #[test]
    fn commit_staged_skips_failing_note_without_aborting_batch() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let staged = vec![
            StagedNote {
                title: "Good 1".into(),
                body_md: String::new(),
                tag_names: vec![],
                year: None,
                created_at: "2020-01-01T00:00:00Z".into(),
            },
            StagedNote {
                title: "Bad (year out of range)".into(),
                body_md: String::new(),
                tag_names: vec![],
                year: Some(99999), // out of -9999..9999 → create_with_timestamp returns Validation
                created_at: "2020-01-01T00:00:00Z".into(),
            },
            StagedNote {
                title: "Good 2".into(),
                body_md: String::new(),
                tag_names: vec![],
                year: None,
                created_at: "2020-01-02T00:00:00Z".into(),
            },
        ];

        let result = commit_staged(&mut conn, &folder_id, staged).unwrap();
        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.note_ids.len(), 2);
    }
}
