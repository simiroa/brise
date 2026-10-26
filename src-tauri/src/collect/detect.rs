// crate::collect::detect — 로컬 소스 감지 + 1클릭 가져오기(PLAN-2026-09-04-local-import.md §W7).
// commands::collect::{collect_detect_local, collect_import_local}이 이 모듈을 쓴다.
//
// 크롬/엣지는 browser_history.rs의 임시 복사 헬퍼를 재사용해 프로필별 History를 살짝 들여다보고
// (최근 7일·15초 이상 방문 수), 클로드/코덱스는 세션 로그 파일을 얕게 스캔한다(mtime 14일 이내
// 파일만 열어보고, 최대 200개까지만 — `~/.claude/projects`가 1.2GB까지 자랄 수 있어 전체 파싱은
// 하지 않는다, claude_prompts.rs의 backfill/mtime 스킵과 같은 절약 철학). 여기는 순수 탐지/조립
// 로직만 — collect_detect_local이 이미 조회해 둔 기존 소스 목록(`existing`)을 받아 이 파일
// 안에서 매칭하고, DB conn은 import 시 폴더 생성/소스 저장에만 필요하다(그것도
// `import_local_source`가 캡슐화 — 커맨드 레이어는 얇은 래퍼).
use super::browser_history;
use super::config::{self as source_config, BrowserHistoryConfig, SourceConfig};
use crate::error::{AppError, AppResult};
use crate::repo::collect::{self as repo_collect, CollectSource, CreateCollectSourceParams};
use chrono::TimeZone;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// 프롬프트 어댑터(claude_prompts.rs/codex_prompts.rs)의 기본 backfill_days와 같은 창 — "최근
/// 14일에 이 정도 쌓여 있다"는 미리보기 숫자를 실제 가져오기 기본값과 맞춘다.
const PROMPT_DETECT_BACKFILL_DAYS: i64 = 14;
/// 1.2GB짜리 `~/.claude/projects` 전체를 열어보지 않기 위한 상한(브리프 지시) — mtime이
/// 최근인 파일부터가 아니라 디렉터리 순회 순서대로 처음 만난 200개. 넘는 만큼은 detail
/// 숫자에서 과소집계될 수 있지만, 이건 미리보기일 뿐 실제 가져오기(claude_prompts::collect)는
/// 이 상한의 적용을 받지 않는다.
const PROMPT_DETECT_FILE_CAP: usize = 200;
/// browser_history 어댑터의 기본 config(min_seconds=15, backfill_days=7)와 같은 창 — detail의
/// "최근 7일 N건"이 실제 가져오기 기본값 미리보기가 되게 한다.
const BROWSER_RECENT_DAYS: i64 = 7;
const BROWSER_MIN_SECONDS: i64 = 15;

pub const PROMPTS_FOLDER_NAME: &str = "수집 — AI 대화";
pub const BROWSING_FOLDER_NAME: &str = "수집 — 브라우징";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LocalCandidate {
    pub key: String,
    pub kind: String,
    pub label: String,
    pub detail: String,
    pub recent_count: i64,
    pub last_seen_at: Option<String>,
    pub source_id: Option<String>,
    pub config: String,
}

fn iso(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 순서 계약(commands/collect.yaml): 크롬 프로필(Default 먼저, 그다음 디렉터리명순) → 엣지
/// 프로필 → 클로드 → 코덱스. 크롬/엣지가 없으면(비Windows, LOCALAPPDATA 없음, User Data 없음)
/// 그냥 빈 목록 — 에러로 전체 감지를 막지 않는다.
pub fn detect_candidates(data_dir: &Path, existing: &[CollectSource]) -> Vec<LocalCandidate> {
    let mut out = Vec::new();
    for browser in ["chrome", "edge", "brave", "vivaldi", "whale"] {
        out.extend(detect_browser_candidates(browser, data_dir, existing));
    }
    if let Some(c) = detect_prompts_candidate("claude_prompts", &source_config::claude_projects_root(), "클로드 대화", existing) {
        out.push(c);
    }
    if let Some(c) = detect_prompts_candidate("codex_prompts", &source_config::codex_sessions_root(), "코덱스 대화", existing) {
        out.push(c);
    }
    out
}

// ── 브라우저 프로필 ──────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn detect_browser_candidates(browser: &str, data_dir: &Path, existing: &[CollectSource]) -> Vec<LocalCandidate> {
    let Ok(user_data_dir) = browser_history::user_data_dir(browser) else {
        return Vec::new();
    };
    browser_candidates_from_user_data_dir(browser, &user_data_dir, data_dir, existing)
}

#[cfg(not(windows))]
fn detect_browser_candidates(_browser: &str, _data_dir: &Path, _existing: &[CollectSource]) -> Vec<LocalCandidate> {
    Vec::new() // browser_history 어댑터 자체가 Windows 전용(browser_history::collect).
}

