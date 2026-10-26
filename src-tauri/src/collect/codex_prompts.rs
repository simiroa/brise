// crate::collect::codex_prompts — OpenAI Codex CLI 세션 로그(kind='codex_prompts')에서 "사용자가
// 던진 프롬프트"만 뽑아 일자별 노트로 묶는 어댑터. claude_prompts.rs와 같은 자세(raw 전문 저장
// 안 함, user 메시지만 추출)지만 로그 레이아웃이 다르다:
//
// - 경로: `~/.codex/sessions/YYYY/MM/DD/rollout-<타임스탬프>-<uuid>.jsonl` — 날짜별 디렉터리라
//   claude_prompts처럼 "루트 바로 아래 첫 서브디렉터리 = 프로젝트"가 성립하지 않는다. 대신
//   각 세션 파일의 첫 줄(`type=="session_meta"`)이 `payload.cwd`로 작업 디렉터리를 실어온다 —
//   그 마지막 경로 성분을 프로젝트 이름으로 쓴다.
// - 관심 있는 줄: `type=="response_item"` 이고 `payload.type=="message"`, `payload.role=="user"`
//   인 것만. 같은 발화가 `type=="event_msg"`(payload.type=="user_message")로도 한 번 더 찍히지만
//   중복 표현이라 무시한다 — response_item이 정본.
// - 각 세션의 첫 response_item은 앱이 주입한 `<environment_context>...</environment_context>`
//   블록이다(사용자가 타이핑한 게 아님) — 노이즈로 걸러낸다.
use super::{config as source_config, mtime_local_date, sha256_hex16, skip_notice_part, CollectCtx, CollectedItem, CollectedPart};
use crate::error::AppResult;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// 세션 파일 하나의 크기 상한 — claude_prompts.rs와 동일 근거(로컬 파일, 네트워크 스트리밍
/// 상한보다 여유를 둠). 15개 파일이 옛 50MB 상한을 넘겼던 이 PC 실측(2026-09-05)에 맞춰 500MB로.
const MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;

/// 하루치 프롬프트 묶음 하나 — claude_prompts.rs::DayGroup과 같은 모양(§hygiene wave).
#[derive(Default)]
struct DayGroup {
    prompts: Vec<(String, String, String)>,
    skips: Vec<CollectedPart>,
}

/// 크기 초과/오픈 실패로 스킵된 파일의 프로젝트명 — Codex 는 cwd(=프로젝트명)를 파일 첫 줄
/// (session_meta)에서 읽는데, 그 파일 자체를 못 여니 알 수 없다. `project_name_from_cwd`의
/// "unknown" 폴백과 같은 이름을 재사용한다.
const UNKNOWN_PROJECT: &str = "unknown";

