// 프로세스 전역 "데이터가 바뀌었다" 버스 — 실시간 동기화의 단일 초크포인트.
//
// 쓰기 진입 경로는 두 개고, 둘 다 **같은 커맨드 함수**로 수렴한다:
//   (1) 데스크톱 웹뷰 → Tauri IPC        → commands::*
//   (2) 폰 브라우저   → POST /api/v1/invoke → sync_server::dispatch → commands::*
// 그래서 알림은 HTTP 계층이 아니라 커맨드 계층에서 낸다. 예전에는 sync_server::handlers 의
// 손으로 쓴 REST 쓰기 핸들러만 emit 했고, 그 결과 (a) 폰이 /api/v1/invoke 로 한 쓰기(=웹
// 클라이언트의 거의 모든 쓰기)와 (b) 데스크톱 IPC 쓰기 전부가 아무에게도 통지되지 않았다.
//
// 두 가지 규칙 — 어기면 이중 emit 또는 무통지로 돌아간다:
//   * 손으로 쓴 REST 쓰기 핸들러(checklist toggle, attachment upload — note CRUD(POST/PUT
//     /api/v1/notes)는 클라이언트 zero 확인 후 삭제됨, invoke 만 남았다)는 커맨드를 거치지 않고
//     repo 를 직접 부른다 → **자기 자리에서 publish_remote() 한다.**
//   * 반대로 handlers::invoke 는 **절대 publish 하지 않는다** — 디스패치되는 커맨드가 이미 낸다.
//
// 루프 방지 규칙(payload 의 `origin` = "누가 썼는가"):
//   "local"  = 데스크톱 Tauri IPC 쓰기.
//   "remote" = HTTP 경로(폰) 쓰기 — /api/v1/invoke 는 scope_remote() 로 감싸 표시하고,
//              REST 쓰기 핸들러는 publish_remote() 로 명시한다.
// payload 의 `window` = 쓰기를 낸 데스크톱 창의 라벨(lib.rs invoke_handler 가 scope_window 로 표시).
// 데스크톱 웹뷰 리스너는 window==자기 라벨(자기가 낸 쓰기)만 무시한다 — 데스크톱 스토어는 이미
// 낙관적으로 갱신돼 있으므로 재로드하면 방금 친 글자를 되돌릴 뿐이다. 다른 창(설정·브리핑·섹션 창)의
// 쓰기는 반영한다. window==null 이면서 origin=="local" 은 백그라운드 작업·라벨을 아직 안 싣는 async 커맨드라 누가 냈는지
// 모른다 — 받는 쪽은 트리/목록만 가볍게 재조회한다(src/lib/remoteNoteWrite.ts::classifyWrite). async 쓰기 커맨드는 `publish_as` 로
// 라벨을 싣는다(scope_window 주석). 브라우저 클라이언트는
// 둘 다 반영한다(데스크톱 쓰기를 받는 것이 이 기능의 나머지 절반이므로) — 자기 쓰기의 메아리는
// 재조회 한 번으로 끝나고 새 쓰기를 만들지 않으므로 루프가 아니다.
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::sync::broadcast;

/// 데스크톱 에디터의 디바운스 저장까지 이 버스를 타므로 예전 SSE 전용 채널(16)보다 넉넉하게.
/// 넘치면 느린 구독자가 옛 이벤트를 건너뛸 뿐 송신자는 절대 블록되지 않는다.
const CAPACITY: usize = 64;

static BUS: OnceLock<broadcast::Sender<String>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

tokio::task_local! {
    /// 존재 자체가 "이 태스크의 쓰기는 원격에서 왔다"는 표시. thread_local 이 아니라
    /// task_local 인 이유: tokio 는 work-stealing 이라 await 지점에서 태스크가 다른 스레드로
    /// 옮겨갈 수 있고, 그러면 thread_local 은 엉뚱한 태스크를 remote 로 오염시킨다.
    static REMOTE: Option<String>;
}

