// repo::collect — collect_sources/collect_seen 테이블 CRUD (P3 수집 관문,
// db/migrations.rs V40_SQL, docs/PLAN-2026-08-07-second-brain.md Q6). commands::collect(사용자
// CRUD·자연어 추가)와 crate::collect(백그라운드 러너)가 함께 쓴다 — 어댑터별 fetch/파싱 로직은
// 여기 없다(crate::collect::rss 등), 이 파일은 테이블 접근만 책임진다.
use crate::error::{db as dberr, AppError, AppResult};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// config JSON에 "interval_minutes"가 없을 때의 기본 주기.
pub const DEFAULT_INTERVAL_MINUTES: i64 = 60;
/// 사용자가 아무리 짧게 설정해도 이보다 자주 돌지 않는다 — 60초 tick 러너가 매 tick마다 같은
/// 소스를 재실행하는 사고를 막는 하한선.
pub const MIN_INTERVAL_MINUTES: i64 = 15;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct CollectSource {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    /// kind별 엄격한 JSON(문자열) — crate::collect::config가 등록·실행 경계에서 스키마를 검증한다.
    pub config: String,
    pub enabled: bool,
    pub dry_run: bool,
    /// 브리핑 "최근 수집 노트"에 이 소스의 노트를 보일지(V92). 기본 true.
    pub show_in_briefing: bool,
    pub target_folder_id: Option<String>,
    pub post_process: String,
    pub post_process_model: Option<String>,
    pub interval_minutes: Option<i64>,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT_COLS: &str =
    "id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, last_status, last_error, created_at, updated_at, show_in_briefing";

fn row_to_source(r: &rusqlite::Row) -> rusqlite::Result<CollectSource> {
    Ok(CollectSource {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        kind: r.get(2)?,
        name: r.get(3)?,
        config: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        dry_run: r.get::<_, i64>(6)? != 0,
        show_in_briefing: r.get::<_, i64>(16)? != 0,
        target_folder_id: r.get(7)?,
        post_process: r.get(8)?,
        post_process_model: r.get(9)?,
        interval_minutes: r.get(10)?,
        last_run_at: r.get(11)?,
        last_status: r.get(12)?,
        last_error: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

pub fn list(conn: &Connection, workspace_id: &str) -> AppResult<Vec<CollectSource>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM collect_sources WHERE workspace_id = ?1 ORDER BY created_at DESC"
        ))
        .map_err(dberr)?;
    let rows = stmt.query_map(params![workspace_id], row_to_source).map_err(dberr)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(dberr)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<CollectSource>> {
    conn.query_row(&format!("SELECT {SELECT_COLS} FROM collect_sources WHERE id = ?1"), params![id], row_to_source)
        .optional()
        .map_err(dberr)
}

#[derive(Debug, Clone)]
pub struct CreateCollectSourceParams<'a> {
    pub workspace_id: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub config: &'a str,
    pub dry_run: bool,
    pub target_folder_id: Option<&'a str>,
    pub post_process: &'a str,
    pub post_process_model: Option<&'a str>,
    pub interval_minutes: Option<i64>,
    pub show_in_briefing: bool,
}

/// 새 소스를 저장한다 (기본 옵션).
pub fn create(conn: &Connection, workspace_id: &str, kind: &str, name: &str, config: &str) -> AppResult<CollectSource> {
    create_with_options(
        conn,
        CreateCollectSourceParams {
            workspace_id,
            kind,
            name,
            config,
            dry_run: false,
            target_folder_id: None,
            post_process: "none",
            post_process_model: None,
            interval_minutes: None,
            show_in_briefing: true,
        },
    )
}

/// `post_process` 허용값 — `none`(무시) | `suggest`(정리 제안 카드, §2.6) |
/// `summary`(하루치 프롬프트 3줄 요약 upsert, PLAN-2026-09-04-local-import §2.4). create/update
/// 두 커맨드가 모두 여길 지나므로(commands::collect::collect_source_create/update →
/// create_with_options/update) 한 곳에서만 막는다 — 어느 한쪽만 검증하고 다른 쪽이 빠지는
/// 드리프트를 방지.
const ALLOWED_POST_PROCESS: &[&str] = &["none", "suggest", "summary"];

fn validate_post_process(value: &str) -> AppResult<()> {
    if ALLOWED_POST_PROCESS.contains(&value) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "invalid post_process {value:?} — must be one of {ALLOWED_POST_PROCESS:?}"
        )))
    }
}

