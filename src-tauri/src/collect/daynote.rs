// collect/daynote.rs — 동기화 수렴 규칙: 같은 폴더에 제목이 똑같은 "일자 노트"("브라우징 기록 —
// 2026-09-05", "클로드 프롬프트 — proj 2026-09-05" 등)가 두 개 이상 있으면 하나로 합친다.
//
// 배경: 이 노트들은 세 곳에서 append된다 — 익스텐션 방문 채널(sync_server::ingest.rs::
// append_visit), browser_history/claude_prompts/codex_prompts 어댑터(collect::mod.rs::
// ingest_item_parts). 두 기기가 오프라인으로 각자 오늘치 노트를 만든 뒤 동기화되면 LWW(docs/
// SYNC.md §1)는 둘 중 더 최근에 쓰인 노트의 몸통만 살리고 다른 쪽 줄을 통째로 잃는다 — 병합
// 규칙 없이는 append 자체가 안전하지 않다.
//
// 결정적 id(예: 날짜+제목 해시를 노트 id로 시드)는 기각했다 — 노트 id는 이미 첨부·태그·내부
// 링크 참조의 진짜 식별자라 사후에 결정적으로 바꾸면 그 참조들이 깨진다. 대신 "값(본문 줄)만
// 오래된 노트로 모으고 나머지는 소프트 삭제"하는 편이 참조 무결성을 안 건드린다 — 살아남는
// 노트 id가 항상 있던 것 중 하나이므로.
use crate::error::{db as dberr, AppResult};
use rusqlite::{params, Connection};
use std::collections::HashSet;

use super::summary::split_summary_block;

/// `folder_id`(workspace 소유가 이미 확인된 폴더) 안에서 `title`이 정확히 같은 살아있는 노트를
/// 찾는다.
/// - 0개 → `Ok(None)` (호출자가 새 노트를 만든다)
/// - 1개 → 그 노트의 (id, 첫 섹션 id, 첫 섹션 본문)을 그대로 돌려준다(손대지 않음)
/// - 2개 이상(동기화가 만든 중복) → 가장 오래된 노트(동률이면 id가 작은 쪽)를 생존자로 삼아
///   나머지 본문 줄을 그 노트로 합치고 소프트 삭제한 뒤 생존자를 돌려준다
pub(crate) fn find_or_merge_day_note(
    conn: &mut Connection,
    workspace_id: &str,
    folder_id: &str,
    title: &str,
) -> AppResult<Option<(String, String, String)>> {
    let rows = load_candidates(conn, workspace_id, folder_id, title)?;
    if rows.len() <= 1 {
        return Ok(rows.into_iter().next());
    }
    merge_duplicates(conn, rows)
}

/// 제목이 같은 노트마다 "첫 섹션"(position 최소) 하나씩 — 오래된 순(동률이면 id 오름차순).
fn load_candidates(
    conn: &Connection,
    workspace_id: &str,
    folder_id: &str,
    title: &str,
) -> AppResult<Vec<(String, String, String)>> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, s.id, s.body_md FROM notes n
             JOIN folders f ON f.id = n.folder_id
             JOIN sections s ON s.note_id = n.id
             WHERE f.id = ?1 AND f.workspace_id = ?2 AND n.title = ?3 AND n.deleted_at IS NULL
               AND s.position = (SELECT MIN(position) FROM sections WHERE note_id = n.id)
             ORDER BY n.created_at ASC, n.id ASC",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![folder_id, workspace_id, title], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(dberr)?
        .collect::<Result<Vec<(String, String, String)>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

/// `rows`는 오래된 순으로 2개 이상 — `rows[0]`을 생존자로 삼아 병합한다.
fn merge_duplicates(conn: &mut Connection, rows: Vec<(String, String, String)>) -> AppResult<Option<(String, String, String)>> {
    let survivor_id = rows[0].0.clone();
    let survivor_section_id = rows[0].1.clone();

    // 가장 최신 노트의 "## 요약" 블록이 이긴다 — rows는 오래된 순이니 뒤에서부터 찾는다.
    let newest_summary = rows.iter().rev().find_map(|(_, _, body)| split_summary_block(body).0.map(str::to_string));

    // 줄 병합: 오래된 노트부터, 요약 블록을 뺀 본문만 이어붙이며 중복을 걸러낸다.
    let mut seen_lines: HashSet<String> = HashSet::new();
    let mut seen_needles: HashSet<String> = HashSet::new();
    let mut merged_lines: Vec<String> = Vec::new();
    for (_, _, body) in &rows {
        let (_, remainder) = split_summary_block(body);
        for line in remainder.lines() {
            if line.is_empty() || seen_lines.contains(line) {
                continue;
            }
            if let Some(needle) = extract_url_needle(line) {
                if seen_needles.contains(&needle) {
                    continue;
                }
                seen_needles.insert(needle);
            }
            seen_lines.insert(line.to_string());
            merged_lines.push(line.to_string());
        }
    }
    let joined = merged_lines.join("\n");
    let final_body = match newest_summary {
        Some(block) => format!("{block}{joined}"),
        None => joined,
    };

    let now = crate::util::now_iso();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) // 첫 문장이 읽기(write_body_tx 판정) — 승격 실패 방지
        .map_err(dberr)?;
    crate::repo::sections::write_body_tx(&tx, &survivor_id, &survivor_section_id, &final_body, &now)?;
    crate::repo::fts::fts_upsert(&tx, &survivor_id)?;
    // 나머지는 소프트 삭제 — notes::delete의 핵심(deleted_at + fts_delete)만 재사용한다.
    // activity_log는 남기지 않는다: 사용자가 지운 게 아니라 동기화 수렴이 자동으로 합친
    // 것이라, "삭제" 활동 줄로 보이면 오해를 산다(notes::delete가 남기는 KIND_DELETE와는
    // 다른 자세 — ponytail: 병합은 흔치 않은 이벤트라 별도 활동 종류를 새로 만들 만큼은 아니다).
    for (note_id, _, _) in rows.iter().skip(1) {
        tx.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![now, note_id]).map_err(dberr)?;
        crate::repo::fts::fts_delete(&tx, note_id)?;
    }
    tx.commit().map_err(dberr)?;

    Ok(Some((survivor_id, survivor_section_id, final_body)))
}

