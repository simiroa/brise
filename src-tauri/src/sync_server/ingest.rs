// 캡처 ingest 리스너 — 폰 자동화 앱(Tasker/단축어)이 결제문자를 넣는 loopback 서버.
//
// 2026-09-09 크롬 익스텐션 철수로 `/clip`·`/visit`·`/config`·`/pair` 라우트가 사라지고 `/ping`
// 과 `/ledger` 둘만 남았다. 방문 기록은 익스텐션이 아니라 크롬 History 파일을 직접 읽는
// collect::browser_history 어댑터가 대신한다(PLAN-2026-09-04-local-import).
//
// sync_server 와 **완전히 독립**이다: sync_enabled 와 무관하게 켜지고 꺼지며, 포트도 토큰도
// 별개다(capture_ingest_port / capture_ingest_token). 합승하지 않는 이유가 Q4 그 자체다 —
// sync 서버는 Tailscale CGNAT 인터페이스가 있으면 거기에 바인딩하므로(bind::pick_bind_addr)
// 브라우저가 127.0.0.1 로 붙을 수 없게 되는 순간이 있다.
//
// 그래서 바인딩 주소는 **127.0.0.1 고정**이고, bind.rs 를 아예 거치지 않는다(loopback 보다
// 넓은 주소는 선택지에 없다). 재사용하는 것은 axum 과 인증 규칙(handlers::token_authorized)뿐.
//
// CORS 헤더를 붙이지 않는다: 일반 웹페이지가 이 포트로 JSON POST 를 던지려면 preflight 가
// 필요한데, 헤더가 없으면 브라우저가 요청 자체를 막는다 — 안 붙이는 쪽이 더 안전하다(토큰이
// 이미 있어야 하는 것과 별개의 두 번째 벽). 폰 자동화 앱은 브라우저가 아니라 CORS 를 안 탄다.
use crate::db;
use crate::error::{db as dberr, io as ioerr, AppResult};
use crate::repo::ai::{self, LedgerExtraction, RealTextTransport};
use crate::sync_server::handlers::token_authorized;
use crate::sync_server::Running;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

pub const DEFAULT_INGEST_PORT: i64 = 7333;

/// 앱 전역 ingest 핸들 — SyncState 와 같은 모양이지만 **다른 서버**다(lib.rs 가 둘 다 manage 한다).
#[derive(Default)]
pub struct IngestState(pub parking_lot::Mutex<Option<Running>>);

#[derive(Clone)]
struct IngestServerState {
    data_dir: PathBuf,
    token: String,
}

/// 결제문자/알림 캡처 채널(가계부) — clip/visits와 같은 자세: 시드 없음 = OFF.
fn ledger_enabled(conn: &Connection) -> bool {
    crate::repo::settings::get_all(conn)
        .ok()
        .and_then(|s| s.get("capture_ledger_enabled").and_then(|v| v.as_str()).map(|v| v == "1"))
        .unwrap_or(false)
}

