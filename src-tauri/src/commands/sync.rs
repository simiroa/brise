// commands: sync (beta) — commands/sync.yaml. 서버 자체 로직은 sync_server::*, 여기는 그 위의
// 얇은 IPC 래퍼 + 설정 영속(sync_enabled/sync_port/sync_token, migrations.rs SSOT)만 담당.
use super::AppState;
use crate::error::AppError;
use crate::sync_server::{self, Running, SyncState};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::State;

const DEFAULT_PORT: i64 = 7332;

#[derive(Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub running: bool,
    pub bound_addr: Option<String>,
    pub port: i64,
    pub token: String,
    pub url: Option<String>,
    /// url 을 그대로 인코딩한 QR 코드(SVG 마크업 문자열) — 폰 카메라로 스캔하면 토큰까지 포함된
    /// URL이 바로 열린다. url 과 완전히 결정적으로 같은 정보라 별도 커맨드 없이 매번 재계산한다
    /// (토큰/포트가 바뀌는 시점 = url 이 바뀌는 시점 = 이 필드가 바뀌는 시점, 항상 같음).
    pub qr_svg: Option<String>,
    /// 추가 필드(additive — specs/commands/sync.yaml 하위호환 규칙): running:true 인 채로도 이
    /// 서버가 바인딩됐던 Tailscale CGNAT 인터페이스가 그 사이 사라졌을 수 있다(인터페이스
    /// 재기동/tailscale 재할당). true 면 설정 화면이 경고를 보여줄 근거만 준다 — 자동 재바인딩은
    /// 절대 하지 않는다(과제 지시). loopback 바인딩은 원래 폴백이라 항상 false.
    pub bind_stale: bool,
}

/// owner 요구사항: 설정 카드에서 QR 스캔만으로 접속 URL(토큰 포함)을 열 수 있어야 한다 — 이
/// 트레이드오프(QR에 bearer 토큰이 그대로 인코딩됨)는 sync_token 이 이미 화면에 평문 노출되는
/// 것과 같은 신뢰 경계(설정 모달, 소유자 본인의 데스크톱)라 owner 가 수용했다. 인코딩 실패
/// (사실상 없음 — URL 길이가 QR 상한을 넘는 극단적 경우만)는 카드에서 QR 없이 URL 텍스트만
/// 보여주는 것으로 충분해 Option으로 조용히 흡수한다.
fn build_qr_svg(url: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(url.as_bytes()).ok()?;
    Some(code.render::<svg::Color>().min_dimensions(180, 180).build())
}

