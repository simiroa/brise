// P2 1단계 후행 제안 저장소(docs/PLAN-2026-08-07-second-brain.md Q5, db/migrations.rs V39_SQL).
// 겹침 행은 그래프 탭 로드 시 related_sql 이 upsert_overlap 을 호출해 채운다
// (repo::dashboard::graph). theme 행은 저장 스키마만 준비돼 있고 프로덕션 생산자가 없다
// (upsert_theme 호출은 테스트뿐). 커맨드(commands::suggestions)가 list/set_status 를 얇게 감싼다.
use crate::error::{db as dberr, AppError, AppResult};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};

pub const VALID_STATUSES: [&str; 3] = ["pending", "dismissed", "accepted"];

pub struct OverlapItem<'a> {
    pub note_a: &'a str,
    pub note_b: &'a str,
    pub score: f32,
    pub payload: &'a str,
}

/// 여러 노트 쌍 제안을 단일 prepared statement로 일괄 upsert 한다.
pub fn upsert_overlap_batch(
    conn: &Connection,
    workspace_id: &str,
    items: &[OverlapItem<'_>],
) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let now = now_iso();
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO suggestions
               (id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
             VALUES (?1, ?2, 'overlap', ?3, ?4, ?5, ?6, 'pending', ?7, ?7)",
        )
        .map_err(dberr)?;
    for item in items {
        let (lo, hi) = if item.note_a <= item.note_b {
            (item.note_a, item.note_b)
        } else {
            (item.note_b, item.note_a)
        };
        stmt.execute(params![
            new_id(),
            workspace_id,
            lo,
            hi,
            item.payload,
            item.score as f64,
            now
        ])
        .map_err(dberr)?;
    }
    Ok(())
}

/// 노트 쌍 제안을 upsert 한다. note_id/related_note_id는 호출 순서와 무관하게 항상 (min,max)로
/// 정규화해 저장한다 — A→B와 B→A 스캔이 서로 다른 순서로 들어와도 같은 UNIQUE(kind,note_id,
/// related_note_id) 키에 수렴시키기 위함(안 그러면 두 방향 스캔이 별개 행 두 개를 만든다).
/// INSERT OR IGNORE라 이미 어떤 status로든 존재하는 쌍은 조용히 건너뛴다 — dismissed 존중.
pub fn upsert_overlap(
    conn: &Connection,
    workspace_id: &str,
    note_a: &str,
    note_b: &str,
    score: f32,
    payload: &str,
) -> AppResult<()> {
    upsert_overlap_batch(
        conn,
        workspace_id,
        &[OverlapItem {
            note_a,
            note_b,
            score,
            payload,
        }],
    )
}

// ── 웨이브 ③ 테마 제안 (docs/PLAN-2026-08-08-presets-schedule.md Q1~Q3) ────────────────────────

/// kind='theme' 의 payload — 클러스터 멤버 노트 id 전량(앵커 포함, 정렬됨). 프런트
/// (src/pet/PetBubbleApp.tsx)는 여기서 개수를 세고, 수락 시 이 id들로 본문을 읽는다.
/// 저장(Serialize)과 중복 판별(Deserialize)이 같은 구조체를 쓴다 — 두 곳에서 모양이 갈리지 않게.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ThemePayload {
    #[serde(default)]
    note_ids: Vec<String>,
}

