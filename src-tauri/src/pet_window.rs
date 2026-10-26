// 데스크톱 펫 창 (W7-h 창 분리) — **창 두 개**다.
//
//  1. `pet`        캐릭터 창. 크기가 **영원히 고정**(160×180)이고 절대 리사이즈하지 않는다.
//  2. `pet-bubble` 말풍선/채팅 창. 필요할 때 만들고 닫으면 파괴한다. 크기는 내용에 맞춰 바뀌지만
//                  위치는 **매번 펫의 실제 사각형 + 모니터 작업영역에서 새로 계산**한다.
//
// 왜 나눴나(오너 신고 "펫 위치가 계속 틀어짐"): W6 까지는 창이 하나였고 패널을 열 때 160×180 →
// 320×420 으로 키우면서 좌상단을 늘어난 만큼 빼는 방식이었다(구 src/pet/geometry.ts).
//   - 모니터 경계를 안 봤다 → x=20 에서 펼치면 x=-140(화면 밖, 입력창에 손이 안 닿음)
//   - 분수 DPI(125%/150%)에서 Math.round 가 토글마다 ~1px 씩 누적 → "계속 틀어짐"
//   - 델타 누적 방식이라 한 번 어긋나면 영영 복구되지 않았다
// 창을 나누면 셋 다 **구조적으로 불가능**해진다: 펫은 리사이즈가 없어 드리프트할 축 자체가 없고,
// 말풍선 위치는 델타가 아니라 절대 좌표를 매번 새로 계산하므로 누적될 값이 없다.
//
// 프런트 엔트리는 src/pet/PetApp.tsx(#/pet) 와 src/pet/PetBubbleApp.tsx(#/pet-bubble).
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const PET_LABEL: &str = "pet";
pub const BUBBLE_LABEL: &str = "pet-bubble";

const PET_WIDTH: f64 = 160.0;
const PET_HEIGHT: f64 = 180.0;
const EDGE_MARGIN: f64 = 16.0;
/// 펫과 말풍선 창 사이 간격.
const GAP: f64 = 6.0;

/// 스프라이트가 실제로 차지하는 높이. 출처: src/pet/PetSprite.tsx — 아틀라스 경로는
/// `SIZE(120) * CodexPetAtlas.cellHeight(208) / cellWidth(192) = 130`, 레거시 에셋/SVG 폴백은
/// 120. 스프라이트는 창 하단에 정렬되므로(src/pet/pet.css `.pet-app { align-items: flex-end }`)
/// 창 위쪽 50~60px 은 **투명 여백**이다. 둘 중 큰 130 을 기준 삼아 어떤 스프라이트에서도
/// 말풍선이 캐릭터를 덮지 않게 한다. 창 자체(PET_HEIGHT)는 건드리지 않는다 — 저장된 좌표와
/// resolve_position/is_on_screen 이 전부 그 값에 물려 있다.
const PET_SPRITE_HEIGHT: f64 = 130.0;

/// 채팅 모드 크기 — 최신 3말풍선 + 1줄 입력(docs/PET.md). 사이드바가 본 표면.
const CHAT_W: f64 = 300.0;
const CHAT_H: f64 = 248.0;
/// 알림 모드 폭. 높이는 내용에 맞춰 pet_bubble_resize 로 [MIN, MAX] 안에서 정해진다 —
/// 예전 `.pet-notice { max-height: 84px; overflow: hidden }` 처럼 긴 알림이 잘리지 않게.
const NOTICE_W: f64 = 260.0;
pub const NOTICE_MIN_H: f64 = 44.0;
pub const NOTICE_MAX_H: f64 = 360.0;

/// 논리(logical) px 사각형. 창/모니터 API 는 물리 px + scale factor 를 주므로 경계를 넘자마자
/// 여기로 정규화해서, 배치 계산이 DPI 를 아예 모르게 한다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 말풍선 창에 넘길 내용. 창이 뜨기 전에 여기 담아 두고, 창이 마운트되면
/// `pet_bubble_state` 로 가져간다(URL 쿼리로 실어 보내면 텍스트 이스케이프 문제가 생긴다).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BubblePayload {
    /// "chat" | "notice" | "clip"(클립보드 저장 확인 카드 — text 가 JSON 이다)
    pub mode: String,
    pub text: String,
    pub note_id: Option<String>,
}

