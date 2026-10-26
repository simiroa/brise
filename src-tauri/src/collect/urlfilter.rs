//! Shared URL heuristics for the browsing-history paths: the crome extension's manual visit
//! ingest (`sync_server::ingest`) and the `browser_history` collect adapter both build "one line
//! per visit" notes with the same title prefix, the same markdown line shape, and the same
//! search-result/excluded-domain filters. This module is the single definition so the two paths
//! cannot drift (PLAN-2026-09-04-local-import §2.3 — previously only `sync_server::ingest` had
//! these, this moves them here and `ingest.rs` now calls back into this module).

use crate::error::AppResult;
use regex::Regex;
use std::sync::OnceLock;

/// 검색 결과 페이지 4종 — extension/visit.js 의 `SEARCH_RESULT_PATTERNS` 와 완전히 같은 정규식
/// (D2/W1). 그쪽 사본은 트래픽 절약용으로 남아 있고 여기가 최종 심판이다 — 여기가 바뀌면 visit.js
/// 도 같이 바꿔라(반대 방향은 다른 작업자가 맡음).
fn search_result_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)^https?://(www\.)?google\.[a-z.]+/(search|url)\b",
            r"(?i)^https?://(www\.)?bing\.com/search\b",
            r"(?i)^https?://(www\.|html\.|lite\.)?duckduckgo\.com/(html|lite|\?|$)",
            r"(?i)^https?://([a-z]+\.)?search\.naver\.com/",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("static search-result pattern is valid"))
        .collect()
    })
}

pub(crate) fn is_search_result(url: &str) -> bool {
    search_result_patterns().iter().any(|re| re.is_match(url))
}

/// 호스트가 제외 목록에 걸리는가 — 정확히 같거나 서브도메인이면 제외("example.com" 이
/// "news.example.com" 도 막는다). URL 을 파싱하지 못하면 제외하지 않는다(문턱 판정이 남아 있다).
pub(crate) fn host_excluded(url: &str, excluded: &[String]) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    excluded
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// 자격증명/세션 성격의 쿼리 파라미터 — 대소문자 무시 정확 일치. `oauth_`는 접두사 매치(플랫폼마다
/// `oauth_token`/`oauth_verifier` 등 파생 키가 있다). `q`(검색어)는 일부러 남긴다 — 검색결과
/// 페이지 자체가 이미 `is_search_result`로 제외되므로 일반 페이지에 남는 `q`는 자격증명이 아니다.
const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "token", "access_token", "id_token", "refresh_token", "code", "key", "api_key", "apikey",
    "secret", "session", "sessionid", "sid", "auth", "password", "pwd", "signature", "sig", "state",
];

fn is_sensitive_query_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_QUERY_KEYS.contains(&lower.as_str()) || lower.starts_with("oauth_")
}

/// 노트에 URL을 적기 전에 자격증명 성격의 쿼리 파라미터를 없앤다 — `browser_history` 어댑터와
/// `sync_server::ingest::append_visit` 둘 다 방문한 URL을 그대로 노트에 영구 저장하므로, 세션
/// 토큰이 섞인 링크(예: OAuth 콜백, 로그인 매직링크)가 노트에 평문으로 남는 걸 막는다. 나머지
/// 쿼리는 그대로 유지하고, 지운 뒤 쿼리가 하나도 안 남으면 `?` 자체도 없앤다. URL을 못 파싱하면
/// (호출자가 이미 스킴/파싱 검증을 마쳤을 것이므로 방어적 처리) 원문을 그대로 돌려준다.
pub(crate) fn scrub_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if parsed.query().is_none() {
        return parsed.to_string();
    }
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| !is_sensitive_query_key(k))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.query_pairs_mut().clear().extend_pairs(kept.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    parsed.to_string()
}

/// 일자별 방문 노트 제목 접두사 — claude_prompts 의 "클로드 프롬프트 — <날짜>" 관례와 같은 모양
/// (kind 가 다르니 계열만 나눈다). 익스텐션 방문 기록과 `browser_history` 수동 가져오기가 같은
/// 접두사를 써야 같은 일자 노트에 합쳐진다(PLAN-2026-09-04-local-import Q1).
pub(crate) const VISIT_NOTE_TITLE_PREFIX: &str = "브라우징 기록 — ";

/// 관여 시간 표시 — 1200초보다 "20분"이 읽힌다.
pub(crate) fn humanize_seconds(seconds: i64) -> String {
    if seconds >= 60 {
        format!("{}분", seconds / 60)
    } else {
        format!("{seconds}초")
    }
}

/// 마크다운 링크 텍스트로 안전한 한 줄 제목 — 줄바꿈·대괄호를 없애고 길이를 자른다.
pub(crate) fn link_label(title: &str, url: &str) -> String {
    let cleaned: String = title
        .replace(['\r', '\n'], " ")
        .replace(['[', ']'], "")
        .trim()
        .chars()
        .take(120)
        .collect();
    if cleaned.is_empty() {
        url.chars().take(120).collect()
    } else {
        cleaned
    }
}

