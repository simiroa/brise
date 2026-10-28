// 트레이 상주 — 창을 닫을 때(X) settings.close_to_tray(기본 true)에 따라 트레이로 숨기거나 실제
// 종료한다. lib.rs::run() 의 setup()(부팅 시 트레이를 만든다)과 on_window_event(CloseRequested)
// (매 이벤트마다 close_to_tray_setting 을 다시 읽어 hide_to_tray 또는 app.exit(0) 중 하나를 고른다)
// 만 이 모듈을 부른다 — 그 외 어디서도 트레이를 만들지 않는다.
//
// 2026-08-01: close_to_tray 설정(sync beta 트랙, 8432aa7)에 물려 있던 opt-in 게이팅을 한 번
// 걷어냈다(기본값이 false라 새 설치/기존 사용자 모두 X 를 누르면 그냥 종료됐다 — 과제 신고 증상
// 그대로). 2026-08-06: 오너 승인으로 되살린다 — 이번엔 기본값을 true로 뒤집어서
// (settings_schema.rs::default_settings) 그 사이의 무조건 동작과 같은 결과를 기본값으로 유지하면서,
// 설정 > 펫 카드의 체크박스로 사용자가 다시 끌 수 있게 한다. hide_to_tray() 자체는 여전히 무조건
// 함수(호출되면 항상 숨긴다) — 게이팅은 호출부인 lib.rs 의 CloseRequested 핸들러가 진다
// (close_to_tray_setting/close_to_tray_from_settings, 아래).
//
// 2026-08-02 (5A): 트레이 메뉴 문구는 예전엔 한국어 하드코딩이었다. 앱 UI 로케일(ko/en/fr,
// settings.ui_lang)에 맞춘 최소 문자열 테이블로 읽는다. 동기화 상태 항목 자체는 이미 있음(우클릭).
use crate::commands::AppState;
use crate::pet_window;
use crate::sync_server::SyncState;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

/// tray::reconcile 이 emit_to("main", "pet-enabled-changed", ..)로 쏘는 페이로드(W8-g 2단계
/// 노출 모델). App.tsx/PetSection.tsx 둘 다 이 두 값을 함께 받아야 한다 — 마스터
/// (enabled)만 실어 보내던 이전 bool 페이로드로는 표시/숨김(visible)을 표현할 수 없다.
#[derive(Clone, Copy, serde::Serialize)]
struct PetState {
    enabled: bool,
    visible: bool,
}

const TRAY_ID: &str = "main-tray";
const OPEN_ID: &str = "tray-open";
const PET_TOGGLE_ID: &str = "tray-pet-toggle";
const COPY_URL_ID: &str = "tray-copy-url";
const QUIT_ID: &str = "tray-quit";
const CLIPBOARD_ID: &str = "tray-clipboard";
const CAPTURE_ID: &str = "tray-capture";
/// 챗 "새 세션 열기" — 사이드바 챗 도구 메뉴 "새 세션"과 같은 커맨드(commands::pet::pet_session_new).
const NEW_SESSION_ID: &str = "tray-chat-new-session";
/// 트레이/펫 메뉴의 "클립보드 저장"·"화면 저장"(펫이 떠 있을 때)을 펫 웹뷰에 넘기는 이벤트.
/// 페이로드 `{ action: "clipboard", text } | { action: "capture" }` — PetApp.tsx 가 듣는다.
const PET_MENU_RUN: &str = "pet-menu-run";

/// 트레이의 "동기화 상태" 항목(비활성 정보용), "접속 주소 복사" 항목, "펫 표시/숨기기" 체크 항목 핸들
#[derive(Default)]
pub struct TrayHandles {
    pub sync_item: parking_lot::Mutex<Option<MenuItem<Wry>>>,
    pub copy_url_item: parking_lot::Mutex<Option<MenuItem<Wry>>>,
    pub pet_item: parking_lot::Mutex<Option<CheckMenuItem<Wry>>>,
    /// lib.rs 의 H2 부팅 failsafe가 "의도적으로 트레이에 숨긴 창"과 "웹뷰가 아직 show()를 못 부른
    /// 창"을 구분하는 플래그. hide_to_tray()(아래)가 유일한 set 지점 — 모든 트레이 숨김 경로가
    /// 그 함수를 거치므로(현재 유일한 호출부는 commands/window.rs::window_close_confirmed) 거기
    /// 한 곳에서만 세팅하면 된다. failsafe 는 부팅 후 한 번만 읽으므로 되돌릴 필요는 없다.
    pub hidden_to_tray: std::sync::atomic::AtomicBool,
    /// 트레이 "종료" 가 눌렸다 — `request_quit` 이 유일한 set 지점. window_close_confirmed 가 이걸 보고
    /// close_to_tray 설정과 무관하게 트레이로 숨기는 대신 종료한다(AUDIT-2026-10-23 R2).
    pub quit_requested: std::sync::atomic::AtomicBool,
    /// `exit_after_flush` 에 들어섰다 — 정상 경로(창 확인)와 트레이 종료의 시간 초과 경로가 겹쳐도 한 번만
    /// 끝내고, 분리 창 저장을 기다리는 중에 시간 초과가 거짓 `quit_flush_timeout` 을 남기지 않게 한다.
    pub exiting: std::sync::atomic::AtomicBool,
    /// 본 창이 트레이에 숨어 있는 동안 표면 효과(아크릴)를 보류한다 — `hide_to_tray` 가 세우고
    /// `show_and_focus` 가 내린다. 위 `hidden_to_tray` 는 부팅 failsafe 전용이라 한 번 서면 안 내리므로
    /// 이 용도로 못 쓴다. 판정·보류는 commands::window::window_set_effect 가 한다(거기 `effect_decision`).
    pub main_effect: parking_lot::Mutex<crate::commands::window::MainEffectGate>,
}

/// 트레이 "종료" 가 본 창의 닫기 확인(flushAll → window_close_confirmed)을 기다리는 상한. 평소 flush 는 로컬 IPC
/// 몇 번이라 수십 ms. 넘기면 웹뷰가 멈춘/백지 상태로 보고 미저장 편집을 포기하고 끈다 — 앱이 안 꺼지는 쪽보다 낫다.
const QUIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 트레이 "종료" 가 눌린 뒤인가 — window_close_confirmed 가 숨김/종료를 가를 때 읽는다.
pub fn quit_requested(app: &AppHandle) -> bool {
    app.try_state::<TrayHandles>()
        .map(|h| h.quit_requested.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false)
}

