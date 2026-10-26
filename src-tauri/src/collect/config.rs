//! Typed, kind-specific configuration for collection sources.
//!
//! Source configuration is persisted as JSON because the collect table supports several
//! adapters, but accepting an arbitrary JSON object here would turn every new source into a
//! potential capability expansion.  Keep the wire shape strict and make each adapter opt into its
//! own small, deny-unknown-fields schema.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RssConfig {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudePromptsConfig {
    /// Optional project-name substring filter.  The adapter still reads only below `dir`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Optional override is intentionally constrained to the standard Claude projects root.
    /// Keeping this field lets existing local configurations continue to work while preventing
    /// an AI response (or imported row) from turning the collector into an arbitrary file reader.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// 첫 실행이 전체 세션 히스토리(관측: 71건 day-note)를 한 번에 인박스로 쏟은 실기 결함의
    /// 수정 — 이보다 오래된 날짜는 스킵한다(§smoke-test defect C). 클램프는
    /// browser_history의 min_seconds/backfill_days 관례와 같음(거부 대신 문턱 안으로).
    #[serde(default = "default_prompts_backfill_days")]
    pub backfill_days: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// OpenAI Codex CLI 세션 로그(`~/.codex/sessions/YYYY/MM/DD/*.jsonl`) — ClaudePromptsConfig와
/// 같은 자세: project는 세션의 cwd 필드에서, dir override는 표준 루트 아래로만 강제.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CodexPromptsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default = "default_prompts_backfill_days")]
    pub backfill_days: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

