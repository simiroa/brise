// crate::collect::claude_prompts — 클로드 CLI 세션 로그(kind='claude_prompts')에서 "사용자가
// 던진 프롬프트"만 뽑아 일자별 노트로 묶는 어댑터(P3 수집 관문 2단계,
// docs/PLAN-2026-08-07-second-brain.md Q6: "raw 전문 저장 안 함", 실제로는 어시스턴트 응답·도구
// 결과는 애초에 읽지도 않는다 — user 메시지만 추출).
//
// 대상 경로: `~/.claude/projects/<프로젝트 디렉터리>/<세션>.jsonl`, 각 줄이 독립 JSON 이벤트다
// (Claude Code의 세션 로그 포맷). 관심 있는 줄만: `type=="user"` 이고 `message.role=="user"`인
// 것 — content 는 문자열이거나 `[{type:"text", text:...}]` 배열(멀티파트 메시지)이다. 그 외
// 이벤트(type=assistant/도구 결과/큐 오퍼레이션 등)는 스키마를 안다고 가정하지 않고 그냥
// 건너뛴다.
use super::{config as source_config, mtime_local_date, sha256_hex16, skip_notice_part, CollectCtx, CollectedItem, CollectedPart};
use crate::error::AppResult;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// 세션 파일 하나의 크기 상한 — 네트워크가 아니라 로컬 파일이라 rss.rs의 스트리밍 상한(3MB)보다
/// 훨씬 여유를 둔다. 이 PC 실측(2026-09-05)에서 125MB/102MB/65MB 세션 파일이 옛 50MB 상한에
/// 통째로 걸려 조용히 사라졌다 — 500MB로 올리고, 그래도 넘거나 열 수 없는 파일은 조용히 사라지는
/// 대신 그 날짜 노트에 "(건너뜀)" 안내 줄을 남긴다(skip_notice_part, §hygiene wave).
const MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;

/// 하루치 프롬프트 묶음 하나 — 실제 프롬프트 줄과, 그 날짜에 걸쳐 스킵된 파일 안내 줄을 따로
/// 모았다가 조립 단계(§아래 `.map`)에서 합친다. `Default`는 두 필드 모두 빈 Vec.
#[derive(Default)]
struct DayGroup {
    prompts: Vec<(String, String, String)>,
    skips: Vec<CollectedPart>,
}