/// `collect_excluded_domains`(모든 collection 경로 공유) 우선, 비어있으면 legacy
/// `capture_visit_excluded_domains` 로 폴백 — `sync_server::ingest::read_visit_config` 과 같은
/// 규칙. `browser_history` 어댑터는 conn 이 없어 이 판정을 스스로 못 하므로, 유일하게 conn 을
/// 쥐고 있는 `collect::ingest_item_parts` 가 이 함수로 대신 걸러낸다(§2.3).
///
/// D5(AUDIT-2026-09-26-fallback-observability.md §4): 예전엔 설정 읽기 실패를 `unwrap_or_default()`
/// 로 삼켜 **빈 목록**을 돌려줬다 — fail-open. 제외 목록이 빈 걸로 보이면 그 사이클에 들어온
/// 항목은 전부 "제외 없음"으로 통과해 `collect_seen`에 영구히 클레임되므로, 다음에 설정을 다시
/// 읽을 수 있게 되어도 이미 놓친 방문은 되돌릴 수 없다(사용자가 명시적으로 뺀 도메인이 그 창에서
/// 만큼은 계속 수집된다는 뜻 — 프라이버시 사고). 그래서 여기서부터 Result로 승격해 fail-closed로
/// 뒤집는다: 호출자(`ingest_item_parts`)가 Err를 받으면 이번 항목 전체를 건너뛰고(클레임 없음)
/// 다음 사이클에 자연히 재시도되게 한다.
pub(crate) fn read_excluded_domains(conn: &rusqlite::Connection) -> AppResult<Vec<String>> {
    let settings = crate::repo::settings::get_all(conn)?;
    let excluded_raw = settings
        .get("collect_excluded_domains")
        .and_then(|v| v.as_array())
        .filter(|arr| !arr.is_empty())
        .or_else(|| settings.get("capture_visit_excluded_domains").and_then(|v| v.as_array()));
    Ok(excluded_raw
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_search_result_matches_all_four_engines_and_rejects_normal_pages() {
        assert!(is_search_result("https://www.google.com/search?q=x"));
        assert!(is_search_result("https://www.bing.com/search?q=x"));
        assert!(is_search_result("https://duckduckgo.com/html?q=x"));
        assert!(is_search_result("https://search.naver.com/search.naver?query=x"));
        assert!(!is_search_result("https://example.com/article"));
    }

    #[test]
    fn host_excluded_matches_exact_and_subdomains_only() {
        let excluded = vec!["example.com".to_string()];
        assert!(host_excluded("https://example.com/a", &excluded));
        assert!(host_excluded("https://news.example.com/a", &excluded));
        assert!(!host_excluded("https://otherexample.com/a", &excluded));
        assert!(!host_excluded("not a url", &excluded));
    }

    #[test]
    fn link_label_strips_brackets_newlines_and_falls_back_to_the_url() {
        assert_eq!(link_label("A [B]\nC", "https://example.com/a"), "A B C");
        assert_eq!(link_label("   ", "https://example.com/a"), "https://example.com/a");
    }

    #[test]
    fn humanize_seconds_switches_units_at_the_60_second_boundary() {
        assert_eq!(humanize_seconds(59), "59초");
        assert_eq!(humanize_seconds(60), "1분");
        assert_eq!(humanize_seconds(1200), "20분");
    }

    #[test]
    fn scrub_url_strips_sensitive_query_keys_case_insensitively_and_keeps_the_rest() {
        assert_eq!(
            scrub_url("https://example.com/a?Token=abc&q=cats&Sid=x"),
            "https://example.com/a?q=cats",
            "Token/Sid must go (case-insensitive) while q survives"
        );
        assert_eq!(
            scrub_url("https://example.com/a?token=abc&api_key=xyz&password=hunter2"),
            "https://example.com/a",
            "when every param is sensitive the trailing ? must also disappear"
        );
    }

    #[test]
    fn scrub_url_strips_the_oauth_prefix_family_and_leaves_normal_urls_untouched() {
        assert_eq!(scrub_url("https://example.com/cb?oauth_token=abc&oauth_verifier=def"), "https://example.com/cb");
        assert_eq!(scrub_url("https://example.com/a?q=cats&page=2"), "https://example.com/a?q=cats&page=2");
        assert_eq!(scrub_url("https://example.com/a"), "https://example.com/a", "no query string is a no-op");
        assert_eq!(scrub_url("not a url"), "not a url", "unparseable input is returned unchanged");
    }

    /// D5: 설정 읽기가 실패하면(`settings` 테이블이 없는 커넥션으로 재현) `unwrap_or_default()`로
    /// 삼켜 빈 목록(fail-open)을 돌려주던 옛 동작 대신 Err를 낸다 — 호출자가 이번 사이클을
    /// 건너뛰게 하는 신호.
    #[test]
    fn read_excluded_domains_fails_closed_when_settings_are_unreadable() {
        let conn = rusqlite::Connection::open_in_memory().unwrap(); // migrations 미실행 -> settings 테이블 없음
        assert!(read_excluded_domains(&conn).is_err(), "settings 조회 실패는 빈 목록이 아니라 Err여야 한다");
    }
}