static BUBBLE_PAYLOAD: parking_lot::Mutex<Option<BubblePayload>> = parking_lot::Mutex::new(None);

// ── 커맨드 스코프 (SECURITY, W7-h §3) ────────────────────────────────────────────────────
// 앱 커맨드(`#[tauri::command]`)는 capabilities/ACL 을 **타지 않는다** — capabilities 는
// `plugin:` 접두사가 붙는 코어/플러그인 커맨드만 게이팅한다. 그래서 pet.json 이 창 관리 권한만
// 열어 뒀는데도 펫 웹뷰의 JS 는 `db_reset`·`backup_restore`·`export_all`·`workspace_delete`·
// `settings_set` 같은 전 커맨드를 그대로 부를 수 있었다. 지금은 모델 출력이 그쪽으로 흐르는
// 경로가 없어 잠재 위험이지만, 계획된 "에이전트화"(run_command) 가 들어오기 전에 닫아야 한다.
//
// 게이트는 lib.rs 의 invoke_handler 래퍼 한 곳이다(커맨드 100개를 건드리지 않는 최소 폭발반경).
// **기본 거부** — 아래 목록은 src/pet/** 이 실제로 호출하는 것만이고, 새 호출을 추가하려면
// 여기에도 한 줄을 더해야 한다.
pub const PET_ALLOWED_COMMANDS: &[&str] = &[
    // 펫 자신의 표면
    "pet_chat",
    "pet_chat_history",
    "pet_chat_clear",
    // pet_session_list / new / open 은 사이드바 전용 — 펫 창은 pet-chat-updated 미러만.
    "pet_note_create",
    "pet_conversation_save",
    "pet_notifications",
    "pet_open_main",
    "pet_close",
    // 우클릭 = 트레이 메뉴 사본을 네이티브로 띄운다(tray::popup_menu_on). 항목 동작은 Rust 쪽 핸들러.
    "pet_menu_popup",
    "pet_set_position",
    "pet_assets_list",
    "pet_packages_list",
    "pet_package_asset",
    "pet_bubble_toggle",
    "pet_bubble_notice",
    "pet_bubble_close",
    "pet_bubble_state",
    "pet_bubble_resize",
    // W8-h: 펫 대화창 스타일 상속(theme/accent/font_scale 만 노출하는 좁은 읽기).
    "pet_theme",
    // 진단 싱크(AUDIT-2026-09-26-fallback-observability.md §7.1) — 모든 창에서 호출 가능해야
    // 한다(안 하면 가장 눈먼 이 창이 계속 눈먼다). 읽기 커맨드(diag_recent/diag_status/
    // diag_take_notices)는 여기 없다 — 펫 창은 자기 실패를 보고만 하지, 전체 진단을 조회하지 않는다.
    "diag_record",
];

pub fn is_pet_label(label: &str) -> bool {
    label == PET_LABEL || label == BUBBLE_LABEL
}

pub fn is_pet_command_allowed(cmd: &str) -> bool {
    PET_ALLOWED_COMMANDS.contains(&cmd)
}

// ── 캐릭터 창 ────────────────────────────────────────────────────────────────────────────

/// 창이 이미 있으면 아무것도 안 한다(idempotent) — tray 토글/부팅 자동기동 양쪽이 안전하게 부를 수 있게.
pub fn ensure_pet_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(PET_LABEL).is_some() {
        return Ok(());
    }
    let (x, y) = resolve_position(app);
    let win = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("index.html#/pet".into()))
        .title("Brise Pet")
        .inner_size(PET_WIDTH, PET_HEIGHT)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // 영구 고정. 이 창은 살아 있는 동안 단 한 번도 크기가 바뀌지 않는다 — 드리프트의 뿌리.
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(true)
        .build()?;

    // 펫을 끌면 말풍선이 따라온다. JS 가 아니라 여기서 처리하는 이유: 배치에는 모니터 작업영역이
    // 필요한데 웹뷰에서는 그걸 볼 수 없다(그게 애초에 화면 밖으로 펼쳐지던 원인이다).
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            place_bubble(&handle);
        }
    });
    Ok(())
}

pub fn destroy_pet_window(app: &AppHandle) {
    close_bubble(app);
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.destroy();
    }
}