/// 새 소스를 상세 옵션과 함께 저장한다.
pub fn create_with_options(
    conn: &Connection,
    params: CreateCollectSourceParams,
) -> AppResult<CollectSource> {
    validate_post_process(params.post_process)?;
    let id = new_id();
    let now = now_iso();
    let interval = params.interval_minutes.map(clamp_interval_or_on_open_sentinel);
    conn.execute(
        "INSERT INTO collect_sources(id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, created_at, updated_at, show_in_briefing)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)",
        rusqlite::params![
            id,
            params.workspace_id,
            params.kind,
            params.name,
            params.config,
            params.dry_run as i64,
            params.target_folder_id,
            params.post_process,
            params.post_process_model,
            interval,
            now,
            params.show_in_briefing as i64,
        ],
    )
    .map_err(dberr)?;
    get(conn, &id)?.ok_or_else(|| AppError::Db("collect source vanished right after insert".to_string()))
}

#[derive(Debug, Clone, Default)]
pub struct UpdateCollectSourceParams<'a> {
    pub name: Option<&'a str>,
    pub config: Option<&'a str>,
    pub dry_run: Option<bool>,
    pub target_folder_id: Option<Option<&'a str>>,
    pub post_process: Option<&'a str>,
    pub post_process_model: Option<Option<&'a str>>,
    pub interval_minutes: Option<Option<i64>>,
    /// None = 유지(dry_run 과 같은 관례).
    pub show_in_briefing: Option<bool>,
}

/// 기존 소스의 메타데이터 및 설정을 갱신한다.
pub fn update(
    conn: &Connection,
    id: &str,
    params: UpdateCollectSourceParams,
) -> AppResult<CollectSource> {
    if let Some(pp) = params.post_process {
        validate_post_process(pp)?;
    }
    let current = get(conn, id)?.ok_or_else(|| AppError::NotFound(format!("collect source not found: {id}")))?;
    let name = params.name.unwrap_or(&current.name);
    let config = params.config.unwrap_or(&current.config);
    let dry_run = params.dry_run.unwrap_or(current.dry_run);
    let target_folder_id = match params.target_folder_id {
        Some(opt) => opt.map(str::to_string),
        None => current.target_folder_id,
    };
    let post_process = params.post_process.unwrap_or(&current.post_process);
    let post_process_model = match params.post_process_model {
        Some(opt) => opt.map(str::to_string),
        None => current.post_process_model,
    };
    let interval_minutes = match params.interval_minutes {
        Some(opt) => opt.map(clamp_interval_or_on_open_sentinel),
        None => current.interval_minutes,
    };
    let show_in_briefing = params.show_in_briefing.unwrap_or(current.show_in_briefing);
    let now = now_iso();
    conn.execute(
        "UPDATE collect_sources SET name = ?1, config = ?2, dry_run = ?3, target_folder_id = ?4, post_process = ?5, post_process_model = ?6, interval_minutes = ?7, updated_at = ?8, show_in_briefing = ?10 WHERE id = ?9",
        rusqlite::params![
            name,
            config,
            dry_run as i64,
            target_folder_id,
            post_process,
            post_process_model,
            interval_minutes,
            now,
            id,
            show_in_briefing as i64,
        ],
    )
    .map_err(dberr)?;
    get(conn, id)?.ok_or_else(|| AppError::NotFound(format!("collect source not found: {id}")))
}

pub fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> AppResult<()> {
    let n = conn
        .execute(
            "UPDATE collect_sources SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled as i64, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("collect source not found: {id}")));
    }
    Ok(())
}

/// 소스와 그 collect_seen 기록을 함께 지운다. V96 부터 collect_seen 이 ON DELETE CASCADE 라 첫 DELETE 는
/// 중복이지만 남긴다 — FK 강제는 연결별 PRAGMA(db::open 이 켠다)라 그걸 안 켠 연결에서도 같은 결과여야 한다.
pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
    // Seen history and its owning source form one logical record. Keep both deletes in a single
    // transaction so an error cannot leave the source alive without its idempotency history (or
    // vice versa).
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("DELETE FROM collect_seen WHERE source_id = ?1", params![id]).map_err(dberr)?;
    let n = tx.execute("DELETE FROM collect_sources WHERE id = ?1", params![id]).map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("collect source not found: {id}")));
    }
    tx.commit().map_err(dberr)?;
    Ok(())
}