pub fn collect(config: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match source_config::parse("claude_prompts", config)? {
        source_config::SourceConfig::ClaudePrompts(cfg) => cfg,
        _ => unreachable!("kind parser returned the wrong config"),
    };
    let dir = source_config::resolve_claude_projects_dir(cfg.dir.as_deref())?;
    let project_filter = cfg
        .project
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // backfill_days 문턱 — 첫 실행이 ~/.claude/projects 전체(71개 day-note 관측)를 한 번에
    // 인박스로 쏟은 실기 결함의 수정. YYYY-MM-DD 문자열끼리 비교해도 사전식 순서 = 날짜 순서라
    // 별도 파싱 없이 비교 가능하다.
    let backfill_cutoff_date = chrono::Local::now().date_naive() - chrono::Duration::days(cfg.backfill_days);
    let backfill_cutoff_ymd = backfill_cutoff_date.format("%Y-%m-%d").to_string();
    // mtime 스킵용으로는 로컬 자정 정밀도가 필요 없다(순수 IO 최적화 — 정확한 경계는 위
    // backfill_cutoff_ymd 문자열 비교가 담당한다) — 그냥 "지금부터 backfill_days 전"이면 충분.
    let backfill_cutoff_utc = Some(chrono::Utc::now() - chrono::Duration::days(cfg.backfill_days));

    // mtime 스킵 문턱 — collect::ingest_item이 항목이 아니라 줄(part) 단위로 seen을 판정하므로
    // (PLAN-2026-09-04-local-import §2.1) 오늘 세션을 뺄 필요가 없어졌다: 오늘 늘어나는 줄도
    // 그때그때 새 part guid로 append된다. ctx.since보다 하루 더 오래된 파일만 건너뛴다 —
    // seen이 정본 판정이고 이건 순전히 IO 절약이다(파일이 그 이후로 안 바뀌었으면 이미 본
    // 줄들만 들어있을 것). backfill_cutoff보다 오래된 파일도 같은 이유로 건너뛴다(그 이후로
    // 안 바뀌었다면 안에 든 날짜도 전부 cutoff 이전일 수밖에 없다) — 두 문턱 중 더 최근 쪽을
    // 쓴다(OR 조건은 max와 동치). ponytail: since도 backfill도 없으면(있을 수 없음, backfill은
    // 항상 있다) 전체를 훑는다.
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
        let Some(project) = project_name_for(&dir, &file) else {
            continue;
        };
        if let Some(filter) = project_filter {
            if !project.contains(filter) {
                continue;
            }
        }
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            crate::diag::warn(
                "collect",
                "claude_session_file_oversized",
                format!("skipping session file ({} bytes)", meta.len()),
            );
            if let Some(date) = mtime_local_date(&meta) {
                groups
                    .entry((project.clone(), date.clone()))
                    .or_default()
                    .skips
                    .push(skip_notice_part("claude", &project, &date, &file, meta.len()));
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
            crate::diag::warn("collect", "claude_session_file_open_failed", "failed to open session file");
            if let Some(date) = mtime_local_date(&meta) {
                groups
                    .entry((project.clone(), date.clone()))
                    .or_default()
                    .skips
                    .push(skip_notice_part("claude", &project, &date, &file, meta.len()));
            }
            continue;
        };
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            let Some((date, time, text, ts)) = extract_prompt(&line) else {
                continue;
            };
            if date < backfill_cutoff_ymd {
                continue;
            }
            if is_noise(&text) {
                continue;
            }
            groups
                .entry((project.clone(), date))
                .or_default()
                .prompts
                .push((time, super::one_line(&text, super::ITEM_BODY_MAX_CHARS), ts));
        }
    }

    Ok(groups
        .into_iter()
        .map(|((project, date), group)| {
            let mut prompts = group.prompts;
            prompts.sort_by(|a, b| a.0.cmp(&b.0));
            // 같은 분 안에 초 단위만 다른 채로 같은 텍스트가 두 번 로그되면 렌더 결과("- HH:MM
            // text")가 완전히 똑같은 줄 두 개가 된다(part guid는 타임스탬프가 섞여 다르므로 seen
            // 만으로는 안 걸러진다) — 렌더된 줄이 그룹 안에서 이미 나왔으면 뒤엣것을 버린다.
            // body_md/parts 둘 다 이 뒤에서 만들어지므로 자동으로 일관된다.
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
                        guid: format!("claude:{project}:{date}:{hash}"),
                        line,
                        dedupe_needle: None,
                    }
                })
                .collect();
            // 스킵 안내 줄은 실제 프롬프트 뒤에 이어붙인다 — 시각 정렬 대상이 아니라 "이 날짜에서
            // 무언가 빠졌다"는 별도 신호다.
            for skip in &group.skips {
                if !body_md.is_empty() {
                    body_md.push('\n');
                }
                body_md.push_str(&skip.line);
            }
            parts.extend(group.skips);
            CollectedItem {
                guid: format!("claude:{project}:{date}"),
                title: format!("클로드 프롬프트 — {project} {date}"),
                body_md,
                source_url: None,
                published_at: None,
                parts,
            }
        })
        .collect())
}

/// dir 아래 `*.jsonl` 을 재귀적으로 찾는다.
/// ~/.claude/projects 트리를 읽지만, 심링크/재분석 지점은 건너뛰고 canonical 경로가 루트 아래인지
/// 재확인한다.
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
        // Do not follow symlinks/junctions: a link below ~/.claude/projects could otherwise turn
        // the bounded collector into an arbitrary filesystem reader. Canonicalize each entry as
        // a second boundary check for platforms where a directory reparse point is not reported
        // as a regular symlink by symlink_metadata.
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
            // Keep the original path spelling so project_name_for can derive the first relative
            // component from the configured root; the canonical form above was only a boundary
            // check.
            out.push(path);
        }
    }
}

/// `root` 바로 아래 첫 서브디렉터리 이름을 프로젝트 이름으로 쓴다(Claude Code의 실제 레이아웃:
/// `<root>/<프로젝트 디렉터리>/<세션>.jsonl`). root 바로 아래에 파일이 있으면(서브디렉터리 없음)
/// 프로젝트를 판단할 수 없으니 None — 그런 파일은 스킵.
fn project_name_for(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    let first = rel.components().next()?;
    if rel.components().count() < 2 {
        return None; // root 직속 파일 — 프로젝트 디렉터리가 없다
    }
    Some(first.as_os_str().to_string_lossy().into_owned())
}