/// `user_data_dir`을 명시로 받는 순수 함수 — 테스트가 LOCALAPPDATA를 건드리지 않고 tempdir로
/// 직접 부른다(browser_history.rs::collect_from_path와 같은 자세).
fn browser_candidates_from_user_data_dir(
    browser: &str,
    user_data_dir: &Path,
    data_dir: &Path,
    existing: &[CollectSource],
) -> Vec<LocalCandidate> {
    let display_names = read_profile_display_names(user_data_dir);
    let mut out = Vec::new();
    for profile_dir in discover_profile_dirs(user_data_dir) {
        let history_path = user_data_dir.join(&profile_dir).join("History");
        let (recent_count, last_seen) = browser_recent_stats(&history_path, data_dir).unwrap_or((0, None));
        let cfg = BrowserHistoryConfig {
            browser: browser.to_string(),
            profile: profile_dir.clone(),
            min_seconds: BROWSER_MIN_SECONDS,
            backfill_days: BROWSER_RECENT_DAYS,
            prompt: None,
        };
        let config = serde_json::to_string(&cfg).unwrap_or_else(|_| "{}".to_string());
        let brand = browser_brand(browser);
        let display = display_names.get(&profile_dir).cloned().unwrap_or_else(|| profile_dir.clone());
        let detail = match last_seen {
            Some(dt) => format!("최근 {BROWSER_RECENT_DAYS}일 {recent_count}건 · 마지막 {}", relative_or_date(dt)),
            None => format!("최근 {BROWSER_RECENT_DAYS}일 {recent_count}건"),
        };
        out.push(LocalCandidate {
            key: format!("{browser}:{profile_dir}"),
            kind: "browser_history".to_string(),
            label: format!("{brand} · {display}"),
            detail,
            recent_count,
            last_seen_at: last_seen.map(iso),
            source_id: find_matching_browser_source(existing, browser, &profile_dir),
            config,
        });
    }
    out
}

/// browser 코드 → 표시 브랜드명 — 감지 라벨(`browser_candidates_from_user_data_dir`)과 1클릭
/// 가져오기 이름(`browser_label`)이 공유한다.
fn browser_brand(browser: &str) -> &'static str {
    match browser {
        "edge" => "엣지",
        "brave" => "브레이브",
        "vivaldi" => "비발디",
        "whale" => "웨일",
        _ => "크롬",
    }
}

/// `History` 파일이 있는 `user_data_dir` 바로 아래 디렉터리들 — Default 먼저, 그다음
/// 디렉터리명 사전순(계약: commands/collect.yaml). History가 없는 프로필(방문 기록 없이 막
/// 만든 프로필 등)은 후보에서 제외.
fn discover_profile_dirs(user_data_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(user_data_dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| e.path().join("History").exists())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    dirs.sort_by(|a, b| match (a == "Default", b == "Default") {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.cmp(b),
    });
    dirs
}

/// `Local State`(JSON) → `profile.info_cache.<dir>.name`. 파일이 없거나 파싱이 안 되면 빈
/// 맵(호출부가 디렉터리명으로 폴백한다).
fn read_profile_display_names(user_data_dir: &Path) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(user_data_dir.join("Local State")) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashMap::new();
    };
    let Some(cache) = value.get("profile").and_then(|p| p.get("info_cache")).and_then(|c| c.as_object()) else {
        return HashMap::new();
    };
    cache
        .iter()
        .filter_map(|(dir, info)| {
            let name = info.get("name").and_then(|n| n.as_str())?;
            Some((dir.clone(), name.to_string()))
        })
        .collect()
}

/// 최근 `BROWSER_RECENT_DAYS`일·`BROWSER_MIN_SECONDS`초 이상 방문 수와 그중 가장 최근 시각 —
/// browser_history::collect_from_path의 질의를 미리보기 창(7일/15초 고정)으로 단순화한 것.
/// 검색결과/스킴 필터는 적용하지 않는다(미리보기 근사치 — 실제 가져오기 때 정확한 값이 나온다,
/// ponytail: 두 벌 유지 비용 대비 이득이 없다).
fn browser_recent_stats(history_path: &Path, data_dir: &Path) -> AppResult<(i64, Option<chrono::DateTime<chrono::Utc>>)> {
    let temp = browser_history::open_temp_readonly_copy(history_path, data_dir)?;
    let conn = &temp.conn;
    let lower_bound = chrono::Utc::now() - chrono::Duration::days(BROWSER_RECENT_DAYS);
    let lower_bound_chrome = browser_history::chrome_time_from_unix_seconds(lower_bound.timestamp());
    let min_duration_us = BROWSER_MIN_SECONDS * 1_000_000;
    let (count, max_time): (i64, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*), MAX(v.visit_time) FROM visits v JOIN urls u ON u.id = v.url
             WHERE u.hidden = 0 AND v.visit_duration >= ?1 AND v.visit_time > ?2",
            rusqlite::params![min_duration_us, lower_bound_chrome],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(crate::error::db)?;
    let last_seen = max_time.and_then(|t| {
        let secs = browser_history::unix_seconds_from_chrome_time(t);
        chrono::Utc.timestamp_opt(secs, 0).single()
    });
    Ok((count, last_seen))
}

