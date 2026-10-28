//! 보조 OS 창(설정 / 활동 이력 / AI 히스토리)의 공통 생성.
//!
//! 이 셋은 모달이 아니라 **별도 OS 창**이다(2026-08-14). 이유는
//! commands/window.rs::settings_window_open 의 문서 주석과 같다(요약: 본 창이 투명 창이라
//! WebView2 가 CSS backdrop blur 를 화면에 반영하지 않는데, 투명 창은 네이티브 Acrylic 의 전제라
//! 둘을 동시에 가질 수 없다. Acrylic 창은 자기 뒤에 있는 창을 실제로 블러하므로, 오래 열어 두고
//! 뒤 앱을 보는 표면은 별도 Acrylic 창으로 띄운다).
//!
//! 창 자체는 펫 창(pet_window.rs)과 같은 방식이다: 프런트는 `index.html#/<route>` 해시로
//! 라우팅되고(src/main.tsx), 크롬(제목/닫기/드래그)은 데코레이션 없이 React 가 그린다
//! (`src/components/AuxWindowChrome.tsx`). 다만 펫과 달리 **커맨드 제한이 없다** — 이 창들은
//! 설정·이력·AI 히스토리까지 만지므로 본 창과 같은 권한으로 돈다(lib.rs 의 게이트는 펫 라벨만 본다).

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 본 창 라벨 — tauri.conf.json 의 windows[0] 에 label 이 없으면 Tauri 가 "main" 을 쓴다.
const MAIN_LABEL: &str = "main";

/// 고정 창(설정/이력/AI 히스토리)은 `'static` 리터럴을 그대로 넘긴다. 라벨·제목이 런타임에 정해지는
/// 창(섹션 분리 창 `section-<id>`, section_window.rs)은 빌려 온 `&str` 을 넘긴다 — 그래서 수명 인자다.
pub struct AuxWindowSpec<'a> {
    pub label: &'a str,
    pub title: &'a str,
    /// 예: `"index.html#/settings"`
    pub url: &'a str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// Idempotent: existing window → unminimize + show + focus. New → decorations(false),
/// transparent(true), center, skip_taskbar, visible(false)(프런트가 그린 뒤 show), Windows `owner(main)` NOT `parent()`.
pub fn ensure_owned_window<R: Runtime>(app: &AppHandle<R>, spec: &AuxWindowSpec<'_>) -> tauri::Result<()> {
    ensure_owned_window_at(app, spec, spec.url)
}

/// `ensure_owned_window` 와 같되, **새로 만들 때만** `url` 로 연다(이미 있는 창은 URL 을 바꾸지 않고
/// 앞으로 가져오기만 한다 — 열린 창에 뭔가를 알려야 하면 호출자가 이벤트로 보낸다). 설정 창의 페이지
/// 딥링크(settings_window::ensure_settings_window)가 `index.html?page=<id>#/settings` 를 넘긴다.
pub fn ensure_owned_window_at<R: Runtime>(app: &AppHandle<R>, spec: &AuxWindowSpec<'_>, url: &str) -> tauri::Result<()> {
    ensure_owned_window_placed(app, spec, url, None)
}