/// settings.pet_pos_x/y 가 있고 지금 붙어 있는 모니터들 중 하나의 화면 안이면 그대로 쓰고,
/// 없거나 화면 밖(모니터 구성이 바뀐 경우)이면 기본 위치(우하단)로 되돌린다.
fn resolve_position(app: &AppHandle) -> (f64, f64) {
    let fallback = default_position(app);
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return fallback;
    };
    let conn = state.db.lock();
    let settings = crate::repo::settings::get_all(&conn);
    drop(conn);
    let Ok(settings) = settings else {
        return fallback;
    };
    let x = settings.get("pet_pos_x").and_then(|v| v.as_i64());
    let y = settings.get("pet_pos_y").and_then(|v| v.as_i64());
    match (x, y) {
        (Some(x), Some(y)) if is_on_screen(app, x as f64, y as f64) => (x as f64, y as f64),
        _ => fallback,
    }
}

/// 주 모니터의 작업영역(work area — 작업표시줄 제외) 우하단 근처. 모니터 정보를 못 읽으면
/// ponytail: 1080p 화면 기준 대략치로 폴백(멀티모니터/특이 해상도에서는 부정확할 수 있음 — 실제
/// 화면 밖으로 나가면 다음 부팅에 is_on_screen 이 걸러 다시 이 계산으로 돌아온다).
/// pub: 설정의 "기본 위치로"(pet_position_reset)가 같은 규칙을 그대로 쓴다 — 프런트가 기본
/// 위치 계산을 두 번 구현하지 않게(P7).
pub fn default_position(app: &AppHandle) -> (f64, f64) {
    match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let work = monitor.work_area();
            let wx = work.position.x as f64 / scale;
            let wy = work.position.y as f64 / scale;
            let ww = work.size.width as f64 / scale;
            let wh = work.size.height as f64 / scale;
            (wx + ww - PET_WIDTH - EDGE_MARGIN, wy + wh - PET_HEIGHT - EDGE_MARGIN)
        }
        _ => (1920.0 - PET_WIDTH - EDGE_MARGIN, 1080.0 - PET_HEIGHT - EDGE_MARGIN),
    }
}

fn is_on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
    app.available_monitors()
        .map(|monitors| {
            monitors.iter().any(|m| {
                let scale = m.scale_factor();
                let mx = m.position().x as f64 / scale;
                let my = m.position().y as f64 / scale;
                let mw = m.size().width as f64 / scale;
                let mh = m.size().height as f64 / scale;
                x >= mx && y >= my && x + PET_WIDTH <= mx + mw && y + PET_HEIGHT <= my + mh
            })
        })
        // 모니터 조회 실패 시엔 거부하지 않는다(저장된 값을 그냥 믿는다) — 보수적으로 막았다가
        // 정상 좌표까지 매번 기본값으로 되돌리는 게 더 나쁘다.
        .unwrap_or(true)
}

// ── 말풍선/채팅 창 ───────────────────────────────────────────────────────────────────────

/// 채팅 창 토글. 열림 여부의 진실은 **창의 존재 여부**다 — 프런트에 열림 플래그를 두면
/// 말풍선이 스스로 닫혔을 때(알림 클릭 등) 어긋난다.
pub fn toggle_chat(app: &AppHandle) -> tauri::Result<bool> {
    if app.get_webview_window(BUBBLE_LABEL).is_some() {
        // 알림 말풍선이 떠 있는 상태에서 펫을 누르면 **채팅으로 바꾼다**(닫지 않는다) —
        // 알림을 읽고 이어서 말을 걸려는 흐름이 자연스럽다. 채팅일 때만 닫기 토글.
        let is_chat = BUBBLE_PAYLOAD.lock().as_ref().map(|p| p.mode == "chat").unwrap_or(false);
        if is_chat {
            // 닫기 버튼/Esc와 같은 UX를 유지한다. 캐릭터 창은 대화 원문을 볼 수 없으므로
            // 여기서 바로 파괴하지 않고 채팅 웹뷰에 확인 이벤트를 보내 저장 여부를 묻는다.
            // 저장하지 않고 닫기를 선택하면 웹뷰가 기존 pet_bubble_close를 호출한다.
            let _ = app.emit_to(BUBBLE_LABEL, "pet-bubble-close-request", ());
            return Ok(false);
        }
    }
    open_bubble(
        app,
        BubblePayload { mode: "chat".to_string(), ..Default::default() },
    )?;
    Ok(true)
}

