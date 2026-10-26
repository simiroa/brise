// 커맨드: window (신규) — surface_style 프리셋(flat/acrylic, 이전 이름 mica → acrylic 리네임
// 2026-07-24)을 실제 Windows 컴포지터 효과에 매핑한다. 이전 판은 "유리에 뭔가 비치게" 하려고
// 워크스페이스 배경 이미지를 앱 전체 벽지로 썼는데(오독), 사용자가 원한 건 그게 아니라 **창 자체의
// 실제 투명도**였다 — 데스크톱이 진짜로 비쳐 보여야 한다. Tauri 2 는 `Window::set_effects`로 이걸
// 기본 제공하지만, 내부에서 apply/clear 의 Result 를 그냥 버린다(tauri 크레이트
// src/vibrancy/mod.rs — `let _ =`) — Mica/Acrylic 은 Windows 11(빌드 22000+) 전용이라 구버전에서
// 실패해도 우리가 알 방법이 없고, "그레이스풀하게 flat 으로 폴백"을 못 한다. window-vibrancy 를
// 직접 호출해 Result 를 관찰함으로써 그 폴백을 구현한다.
// ⚠️ 정정(2026-09-19): apply_acrylic 은 Windows 10(17763+)에서도 SWCA 경로로 **Ok 를 돌려준다** —
// Result 만으로는 폴백이 안 됐다. 그래서 빌드 판정 가드 acrylic_supported() 를 따로 둔다.
//
// flat = 효과 없음(불투명 유지, 합성 비용 0) · acrylic = Acrylic. (glass 라는 프리셋 이름은
// 2026-07-21 제거, mica 라는 프리셋 이름은 2026-07-24 acrylic 으로 리네임 — 이 프리셋의 실제 OS
// 효과는 처음부터 Acrylic 이었다, 아래 apply_style 참고.)
// 프리셋 전환마다 매번 호출된다(flat 으로 되돌아갈 때도) — 그렇지 않으면 이전 효과가 창에 남는다.
// clear_mica 방어 호출은 남겨둔다: 실제 OS Mica 를 쓰던 구버전(mica 리네임보다도 전, 진짜 Mica
// API 를 호출하던 시절)에서 올라온 창의 잔여 Mica 를 이 버전에서 확실히 지우기 위함.
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, Window};

#[derive(Serialize)]
pub struct WindowEffectResult {
    /// true: 요청한 효과가 실제로 적용됐다(또는 flat 이라 적용할 게 없다).
    /// false: OS/빌드 미지원으로 실패 — 프런트는 data-surface 를 flat 으로 되돌려야 한다
    /// (그렇지 않으면 CSS 쪽만 "투명 모드"로 착각해 실제 Mica/Acrylic 배경 없이 빈 구멍만 남는다 —
    /// "검은 창"으로 이어지는 정확히 그 실패 모드).
    pub applied: bool,
}

/// style 문자열 → 어떤 효과를 시도할지의 순수 매핑. I/O(실제 HWND 호출)에서 분리해두면
/// "알 수 없는 값은 flat 취급" 같은 계약을 실제 창 없이도 단위 테스트할 수 있다.
#[derive(Debug, PartialEq, Eq)]
enum PresetAction {
    Acrylic,
    /// flat, 혹은 알 수 없는 값(구 "mica"/"glass" 포함) — 항상 "효과 없음"으로 수렴시킨다(허용
    /// 목록 밖 값이 조용히 미지의 효과로 새지 않도록). 프런트 load() 가 "mica"→"acrylic" 매핑을
    /// 책임지므로(settings.ts) 이 커맨드에 "mica" 가 도달하는 건 정상 경로에선 일어나지 않는다 —
    /// 그래도 안전망으로 ClearAll 에 떨어진다.
    ClearAll,
}

fn action_for_style(style: &str) -> PresetAction {
    match style {
        "acrylic" => PresetAction::Acrylic,
        _ => PresetAction::ClearAll,
    }
}

