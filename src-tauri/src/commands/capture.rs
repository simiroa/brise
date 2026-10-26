// commands: capture (결제문자 ingest 리스너) — specs/commands/capture.yaml.
// 서버 자체 로직은 sync_server::ingest, 여기는 그 위의 얇은 IPC 래퍼 + 설정 영속만 담당한다
// (commands/sync.rs 와 완전히 같은 구조 — 다른 서버라는 점만 다르다).
use super::AppState;
use crate::error::AppError;
use crate::sync_server::ingest::{self, IngestState, DEFAULT_INGEST_PORT};
use crate::sync_server::Running;
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::State;

#[derive(Serialize)]
pub struct CaptureStatus {
    /// capture_ledger_enabled — 결제문자/알림 캡처 채널(Tasker/단축어 연동). 2026-09-09 크롬
    /// 익스텐션 철수 전에는 clip/visits 채널이 같은 리스너를 공유했다.
    pub ledger_enabled: bool,
    /// 리스너가 실제로 살아있는지. 포트 충돌로 기동에 실패하면 채널이 켜진 채로 false.
    pub running: bool,
    pub port: i64,
    pub token: String,
}

/// (ledger_enabled, port, token).
fn read_settings(state: &AppState) -> Result<(bool, i64, String), AppError> {
    let conn = state.db.lock();
    let settings = crate::repo::settings::get_all(&conn)?;
    Ok((
        settings.get("capture_ledger_enabled").and_then(|v| v.as_str()) == Some("1"),
        settings.get("capture_ingest_port").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_INGEST_PORT),
        settings.get("capture_ingest_token").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    ))
}

fn build_status(
    ledger_enabled: bool,
    port: i64,
    token: String,
    ingest_state: &IngestState,
) -> CaptureStatus {
    // sync 쪽 build_status 와 같은 헬스체크 — 태스크가 죽었으면 "running: true" 는 거짓말이다.
    let running = ingest_state.0.lock().as_ref().is_some_and(|r| !r.handle.inner().is_finished());
    CaptureStatus { ledger_enabled, running, port, token }
}

#[tauri::command(rename_all = "snake_case")]
pub fn capture_status(state: State<AppState>, ingest_state: State<IngestState>) -> Result<CaptureStatus, AppError> {
    let (ledger_enabled, port, token) = read_settings(&state)?;
    Ok(build_status(ledger_enabled, port, token, &ingest_state))
}

/// 채널 토글을 저장하고 리스너를 설정과 일치시킨다 — 켜지면 기동, 꺼지면 abort.
///
/// on: 토큰이 비어 있으면(첫 활성화) 새로 생성해 영속. 바인딩 실패 시 방금 저장한 값을 "0" 으로
/// 롤백한다(sync_set_enabled 와 같은 규칙 — 안 그러면 DB 는 "켜짐"인데 리스너는 안 떠서 사용자가
/// 껐다 켜기 전엔 재시도되지 않는다).
///
/// 2026-09-09 크롬 익스텐션 철수 전에는 clip/visits/ledger 세 토글이 이 리스너를 공유했고, 그래서
/// 이 함수가 `key: &str` 를 받아 "하나라도 켜져 있으면 기동"을 판정했다. 채널이 하나만 남아
/// 그 일반화는 사라졌다 — 다음 채널이 실제로 생기면 그때 되살리는 것이 업그레이드 경로다.
///
/// ponytail: 포트 변경은 sync 쪽과 같은 관례로 settings_set 이 담당하고, 실행 중인 리스너는 다음
/// 토글 사이클에만 새 포트를 반영한다. 토큰 재발급 커맨드도 두지 않는다 — 필요하면 껐다 켜는
/// 대신 이 파일에 sync_regenerate_token 과 같은 arm 을 하나 더 만드는 것이 업그레이드 경로.
#[tauri::command(rename_all = "snake_case")]
pub fn capture_set_ledger_enabled(
    state: State<AppState>,
    ingest_state: State<IngestState>,
    enabled: bool,
) -> Result<CaptureStatus, AppError> {
    let (port, token) = {
        let mut conn = state.db.lock();
        let settings = crate::repo::settings::get_all(&conn)?;
        let port = settings
            .get("capture_ingest_port")
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_INGEST_PORT);
        let mut token = settings
            .get("capture_ingest_token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut entries: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        entries.insert("capture_ledger_enabled".to_string(), serde_json::json!(if enabled { "1" } else { "0" }));
        if enabled && token.is_empty() {
            token = crate::util::new_id();
            entries.insert("capture_ingest_token".to_string(), serde_json::json!(token));
        }
        crate::repo::settings::set(&mut conn, &entries)?;
        (port, token)
    };

    ingest::stop(&ingest_state);
    if enabled {
        match ingest::start(state.data_dir.clone(), port as u16, token.clone()) {
            Ok((addr, handle)) => {
                *ingest_state.0.lock() = Some(Running { handle, addr, token: token.clone() });
            }
            Err(e) => {
                let mut conn = state.db.lock();
                let mut rollback: BTreeMap<String, serde_json::Value> = BTreeMap::new();
                rollback.insert("capture_ledger_enabled".to_string(), serde_json::json!("0"));
                let _ = crate::repo::settings::set(&mut conn, &rollback);
                return Err(e);
            }
        }
    }
    Ok(build_status(enabled, port, token, &ingest_state))
}