/// "오늘 HH:MM"/"어제"/"N일 전"/그 이전은 날짜 — detail 문자열은 프런트가 그대로 렌더하는 순수
/// 텍스트이므로(계약: `detail`은 "plain string; the frontend just renders it") 서식은 여기서
/// 자유롭게 정한다.
fn relative_or_date(dt: chrono::DateTime<chrono::Utc>) -> String {
    let local = dt.with_timezone(&chrono::Local);
    let now = chrono::Local::now();
    let days = (now.date_naive() - local.date_naive()).num_days();
    match days {
        0 => format!("오늘 {}", local.format("%H:%M")),
        1 => "어제".to_string(),
        d if (2..7).contains(&d) => format!("{d}일 전"),
        _ => local.format("%Y-%m-%d").to_string(),
    }
}

fn find_matching_browser_source(existing: &[CollectSource], browser: &str, profile: &str) -> Option<String> {
    existing
        .iter()
        .find(|s| {
            s.kind == "browser_history"
                && matches!(
                    source_config::parse("browser_history", &s.config),
                    Ok(SourceConfig::BrowserHistory(cfg)) if cfg.browser == browser && cfg.profile == profile
                )
        })
        .map(|s| s.id.clone())
}

// ── 클로드/코덱스 프롬프트 ───────────────────────────────────────────────────────────────────

fn detect_prompts_candidate(kind: &str, root: &Path, label: &str, existing: &[CollectSource]) -> Option<LocalCandidate> {
    if !root.exists() {
        return None;
    }
    let (project_count, prompt_count, last_seen) = if kind == "claude_prompts" {
        scan_claude_root(root)
    } else {
        scan_codex_root(root)
    };
    Some(LocalCandidate {
        key: kind.to_string(),
        kind: kind.to_string(),
        label: label.to_string(),
        detail: format!("{project_count} 프로젝트 · 최근 {PROMPT_DETECT_BACKFILL_DAYS}일 {prompt_count}건"),
        recent_count: prompt_count,
        last_seen_at: last_seen.map(iso),
        source_id: find_matching_kind_source(existing, kind),
        config: "{}".to_string(),
    })
}

fn find_matching_kind_source(existing: &[CollectSource], kind: &str) -> Option<String> {
    existing.iter().find(|s| s.kind == kind).map(|s| s.id.clone())
}

/// `dir` 아래 `*.jsonl`을 재귀적으로 찾되(심링크는 건너뜀), `cap`개를 채우면 즉시 멈춘다 — 전체
/// 트리 크기와 무관하게 이 함수의 비용은 `cap`으로 상한이 잡힌다.
fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            return;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_jsonl_files(&path, out, cap);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn is_within_last_days(meta: &std::fs::Metadata, days: i64) -> bool {
    let Ok(modified) = meta.modified() else { return false };
    let modified_utc: chrono::DateTime<chrono::Utc> = modified.into();
    modified_utc >= chrono::Utc::now() - chrono::Duration::days(days)
}

/// `<root>/<project>/<세션>.jsonl` 레이아웃(claude_prompts.rs) — 프로젝트 수는 jsonl이 하나라도
/// 있는 1단계 서브디렉터리 전체(전체 히스토리 기준), 프롬프트 수/최근 시각은 mtime이 14일
/// 이내인 파일만(최대 200개) 열어 센다.
fn scan_claude_root(root: &Path) -> (usize, i64, Option<chrono::DateTime<chrono::Utc>>) {
    let mut projects = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let has_jsonl = std::fs::read_dir(&path)
                .map(|it| it.flatten().any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")))
                .unwrap_or(false);
            if has_jsonl {
                if let Some(name) = entry.file_name().to_str() {
                    projects.insert(name.to_string());
                }
            }
        }
    }

    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files, PROMPT_DETECT_FILE_CAP);
    let mut prompt_count = 0i64;
    let mut last_seen: Option<chrono::DateTime<chrono::Utc>> = None;
    for file in files {
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        if !is_within_last_days(&meta, PROMPT_DETECT_BACKFILL_DAYS) {
            continue;
        }
        let Ok(f) = std::fs::File::open(&file) else { continue };
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            if let Some(ts) = claude_prompt_timestamp(&line) {
                prompt_count += 1;
                if last_seen.is_none_or(|cur| ts > cur) {
                    last_seen = Some(ts);
                }
            }
        }
    }
    (projects.len(), prompt_count, last_seen)
}

/// claude_prompts.rs::extract_prompt과 같은 판정(type=="user" && message.role=="user" && 텍스트
/// 존재)을 쓰되, 미리보기는 타임스탬프만 있으면 된다(줄 텍스트는 노트로 만들지 않으므로 필요
/// 없음).
fn claude_prompt_timestamp(line: &str) -> Option<chrono::DateTime<chrono::Utc>> {
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
    if !has_prompt_text(message.get("content")?) {
        return None;
    }
    let ts = v.get("timestamp").and_then(|t| t.as_str())?;
    chrono::DateTime::parse_from_rfc3339(ts).ok().map(|dt| dt.with_timezone(&chrono::Utc))
}