thread_local! {
    /// 지금 이 스레드에서 실행 중인 IPC 커맨드를 부른 웹뷰 창의 라벨. task_local 이 아니라 thread_local 인
    /// 이유: 동기 커맨드는 invoke_handler 안에서 그 자리에서(같은 스레드, await 없음) 끝까지 돈다.
    static WINDOW: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// lib.rs invoke_handler 가 모든 앱 커맨드를 이걸로 감싼다 — 그 안에서 불린 publish 는 `window` 에 이 라벨을 싣는다.
///
/// ponytail: **이 단일 지점은 동기 커맨드만** 라벨을 얻는다. tauri 2 의 generate_handler 는 async 커맨드(그리고
/// `#[command(async)]`)의 본문을 `respond_async_serialized` → async_runtime::spawn 으로 다른 태스크에 넘기고
/// 곧바로 돌아오므로 이 스코프는 이미 끝나 있다 → window=null. 커맨드 시그니처 ~100개를 안 바꾸고
/// 라벨을 실어 나를 단일 지점은 없다(본문 future 가 매크로 안에서 만들어진다). 그래서 **쓰기를 알리는 async 커맨드는 개별로**
/// `webview: tauri::Webview` 를 받아 `publish_as(webview.label(), …)` 로 라벨을 싣는다 — 본 창 자신의 붙여넣기·드롭마다 트리를 통째
/// 재조회하던 것을 이걸로 막았다(attachment_add_file/bytes · doc_import_html · export_note · workspace_delete; 모두 http:false 라
/// HTTP 디스패치에 Webview 가 없어도 된다). 아직 라벨이 없는 async 쓰기(pet_chat·audio_transcribe 의 쓰기, 백그라운드 워커의 EXIF
/// 알림)는 그대로 window=null 이고, 받는 쪽(remoteNoteWrite.ts::classifyWrite)은 이를 "출처 모름 → coarse 재조회"로 다룬다.
/// 새 async 쓰기 커맨드를 추가하면 같은 방식으로 라벨을 싣는다.
pub fn scope_window<R>(label: &str, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            WINDOW.with(|w| *w.borrow_mut() = prev);
        }
    }
    // 중첩·패닉에도 이전 값으로 되돌린다(동기 커맨드 안에서 block_on 으로 다른 IPC 가 끼어드는 일은 없지만 싸다).
    let _restore = Restore(WINDOW.with(|w| w.borrow_mut().replace(label.to_string())));
    f()
}

/// async 커맨드용 `publish` — 커맨드가 `webview: tauri::Webview` 를 받아 그 라벨을 넘긴다. `scope_window` 는 thread_local 이라
/// **publish 를 부르는 동기 구간만** 감싸야 한다(여기서 하는 일이 그것이다 — await 를 건너 감싸면 안 된다).
pub fn publish_as(window_label: Option<&str>, note_id: Option<&str>, created: bool) {
    match window_label {
        Some(label) => scope_window(label, || publish(note_id, created)),
        None => publish(note_id, created), // 창이 없는 호출(트레이·테스트) — 출처 모름
    }
}

/// HTTP 경로(폰)에는 창이 없다 — REMOTE 스코프 안이면 무조건 None.
fn ambient_window() -> Option<String> {
    if REMOTE.try_with(|_| ()).is_ok() {
        return None;
    }
    WINDOW.with(|w| w.borrow().clone())
}

fn bus() -> &'static broadcast::Sender<String> {
    BUS.get_or_init(|| broadcast::channel(CAPACITY).0)
}

/// GET /api/v1/events (SSE) 구독. 서버가 떠 있지 않아도(테스트) 항상 유효한 버스를 돌려준다.
pub fn subscribe() -> broadcast::Receiver<String> {
    bus().subscribe()
}

/// lib.rs::setup() 에서 1회 — 데스크톱 웹뷰 emit 대상. mock 런타임 테스트에선 설정되지 않고,
/// 그 경우 publish 는 SSE 버스로만 나간다.
pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// 데스크톱 전용 무페이로드 브로드캐스트 — SSE 버스(원격 폰)로는 안 나가고 로컬 웹뷰 창에만
/// emit 한다. pet-theme-changed(W8-h) 같은, 원격에 존재하지 않는 대상(펫 창은 데스크톱 로컬 전용
/// 창)에게만 알리면 되는 이벤트용. mock 런타임 테스트에선 set_app_handle 이 불리지 않으므로
/// 조용히 no-op(publish_with_origin 의 APP.get() 폴백과 같은 패턴).
pub fn emit_desktop(event: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, ());
    }
}

/// emit_desktop 의 페이로드 버전 — 일정 알림(docs/PLAN-schedule-system.md §5.3)의 메인 창 채널이
/// 문구를 실어 보내야 한다(`app-notice` → App.tsx → invoke.ts::emitNotice → Toast). 위와 같은
/// 이유로 SSE 버스로는 안 나간다: 원격 폰에는 데스크톱 토스트에 대응하는 표면이 없다.
pub fn emit_desktop_json(event: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

fn ambient_origin() -> &'static str {
    if REMOTE.try_with(|_| ()).is_ok() {
        "remote"
    } else {
        "local"
    }
}