#[cfg(windows)]
fn apply_style<R: Runtime>(
    window: &Window<R>,
    style: &str,
    tint: Option<(u8, u8, u8, u8)>,
) -> bool {
    match action_for_style(style) {
        // Windows 10 가드(PLAN-2026-09-19 §4): 미지원 빌드에선 아예 걸지 않고 false 로 보고한다 —
        // 프런트가 flat 으로 내려앉고 "지원 안 됨" 배지를 띄운다.
        PresetAction::Acrylic if !acrylic_supported() => false,
        PresetAction::Acrylic => {
            // 코어 검증(2026-07-23): 실제 OS Mica 는 바탕화면 wallpaper 만 미묘하게 반영해 "뒤가
            // 비친다"는 사용자 요구를 원천적으로 못 채운다. 실제로 뒤(데스크톱/창)를 블러로 비추는
            // 건 Acrylic 이라 이 분기는 apply_acrylic 만 호출한다. clear 짝도 뒤집는다: 이전에
            // 켜져 있던(진짜) Mica 를 먼저 지운다. tint: 프런트가 테마별 고정 중립색 + 은은한
            // 알파(기본 90)를 계산해 넘긴다(settings.ts::syncWindowEffect) — None 이면 무색 acrylic.
            let _ = window_vibrancy::clear_mica(window);
            match window_vibrancy::apply_acrylic(window, tint) {
                Ok(()) => true,
                Err(_) => {
                    let _ = window_vibrancy::clear_acrylic(window);
                    false
                }
            }
        }
        PresetAction::ClearAll => {
            // flat 은 "효과 없음"이 목표이므로, 애초에 적용된 적이 없어 clear_* 가 Err 를
            // 반환하더라도 항상 성공(true)으로 본다. tint 는 acrylic 전용이라 여기선 무시.
            let _ = window_vibrancy::clear_acrylic(window);
            let _ = window_vibrancy::clear_mica(window);
            true
        }
    }
}

#[cfg(not(windows))]
fn apply_style<R: Runtime>(
    _window: &Window<R>,
    style: &str,
    _tint: Option<(u8, u8, u8, u8)>,
) -> bool {
    // Mica/Acrylic 은 Windows 전용(window-vibrancy 크레이트 자체 문서 참고). 이 앱은 Windows
    // 우선(specs/manifest.yaml stack.shell 참고)이라 다른 OS 용 효과는 이번 판 범위 밖이다 —
    // 다만 "적용됐다고 거짓 보고"는 하지 않는다: flat 은 항상 true, 그 외엔 false 로 보고해
    // 프런트가 안전하게 flat 으로 내려앉게 한다. tint 는 Windows acrylic 전용이라 무시.
    matches!(action_for_style(style), PresetAction::ClearAll)
}

/// 아크릴을 걸어도 되는 OS 인가 — 판정은 여기 한 곳(PLAN-2026-09-19 §4).
///
/// 경계 22523 은 window-vibrancy 0.6 이 DWM 시스템 백드롭(`DWMWA_SYSTEMBACKDROP_TYPE`)으로 가는
/// 빌드다. 그 아래(Windows 10 17763+ 와 초기 Windows 11 21H2)에서 `apply_acrylic` 은
/// `SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND)` 로 떨어지고 **Ok 를 돌려준다** —
/// 그래서 "Win10 에선 실패해 flat 으로 폴백"한다는 위 파일 머리 주석의 전제가 실제론 성립하지 않았고,
/// 창 이동·리사이즈 때 끌리는 그 경로가 "적용됨"으로 보고됐다. OS 이름이 아니라 **경로**로 가른다.
#[cfg(windows)]
pub fn acrylic_supported() -> bool {
    acrylic_supported_on_build(windows_version::OsVersion::current().build)
}

#[cfg(not(windows))]
pub fn acrylic_supported() -> bool {
    false
}

const ACRYLIC_MIN_BUILD: u32 = 22523;

#[cfg_attr(not(windows), allow(dead_code))]
fn acrylic_supported_on_build(build: u32) -> bool {
    build >= ACRYLIC_MIN_BUILD
}

#[derive(Serialize)]
pub struct SurfaceSupport {
    pub acrylic: bool,
}

/// 모양 페이지가 "아크릴" 칸을 열지 말지 미리 알기 위한 질의(선택 차단, §4-2).
#[tauri::command(rename_all = "snake_case")]
pub fn window_surface_support() -> SurfaceSupport {
    SurfaceSupport { acrylic: acrylic_supported() }
}