/// 트레이 "종료" — 본 창의 미저장 편집을 **먼저 저장**한다(AUDIT-2026-10-23 R2. 예전엔 분리 창만 flush 하고
/// 본 창의 마지막 700ms 디바운스 편집은 버렸다). 본 창에 닫기를 요청하면 프런트의 onCloseRequested
/// (src/lib/invoke.ts)가 flushAll 뒤 window_close_confirmed 를 부르고, 거기서 `quit_requested` 를 보고
/// 트레이로 숨기는 대신 `exit_after_flush` 로 끝낸다. 웹뷰가 죽어 그 확인이 QUIT_TIMEOUT 안에 안 오면 여기서
/// 직접 `exit_after_flush` — 본 창 편집은 포기하되(진단 기록) 앱이 안 꺼지는 일은 없게. 두 번 눌러도 한 번만.
pub fn request_quit(app: &AppHandle) {
    let already = app
        .try_state::<TrayHandles>()
        .map(|h| h.quit_requested.swap(true, std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false);
    if already {
        return;
    }
    let requested = app.get_webview_window("main").map(|w| w.close().is_ok()).unwrap_or(false);
    // 이 콜백은 메인 스레드라 여기서 기다리면 창 닫기 이벤트가 돌 루프를 막는다 — 비동기 태스크로 넘긴다.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if requested {
            tokio::time::sleep(QUIT_TIMEOUT).await;
            let exiting = app
                .try_state::<TrayHandles>()
                .map(|h| h.exiting.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap_or(false);
            if exiting {
                return; // 본 창이 확인을 보냈고 종료가 진행 중이다(분리 창 저장 대기 등).
            }
            crate::diag::warn(
                "tray",
                "quit_flush_timeout",
                "main window did not confirm close within the quit timeout; exiting without its pending edits",
            );
        }
        exit_after_flush(&app).await;
    });
}

/// 종료의 마지막 구간 — 분리 창 저장 → WAL 체크포인트 → 정상 종료 마커 → exit. 본 창의 flush 는 호출자가
/// 끝냈거나 포기한 뒤다. window_close_confirmed(창 X) 와 트레이 종료가 이 한 경로를 공유한다.
pub async fn exit_after_flush(app: &AppHandle) {
    if let Some(h) = app.try_state::<TrayHandles>() {
        if h.exiting.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
    }
    crate::section_window::close_all_before_exit(app).await;
    if let Some(state) = app.try_state::<AppState>() {
        let conn = state.db.lock();
        let _ = conn.pragma_update(None, "wal_checkpoint", "PASSIVE");
        let _ = std::fs::write(state.data_dir.join(crate::db::CLEAN_SHUTDOWN_MARKER), b"ok");
    }
    app.exit(0);
}

/// settings 테이블에서 단일 키를 읽는다 — AppState 미준비/조회 실패는 조용히 `None`(호출자가
/// 각자의 fail-safe 기본값으로 폴백).
fn setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    let state = app.try_state::<AppState>()?;
    let conn = state.db.lock();
    crate::repo::settings::get_all(&conn).ok()?.get(key).cloned()
}

/// settings.ui_lang → tray 문구 로케일. 알 수 없거나 AppState 미준비면 ko(시드 기본값과 동일).
fn read_ui_lang(app: &AppHandle) -> String {
    setting(app, "ui_lang")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| matches!(s.as_str(), "en" | "fr" | "ko"))
        .unwrap_or_else(|| "ko".to_string())
}

/// Minimal tray string table (ko/en/fr). Not the full frontend i18n JSON — tray is Rust-only.
#[derive(Clone, Copy)]
struct TrayStrings {
    open: &'static str,
    quit: &'static str,
    sync_running_prefix: &'static str, // "... @ {addr}"
    sync_off: &'static str,
    copy_url: &'static str,
    pet_toggle: &'static str,
    clipboard: &'static str,
    capture: &'static str,
    new_session: &'static str,
    /// 화면 저장 OS 알림 제목 — 본문은 저장 경로(성공) 또는 오류 문구(실패).
    capture_saved: &'static str,
    capture_failed: &'static str,
}

fn tray_strings(lang: &str) -> TrayStrings {
    match lang {
        "en" => TrayStrings {
            open: "Open",
            quit: "Quit",
            sync_running_prefix: "Sync status: running @ ",
            sync_off: "Sync status: off",
            copy_url: "Copy access URL",
            pet_toggle: "Show/Hide Pet",
            clipboard: "Save clipboard",
            capture: "Save screen",
            new_session: "Start new session",
            capture_saved: "Screen saved",
            capture_failed: "Couldn't save the screen",
        },
        "fr" => TrayStrings {
            open: "Ouvrir",
            quit: "Quitter",
            sync_running_prefix: "État de la sync : en cours @ ",
            sync_off: "État de la sync : désactivée",
            copy_url: "Copier l'URL d'accès",
            pet_toggle: "Afficher/Masquer l'animal",
            clipboard: "Enregistrer le presse-papiers",
            capture: "Enregistrer l'écran",
            new_session: "Nouvelle session",
            capture_saved: "Écran enregistré",
            capture_failed: "Impossible d'enregistrer l'écran",
        },
        // ko (default)
        _ => TrayStrings {
            open: "열기",
            quit: "종료",
            sync_running_prefix: "동기화 상태: 실행 중 @ ",
            sync_off: "동기화 상태: 꺼짐",
            copy_url: "접속 주소 복사",
            pet_toggle: "펫 표시/숨기기",
            clipboard: "클립보드 저장",
            capture: "화면 저장",
            new_session: "새 세션 열기",
            capture_saved: "화면을 저장했어요",
            capture_failed: "화면을 저장하지 못했어요",
        },
    }
}

fn is_sync_running(app: &AppHandle) -> bool {
    let Some(sync_state) = app.try_state::<SyncState>() else {
        return false;
    };
    let guard = sync_state.0.lock();
    guard.as_ref().map(|r| !r.handle.inner().is_finished()).unwrap_or(false)
}

fn sync_status_label(app: &AppHandle) -> String {
    let strings = tray_strings(&read_ui_lang(app));
    let Some(sync_state) = app.try_state::<SyncState>() else {
        return strings.sync_off.to_string();
    };
    let guard = sync_state.0.lock();
    match guard.as_ref() {
        Some(r) if !r.handle.inner().is_finished() => format!("{}{}", strings.sync_running_prefix, r.addr),
        _ => strings.sync_off.to_string(),
    }
}

/// 본 창 라벨 — tauri.conf.json 의 windows[0] 에 label 이 없으면 Tauri 가 "main" 을 쓴다
/// (aux_window.rs 의 MAIN_LABEL 과 같은 값).
pub(crate) const MAIN_LABEL: &str = "main";