/// 설정에서 (리스너를 띄워야 하는가, port, token) 을 읽는다 — sync_server::read_sync_settings 와
/// 같은 모양. 채널이 **하나라도** 켜져 있으면 리스너가 필요하다(클리핑만 끄고 방문 기록만 켜는
/// 조합이 정상 경로다). 채널별 게이트는 요청 핸들러가 따로 본다.
pub fn read_ingest_settings(conn: &Connection) -> AppResult<(bool, u16, String)> {
    let settings = crate::repo::settings::get_all(conn)?;
    let enabled = settings.get("capture_clip_enabled").and_then(|v| v.as_str()) == Some("1")
        || settings.get("capture_visits_enabled").and_then(|v| v.as_str()) == Some("1")
        || settings.get("capture_ledger_enabled").and_then(|v| v.as_str()) == Some("1");
    let port = settings
        .get("capture_ingest_port")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_INGEST_PORT) as u16;
    let token = settings
        .get("capture_ingest_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((enabled, port, token))
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

/// GET /ping — 토큰 검증만. 익스텐션 옵션 페이지의 "연결 테스트" 전용이라 앱 상태를 아무것도
/// 흘리지 않는다(sync 쪽 /api/v1/ping 과 달리 버전·기기 id 를 담지 않는다).
async fn ping(State(state): State<IngestServerState>, headers: HeaderMap) -> Response {
    if !token_authorized(&state.token, &headers, None) {
        return unauthorized();
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// POST /ledger 본문 — 알림/결제문자 원문 그대로. 파싱은 서버가 한다(자동화 앱 쪽에 로직을
/// 두지 않는다 — Tasker 설정이 복잡해지면 사용자가 포기한다).
#[derive(Deserialize, Serialize, Clone)]
pub struct LedgerBody {
    pub text: String,
}

/// 원문의 짧은 해시 태그 — 자동화 앱이 같은 알림을 실수로 두 번 보내도(재시도·중복 트리거) 같은
/// 날 노트에 두 번 쌓이지 않게 한다. collect_seen처럼 전용 테이블을 두지 않고 append_visit의
/// (url,날짜) 본문-검색 중복판정과 같은 자세 — 하루치 노트 한 개를 훑는 비용은 무해하다.
fn content_tag(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.trim().as_bytes());
    format!("#{:x}", hasher.finalize())[..9].to_string() // "#" + 8 hex chars
}

const LEDGER_NOTE_TITLE_PREFIX: &str = "가계부 — ";

fn ledger_note_title(date: &str) -> String {
    format!("{LEDGER_NOTE_TITLE_PREFIX}{date}")
}

fn format_krw(amount: f64) -> String {
    let rounded = amount.round() as i64;
    let digits = rounded.abs().to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let grouped: String = grouped.chars().rev().collect();
    format!("{grouped}원")
}

/// 원문 텍스트 + (있으면) AI 추출 결과 → 한 줄. amount가 없으면(파싱 실패거나 애초에 결제
/// 알림이 아니었거나) "파싱 필요" 딱지를 달고 원문을 그대로 남긴다 — 절대 조용히 버리지 않는다
/// (돈 기록은 캡처 실패보다 "일단 원문이라도 남기고 나중에 사람이 본다"가 항상 낫다).
fn format_ledger_line(text: &str, parsed: Option<&LedgerExtraction>) -> String {
    let time = chrono::Local::now().format("%H:%M");
    let tag = content_tag(text);
    let raw_preview: String = text.trim().chars().take(200).collect();
    match parsed.and_then(|p| p.amount.map(|amt| (p, amt))) {
        Some((p, amount)) => {
            let sign = if p.is_expense == Some(false) { "+" } else { "-" };
            let merchant = p.merchant.as_deref().unwrap_or("(상호 미상)");
            let category = p.category.as_deref().map(|c| format!(" ({c})")).unwrap_or_default();
            format!("- {time} **{sign}{}**{category} {merchant} [{tag}]", format_krw(amount))
        }
        None => format!("- {time} (파싱 필요) {raw_preview} [{tag}]"),
    }
}

/// 당일 가계부 노트에 한 줄 append — append_visit과 완전히 같은 자세(없으면 생성, 같은 원문
/// 해시 태그가 이미 있으면 스킵, sections 직접 UPDATE로 activity_log 2000행 상한을 밀어내지
/// 않는다).
fn append_ledger_line(conn: &mut Connection, text: &str, parsed: Option<&LedgerExtraction>) -> AppResult<bool> {
    let tag = content_tag(text);
    let line = format_ledger_line(text, parsed);
    let (y, m, d) = crate::util::today_ymd_local();
    let note_title = ledger_note_title(&format!("{y:04}-{m:02}-{d:02}"));
    let workspace_id = crate::repo::folders::active_workspace_id(conn)?;
    // 가계부 일자 노트도 방문 기록과 같은 동기화 수렴 규칙을 탄다(collect::daynote — 같은 제목이 여럿이면
    // 가장 오래된 노트로 합치고 나머지는 소프트 삭제). 세 번째 일자 노트 작성자가 다른 규칙을 쓰면
    // 기기 간 병합이 한 곳에서만 깨진다.
    let folder_id = crate::repo::folders::ensure_inbox_folder_id(conn, &workspace_id)?;
    let existing = crate::collect::daynote::find_or_merge_day_note(conn, &workspace_id, &folder_id, &note_title)?;

    let Some((note_id, section_id, _)) = existing else {
        crate::repo::pet::create_inbox_note(conn, &workspace_id, None, Some(&note_title), &line)?;
        return Ok(true);
    };
    let now = crate::util::now_iso();
    // 본문은 쓰기 트랜잭션 **안에서** 다시 읽는다 — 밖에서 읽은 값에 덧붙이면 그 사이 들어온 편집기 자동
    // 저장(폰·데스크톱)을 덮는다. 쓰기는 단일 지점 write_body_tx(버전 토큰 단조 증가 — 그 노트를 열어 둔
    // 클라이언트의 다음 저장이 CONFLICT 로 드러난다. 2026-10-07 제안서가 찾은 7번째 직접 UPDATE 경로).
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(dberr)?;
    let body: String = tx
        .query_row("SELECT body_md FROM sections WHERE id=?1", [&section_id], |r| r.get(0))
        .map_err(dberr)?;
    if body.contains(&format!("[{tag}]")) {
        return Ok(false);
    }
    let next_body = format!("{}\n{line}", body.trim_end());
    crate::repo::sections::write_body_tx(&tx, &note_id, &section_id, &next_body, &now)?;
    crate::repo::fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// POST /ledger — clip과 달리 여기서 바로 적재한다(visit과 같은 이유: 오늘 쓴 돈이 오늘 알림을
/// 요구한다). AI 파싱은 게이트가 닫혀 있거나 실패해도 캡처 자체를 막지 않는다 — 원문만이라도
/// 남기는 쪽이 항상 "파싱 실패 시 통째로 버림"보다 낫다(§format_ledger_line).
async fn ledger(State(state): State<IngestServerState>, headers: HeaderMap, Json(body): Json<LedgerBody>) -> Response {
    if !token_authorized(&state.token, &headers, None) {
        return unauthorized();
    }
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, "text is required").into_response();
    }

    let data_dir = state.data_dir.clone();
    let gate_and_creds = {
        let data_dir = data_dir.clone();
        tokio::task::spawn_blocking(move || {
            let conn = db::open(&db::db_path(&data_dir)).ok()?;
            Some((ledger_enabled(&conn), ai::read_ai_creds(&conn)))
        })
        .await
        .ok()
        .flatten()
    };
    let Some((gate, creds)) = gate_and_creds else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "failed to read capture settings").into_response();
    };
    if !gate {
        return (StatusCode::FORBIDDEN, "capture ledger channel is off").into_response();
    }

    // AI 파싱 — conn을 놓은 뒤(락 규율, docs/COLLECT.md §2.2와 동일 원칙) 여기서 네트워크 호출.
    // 실패(프로바이더 게이트 닫힘·타임아웃·JSON 파싱 실패 전부)는 조용히 None — 원문 라인으로
    // 폴백한다.
    let parsed = 'parse: {
        let Ok((provider, ep)) = ai::resolve_provider_and_endpoint(&creds.provider, creds.endpoint.clone()) else {
            break 'parse None;
        };
        if !ai::privacy_gate_ok(&provider, &ep, creds.ai_enabled) {
            break 'parse None;
        }
        let transport = RealTextTransport::new(None);
        ai::parse_ledger_text_with_transport(provider, ep, creds.api_key.clone(), creds.model.clone(), text.clone(), &transport)
            .await
            .ok()
    };

    let text_for_write = text.clone();
    let outcome = tokio::task::spawn_blocking(move || match db::open(&db::db_path(&data_dir)) {
        Ok(mut conn) => append_ledger_line(&mut conn, &text_for_write, parsed.as_ref()),
        Err(e) => Err(e),
    })
    .await;
    match outcome {
        Ok(Ok(stored)) => Json(serde_json::json!({ "ok": true, "stored": stored })).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "failed to record ledger entry").into_response(),
    }
}