/// 방문 스타일 줄("- HH:MM [제목](url) · N분")에서 "(url)" needle을 뽑는다 — 없으면 None(방문
/// 줄이 아니거나 형식이 다름, 그런 줄은 needle 중복 판정 없이 exact-line 중복만 적용된다).
/// `CollectedPart.dedupe_needle`과 같은 모양("(url)")이라 ingest_item_parts/append_visit이 이미
/// `body.contains(needle)`로 판정하는 관례와 그대로 맞물린다.
fn extract_url_needle(line: &str) -> Option<String> {
    let after = line.find("](")? + 2;
    let rest = &line[after..];
    let end = rest.find(')')?;
    Some(format!("({})", &rest[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_iso;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute("INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', ?1)", params![now_iso()])
            .unwrap();
        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at) VALUES ('f1', 'ws1', 'Inbox', 0, 1, ?1)",
            params![now_iso()],
        )
        .unwrap();
        conn
    }

    /// 노트 하나 + 첫 섹션 하나를 직접 심는다(created_at을 정밀 제어하려고 pet::create_inbox_note
    /// 대신 raw INSERT — id 순서·생성 시각 동률을 테스트가 마음대로 짤 수 있어야 한다).
    fn seed(conn: &Connection, note_id: &str, folder_id: &str, title: &str, created_at: &str, body: &str) {
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES (?1, ?2, ?3, 2026, ?4, ?4)",
            params![note_id, folder_id, title, created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at) VALUES (?1, ?2, '', ?3, 0, ?4)",
            params![format!("{note_id}-s"), note_id, body, created_at],
        )
        .unwrap();
    }

    fn note_alive(conn: &Connection, note_id: &str) -> bool {
        conn.query_row("SELECT deleted_at FROM notes WHERE id=?1", [note_id], |r| r.get::<_, Option<String>>(0))
            .unwrap()
            .is_none()
    }

    #[test]
    fn a_single_note_is_returned_untouched() {
        let mut conn = test_conn();
        seed(&conn, "n1", "f1", "브라우징 기록 — 2026-09-05", "2026-09-05T09:00:00.000Z", "- 09:00 a");

        let (note_id, section_id, body) = find_or_merge_day_note(&mut conn, "ws1", "f1", "브라우징 기록 — 2026-09-05")
            .unwrap()
            .expect("one note must be found");
        assert_eq!(note_id, "n1");
        assert_eq!(section_id, "n1-s");
        assert_eq!(body, "- 09:00 a");
    }

    #[test]
    fn no_matching_note_returns_none() {
        let mut conn = test_conn();
        assert!(find_or_merge_day_note(&mut conn, "ws1", "f1", "없는 제목").unwrap().is_none());
    }

    /// 두 노트, 겹치는 줄 하나 + 서로 다른 줄 하나씩 — 생존자는 더 오래된 노트, 합쳐진 본문은
    /// 오래된 노트 줄 먼저, 중복 없음, 새 노트는 소프트 삭제.
    #[test]
    fn two_notes_with_overlapping_and_distinct_lines_merge_into_the_oldest_survivor() {
        let mut conn = test_conn();
        seed(&conn, "old", "f1", "브라우징 기록 — 2026-09-05", "2026-09-05T09:00:00.000Z", "- 09:00 shared\n- 09:05 only-old");
        seed(&conn, "new", "f1", "브라우징 기록 — 2026-09-05", "2026-09-05T10:00:00.000Z", "- 09:00 shared\n- 10:00 only-new");

        let (note_id, section_id, body) = find_or_merge_day_note(&mut conn, "ws1", "f1", "브라우징 기록 — 2026-09-05")
            .unwrap()
            .expect("merge must return the survivor");
        assert_eq!(note_id, "old", "the oldest note must survive");
        assert_eq!(section_id, "old-s");
        assert_eq!(body, "- 09:00 shared\n- 09:05 only-old\n- 10:00 only-new");
        assert!(note_alive(&conn, "old"));
        assert!(!note_alive(&conn, "new"), "the duplicate must be soft-deleted");

        // The survivor's row in the DB must match what was returned.
        let stored: String = conn.query_row("SELECT body_md FROM sections WHERE id='old-s'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, body);
    }

    /// 세 노트 — 병합은 개수와 무관하게 전부 오래된 순으로 합쳐지고 생존자는 하나뿐이어야 한다.
    #[test]
    fn three_notes_merge_into_a_single_survivor() {
        let mut conn = test_conn();
        seed(&conn, "a", "f1", "클로드 프롬프트 — proj 2026-09-05", "2026-09-05T08:00:00.000Z", "- 08:00 one");
        seed(&conn, "b", "f1", "클로드 프롬프트 — proj 2026-09-05", "2026-09-05T09:00:00.000Z", "- 09:00 two");
        seed(&conn, "c", "f1", "클로드 프롬프트 — proj 2026-09-05", "2026-09-05T10:00:00.000Z", "- 10:00 three");

        let (note_id, _, body) = find_or_merge_day_note(&mut conn, "ws1", "f1", "클로드 프롬프트 — proj 2026-09-05")
            .unwrap()
            .unwrap();
        assert_eq!(note_id, "a");
        assert_eq!(body, "- 08:00 one\n- 09:00 two\n- 10:00 three");
        assert!(note_alive(&conn, "a"));
        assert!(!note_alive(&conn, "b"));
        assert!(!note_alive(&conn, "c"));

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title='클로드 프롬프트 — proj 2026-09-05' AND deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    /// created_at이 완전히 같으면(동시 sync) id가 작은 쪽이 생존자.
    #[test]
    fn a_tie_on_created_at_breaks_by_the_smaller_id() {
        let mut conn = test_conn();
        seed(&conn, "zzz", "f1", "브라우징 기록 — 2026-09-05", "2026-09-05T09:00:00.000Z", "- 09:00 z");
        seed(&conn, "aaa", "f1", "브라우징 기록 — 2026-09-05", "2026-09-05T09:00:00.000Z", "- 09:00 a");

        let (note_id, ..) = find_or_merge_day_note(&mut conn, "ws1", "f1", "브라우징 기록 — 2026-09-05").unwrap().unwrap();
        assert_eq!(note_id, "aaa", "smaller id wins the tie");
    }

    /// 방문 스타일 줄은 텍스트가 달라도(관여 시간 등) 같은 (url) needle이면 첫 번째만 남는다.
    #[test]
    fn duplicate_url_needles_across_notes_keep_only_the_first() {
        let mut conn = test_conn();
        seed(
            &conn,
            "old",
            "f1",
            "브라우징 기록 — 2026-09-05",
            "2026-09-05T09:00:00.000Z",
            "- 09:00 [Example](https://example.com/a) · 5분",
        );
        seed(
            &conn,
            "new",
            "f1",
            "브라우징 기록 — 2026-09-05",
            "2026-09-05T10:00:00.000Z",
            "- 10:00 [Example](https://example.com/a) · 40분\n- 10:05 [Other](https://example.com/b) · 1분",
        );

        let (_, _, body) = find_or_merge_day_note(&mut conn, "ws1", "f1", "브라우징 기록 — 2026-09-05").unwrap().unwrap();
        assert_eq!(
            body,
            "- 09:00 [Example](https://example.com/a) · 5분\n- 10:05 [Other](https://example.com/b) · 1분",
            "the older visit to the same url must win, the distinct url must still be appended"
        );
    }

    /// 요약 블록은 최신 노트의 것이 이기고, 병합된 줄 앞에 그대로 붙는다.
    #[test]
    fn the_newest_summary_block_wins_and_old_ones_are_dropped() {
        let mut conn = test_conn();
        let old_summary = "## 요약\n<!-- summarized_at: 2026-09-05T08:00:00.000Z -->\n무엇: 옛 요약\n\n";
        let new_summary = "## 요약\n<!-- summarized_at: 2026-09-05T11:00:00.000Z -->\n무엇: 새 요약\n\n";
        seed(&conn, "old", "f1", "클로드 프롬프트 — proj 2026-09-05", "2026-09-05T08:00:00.000Z", &format!("{old_summary}- 08:00 one"));
        seed(&conn, "new", "f1", "클로드 프롬프트 — proj 2026-09-05", "2026-09-05T10:00:00.000Z", &format!("{new_summary}- 10:00 two"));

        let (_, _, body) = find_or_merge_day_note(&mut conn, "ws1", "f1", "클로드 프롬프트 — proj 2026-09-05").unwrap().unwrap();
        assert_eq!(body, format!("{new_summary}- 08:00 one\n- 10:00 two"));
        assert!(!body.contains("옛 요약"));
    }
}