/// 파괴된 본 창을 tauri.conf.json 의 windows[0] 과 같은 조건으로 다시 만든다.
///
/// conf 는 `visible: false` 로 만들고 프런트가 준비되면 show() 하지만, 여기서는 **보이게** 만든다 —
/// 사용자가 트레이를 눌러 명시적으로 연 상황이라 웹뷰가 또 뻗더라도 창은 떠 있어야 한다.
/// 위치·크기는 아래에서 window_geometry 설정으로 복원하므로(window_geometry.rs) center() 는 저장값이 없을 때의 폴백이다.
fn rebuild_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let w = tauri::WebviewWindowBuilder::new(app, MAIN_LABEL, tauri::WebviewUrl::App("index.html".into()))
        .title("Brise")
        .inner_size(1280.0, 820.0)
        .decorations(false)
        .transparent(true)
        .center()
        // 숨긴 채 만든다 — 부팅 시퀀스(bootWindow.ts::applyThemeGeometryAndShow)가 테마·지오메트리를
        // 입히고 한 프레임 그린 뒤 스스로 show() 한다(tauri.conf.json 의 첫 본 창과 같은 계약).
        // 보이는 채로 만들던 때는 트레이에서 열 때마다 흰 창 → 불투명 부팅색 → 화면이 ~1초 보였다
        // (2026-10-22 캡처). 포커스와 failsafe 는 호출자가 aux_window::watch_reveal 로 건다.
        .visible(false)
        .build()?;
    // 부팅과 같은 규칙으로 크기·위치를 숨긴 채 복원한다(window_geometry.rs) — 프런트는 최대화만 한다.
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        let settings = {
            let conn = state.db.lock();
            crate::repo::settings::get_all(&conn).unwrap_or_default()
        };
        crate::window_geometry::restore(&w, settings.get("window_geometry"));
    }
    Ok(w)
}

/// 누가 본 창을 열었나 — `tray/reveal_state` 진단에 싣는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealVia {
    TrayClick,
    TrayDoubleClick,
    TrayMenu,
    SecondInstance,
    Pet,
}

impl RevealVia {
    fn as_str(self) -> &'static str {
        match self {
            RevealVia::TrayClick => "tray_click",
            RevealVia::TrayDoubleClick => "tray_double_click",
            RevealVia::TrayMenu => "tray_menu",
            RevealVia::SecondInstance => "second_instance",
            RevealVia::Pet => "pet",
        }
    }
}

/// 숨어 있는 동안 보류한 표면 효과를 show 뒤에 건 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeferredEffect {
    /// 보류분이 없었다.
    None,
    Applied,
    /// 걸었지만 apply_style 이 false(미지원·실패) — 또는 메인 스레드로 못 넘겼다.
    Failed,
    /// 창을 다시 만들어서 버렸다 — 새 웹뷰의 부팅이 현재 설정으로 다시 건다.
    Dropped,
}

impl DeferredEffect {
    fn as_str(self) -> &'static str {
        match self {
            DeferredEffect::None => "none",
            DeferredEffect::Applied => "applied",
            DeferredEffect::Failed => "failed",
            DeferredEffect::Dropped => "dropped",
        }
    }
}

/// 열기 뒤 본 창의 상태를 확인할 때까지 기다리는 시간. show 는 메인 스레드로 넘어가 비동기로 처리되므로
/// 바로 읽으면 아직 숨김으로 보인다.
const REVEAL_STATE_DELAY: std::time::Duration = std::time::Duration::from_millis(300);
/// 다시 만든 본 창은 프런트 부팅이 show 하고, 못 하면 watch_reveal 이 이 시간 뒤에 띄운다.
const REBUILD_REVEAL_TIMEOUT_MS: u64 = 5000;

/// `tray/reveal_state` 한 줄 — 순수 함수라 창 없이 테스트한다. 정상(보임·최소화 아님·맨 앞)이면 Info,
/// 하나라도 어긋나거나 읽지 못했으면 Warn. 메시지는 상태 플래그만 — 경로·노트 내용은 없다(CLAUDE.md 함정 11).
fn reveal_state_entry(
    via: RevealVia,
    rebuilt: bool,
    effect: DeferredEffect,
    visible: Option<bool>,
    minimized: Option<bool>,
    foreground: Option<bool>,
) -> (crate::diag::Level, String) {
    let ok = visible == Some(true) && minimized == Some(false) && foreground == Some(true);
    let flag = |v: Option<bool>| match v {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    };
    let message = format!(
        "via={} rebuilt={rebuilt} visible={} minimized={} foreground={} deferred_effect={}",
        via.as_str(),
        flag(visible),
        flag(minimized),
        flag(foreground),
        effect.as_str(),
    );
    let level = if ok { crate::diag::Level::Info } else { crate::diag::Level::Warn };
    (level, message)
}

/// 열기 `delay` 뒤 본 창 상태를 한 번 기록한다. 열기의 각 호출(show·set_focus 등)은 OS 수준에서 실패해도
/// Err 를 돌려주지 않아(tao 의 set_visible 은 반환값이 없다) 릴리스에서 "트레이로 안 열림"이 흔적 없이
/// 지나갔다(2026-10-28 조사) — 보였는지·최소화인지·앞에 왔는지를 사후에 읽어 남긴다. 창 getter 는 메인
/// 스레드 왕복이라 메인 스레드를 막지 않게 비동기 태스크에서 읽는다.
/// ponytail: 웹뷰가 실제로 그리는지(투명·빈 창)는 못 본다 — 웹뷰 왕복(eval→IPC 응답)으로 재려면 프런트에
/// 응답 경로가 필요하다. 이 기록이 "visible=true foreground=true 인데 안 보였다"를 보이면 그때 붙인다.
fn schedule_reveal_state(
    app: &AppHandle,
    via: RevealVia,
    rebuilt: bool,
    effect: DeferredEffect,
    delay: std::time::Duration,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let Some(w) = app.get_webview_window(MAIN_LABEL) else {
            crate::diag::warn(
                "tray",
                "reveal_state",
                format!(
                    "via={} rebuilt={rebuilt} window=gone deferred_effect={}",
                    via.as_str(),
                    effect.as_str()
                ),
            );
            return;
        };
        let (level, message) = reveal_state_entry(
            via,
            rebuilt,
            effect,
            w.is_visible().ok(),
            w.is_minimized().ok(),
            is_foreground(&w),
        );
        crate::diag::record(level, "tray", "reveal_state", message);
    });
}

/// 본 창이 지금 맨 앞(전경) 창인가 — reveal_state 가 "열렸지만 다른 창 뒤"를 가르는 값. Windows 는 Win32
/// `GetForegroundWindow` 를 HWND 와 비교한다. Tauri `is_focused()` 를 쓰지 않는 이유: tao 의 그 값은 최상위
/// HWND 의 WM_SETFOCUS/WM_KILLFOCUS 를 따르는데, wry 가 WM_SETFOCUS 마다 키보드 포커스를 WebView2 자식으로
/// 넘겨(`MoveFocus`) 최상위 HWND 가 곧바로 WM_KILLFOCUS 를 받는다 — 맨 앞에 뜬 정상 창도 false 로 읽힌다.
/// 선언 하나라 crate 를 들이지 않는다(user32 는 Windows 바이너리가 이미 링크한다). `hwnd()` 를 못 읽으면 unknown.
#[cfg(windows)]
fn is_foreground(w: &tauri::WebviewWindow) -> Option<bool> {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut core::ffi::c_void;
    }
    let hwnd = w.hwnd().ok()?.0 as *mut core::ffi::c_void;
    // SAFETY: 인자 없는 순수 조회 — 전경 창 핸들(없으면 null)을 돌려줄 뿐 메모리·프로세스 상태를 건드리지 않는다.
    let foreground = unsafe { GetForegroundWindow() };
    Some(foreground == hwnd)
}