/// 결제문자 한 건은 짧은 텍스트다 — 노트 한 편이 통째로 들어올 이유가 없다.
const INGEST_BODY_LIMIT_BYTES: usize = 256 * 1024;

fn build_router(state: IngestServerState) -> Router {
    Router::new()
        .route("/ping", get(ping))
        .route("/ledger", post(ledger))
        .layer(axum::extract::DefaultBodyLimit::max(INGEST_BODY_LIMIT_BYTES))
        .with_state(state)
}

/// 서버 시작 — 주소는 항상 127.0.0.1. data_dir/port/token 만으로 결정되는 순수 진입점이라
/// AppState 없이도 임시 디렉토리 + 포트 0 으로 통합 테스트를 돌릴 수 있다(sync_server::start 와 동일).
pub fn start(
    data_dir: PathBuf,
    port: u16,
    token: String,
) -> AppResult<(SocketAddr, tauri::async_runtime::JoinHandle<()>)> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let std_listener = std::net::TcpListener::bind(addr).map_err(ioerr)?;
    std_listener.set_nonblocking(true).map_err(ioerr)?;
    let bound_addr = std_listener.local_addr().map_err(ioerr)?;
    let router = build_router(IngestServerState { data_dir, token });
    let handle = tauri::async_runtime::spawn(async move {
        // from_std 는 활성 Tokio reactor 가 있는 스레드에서만 된다 — sync_server::start 와 같은
        // 이유로 변환 자체를 스폰된 블록 안에서 한다.
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                // U7: serve-task death — capture ingest 리스너가 다시 안 뜬다(수동 토글 전까지).
                crate::diag::error("sync", "capture_listener_setup_failed", format!("{e}"));
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            crate::diag::error("sync", "capture_serve_failed", format!("{e}"));
        }
    });
    Ok((bound_addr, handle))
}

