//! 본 창 지오메트리(크기·위치) 복원 — 창이 아직 **숨겨진** 동안 Rust 가 한다.
//!
//! 예전엔 프런트(src/lib/bootWindow.ts)가 설정을 다 읽은 뒤 `set_size` → `available_monitors` →
//! `set_position` 을 IPC 로 하나씩 기다리고 나서야 창을 보였다. 그 사슬이 부팅 중 바쁜 메인 스레드와
//! 엉켜 창 표시를 늦췄다(2026-10-22 콜드 스타트 계측: 설정 → 표시 구간 ~120ms 의 대부분). 여기서는
//! setup(DB 직후, 웹뷰가 페이지를 읽는 동안)에 같은 일을 끝내 둔다.
//!
//! 최대화는 하지 않는다 — Windows 의 maximize 는 숨긴 창을 그 자리에서 보이게 만든다(표시 계약 위반:
//! 다 그리기 전에 창이 뜬다). 최대화는 프런트가 표시 직전에 그대로 한다.
//!
//! 저장 형식은 프런트 `currentWindowGeometry()` 가 쓰는 JSON 문자열 그대로다: `{x,y,width,height,maximized}`,
//! 전부 물리 px(크기는 inner).

use serde::Deserialize;
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

#[derive(Debug, Deserialize, PartialEq)]
pub struct SavedGeometry {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 모니터 사각형(물리 px).
#[derive(Debug, Clone, Copy)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// settings 의 `window_geometry` 값(JSON 문자열을 담은 문자열) → 지오메트리. 없거나 깨졌으면 None.
pub fn parse(raw: Option<&serde_json::Value>) -> Option<SavedGeometry> {
    let s = raw?.as_str()?;
    serde_json::from_str(s).ok()
}

/// 저장 위치가 지금 붙어 있는 모니터 어디엔가 걸치는가 — 프런트 `rectIntersectsAnyMonitor`(lib/ui.ts)와
/// 같은 규칙: 모니터 목록이 비면 true(모르면 옛 동작 유지), 크기가 없으면 1×1 로 본다.
pub fn on_some_monitor(g: &SavedGeometry, monitors: &[MonitorRect]) -> bool {
    let (Some(x), Some(y)) = (g.x, g.y) else { return false };
    if monitors.is_empty() {
        return true;
    }
    let (w, h) = (g.width.unwrap_or(1) as i64, g.height.unwrap_or(1) as i64);
    let (x, y) = (x as i64, y as i64);
    monitors.iter().any(|m| {
        let (mx, my) = (m.x as i64, m.y as i64);
        x + w > mx && x < mx + m.width as i64 && y + h > my && y < my + m.height as i64
    })
}

/// 저장된 크기·위치를 창에 건다(숨긴 창 전제). 실패는 진단에만 남기고 넘어간다 — 기본 크기로라도 떠야 한다.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, raw: Option<&serde_json::Value>) {
    let Some(g) = parse(raw) else { return };
    if let (Some(w), Some(h)) = (g.width, g.height) {
        if w > 0 && h > 0 {
            if let Err(e) = window.set_size(PhysicalSize::new(w, h)) {
                crate::diag::warn("boot", "geometry_size_failed", e.to_string());
            }
        }
    }
    if g.x.is_some() && g.y.is_some() {
        let monitors: Vec<MonitorRect> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| MonitorRect {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
            })
            .collect();
        if on_some_monitor(&g, &monitors) {
            if let Err(e) = window.set_position(PhysicalPosition::new(g.x.unwrap_or(0), g.y.unwrap_or(0))) {
                crate::diag::warn("boot", "geometry_position_failed", e.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mon(x: i32, y: i32, w: u32, h: u32) -> MonitorRect {
        MonitorRect { x, y, width: w, height: h }
    }

    #[test]
    fn parses_the_string_the_frontend_saves() {
        let raw = json!(r#"{"x":300,"y":400,"width":1400,"height":900,"maximized":false}"#);
        assert_eq!(
            parse(Some(&raw)),
            Some(SavedGeometry { x: Some(300), y: Some(400), width: Some(1400), height: Some(900) })
        );
    }

    #[test]
    fn missing_or_broken_values_restore_nothing() {
        assert_eq!(parse(None), None);
        assert_eq!(parse(Some(&json!(null))), None);
        assert_eq!(parse(Some(&json!("not json"))), None);
        assert_eq!(parse(Some(&json!({"x": 1}))), None, "객체가 아니라 문자열로 저장된다");
    }

    #[test]
    fn position_needs_a_monitor_it_overlaps() {
        let g = SavedGeometry { x: Some(300), y: Some(400), width: Some(1400), height: Some(900) };
        assert!(on_some_monitor(&g, &[mon(0, 0, 1920, 1080)]));
        // 떼어 낸 보조 모니터 좌표 — 화면 밖으로 복원하면 창을 찾을 수 없다.
        let off = SavedGeometry { x: Some(4000), y: Some(0), width: Some(800), height: Some(600) };
        assert!(!on_some_monitor(&off, &[mon(0, 0, 1920, 1080)]));
        assert!(on_some_monitor(&off, &[mon(0, 0, 1920, 1080), mon(3840, 0, 2560, 1440)]));
    }

    // 실제 사용자 구성(옛 lib/ui.test.ts 에서 옮김): 주 모니터 0,0 3072x1728 + 위쪽 보조 0,-1440 3440x1440.
    #[test]
    fn real_layout_cases_ported_from_the_frontend() {
        let ms = [mon(0, 0, 3072, 1728), mon(0, -1440, 3440, 1440)];
        let g = |x, y, w, h| SavedGeometry { x: Some(x), y: Some(y), width: Some(w), height: Some(h) };
        assert!(on_some_monitor(&g(102, 102, 1294, 828), &ms), "주 모니터");
        assert!(on_some_monitor(&g(200, -1200, 1294, 828), &ms), "위쪽 보조 모니터의 음수 좌표");
        assert!(!on_some_monitor(&g(-32768, -32768, 964, 243), &ms), "최소화 센티널은 화면 밖");
        assert!(!on_some_monitor(&g(5000, 300, 1280, 820), &ms), "뽑힌 모니터");
        assert!(on_some_monitor(&g(-32768, -32768, 964, 243), &[]), "모니터를 모르면 옛 동작 유지");
    }

    #[test]
    fn unknown_monitors_keep_the_old_behaviour_and_negative_coords_work() {
        let g = SavedGeometry { x: Some(-1800), y: Some(100), width: Some(1600), height: Some(900) };
        assert!(on_some_monitor(&g, &[]));
        assert!(on_some_monitor(&g, &[mon(-1920, 0, 1920, 1080)]));
        let no_pos = SavedGeometry { x: None, y: None, width: Some(10), height: Some(10) };
        assert!(!on_some_monitor(&no_pos, &[mon(0, 0, 1920, 1080)]));
    }
}