/// 이 창에 표면 효과를 걸어도 되는가. 세 규칙이 전부 여기 있다.
///
/// 1. **펫 창은 언제나 제외** — 스프라이트용 투명 창이라 Acrylic 을 얹으면 캐릭터 주변에
///    사각형 판이 생긴다.
/// 2. **부른 창은 언제나 포함** — 살아 있는 웹뷰가 스스로 요청한 것이다. 여기서 가시성을
///    따지면 show() 직후 is_visible 이 아직 false 로 보이는 순간에 걸려 본 창이 매 부팅
///    flat 으로 떨어진다(2026-08-14 에 결과를 AND 로 묶었다가 겪은 그 증상과 같은 부류).
/// 3. **그 밖의 창은 보일 때만** — 숨긴 HWND 에 window-vibrancy 를 걸면 핸들이 깨져 그 창은
///    다시는 보이지 않는다. 트레이/펫에서 메인 창이 안 열리는 버그의 정체가 이것이다.
///
/// 3번은 docs/PET.md 에 "하지 말 것"으로 오래 적혀 있었지만 **문서에만** 있었다. 지키는 것은
/// 호출부들이었고(App.tsx 는 show 뒤로 미루고 AuxWindowChrome 도 그렇다), 정작 효과를 거는
/// 이 함수는 창이 보이는지 묻지 않은 채 펫이 아닌 **모든 창**에 걸었다. 그래서 호출부를 아무리
/// 고쳐도 새 팬아웃 경로가 생길 때마다 되살아났다 — 마지막이 2026-08-14 의 별도 설정 창이다:
/// 메인이 트레이에 숨은 동안 설정 창에서 테마나 표면을 바꾸면 그 팬아웃이 숨은 메인 창의
/// 핸들을 죽였다. 규칙을 문서에서 코드로 옮긴다.
///
/// `visible` 은 `is_visible()` 의 Result 를 그대로 받는다. **판단이 불가능하면 건다** —
/// 잘못 건너뛰면 창이 아무 효과 없이 남고 그건 조용한 시각 회귀다.
///
/// ponytail: 숨어 있는 동안 바뀐 프리셋은 그 창에 반영되지 않는다 — 다시 보일 때 **이전
/// 효과 그대로** 나온다(핸들은 멀쩡하다). 죽은 창보다 낫고, 다음에 그 창이 보이는 상태에서
/// 테마·표면을 바꾸면 맞춰진다. 이게 거슬리면 show 직후 프런트가 `applySurfaceEffectAfterShow`
/// 를 한 번 더 부르게 하면 된다(tray::show_and_focus 에서 이벤트를 쏘는 자리).
pub fn should_apply_effect(label: &str, is_caller: bool, visible: Result<bool, tauri::Error>) -> bool {
    if crate::pet_window::is_pet_label(label) {
        return false;
    }
    if is_caller {
        return true;
    }
    visible.unwrap_or(true)
}

/// 표면 프리셋은 **앱 전체**의 성질이지 한 창의 성질이 아니다 — 그래서 호출한 창이 아니라 펫이
/// 아닌 모든 창에 적용한다. 2026-08-14 설정 창이 분리되면서 필요해졌다: 설정 창에서 프리셋을
/// 바꾸면 예전 구현은 **설정 창에만** 효과를 걸고 본 창은 그대로 두었다. 펫 창은 제외한다 —
/// 스프라이트용 투명 창이라 Acrylic 을 얹으면 캐릭터 주변에 사각형 판이 생긴다.
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_effect<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    style: String,
    tint: Option<(u8, u8, u8, u8)>,
) -> WindowEffectResult {
    // applied 는 **부른 창** 하나의 결과다. 그 값이 곧 그 창의 CSS 폴백 스위치이기 때문이다
    // (프런트 surfaceEffectApplied → data-surface). 다른 창들은 최선노력으로 같이 맞춘다 —
    // 하나라도 실패했다고 부른 창까지 flat 으로 떨어뜨리면, 예컨대 부팅 타이밍에 아직 준비되지
    // 않은 보조 창 하나 때문에 본 창이 통째로 flat 이 된다(2026-08-14 실측: AND 로 묶었더니
    // 부팅 직후 본 창이 항상 flat 이었다).
    let caller = window.label().to_string();
    let mut applied = false;
    for (label, target) in app.webview_windows() {
        if !should_apply_effect(&label, label == caller, target.is_visible()) {
            continue;
        }
        // WebviewWindow 가 아니라 그 안의 Window 핸들로 건다 — 부팅 직후에는 WebviewWindow
        // 핸들로 apply 하면 실패한다(2026-08-14 실측: 본 창이 매 부팅 flat 으로 떨어졌다).
        let ok = apply_style(&target.as_ref().window(), &style, tint);
        if label == caller {
            applied = ok;
        }
    }
    WindowEffectResult { applied }
}