pub fn collect(config: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match source_config::parse("codex_prompts", config)? {
        source_config::SourceConfig::CodexPrompts(cfg) => cfg,
        _ => unreachable!("kind parser returned the wrong config"),
    };
    let dir = source_config::resolve_codex_sessions_dir(cfg.dir.as_deref())?;
    let project_filter = cfg
        .project
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // backfill_days 문턱 — claude_prompts.rs와 동일 근거(smoke-test defect C: 첫 실행이 코덱스
    // 세션 228개 day-note를 한 번에 인박스로 쏟았다).
    let backfill_cutoff_date = chrono::Local::now().date_naive() - chrono::Duration::days(cfg.backfill_days);
    let backfill_cutoff_ymd = backfill_cutoff_date.format("%Y-%m-%d").to_string();
    let backfill_cutoff_utc = Some(chrono::Utc::now() - chrono::Duration::days(cfg.backfill_days));

    // mtime 스킵 문턱 — claude_prompts.rs와 동일 근거(§2.1: seen이 이제 줄 단위라 오늘 세션을
    // 뺄 필요가 없어졌다, 이건 순전히 IO 절약). backfill_cutoff보다 오래된 파일도 같은 이유로
    // 건너뛴다 — 두 문턱 중 더 최근 쪽을 쓴다(OR 조건은 max와 동치, claude_prompts.rs 참고).
    let mtime_cutoff = {
        let since_cutoff = ctx
            .since
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc) - chrono::Duration::days(1));
        match (since_cutoff, backfill_cutoff_utc) {
            (Some(sc), Some(bc)) => Some(sc.max(bc)),
            (Some(sc), None) => Some(sc),
            (None, bc) => bc,
        }
    };

    // (project, date) -> 프롬프트 줄 + 스킵 안내
    let mut groups: BTreeMap<(String, String), DayGroup> = BTreeMap::new();

    for file in scan_jsonl_files(&dir) {
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            crate::diag::warn(
                "collect",
                "codex_session_file_oversized",
                format!("skipping session file ({} bytes)", meta.len()),
            );
            // cwd(=프로젝트명)는 파일 첫 줄(session_meta)에서 나오는데 그 파일을 못 여니 알 수
            // 없다 — project_name_from_cwd와 같은 "unknown" 폴백을 쓴다.
            if let Some(date) = mtime_local_date(&meta) {
                groups
                    .entry((UNKNOWN_PROJECT.to_string(), date.clone()))
                    .or_default()
                    .skips
                    .push(skip_notice_part("codex", UNKNOWN_PROJECT, &date, &file, meta.len()));
            }
            continue;
        }
        if let Some(cutoff) = mtime_cutoff {
            if let Ok(modified) = meta.modified() {
                if chrono::DateTime::<chrono::Utc>::from(modified) < cutoff {
                    continue;
                }
            }
        }
        let Ok(f) = std::fs::File::open(&file) else {
            crate::diag::warn("collect", "codex_session_file_open_failed", "failed to open session file");
            if let Some(date) = mtime_local_date(&meta) {
                groups
                    .entry((UNKNOWN_PROJECT.to_string(), date.clone()))
                    .or_default()
                    .skips
                    .push(skip_notice_part("codex", UNKNOWN_PROJECT, &date, &file, meta.len()));
            }
            continue;
        };
        let mut project: Option<String> = None;
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("session_meta") => {
                    project = v
                        .get("payload")
                        .and_then(|p| p.get("cwd"))
                        .and_then(|c| c.as_str())
                        .map(project_name_from_cwd);
                }
                Some("response_item") => {
                    let Some(project) = project.as_deref() else { continue }; // session_meta must come first
                    let Some((date, time, text, ts)) = extract_prompt(&v) else { continue };
                    if date < backfill_cutoff_ymd {
                        continue;
                    }
                    if is_noise(&text) {
                        continue;
                    }
                    if let Some(filter) = project_filter {
                        if !project.contains(filter) {
                            continue;
                        }
                    }
                    groups
                        .entry((project.to_string(), date))
                        .or_default()
                        .prompts
                        .push((time, super::one_line(&text, super::ITEM_BODY_MAX_CHARS), ts));
                }
                _ => {}
            }
        }
    }

    Ok(groups
        .into_iter()
        .map(|((project, date), group)| {
            let mut prompts = group.prompts;
            prompts.sort_by(|a, b| a.0.cmp(&b.0));
            // claude_prompts.rs와 같은 근거 — 같은 분 안에 초만 다른 동일 텍스트가 두 번 로그되면
            // 렌더된 줄이 완전히 똑같아진다(part guid는 타임스탬프가 섞여 달라서 seen만으로는
            // 못 거른다). 렌더된 줄이 그룹 안에서 이미 나왔으면 뒤엣것을 버린다.
            let mut seen_lines: std::collections::HashSet<String> = std::collections::HashSet::new();
            prompts.retain(|(time, text, _ts)| seen_lines.insert(format!("- {time} {text}")));
            let mut body_md = prompts
                .iter()
                .map(|(time, text, _ts)| format!("- {time} {text}"))
                .collect::<Vec<_>>()
                .join("\n");
            let mut parts: Vec<CollectedPart> = prompts
                .iter()
                .map(|(time, text, ts)| {
                    let line = format!("- {time} {text}");
                    let hash = sha256_hex16(&format!("{ts}{text}"));
                    CollectedPart {
                        guid: format!("codex:{project}:{date}:{hash}"),
                        line,
                        dedupe_needle: None,
                    }
                })
                .collect();
            for skip in &group.skips {
                if !body_md.is_empty() {
                    body_md.push('\n');
                }
                body_md.push_str(&skip.line);
            }
            parts.extend(group.skips);
            CollectedItem {
                guid: format!("codex:{project}:{date}"),
                title: format!("코덱스 프롬프트 — {project} {date}"),
                body_md,
                source_url: None,
                published_at: None,
                parts,
            }
        })
        .collect())
}