/// Windows 밖에는 같은 방식의 전경 창 조회가 없어 Tauri `is_focused()` 로 채운다 — 진단 문구의 필드 이름은
/// 플랫폼과 무관하게 `foreground` 로 둔다(이 앱의 배포 대상은 Windows 뿐이라 이 갈래는 컴파일 유지용).
#[cfg(not(windows))]
fn is_foreground(w: &tauri::WebviewWindow) -> Option<bool> {
    w.is_focused().ok()
}

/// 표시 쪽 관문 — 보류 플래그를 내리고 보류분을 넘긴다. TrayHandles 미준비(방어적)면 없음.
fn unpark_main(app: &AppHandle) -> Option<crate::commands::window::EffectRequest> {
    app.try_state::<TrayHandles>().and_then(|h| h.main_effect.lock().unpark())
}

/// 창을 보이고, 최소화돼 있으면 복원하고, 포커스를 준다 — 트레이 좌클릭·더블클릭·메뉴 "열기",
/// 단일 인스턴스 재실행(lib.rs::run 의 single-instance 플러그인 콜백), 펫의 "메인 열기"가 공유한다.
/// 숨긴 창에 Acrylic을 먼저 바르면 HWND 가 죽어 show 가 조용히 실패한다(docs/PET.md) — 그래서 숨은 동안
/// 보류한 효과(commands::window::effect_decision 2번)는 여기서 show **뒤에** 건다.
/// 안 보이면 한 번 가운데로 옮기고 다시 show 한다. 끝나고 잠시 뒤 상태를 진단에 남긴다(schedule_reveal_state).
pub fn show_and_focus(app: &AppHandle, via: RevealVia) {
    let w = match app.get_webview_window(MAIN_LABEL) {
        Some(w) => w,
        // 창이 **파괴된** 경우(숨김이 아니다) — 여기서 다시 만든다. 예전엔 그냥 로그만 찍고
        // 돌아갔고, 그러면 트레이 열기/좌클릭/더블클릭·단일 인스턴스 재실행·펫의 "메인 열기"가
        // 전부 영구히 죽어 앱이 트레이만 남은 좀비가 됐다(2026-08-25 실제 발생). 본 창은
        // tauri.conf.json 이 부팅 때 한 번만 만들므로 재생성 경로가 없으면 복구 불가였다.
        None => {
            // 보류 플래그를 **만들기 전에** 내리고 보류분은 버린다. 새 창은 숨긴 채 만들어져 부팅이 DB 의
            // 현재 설정을 읽고 show 뒤 스스로 효과를 건다(bootWindow → applySurfaceEffectAfterShow) — 보류분도
            // 같은 설정에서 나온 값이라 중복이고, 여기서 걸면 숨긴 새 HWND 에 거는 바로 그 버그다. 플래그를
            // 남겨 두면 그 부팅 호출이 보류되는데 그 뒤로 이 함수를 다시 탈 계기가 없어 효과가 영영 안 걸린다.
            let dropped = if unpark_main(app).is_some() { DeferredEffect::Dropped } else { DeferredEffect::None };
            match rebuild_main_window(app) {
                // 프런트가 다 그린 뒤 show() 한다 — 여기서 show 하면 숨긴 의미가 없다. 보이는 순간 포커스.
                Ok(_) => {
                    crate::aux_window::watch_reveal(app, MAIN_LABEL, REBUILD_REVEAL_TIMEOUT_MS, true);
                    // 300ms 면 새 웹뷰가 아직 부팅 중이라 늘 "안 보임"이다 — watch_reveal 의 마감 뒤에 본다.
                    let delay = std::time::Duration::from_millis(REBUILD_REVEAL_TIMEOUT_MS) + REVEAL_STATE_DELAY;
                    schedule_reveal_state(app, via, true, dropped, delay);
                }
                Err(e) => {
                    // 여기서 실패하면 진짜 복구 불가(재생성 경로 자체가 없다) — Error 레벨.
                    crate::diag::error("tray", "rebuild_main_window_failed", format!("{e}"));
                }
            }
            return;
        }
    };
    if let Err(e) = w.unminimize() {
        crate::diag::warn("tray", "unminimize_failed", format!("{e}"));
    }
    if let Err(e) = w.show() {
        crate::diag::warn("tray", "show_failed", format!("{e}"));
    }
    if !w.is_visible().unwrap_or(false) {
        let _ = w.center();
        if let Err(e) = w.show() {
            crate::diag::warn("tray", "show_after_center_failed", format!("{e}"));
        }
    }
    if let Err(e) = w.set_focus() {
        crate::diag::warn("tray", "set_focus_failed", format!("{e}"));
    }
    // 보류분은 메인 스레드에서 건다: 이 함수는 펫 "메인 열기"(async 커맨드)에선 다른 스레드에서 돌아,
    // 위 show() 가 메인 이벤트 루프로 넘겨지고 바로 돌아온다. 효과를 여기서 곧장 걸면 아직 숨은 HWND 에
    // 닿을 수 있다 — 같은 루프에 뒤따라 넣으면 show 가 처리된 다음에 돈다(메인 스레드에서 불렸으면
    // show 가 이미 동기로 끝났다). 상태 기록도 그 결과를 실어야 해서 같은 자리에서 예약한다.
    let pending = unpark_main(app);
    let had_pending = pending.is_some();
    let handle = app.clone();
    let main = w.clone();
    let queued = app.run_on_main_thread(move || {
        let effect = match pending {
            None => DeferredEffect::None,
            Some(req) if crate::commands::window::apply_effect_request(&main, &req) => DeferredEffect::Applied,
            Some(_) => DeferredEffect::Failed,
        };
        schedule_reveal_state(&handle, via, false, effect, REVEAL_STATE_DELAY);
    });
    if let Err(e) = queued {
        // 이벤트 루프가 이미 끝나는 중(종료 직전)이다 — 보류분은 걸지 못했다.
        crate::diag::warn("tray", "deferred_effect_dispatch_failed", format!("{e}"));
        let effect = if had_pending { DeferredEffect::Failed } else { DeferredEffect::None };
        schedule_reveal_state(app, via, false, effect, REVEAL_STATE_DELAY);
    }
}