/// 설정 창을 띄운다(이미 있으면 앞으로 가져오기만).
///
/// **반드시 async 여야 한다.** Tauri 는 동기 커맨드를 메인 스레드에서 실행하는데, 창 생성은 그
/// 메인 스레드의 이벤트 루프가 돌아야 완료된다 — 동기로 두면 교착한다: 창 껍데기는 만들어지고
/// 웹뷰는 about:blank 에서 멈추며(흰 화면) invoke 프로미스는 영영 돌아오지 않는다(2026-08-14
/// CDP 로 확인). 펫 창이 이 함정을 안 밟은 건 커맨드가 아니라 트레이 핸들러와 setup() 에서만
/// 만들어지기 때문이다.
///
/// 설정이 모달이 아니라 **별도 OS 창**인 이유(2026-08-14): 본 창이 `transparent: true` 라
/// WebView2 가 `backdrop-filter: blur()` 를 화면에 반영하지 않는다(계산된 스타일에는 들어 있지만
/// 픽셀은 그대로 — transparent 를 false 로 바꾸면 같은 CSS 로 즉시 블러가 걸린다). 그 투명 창은
/// 네이티브 Acrylic(창 뒤가 비치는 재질)의 전제라 둘은 상호 배타다. 반면 Acrylic 창은 자기 뒤에
/// 있는 것을 실제로 블러하므로(다른 창 포함, 실측 확인), 설정을 별도 Acrylic 창으로 띄우면
/// 컴포지터가 본 창을 흐려준다 — CSS 가 못 하는 유리를 OS 가 대신 해준다.
///
/// `page`(2026-09-27): 그 설정 페이지로 연다(딥링크, 예 `"ai"`·`"ai_presets"`). 없거나 모르는 id 면 예전처럼
/// 첫 페이지. 새 창은 URL 쿼리로, 이미 열린 창은 이벤트로 받는다(settings_window.rs).
/// `anchor`: 그 페이지 안 블록으로 스크롤+강조(`settings-anchor-<anchor>`). page 없이는 무시.
#[tauri::command(rename_all = "snake_case")]
pub async fn settings_window_open<R: Runtime>(
    app: AppHandle<R>,
    page: Option<String>,
    anchor: Option<String>,
) -> Result<(), String> {
    crate::settings_window::ensure_settings_window(&app, page.as_deref(), anchor.as_deref()).map_err(|e| e.to_string())
}

/// 활동 이력 창을 띄운다(이미 있으면 앞으로 가져오기만).
///
/// **반드시 async 여야 한다** — settings_window_open 과 같은 교착 함정(동기 커맨드 = 흰 화면).
#[tauri::command(rename_all = "snake_case")]
pub async fn activity_window_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::activity_window::ensure_activity_window(&app).map_err(|e| e.to_string())
}

/// AI 히스토리 창을 띄운다(이미 있으면 앞으로 가져오기만).
///
/// **반드시 async 여야 한다** — settings_window_open 과 같은 교착 함정(동기 커맨드 = 흰 화면).
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_history_window_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::ai_history_window::ensure_ai_history_window(&app).map_err(|e| e.to_string())
}

/// 브리핑 창(#/briefing)을 띄운다 — 이미 있으면 앞으로 가져오기만(briefing_window.rs).
/// 예전 `edit` 인자(창 안 편집 모드)는 브리핑 재작성으로 없어졌다(PLAN-2026-10-19-briefing-rewrite §9.1).
///
/// **반드시 async 여야 한다** — settings_window_open 과 같은 교착 함정(동기 커맨드 = 흰 화면).
#[tauri::command(rename_all = "snake_case")]
pub async fn briefing_window_open<R: Runtime>(app: AppHandle<R>, mode: Option<String>) -> Result<(), String> {
    crate::briefing_window::ensure_briefing_window(&app, mode.as_deref()).map_err(|e| e.to_string())
}

/// 섹션 하나를 별도 OS 창(`section-<id>`)으로 띄운다 — 이미 있으면 앞으로 가져오기만(section_window.rs).
///
/// **반드시 async 여야 한다** — settings_window_open 과 같은 교착 함정(동기 커맨드 = 흰 화면).
#[tauri::command(rename_all = "snake_case")]
pub async fn section_window_open<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    section_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<serde_json::Value, String> {
    // x·y = 탭을 창 밖으로 끌어 놓은 화면 좌표(논리 px, 2단계). 둘 다 있을 때만 위치를 쓴다.
    let at = x.zip(y);
    crate::section_window::ensure_section_window(&app, &note_id, &section_id, &title, at)?;
    Ok(serde_json::json!({ "opened": true }))
}

/// 분리 창 닫기(본 창의 "여기로 되돌리기", 스냅샷 복원 전 닫기). 창이 저장을 끝내고 스스로 파괴될
/// 때까지 기다렸다 돌아온다 — 멈춘 창은 시간 초과 뒤 강제 파괴(section_window::close_and_wait).
/// 파괴 때 `section-window-changed { open: false }` 가 나간다. 창이 없었으면 closed=false.
#[tauri::command(rename_all = "snake_case")]
pub async fn section_window_close<R: Runtime>(app: AppHandle<R>, section_id: String) -> Result<serde_json::Value, String> {
    let closed = !crate::section_window::close_and_wait(&app, vec![section_id], "close").await.is_empty();
    Ok(serde_json::json!({ "closed": closed }))
}