fn has_prompt_text(content: &serde_json::Value) -> bool {
    if let Some(s) = content.as_str() {
        return !s.trim().is_empty();
    }
    content.as_array().is_some_and(|arr| {
        arr.iter().any(|b| {
            b.get("type").and_then(|t| t.as_str()) == Some("text")
                && b.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty())
        })
    })
}

/// `<root>/YYYY/MM/DD/*.jsonl` 레이아웃(codex_prompts.rs) — 디렉터리 구조에 프로젝트 개념이
/// 없으므로(각 세션 첫 줄의 `session_meta.payload.cwd`가 정본) 프로젝트 수도 프롬프트 수와 같은
/// mtime/cap 상한 아래에서만 집계한다(코덱스는 claude보다 근사치 성격이 강하다 — ponytail: 전체
/// 히스토리 프로젝트 집합을 알려면 어차피 파일을 다 열어야 해서 스캔 자체가 무거워진다).
fn scan_codex_root(root: &Path) -> (usize, i64, Option<chrono::DateTime<chrono::Utc>>) {
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files, PROMPT_DETECT_FILE_CAP);
    let mut projects = std::collections::HashSet::new();
    let mut prompt_count = 0i64;
    let mut last_seen: Option<chrono::DateTime<chrono::Utc>> = None;
    for file in files {
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        if !is_within_last_days(&meta, PROMPT_DETECT_BACKFILL_DAYS) {
            continue;
        }
        let Ok(f) = std::fs::File::open(&file) else { continue };
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("session_meta") => {
                    if let Some(cwd) = v.get("payload").and_then(|p| p.get("cwd")).and_then(|c| c.as_str()) {
                        projects.insert(codex_project_name(cwd));
                    }
                }
                Some("response_item") => {
                    if let Some(ts) = codex_prompt_timestamp(&v) {
                        prompt_count += 1;
                        if last_seen.is_none_or(|cur| ts > cur) {
                            last_seen = Some(ts);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    (projects.len(), prompt_count, last_seen)
}

fn codex_project_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn codex_prompt_timestamp(event: &serde_json::Value) -> Option<chrono::DateTime<chrono::Utc>> {
    let payload = event.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    if payload.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let content = payload.get("content")?.as_array()?;
    let has_text = content.iter().any(|b| {
        b.get("type").and_then(|t| t.as_str()) == Some("input_text")
            && b.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty())
    });
    if !has_text {
        return None;
    }
    let ts = event.get("timestamp").and_then(|t| t.as_str())?;
    chrono::DateTime::parse_from_rfc3339(ts).ok().map(|dt| dt.with_timezone(&chrono::Utc))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DetectedChatSession {
    pub id: String,
    pub kind: String,
    pub project: String,
    pub title: String,
    pub last_prompt: String,
    pub prompt_count: usize,
    pub last_active_at: Option<String>,
    pub relative_time: String,
}

fn truncate_preview(s: &str, max_len: usize) -> String {
    let s = s.trim().replace(['\r', '\n'], " ");
    let mut chars = s.chars();
    let mut truncated: String = chars.by_ref().take(max_len).collect();
    if chars.next().is_some() {
        truncated.push('…');
    }
    truncated
}

fn claude_prompt_info(line: &str) -> Option<(String, chrono::DateTime<chrono::Utc>)> {
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
    let content = message.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.trim().to_string()
    } else if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for b in arr {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|s| s.as_str()) {
                    let tr = t.trim();
                    if !tr.is_empty() {
                        parts.push(tr);
                    }
                }
            }
        }
        parts.join(" ")
    } else {
        String::new()
    };
    if text.is_empty() {
        return None;
    }
    let ts_str = v.get("timestamp").and_then(|t| t.as_str())?;
    let ts = chrono::DateTime::parse_from_rfc3339(ts_str).ok()?.with_timezone(&chrono::Utc);
    Some((text, ts))
}

fn codex_prompt_info(event: &serde_json::Value) -> Option<(String, chrono::DateTime<chrono::Utc>)> {
    let payload = event.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    if payload.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let content = payload.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for b in content {
        if b.get("type").and_then(|t| t.as_str()) == Some("input_text") {
            if let Some(t) = b.get("text").and_then(|s| s.as_str()) {
                let tr = t.trim();
                if !tr.is_empty() {
                    parts.push(tr);
                }
            }
        }
    }
    let text = parts.join(" ");
    if text.is_empty() {
        return None;
    }
    let ts_str = event.get("timestamp").and_then(|t| t.as_str())?;
    let ts = chrono::DateTime::parse_from_rfc3339(ts_str).ok()?.with_timezone(&chrono::Utc);
    Some((text, ts))
}