/// 실행 중이면 중단(abort). 설정 토글-off 시 호출 — no-op 이면 조용히 지나간다.
pub fn stop(state: &IngestState) {
    if let Some(running) = state.0.lock().take() {
        running.handle.abort();
    }
}

/// 부팅 시 채널이 켜져 있으면 자동 기동 — sync_server::maybe_start_at_boot 와 같은
/// 자리(lib.rs::setup)에서 호출된다. 토큰이 없으면 시작하지 않는다(fail-closed 대칭).
pub fn maybe_start_at_boot(app: &tauri::AppHandle, conn: &Connection, data_dir: &Path) {
    use tauri::Manager;
    let (enabled, port, token) = match read_ingest_settings(conn) {
        Ok(v) => v,
        Err(e) => {
            crate::diag::error("sync", "capture_boot_settings_read_failed", format!("{e}"));
            return;
        }
    };
    if !enabled || token.is_empty() {
        return;
    }
    match start(data_dir.to_path_buf(), port, token.clone()) {
        Ok((addr, handle)) => {
            *app.state::<IngestState>().0.lock() = Some(Running { handle, addr, token });
        }
        Err(e) => crate::diag::error("sync", "capture_boot_autostart_failed", format!("{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use rusqlite::OptionalExtension;
    use std::collections::BTreeMap;

    fn set_settings(data_dir: &Path, entries: BTreeMap<String, serde_json::Value>) {
        let mut conn = db::open(&db::db_path(data_dir)).unwrap();
        crate::repo::settings::set(&mut conn, &entries).unwrap();
    }

    /// /ping 은 토큰만 본다 — 맞으면 200, 틀리거나 없으면 401.
    #[tokio::test]
    async fn ping_requires_the_ingest_token() {
        let data_dir = tempfile::tempdir().unwrap();
        drop(db::bootstrap(data_dir.path()).unwrap());

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "ingest-tok".to_string()).unwrap();
        assert!(addr.ip().is_loopback(), "ingest must never bind wider than loopback");
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();

        let ok = client
            .get(format!("http://{addr}/ping"))
            .header("Authorization", "Bearer ingest-tok")
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);

        let denied = client.get(format!("http://{addr}/ping")).send().await.unwrap();
        assert_eq!(denied.status(), 401);

        handle.abort();
    }

    fn ledger_on(data_dir: &Path) {
        let mut entries = BTreeMap::new();
        entries.insert("capture_ledger_enabled".to_string(), serde_json::json!("1"));
        set_settings(data_dir, entries);
    }

    fn today_ledger_note_body(data_dir: &Path) -> Option<String> {
        let (y, m, d) = crate::util::today_ymd_local();
        let title = ledger_note_title(&format!("{y:04}-{m:02}-{d:02}"));
        let conn = db::open(&db::db_path(data_dir)).unwrap();
        conn.query_row(
            "SELECT s.body_md FROM notes n JOIN sections s ON s.note_id = n.id WHERE n.title = ?1",
            params![title],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .unwrap()
    }

    /// /clip·/visit과 같은 규칙 — 토큰이 맞아도 capture_ledger_enabled가 "1"이 아니면 403,
    /// 그보다 먼저 401. 이 지점까진 AI 호출이 전혀 일어나지 않으므로 결정론적으로 테스트할 수
    /// 있다(위 모듈 주석).
    #[tokio::test]
    async fn ledger_is_403_until_the_channel_setting_is_on_and_401_beats_403() {
        let data_dir = tempfile::tempdir().unwrap();
        drop(db::bootstrap(data_dir.path()).unwrap());

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "ingest-tok".to_string()).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();
        let payload = serde_json::json!({ "text": "스타벅스 4,500원 결제되었습니다" });

        let blocked = client
            .post(format!("http://{addr}/ledger"))
            .header("Authorization", "Bearer ingest-tok")
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), 403, "the gate lives in Rust, not in the automation app");
        assert!(today_ledger_note_body(data_dir.path()).is_none());

        let unauth = client.post(format!("http://{addr}/ledger")).json(&payload).send().await.unwrap();
        assert_eq!(unauth.status(), 401, "401 beats 403, same order as /clip and /visit");

        handle.abort();
    }

    #[tokio::test]
    async fn ledger_rejects_empty_text() {
        let data_dir = tempfile::tempdir().unwrap();
        drop(db::bootstrap(data_dir.path()).unwrap());
        ledger_on(data_dir.path());

        let (addr, handle) = start(data_dir.path().to_path_buf(), 0, "ingest-tok".to_string()).unwrap();
        tokio::task::yield_now().await;
        let client = reqwest::Client::new();
        let empty = client
            .post(format!("http://{addr}/ledger"))
            .header("Authorization", "Bearer ingest-tok")
            .json(&serde_json::json!({ "text": "   " }))
            .send()
            .await
            .unwrap();
        assert_eq!(empty.status(), 400);
        handle.abort();
    }

    fn extraction(merchant: &str, amount: f64, category: &str, is_expense: bool) -> LedgerExtraction {
        LedgerExtraction {
            merchant: Some(merchant.to_string()),
            amount: Some(amount),
            currency: Some("KRW".to_string()),
            category: Some(category.to_string()),
            is_expense: Some(is_expense),
        }
    }

    #[test]
    fn format_ledger_line_renders_amount_merchant_and_category_for_an_expense() {
        let line = format_ledger_line("[Web발신] 스타벅스 4,500원", Some(&extraction("스타벅스", 4500.0, "카페", true)));
        assert!(line.contains("-4,500원"));
        assert!(line.contains("스타벅스"));
        assert!(line.contains("(카페)"));
    }

    #[test]
    fn format_ledger_line_uses_a_plus_sign_for_a_deposit() {
        let line = format_ledger_line("입금 50,000원", Some(&extraction("계좌이체", 50000.0, "입금", false)));
        assert!(line.contains("+50,000원"));
    }

    /// amount가 없으면(파싱 실패든, 애초에 결제 알림이 아니었든) 원문을 그대로 남긴다 —
    /// 조용히 버리지 않는다는 게 이 기능의 핵심 불변식이다.
    #[test]
    fn format_ledger_line_falls_back_to_the_raw_text_when_amount_is_missing() {
        let no_parse = format_ledger_line("알 수 없는 알림 문자입니다", None);
        assert!(no_parse.contains("파싱 필요"));
        assert!(no_parse.contains("알 수 없는 알림 문자입니다"));

        let empty_extraction = LedgerExtraction::default();
        let null_amount = format_ledger_line("애매한 문자", Some(&empty_extraction));
        assert!(null_amount.contains("파싱 필요"));
    }

    #[test]
    fn append_ledger_line_creates_a_daily_note_and_dedupes_the_same_text() {
        let data_dir = tempfile::tempdir().unwrap();
        drop(db::bootstrap(data_dir.path()).unwrap());
        let mut conn = db::open(&db::db_path(data_dir.path())).unwrap();

        let parsed = extraction("스타벅스", 4500.0, "카페", true);
        assert!(append_ledger_line(&mut conn, "스벅 결제 문자", Some(&parsed)).unwrap());
        // Same raw text again (e.g. Tasker double-fired the trigger) — must not double-count.
        assert!(!append_ledger_line(&mut conn, "스벅 결제 문자", Some(&parsed)).unwrap());

        let saved = today_ledger_note_body(data_dir.path()).unwrap();
        assert_eq!(saved.lines().filter(|l| l.contains("스타벅스")).count(), 1, "dedup must not double-append");

        // A second, genuinely different notification the same day appends a second line to the
        // SAME daily note (not a second note).
        let parsed2 = extraction("이마트", 32000.0, "쇼핑", true);
        assert!(append_ledger_line(&mut conn, "이마트 결제 문자", Some(&parsed2)).unwrap());
        let notes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1",
                params![ledger_note_title(&{
                    let (y, m, d) = crate::util::today_ymd_local();
                    format!("{y:04}-{m:02}-{d:02}")
                })],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(notes, 1, "하루에 노트 하나 — append다");
        assert!(today_ledger_note_body(data_dir.path()).unwrap().contains("이마트"));
    }

    /// AI 파싱이 완전히 없어도(None) 원문 캡처 자체는 성공한다 — "AI 실패는 캡처를 막지 않는다"
    /// 불변식(§ledger 핸들러 주석)을 append 계층에서 직접 확인.
    #[test]
    fn append_ledger_line_stores_the_raw_text_when_no_extraction_is_available() {
        let data_dir = tempfile::tempdir().unwrap();
        drop(db::bootstrap(data_dir.path()).unwrap());
        let mut conn = db::open(&db::db_path(data_dir.path())).unwrap();

        assert!(append_ledger_line(&mut conn, "이상한 알림, 파싱 못함", None).unwrap());
        let saved = today_ledger_note_body(data_dir.path()).unwrap();
        assert!(saved.contains("이상한 알림, 파싱 못함"));
    }
}