/// 지금 분리돼 있는 섹션 id 목록 — 창 존재가 단일 진실이라 저장된 상태가 아니라 창 목록에서 읽는다.
#[tauri::command(rename_all = "snake_case")]
pub async fn section_window_list<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "section_ids": crate::section_window::open_section_ids(&app) }))
}

/// 창 닫기 요청 시 프론트엔드의 비동기 flushAll()이 완료된 후 최종적으로 안전하게 닫거나 트레이로 숨긴다.
#[tauri::command(rename_all = "snake_case")]
pub async fn window_close_confirmed(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let is_main = window.label() == "main";
    if is_main {
        // 트레이 "종료" 가 이 닫기를 요청했으면(tray::request_quit) 설정과 무관하게 끝낸다 — 숨기면 종료가 안 된다.
        if crate::tray::close_to_tray_setting(&app) && !crate::tray::quit_requested(&app) {
            crate::tray::hide_to_tray(&app);
        } else {
            // 본 창은 이미 flushAll 했다 — 분리 창들도 저장을 끝내게 한 뒤 끈다(DB 락을 잡기 **전**에).
            crate::tray::exit_after_flush(&app).await;
        }
    } else {
        let _ = window.destroy();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acrylic_blocked_below_dwm_backdrop_build() {
        assert!(!acrylic_supported_on_build(19045)); // Windows 10 22H2
        assert!(!acrylic_supported_on_build(22000)); // Windows 11 21H2 — 같은 SWCA 경로
        assert!(acrylic_supported_on_build(22523));
        assert!(acrylic_supported_on_build(26100));
    }

    #[test]
    fn acrylic_maps_to_acrylic() {
        assert_eq!(action_for_style("acrylic"), PresetAction::Acrylic);
    }

    #[test]
    fn flat_maps_to_clear_all() {
        assert_eq!(action_for_style("flat"), PresetAction::ClearAll);
    }

    // ── 숨긴 창에 효과를 걸지 않는다 ────────────────────────────────────────────────
    // 트레이/펫에서 메인 창이 안 열리던 버그. 숨긴 HWND 에 window-vibrancy 를 걸면 핸들이
    // 깨진다. 규칙이 docs/PET.md 에만 있고 코드에 없어서, 호출부를 고쳐도 새 팬아웃 경로가
    // 생길 때마다 되살아났다.

    #[test]
    fn hidden_window_is_skipped() {
        assert!(!should_apply_effect("main", false, Ok(false)));
    }

    #[test]
    fn visible_window_gets_effect() {
        assert!(should_apply_effect("main", false, Ok(true)));
    }

    #[test]
    fn caller_is_never_gated_on_visibility() {
        // 부팅 직후 show() 직후의 is_visible 이 아직 false 로 보여도 본 창은 flat 으로
        // 떨어지면 안 된다.
        assert!(should_apply_effect("main", true, Ok(false)));
    }

    #[test]
    fn unknown_visibility_falls_back_to_applying() {
        assert!(should_apply_effect(
            "main",
            false,
            Err(tauri::Error::WebviewNotFound)
        ));
    }

    #[test]
    fn pet_window_is_always_excluded() {
        // is_pet_label 이 참인 라벨이면 무엇이든 제외된다.
        let pet = "pet";
        assert!(crate::pet_window::is_pet_label(pet));
        assert!(!should_apply_effect(pet, false, Ok(true)));
        assert!(!should_apply_effect(pet, true, Ok(true)));
    }

    #[test]
    fn unknown_style_falls_back_to_clear_all_not_some_default_effect() {
        // 허용 목록 밖 값(오타, 제거된 "glass"/"mica", 미래 값 등)이 조용히 어떤 효과로도 새지
        // 않는다는 계약 — validate_setting 이 이미 "flat"|"acrylic" 만 허용하고 프런트 load() 가
        // 구 DB 값 "mica"를 "acrylic"으로 매핑하지만, 버전이 어긋나는 과도기에도 이 커맨드가
        // 안전한 기본값(ClearAll)으로 수렴해야 한다 — "mica" 리네임 전 이름도 여기 포함된다.
        assert_eq!(action_for_style("mica"), PresetAction::ClearAll);
        assert_eq!(action_for_style("sepia"), PresetAction::ClearAll);
        assert_eq!(action_for_style(""), PresetAction::ClearAll);
    }
}
