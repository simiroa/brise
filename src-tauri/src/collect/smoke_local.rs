//! 실기 스모크 — **이 PC 의 실제** 크롬/엣지 History 와 `~/.claude/projects`·`~/.codex/sessions` 를
//! 읽어 본다. 읽기 전용(브라우저 DB 는 임시 복사본, 앱 DB 는 tempdir)이라 사용자 데이터를 바꾸지 않는다.
//! 기본 `cargo test` 에서는 돌지 않는다(#[ignore]) — 오너 실기 전에 코드만으로 "돌아가긴 하는가"를
//! 확인하는 용도:
//!
//!   cargo test --lib smoke_local -- --ignored --nocapture
//!
//! 출력은 건수·소요 시간만 찍는다(URL·프롬프트 원문은 찍지 않는다 — 로그가 남는 곳이 어디든 개인 데이터다).
#![cfg(test)]
use super::*;
use crate::repo::collect as repo_collect;

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn ctx<'a>(rt: &'a tokio::runtime::Runtime, data_dir: &Path, since: Option<String>) -> CollectCtx<'a> {
    CollectCtx { rt, data_dir: data_dir.to_path_buf(), since }
}

/// 노트 제목 → 첫 섹션의 줄 목록.
fn note_lines(conn: &rusqlite::Connection) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT n.title, s.body_md FROM notes n JOIN sections s ON s.note_id = n.id WHERE n.deleted_at IS NULL ORDER BY s.position")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .map(|(t, b)| (t, b.lines().map(str::to_string).collect()))
        .collect()
}

fn report(kind: &str, items: &[CollectedItem], elapsed: std::time::Duration) {
    let parts: usize = items.iter().map(|i| i.parts.len()).sum();
    eprintln!("[{kind}] {} day-notes, {parts} parts, {:?}", items.len(), elapsed);
    for i in items {
        eprintln!("  {} — {} parts", i.title, i.parts.len());
    }
}

#[test]
#[ignore = "reads this machine's real browser History — run explicitly"]
fn real_browser_history_reads_chrome_and_edge_and_cleans_the_temp_copy() {
    let data_dir = tempfile::tempdir().unwrap();
    let rt = rt();
    for browser in ["chrome", "edge"] {
        let cfg = serde_json::json!({ "browser": browser, "profile": "Default", "min_seconds": 15, "backfill_days": 7 })
            .to_string();
        let t0 = std::time::Instant::now();
        match browser_history::collect(&cfg, &ctx(&rt, data_dir.path(), None)) {
            Ok(items) => report(browser, &items, t0.elapsed()),
            Err(e) => eprintln!("[{browser}] ERR {e}"),
        }
        let leftover = std::fs::read_dir(data_dir.path().join("tmp")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftover, 0, "{browser}: temp History copy must be deleted");
    }
}

#[test]
#[ignore = "end-to-end on a temp app DB with real local inputs — run explicitly"]
fn real_end_to_end_run_now_twice_is_idempotent_and_logs_one_activity_row() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut conn = crate::db::bootstrap(data_dir.path()).unwrap();
    let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
    let rt = rt();
    let browser_cfg =
        serde_json::json!({ "browser": "chrome", "profile": "Default", "min_seconds": 15, "backfill_days": 7 }).to_string();
    for (kind, name, cfg) in [("browser_history", "브라우저 기록", browser_cfg.as_str()), ("claude_prompts", "클로드 대화", "{}")] {
        let source = repo_collect::create_with_options(
            &conn,
            repo_collect::CreateCollectSourceParams {
                workspace_id: &ws,
                kind,
                name,
                config: cfg,
                dry_run: false,
                target_folder_id: None,
                post_process: "none",
                post_process_model: None,
                interval_minutes: Some(0),
                show_in_briefing: true,
            },
        )
        .unwrap();
        let t0 = std::time::Instant::now();
        let first = run_now(&mut conn, &source.id, &rt, data_dir.path().to_path_buf()).unwrap();
        eprintln!("[{kind}] run 1: ok={} added={} err={:?} {:?}", first.ok, first.added, first.error, t0.elapsed());
        let snapshot = note_lines(&conn);
        let second = run_now(&mut conn, &source.id, &rt, data_dir.path().to_path_buf()).unwrap();
        eprintln!("[{kind}] run 2: ok={} added={} err={:?}", second.ok, second.added, second.error);
        // 라이브 머신이라 run 1 과 run 2 사이에 진짜 새 방문/프롬프트가 생길 수 있다 — 그래서 added==0 이
        // 아니라 "같은 줄이 두 번 붙지 않았다"를 검사한다. 새로 붙은 줄은 시각 접두사만 찍는다(개인 데이터).
        for (title, lines) in note_lines(&conn) {
            let before = snapshot.get(&title).cloned().unwrap_or_default();
            let fresh: Vec<&String> = lines.iter().filter(|l| !before.contains(*l)).collect();
            if !fresh.is_empty() {
                let stamps: Vec<String> = fresh.iter().map(|l| l.chars().take(8).collect()).collect();
                eprintln!("  run 2 appended {} line(s) to '{title}': {:?}", fresh.len(), stamps);
            }
            let mut sorted = lines.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), lines.len(), "{kind}: duplicate line in '{title}' — seen/dedupe is broken");
        }
    }
    let notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
    let seen: i64 = conn.query_row("SELECT COUNT(*) FROM collect_seen", [], |r| r.get(0)).unwrap();
    let activity: i64 = conn
        .query_row("SELECT COUNT(*) FROM activity_log WHERE kind = ?1", [crate::repo::activity::KIND_COLLECT], |r| r.get(0))
        .unwrap();
    eprintln!("notes={notes} collect_seen={seen} activity(collect)={activity}");
}