fn default_prompts_backfill_days() -> i64 {
    14
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebConfig {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct YoutubeConfig {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// `browser_history` 수동 가져오기(kind, PLAN-2026-09-04-local-import §2.3) — Chrome/Edge 의
/// History sqlite 를 직접 읽는다. `min_seconds`/`backfill_days`는 거부 대신 클램프한다(다른 kind
/// 들의 `interval_minutes` 클램프 관례와 같음, repo::collect::MIN_INTERVAL_MINUTES 참고) — 사용자가
/// 극단값을 넣어도 소스 등록 자체는 성공하고 조용히 문턱 안으로 맞춰진다.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserHistoryConfig {
    #[serde(default = "default_browser_history_browser")]
    pub browser: String,
    #[serde(default = "default_browser_history_profile")]
    pub profile: String,
    #[serde(default = "default_browser_history_min_seconds")]
    pub min_seconds: i64,
    #[serde(default = "default_browser_history_backfill_days")]
    pub backfill_days: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

fn default_browser_history_browser() -> String {
    "chrome".to_string()
}
fn default_browser_history_profile() -> String {
    "Default".to_string()
}
fn default_browser_history_min_seconds() -> i64 {
    15
}
fn default_browser_history_backfill_days() -> i64 {
    7
}

#[derive(Debug, Clone)]
pub enum SourceConfig {
    Rss(RssConfig),
    ClaudePrompts(ClaudePromptsConfig),
    CodexPrompts(CodexPromptsConfig),
    Web(WebConfig),
    Youtube(YoutubeConfig),
    BrowserHistory(BrowserHistoryConfig),
}

/// Parse and validate the persisted config for one known source kind.
pub fn parse(kind: &str, raw: &str) -> AppResult<SourceConfig> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| AppError::Validation(format!("invalid {kind} source config: {e}")))?;
    if !value.is_object() {
        return Err(AppError::Validation(format!(
            "{kind} source config must be a JSON object"
        )));
    }
    match kind {
        "rss" => {
            let cfg: RssConfig = serde_json::from_value(value)
                .map_err(|e| AppError::Validation(format!("invalid rss source config: {e}")))?;
            validate_url(&cfg.url, "rss")?;
            Ok(SourceConfig::Rss(cfg))
        }
        "claude_prompts" => {
            let mut cfg: ClaudePromptsConfig = serde_json::from_value(value).map_err(|e| {
                AppError::Validation(format!("invalid claude_prompts source config: {e}"))
            })?;
            // Resolve even when the adapter is not run yet so an unsafe override cannot be
            // persisted by collect_source_add_nl and fail open later in the background runner.
            resolve_claude_projects_dir(cfg.dir.as_deref())?;
            if cfg.project.as_deref().is_some_and(|p| p.trim().is_empty()) {
                return Err(AppError::Validation(
                    "claude_prompts source config project must not be empty".to_string(),
                ));
            }
            cfg.backfill_days = cfg.backfill_days.clamp(1, 365);
            Ok(SourceConfig::ClaudePrompts(cfg))
        }
        "codex_prompts" => {
            let mut cfg: CodexPromptsConfig = serde_json::from_value(value).map_err(|e| {
                AppError::Validation(format!("invalid codex_prompts source config: {e}"))
            })?;
            resolve_codex_sessions_dir(cfg.dir.as_deref())?;
            if cfg.project.as_deref().is_some_and(|p| p.trim().is_empty()) {
                return Err(AppError::Validation(
                    "codex_prompts source config project must not be empty".to_string(),
                ));
            }
            cfg.backfill_days = cfg.backfill_days.clamp(1, 365);
            Ok(SourceConfig::CodexPrompts(cfg))
        }
        "web" => {
            let cfg: WebConfig = serde_json::from_value(value)
                .map_err(|e| AppError::Validation(format!("invalid web source config: {e}")))?;
            validate_url(&cfg.url, "web")?;
            Ok(SourceConfig::Web(cfg))
        }
        "youtube" => {
            let cfg: YoutubeConfig = serde_json::from_value(value)
                .map_err(|e| AppError::Validation(format!("invalid youtube source config: {e}")))?;
            validate_url(&cfg.url, "youtube")?;
            Ok(SourceConfig::Youtube(cfg))
        }
        "browser_history" => {
            let mut cfg: BrowserHistoryConfig = serde_json::from_value(value).map_err(|e| {
                AppError::Validation(format!("invalid browser_history source config: {e}"))
            })?;
            const ALLOWED_BROWSERS: &[&str] = &["chrome", "edge", "brave", "vivaldi", "whale"];
            if !ALLOWED_BROWSERS.contains(&cfg.browser.as_str()) {
                return Err(AppError::Validation(format!(
                    "browser_history source config browser must be one of {ALLOWED_BROWSERS:?}, got {:?}",
                    cfg.browser
                )));
            }
            if cfg.profile.trim().is_empty() {
                return Err(AppError::Validation(
                    "browser_history source config profile must not be empty".to_string(),
                ));
            }
            cfg.min_seconds = cfg.min_seconds.clamp(5, 600);
            cfg.backfill_days = cfg.backfill_days.clamp(1, 90);
            Ok(SourceConfig::BrowserHistory(cfg))
        }
        other => Err(AppError::Validation(format!(
            "unsupported source kind: {other:?}"
        ))),
    }
}

/// Parse a model-produced JSON value and return a canonical JSON string containing only fields
/// accepted by the kind-specific schema.  Canonicalization is important: values in the database
/// should not retain unknown keys after a successful AI registration.
pub fn normalize_value(kind: &str, value: &serde_json::Value) -> AppResult<String> {
    let raw = serde_json::to_string(value)
        .map_err(|e| AppError::Validation(format!("invalid {kind} source config: {e}")))?;
    let parsed = parse(kind, &raw)?;
    let normalized = match parsed {
        SourceConfig::Rss(mut cfg) => {
            cfg.url = cfg.url.trim().to_string();
            serde_json::to_string(&cfg)
        }
        SourceConfig::ClaudePrompts(cfg) => serde_json::to_string(&cfg),
        SourceConfig::CodexPrompts(cfg) => serde_json::to_string(&cfg),
        SourceConfig::Web(mut cfg) => {
            cfg.url = cfg.url.trim().to_string();
            serde_json::to_string(&cfg)
        }
        SourceConfig::Youtube(mut cfg) => {
            cfg.url = cfg.url.trim().to_string();
            serde_json::to_string(&cfg)
        }
        SourceConfig::BrowserHistory(cfg) => serde_json::to_string(&cfg),
    }
    .map_err(|e| AppError::Validation(format!("could not serialize {kind} source config: {e}")))?;
    Ok(normalized)
}

fn validate_url(raw_url: &str, kind: &str) -> AppResult<()> {
    let url = raw_url.trim();
    if url.is_empty() {
        return Err(AppError::Validation(
            format!("{kind} source config is missing \"url\""),
        ));
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::Validation(format!("{kind} source URL is not valid: {url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::Validation(
            format!("{kind} source URL must be an http(s) URL with a host"),
        ));
    }
    if let Some(host) = parsed.host_str() {
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            if crate::repo::web_reader::ip_is_internal(&ip) {
                return Err(AppError::Validation(
                    format!("{kind} source URL must not target a private or loopback address"),
                ));
            }
        }
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Validation(
            format!("{kind} source URL must not contain username or password"),
        ));
    }
    Ok(())
}