/// interval_minutes 저장값 하나를 검증한다: 0은 "창을 열 때"(ON_OPEN_SENTINEL) 예약값이라 그대로
/// 통과, 그 외는 기존처럼 MIN_INTERVAL_MINUTES로 클램프.
fn clamp_interval_or_on_open_sentinel(m: i64) -> i64 {
    if m == ON_OPEN_SENTINEL { m } else { m.max(MIN_INTERVAL_MINUTES) }
}

/// `interval_minutes = 0`은 실제 분(minute) 값이 아니라 "앱을 새로 켤 때마다 한 번" 예약값이다.
/// MIN_INTERVAL_MINUTES(15)보다 작아 평소엔 나올 수 없는 값이라 별도 컬럼 없이 재사용할 수 있다
/// — is_due가 boot_at 이후로 아직 한 번도 안 돌았으면 due로 판정하고, 같은 세션 안에서는 60초
/// tick마다 재실행되지 않는다(부팅 후 딱 한 번, 다음 재부팅에 다시 한 번).
pub const ON_OPEN_SENTINEL: i64 = 0;

/// config JSON의 "interval_minutes"(정수)를 읽어 MIN_INTERVAL_MINUTES로 클램프한다. 파싱 실패/
/// 필드 없음은 DEFAULT_INTERVAL_MINUTES.
/// ponytail: 컬럼(interval_minutes)으로 승격되었으며, 기존 행 호환을 위해 유지됨.
pub fn effective_interval_minutes(config: &str) -> i64 {
    let parsed: serde_json::Value = serde_json::from_str(config).unwrap_or(serde_json::Value::Null);
    let raw = parsed.get("interval_minutes").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_INTERVAL_MINUTES);
    raw.max(MIN_INTERVAL_MINUTES)
}

/// `source`가 `now`(ISO8601) 시점에 실행 도래했는지.
/// - `interval_minutes == ON_OPEN_SENTINEL`(0, "창을 열 때"): last_run_at이 없거나 `boot_at`
///   (이번 앱 실행이 시작된 시각)보다 이전이면 due — 이번 부팅에서 아직 한 번도 안 돈 것이다.
///   한 번 돌면 last_run_at이 boot_at 이후로 갱신되므로 같은 세션의 남은 60초 tick에서는
///   전부 false(다음 재부팅까지 조용함).
/// - 그 외: last_run_at이 없으면(한 번도 안 돎) 항상 due, 있으면
///   last_run_at + (interval_minutes 컬럼 우선, 없으면 config 폴백) <= now.
/// 타임스탬프 파싱 실패는 "도래한 걸로 취급"(안전 쪽 — 소스가 영원히 멈춰있는 것보다 한 번 더
/// 도는 게 낫다)한다.
fn is_due(source: &CollectSource, now: &str, boot_at: &str) -> bool {
    // "partial"(browser_history가 VISIT_LIMIT을 꽉 채운 run, collect::mod::finish_run_now_
    // collecting_notes) 은 History에 더 가져올 방문이 남아있다는 신호라 주기/ON_OPEN_SENTINEL과
    // 무관하게 다음 tick에 바로 다시 잡힌다 — 안 그러면 사용자가 기본 60분 주기를 다 기다려야
    // 이월분을 마저 받는다.
    if source.last_status.as_deref() == Some("partial") {
        return true;
    }
    let Some(last) = source.last_run_at.as_deref() else { return true };
    let Ok(last_t) = chrono::DateTime::parse_from_rfc3339(last) else { return true };
    if source.interval_minutes == Some(ON_OPEN_SENTINEL) {
        let Ok(boot_t) = chrono::DateTime::parse_from_rfc3339(boot_at) else { return true };
        return last_t < boot_t;
    }
    let Ok(now_t) = chrono::DateTime::parse_from_rfc3339(now) else { return false };
    let interval = source
        .interval_minutes
        .map(|m| m.max(MIN_INTERVAL_MINUTES))
        .unwrap_or_else(|| effective_interval_minutes(&source.config));
    now_t.signed_duration_since(last_t) >= chrono::Duration::minutes(interval)
}