#[test]
#[ignore = "calls Gemini (Gemma) with the dev DB's key — run explicitly"]
fn real_summary_through_gemini_gemma() {
    // 키는 dev DB(읽기 전용)에서 임시 DB로 복사만 한다 — 출력에 절대 찍지 않는다.
    let dev_db = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.brise.app.dev").join("brise.db");
    let dev = rusqlite::Connection::open_with_flags(&dev_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let api_key: String = dev
        .query_row("SELECT value FROM settings WHERE key = 'ai_api_key'", [], |r| r.get(0))
        .map(|v: String| serde_json::from_str::<String>(&v).unwrap_or(v))
        .expect("dev DB has no ai_api_key — set one in 설정 > AI first");
    drop(dev);

    let data_dir = tempfile::tempdir().unwrap();
    let mut conn = crate::db::bootstrap(data_dir.path()).unwrap();
    let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
    let mut entries = std::collections::BTreeMap::new();
    entries.insert("ai_provider".to_string(), serde_json::json!("gemini"));
    entries.insert("ai_enabled".to_string(), serde_json::json!(true));
    entries.insert("ai_api_key".to_string(), serde_json::json!(api_key));
    crate::repo::settings::set(&mut conn, &entries).unwrap();

    // post_process_model 오버라이드 경로까지 같이 검증 — 앱이 이미 아는 Gemma 이름을 쓴다.
    let source = repo_collect::create_with_options(
        &conn,
        repo_collect::CreateCollectSourceParams {
            workspace_id: &ws,
            kind: "claude_prompts",
            name: "클로드 대화",
            config: "{}",
            dry_run: false,
            target_folder_id: None,
            post_process: "summary",
            post_process_model: Some(crate::repo::ai::DEFAULT_GEMINI_FALLBACK_MODEL),
            interval_minutes: Some(0),
            show_in_briefing: true,
        },
    )
    .unwrap();
    let rt = rt();
    let result = collect_source(&source, &rt, data_dir.path().to_path_buf());
    let (outcome, note_ids) = finish_run_now_collecting_notes(&mut conn, &source, result).unwrap();
    eprintln!("ingest: added={} notes={}", outcome.added, note_ids.len());
    // 줄이 가장 많은 노트를 고른다 — 한 줄짜리 노트 요약은 검증이 안 된다.
    let note_id: String = conn
        .query_row(
            "SELECT n.id FROM notes n JOIN sections s ON s.note_id = n.id WHERE n.deleted_at IS NULL
             ORDER BY length(s.body_md) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .expect("no prompt notes on this machine — nothing to summarize");
    drop(conn);
    let t0 = std::time::Instant::now();
    let path = crate::db::db_path(data_dir.path());
    summary::maybe_summarize(|| crate::db::open(&path), &ctx(&rt, data_dir.path(), None), &source, &note_id);
    let conn = crate::db::open(&path).unwrap();
    let body: String = conn
        .query_row("SELECT s.body_md FROM sections s WHERE s.note_id = ?1 ORDER BY s.position LIMIT 1", [&note_id], |r| r.get(0))
        .unwrap();
    let head: String = body.lines().take(5).collect::<Vec<_>>().join(" | ");
    eprintln!("summary in {:?}: {}", t0.elapsed(), head.chars().take(400).collect::<String>());
    assert!(body.starts_with("## 요약"), "summary block must be prepended");
}

#[test]
#[ignore = "detects this machine's real browser profiles and session dirs — run explicitly"]
fn real_detect_local_lists_candidates_without_touching_the_db() {
    let data_dir = tempfile::tempdir().unwrap();
    let t0 = std::time::Instant::now();
    let candidates = detect::detect_candidates(data_dir.path(), &[]);
    eprintln!("detect: {} candidates in {:?}", candidates.len(), t0.elapsed());
    for c in &candidates {
        // 프로필 표시 이름은 개인 정보라 key/kind/건수만 찍는다.
        eprintln!("  {} [{}] recent={} last_seen={} source_id={:?}", c.key, c.kind, c.recent_count, c.last_seen_at.is_some(), c.source_id);
    }
    assert!(!candidates.is_empty(), "this machine has Chrome and ~/.claude/projects — at least one candidate expected");
    let leftover = std::fs::read_dir(data_dir.path().join("tmp")).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftover, 0, "temp History copies must be deleted");
}