pub fn detect_chat_sessions() -> Vec<DetectedChatSession> {
    let mut sessions = Vec::new();

    // 1. Claude sessions
    let claude_root = source_config::claude_projects_root();
    if claude_root.exists() {
        let mut files = Vec::new();
        collect_jsonl_files(&claude_root, &mut files, PROMPT_DETECT_FILE_CAP);
        for file in files {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if !is_within_last_days(&meta, PROMPT_DETECT_BACKFILL_DAYS) {
                continue;
            }
            let Ok(f) = std::fs::File::open(&file) else { continue };
            let mut prompt_count = 0usize;
            let mut first_prompt = String::new();
            let mut last_prompt = String::new();
            let mut last_ts: Option<chrono::DateTime<chrono::Utc>> = None;

            for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
                if let Some((text, ts)) = claude_prompt_info(&line) {
                    prompt_count += 1;
                    if first_prompt.is_empty() {
                        first_prompt = text.clone();
                    }
                    last_prompt = text;
                    if last_ts.is_none_or(|cur| ts > cur) {
                        last_ts = Some(ts);
                    }
                }
            }
            if prompt_count > 0 {
                let project = file
                    .strip_prefix(&claude_root)
                    .ok()
                    .and_then(|p| p.components().next())
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .unwrap_or_else(|| "claude".to_string());

                let session_id = file
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("session")
                    .to_string();

                let rel_time = last_ts.map(relative_or_date).unwrap_or_else(|| "최근".to_string());

                sessions.push(DetectedChatSession {
                    id: format!("claude:{session_id}"),
                    kind: "claude_prompts".to_string(),
                    project,
                    title: truncate_preview(&first_prompt, 70),
                    last_prompt: truncate_preview(&last_prompt, 70),
                    prompt_count,
                    last_active_at: last_ts.map(iso),
                    relative_time: rel_time,
                });
            }
        }
    }

    // 2. Codex sessions
    let codex_root = source_config::codex_sessions_root();
    if codex_root.exists() {
        let mut files = Vec::new();
        collect_jsonl_files(&codex_root, &mut files, PROMPT_DETECT_FILE_CAP);
        for file in files {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if !is_within_last_days(&meta, PROMPT_DETECT_BACKFILL_DAYS) {
                continue;
            }
            let Ok(f) = std::fs::File::open(&file) else { continue };
            let mut prompt_count = 0usize;
            let mut first_prompt = String::new();
            let mut last_prompt = String::new();
            let mut last_ts: Option<chrono::DateTime<chrono::Utc>> = None;
            let mut project = String::new();

            for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("session_meta") => {
                        if let Some(cwd) = v.get("payload").and_then(|p| p.get("cwd")).and_then(|c| c.as_str()) {
                            project = codex_project_name(cwd);
                        }
                    }
                    Some("response_item") => {
                        if let Some((text, ts)) = codex_prompt_info(&v) {
                            prompt_count += 1;
                            if first_prompt.is_empty() {
                                first_prompt = text.clone();
                            }
                            last_prompt = text;
                            if last_ts.is_none_or(|cur| ts > cur) {
                                last_ts = Some(ts);
                            }
                        }
                    }
                    _ => {}
                }
            }
            if prompt_count > 0 {
                let session_id = file
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("session")
                    .to_string();

                let rel_time = last_ts.map(relative_or_date).unwrap_or_else(|| "최근".to_string());

                sessions.push(DetectedChatSession {
                    id: format!("codex:{session_id}"),
                    kind: "codex_prompts".to_string(),
                    project: if project.is_empty() { "codex".to_string() } else { project },
                    title: truncate_preview(&first_prompt, 70),
                    last_prompt: truncate_preview(&last_prompt, 70),
                    prompt_count,
                    last_active_at: last_ts.map(iso),
                    relative_time: rel_time,
                });
            }
        }
    }

    // 최신 활동 순 정렬
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    sessions.truncate(30);
    sessions
}

// ── 1클릭 가져오기 (collect_import_local) ────────────────────────────────────────────────────