/// 알림 말풍선. 이미 채팅이 열려 있으면 밀어내지 않는다(대화 중에 알림이 화면을 빼앗지 않게).
pub fn show_notice(app: &AppHandle, text: String, note_id: Option<String>) -> tauri::Result<bool> {
    if let Some(existing) = BUBBLE_PAYLOAD.lock().as_ref() {
        if existing.mode == "chat" && app.get_webview_window(BUBBLE_LABEL).is_some() {
            return Ok(false);
        }
    }
    open_bubble(app, BubblePayload { mode: "notice".to_string(), text, note_id })?;
    Ok(true)
}

/// 클립보드 저장 확인 카드(Q9, docs/PLAN-2026-08-08-presets-schedule.md). 알림과 달리 채팅이
/// 떠 있어도 **밀어낸다** — 사용자가 방금 우클릭으로 명시 요청한 액션이라 조용히 무시하면
/// "눌렀는데 아무 일도 안 남"이 된다. 대화 원문은 이미 pet_messages 에 있어 채팅을 덮어써도
/// 잃는 게 없다(pet_chat_history 가 복원한다). 창 크기는 notice 와 같은 규칙(내용 높이 실측 →
/// pet_bubble_resize)을 그대로 탄다 — mode 가 "chat" 이 아니면 전부 그 경로다.
pub fn show_clip(app: &AppHandle, payload_json: String) -> tauri::Result<()> {
    open_bubble(app, BubblePayload { mode: "clip".to_string(), text: payload_json, note_id: None })
}

fn open_bubble(app: &AppHandle, payload: BubblePayload) -> tauri::Result<()> {
    let chat = payload.mode == "chat";
    let (w, h) = if chat { (CHAT_W, CHAT_H) } else { (NOTICE_W, NOTICE_MIN_H) };
    *BUBBLE_PAYLOAD.lock() = Some(payload.clone());

    if let Some(win) = app.get_webview_window(BUBBLE_LABEL) {
        // 이미 떠 있으면 내용만 갈아 끼운다(창을 파괴했다 다시 만들면 깜박인다).
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let _ = win.emit_to(BUBBLE_LABEL, "pet-bubble-payload", &payload);
        place_bubble(app);
        if chat {
            let _ = win.set_focus();
        }
        return Ok(());
    }

    let pet = pet_rect(app).unwrap_or(Rect { x: 0.0, y: 0.0, w: PET_WIDTH, h: PET_HEIGHT });
    let (x, y) = place(pet, w, h, work_rect(app));
    WebviewWindowBuilder::new(
        app,
        BUBBLE_LABEL,
        WebviewUrl::App("index.html#/pet-bubble".into()),
    )
    .title("Brise Pet Bubble")
    .inner_size(w, h)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    // 알림은 수동적이라 포커스를 뺏지 않는다(타이핑 중에 5분마다 커서를 훔치면 안 된다).
    // 채팅은 입력창에 바로 쓸 수 있어야 하므로 포커스를 받는다. 어느 쪽이든 펫 창은
    // 별개 창이라 포커스가 옮겨가도 움직이거나 사라지지 않는다.
    .focused(chat)
    .visible(true)
    .build()?;
    Ok(())
}

pub fn close_bubble(app: &AppHandle) {
    *BUBBLE_PAYLOAD.lock() = None;
    if let Some(w) = app.get_webview_window(BUBBLE_LABEL) {
        let _ = w.destroy();
    }
    // 펫이 alert 표정을 풀 수 있게 알린다(말풍선이 스스로 닫히는 경로가 여럿이다).
    let _ = app.emit_to(PET_LABEL, "pet-bubble-closed", ());
}

pub fn bubble_payload() -> Option<BubblePayload> {
    BUBBLE_PAYLOAD.lock().clone()
}

/// 알림 말풍선이 자기 내용 높이를 재서 알려온다 — 창을 그 높이로 맞추고 다시 배치한다.
pub fn resize_bubble(app: &AppHandle, height: f64) {
    let Some(win) = app.get_webview_window(BUBBLE_LABEL) else {
        return;
    };
    // 채팅 크기는 고정이다 — 늦게 도착한 알림 모드의 실측이 채팅 창을 찌그러뜨리지 않게.
    if BUBBLE_PAYLOAD.lock().as_ref().map(|p| p.mode == "chat").unwrap_or(false) {
        return;
    }
    let h = height.clamp(NOTICE_MIN_H, NOTICE_MAX_H);
    let _ = win.set_size(tauri::LogicalSize::new(NOTICE_W, h));
    place_bubble(app);
}