/// enabled 소스 중 `now` 시점에 주기가 도래한 것들. dry_run=1 소스는 제외(드라이런은 지금 실행 전용).
/// `boot_at`은 이번 앱 실행이 시작된 시각(ISO8601, collect::start가 한 번 고정) — ON_OPEN_SENTINEL
/// 판정에만 쓰인다. 러너의 60초 tick 하나당 1쿼리(브루트포스 전량 스캔) —
/// embedding::worker::find_stale과 같은 근거(개인 노트 앱 규모에서 소스 개수는 수십 단위를 넘지 않는다).
pub fn find_due(conn: &Connection, now: &str, boot_at: &str) -> AppResult<Vec<CollectSource>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM collect_sources WHERE enabled = 1 AND dry_run = 0"
        ))
        .map_err(dberr)?;
    let rows = stmt.query_map([], row_to_source).map_err(dberr)?;
    let all: Vec<CollectSource> = rows.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
    Ok(all.into_iter().filter(|s| is_due(s, now, boot_at)).collect())
}

/// 실행 결과 기록 — status는 'ok'|'error'만 쓴다(러너 전용 내부 호출이라 커맨드 계층의 VALIDATION
/// allowlist 검증 없이 그대로 UPDATE, suggestions::set_status와 달리 프런트가 직접 부르지 않음).
pub fn record_result(conn: &Connection, id: &str, status: &str, error: Option<&str>) -> AppResult<()> {
    let now = now_iso();
    conn.execute(
        "UPDATE collect_sources SET last_run_at = ?1, last_status = ?2, last_error = ?3, updated_at = ?1 WHERE id = ?4",
        params![now, status, error, id],
    )
    .map_err(dberr)?;
    Ok(())
}

pub fn is_seen(conn: &Connection, source_id: &str, guid: &str) -> AppResult<bool> {
    conn.query_row(
        "SELECT 1 FROM collect_seen WHERE source_id = ?1 AND guid = ?2",
        params![source_id, guid],
        |_| Ok(()),
    )
    .optional()
    .map_err(dberr)
    .map(|r| r.is_some())
}

/// `guids` 중 이 소스에 대해 이미 collect_seen인 것들의 집합을 배치로 조회한다 — 드라이런
/// seen-체크가 항목 하나당 `is_seen` SELECT를 쏘던 N+1 을 청크당 쿼리 1회로 줄인다
/// (populate_snippets 배치 패턴, repo/search.rs 참고).
pub fn seen_guids(
    conn: &Connection,
    source_id: &str,
    guids: &[String],
) -> AppResult<std::collections::HashSet<String>> {
    let mut out = std::collections::HashSet::new();
    for chunk in guids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT guid FROM collect_seen WHERE source_id = ? AND guid IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let mut binds: Vec<&str> = Vec::with_capacity(chunk.len() + 1);
        binds.push(source_id);
        binds.extend(chunk.iter().map(String::as_str));
        let rows = stmt
            .query_map(rusqlite::params_from_iter(binds.iter()), |r| r.get::<_, String>(0))
            .map_err(dberr)?;
        for row in rows {
            out.insert(row.map_err(dberr)?);
        }
    }
    Ok(out)
}

/// Atomically claim an item for ingestion. The composite primary key makes this safe when a
/// background run and a manual run observe the same feed item at the same time: exactly one
/// caller receives `true` and is allowed to create the note.
pub fn claim_seen(conn: &Connection, source_id: &str, guid: &str) -> AppResult<bool> {
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO collect_seen(source_id, guid) VALUES (?1, ?2)",
            params![source_id, guid],
        )
        .map_err(dberr)?;
    Ok(inserted == 1)
}