/// `key` 파싱 결과 — 등록될 kind/설정이 아니라 "어느 가족인가"만 담는다(설정/이름은
/// resolve_import가 마저 채운다).
enum KeyTarget {
    Prompts(&'static str),
    Browser { browser: String, profile: String },
}

fn parse_key(key: &str) -> AppResult<KeyTarget> {
    match key {
        "claude_prompts" => Ok(KeyTarget::Prompts("claude_prompts")),
        "codex_prompts" => Ok(KeyTarget::Prompts("codex_prompts")),
        other => {
            let Some((browser, profile)) = other.split_once(':') else {
                return Err(unknown_key(key));
            };
            const ALLOWED_BROWSERS: &[&str] = &["chrome", "edge", "brave", "vivaldi", "whale"];
            if !ALLOWED_BROWSERS.contains(&browser) || profile.is_empty() {
                return Err(unknown_key(key));
            }
            Ok(KeyTarget::Browser { browser: browser.to_string(), profile: profile.to_string() })
        }
    }
}

fn unknown_key(key: &str) -> AppError {
    AppError::Validation(format!("unknown local import key: {key:?}"))
}

/// 새로 등록할 때 필요한 값 — `import_local_source`가 폴더/소스 생성에 그대로 쓴다.
struct ImportPlan {
    kind: &'static str,
    name: String,
    config: String,
    folder_name: &'static str,
    post_process: &'static str,
}

fn build_plan(target: KeyTarget) -> AppResult<ImportPlan> {
    match target {
        KeyTarget::Prompts(kind) => {
            let name = if kind == "codex_prompts" { "코덱스 대화" } else { "클로드 대화" };
            Ok(ImportPlan {
                kind,
                name: name.to_string(),
                config: "{}".to_string(),
                folder_name: PROMPTS_FOLDER_NAME,
                post_process: "summary",
            })
        }
        KeyTarget::Browser { browser, profile } => {
            let cfg = BrowserHistoryConfig {
                browser: browser.clone(),
                profile: profile.clone(),
                min_seconds: BROWSER_MIN_SECONDS,
                backfill_days: BROWSER_RECENT_DAYS,
                prompt: None,
            };
            let config = serde_json::to_string(&cfg).map_err(|e| AppError::Validation(e.to_string()))?;
            Ok(ImportPlan {
                kind: "browser_history",
                name: browser_label(&browser, &profile),
                config,
                folder_name: BROWSING_FOLDER_NAME,
                post_process: "none",
            })
        }
    }
}

/// detect가 보여준 label과 같은 이름이 소스 이름으로 저장되게 — 표시 이름을 다시 찾는다(감지와
/// 가져오기가 별도 IPC 왕복이라 프런트가 label을 그대로 넘겨주지 않는다, 계약: `key`만 받음).
#[cfg(windows)]
fn browser_label(browser: &str, profile: &str) -> String {
    let brand = browser_brand(browser);
    let display = browser_history::user_data_dir(browser)
        .ok()
        .and_then(|dir| read_profile_display_names(&dir).get(profile).cloned())
        .unwrap_or_else(|| profile.to_string());
    format!("{brand} · {display}")
}

#[cfg(not(windows))]
fn browser_label(browser: &str, profile: &str) -> String {
    format!("{} · {profile}", browser_brand(browser))
}

fn matches_browser_source(source: &CollectSource, browser: &str, profile: &str) -> bool {
    source.kind == "browser_history"
        && matches!(
            source_config::parse("browser_history", &source.config),
            Ok(SourceConfig::BrowserHistory(cfg)) if cfg.browser == browser && cfg.profile == profile
        )
}

/// `collect_import_local`의 실제 로직 — conn만 받는 얇은 함수라 State<AppState> 없이 단위
/// 테스트가 가능하다(commands/collect.rs의 다른 자유 함수들과 같은 자세). 같은 kind(프롬프트)
/// 또는 같은 browser+profile(브라우저) 소스가 이미 있으면 그대로 반환 — 중복 등록하지 않는다.
pub fn import_local_source(conn: &mut Connection, workspace_id: &str, key: &str) -> AppResult<CollectSource> {
    let target = parse_key(key)?;
    let existing = repo_collect::list(conn, workspace_id)?;
    let already = match &target {
        KeyTarget::Prompts(kind) => existing.iter().find(|s| s.kind == *kind).cloned(),
        KeyTarget::Browser { browser, profile } => existing.iter().find(|s| matches_browser_source(s, browser, profile)).cloned(),
    };
    if let Some(source) = already {
        return Ok(source);
    }

    let plan = build_plan(target)?;
    let folder_id = crate::repo::folders::ensure_named_folder_id(conn, workspace_id, plan.folder_name)?;
    repo_collect::create_with_options(
        conn,
        CreateCollectSourceParams {
            workspace_id,
            kind: plan.kind,
            name: &plan.name,
            config: &plan.config,
            dry_run: false,
            show_in_briefing: true,
            target_folder_id: Some(&folder_id),
            post_process: plan.post_process,
            post_process_model: None,
            interval_minutes: Some(repo_collect::ON_OPEN_SENTINEL),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_history_db(dir: &Path, urls: &[(i64, &str, &str, i64)], visits: &[(i64, i64, i64, i64)]) -> PathBuf {
        let path = dir.join("History");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER);
             CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, visit_duration INTEGER);",
        )
        .unwrap();
        for (id, url, title, hidden) in urls {
            conn.execute(
                "INSERT INTO urls (id, url, title, hidden) VALUES (?1,?2,?3,?4)",
                rusqlite::params![id, url, title, hidden],
            )
            .unwrap();
        }
        for (id, url_id, visit_time, visit_duration) in visits {
            conn.execute(
                "INSERT INTO visits (id, url, visit_time, visit_duration) VALUES (?1,?2,?3,?4)",
                rusqlite::params![id, url_id, visit_time, visit_duration],
            )
            .unwrap();
        }
        path
    }

    fn chrome_time_hours_ago(hours: i64) -> i64 {
        browser_history::chrome_time_from_unix_seconds((chrono::Utc::now() - chrono::Duration::hours(hours)).timestamp())
    }

    fn chrome_time_days_ago(days: i64) -> i64 {
        browser_history::chrome_time_from_unix_seconds((chrono::Utc::now() - chrono::Duration::days(days)).timestamp())
    }