/// settings.close_to_tray(boolean, 기본 true — settings_schema.rs 시드) 판정 — 순수 함수라
/// AppHandle/DB 없이 유닛 테스트 가능(repo::settings_schema 테스트 참고). true(기본) = X 버튼이
/// 트레이로 숨긴다, false = 실제 종료. 값이 없거나 boolean이 아니면 true(트레이 숨김)로 안전 폴백.
pub fn close_to_tray_from_settings(settings: &std::collections::BTreeMap<String, serde_json::Value>) -> bool {
    settings.get("close_to_tray").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// lib.rs::run() 의 CloseRequested 핸들러 전용 — 매 이벤트마다 AppState에서 다시 읽어 재시작 없이
/// 설정 변경을 반영한다. AppState 미준비(방어적)면 기본값(트레이로 숨김)으로 fail-safe.
pub fn close_to_tray_setting(app: &AppHandle) -> bool {
    setting(app, "close_to_tray").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// settings.pet_enabled(문자열 "0"/"1" — settings_schema.rs 주석 참고, 마스터 "펫 사용")가
/// 켜져 있는지. 실패 시 false(미설정 = 꺼짐, default_settings에 시드하지 않는다).
fn pet_enabled_setting(app: &AppHandle) -> bool {
    setting(app, "pet_enabled").as_ref().and_then(|v| v.as_str()) == Some("1")
}

/// settings.pet_visible(문자열 "0"/"1" — 마스터와 별개, W8-g 표시/숨기기). default_settings가
/// "1"로 시드하므로 정상 경로에선 항상 값이 있지만, 없거나 이상해도 명시적 "0"만 숨김으로
/// 본다(기본값 = 보임, pet_enabled와 반대로 fail-open — 마스터가 꺼져 있으면 어차피 창이 없다).
fn pet_visible_setting(app: &AppHandle) -> bool {
    setting(app, "pet_visible").as_ref().and_then(|v| v.as_str()) != Some("0")
}

/// (화면 저장 켜짐, AI 챗 사용 가능) — 판정은 commands::pet 의 것을 그대로 쓴다(각 게이트와 같은 값:
/// capture_screenshot_enabled · chat_available = pet_chat 의 privacy_gate_ok). 설정 한 번 읽기.
fn gate_settings(app: &AppHandle) -> (bool, bool) {
    let Some(state) = app.try_state::<AppState>() else {
        return (false, false);
    };
    let conn = state.db.lock();
    crate::repo::settings::get_all(&conn)
        .map(|s| {
            (
                crate::commands::pet::capture_screenshot_enabled(&s),
                crate::commands::pet::chat_available(&s),
            )
        })
        .unwrap_or((false, false))
}

fn persist_flag(app: &AppHandle, key: &str, next: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut conn = state.db.lock();
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(key.to_string(), serde_json::json!(if next { "1" } else { "0" }));
        let _ = crate::repo::settings::set(&mut conn, &entries);
    }
}

/// 트레이 "펫 표시/숨기기" 클릭 — 마스터가 켜져 있을 때만 이 항목이 메뉴에 존재하므로(아래
/// build_tray_menu) 여기서 건드리는 건 항상 visible뿐, 마스터는 절대 건드리지 않는다.
fn toggle_pet_visible(app: &AppHandle) {
    set_pet_visible(app, !pet_visible_setting(app));
}

/// 마스터 "펫 사용" 설정 — Settings > 펫 전용(commands::pet::pet_set_enabled). 트레이 항목의
/// 존재 자체와 타이틀바 버튼의 렌더 여부가 이 값에 물려 있다(reconcile 이 rebuild_tray_menu를
/// 부른다) — 프런트도 "enabled"를 보고 버튼을 아예 숨긴다.
pub fn set_pet_enabled(app: &AppHandle, next: bool) {
    persist_flag(app, "pet_enabled", next);
    if next {
        persist_flag(app, "pet_visible", true);
    }
    reconcile(app);
}

/// 표시/숨기기 — 타이틀바 버튼(commands::pet::pet_set_visible)과 트레이 "펫 표시/숨기기"가
/// 공유한다. 마스터는 그대로 두고 창만 껐다 켠다 — pet_close(펫 우클릭 "펫 끄기")도 결국
/// 이 함수로 온다(commands/pet.rs 주석 참고).
pub fn set_pet_visible(app: &AppHandle, next: bool) {
    persist_flag(app, "pet_visible", next);
    reconcile(app);
}

/// 펫 on/off·표시/숨김의 **단일** 지점.
fn reconcile(app: &AppHandle) {
    let pet_enabled = pet_enabled_setting(app);
    let pet_visible = pet_visible_setting(app);
    if pet_enabled && pet_visible {
        let _ = pet_window::ensure_pet_window(app);
    } else {
        pet_window::destroy_pet_window(app);
    }

    let _ = rebuild_tray_menu(app);
    let _ = app.emit_to("main", "pet-enabled-changed", PetState { enabled: pet_enabled, visible: pet_visible });
}

fn copy_sync_url(app: &AppHandle) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let Some(sync_state) = app.try_state::<SyncState>() else {
        return;
    };
    let guard = sync_state.0.lock();
    if let Some(r) = guard.as_ref() {
        let token = setting(app, "sync_token")
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let bound = format!("{}:{}", r.addr.ip(), r.addr.port());
        let url = format!("http://{bound}/app?token={token}");
        let _ = app.clipboard().write_text(url);
    }
}

fn notify_os(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::diag::warn("capture", "os_notification_failed", format!("{e}"));
    }
}

/// "클립보드 저장" — 펫이 떠 있을 때만 메뉴에 있다(확인 카드가 펫 말풍선에 뜨므로). 클립보드는
/// 여기(Rust)서 읽는다: 트레이에서 누르면 펫 웹뷰에 포커스가 없어 navigator.clipboard 가 거부된다.
/// 텍스트가 아니면 빈 문자열 → 펫이 "비어 있어요"로 답한다.
fn run_clipboard(app: &AppHandle) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app.clipboard().read_text().unwrap_or_default();
    let payload = serde_json::json!({ "action": "clipboard", "text": text });
    if let Err(e) = app.emit_to(pet_window::PET_LABEL, PET_MENU_RUN, payload) {
        crate::diag::warn("capture", "pet_menu_emit_failed", format!("{e}"));
    }
}

/// "화면 저장" — 펫이 떠 있으면 기존 카드 흐름(펫 말풍선 진행 표시 → 메인 창 다리 →
/// pet_screenshot_capture, 그 안에서 아래 capture_to_folder 를 탄다). 펫이 없으면 여기서 바로
/// 캡처 → 폴더 저장 → OS 알림 → 인박스 노트(commands::pet::capture_to_inbox, AI 요약 없음).
/// 오너 2026-10-16: 펫 꺼져도 캡처되고 노트로도 남는다. 이미지가 AI 로 나가는 건 펫 카드 경로뿐.
fn run_capture(app: &AppHandle) {
    if app.get_webview_window(pet_window::PET_LABEL).is_some() {
        let payload = serde_json::json!({ "action": "capture" });
        if let Err(e) = app.emit_to(pet_window::PET_LABEL, PET_MENU_RUN, payload) {
            crate::diag::warn("capture", "pet_menu_emit_failed", format!("{e}"));
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::commands::pet::capture_to_inbox(&app).await {
            // 캡처 자체가 실패했든 노트/첨부만 실패했든 사용자에게 알린다 — 폴더 저장이 됐다면
            // capture_to_folder 가 이미 "저장했어요"를 띄웠고, 이 알림은 노트 쪽 실패를 뜻한다.
            crate::diag::warn("capture", "capture_to_inbox_failed", e.code().to_string());
            notify_os(&app, tray_strings(&read_ui_lang(&app)).capture_failed, &e.to_string());
        }
    });
}