/// 한 줄(JSON) → (로컬 날짜 YYYY-MM-DD, 로컬 시각 HH:MM, 프롬프트 텍스트, 원본 타임스탬프
/// 문자열 — part guid 해시 입력용, HH:MM보다 더 세밀해 같은 분 안 여러 프롬프트도 구분한다).
/// 방어적 파싱 — 못 읽는 줄, user 메시지가 아닌 줄, 텍스트를 못 뽑은 줄, 타임스탬프가 없는/파싱
/// 안 되는 줄은 전부 None.
fn extract_prompt(line: &str) -> Option<(String, String, String, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    let message = v.get("message")?;
    if message.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let text = extract_content_text(message.get("content")?)?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let ts = v.get("timestamp").and_then(|t| t.as_str())?;
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

/// content 는 문자열이거나 `[{type:"text", text:"..."}]` 배열(멀티파트) — 그 외 블록 타입
/// (tool_use/tool_result/image 등)은 무시한다. text 블록이 하나도 없으면 None(사용자가 실제로
/// 타이핑한 텍스트가 없는 메시지 — 프롬프트로 취급하지 않는다).
fn extract_content_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let arr = content.as_array()?;
    let parts: Vec<&str> = arr
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("\n"))
}

/// 명백한 비프롬프트 노이즈 라인 필터 — 단순 프리픽스/포함 검사 몇 개만(브리프 지시: "과도한
/// 휴리스틱 금지"). system-reminder 는 언급 자체는 무해할 수 있으니 100자 이상일 때만 걸러
/// 낸다(실제 system-reminder 삽입 블록은 항상 훨씬 길다).
fn is_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<command-name>")
        || t.contains("<local-command")
        || t.starts_with("[Request interrupted")
        // 백그라운드 작업 완료 통지 — 하네스가 user 역할로 주입하는 기계 메시지라 사용자가 친 게
        // 아니다(2026-09-05 실측: 가장 긴 "프롬프트" 노트가 통째로 이걸로 차 있었다).
        || t.starts_with("<task-notification>")
        || t.starts_with("<system-reminder>")
        || (text.len() >= 100 && text.contains("system-reminder"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 하네스 주입 메시지(<task-notification>, <system-reminder>)는 짧아도 노이즈다.
    #[test]
    fn harness_injected_messages_are_noise() {
        assert!(is_noise("<task-notification>
<task-id>abc</task-id>"));
        assert!(is_noise("  <system-reminder>short</system-reminder>"));
        assert!(!is_noise("내 프롬프트 — task-notification 얘기를 하는 진짜 문장"));
    }

    fn ctx(rt: &tokio::runtime::Runtime) -> CollectCtx<'_> {
        CollectCtx { rt, data_dir: std::env::temp_dir(), since: None }
    }

    fn write_jsonl(dir: &Path, project: &str, session: &str, lines: &[String]) {
        let proj_dir = dir.join(project);
        std::fs::create_dir_all(&proj_dir).unwrap();
        std::fs::write(proj_dir.join(format!("{session}.jsonl")), lines.join("\n")).unwrap();
    }

    fn user_line(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":{}}},"timestamp":"{ts}"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn user_line_array(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"text","text":{}}}]}},"timestamp":"{ts}"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// 어제 날짜(로컬 기준) hh:mm을 RFC3339(UTC) 타임스탬프로 — 실행 시점의 로컬 타임존 오프셋과
    /// 무관하게 코드가 되돌려 계산하는 로컬 HH:MM이 이 함수에 넘긴 hh_mm과 일치하도록, 로컬
    /// datetime을 먼저 만들고 그걸 UTC로 변환해서 직렬화한다(테스트 머신이 UTC가 아닐 수 있다 —
    /// 실제로 KST에서 "09:15 UTC"를 그대로 문자열로 박으면 로컬 변환 후 18:15가 되어 깨졌었다).
    fn yesterday_ts(hh_mm: &str) -> String {
        use chrono::TimeZone;
        let date = chrono::Local::now().date_naive() - chrono::Duration::days(1);
        let (h, m) = hh_mm.split_once(':').unwrap();
        let naive = date
            .and_hms_opt(h.parse().unwrap(), m.parse().unwrap(), 0)
            .unwrap();
        let local_dt = chrono::Local.from_local_datetime(&naive).unwrap();
        local_dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn yesterday_ymd() -> String {
        (chrono::Local::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string()
    }

    /// `days_ago`일 전(로컬 기준) hh:mm:ss를 RFC3339(UTC) 타임스탬프로 — yesterday_ts와 같은
    /// 근거지만 초 단위와 임의 일수를 받는다(backfill_days 문턱·같은 분 중복 테스트용).
    fn days_ago_ts(days: i64, hh: u32, mm: u32, ss: u32) -> String {
        use chrono::TimeZone;
        let date = chrono::Local::now().date_naive() - chrono::Duration::days(days);
        let naive = date.and_hms_opt(hh, mm, ss).unwrap();
        let local_dt = chrono::Local.from_local_datetime(&naive).unwrap();
        local_dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn extracts_only_user_messages_string_and_array_content() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "ProjA",
            "s1",
            &[
                r#"{"type":"assistant","message":{"role":"assistant","content":"ignored"},"timestamp":"2020-01-01T00:00:00.000Z"}"#.to_string(),
                r#"{"type":"queue-operation","operation":"enqueue"}"#.to_string(),
                user_line(&yesterday_ts("09:15"), "첫 번째 프롬프트"),
                user_line_array(&yesterday_ts("09:20"), "배열 형태 프롬프트"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let items = collect(
            &format!(
                r#"{{"dir":{}}}"#,
                serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
            ),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].guid, format!("claude:ProjA:{}", yesterday_ymd()));
        assert!(items[0].body_md.contains("09:15 첫 번째 프롬프트"));
        assert!(items[0].body_md.contains("09:20 배열 형태 프롬프트"));
        // Assistant/queue-operation lines never leak in.
        assert!(!items[0].body_md.contains("ignored"));
    }

    #[test]
    fn filters_noise_lines() {
        let dir = tempdir();
        let long_reminder = format!("<system-reminder>{}</system-reminder>", "x".repeat(120));
        write_jsonl(
            dir.path(),
            "ProjA",
            "s1",
            &[
                user_line(
                    &yesterday_ts("09:00"),
                    "<command-name>/model</command-name>",
                ),
                user_line(
                    &yesterday_ts("09:01"),
                    "<local-command-stdout>output</local-command-stdout>",
                ),
                user_line(&yesterday_ts("09:02"), "[Request interrupted by user]"),
                user_line(&yesterday_ts("09:03"), &long_reminder),
                user_line(&yesterday_ts("09:04"), "real prompt survives"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let items = collect(
            &format!(
                r#"{{"dir":{}}}"#,
                serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
            ),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].body_md.trim(), "- 09:04 real prompt survives");
    }

    #[test]
    fn groups_by_project_and_date_and_includes_today() {
        // PLAN-2026-09-04-local-import §2.1: seen is now tracked per prompt line (part.guid), not
        // per (project, date) item, so today's still-growing session no longer needs to be
        // excluded — each new line gets its own new part guid whenever it is re-fetched.
        let dir = tempdir();
        let today_ts = {
            use chrono::TimeZone;
            let naive = chrono::Local::now()
                .date_naive()
                .and_hms_opt(10, 0, 0)
                .unwrap();
            chrono::Local
                .from_local_datetime(&naive)
                .unwrap()
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        write_jsonl(
            dir.path(),
            "ProjA",
            "s1",
            &[
                user_line(&yesterday_ts("08:00"), "yesterday prompt"),
                user_line(&today_ts, "today prompt now included"),
            ],
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let items = collect(
            &format!(
                r#"{{"dir":{}}}"#,
                serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
            ),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 2, "yesterday and today are now two separate day-groups");
        let yesterday_item = items.iter().find(|i| i.body_md.contains("yesterday prompt")).unwrap();
        let today_item = items.iter().find(|i| i.body_md.contains("today prompt")).unwrap();
        assert_eq!(yesterday_item.parts.len(), 1);
        assert_eq!(today_item.parts.len(), 1);
        assert_ne!(today_item.guid, yesterday_item.guid);
    }

    /// PLAN-2026-09-04-local-import §2.2: a JSONL file whose mtime is older than `since` minus a
    /// day is skipped outright (IO optimization only — seen is still the correctness source of
    /// truth, this test only proves the file never even gets read).
    #[test]
    fn skips_a_file_whose_mtime_predates_since_by_more_than_a_day() {
        let dir = tempdir();
        write_jsonl(dir.path(), "ProjA", "s1", &[user_line(&yesterday_ts("08:00"), "stale file prompt")]);
        let file = dir.path().join("ProjA").join("s1.jsonl");
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

    /// smoke-test defect C: the first-ever run dumped the whole history (71 day-notes observed)
    /// into the inbox at once. backfill_days bounds it — default 14 excludes a 30-day-old prompt,
    /// widening the config includes it.
    #[test]
    fn backfill_days_excludes_old_prompts_by_default_and_includes_them_when_widened() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "ProjA",
            "s1",
            &[user_line(&days_ago_ts(30, 9, 0, 0), "prompt from 30 days ago")],
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
            "ProjA",
            "s1",
            &[
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
    fn project_filter_keeps_only_matching_project_dirs() {
        let dir = tempdir();
        write_jsonl(
            dir.path(),
            "brise",
            "s1",
            &[user_line(&yesterday_ts("08:00"), "brise prompt")],
        );
        write_jsonl(
            dir.path(),
            "other-repo",
            "s1",
            &[user_line(&yesterday_ts("08:00"), "other prompt")],
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let cfg = format!(
            r#"{{"dir":{},"project":"brise"}}"#,
            serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
        );
        let items = collect(&cfg, &ctx(&rt)).unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0].guid.starts_with("claude:brise:"));
    }

    #[test]
    fn prompts_longer_than_500_chars_are_preserved_until_the_item_cap() {
        let dir = tempdir();
        let long = "a".repeat(600);
        write_jsonl(
            dir.path(),
            "ProjA",
            "s1",
            &[user_line(&yesterday_ts("08:00"), &long)],
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let items = collect(
            &format!(
                r#"{{"dir":{}}}"#,
                serde_json::to_string(dir.path().to_str().unwrap()).unwrap()
            ),
            &ctx(&rt),
        )
        .unwrap();

        let body = &items[0].body_md;
        // The collector-level ITEM_BODY_MAX_CHARS cap remains the final safety boundary, but an
        // individual prompt must not be silently truncated before it reaches the grouped note.
        assert_eq!(body.trim_start_matches("- 08:00 ").chars().count(), 600);
    }

    /// 옛 50MB 상한이면 걸렸을 60MB 파일이 새 500MB 상한에서는 통째로 스킵되지 않고 안의 프롬프트가
    /// 그대로 파싱된다 — 실제 대용량 콘텐츠를 다 쓰는 대신 진짜 몇 줄 뒤에 `set_len`으로 널 바이트를
    /// 패딩해 파일 크기만 부풀린다(라인 파서가 파싱 실패 줄을 그냥 건너뛰므로 트레일링 널 바이트가
    /// 안전하다 — BufRead::lines()가 잘못된 UTF-8을 만나면 그 지점에서 멈추지만, 그 전의 유효한
    /// 줄들은 이미 처리된 뒤다).
    #[test]
    fn a_file_up_to_the_new_500mb_cap_is_no_longer_skipped_wholesale() {
        let dir = tempdir();
        let proj_dir = dir.path().join("ProjA");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let file_path = proj_dir.join("s1.jsonl");
        std::fs::write(&file_path, user_line(&yesterday_ts("08:00"), "large file prompt survives") + "\n").unwrap();
        {
            let f = std::fs::OpenOptions::new().write(true).open(&file_path).unwrap();
            f.set_len(60 * 1024 * 1024).unwrap(); // pad past the OLD 50MB cap with zero bytes
        }

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(
            &format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0].body_md.contains("large file prompt survives"));
        assert!(!items[0].body_md.contains("건너뜀"), "60MB is well under the new 500MB cap — must not be skipped");
    }

    /// 500MB 를 넘는 파일은 여전히 통째로 스킵되지만, 이제 조용히 사라지는 대신 그 날짜 노트에
    /// "(건너뜀)" 안내 part 하나가 남는다.
    #[test]
    fn a_file_over_the_new_cap_yields_exactly_one_skip_notice_part() {
        let dir = tempdir();
        let proj_dir = dir.path().join("ProjA");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let file_path = proj_dir.join("huge.jsonl");
        {
            let f = std::fs::File::create(&file_path).unwrap();
            f.set_len(MAX_FILE_BYTES + 1).unwrap();
        }

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect(
            &format!(r#"{{"dir":{}}}"#, serde_json::to_string(dir.path().to_str().unwrap()).unwrap()),
            &ctx(&rt),
        )
        .unwrap();

        assert_eq!(items.len(), 1, "one day-note for today's mtime-derived date");
        assert_eq!(items[0].parts.len(), 1);
        assert!(items[0].parts[0].guid.starts_with("claude:ProjA:"));
        assert!(items[0].parts[0].guid.contains(":skipped:"));
        assert!(items[0].body_md.contains("건너뜀"));
        assert!(items[0].body_md.contains("501MB") || items[0].body_md.contains("500MB"));
    }

    /// Claude projects 허용 루트 아래에 유니크한 하위 폴더를 만들어 정리한다.  실제 어댑터와
    /// 동일한 경로 가드(`~/.claude/projects` 밖은 거부)를 통과시키면서 테스트가 사용자 파일을
    /// 건드리지 않도록 각 테스트 전용 폴더만 삭제한다.
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
        let root = source_config::claude_projects_root();
        std::fs::create_dir_all(&root).unwrap();
        let p = root.join(format!(
            "brise-claude-prompts-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