    #[test]
    fn profile_names_come_from_local_state_with_dir_name_fallback_and_default_sorts_first() {
        let user_data = tempfile::tempdir().unwrap();
        std::fs::write(
            user_data.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Hongoo"},"Profile 1":{"name":"Work"}}}}"#,
        )
        .unwrap();
        for dir in ["Default", "Profile 1", "Guest Profile"] {
            let p = user_data.path().join(dir);
            std::fs::create_dir_all(&p).unwrap();
            build_history_db(&p, &[], &[]);
        }
        let data_dir = tempfile::tempdir().unwrap();

        let candidates = browser_candidates_from_user_data_dir("chrome", user_data.path(), data_dir.path(), &[]);

        let labels: Vec<&str> = candidates.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["크롬 · Hongoo", "크롬 · Guest Profile", "크롬 · Work"],
            "Default first, then by dir name; Local State supplies display names, missing entries fall back to the dir name"
        );
    }

    #[test]
    fn profiles_without_a_history_file_are_omitted() {
        let user_data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(user_data.path().join("Default")).unwrap();
        build_history_db(&user_data.path().join("Default"), &[], &[]);
        std::fs::create_dir_all(user_data.path().join("Profile 1")).unwrap(); // no History file
        let data_dir = tempfile::tempdir().unwrap();

        let candidates = browser_candidates_from_user_data_dir("chrome", user_data.path(), data_dir.path(), &[]);

        assert_eq!(candidates.len(), 1, "a profile dir with no History file must be omitted");
        assert_eq!(candidates[0].key, "chrome:Default");
    }

    #[test]
    fn recent_count_and_last_seen_are_computed_from_the_temp_history_copy() {
        let user_data = tempfile::tempdir().unwrap();
        let profile_dir = user_data.path().join("Default");
        std::fs::create_dir_all(&profile_dir).unwrap();
        build_history_db(
            &profile_dir,
            &[(1, "https://example.com/a", "A", 0), (2, "https://example.com/b", "B", 0)],
            &[(1, 1, chrome_time_hours_ago(2), 60_000_000), (2, 2, chrome_time_days_ago(30), 60_000_000)],
        );
        let data_dir = tempfile::tempdir().unwrap();

        let candidates = browser_candidates_from_user_data_dir("chrome", user_data.path(), data_dir.path(), &[]);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].recent_count, 1, "only the visit within the last 7 days counts");
        assert!(candidates[0].last_seen_at.is_some());
        assert!(candidates[0].detail.contains("최근 7일 1건"));
        // 복사본은 커넥션이 닫힌 뒤 지워져야 한다(Windows 는 열린 파일을 못 지운다 — 2026-09-05 실기 스모크).
        let leftover = std::fs::read_dir(data_dir.path().join("tmp")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftover, 0, "temp History copy must be deleted after the stats query");
    }

    #[test]
    fn source_id_is_populated_when_a_matching_browser_source_exists() {
        let user_data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(user_data.path().join("Default")).unwrap();
        build_history_db(&user_data.path().join("Default"), &[], &[]);
        let data_dir = tempfile::tempdir().unwrap();
        let existing = vec![fake_source("s1", "browser_history", r#"{"browser":"chrome","profile":"Default","min_seconds":15,"backfill_days":7}"#)];

        let candidates = browser_candidates_from_user_data_dir("chrome", user_data.path(), data_dir.path(), &existing);

        assert_eq!(candidates[0].source_id.as_deref(), Some("s1"));
    }

    fn fake_source(id: &str, kind: &str, config: &str) -> CollectSource {
        CollectSource {
            id: id.to_string(),
            workspace_id: "ws1".to_string(),
            kind: kind.to_string(),
            name: "n".to_string(),
            config: config.to_string(),
            enabled: true,
            dry_run: false,
            show_in_briefing: true,
            target_folder_id: None,
            post_process: "none".to_string(),
            post_process_model: None,
            interval_minutes: None,
            last_run_at: None,
            last_status: None,
            last_error: None,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        }
    }

    fn write_jsonl(dir: &Path, name: &str, lines: &[String]) {
        std::fs::write(dir.join(name), lines.join("\n")).unwrap();
    }

    fn claude_user_line(ts: &str, text: &str) -> String {
        format!(r#"{{"type":"user","message":{{"role":"user","content":{}}},"timestamp":"{ts}"}}"#, serde_json::to_string(text).unwrap())
    }

    fn now_ts() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn claude_candidate_counts_recent_prompt_lines_and_all_time_projects() {
        let root = tempfile::tempdir().unwrap();
        let proj_a = root.path().join("ProjA");
        std::fs::create_dir_all(&proj_a).unwrap();
        write_jsonl(&proj_a, "s1.jsonl", &[claude_user_line(&now_ts(), "hello there"), claude_user_line(&now_ts(), "second prompt")]);
        let proj_b = root.path().join("ProjB");
        std::fs::create_dir_all(&proj_b).unwrap();
        write_jsonl(&proj_b, "s1.jsonl", &[claude_user_line(&now_ts(), "from another project")]);

        let (projects, prompts, last_seen) = scan_claude_root(root.path());

        assert_eq!(projects, 2, "two project directories each with a jsonl file");
        assert_eq!(prompts, 3, "three user prompt lines across both projects");
        assert!(last_seen.is_some());
    }

    #[test]
    fn claude_candidate_excludes_files_older_than_the_detection_backfill_window() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("ProjA");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("s1.jsonl");
        write_jsonl(&proj, "s1.jsonl", &[claude_user_line(&now_ts(), "stale prompt")]);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600);
        std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_modified(old).unwrap();

        let (projects, prompts, last_seen) = scan_claude_root(root.path());

        assert_eq!(projects, 1, "the project directory itself still counts");
        assert_eq!(prompts, 0, "a file untouched for 14+ days must not be opened for counting");
        assert!(last_seen.is_none());
    }

    fn codex_session_meta(ts: &str, cwd: &str) -> String {
        format!(r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"cwd":{}}}}}"#, serde_json::to_string(cwd).unwrap())
    }

    fn codex_user_line(ts: &str, text: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn codex_candidate_counts_recent_prompt_lines_and_distinct_cwd_projects() {
        let root = tempfile::tempdir().unwrap();
        let day_dir = root.path().join("2026").join("09").join("05");
        std::fs::create_dir_all(&day_dir).unwrap();
        write_jsonl(
            &day_dir,
            "rollout-1.jsonl",
            &[codex_session_meta(&now_ts(), "/home/user/brise"), codex_user_line(&now_ts(), "do the thing")],
        );

        let (projects, prompts, last_seen) = scan_codex_root(root.path());

        assert_eq!(projects, 1, "counts one distinct cwd project from session_meta");
        assert_eq!(prompts, 1);
        assert!(last_seen.is_some());
    }

    #[test]
    fn detect_prompts_candidate_omits_missing_roots_and_reports_source_id() {
        let missing = tempfile::tempdir().unwrap().path().join("nope");
        assert!(detect_prompts_candidate("claude_prompts", &missing, "클로드 대화", &[]).is_none());

        let root = tempfile::tempdir().unwrap();
        let existing = vec![fake_source("cp1", "claude_prompts", "{}")];
        let candidate = detect_prompts_candidate("claude_prompts", root.path(), "클로드 대화", &existing).unwrap();
        assert_eq!(candidate.source_id.as_deref(), Some("cp1"));
        assert!(candidate.detail.contains("최근 14일"));
    }

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', ?1)",
            rusqlite::params![crate::util::now_iso()],
        )
        .unwrap();
        conn
    }

    #[test]
    fn import_creates_a_folder_and_source_once_then_reuses_it_on_a_second_call() {
        let mut conn = test_conn();

        let first = import_local_source(&mut conn, "ws1", "claude_prompts").unwrap();
        assert_eq!(first.kind, "claude_prompts");
        assert_eq!(first.post_process, "summary");
        assert_eq!(first.interval_minutes, Some(repo_collect::ON_OPEN_SENTINEL));
        let folder_name: String = conn
            .query_row("SELECT name FROM folders WHERE id=?1", [first.target_folder_id.as_deref().unwrap()], |r| r.get(0))
            .unwrap();
        assert_eq!(folder_name, "수집 — AI 대화");

        let second = import_local_source(&mut conn, "ws1", "claude_prompts").unwrap();
        assert_eq!(second.id, first.id, "an existing source of this kind must be reused, not duplicated");
    }

    #[test]
    fn import_browser_key_uses_the_browsing_folder_and_none_post_process() {
        let mut conn = test_conn();

        let source = import_local_source(&mut conn, "ws1", "chrome:Default").unwrap();
        assert_eq!(source.kind, "browser_history");
        assert_eq!(source.post_process, "none");
        let folder_name: String = conn
            .query_row("SELECT name FROM folders WHERE id=?1", [source.target_folder_id.as_deref().unwrap()], |r| r.get(0))
            .unwrap();
        assert_eq!(folder_name, "수집 — 브라우징");

        let second = import_local_source(&mut conn, "ws1", "chrome:Default").unwrap();
        assert_eq!(second.id, source.id, "same browser+profile must be reused");
    }

    #[test]
    fn import_rejects_an_unknown_key() {
        let mut conn = test_conn();
        let err = import_local_source(&mut conn, "ws1", "bogus-key").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // A browser-shaped key with an unsupported browser name must also be rejected.
        let err2 = import_local_source(&mut conn, "ws1", "firefox:Default").unwrap_err();
        assert!(matches!(err2, AppError::Validation(_)));
    }

    #[test]
    fn import_accepts_the_newly_supported_chromium_browsers() {
        let mut conn = test_conn();
        for browser in ["brave", "vivaldi", "whale"] {
            let source = import_local_source(&mut conn, "ws1", &format!("{browser}:Default")).unwrap();
            assert_eq!(source.kind, "browser_history");
            assert!(source.name.starts_with(browser_brand(browser)), "name must use the brand label for {browser}");
        }
    }
}