/// "새 세션 열기" — 사이드바 챗 "새 세션"과 같은 커맨드. 지금 대화는 지워지지 않고 보관되며
/// (세션 목록에서 다시 연다), 비어 있으면 아무것도 보관하지 않는다 — 그래서 사이드바와 달리 확인을
/// 묻지 않는다(네이티브 메뉴 클릭 자체가 명시적 행동). 사이드바·펫 말풍선은 커맨드가 내는
/// pet-chat-updated 로 다시 읽는다.
fn run_new_session(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Err(e) = crate::commands::pet::pet_session_new(state) {
        crate::diag::warn("pet", "menu_new_session_failed", e.code().to_string());
    }
}

/// 화면 저장의 **단일 관문** — 게이트(capture_screenshot_enabled) · 활성 창 캡처 · 폴더 저장 · OS 알림.
/// 트레이 직행 경로와 펫 카드 경로(commands::pet::pet_screenshot_capture)가 둘 다 여기를 지난다.
/// 폴더 저장 실패는 캡처 실패가 아니다 — 알리고 기록한 뒤 캡처는 돌려준다(카드 경로는 노트로라도
/// 남길 수 있다). 반환 = (캡처, 파일명).
pub async fn capture_to_folder(
    app: &AppHandle,
) -> crate::error::AppResult<(crate::repo::screenshot::Capture, String)> {
    use crate::error::AppError;
    use crate::repo::screenshot;
    let dir = {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| AppError::Io("app state not ready".to_string()))?;
        let conn = state.db.lock();
        let s = crate::repo::settings::get_all(&conn)?;
        if !crate::commands::pet::capture_screenshot_enabled(&s) {
            return Err(AppError::Validation("screen capture is off (Settings > General)".to_string()));
        }
        screenshot::capture_dir(
            s.get("capture_screenshot_dir").and_then(|v| v.as_str()),
            app.path().picture_dir().ok(),
            &state.data_dir,
        )
    };
    let name = screenshot::capture_file_name(chrono::Local::now());
    let file_name = name.clone();
    // 캡처·파일 쓰기는 OS 왕복이라 커맨드/메인 스레드를 잡지 않는다.
    let (capture, saved) = tauri::async_runtime::spawn_blocking(move || {
        screenshot::capture_active_window().map(|c| {
            let saved = screenshot::save_png(&dir, &file_name, &c.png);
            (c, saved)
        })
    })
    .await
    .map_err(|e| AppError::Io(format!("capture worker join error: {e}")))??;

    let strings = tray_strings(&read_ui_lang(app));
    match saved {
        Ok(path) => notify_os(app, strings.capture_saved, &path.display().to_string()),
        Err(e) => {
            // 경로는 진단 기록에 넣지 않는다(CLAUDE.md 함정 11) — 사용자 알림에만.
            crate::diag::warn("capture", "save_to_folder_failed", e.kind().to_string());
            notify_os(app, strings.capture_failed, &e.to_string());
        }
    }
    Ok((capture, name))
}

/// 펫 우클릭 — 트레이와 **같은 메뉴**를 펫 창 위에 띄운다(commands::pet::pet_menu_popup).
/// 클릭은 트레이 아이콘의 on_menu_event 가 받는다(Tauri 메뉴 이벤트는 전역). 이 메뉴의 핸들은
/// TrayHandles 에 넣지 않는다 — 한 번 뜨고 버려지는 사본이다.
pub fn popup_menu_on(app: &AppHandle, window: &tauri::Window) -> tauri::Result<()> {
    let (menu, ..) = build_tray_menu(app)?;
    window.popup_menu(&menu)
}

/// 조건부 항목의 노출 판정 — 순수 함수라 AppHandle 없이 테스트한다(tests::menu_model_*).
#[derive(Debug, PartialEq, Eq)]
struct MenuModel {
    /// 펫 창이 떠 있을 때만 의미 있는 항목: 클립보드 저장(확인 카드가 펫 말풍선에 뜬다).
    pet_window_items: bool,
    /// 새 세션 열기 — 펫 창이 떠 있고(펫 말풍선이 챗 미러라 거기서 대화를 끊을 손잡이) **AI 챗을
    /// 쓸 수 있을 때만**(chat_available — 챗 자체의 게이트). 챗이 막혀 있으면 열 세션이 없다.
    new_session: bool,
    capture: bool,
    pet_toggle: bool,
}

fn menu_model(pet_enabled: bool, pet_visible: bool, capture_enabled: bool, chat_available: bool) -> MenuModel {
    let pet_window_items = pet_enabled && pet_visible;
    MenuModel {
        pet_window_items,
        new_session: pet_window_items && chat_available,
        capture: capture_enabled,
        pet_toggle: pet_enabled,
    }
}

/// 현재 설정에 맞는 트레이 메뉴를 새로 만든다. **트레이와 펫 우클릭이 공유하는 유일한 항목
/// 목록**이다(popup_menu_on) — 한쪽에만 의미 있는 항목도 여기서 조건으로 처리하고, 두 번째
/// 목록을 만들지 않는다.
fn build_tray_menu(
    app: &AppHandle,
) -> tauri::Result<(
    Menu<Wry>,
    MenuItem<Wry>,
    MenuItem<Wry>,
    Option<CheckMenuItem<Wry>>,
)> {
    let strings = tray_strings(&read_ui_lang(app));
    let open_item = MenuItem::with_id(app, OPEN_ID, strings.open, true, None::<&str>)?;
    let sync_item = MenuItem::with_id(app, "tray-sync-status", sync_status_label(app), false, None::<&str>)?;
    let is_running = is_sync_running(app);
    let copy_url_item = MenuItem::with_id(app, COPY_URL_ID, strings.copy_url, is_running, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_ID, strings.quit, true, None::<&str>)?;
    let pet_enabled = pet_enabled_setting(app);
    let (capture_enabled, chat_available) = gate_settings(app);
    let model = menu_model(pet_enabled, pet_visible_setting(app), capture_enabled, chat_available);
    let clipboard_item = if model.pet_window_items {
        Some(MenuItem::with_id(app, CLIPBOARD_ID, strings.clipboard, true, None::<&str>)?)
    } else {
        None
    };
    let new_session_item = if model.new_session {
        Some(MenuItem::with_id(app, NEW_SESSION_ID, strings.new_session, true, None::<&str>)?)
    } else {
        None
    };
    let capture_item = if model.capture {
        Some(MenuItem::with_id(app, CAPTURE_ID, strings.capture, true, None::<&str>)?)
    } else {
        None
    };
    let pet_item = if model.pet_toggle {
        Some(CheckMenuItem::with_id(
            app,
            PET_TOGGLE_ID,
            strings.pet_toggle,
            true,
            pet_visible_setting(app),
            None::<&str>,
        )?)
    } else {
        None
    };

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![&open_item];
    if let Some(ref c) = clipboard_item {
        items.push(c);
    }
    if let Some(ref c) = capture_item {
        items.push(c);
    }
    if let Some(ref c) = new_session_item {
        items.push(c);
    }
    if let Some(ref p) = pet_item {
        items.push(p);
    }
    items.push(&sync_item);
    items.push(&copy_url_item);
    items.push(&quit_item);
    let menu = Menu::with_items(app, &items)?;
    Ok((menu, sync_item, copy_url_item, pet_item))
}