fn read_settings(state: &AppState) -> Result<(bool, i64, String), AppError> {
    let conn = state.db.lock();
    let settings = crate::repo::settings::get_all(&conn)?;
    let enabled = settings.get("sync_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let port = settings.get("sync_port").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_PORT);
    let token = settings.get("sync_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok((enabled, port, token))
}

/// 이 기기가 실제로 붙어있는 Tailscale CGNAT 인터페이스 목록에 `ip`가 더는 없으면(그리고
/// loopback도 아니면) "stale" — 인터페이스가 재기동/재할당됐는데 서버는 옛 주소로 계속 리슨
/// 중인 상태다. loopback은 원래 항상 유효한 폴백이므로 절대 stale 취급하지 않는다.
fn is_bind_stale(ip: std::net::IpAddr) -> bool {
    if ip.is_loopback() {
        return false;
    }
    !crate::sync_server::bind::local_ipv4_addrs().contains(&ip)
}

fn build_status(enabled: bool, port: i64, token: String, sync_state: &SyncState) -> SyncStatus {
    let guard = sync_state.0.lock();
    // 헬스체크(§9): axum 태스크가 패닉으로 죽었으면 handle이 finished 상태가 된다 — Running{} 을
    // 영원히 들고 있어도 그 서버는 더 이상 요청을 받지 않으므로 "running: true"는 거짓말이다.
    let live = guard.as_ref().filter(|r| !r.handle.inner().is_finished());
    match live {
        Some(r) => {
            let ip = r.addr.ip().to_string();
            let bound = format!("{ip}:{}", r.addr.port());
            // /app = 정식 웹 클라이언트(React, 폰이면 모바일 레이아웃 자동). 구형 /m 뷰어는
            // 폴백으로 남아 있지만 안내 URL/QR은 /app을 가리킨다 (2026-07-29).
            let url = format!("http://{bound}/app?token={token}");
            let qr_svg = build_qr_svg(&url);
            let bind_stale = is_bind_stale(r.addr.ip());
            SyncStatus { enabled, running: true, bound_addr: Some(bound), port, token, url: Some(url), qr_svg, bind_stale }
        }
        None => SyncStatus { enabled, running: false, bound_addr: None, port, token, url: None, qr_svg: None, bind_stale: false },
    }
}

/// 설정 카드 상태 조회 — 서버 자체(SyncState)가 실행 여부/바인딩 주소의 진실 원천이고,
/// enabled/port/token은 설정 테이블에서 읽는다(재시작해도 살아남아야 하는 값들).
#[tauri::command(rename_all = "snake_case")]
pub fn sync_status(state: State<AppState>, sync_state: State<SyncState>) -> Result<SyncStatus, AppError> {
    let (enabled, port, token) = read_settings(&state)?;
    Ok(build_status(enabled, port, token, &sync_state))
}

/// 토글 on/off — on: 토큰이 비어 있으면(첫 활성화) 새로 생성해 영속하고 서버를 그 포트로 기동.
/// off: 저장된 sync_enabled=false 로 남기고 서버를 abort.
#[tauri::command(rename_all = "snake_case")]
pub fn sync_set_enabled(
    app: tauri::AppHandle,
    state: State<AppState>,
    sync_state: State<SyncState>,
    enabled: bool,
) -> Result<SyncStatus, AppError> {
    let (port, token) = {
        let mut conn = state.db.lock();
        let settings = crate::repo::settings::get_all(&conn)?;
        let port = settings.get("sync_port").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_PORT);
        let mut token = settings.get("sync_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut entries: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        entries.insert("sync_enabled".to_string(), serde_json::json!(enabled));
        if enabled && token.is_empty() {
            token = crate::util::new_id();
            entries.insert("sync_token".to_string(), serde_json::json!(token));
        }
        crate::repo::settings::set(&mut conn, &entries)?;
        (port, token)
    };

    sync_server::stop(&sync_state);
    if enabled {
        match sync_server::start(state.data_dir.clone(), port as u16, token.clone(), Some(app.clone())) {
            Ok((addr, handle)) => {
                *sync_state.0.lock() = Some(Running { handle, addr, token: token.clone() });
            }
            Err(e) => {
                // 바인딩 실패(포트 사용중 등)면 방금 저장한 sync_enabled=true 를 되돌린다 — 안 그러면
                // DB는 "켜짐"인데 서버는 안 떠서, sync_status 가 enabled:true/running:false 를
                // 영구히 반환하고(토글은 계속 ON으로 보임) 사용자가 껐다 켜기 전엔 재시도되지 않는다.
                let mut conn = state.db.lock();
                let mut rollback: BTreeMap<String, serde_json::Value> = BTreeMap::new();
                rollback.insert("sync_enabled".to_string(), serde_json::json!(false));
                let _ = crate::repo::settings::set(&mut conn, &rollback);
                return Err(e);
            }
        }
    }
    // 트레이의 "동기화 상태" 항목(있으면) — 방금 start/stop 한 결과를 즉시 반영.
    crate::tray::refresh_sync_status_item(&app);
    Ok(build_status(enabled, port, token, &sync_state))
}

/// 토큰 재발급 — 실행 중이면 새 토큰으로 재기동(가장 단순한 반영 방법: 껐다 켠다).
///
/// 순서가 중요하다(P1 lifecycle 버그 수정): 예전엔 새 토큰을 먼저 DB에 영속한 뒤 재기동을
/// 시도했다 — 바인딩이 실패하면(포트 사용중 등) `?`로 즉시 리턴되어, enabled=true/running=false
/// 인데 DB의 sync_token은 이미 아무도 모르는 새 값으로 바뀐 채 남았다(재시도 경로 없음: 다음
/// "토글 켜기"가 그 낯선 토큰으로 붙으려 해도 URL/QR을 다시 만들 방법이 없다). 이제는 재기동이
/// 실제로 성공한 뒤에야(또는 애초에 꺼져 있어 재기동이 필요 없을 때만) 새 토큰을 영속한다 —
/// 실패하면 DB의 토큰은 이전 값 그대로다. 이건 §5.4의 "즉시 무효화" 요구와 충돌하지 않는다:
/// sync_server::stop() 이 재기동 시도 전에 무조건 먼저 옛 서버를 죽이므로, 바인딩이 실패해도
/// 옛 토큰으로 접근 가능한 서버는 이미 없다(어느 토큰도 그 순간엔 아무 서버에도 안 통한다).
#[tauri::command(rename_all = "snake_case")]
pub fn sync_regenerate_token(
    app: tauri::AppHandle,
    state: State<AppState>,
    sync_state: State<SyncState>,
) -> Result<SyncStatus, AppError> {
    let new_token = crate::util::new_id();
    let (enabled, port) = {
        let conn = state.db.lock();
        let settings = crate::repo::settings::get_all(&conn)?;
        let enabled = settings.get("sync_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let port = settings.get("sync_port").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_PORT);
        (enabled, port)
    };

    sync_server::stop(&sync_state);
    if enabled {
        let (addr, handle) = sync_server::start(state.data_dir.clone(), port as u16, new_token.clone(), Some(app.clone()))?;
        *sync_state.0.lock() = Some(Running { handle, addr, token: new_token.clone() });
    }
    // 재기동이 필요 없었거나(enabled=false) 성공했을 때만 도달 — 이제서야 커밋.
    {
        let mut conn = state.db.lock();
        let mut entries: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        entries.insert("sync_token".to_string(), serde_json::json!(new_token));
        crate::repo::settings::set(&mut conn, &entries)?;
    }
    crate::tray::refresh_sync_status_item(&app);
    Ok(build_status(enabled, port, new_token, &sync_state))
}

#[cfg(test)]
mod build_status_tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    /// P1 lifecycle (item 9): a panicked/aborted axum task must not be reported as "running"
    /// forever. Spawns a task that finishes immediately (no `.await` on the handle needed —
    /// tokio runs it to completion on its own once spawned) and drives it to completion before
    /// asserting, so `is_finished()` is deterministic rather than racing the scheduler.
    #[tokio::test]
    async fn a_finished_handle_is_reported_as_not_running() {
        let handle = tauri::async_runtime::spawn(async {});
        while !handle.inner().is_finished() {
            tokio::task::yield_now().await;
        }
        let sync_state = SyncState::default();
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 7332);
        *sync_state.0.lock() = Some(Running { handle, addr, token: "tok".to_string() });

        let status = build_status(true, 7332, "tok".to_string(), &sync_state);
        assert!(!status.running, "a dead server task must not be reported as running");
        assert!(status.bound_addr.is_none(), "not-running status must not carry a bound address either");
        assert!(!status.bind_stale, "not-running status has no bind to be stale about");
    }

    /// P1 lifecycle (item 10): loopback is the permanent fallback bind target, never "stale"
    /// even though it's never returned by local_ipv4_addrs() as a Tailscale-style interface.
    #[test]
    fn loopback_bind_is_never_stale() {
        assert!(!is_bind_stale(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    /// A CGNAT-shaped address that (barring a wild coincidence) will never actually be among
    /// this test machine's real interfaces is the "interface disappeared" case build_status must
    /// surface via bind_stale — additive field, does not auto-rebind (task requirement).
    #[test]
    fn a_cgnat_ip_not_among_current_interfaces_is_stale() {
        assert!(is_bind_stale(IpAddr::V4(Ipv4Addr::new(100, 99, 88, 77))));
    }
}

#[derive(Serialize)]
pub struct AgentSkillInstall {
    pub skill_path: String,
    pub cli_path: String,
    pub mcp_command: String,
}

const AGENT_SKILL_MD: &str = include_str!("agent_skill.md");

/// 번들된 cli/brise.mjs 의 절대경로. 윈도우의 `\?\` 확장 접두는 node·사용자 모두 불편하니 뗀다.
fn bundled_cli_path(app: &tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let p = app
        .path()
        .resolve("cli/brise.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Io(e.to_string()))?;
    if !p.exists() {
        return Err(AppError::Io(format!("cli/brise.mjs not found: {}", p.display())));
    }
    Ok(p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

fn mcp_register_command(cli_path: &str, data_dir: &str) -> String {
    format!("claude mcp add --scope user --transport stdio --env BRISE_DATA_DIR=\"{data_dir}\" brise -- node \"{cli_path}\" mcp")
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_skill_install(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<AgentSkillInstall, AppError> {
    use tauri::Manager;
    let cli_path = bundled_cli_path(&app)?;
    let data_dir = state.data_dir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let mcp_command = mcp_register_command(&cli_path, &data_dir);
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join(".claude")
        .join("skills")
        .join("brise");
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Io(e.to_string()))?;
    let file = dir.join("SKILL.md");
    let body = AGENT_SKILL_MD.replace("{{MCP_COMMAND}}", &mcp_command);
    std::fs::write(&file, body).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(AgentSkillInstall { skill_path: file.to_string_lossy().to_string(), cli_path, mcp_command })
}

#[cfg(test)]
mod agent_skill_tests {
    use super::*;

    #[test]
    fn register_command_embeds_cli_and_data_dir() {
        let c = mcp_register_command(r"C:\app\cli\brise.mjs", r"C:\data");
        assert!(c.contains(r#"BRISE_DATA_DIR="C:\data""#));
        assert!(c.ends_with(r#"node "C:\app\cli\brise.mjs" mcp"#));
    }

    #[test]
    fn skill_template_has_frontmatter_and_placeholder() {
        assert!(AGENT_SKILL_MD.starts_with("---
name: brise
"));
        assert!(AGENT_SKILL_MD.contains("{{MCP_COMMAND}}"));
    }
}