/// `ensure_owned_window_at` 과 같되 새 창의 좌상단을 `position` 에 둔다(없으면 center). 좌표는
/// tao 규약의 "논리" px — tao 가 모니터마다 그 모니터 배율로 물리 변환해 들어맞는 모니터를 고른다
/// (섹션 분리 창의 끌어 놓기 위치, section_window::place_near_cursor 가 계산한다).
pub fn ensure_owned_window_placed<R: Runtime>(
    app: &AppHandle<R>,
    spec: &AuxWindowSpec<'_>,
    url: &str,
    position: Option<(f64, f64)>,
) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(spec.label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .decorations(false)
        // 본 창과 같은 조건 — 네이티브 Acrylic 은 투명 창을 전제한다. 프런트가 부팅 직후
        // window_set_effect 를 호출해 현재 프리셋을 이 창에도 건다(settings.ts::load).
        .transparent(true)
        // 작업표시줄에 두 번째 항목으로 뜨지 않게 — 보조 창은 본 창에 딸린다.
        .skip_taskbar(true)
        // 숨긴 채로 만든다 — 보이는 채로 만들면 웹뷰가 준비되는 과정(빈 회색 창 → index.html 의
        // 불투명 부팅색 → 아크릴 없이 뚫린 투명 창 → 완성)이 첫 열기마다 ~1초 동안 그대로 보였다
        // (2026-10-22 60fps 데스크톱 캡처로 확인). 프런트 AuxWindowChrome 이 설정을 읽고 한 프레임을
        // 그린 뒤 show() → 아크릴 순서로 드러낸다. 아크릴은 숨긴 HWND 에 걸면 안 되므로(commands/
        // window.rs::effect_decision) 반드시 show() 뒤다. 프런트가 못 부르면 watch_reveal 이 띄운다.
        .visible(false);
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut builder = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    // 소유자 창을 지정하면 Windows 가 이 창을 본 창 위에 유지한다(always_on_top 과 달리 다른 앱
    // 위로는 올라가지 않는다). 본 창을 못 찾으면 소유자 없이 만든다 — 그래도 열리긴 해야 한다.
    //
    // **`parent()` 가 아니라 `owner()`** 다. Tauri 2 의 `parent()` 는 WS_CHILD 자식 창을 만든다 —
    // 부모 클라이언트 영역에 클리핑되는 창이라 독립 top-level 창처럼 굴지 않고, 실제로 웹뷰가
    // URL 로 이동조차 하지 않았다(창은 뜨는데 about:blank 인 채로 흰 화면 — CDP 로 확인,
    // 2026-08-14). `owner()` 는 z-order 소유 관계만 맺는다.
    #[cfg(windows)]
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        builder = builder.owner(&main)?;
    }

    builder.build()?;
    watch_reveal(app, spec.label, 3000, false);
    Ok(())
}

/// 숨긴 채 만든 창을 프런트가 다 그린 뒤 show() 한다(보조 창은 위 `.visible(false)`, 다시 만든 본 창은
/// tray::rebuild_main_window). 이 함수는 그 show 를 지켜본다:
/// - 보이면 `focus` 일 때 포커스를 준다 — 다시 만든 본 창은 트레이에서 연 것이라 앞으로 와야 하는데,
///   프런트의 show() 는 포커스를 주지 않는다(받아야 할 쪽이 숨어 있던 사이 다른 앱이 가져갔다).
/// - `timeout_ms` 안에 안 보이면(JS 예외·행) 띄우고 기록한다 — 본 창의 부팅 failsafe(lib.rs H2)와 같은 이유.
/// 그 사이 창이 사라졌으면(닫힘) 아무것도 안 한다.
/// ponytail: 프런트가 일부러 숨긴 상태(닫기 = hide)와 구분하지 않는다 — 창을 연 뒤 timeout 안에
/// 닫아야만 다시 뜬다. 문제가 되면 "프런트가 한 번이라도 show 했다" 플래그를 커맨드로 세운다.
pub(crate) fn watch_reveal<R: Runtime>(app: &AppHandle<R>, label: &str, timeout_ms: u64, focus: bool) {
    let handle = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let step = std::time::Duration::from_millis(50);
        let mut waited = 0u64;
        loop {
            let Some(w) = handle.get_webview_window(&label) else { return };
            if w.is_visible().unwrap_or(false) {
                if focus {
                    let _ = w.set_focus();
                }
                return;
            }
            if waited >= timeout_ms {
                crate::diag::warn("aux_window", "window_force_shown", &label);
                let _ = w.show();
                if focus {
                    let _ = w.set_focus();
                }
                return;
            }
            tokio::time::sleep(step).await;
            waited += 50;
        }
    });
}