/// 테마 제안 삽입. 이미 같은 클러스터의 제안이 있으면 넣지 않고 false 를 돌려준다.
/// 저장 스키마는 준비됐지만 프로덕션 생산자는 없다 — 호출은 테스트뿐. 그래프 탭 겹침은
/// related_sql → upsert_overlap.
///
/// 겹침(kind='overlap')처럼 노트 **쌍**으로 정규화할 수 없어(멤버가 4개 이상) UNIQUE 인덱스로
/// 중복을 막을 수 없다 — 대신 **멤버 노트 집합이 하나라도 겹치면 같은 클러스터**로 보고 기존
/// 행이 있으면 건너뛴다. status 를 가리지 않는 이유: dismissed 는 재제안 금지(overlap 과 동일
/// 정책), accepted 는 이미 체크리스트를 만들었고, pending 은 아직 답을 안 준 카드다 — 셋 다
/// 다시 물을 이유가 없다.
///
/// ponytail: 멤버 한 개만 겹쳐도 같은 클러스터로 접는다 — 실제로 갈라진 두 주제가 노트 하나를
/// 공유하면 두 번째 테마는 영영 안 뜬다. 조르지 않는 쪽으로 기운 보수적 기본값이다. 재제안이
/// 필요해지면 교집합 **비율**(예: 절반 이상 겹칠 때만 동일 클러스터)로 올린다.
pub fn upsert_theme(
    conn: &Connection,
    workspace_id: &str,
    anchor_note_id: &str,
    representative_note_id: &str,
    member_note_ids: &[String],
    score: f32,
) -> AppResult<bool> {
    let mut stmt = conn
        .prepare("SELECT payload FROM suggestions WHERE kind = 'theme' AND workspace_id = ?1")
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id], |r| r.get::<_, Option<String>>(0))
        .map_err(dberr)?;
    for row in rows {
        let Some(payload) = row.map_err(dberr)? else { continue };
        let Ok(existing) = serde_json::from_str::<ThemePayload>(&payload) else { continue };
        if existing.note_ids.iter().any(|id| member_note_ids.contains(id)) {
            return Ok(false);
        }
    }

    let payload = serde_json::to_string(&ThemePayload { note_ids: member_note_ids.to_vec() })
        .unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "INSERT INTO suggestions
           (id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
         VALUES (?1, ?2, 'theme', ?3, ?4, ?5, ?6, 'pending', ?7, ?7)",
        params![
            new_id(),
            workspace_id,
            anchor_note_id,
            representative_note_id,
            payload,
            score as f64,
            now_iso()
        ],
    )
    .map_err(dberr)?;
    Ok(true)
}

pub struct SuggestionRow {
    pub id: String,
    pub kind: String,
    pub note_id: String,
    pub note_title: String,
    pub related_note_id: String,
    pub related_note_title: String,
    pub payload: String,
    pub score: f64,
    pub created_at: String,
}

/// workspace_id + status 로 필터한 제안 목록, 최신순. 삭제(소프트 포함)된 노트가 관련된 행은
/// notes 이너 조인 + deleted_at IS NULL 필터로 자연스럽게 빠진다(별도 후처리 불필요).
pub fn list(conn: &Connection, workspace_id: &str, status: &str) -> AppResult<Vec<SuggestionRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.kind, s.note_id, n1.title, s.related_note_id, n2.title, s.payload, s.score, s.created_at
             FROM suggestions s
             JOIN notes n1 ON n1.id = s.note_id
             JOIN notes n2 ON n2.id = s.related_note_id
             WHERE s.workspace_id = ?1 AND s.status = ?2
               AND n1.deleted_at IS NULL AND n2.deleted_at IS NULL
             ORDER BY s.created_at DESC",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, status], |r| {
            Ok(SuggestionRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                note_id: r.get(2)?,
                note_title: r.get(3)?,
                related_note_id: r.get(4)?,
                related_note_title: r.get(5)?,
                payload: r.get(6)?,
                score: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(dberr)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(dberr)
}

// ── P2 3단계: 링크 붙여넣기 후행 제안 (docs/PLAN-2026-08-07-second-brain.md Q5) ────────────────

/// 링크 후행 제안 실효 게이트 — `ai_enabled` && `link_suggestions`(옵트인, 기본 OFF).
/// 단일 지점 패턴(모든 호출부가 이 함수만 지난다) — 링크 붙여넣기는
/// 외부 fetch(commands::suggestions::link_suggest → repo::web_reader::fetch_reader)를 트리거하므로
/// ai_enabled 만으로는 부족하고, 사용자가 이 기능을 별도로 켜야 한다("외부 fetch는 프라이버시
/// 게이트 옵트인" 원칙).
pub fn link_suggestions_active(conn: &Connection) -> bool {
    crate::repo::settings::get_all(conn)
        .ok()
        .map(|s| {
            let b = |k: &str| s.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
            b("ai_enabled") && b("link_suggestions")
        })
        .unwrap_or(false)
}