/// 이 쓰기를 낸 원격 클라이언트의 id(요청 헤더 X-Brise-Client) — SSE payload 의 `client` 로 실려
/// 간다. 브라우저 클라이언트가 자기 쓰기의 메아리를 알아보는 유일한 방법이다(origin 은 "remote"
/// 하나뿐이라 폰이 자기 저장을 "다른 기기의 변경"으로 오인했다).
fn ambient_client() -> Option<String> {
    REMOTE.try_with(|c| c.clone()).ok().flatten()
}

/// HTTP 경로 표시 — sync_server::handlers::invoke 가 dispatch 호출을 이걸로 감싼다.
/// 이 스코프 안에서 커맨드가 부르는 publish() 는 origin="remote" 가 된다. `client` 는 호출한
/// 클라이언트가 보낸 식별자(없으면 None) — 메아리 판별용이지 인증이 아니다.
pub async fn scope_remote<F: std::future::Future>(client: Option<String>, f: F) -> F::Output {
    REMOTE.scope(client, f).await
}

/// 커맨드 계층에서 부르는 기본 진입점 — origin 은 주변 컨텍스트가 결정한다.
///
/// note_id=None 은 "뭔가 바뀌었다"(폴더/워크스페이스/일괄 임포트처럼 노트 하나로 좁힐 수 없는
/// 변경) — 클라이언트는 무시하지 말고 가벼운 재조회를 해야 한다(src/lib/remoteNoteWrite.ts).
///
/// 주의: spawn_blocking 안에서 부르면 안 된다 — task_local 은 blocking 태스크로 전파되지 않아
/// 원격 쓰기가 조용히 "local" 로 찍힌다. 항상 블로킹 작업이 끝난 뒤 커맨드 본문에서 부를 것.
pub fn publish(note_id: Option<&str>, created: bool) {
    publish_with_origin(ambient_origin(), note_id, created);
}

/// 노트 쓰기가 아닌 이름 있는 이벤트(예: "pet-chat-updated") — 데스크톱 웹뷰 emit 과 SSE 버스에
/// 한 번에 낸다. SSE 프레임 이름은 payload 의 `event` 필드(handlers/sse.rs::events 가 읽는다).
/// payload 는 JSON 객체여야 하며 `event`/`origin` 은 여기서 덮어쓴다. HTTP 경로에서 불리면
/// origin="remote" — 클라이언트가 자기 에코를 구분할 수 있다. 커맨드 본문에서 부를 것
/// (spawn_blocking 안에서는 task_local 이 전파되지 않는다 — publish 와 같은 주의).
pub fn publish_event(event: &str, mut payload: serde_json::Value) {
    let origin = ambient_origin();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("window".into(), ambient_window().map_or(serde_json::Value::Null, serde_json::Value::String));
    }
    let mut sse = payload.clone();
    if let Some(obj) = sse.as_object_mut() {
        obj.insert("event".into(), serde_json::Value::String(event.to_string()));
        obj.insert("origin".into(), serde_json::Value::String(origin.to_string()));
        if let Some(c) = ambient_client() {
            obj.insert("client".into(), serde_json::Value::String(c));
        }
    }
    let _ = bus().send(sse.to_string());
    emit_desktop_json(event, payload);
}

/// 커맨드 계층을 거치지 않는 원격 쓰기(손으로 쓴 REST 핸들러)용.
pub fn publish_remote(note_id: Option<&str>, created: bool) {
    publish_with_origin("remote", note_id, created);
}