/// Release a claim when note creation fails. A later run can then retry the item instead of
/// treating a failed insert as permanently seen. This is intentionally a narrow helper rather
/// than a general delete API so callers cannot accidentally remove another source's history.
pub fn release_seen_claim(conn: &Connection, source_id: &str, guid: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM collect_seen WHERE source_id = ?1 AND guid = ?2",
        params![source_id, guid],
    )
    .map_err(dberr)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', ?1)",
            params![now_iso()],
        )
        .unwrap();
        conn
    }

    #[test]
    fn create_list_set_enabled_delete_round_trip() {
        let mut conn = test_conn();
        let s = create(&conn, "ws1", "rss", "Example Feed", r#"{"url":"https://example.com/feed.xml"}"#).unwrap();
        assert!(s.enabled, "new sources start enabled (no editing UX — delete + re-add instead)");
        assert_eq!(s.last_run_at, None);

        let listed = list(&conn, "ws1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, s.id);

        set_enabled(&conn, &s.id, false).unwrap();
        assert!(!get(&conn, &s.id).unwrap().unwrap().enabled);

        claim_seen(&conn, &s.id, "guid-1").unwrap();
        assert!(is_seen(&conn, &s.id, "guid-1").unwrap());

        delete(&mut conn, &s.id).unwrap();
        assert!(get(&conn, &s.id).unwrap().is_none());
        assert!(!is_seen(&conn, &s.id, "guid-1").unwrap(), "collect_seen must be cleaned up on delete");
    }

    #[test]
    fn create_and_update_reject_unknown_post_process_values() {
        let conn = test_conn();
        let err = create_with_options(
            &conn,
            CreateCollectSourceParams {
                workspace_id: "ws1", kind: "rss", name: "A", config: "{}",
                dry_run: false, target_folder_id: None, post_process: "bogus", post_process_model: None,
                interval_minutes: None, show_in_briefing: true,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let s = create(&conn, "ws1", "rss", "B", "{}").unwrap();
        let err = update(&conn, &s.id, UpdateCollectSourceParams { post_process: Some("bogus"), ..Default::default() }).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // "summary" (new in this wave) and the pre-existing "none"/"suggest" must all pass.
        for allowed in ["none", "suggest", "summary"] {
            update(&conn, &s.id, UpdateCollectSourceParams { post_process: Some(allowed), ..Default::default() }).unwrap();
        }
    }

    #[test]
    fn show_in_briefing_defaults_on_and_update_none_keeps_it() {
        let conn = test_conn();
        let s = create(&conn, "ws1", "rss", "A", "{}").unwrap();
        assert!(s.show_in_briefing, "새 소스는 브리핑에 표시가 기본");
        let off = update(&conn, &s.id, UpdateCollectSourceParams { show_in_briefing: Some(false), ..Default::default() }).unwrap();
        assert!(!off.show_in_briefing);
        // 다른 필드만 고치는 update(show_in_briefing 생략) 는 값을 유지한다.
        let kept = update(&conn, &s.id, UpdateCollectSourceParams { name: Some("B"), ..Default::default() }).unwrap();
        assert!(!kept.show_in_briefing);
        assert!(!list(&conn, "ws1").unwrap()[0].show_in_briefing);
    }

    #[test]
    fn set_enabled_and_delete_reject_unknown_id() {
        let mut conn = test_conn();
        assert!(matches!(set_enabled(&conn, "nope", true), Err(AppError::NotFound(_))));
        assert!(matches!(delete(&mut conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn effective_interval_minutes_defaults_clamps_and_respects_config() {
        assert_eq!(effective_interval_minutes("{}"), DEFAULT_INTERVAL_MINUTES);
        assert_eq!(effective_interval_minutes("not json"), DEFAULT_INTERVAL_MINUTES);
        assert_eq!(effective_interval_minutes(r#"{"interval_minutes": 5}"#), MIN_INTERVAL_MINUTES, "must clamp below the floor");
        assert_eq!(effective_interval_minutes(r#"{"interval_minutes": 120}"#), 120);
    }

    #[test]
    fn is_due_true_when_never_run() {
        let s = CollectSource {
            id: "s".into(), workspace_id: "ws1".into(), kind: "rss".into(), name: "n".into(),
            config: "{}".into(), enabled: true, dry_run: false, show_in_briefing: true, target_folder_id: None,
            post_process: "none".into(), post_process_model: None, interval_minutes: None,
            last_run_at: None, last_status: None, last_error: None,
            created_at: now_iso(), updated_at: now_iso(),
        };
        assert!(is_due(&s, &now_iso(), &now_iso()));
    }

    #[test]
    fn is_due_false_just_after_running_true_once_interval_elapses() {
        let mut s = CollectSource {
            id: "s".into(), workspace_id: "ws1".into(), kind: "rss".into(), name: "n".into(),
            config: r#"{"interval_minutes": 30}"#.into(), enabled: true, dry_run: false, show_in_briefing: true, target_folder_id: None,
            post_process: "none".into(), post_process_model: None, interval_minutes: None,
            last_run_at: Some("2026-08-08T00:00:00.000Z".to_string()), last_status: Some("ok".into()), last_error: None,
            created_at: now_iso(), updated_at: now_iso(),
        };
        let boot_at = "2020-01-01T00:00:00.000Z"; // irrelevant here — not an ON_OPEN_SENTINEL source
        assert!(!is_due(&s, "2026-08-08T00:10:00.000Z", boot_at), "10min < 30min interval — not due yet");
        assert!(is_due(&s, "2026-08-08T00:30:00.000Z", boot_at), "exactly the interval — due");
        s.last_run_at = Some("2026-08-08T00:00:00.000Z".to_string());
        assert!(is_due(&s, "2026-08-08T01:00:00.000Z", boot_at), "well past the interval — due");
    }

    /// "창을 열 때"(ON_OPEN_SENTINEL=0) — 이번 부팅에서 아직 안 돌았으면 due, 이번 부팅 안에서
    /// 한 번 돌고 나면(last_run_at이 boot_at 이후) 같은 세션 동안은 다시 due가 되지 않는다.
    #[test]
    fn is_due_on_open_sentinel_fires_once_per_boot() {
        let boot_at = "2026-08-30T09:00:00.000Z";
        let mut s = CollectSource {
            id: "s".into(), workspace_id: "ws1".into(), kind: "rss".into(), name: "n".into(),
            config: "{}".into(), enabled: true, dry_run: false, show_in_briefing: true, target_folder_id: None,
            post_process: "none".into(), post_process_model: None,
            interval_minutes: Some(ON_OPEN_SENTINEL),
            last_run_at: None, last_status: None, last_error: None,
            created_at: now_iso(), updated_at: now_iso(),
        };
        assert!(is_due(&s, "2026-08-30T09:00:05.000Z", boot_at), "never run — due on boot");

        // Ran a moment before this boot (e.g. the previous session's on-open run) — stale, due again.
        s.last_run_at = Some("2026-08-29T12:00:00.000Z".to_string());
        assert!(is_due(&s, "2026-08-30T09:00:05.000Z", boot_at), "last run predates this boot — due");

        // Ran during THIS boot — must not fire again for the rest of the session, no matter how
        // much wall-clock time (or 60s ticks) pass.
        s.last_run_at = Some("2026-08-30T09:00:05.000Z".to_string());
        assert!(!is_due(&s, "2026-08-30T18:00:00.000Z", boot_at), "already ran this boot — quiet for the rest of the session");
    }

    #[test]
    fn is_due_true_immediately_when_last_status_is_partial_regardless_of_interval() {
        let s = CollectSource {
            id: "s".into(), workspace_id: "ws1".into(), kind: "browser_history".into(), name: "n".into(),
            config: "{}".into(), enabled: true, dry_run: false, show_in_briefing: true, target_folder_id: None,
            post_process: "none".into(), post_process_model: None, interval_minutes: Some(999_999),
            last_run_at: Some(now_iso()), last_status: Some("partial".into()), last_error: None,
            created_at: now_iso(), updated_at: now_iso(),
        };
        assert!(is_due(&s, &now_iso(), &now_iso()), "a partial run must be due immediately, ignoring the interval");
    }

    #[test]
    fn find_due_filters_disabled_and_not_yet_due_sources() {
        let conn = test_conn();
        let boot_at = now_iso();
        let due_never_run = create(&conn, "ws1", "rss", "A", "{}").unwrap();
        let due_soon = create(&conn, "ws1", "rss", "B", r#"{"interval_minutes":30}"#).unwrap();
        record_result(&conn, &due_soon.id, "ok", None).unwrap(); // last_run_at = now → not due yet
        let disabled = create(&conn, "ws1", "rss", "C", "{}").unwrap();
        set_enabled(&conn, &disabled.id, false).unwrap();

        let due = find_due(&conn, &now_iso(), &boot_at).unwrap();
        let due_ids: Vec<&str> = due.iter().map(|s| s.id.as_str()).collect();
        assert!(due_ids.contains(&due_never_run.id.as_str()));
        assert!(!due_ids.contains(&due_soon.id.as_str()), "just ran, interval not elapsed");
        assert!(!due_ids.contains(&disabled.id.as_str()), "disabled sources are never due");
    }

    #[test]
    fn create_and_update_preserve_the_on_open_sentinel_without_clamping_it_up() {
        let conn = test_conn();
        let s = create_with_options(
            &conn,
            CreateCollectSourceParams {
                workspace_id: "ws1", kind: "rss", name: "On-open", config: "{}",
                dry_run: false, target_folder_id: None, post_process: "none", post_process_model: None,
                interval_minutes: Some(ON_OPEN_SENTINEL), show_in_briefing: true,
            },
        )
        .unwrap();
        assert_eq!(s.interval_minutes, Some(ON_OPEN_SENTINEL), "0 must survive create, not clamp up to MIN_INTERVAL_MINUTES");

        let updated = update(
            &conn,
            &s.id,
            UpdateCollectSourceParams { interval_minutes: Some(Some(ON_OPEN_SENTINEL)), ..Default::default() },
        )
        .unwrap();
        assert_eq!(updated.interval_minutes, Some(ON_OPEN_SENTINEL));

        // A real interval value still clamps as before — the sentinel bypass is 0-only.
        let clamped = update(
            &conn,
            &s.id,
            UpdateCollectSourceParams { interval_minutes: Some(Some(5)), ..Default::default() },
        )
        .unwrap();
        assert_eq!(clamped.interval_minutes, Some(MIN_INTERVAL_MINUTES));
    }

    #[test]
    fn record_result_stores_status_and_error() {
        let conn = test_conn();
        let s = create(&conn, "ws1", "rss", "A", "{}").unwrap();
        record_result(&conn, &s.id, "error", Some("boom")).unwrap();
        let after = get(&conn, &s.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("error"));
        assert_eq!(after.last_error.as_deref(), Some("boom"));
        assert!(after.last_run_at.is_some());
    }

    #[test]
    fn seen_guids_returns_only_the_seen_subset_for_this_source() {
        let conn = test_conn();
        let source = create(&conn, "ws1", "rss", "A", "{}").unwrap();
        let other_source = create(&conn, "ws1", "rss", "B", "{}").unwrap();
        claim_seen(&conn, &source.id, "g1").unwrap();
        claim_seen(&conn, &source.id, "g2").unwrap();
        // Same guid claimed under a different source must not leak into this source's result.
        claim_seen(&conn, &other_source.id, "g3").unwrap();

        let requested = vec!["g1".to_string(), "g2".to_string(), "g3".to_string(), "g4".to_string()];
        let seen = seen_guids(&conn, &source.id, &requested).unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen.contains("g1"));
        assert!(seen.contains("g2"));
        assert!(!seen.contains("g3"), "guid seen under a different source must not match");
        assert!(!seen.contains("g4"), "never-claimed guid must not match");

        // Empty input must not error and must return an empty set (no chunks to iterate).
        assert!(seen_guids(&conn, &source.id, &[]).unwrap().is_empty());
    }

    #[test]
    fn claim_seen_is_atomic_and_only_the_first_claim_succeeds() {
        let conn = test_conn();
        let source = create(&conn, "ws1", "rss", "A", "{}").unwrap();

        assert!(claim_seen(&conn, &source.id, "guid-1").unwrap());
        assert!(!claim_seen(&conn, &source.id, "guid-1").unwrap());
        assert!(is_seen(&conn, &source.id, "guid-1").unwrap());

        release_seen_claim(&conn, &source.id, "guid-1").unwrap();
        assert!(!is_seen(&conn, &source.id, "guid-1").unwrap());
    }

    /// V96: 노트북 삭제(repo::workspaces::delete)가 그 노트북의 수집 소스와 seen 기록까지 지운다 —
    /// 예전엔 소스가 남아 러너가 없는 노트북으로 계속 수집했다. 실제 앱 연결(db::bootstrap → FK ON)로 확인.
    #[test]
    fn deleting_a_notebook_cascades_to_its_collect_sources_and_seen() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let gone = crate::repo::workspaces::create(&mut conn, "지울 노트북").unwrap();
        let keep_ws: String = conn
            .query_row("SELECT id FROM workspaces WHERE id <> ?1 LIMIT 1", params![gone.id], |r| r.get(0))
            .unwrap();
        let doomed = create(&conn, &gone.id, "rss", "Gone Feed", "{}").unwrap();
        let kept = create(&conn, &keep_ws, "rss", "Kept Feed", "{}").unwrap();
        claim_seen(&conn, &doomed.id, "g1").unwrap();
        claim_seen(&conn, &kept.id, "g1").unwrap();

        crate::repo::workspaces::delete(&mut conn, dir.path(), &gone.id).unwrap();

        assert!(get(&conn, &doomed.id).unwrap().is_none(), "source must die with its notebook");
        assert!(!is_seen(&conn, &doomed.id, "g1").unwrap(), "its seen rows must go too");
        assert!(get(&conn, &kept.id).unwrap().is_some(), "other notebooks' sources are untouched");
        assert!(is_seen(&conn, &kept.id, "g1").unwrap());
    }
}