/// 말풍선 창을 **지금** 펫이 있는 자리 기준으로 다시 놓는다. 델타가 아니라 절대 좌표라서
/// 몇 번을 불러도 누적 오차가 없다(같은 입력 → 같은 출력, 멱등).
pub fn place_bubble(app: &AppHandle) {
    let (Some(bubble), Some(pet)) = (app.get_webview_window(BUBBLE_LABEL), pet_rect(app)) else {
        return;
    };
    let Ok(scale) = bubble.scale_factor() else { return };
    let Ok(size) = bubble.outer_size() else { return };
    let size = size.to_logical::<f64>(scale);
    let (x, y) = place(pet, size.width, size.height, work_rect(app));
    let _ = bubble.set_position(tauri::LogicalPosition::new(x, y));
}

/// 배치 규칙(순수 함수 — 부호 하나가 뒤집히면 창이 화면 밖으로 날아가는데, 창이 떠 있어야만
/// 확인되는 코드였다면 그걸 못 잡는다. 구 geometry.ts 의 테스트 규율을 여기로 옮겼다).
///
/// 펫 기준 위 → 아래 → 왼쪽 → 오른쪽 순으로 **작업영역 안에 통째로 들어가는 첫 자리**를 고른다.
/// 붙는 축이 안 맞으면 다음 후보로 넘어가고, 교차 축은 그때그때 작업영역 안으로 클램프한다.
/// 넷 다 안 되면(작은 화면 + 큰 패널) 겹치더라도 작업영역 안으로 밀어 넣는다 — 화면 밖은 절대 안 된다.
pub fn place(pet: Rect, w: f64, h: f64, work: Rect) -> (f64, f64) {
    let cx = pet.x + pet.w / 2.0 - w / 2.0;
    let cy = pet.y + pet.h / 2.0 - h / 2.0;
    let clamp_x = |x: f64| clamp(x, work.x, work.x + work.w - w);
    let clamp_y = |y: f64| clamp(y, work.y, work.y + work.h - h);

    let candidates = [
        (true, cx, pet.y - GAP - h),          // 위
        (true, cx, pet.y + pet.h + GAP),      // 아래
        (false, pet.x - GAP - w, cy),         // 왼쪽
        (false, pet.x + pet.w + GAP, cy),     // 오른쪽
    ];
    for (vertical, x, y) in candidates {
        if vertical {
            if y >= work.y && y + h <= work.y + work.h {
                return (clamp_x(x), y);
            }
        } else if x >= work.x && x + w <= work.x + work.w {
            return (x, clamp_y(y));
        }
    }
    (clamp_x(cx), clamp_y(cy))
}

/// 작업영역이 창보다 작으면 lo > hi 가 되어 f64::clamp 가 패닉한다 — 그때는 작업영역 좌상단.
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi <= lo {
        lo
    } else {
        v.clamp(lo, hi)
    }
}

/// 창 rect → **스프라이트** rect. 배치 기준을 창이 아니라 그림으로 좁힌다 — 창 위쪽 투명 여백
/// (PET_SPRITE_HEIGHT 주석)을 그대로 두면 위쪽 말풍선이 캐릭터에서 50~60px 떠 보인다.
/// 아래쪽 변은 그대로라 "아래에 붙는" 후보의 좌표는 바뀌지 않는다.
pub fn sprite_rect(win: Rect) -> Rect {
    let inset = (win.h - PET_SPRITE_HEIGHT).max(0.0);
    Rect { x: win.x, y: win.y + inset, w: win.w, h: win.h - inset }
}

/// 펫 창의 스프라이트 사각형(논리 px). 배치 계산의 유일한 입구라 보정도 여기 한 번만 한다.
fn pet_rect(app: &AppHandle) -> Option<Rect> {
    let w = app.get_webview_window(PET_LABEL)?;
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.outer_size().ok()?.to_logical::<f64>(scale);
    Some(sprite_rect(Rect { x: pos.x, y: pos.y, w: size.width, h: size.height }))
}