/// 같은 노트에 같은 url의 pending 링크 제안이 이미 있는가 — link_suggest 커맨드가 중복 생성을
/// 막는 데 쓴다. link의
/// related_note_id는 매칭된 대상 노트(또는 대상이 없을 때 note_id 자기참조, insert_link 참고)이지
/// url이 아니라서, 같은 노트에 붙여넣은 서로 다른 두 url이 우연히 같은 결론(같은 대상, 혹은 둘 다
/// 대상 없음)에 도달하면 그 제약과는 별개로 이 함수가 url 자체로 먼저 걸러낸다.
pub fn has_pending_link(conn: &Connection, note_id: &str, url: &str) -> AppResult<bool> {
    conn.query_row(
        "SELECT 1 FROM suggestions
         WHERE kind = 'link' AND note_id = ?1 AND status = 'pending'
           AND link_url = ?2
         LIMIT 1",
        params![note_id, url],
        |_| Ok(()),
    )
    .optional()
    .map_err(dberr)
    .map(|r| r.is_some())
}

/// 링크 제안을 삽입한다. `related_note_id`는 시맨틱 매치로 찾은 대상 노트(있으면) — 없으면
/// `note_id` 자기참조로 채운다(컬럼이 NOT NULL이라, "대상 없음"을 이렇게 인코딩한다. 프런트는
/// payload의 target_note_id 유무로 실제 대상 여부를 판단하지 이 컬럼을 직접 보지 않는다).
/// `link_url` 컬럼의 부분 유니크 인덱스가 같은 노트·URL의 pending 행만 막는다. `has_pending_link`
/// 로 먼저 걸렀어도 동시에 들어온 동일 URL 요청은 INSERT OR IGNORE로 안전하게 수렴하고,
/// 서로 다른 URL은 같은 대상 노트로 매칭돼도 각각 보존된다.
pub fn insert_link(
    conn: &Connection,
    workspace_id: &str,
    note_id: &str,
    related_note_id: &str,
    link_url: &str,
    score: f32,
    payload: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO suggestions
           (id, workspace_id, kind, note_id, related_note_id, link_url, payload, score, status, created_at, updated_at)
         VALUES (?1, ?2, 'link', ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)",
        params![new_id(), workspace_id, note_id, related_note_id, link_url, payload, score as f64, now_iso()],
    )
    .map_err(dberr)?;
    Ok(())
}

// ── P3 수집: 수집 후행 AI 처리 제안 (crate::collect::ingest_item, post_process='suggest') ─────

/// 수집기가 `post_process='suggest'` 소스에서 노트를 만든 직후, AI 후처리 제안 하나를 적재한다.
/// `related_note_id`도 `note_id`와 같은 값을 쓴다 — 대상이 그 노트 자신이라 overlap/link처럼
/// 서로 다른 두 노트를 잇는 관계가 아니다(컬럼이 NOT NULL이라 자기참조로 채운다, insert_link와
/// 같은 관례). 이 파일 밖(옛 collect::mod.rs)에서 직접 INSERT하던 걸 옮겨왔다 — VALID_STATUSES·
/// upsert류와 함께 suggestions 테이블 쓰기는 이 파일 하나로 모은다.
pub fn insert_collect_post_process(
    conn: &Connection,
    workspace_id: &str,
    note_id: &str,
    payload: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO suggestions (id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
         VALUES (?1, ?2, 'collect_post_process', ?3, ?3, ?4, 1.0, 'pending', ?5, ?5)",
        params![new_id(), workspace_id, note_id, payload, now_iso()],
    )
    .map_err(dberr)?;
    Ok(())
}

/// status 갱신. 허용값(VALID_STATUSES) 밖이면 VALIDATION — 프론트 오타/구버전 방어.
pub fn set_status(conn: &Connection, id: &str, status: &str) -> AppResult<()> {
    if !VALID_STATUSES.contains(&status) {
        return Err(AppError::Validation(format!(
            "suggestion_set_status: unknown status '{status}' (pending|dismissed|accepted)"
        )));
    }
    conn.execute(
        "UPDATE suggestions SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, now_iso(), id],
    )
    .map_err(dberr)?;
    Ok(())
}