/// Standard Claude Code session root.  This deliberately does not accept an arbitrary home
/// directory or absolute path; the collector is only for `~/.claude/projects`.
pub fn claude_projects_root() -> PathBuf {
    expand_home("~/.claude/projects")
}

pub fn codex_sessions_root() -> PathBuf {
    expand_home("~/.codex/sessions")
}

/// Expand only a leading `~` and reject overrides outside `root`. Lexical component checks catch
/// `..` traversal; canonicalizing the nearest existing prefix also catches a symlink below the
/// root that points elsewhere. Shared by resolve_claude_projects_dir/resolve_codex_sessions_dir
/// (two local-session-log adapters with the same "stay under this one allowed root" shape,
/// ponytail: extracted once a second real caller showed up).
fn resolve_dir_under_root(raw: Option<&str>, root: &Path, default_text: &str, err_msg: &str) -> AppResult<PathBuf> {
    let text = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default_text);
    let path = expand_home(text);
    if root.as_os_str().is_empty() || path.as_os_str().is_empty() {
        return Err(AppError::Validation(
            "cannot determine the session log home directory".to_string(),
        ));
    }
    if !path_is_below(&path, root) {
        return Err(AppError::Validation(err_msg.to_string()));
    }
    let canonical_root = canonicalize_existing_prefix(root);
    let canonical_path = canonicalize_existing_prefix(&path);
    if !canonical_path.starts_with(&canonical_root) {
        return Err(AppError::Validation(err_msg.to_string()));
    }
    Ok(path)
}

/// Reject overrides outside the standard Claude projects root — see resolve_dir_under_root.
pub fn resolve_claude_projects_dir(raw: Option<&str>) -> AppResult<PathBuf> {
    resolve_dir_under_root(
        raw,
        &claude_projects_root(),
        "~/.claude/projects",
        "claude_prompts source dir must stay under ~/.claude/projects",
    )
}

/// Reject overrides outside the standard Codex CLI sessions root — see resolve_dir_under_root.
pub fn resolve_codex_sessions_dir(raw: Option<&str>) -> AppResult<PathBuf> {
    resolve_dir_under_root(
        raw,
        &codex_sessions_root(),
        "~/.codex/sessions",
        "codex_prompts source dir must stay under ~/.codex/sessions",
    )
}

fn expand_home(path: &str) -> PathBuf {
    let Some(rest) = path.strip_prefix('~') else {
        return PathBuf::from(path);
    };
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_default();
    if home.is_empty() {
        return PathBuf::new();
    }
    match rest.strip_prefix(['/', '\\']) {
        Some(rest) if !rest.is_empty() => PathBuf::from(home).join(rest),
        _ => PathBuf::from(home),
    }
}

fn path_is_below(path: &Path, root: &Path) -> bool {
    let has_parent = path
        .components()
        .any(|component| component == Component::ParentDir);
    !has_parent && path.starts_with(root)
}

fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return path.to_path_buf();
        }
    }
    std::fs::canonicalize(&existing).unwrap_or(existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_schema_rejects_unknown_fields_and_invalid_urls() {
        let err = parse("rss", r#"{"url":"https://example.com/feed","dir":"C:/"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("rss", r#"{"url":"file:///etc/passwd"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn claude_schema_rejects_unknown_fields_and_outside_dir() {
        let err = parse("claude_prompts", r#"{"unexpected":true}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("claude_prompts", r#"{"dir":"C:/Users/Public"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn claude_prompts_backfill_days_defaults_to_14_and_clamps_1_to_365() {
        let SourceConfig::ClaudePrompts(cfg) = parse("claude_prompts", "{}").unwrap() else {
            panic!("wrong variant");
        };
        assert_eq!(cfg.backfill_days, 14, "empty object still parses and applies the default");

        let SourceConfig::ClaudePrompts(clamped) =
            parse("claude_prompts", r#"{"backfill_days":9999}"#).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(clamped.backfill_days, 365, "clamped down to the ceiling");

        let SourceConfig::ClaudePrompts(clamped_low) =
            parse("claude_prompts", r#"{"backfill_days":0}"#).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(clamped_low.backfill_days, 1, "clamped up to the floor");
    }

    #[test]
    fn codex_prompts_backfill_days_defaults_to_14_and_clamps_1_to_365() {
        let SourceConfig::CodexPrompts(cfg) = parse("codex_prompts", "{}").unwrap() else {
            panic!("wrong variant");
        };
        assert_eq!(cfg.backfill_days, 14);

        let SourceConfig::CodexPrompts(clamped) =
            parse("codex_prompts", r#"{"backfill_days":9999}"#).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(clamped.backfill_days, 365, "clamped down to the ceiling");

        let SourceConfig::CodexPrompts(clamped_low) =
            parse("codex_prompts", r#"{"backfill_days":0}"#).unwrap()
        else {
            panic!("wrong variant");
        };
        assert_eq!(clamped_low.backfill_days, 1, "clamped up to the floor");
    }

    #[test]
    fn codex_schema_rejects_unknown_fields_and_outside_dir() {
        let err = parse("codex_prompts", r#"{"unexpected":true}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("codex_prompts", r#"{"dir":"C:/Users/Public"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn web_schema_rejects_unknown_fields_and_invalid_urls() {
        let err = parse("web", r#"{"url":"https://example.com/page","extra":true}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("web", r#"{"url":"file:///etc/passwd"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("web", r#"{"url":"http://127.0.0.1/page"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        parse("web", r#"{"url":"https://example.com/page"}"#).unwrap();
    }

    #[test]
    fn youtube_schema_rejects_unknown_fields_and_invalid_urls() {
        let err = parse("youtube", r#"{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","extra":true}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("youtube", r#"{"url":"file:///etc/passwd"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("youtube", r#"{"url":"http://127.0.0.1/page"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        parse("youtube", r#"{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}"#).unwrap();
    }

    #[test]
    fn browser_history_schema_defaults_clamps_and_rejects_unknown_browser() {
        let SourceConfig::BrowserHistory(cfg) = parse("browser_history", "{}").unwrap() else {
            panic!("wrong variant");
        };
        assert_eq!(cfg.browser, "chrome");
        assert_eq!(cfg.profile, "Default");
        assert_eq!(cfg.min_seconds, 15);
        assert_eq!(cfg.backfill_days, 7);

        let SourceConfig::BrowserHistory(clamped) = parse(
            "browser_history",
            r#"{"browser":"edge","min_seconds":1,"backfill_days":999}"#,
        )
        .unwrap() else {
            panic!("wrong variant");
        };
        assert_eq!(clamped.browser, "edge");
        assert_eq!(clamped.min_seconds, 5, "clamped up to the floor");
        assert_eq!(clamped.backfill_days, 90, "clamped down to the ceiling");

        let err = parse("browser_history", r#"{"browser":"firefox"}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("browser_history", r#"{"unexpected":true}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        let err = parse("browser_history", r#"{"profile":"  "}"#).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn browser_history_schema_accepts_brave_vivaldi_and_whale() {
        for browser in ["brave", "vivaldi", "whale"] {
            let SourceConfig::BrowserHistory(cfg) =
                parse("browser_history", &format!(r#"{{"browser":"{browser}"}}"#)).unwrap()
            else {
                panic!("wrong variant");
            };
            assert_eq!(cfg.browser, browser);
        }
    }

    #[test]
    fn normalizes_only_known_kind_fields() {
        let normalized = normalize_value(
            "rss",
            &serde_json::json!({"url":" https://example.com/feed ", "interval_minutes": 30}),
        )
        .unwrap();
        assert_eq!(
            normalized,
            r#"{"url":"https://example.com/feed","interval_minutes":30}"#
        );
    }
}
