//! 브리핑 창(#/briefing). 생성·포커스·왜 OS 창인지는 `aux_window.rs` 참고. PLAN-2026-09-30-briefing.

use crate::aux_window::{ensure_owned_window_at, AuxWindowSpec};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const BRIEFING_LABEL: &str = "briefing";

/// 이미 열린 브리핑 창에 모드(morning | recap)를 알리는 이벤트 — `BriefingWindowApp` 이 듣는다.
pub const BRIEFING_MODE_EVENT: &str = "briefing-mode";

// 창 안 편집 모드(`?edit=1` · `briefing-edit` 이벤트)는 브리핑 재작성으로 없어졌다
// (PLAN-2026-10-19-briefing-rewrite §9.1) — 블록 격자 편집기 자체가 사라졌다.

const SPEC: AuxWindowSpec = AuxWindowSpec {
    label: BRIEFING_LABEL,
    title: "Brise — Briefing",
    url: "index.html#/briefing",
    width: 1100.0,
    height: 820.0,
    min_width: 360.0,
    min_height: 480.0,
};

/// 허용 모드는 "recap"(저녁 회고)뿐 — 그 밖(None·"morning"·모르는 값)은 아침 브리핑이다.
pub fn is_recap(mode: Option<&str>) -> bool {
    mode == Some("recap")
}

/// 새 창을 열 URL. 쿼리는 해시 **앞**(main.tsx 의 해시 라우트가 `#/briefing` 정확 일치라서).
/// 쿼리 값은 열거형(mode=recap)뿐이라 호출자 문자열이 URL 에 섞이지 않는다.
pub fn briefing_url(mode: Option<&str>) -> String {
    if is_recap(mode) {
        "index.html?mode=recap#/briefing".to_string()
    } else {
        SPEC.url.to_string()
    }
}

/// 이미 있으면 앞으로 가져온다(idempotent). 새 창은 URL 쿼리로, 이미 열린 창은 `briefing-mode`
/// 이벤트로 받는다(열린 창의 URL 은 바꾸지 않는다 — 새로고침이 된다).
pub fn ensure_briefing_window<R: Runtime>(app: &AppHandle<R>, mode: Option<&str>) -> tauri::Result<()> {
    if app.get_webview_window(BRIEFING_LABEL).is_some() {
        let m = if is_recap(mode) { "recap" } else { "morning" };
        // 실패해도 창은 앞으로 온다 — 모드만 그대로일 뿐이라 여는 것 자체를 막지 않는다.
        if let Err(e) = app.emit_to(BRIEFING_LABEL, BRIEFING_MODE_EVENT, m) {
            crate::diag::warn("briefing_window", "mode_emit_failed", &e.to_string());
        }
    }
    ensure_owned_window_at(app, &SPEC, &briefing_url(mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recap_selects_the_recap_url() {
        assert_eq!(briefing_url(Some("recap")), "index.html?mode=recap#/briefing");
        // 모르는 mode 문자열(주입 시도 포함)은 URL 에 새지 않는다.
        for other in [None, Some("morning"), Some(""), Some("recap#/x"), Some("RECAP"), Some("x&edit=1")] {
            assert_eq!(briefing_url(other), "index.html#/briefing", "{other:?}");
        }
    }
}