/// 트레이 아이콘을 (없으면) 만든다 — idempotent, 이미 있으면 아무 것도 안 한다.
pub fn ensure_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let (menu, sync_item, copy_url_item, pet_item) = build_tray_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_and_focus(app, RevealVia::TrayMenu),
            PET_TOGGLE_ID => toggle_pet_visible(app),
            COPY_URL_ID => copy_sync_url(app),
            CLIPBOARD_ID => run_clipboard(app),
            CAPTURE_ID => run_capture(app),
            NEW_SESSION_ID => run_new_session(app),
            QUIT_ID => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick { .. } => show_and_focus(tray.app_handle(), RevealVia::TrayDoubleClick),
            // 좌클릭 단독(업/다운 둘 다가 아니라 Up만 — 안 그러면 한 번의 클릭이 두 번 열고 닫는다).
            // show_menu_on_left_click(false)라 좌클릭이 메뉴를 열지 않으므로 여기서 직접 처리한다.
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => show_and_focus(tray.app_handle(), RevealVia::TrayClick),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    // "화면 저장" 항목은 capture_screenshot_enabled 를, "새 세션 열기"는 AI 설정(ai_enabled·
    // ai_provider·ai_endpoint, chat_available)을 따른다. settings_set 은 AppHandle 이 없어
    // (dispatch.gen.rs 시그니처) 그 키들이 바뀌면 "pet-theme-changed" 를 쏜다 — 그걸 듣고 메뉴를
    // 다시 짠다. 테마 변경에도 한 번씩 다시 짜지만 메뉴 몇 줄이라 무해하다. 메뉴 생성은 메인 스레드로
    // 디스패치하고 기다리므로 리스너(emit 한 스레드)에서 바로 하지 않고 태스크로 넘긴다.
    let handle = app.clone();
    app.listen_any("pet-theme-changed", move |_| {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = rebuild_tray_menu(&h) {
                crate::diag::warn("tray", "rebuild_menu_failed", format!("{e}"));
            }
        });
    });

    // try_state: lib.rs::run() 의 setup()이 TrayHandles를 app.manage()한 다음에만 ensure_tray를
    // 부르므로 정상 경로에선 항상 Some이지만, ensure_tray는 lib.rs 배선을 몰라도 되게 방어적으로 짠다.
    if let Some(handles) = app.try_state::<TrayHandles>() {
        *handles.sync_item.lock() = Some(sync_item);
        *handles.copy_url_item.lock() = Some(copy_url_item);
        *handles.pet_item.lock() = pet_item;
    }
    Ok(())
}

/// 마스터/표시 상태가 바뀌어 "펫 표시/숨기기" 항목의 존재 여부나 체크가 달라졌을 때 메뉴
/// 전체를 교체한다(reconcile 전용). on_menu_event 등 아이콘 자체의 핸들러는 TrayIconBuilder
/// 시점에 고정되어 메뉴 교체와 무관하게 유지된다 — set_menu는 메뉴만 바꾼다.
fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let (menu, sync_item, copy_url_item, pet_item) = build_tray_menu(app)?;
    tray.set_menu(Some(menu))?;
    if let Some(handles) = app.try_state::<TrayHandles>() {
        *handles.sync_item.lock() = Some(sync_item);
        *handles.copy_url_item.lock() = Some(copy_url_item);
        *handles.pet_item.lock() = pet_item;
    }
    Ok(())
}

/// 서버 상태가 바뀔 때(sync_set_enabled/sync_regenerate_token) 호출. 트레이는 부팅 시 항상
/// 만들어지므로 이 함수는 사실상 항상 히트한다(try_state는 초기화 순서 방어용).
pub fn refresh_sync_status_item(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let guard = handles.sync_item.lock();
    if let Some(item) = guard.as_ref() {
        let _ = item.set_text(sync_status_label(app));
    }
    let copy_guard = handles.copy_url_item.lock();
    if let Some(item) = copy_guard.as_ref() {
        let _ = item.set_enabled(is_sync_running(app));
    }
}

/// 창을 닫는 대신 트레이로 숨긴다 — 이 함수 자체는 무조건(호출되면 항상 숨긴다). 게이팅은
/// 호출부(commands/window.rs::window_close_confirmed)가 close_to_tray_setting 으로 미리 판단한다.
/// hidden_to_tray 와 효과 보류(main_effect)를 여기서 세팅한다 — 모든 트레이 숨김이 거치는 유일한
/// 지점이라서다(TrayHandles 주석 참고).
pub fn hide_to_tray(app: &AppHandle) {
    let _ = ensure_tray(app);
    let handles = app.try_state::<TrayHandles>();
    mark_hidden_to_tray(handles.as_deref());
    // 숨기기 **전에** 세운다 — 숨긴 뒤에 세우면 그 사이 도착한 효과 요청이 숨은 HWND 에 걸린다. 숨기기
    // 직전 보이는 동안 온 요청이 보류되는 건 무해하다(다시 보일 때 건다).
    if let Some(h) = handles.as_deref() {
        h.main_effect.lock().park();
    }
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        if let Err(e) = w.hide() {
            // 못 숨겼으면 창은 보이는 채로 남는다 — 보류를 풀어야 효과가 다음 열기까지 멈추지 않는다.
            crate::diag::warn("tray", "hide_failed", format!("{e}"));
            let _ = unpark_main(app);
        }
    }
}

