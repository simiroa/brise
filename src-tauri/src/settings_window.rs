//! 설정 창(#/settings). 생성·포커스·왜 OS 창인지는 `aux_window.rs` 참고.

use crate::aux_window::{ensure_owned_window_at, AuxWindowSpec};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const SETTINGS_LABEL: &str = "settings";

/// 이미 열린 설정 창에 페이지를 알리는 이벤트 — `src/components/SettingsPanel.tsx` 가 듣는다.
pub const SETTINGS_NAVIGATE_EVENT: &str = "settings-navigate";

const SPEC: AuxWindowSpec = AuxWindowSpec {
    label: SETTINGS_LABEL,
    title: "Brise — Settings",
    url: "index.html#/settings",
    width: 900.0,
    height: 760.0,
    min_width: 560.0,
    min_height: 420.0,
};

/// 페이지 id 는 SettingsPanel 의 `allPages[].id`(소문자·숫자·밑줄, 예 `ai_presets`)다. URL 쿼리와 이벤트
/// 페이로드로 그대로 나가므로 그 문자만 통과시킨다 — 나머지는 페이지 없이 여는 것과 같다(프런트도 모르는
/// id 는 첫 페이지로 떨어뜨린다).
pub fn valid_page(page: Option<&str>) -> Option<&str> {
    page.filter(|p| !p.is_empty() && p.len() <= 64 && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
}

/// 앵커(페이지 안 블록 id, 프런트 `settings-anchor-<anchor>`)도 같은 문자 규칙이다 — URL 쿼리·이벤트로 그대로 나간다.
pub fn valid_anchor(anchor: Option<&str>) -> Option<&str> {
    valid_page(anchor)
}

/// 새 창을 열 URL. 쿼리는 해시 **앞**에 온다 — main.tsx 의 해시 라우트가 `#/settings` 정확 일치라서.
/// 앵커는 페이지가 있을 때만 붙는다(페이지 없는 앵커는 어디를 가리키는지 모른다).
pub fn settings_url(page: Option<&str>, anchor: Option<&str>) -> String {
    match (valid_page(page), valid_anchor(anchor)) {
        (Some(p), Some(a)) => format!("index.html?page={p}&anchor={a}#/settings"),
        (Some(p), None) => format!("index.html?page={p}#/settings"),
        _ => SPEC.url.to_string(),
    }
}

/// 열린 창에 보낼 페이로드 — 앵커가 없으면 예전 그대로 문자열(호환), 있으면 `{page, anchor}`.
pub fn navigate_payload(page: &str, anchor: Option<&str>) -> serde_json::Value {
    match anchor {
        Some(a) => serde_json::json!({ "page": page, "anchor": a }),
        None => serde_json::Value::String(page.to_string()),
    }
}

/// 이미 있으면 앞으로 가져온다(idempotent). `page` 가 있으면 그 페이지로 연다 — 새 창은 URL 쿼리로,
/// 이미 열린 창은 `settings-navigate` 이벤트로(열린 창의 URL 은 바꾸지 않는다: 새로고침이 된다).
pub fn ensure_settings_window<R: Runtime>(app: &AppHandle<R>, page: Option<&str>, anchor: Option<&str>) -> tauri::Result<()> {
    let page = valid_page(page);
    let valid = valid_anchor(anchor);
    if anchor.is_some_and(|a| !a.is_empty()) && valid.is_none() {
        crate::diag::warn("settings_window", "invalid_anchor", "dropped");
    }
    let anchor = valid;
    if let (Some(p), true) = (page, app.get_webview_window(SETTINGS_LABEL).is_some()) {
        // 실패해도 창은 앞으로 온다 — 페이지만 그대로일 뿐이라 여는 것 자체를 막지 않는다.
        if let Err(e) = app.emit_to(SETTINGS_LABEL, SETTINGS_NAVIGATE_EVENT, navigate_payload(p, anchor)) {
            crate::diag::warn("settings_window", "navigate_emit_failed", &e.to_string());
        }
    }
    ensure_owned_window_at(app, &SPEC, &settings_url(page, anchor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_ids_pass_only_as_lowercase_word_chars() {
        assert_eq!(valid_page(Some("ai_presets")), Some("ai_presets"));
        assert_eq!(valid_page(Some("ai")), Some("ai"));
        assert_eq!(valid_page(None), None);
        assert_eq!(valid_page(Some("")), None);
        // URL·해시를 깨거나 끼워 넣을 수 있는 것은 전부 거절 — 페이지 없이 여는 것과 같다.
        for bad in ["ai#/pet", "ai&x=1", "../x", "AI", "ai presets", "ai?page=x", "한글"] {
            assert_eq!(valid_page(Some(bad)), None, "{bad}");
        }
        assert_eq!(valid_page(Some(&"a".repeat(65))), None);
    }

    #[test]
    fn url_puts_the_query_before_the_hash_route() {
        assert_eq!(settings_url(Some("ai_presets"), None), "index.html?page=ai_presets#/settings");
        assert_eq!(settings_url(None, None), "index.html#/settings");
        assert_eq!(settings_url(Some("ai#/pet"), None), "index.html#/settings");
    }

    #[test]
    fn anchor_rides_along_only_with_a_valid_page() {
        assert_eq!(settings_url(Some("briefing"), Some("habits_add")), "index.html?page=briefing&anchor=habits_add#/settings");
        assert_eq!(settings_url(None, Some("habits")), "index.html#/settings");
        assert_eq!(settings_url(Some("briefing"), Some("a&b")), "index.html?page=briefing#/settings");
        assert_eq!(valid_anchor(Some("add")), Some("add"));
        assert_eq!(valid_anchor(Some("A#")), None);
    }

    #[test]
    fn navigate_payload_stays_a_string_without_anchor() {
        assert_eq!(navigate_payload("ai", None), serde_json::json!("ai"));
        assert_eq!(navigate_payload("ai", Some("x")), serde_json::json!({"page":"ai","anchor":"x"}));
    }
}
