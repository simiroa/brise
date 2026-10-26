// 커맨드: data_location — 저장 위치 조회/점검/이동 (specs/commands/data_location.yaml).
// 전부 http:false — 서버 머신의 파일시스템에 부수효과가 있거나 로컬 경로 인자를 받는다
// (_conventions.yaml 규칙).
use super::AppState;
use crate::db;
use crate::error::AppError;
use crate::repo::data_location as loc;
use serde::Serialize;
use std::path::Path;
use tauri::{Manager, State};

#[derive(Serialize)]
pub struct DataLocationGetOutput {
    pub root: String,
    pub attachments_dir: String,
    pub backups_dir: String,
    pub is_default: bool,
    pub split: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn data_location_get(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<DataLocationGetOutput, AppError> {
    let default_dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let pointer = loc::read_pointer(&default_dir);
    Ok(DataLocationGetOutput {
        root: state.data_dir.to_string_lossy().to_string(),
        attachments_dir: db::attachments_dir(&state.data_dir).to_string_lossy().to_string(),
        backups_dir: db::backups_dir(&state.data_dir).to_string_lossy().to_string(),
        is_default: pointer.root.is_none() && pointer.attachments.is_none() && pointer.backups.is_none(),
        split: pointer.attachments.is_some(),
    })
}

#[derive(Serialize)]
pub struct DataLocationInspectOutput {
    pub path: String,
    pub cloud_provider: Option<String>,
    pub writable: bool,
    pub has_existing_data: bool,
    pub free_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    pub current_data_bytes: i64,
}

// async + spawn_blocking: loc::inspect() 의 current_data_bytes 는 attachments/+backups/ 를
// walk 해 합산한다 — db_stats(commands/settings.rs)의 dir_sizes 와 같은 이유로 동기 커맨드에서
// 돌리면 그 시간만큼 다른 모든 IPC 를 막는다(attachments.rs:174-178 실측 교훈). 후보 폴더를
// 고르는 동안 반복 호출될 수 있어(온보딩/설정 폴더 선택 UI) db_reset/backup_restore 급 "드문
// 단발성 동작"과는 다르다 — db_stats 와 같은 급으로 취급한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn data_location_inspect(
    state: State<'_, AppState>,
    path: String,
) -> Result<DataLocationInspectOutput, AppError> {
    let current_data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let insp = loc::inspect(Path::new(&path), &current_data_dir);
        DataLocationInspectOutput {
            path,
            cloud_provider: insp.cloud_provider,
            writable: insp.writable,
            has_existing_data: insp.has_existing_data,
            free_bytes: insp.free_bytes,
            total_bytes: insp.total_bytes,
            current_data_bytes: insp.current_data_bytes,
        }
    })
    .await
    .map_err(|e| AppError::Io(format!("data_location_inspect worker failed: {e}")))
}

#[derive(Serialize)]
pub struct DataLocationApplyOutput {
    pub split: bool,
    pub restart_required: bool,
}

// REVIEW #3 — 성공(스냅샷+integrity_check+포인터 원자적 기록)과 재시작 사이에 DB 락을 놓으면
// 그 사이의 쓰기가 스냅샷 뒤에 벌어져 재시작 후 사라진다(라이브 에디터가 계속 떠 있는 채로
// 프런트가 onboardingCompleted 를 먼저 지우고 relaunch 를 기다리는 구조라 이 창이 실제로 열려
// 있다). state.db 락을 쥔 이 스코프 안에서 app.restart() 를 부른다 — 그 함수는 `-> !`(never
// returns, 프로세스가 그대로 재시작된다) 이므로 락이 풀릴 일이 없다. repo::apply() 자체는
// 순수하게 두고(테스트가 재시작 없이 결과만 본다) 재시작은 커맨드 레이어에만 둔다.
//
// ⚠️ 이 커맨드는 **동기(`pub fn`)로 남아야 한다**(재검토 2026-09-29). 동기 커맨드는 메인 스레드에서
// 인라인으로 돌고, 메인 스레드의 `restart()` 는 Exit 이벤트를 건너뛰고 곧장 프로세스를 바꾼다. `async`/
// spawn_blocking 으로 옮기면 restart() 가 "다른 스레드" 경로를 타 Exit 이벤트를 기다리며 영원히
// 잠드는데, 메인 스레드의 Exit 핸들러(lib.rs)는 이 스코프가 쥔 state.db 락을 잡으려다 교착한다 —
// 앱이 통째로 얼어붙는다. 복사 중 UI 가 멈추는 건 프런트의 "옮기는 중" 가림막(lib/dataMove.ts)이
// 가린다. 같은 이유로 Exit 핸들러의 clean-shutdown 표시가 남지 않아 다음 부팅이 quick_check 를
// 한 번 돈다 — 방금 옮긴 DB 를 한 번 더 검사하는 셈이라 의도적으로 둔다.
#[tauri::command(rename_all = "snake_case")]
pub fn data_location_apply(app: tauri::AppHandle, state: State<AppState>, path: String) -> Result<DataLocationApplyOutput, AppError> {
    let default_dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let conn = state.db.lock();
    let layout = loc::Layout {
        data_dir: state.data_dir.clone(),
        attachments_dir: db::attachments_dir(&state.data_dir),
        backups_dir: db::backups_dir(&state.data_dir),
    };
    loc::apply(&conn, &default_dir, &layout, Path::new(&path))?;
    // 성공: 포인터가 이미 기록됐다 — conn 락을 쥔 채로 곧장 재시작한다(never returns).
    app.restart();
}