/// hide_to_tray 의 순수 부분(AppHandle/OS 창 없이 유닛 테스트 가능) — 이 저장소가 원래 방치했던
/// 지점: 예전엔 이 store 자체가 아예 없어서 H2 failsafe(lib.rs)가 부팅 5초 내 트레이 숨김을
/// 되돌려버렸다. TrayHandles 미준비(방어적, 정상 경로에선 항상 Some)면 조용히 넘어간다.
fn mark_hidden_to_tray(handles: Option<&TrayHandles>) {
    if let Some(h) = handles {
        h.hidden_to_tray.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        close_to_tray_from_settings, mark_hidden_to_tray, menu_model, reveal_state_entry, tray_strings, DeferredEffect,
        RevealVia, TrayHandles,
    };
    use crate::diag::Level;

    #[test]
    fn effect_gate_is_not_parked_at_boot() {
        // setup() 이 manage 하는 기본값 — 부팅의 본 창 효과(applySurfaceEffectAfterShow)는 보류되지 않는다.
        // 세우는 곳은 hide_to_tray 뿐이다.
        let handles = TrayHandles::default();
        assert!(!handles.main_effect.lock().is_parked());
    }

    #[test]
    fn reveal_state_is_info_only_when_visible_restored_and_foreground() {
        let (level, message) = reveal_state_entry(
            RevealVia::TrayClick,
            false,
            DeferredEffect::None,
            Some(true),
            Some(false),
            Some(true),
        );
        assert_eq!(level, Level::Info);
        assert_eq!(
            message,
            "via=tray_click rebuilt=false visible=true minimized=false foreground=true deferred_effect=none"
        );
    }

    #[test]
    fn reveal_state_warns_on_any_mismatch_or_unknown() {
        let cases = [
            (Some(false), Some(false), Some(true)), // 안 보임
            (Some(true), Some(true), Some(true)),   // 최소화로 남음
            (Some(true), Some(false), Some(false)), // 다른 창 뒤
            (None, Some(false), Some(true)),        // 못 읽음
        ];
        for (visible, minimized, foreground) in cases {
            let (level, _) =
                reveal_state_entry(RevealVia::Pet, false, DeferredEffect::Applied, visible, minimized, foreground);
            assert_eq!(level, Level::Warn, "{visible:?} {minimized:?} {foreground:?}");
        }
        let (_, message) =
            reveal_state_entry(RevealVia::SecondInstance, true, DeferredEffect::Dropped, None, None, Some(false));
        assert_eq!(
            message,
            "via=second_instance rebuilt=true visible=unknown minimized=unknown foreground=false deferred_effect=dropped"
        );
    }

    #[test]
    fn menu_model_pet_window_items_need_pet_enabled_and_visible() {
        // 클립보드 저장 — 펫 창이 실제로 떠 있을 때만.
        assert!(menu_model(true, true, false, true).pet_window_items);
        assert!(!menu_model(true, false, false, true).pet_window_items, "hidden pet");
        assert!(!menu_model(false, true, false, true).pet_window_items, "pet off (visible flag stale)");
        // 표시/숨기기는 마스터만 본다(숨겨져 있어도 다시 켤 손잡이가 있어야 한다).
        assert!(menu_model(true, false, false, true).pet_toggle);
        assert!(!menu_model(false, true, false, true).pet_toggle);
        // 화면 저장은 펫과 무관.
        assert!(menu_model(false, false, true, false).capture);
        assert!(!menu_model(true, true, false, true).capture);
    }

    #[test]
    fn menu_model_new_session_needs_pet_window_and_chat_available() {
        assert!(menu_model(true, true, false, true).new_session);
        assert!(!menu_model(true, true, false, false).new_session, "AI chat gated off");
        assert!(!menu_model(true, false, false, true).new_session, "hidden pet");
        assert!(!menu_model(false, true, false, true).new_session, "pet off");
    }

    // hidden_to_tray 배선 — lib.rs:421 발견 사항: 플래그가 setup()에서 만들어지고 H2 failsafe가
    // 읽긴 하지만 아무도 store(true)를 안 해서, 부팅 5초 내 X→트레이 숨김이 failsafe에 되돌려졌다.
    // hide_to_tray()(유일한 트레이 숨김 지점)가 실제로 세팅하는지 이 순수 헬퍼로 검증한다.
    #[test]
    fn mark_hidden_to_tray_sets_flag() {
        let handles = TrayHandles::default();
        assert!(!handles.hidden_to_tray.load(std::sync::atomic::Ordering::Relaxed));
        mark_hidden_to_tray(Some(&handles));
        assert!(handles.hidden_to_tray.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn mark_hidden_to_tray_noop_when_state_missing() {
        // 방어 경로 — TrayHandles 가 아직 managed 되지 않은 상태에서도 패닉하면 안 된다.
        mark_hidden_to_tray(None);
    }

    // close_to_tray 부활 — 순수 함수라 AppHandle 없이 값/부재/오형 세 경우를 바로 검증한다.
    #[test]
    fn close_to_tray_from_settings_defaults_true_and_reads_explicit_value() {
        use std::collections::BTreeMap;
        let empty: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        assert!(close_to_tray_from_settings(&empty), "missing key = hide to tray (safe default)");

        let mut hide_off = BTreeMap::new();
        hide_off.insert("close_to_tray".to_string(), serde_json::json!(false));
        assert!(!close_to_tray_from_settings(&hide_off));

        let mut hide_on = BTreeMap::new();
        hide_on.insert("close_to_tray".to_string(), serde_json::json!(true));
        assert!(close_to_tray_from_settings(&hide_on));

        let mut wrong_type = BTreeMap::new();
        wrong_type.insert("close_to_tray".to_string(), serde_json::json!("true"));
        assert!(close_to_tray_from_settings(&wrong_type), "non-boolean value falls back to true");
    }

    #[test]
    fn tray_strings_cover_three_locales() {
        let ko = tray_strings("ko");
        assert_eq!(ko.open, "열기");
        assert_eq!(ko.quit, "종료");
        assert!(ko.sync_running_prefix.contains("동기화"));
        assert!(ko.sync_off.contains("꺼짐"));
        assert_eq!(ko.copy_url, "접속 주소 복사");
        assert_eq!(ko.pet_toggle, "펫 표시/숨기기");
        assert_eq!(ko.capture, "화면 저장");
        assert_eq!(ko.clipboard, "클립보드 저장");
        assert_eq!(ko.new_session, "새 세션 열기");
        assert_eq!(tray_strings("en").new_session, "Start new session");
        assert_eq!(tray_strings("fr").new_session, "Nouvelle session");

        let en = tray_strings("en");
        assert_eq!(en.open, "Open");
        assert_eq!(en.quit, "Quit");
        assert!(en.sync_running_prefix.starts_with("Sync status: running"));
        assert_eq!(en.sync_off, "Sync status: off");
        assert_eq!(en.copy_url, "Copy access URL");
        assert_eq!(en.pet_toggle, "Show/Hide Pet");

        let fr = tray_strings("fr");
        assert_eq!(fr.open, "Ouvrir");
        assert_eq!(fr.quit, "Quitter");
        assert!(fr.sync_running_prefix.contains("sync"));
        assert!(fr.sync_off.contains("désactivée"));
        assert_eq!(fr.copy_url, "Copier l'URL d'accès");
        assert!(fr.pet_toggle.contains("animal"));

        // unknown → ko default (matches settings seed)
        let fallback = tray_strings("de");
        assert_eq!(fallback.open, ko.open);
    }

    #[test]
    fn enabling_pet_restores_pet_visible() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        // Simulate pet right-click "펫 끄기" which sets pet_visible = "0"
        let mut entries = std::collections::BTreeMap::new();
        entries.insert("pet_visible".to_string(), serde_json::json!("0"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let s = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(s.get("pet_visible").and_then(|v| v.as_str()), Some("0"));

        // When enabling pet (set_pet_enabled with next=true), pet_enabled="1" and pet_visible="1" are persisted
        let mut enable_entries = std::collections::BTreeMap::new();
        enable_entries.insert("pet_enabled".to_string(), serde_json::json!("1"));
        enable_entries.insert("pet_visible".to_string(), serde_json::json!("1"));
        crate::repo::settings::set(&mut conn, &enable_entries).unwrap();

        let s_after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(s_after.get("pet_enabled").and_then(|v| v.as_str()), Some("1"));
        assert_eq!(s_after.get("pet_visible").and_then(|v| v.as_str()), Some("1"));
    }
}