/// cwd의 마지막 경로 성분을 프로젝트 이름으로 — Windows(`\`)/POSIX(`/`) 구분자 둘 다 온다
/// (세션 로그가 어느 OS에서 만들어졌는지에 따라 다름).
fn project_name_from_cwd(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/// dir 아래 `*.jsonl`을 재귀적으로 찾는다. claude_prompts.rs와 동일한 심링크/재분석 가드 —
/// 각 진입점의 canonical 경로가 root 아래인지 재확인해 `~/.codex/sessions` 경계를 벗어나는
/// 임의 파일시스템 읽기를 막는다.
fn scan_jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let root = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut out = Vec::new();
    scan_dir_into(dir, &root, &mut out);
    out
}

fn scan_dir_into(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canonical.starts_with(root) {
            continue;
        }
        if metadata.is_dir() {
            scan_dir_into(&path, root, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// `response_item` 이벤트 하나 → (로컬 날짜 YYYY-MM-DD, 로컬 시각 HH:MM, 프롬프트 텍스트, 원본
/// 타임스탬프 — part guid 해시 입력용, claude_prompts.rs와 같은 근거). user 메시지가 아니거나
/// 텍스트/타임스탬프를 못 뽑으면 None.
fn extract_prompt(event: &serde_json::Value) -> Option<(String, String, String, String)> {
    let payload = event.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    if payload.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let text = extract_content_text(payload.get("content")?)?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let ts = event.get("timestamp").and_then(|t| t.as_str())?;
    let dt = chrono::DateTime::parse_from_rfc3339(ts)
        .ok()?
        .with_timezone(&chrono::Local);
    Some((
        dt.format("%Y-%m-%d").to_string(),
        dt.format("%H:%M").to_string(),
        text.to_string(),
        ts.to_string(),
    ))
}

/// content는 `[{type:"input_text", text:"..."}]` 배열 — 그 외 블록(function_call 등)은 무시.
fn extract_content_text(content: &serde_json::Value) -> Option<String> {
    let arr = content.as_array()?;
    let parts: Vec<&str> = arr
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("input_text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("\n"))
}

/// 세션 첫 response_item은 항상 앱이 주입한 environment_context 블록이다(사용자 타이핑 아님).
fn is_noise(text: &str) -> bool {
    text.trim_start().starts_with("<environment_context>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(rt: &tokio::runtime::Runtime) -> CollectCtx<'_> {
        CollectCtx { rt, data_dir: std::env::temp_dir(), since: None }
    }

    fn session_meta_line(cwd: &str) -> String {
        format!(r#"{{"timestamp":"2020-01-01T00:00:00.000Z","type":"session_meta","payload":{{"cwd":{}}}}}"#, serde_json::to_string(cwd).unwrap())
    }

    fn user_line(ts: &str, text: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn write_jsonl(dir: &Path, subpath: &str, lines: &[String]) {
        let file = dir.join(subpath);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, lines.join("\n")).unwrap();
    }

    fn yesterday_ts(hh_mm: &str) -> String {
        use chrono::TimeZone;
        let date = chrono::Local::now().date_naive() - chrono::Duration::days(1);
        let (h, m) = hh_mm.split_once(':').unwrap();
        let naive = date.and_hms_opt(h.parse().unwrap(), m.parse().unwrap(), 0).unwrap();
        chrono::Local
            .from_local_datetime(&naive)
            .unwrap()
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// `days_ago`일 전(로컬 기준) hh:mm:ss를 RFC3339(UTC) 타임스탬프로 — yesterday_ts와 같은
    /// 근거지만 초 단위와 임의 일수를 받는다(backfill_days 문턱·같은 분 중복 테스트용).
    fn days_ago_ts(days: i64, hh: u32, mm: u32, ss: u32) -> String {
        use chrono::TimeZone;
        let date = chrono::Local::now().date_naive() - chrono::Duration::days(days);
        let naive = date.and_hms_opt(hh, mm, ss).unwrap();
        chrono::Local
            .from_local_datetime(&naive)
            .unwrap()
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn yesterday_ymd() -> String {
        (chrono::Local::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let root = source_config::codex_sessions_root();
        std::fs::create_dir_all(&root).unwrap();
        let p = root.join(format!("brise-codex-prompts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    #[test]
    fn extracts_only_response_item_user_messages_and_derives_project_from_cwd() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/08/29/rollout-1.jsonl",
            &[
                session_meta_line(r"C:\Users\dev\Documents\brise"),
                r#"{"timestamp":"2020-01-01T00:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"ignored duplicate"}}"#.to_string(),
                user_line(&yesterday_ts("09:15"), "첫 번째 프롬프트"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(&format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()), &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].guid, format!("codex:brise:{}", yesterday_ymd()));
        assert!(items[0].body_md.contains("09:15 첫 번째 프롬프트"));
        assert!(!items[0].body_md.contains("ignored duplicate"), "event_msg echoes must not leak in");
    }

    #[test]
    fn filters_the_injected_environment_context_and_includes_today() {
        // PLAN-2026-09-04-local-import §2.1: seen is per-line (part.guid) now, so today's
        // still-growing session is no longer excluded (see the claude_prompts.rs twin test).
        let dir = tempdir();
        let today_ts = {
            use chrono::TimeZone;
            let naive = chrono::Local::now().date_naive().and_hms_opt(10, 0, 0).unwrap();
            chrono::Local.from_local_datetime(&naive).unwrap().with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        write_jsonl(
            dir.path(),
            "2026/08/29/rollout-1.jsonl",
            &[
                session_meta_line(r"C:\Users\dev\Documents\brise"),
                user_line(&yesterday_ts("09:00"), "<environment_context>\n  <cwd>x</cwd>\n</environment_context>"),
                user_line(&yesterday_ts("09:01"), "real prompt survives"),
                user_line(&today_ts, "today prompt now included"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(&format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()), &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 2, "yesterday and today are now two separate day-groups");
        let yesterday_item = items.iter().find(|i| i.body_md.contains("real prompt survives")).unwrap();
        assert_eq!(yesterday_item.body_md.trim(), "- 09:01 real prompt survives");
        assert!(items.iter().any(|i| i.body_md.contains("today prompt now included")));
    }

    /// PLAN-2026-09-04-local-import §2.2 — same mtime-skip IO optimization as claude_prompts.rs.
    #[test]
    fn skips_a_file_whose_mtime_predates_since_by_more_than_a_day() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/08/29/rollout-1.jsonl",
            &[session_meta_line(r"C:\Users\dev\Documents\brise"), user_line(&yesterday_ts("09:00"), "stale file prompt")],
        );
        let file = dir.path().join("2026/08/29/rollout-1.jsonl");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
        std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_modified(old).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let since = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let ctx_with_since = CollectCtx { rt: &rt, data_dir: std::env::temp_dir(), since: Some(since) };
        let items = collect(
            &format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()),
            &ctx_with_since,
        )
        .unwrap();
        assert!(items.is_empty(), "a file untouched since well before `since` must be skipped");
    }

    /// smoke-test defect C: the first-ever run dumped the whole session history (228 day-notes
    /// observed) into the inbox at once. backfill_days bounds it — default 14 excludes a 30-day-old
    /// prompt, widening the config includes it.
    #[test]
    fn backfill_days_excludes_old_prompts_by_default_and_includes_them_when_widened() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/01/01/rollout-1.jsonl",
            &[
                session_meta_line(r"C:\Users\dev\Documents\brise"),
                user_line(&days_ago_ts(30, 9, 0, 0), "prompt from 30 days ago"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let default_items = collect(
            &format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()),
            &ctx(&rt),
        )
        .unwrap();
        assert!(default_items.is_empty(), "default backfill_days=14 must exclude a 30-day-old prompt");

        let widened_items = collect(
            &format!(
                r#"{{"dir":{},"backfill_days":60}}"#,
                serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
            ),
            &ctx(&rt),
        )
        .unwrap();
        assert_eq!(widened_items.len(), 1);
        assert!(widened_items[0].body_md.contains("prompt from 30 days ago"));
    }

    /// smoke-test defect B: the same prompt text logged twice within the same minute (seconds
    /// differ, so part guids differ) must not render as two identical lines.
    #[test]
    fn duplicate_identical_prompts_within_the_same_minute_collapse_to_one_part() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/08/29/rollout-1.jsonl",
            &[
                session_meta_line(r"C:\Users\dev\Documents\brise"),
                user_line(&days_ago_ts(1, 9, 0, 0), "same text twice"),
                user_line(&days_ago_ts(1, 9, 0, 5), "same text twice"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(
            &format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts.len(), 1, "identical rendered lines within the same group must collapse to one part");
        assert_eq!(items[0].body_md.trim(), "- 09:00 same text twice");
    }

    #[test]
    fn project_filter_keeps_only_matching_cwd_derived_projects() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/08/29/a.jsonl",
            &[session_meta_line(r"C:\Users\dev\Documents\brise"), user_line(&yesterday_ts("08:00"), "brise prompt")],
        );
        write_jsonl(
            dir.path(),
            "2026/08/29/b.jsonl",
            &[session_meta_line(r"C:\Users\dev\Documents\other-repo"), user_line(&yesterday_ts("08:00"), "other prompt")],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let cfg = format!(r#"{{"dir":{},"project":"brise"}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap());
        let items = collect(&cfg, &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0].guid.starts_with("codex:brise:"));
    }

    /// 옛 50MB 상한이면 걸렸을 60MB 파일이 새 500MB 상한에서는 스킵되지 않는다 —
    /// claude_prompts.rs의 쌍둥이 테스트와 같은 근거·같은 기법(진짜 몇 줄 + set_len 패딩).
    #[test]
    fn a_file_up_to_the_new_500mb_cap_is_no_longer_skipped_wholesale() {
        let dir = tempdir();
        let content = vec![session_meta_line(r"C:\Users\dev\Documents\brise"), user_line(&yesterday_ts("08:00"), "large file prompt survives")];
        write_jsonl(dir.path(), "2026/08/29/rollout-1.jsonl", &content);
        let file_path = dir.path().join("2026/08/29/rollout-1.jsonl");
        {
            // write_jsonl doesn't add a trailing newline — without one, the zero-byte padding
            // below would run straight into the last JSON line, turning it into one unparseable
            // "line" (valid UTF-8 nulls, but garbage trailing a JSON value) instead of padding
            // that lands strictly after it.
            let mut f = std::fs::OpenOptions::new().append(true).open(&file_path).unwrap();
            use std::io::Write;
            f.write_all(b"\n").unwrap();
            drop(f);
            let f = std::fs::OpenOptions::new().write(true).open(&file_path).unwrap();
            f.set_len(60 * 1024 * 1024).unwrap();
        }

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(&format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()), &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0].body_md.contains("large file prompt survives"));
        assert!(!items[0].body_md.contains("건너뜀"));
    }

    /// 500MB를 넘는 codex 세션 파일은 프로젝트를 알 수 없으므로(cwd는 파일 안에 있다) "unknown"
    /// 프로젝트로 스킵 안내 part 하나가 남는다.
    #[test]
    fn a_file_over_the_new_cap_yields_exactly_one_skip_notice_part_under_unknown_project() {
        let dir = tempdir();
        let file_path = dir.path().join("2026").join("08").join("29").join("huge.jsonl");
        std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        {
            let f = std::fs::File::create(&file_path).unwrap();
            f.set_len(MAX_FILE_BYTES + 1).unwrap();
        }

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(&format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()), &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts.len(), 1);
        assert!(items[0].parts[0].guid.starts_with("codex:unknown:"));
        assert!(items[0].parts[0].guid.contains(":skipped:"));
        assert!(items[0].body_md.contains("건너뜀"));
    }

    #[test]
    fn response_items_before_session_meta_are_skipped_not_misattributed() {
        // Malformed/truncated log defense: without a cwd yet, a response_item must not silently
        // land under a fabricated "unknown" project bucket that mixes unrelated sessions.
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "2026/08/29/rollout-1.jsonl",
            &[user_line(&yesterday_ts("09:00"), "orphaned prompt, no session_meta yet")],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(&format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()), &ctx(&rt)).unwrap();
        assert!(items.is_empty());
    }
}