/// Accepts an overlap suggestion as one atomic write: at most one internal link for the pair,
/// then status=accepted. Replaying an already accepted id is a successful no-op.
pub fn graph_suggestion_accept(conn: &mut Connection, id: &str) -> AppResult<String> {
    let tx = conn.transaction().map_err(dberr)?;
    let row: Option<(String, String, String, String, String)> = tx
        .query_row(
            "SELECT s.kind, s.note_id, s.related_note_id, n2.title, s.status
             FROM suggestions s
             JOIN notes n1 ON n1.id=s.note_id
             JOIN notes n2 ON n2.id=s.related_note_id
             JOIN folders f1 ON f1.id=n1.folder_id AND f1.workspace_id=s.workspace_id
             JOIN folders f2 ON f2.id=n2.folder_id AND f2.workspace_id=s.workspace_id
             WHERE s.id=?1
               AND n1.deleted_at IS NULL AND n1.archived_at IS NULL
               AND n2.deleted_at IS NULL AND n2.archived_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (kind, source, target, target_title, status) =
        row.ok_or_else(|| AppError::NotFound(format!("suggestion not found: {id}")))?;
    if kind != "overlap" {
        return Err(AppError::Validation("only overlap suggestions can create graph links".to_string()));
    }
    if status == "accepted" {
        return Ok(source);
    }
    if status != "pending" {
        return Err(AppError::Conflict(format!("suggestion is already {status}")));
    }
    let linked = tx
        .query_row(
            "SELECT 1 FROM attachments WHERE kind='internal'
             AND ((note_id=?1 AND url=?2) OR (note_id=?2 AND url=?1)) LIMIT 1",
            params![source, target],
            |_| Ok(()),
        )
        .optional()
        .map_err(dberr)?
        .is_some();
    if !linked {
        crate::repo::attachments::add_internal(&tx, &source, &target, &target_title)?;
    }
    set_status(&tx, id, "accepted")?;
    tx.commit().map_err(dberr)?;
    Ok(source)
}

/// Dismisses an overlap suggestion and excludes its pair from related-note scoring atomically.
/// Replaying an already dismissed id is a successful no-op.
pub fn graph_suggestion_dismiss(conn: &mut Connection, id: &str) -> AppResult<(String, String)> {
    let tx = conn.transaction().map_err(dberr)?;
    let row: Option<(String, String, String, String)> = tx
        .query_row(
            "SELECT s.kind, s.note_id, s.related_note_id, s.status
             FROM suggestions s
             JOIN notes n1 ON n1.id=s.note_id
             JOIN notes n2 ON n2.id=s.related_note_id
             JOIN folders f1 ON f1.id=n1.folder_id AND f1.workspace_id=s.workspace_id
             JOIN folders f2 ON f2.id=n2.folder_id AND f2.workspace_id=s.workspace_id
             WHERE s.id=?1
               AND n1.deleted_at IS NULL AND n1.archived_at IS NULL
               AND n2.deleted_at IS NULL AND n2.archived_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (kind, source, target, status) =
        row.ok_or_else(|| AppError::NotFound(format!("suggestion not found: {id}")))?;
    if kind != "overlap" {
        return Err(AppError::Validation("only overlap suggestions can be dismissed from the graph".to_string()));
    }
    if status == "dismissed" {
        return Ok((source, target));
    }
    if status != "pending" {
        return Err(AppError::Conflict(format!("suggestion is already {status}")));
    }
    crate::repo::notes::related_exclude(&tx, &source, &target)?;
    set_status(&tx, id, "dismissed")?;
    tx.commit().map_err(dberr)?;
    Ok((source, target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_iso as ts;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn
    }

    /// 워크스페이스/폴더/노트 하나를 만들고 note_id를 돌려준다 — list()의 JOIN이 기대하는
    /// 최소 배경 데이터.
    fn seed_note(conn: &Connection, ws_id: &str, title: &str) -> String {
        let folder_id = new_id();
        let note_id = new_id();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1, 'ws', ?2) ON CONFLICT(id) DO NOTHING",
            params![ws_id, ts()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at) VALUES (?1, ?2, 'f', 0, 1, ?3)",
            params![folder_id, ws_id, ts()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES (?1, ?2, ?3, 2026, ?4, ?4)",
            params![note_id, folder_id, title, ts()],
        )
        .unwrap();
        note_id
    }

    #[test]
    fn upsert_overlap_normalizes_pair_order() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        // Scanning the reverse direction (b, a) must not create a second row.
        upsert_overlap(&conn, &ws, &b, &a, 0.91, "{}").unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "A→B and B→A must collapse into one suggestion row");
    }

    #[test]
    fn upsert_overlap_does_not_reinsert_a_dismissed_pair() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let id: String = conn.query_row("SELECT id FROM suggestions", [], |r| r.get(0)).unwrap();
        set_status(&conn, &id, "dismissed").unwrap();

        // A later re-detection of the same pair must not resurrect it as pending.
        upsert_overlap(&conn, &ws, &a, &b, 0.95, "{}").unwrap();
        let (count, status): (i64, String) = conn
            .query_row("SELECT COUNT(*), MAX(status) FROM suggestions", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(status, "dismissed", "dismissed pairs must not be re-proposed");
    }

    #[test]
    fn list_defaults_to_pending_and_excludes_deleted_notes() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        let c = seed_note(&conn, &ws, "C");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        upsert_overlap(&conn, &ws, &a, &c, 0.88, "{}").unwrap();

        conn.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![ts(), c]).unwrap();

        let pending = list(&conn, &ws, "pending").unwrap();
        assert_eq!(pending.len(), 1, "the pair involving the soft-deleted note must be filtered out");
        // upsert_overlap normalizes (min,max) by raw id string, so which title lands in
        // note_title vs related_note_title depends on the (random) generated ids — assert the
        // unordered pair instead of a fixed slot.
        let mut titles = [pending[0].note_title.as_str(), pending[0].related_note_title.as_str()];
        titles.sort();
        assert_eq!(titles, ["A", "B"]);
    }

    #[test]
    fn list_filters_by_status() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let id: String = conn.query_row("SELECT id FROM suggestions", [], |r| r.get(0)).unwrap();
        set_status(&conn, &id, "accepted").unwrap();

        assert!(list(&conn, &ws, "pending").unwrap().is_empty());
        assert_eq!(list(&conn, &ws, "accepted").unwrap().len(), 1);
    }

    #[test]
    fn set_status_rejects_unknown_values() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let id: String = conn.query_row("SELECT id FROM suggestions", [], |r| r.get(0)).unwrap();
        let err = set_status(&conn, &id, "bogus").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // ── P2 3단계: 링크 후행 제안 ──────────────────────────────────────────────────────────────

    #[test]
    fn link_suggestions_active_requires_both_flags() {
        let mut conn = test_conn();
        // 새 DB 기본값 — 둘 다 OFF.
        assert!(!link_suggestions_active(&conn));

        // ai_enabled만 켜짐 — 여전히 비활성.
        let mut only_ai = std::collections::BTreeMap::new();
        only_ai.insert("ai_enabled".to_string(), serde_json::json!(true));
        crate::repo::settings::set(&mut conn, &only_ai).unwrap();
        assert!(!link_suggestions_active(&conn));

        // 둘 다 켜져야 활성.
        let mut both = std::collections::BTreeMap::new();
        both.insert("link_suggestions".to_string(), serde_json::json!(true));
        crate::repo::settings::set(&mut conn, &both).unwrap();
        assert!(link_suggestions_active(&conn));
    }

    #[test]
    fn has_pending_link_matches_only_same_note_and_url() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        assert!(!has_pending_link(&conn, &a, "https://example.com").unwrap());

        let payload = serde_json::json!({"url": "https://example.com", "summary": "s", "title": "t"}).to_string();
        insert_link(&conn, &ws, &a, &a, "https://example.com", 0.0, &payload).unwrap();

        assert!(has_pending_link(&conn, &a, "https://example.com").unwrap());
        // 다른 url — 매치 없음.
        assert!(!has_pending_link(&conn, &a, "https://example.com/other").unwrap());
        // 다른 노트 — 매치 없음.
        assert!(!has_pending_link(&conn, &b, "https://example.com").unwrap());
    }

    #[test]
    fn has_pending_link_ignores_dismissed_suggestions() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let payload = serde_json::json!({"url": "https://example.com", "summary": "s", "title": "t"}).to_string();
        insert_link(&conn, &ws, &a, &a, "https://example.com", 0.0, &payload).unwrap();
        let id: String = conn.query_row("SELECT id FROM suggestions", [], |r| r.get(0)).unwrap();
        set_status(&conn, &id, "dismissed").unwrap();

        // dismissed된 제안은 "이미 pending" 판정에서 빠진다 — 사용자가 무시한 뒤 같은 url을
        // 다시 붙여넣으면 재제안 가능해야 한다(overlap의 dismissed 존중과는 의도적으로 다르다:
        // 거긴 재탐지 자체를 막지만, link는 애초에 사용자의 명시적 paste 행동이 트리거라 매번
        // 새 판단 기회를 준다).
        assert!(!has_pending_link(&conn, &a, "https://example.com").unwrap());
    }

    #[test]
    fn insert_link_self_references_when_no_target_note() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let payload = serde_json::json!({"url": "https://example.com", "summary": "s", "title": "t"}).to_string();
        insert_link(&conn, &ws, &a, &a, "https://example.com", 0.0, &payload).unwrap();

        let (kind, note_id, related_note_id, status): (String, String, String, String) = conn
            .query_row(
                "SELECT kind, note_id, related_note_id, status FROM suggestions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(kind, "link");
        assert_eq!(status, "pending");
        assert_eq!(note_id, a);
        assert_eq!(related_note_id, a, "대상 노트가 없으면 note_id 자기참조로 NOT NULL을 만족시킨다");
    }

    #[test]
    fn insert_link_payload_round_trips() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        let payload = serde_json::json!({
            "url": "https://example.com/article",
            "summary": "요약 두세 문장",
            "title": "제목",
            "target_note_id": b,
            "target_note_title": "B",
        })
        .to_string();
        insert_link(&conn, &ws, &a, &b, "https://example.com/article", 0.72, &payload).unwrap();

        let items = list(&conn, &ws, "pending").unwrap();
        assert_eq!(items.len(), 1);
        let stored: serde_json::Value = serde_json::from_str(&items[0].payload).unwrap();
        assert_eq!(stored["url"], "https://example.com/article");
        assert_eq!(stored["summary"], "요약 두세 문장");
        assert_eq!(stored["target_note_id"], b);
        assert!((items[0].score - 0.72).abs() < 1e-6);
    }

    // ── 웨이브 ③ 테마 제안 ────────────────────────────────────────────────────────────────────

    #[test]
    fn upsert_theme_skips_a_cluster_that_shares_any_member() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        let c = seed_note(&conn, &ws, "C");
        let d = seed_note(&conn, &ws, "D");
        let e = seed_note(&conn, &ws, "E");

        let first = vec![a.clone(), b.clone(), c.clone(), d.clone()];
        assert!(upsert_theme(&conn, &ws, &a, &b, &first, 0.7).unwrap());

        // 같은 클러스터를 다른 노트가 앵커로 다시 발견 — 멤버가 겹치므로 중복 제안 금지.
        let second = vec![a.clone(), b.clone(), c.clone(), e.clone()];
        assert!(!upsert_theme(&conn, &ws, &b, &a, &second, 0.72).unwrap());

        // 멤버가 하나도 안 겹치는 진짜 다른 클러스터는 통과한다.
        let f = seed_note(&conn, &ws, "F");
        let g = seed_note(&conn, &ws, "G");
        let h = seed_note(&conn, &ws, "H");
        let other = vec![e.clone(), f, g, h];
        assert!(upsert_theme(&conn, &ws, &e, &e, &other, 0.65).unwrap());

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM suggestions WHERE kind='theme'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn upsert_theme_does_not_repropose_a_dismissed_cluster() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        let c = seed_note(&conn, &ws, "C");
        let d = seed_note(&conn, &ws, "D");
        let members = vec![a.clone(), b.clone(), c.clone(), d.clone()];
        upsert_theme(&conn, &ws, &a, &b, &members, 0.7).unwrap();
        let id: String = conn
            .query_row("SELECT id FROM suggestions WHERE kind='theme'", [], |r| r.get(0))
            .unwrap();
        set_status(&conn, &id, "dismissed").unwrap();

        assert!(!upsert_theme(&conn, &ws, &a, &b, &members, 0.7).unwrap());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM suggestions WHERE kind='theme'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "무시한 클러스터는 다시 제안하지 않는다");
    }

    #[test]
    fn upsert_theme_row_is_listable_and_carries_members() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "우유 사기");
        let b = seed_note(&conn, &ws, "B");
        let c = seed_note(&conn, &ws, "C");
        let d = seed_note(&conn, &ws, "D");
        let members = vec![a.clone(), b.clone(), c.clone(), d.clone()];
        upsert_theme(&conn, &ws, &a, &b, &members, 0.7).unwrap();

        let items = list(&conn, &ws, "pending").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "theme");
        assert_eq!(items[0].note_title, "우유 사기", "앵커 노트가 칩의 대표 제목이 된다");
        let payload: serde_json::Value = serde_json::from_str(&items[0].payload).unwrap();
        assert_eq!(payload["note_ids"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn different_link_urls_can_share_the_same_target_note() {
        let conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        let first = serde_json::json!({"url": "https://example.com/one"}).to_string();
        let second = serde_json::json!({"url": "https://example.com/two"}).to_string();

        insert_link(&conn, &ws, &a, &b, "https://example.com/one", 0.7, &first).unwrap();
        insert_link(&conn, &ws, &a, &b, "https://example.com/two", 0.8, &second).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM suggestions WHERE kind='link'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn graph_suggestion_accept_adds_one_link_and_is_idempotent() {
        let mut conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let suggestion_id = list(&conn, &ws, "pending").unwrap()[0].id.clone();

        graph_suggestion_accept(&mut conn, &suggestion_id).unwrap();
        graph_suggestion_accept(&mut conn, &suggestion_id).unwrap();

        assert_eq!(list(&conn, &ws, "accepted").unwrap().len(), 1);
        let graph = crate::repo::dashboard::graph(&conn, &ws, None).unwrap();
        let links: Vec<_> = graph.edges.iter().filter(|edge| edge.kind == "backlink").collect();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].weight, 100);
    }

    #[test]
    fn graph_suggestion_dismiss_hides_the_pair_and_is_idempotent() {
        let mut conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let suggestion_id = list(&conn, &ws, "pending").unwrap()[0].id.clone();
        assert!(crate::repo::dashboard::graph(&conn, &ws, None)
            .unwrap()
            .edges
            .iter()
            .any(|edge| edge.kind == "related"));

        graph_suggestion_dismiss(&mut conn, &suggestion_id).unwrap();
        graph_suggestion_dismiss(&mut conn, &suggestion_id).unwrap();

        assert_eq!(list(&conn, &ws, "dismissed").unwrap().len(), 1);
        assert!(!crate::repo::dashboard::graph(&conn, &ws, None)
            .unwrap()
            .edges
            .iter()
            .any(|edge| edge.kind == "related"));
    }

    #[test]
    fn graph_suggestion_accept_rejects_a_stale_hidden_note() {
        let mut conn = test_conn();
        let ws = new_id();
        let a = seed_note(&conn, &ws, "A");
        let b = seed_note(&conn, &ws, "B");
        upsert_overlap(&conn, &ws, &a, &b, 0.9, "{}").unwrap();
        let suggestion_id = list(&conn, &ws, "pending").unwrap()[0].id.clone();
        crate::repo::notes::archive(&mut conn, &b).unwrap();

        assert!(matches!(
            graph_suggestion_accept(&mut conn, &suggestion_id),
            Err(AppError::NotFound(_))
        ));
        assert_eq!(list(&conn, &ws, "pending").unwrap().len(), 1);
    }
}