/// 펫이 **지금 올라가 있는** 모니터의 작업영역. 주 모니터로 고정하면 보조 모니터의 펫이
/// 엉뚱한 화면 기준으로 클램프된다.
fn work_rect(app: &AppHandle) -> Rect {
    let monitor = app
        .get_webview_window(PET_LABEL)
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let s = m.scale_factor();
            let a = m.work_area();
            Rect {
                x: a.position.x as f64 / s,
                y: a.position.y as f64 / s,
                w: a.size.width as f64 / s,
                h: a.size.height as f64 / s,
            }
        }
        None => Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 };
    const CHAT: (f64, f64) = (CHAT_W, CHAT_H);

    /// 창 좌표를 받아 **생산 코드가 place() 에 실제로 넘기는 것**(스프라이트 rect)을 돌려준다 —
    /// pet_rect 가 하는 보정과 같은 경로를 테스트도 탄다.
    fn pet_at(x: f64, y: f64) -> Rect {
        sprite_rect(Rect { x, y, w: PET_WIDTH, h: PET_HEIGHT })
    }

    /// 회귀(오너 신고 "대화창이 아바타에서 떠 있다"): 창 위쪽 투명 여백만큼 말풍선이 더 위로
    /// 갔었다. 이제 위쪽 후보는 **스프라이트 윗변** 기준이고, 아래쪽 후보는 그대로다.
    #[test]
    fn places_the_bubble_against_the_sprite_not_the_transparent_window_top() {
        let win = Rect { x: 1000.0, y: 800.0, w: PET_WIDTH, h: PET_HEIGHT };
        let s = sprite_rect(win);
        assert_eq!(s.h, PET_SPRITE_HEIGHT);
        assert_eq!(s.y + s.h, win.y + win.h, "아랫변은 창과 같다");

        let (_, y) = place(s, CHAT.0, CHAT.1, WORK);
        assert_eq!(y, s.y - GAP - CHAT.1);
        assert_eq!(y + CHAT.1 + GAP, 850.0, "스프라이트 윗변(800+50)에 붙는다");
    }

    #[test]
    fn prefers_above_and_centers_on_the_pet() {
        let pet = pet_at(1000.0, 800.0);
        let (x, y) = place(pet, CHAT.0, CHAT.1, WORK);
        assert_eq!(y, pet.y - GAP - CHAT.1, "위쪽에 자리가 있으면 위");
        assert_eq!(x, 1000.0 + PET_WIDTH / 2.0 - CHAT.0 / 2.0, "펫 중심 정렬");
    }

    /// 회귀: 구 anchoredTopLeft 는 x=20 에서 펼치면 x=-140 을 냈다(화면 밖 → 입력창 도달 불가).
    #[test]
    fn never_leaves_the_work_area_at_the_left_edge() {
        let (x, y) = place(pet_at(20.0, 800.0), CHAT.0, CHAT.1, WORK);
        assert!(x >= WORK.x, "좌측 경계 밖으로 나가지 않는다: {x}");
        assert!(x + CHAT.0 <= WORK.x + WORK.w);
        assert!(y >= WORK.y);
    }

    /// 회귀: 구 계산은 y=20 에서 펼치면 y=-220 을 냈다(대화 기록이 화면 위로 사라짐).
    #[test]
    fn falls_below_the_pet_when_there_is_no_room_above() {
        let (_, y) = place(pet_at(1000.0, 20.0), CHAT.0, CHAT.1, WORK);
        assert_eq!(y, 20.0 + PET_HEIGHT + GAP, "위가 막히면 아래");
        assert!(y + CHAT.1 <= WORK.y + WORK.h);
    }

    #[test]
    fn goes_to_the_side_when_neither_above_nor_below_fits() {
        // 세로로 꽉 찬 작업영역: 위·아래 어디에도 채팅 높이가 안 들어간다.
        let work = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 520.0 };
        let (x, y) = place(pet_at(900.0, 200.0), CHAT.0, CHAT.1, work);
        assert_eq!(x, 900.0 - GAP - CHAT.0, "왼쪽 우선");
        assert!(y >= work.y && y + CHAT.1 <= work.y + work.h);
    }

    #[test]
    fn clamps_into_the_work_area_when_nothing_fits() {
        let work = Rect { x: 0.0, y: 0.0, w: 400.0, h: 300.0 };
        let (x, y) = place(pet_at(100.0, 60.0), CHAT.0, CHAT.1, work);
        assert!(x >= work.x && x + CHAT.0 <= work.x + work.w);
        assert!(y >= work.y && y + CHAT.1 <= work.y + work.h, "작업영역 안으로 클램프: y={y}");
    }

    /// 드리프트가 구조적으로 불가능하다는 계약: 같은 입력이면 몇 번을 불러도 같은 좌표.
    /// (구 방식은 현재 좌표에서 델타를 빼는 방식이라 반복 호출이 누적됐다.)
    #[test]
    fn is_idempotent_no_matter_how_many_times_it_runs() {
        let pet = pet_at(1000.0, 800.0);
        let first = place(pet, CHAT.0, CHAT.1, WORK);
        for _ in 0..50 {
            assert_eq!(place(pet, CHAT.0, CHAT.1, WORK), first);
        }
    }

    #[test]
    fn handles_negative_coordinates_on_a_secondary_monitor() {
        let work = Rect { x: -1920.0, y: -100.0, w: 1920.0, h: 1040.0 };
        let (x, y) = place(pet_at(-1900.0, -40.0), CHAT.0, CHAT.1, work);
        assert!(x >= work.x && x + CHAT.0 <= work.x + work.w, "x={x}");
        assert!(y >= work.y && y + CHAT.1 <= work.y + work.h, "y={y}");
    }

    #[test]
    fn pet_command_allowlist_denies_destructive_commands_by_default() {
        for denied in [
            "db_reset",
            "note_purge",
            "note_delete",
            "backup_restore",
            "export_all",
            "export_workspace_bundle",
            "workspace_delete",
            "import_bundle",
            "migration_import_markdown",
            "settings_set",
            "settings_get_all",
            "sync_regenerate_token",
            "ai_generate_from_prompt",
            // 클립보드 저장(Q9)의 라우팅·표시 경로는 전부 메인 창 몫이다 — 펫 창이 외부 fetch나
            // 검색을 직접 부를 수 있게 되면 이 창의 좁은 표면이 무의미해진다.
            "link_preview",
            "search_notes",
            "pet_bubble_clip",
            // 화면 저장(PLAN-2026-08-09-pet-capture Phase 1)도 같은 이유로 메인 창 몫이다 —
            // 펫 창이 OS 창 목록·픽셀·첨부 저장에 직접 닿을 수 있게 되면 이 좁은 표면이 무의미해진다.
            "pet_screenshot_capture",
            // 설치/삭제·기본 위치 복귀는 설정 창의 표면이다 — 펫 창이 자기 패키지를 지우거나
            // 스스로를 옮겨 놓을 이유가 없다(드래그 저장은 pet_set_position 그대로).
            "pet_package_install",
            "pet_package_install_url",
            "pet_packages_import_codex",
            "pet_package_remove",
            "pet_position_reset",
            "pet_session_list",
            "pet_session_new",
            "pet_session_open",
            "attachment_add_bytes",
        ] {
            assert!(!is_pet_command_allowed(denied), "{denied} 는 펫 창에서 막혀야 한다");
        }
        for allowed in ["pet_chat", "pet_open_main", "pet_bubble_toggle", "pet_theme"] {
            assert!(is_pet_command_allowed(allowed));
        }
        assert!(is_pet_label(PET_LABEL) && is_pet_label(BUBBLE_LABEL));
        assert!(!is_pet_label("main"));
    }

    /// AUDIT-2026-09-26-fallback-observability.md §7.1: diag_record는 모든 창(펫 포함)에서
    /// 호출 가능해야 한다 — 안 하면 가장 눈먼 이 창이 계속 눈먼다. 읽기 커맨드(diag_recent/
    /// diag_status/diag_take_notices)는 반대로 펫 창에 열지 않는다(전체 진단 조회는 이 창의
    /// 몫이 아니다).
    #[test]
    fn diag_record_is_allowed_but_diag_read_commands_are_not() {
        assert!(is_pet_command_allowed("diag_record"));
        for denied in ["diag_recent", "diag_status", "diag_take_notices"] {
            assert!(!is_pet_command_allowed(denied), "{denied} 는 펫 창에서 막혀야 한다");
        }
    }
}