fn publish_with_origin(origin: &str, note_id: Option<&str>, created: bool) {
    // 하나의 신호, 두 소비자. SSE payload 만 "event" 필드를 더 갖는다(기존 셰이프 유지 —
    // 웹 클라이언트는 SSE 프레임 이름으로 라우팅하지만 payload 의 필드도 계약의 일부다).
    let window = ambient_window();
    let common = serde_json::json!({ "note_id": note_id, "created": created, "origin": origin, "window": window });
    let mut sse = serde_json::json!({
        "event": "remote-note-write",
        "note_id": note_id,
        "created": created,
        "origin": origin,
        "window": window,
    });
    if let Some(c) = ambient_client() {
        sse["client"] = serde_json::Value::String(c);
    }
    let _ = bus().send(sse.to_string());
    if let Some(app) = APP.get() {
        let _ = app.emit("remote-note-write", common);
        // 분리된 섹션 창의 대상이 방금 삭제됐으면 닫는다 — 모든 쓰기가 지나가는 이 자리 하나에서
        // (section_window.rs::close_orphans). 분리 창이 없으면 즉시 반환한다.
        crate::section_window::close_orphans(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 버스는 프로세스 전역이고 cargo 는 테스트를 병렬로 돌린다 — 다른 테스트의 이벤트가
    // 섞이므로 항상 이 테스트만의 note_id 로 필터링해서 본다.

    #[tokio::test]
    async fn publish_outside_the_http_scope_is_tagged_local() {
        let mut rx = subscribe();
        publish(Some("evt-local-1"), false);
        let payload = loop {
            let p: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            if p["note_id"] == "evt-local-1" {
                break p;
            }
        };
        assert_eq!(payload["origin"], "local");
        assert_eq!(payload["event"], "remote-note-write", "SSE frame payload shape must stay backward compatible");
    }

    #[tokio::test]
    async fn publish_inside_scope_remote_is_tagged_remote() {
        let mut rx = subscribe();
        scope_remote(Some("phone-1".to_string()), async {
            publish(Some("evt-remote-1"), true);
        })
        .await;
        let payload = loop {
            let p: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            if p["note_id"] == "evt-remote-1" {
                break p;
            }
        };
        assert_eq!(payload["origin"], "remote");
        assert_eq!(payload["created"], true);
        assert_eq!(payload["client"], "phone-1", "SSE payload must carry the writer's client id for echo detection");
    }

    /// 스코프를 벗어나면 다시 local — 태스크 하나가 remote 로 물들고 끝나지 않는다.
    #[tokio::test]
    async fn origin_does_not_leak_past_the_scope() {
        let mut rx = subscribe();
        scope_remote(None, async { publish(Some("evt-leak"), false) }).await;
        publish(Some("evt-leak"), false);
        let mut origins = vec![];
        while let Ok(p) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&p).unwrap();
            if v["note_id"] == "evt-leak" {
                origins.push(v["origin"].as_str().unwrap().to_string());
            }
        }
        assert_eq!(origins, vec!["remote", "local"]);
    }

    /// lib.rs invoke_handler 의 scope_window 안(=동기 커맨드)이면 라벨, 밖이면 null.
    #[tokio::test]
    async fn publish_carries_the_ambient_window_label_only_inside_the_scope() {
        let mut rx = subscribe();
        scope_window("settings", || publish(Some("evt-win-in"), false));
        publish(Some("evt-win-out"), false);
        let mut seen = std::collections::HashMap::new();
        while let Ok(p) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&p).unwrap();
            if let Some(id) = v["note_id"].as_str().filter(|id| id.starts_with("evt-win-")) {
                seen.insert(id.to_string(), v["window"].clone());
            }
        }
        assert_eq!(seen["evt-win-in"], "settings");
        assert!(seen["evt-win-out"].is_null(), "outside the scope the label must not leak");
    }

    /// 이름 있는 이벤트도 같은 규칙, HTTP 경로(scope_remote)는 창이 없으므로 null.
    #[tokio::test]
    async fn publish_event_carries_window_and_remote_has_none() {
        let mut rx = subscribe();
        scope_window("main", || publish_event("evt-win-named", serde_json::json!({ "k": "a" })));
        scope_remote(None, async {
            scope_window("main", || publish_event("evt-win-named", serde_json::json!({ "k": "b" })));
        })
        .await;
        let mut seen = std::collections::HashMap::new();
        while let Ok(p) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&p).unwrap();
            if v["event"] == "evt-win-named" {
                seen.insert(v["k"].as_str().unwrap().to_string(), v["window"].clone());
            }
        }
        assert_eq!(seen["a"], "main");
        assert!(seen["b"].is_null());
    }

    /// async 커맨드용 publish_as — 라벨을 싣고 끝나면 새지 않는다.
    #[tokio::test]
    async fn publish_as_carries_the_label_and_does_not_leak_it() {
        let mut rx = subscribe();
        publish_as(Some("main"), Some("evt-as-in"), false);
        publish(Some("evt-as-out"), false);
        publish_as(None, Some("evt-as-none"), false);
        let mut seen = std::collections::HashMap::new();
        while let Ok(p) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&p).unwrap();
            if let Some(id) = v["note_id"].as_str().filter(|id| id.starts_with("evt-as-")) {
                seen.insert(id.to_string(), v["window"].clone());
            }
        }
        assert_eq!(seen["evt-as-in"], "main");
        assert!(seen["evt-as-out"].is_null(), "the label must not leak past publish_as");
        assert!(seen["evt-as-none"].is_null(), "no label = unattributed");
    }

    #[tokio::test]
    async fn coarse_event_carries_a_null_note_id() {
        let mut rx = subscribe();
        publish(None, false);
        let mut saw_null = false;
        while let Ok(p) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&p).unwrap();
            if v["note_id"].is_null() {
                saw_null = true;
            }
        }
        assert!(saw_null, "a coarse change must publish note_id: null, not be dropped");
    }
}
