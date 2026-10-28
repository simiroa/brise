// 커맨드: export / import / reset (commands/export.yaml)
use super::{AppState, Okay};
use crate::error::AppError;
use crate::repo::doc_export;
use crate::repo::transfer::{
    self, BackupResult, ExportAllResult, ExportResult, ImportResult, ResetResult, RestoreResult,
};
use serde::Serialize;
use std::path::Path;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

/// 노트 전체 → Markdown 파일. `dest_path` 는 저장 대화상자가 고른 **.md 파일 경로**(W6 — 형식 인자는 없어졌다, Markdown 만).
///
/// async + spawn_blocking 인 이유(L-2): 첨부를 `std::fs::copy` 하는 동안 메인 스레드와 `state.db` 를 쥐고 있었다. 이제 DB 잠금은
/// 노트 상세를 읽을 때와 `exported_at` 을 찍을 때만 잡는다(repo::transfer::export::export_note_shared).
#[tauri::command(rename_all = "snake_case")]
pub async fn export_note(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    id: String,
    dest_path: String,
) -> Result<ExportResult, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    let note_id = id.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        transfer::export::export_note_shared(&db, &data_dir, &note_id, Path::new(&dest_path))
    })
    .await
    .map_err(|e| AppError::Io(format!("export worker failed: {e}")))??;
    // exported_at 을 찍는다 = 노트 행 변경. async 커맨드 — 창 라벨을 직접 싣는다(events::publish_as).
    crate::events::publish_as(Some(webview.label()), Some(&id), false);
    Ok(out)
}

/// 관계도 PNG → 저장 다이얼로그가 고른 경로. State 를 받지 않는 유일한 export 커맨드다 — DB 도
/// data_dir 도 건드리지 않고 프론트가 만든 래스터를 그대로 쓴다(repo::transfer::export 참고).
/// 첨부로 저장(attachment_add_bytes)은 같은 래스터의 두 번째 목적지로 그대로 남아 있다.
#[tauri::command(rename_all = "snake_case")]
pub fn export_diagram_png(
    dest_path: String,
    data_base64: String,
) -> Result<transfer::ExportPngResult, AppError> {
    transfer::export_diagram_png(Path::new(&dest_path), &data_base64)
}

/// 시트 CSV → 저장 다이얼로그가 고른 경로. State 를 받지 않는 export 커맨드다 —
/// 프론트가 생성한 CSV 문자열을 UTF-8 BOM과 함께 지정 경로에 쓴다.
#[tauri::command(rename_all = "snake_case")]
pub fn export_sheet_csv(
    dest_path: String,
    csv: String,
) -> Result<transfer::ExportCsvResult, AppError> {
    transfer::export_sheet_csv(Path::new(&dest_path), &csv)
}

/// 텍스트 섹션 하나 → .md 파일 (specs/commands/export.yaml export_section_md). DB 를 읽는다는
/// 점에서 export_note 와 같은 부류라 State 를 받는다 — export_diagram_png/export_sheet_csv 와
/// 반대(그 둘은 프론트가 만든 바이트를 그대로 쓴다).
#[tauri::command(rename_all = "snake_case")]
pub fn export_section_md(
    state: State<AppState>,
    id: String,
    dest_path: String,
) -> Result<transfer::ExportSectionMdResult, AppError> {
    let conn = state.db.lock();
    transfer::export_section_md(&conn, &id, Path::new(&dest_path))
}

/// 내보내기·인쇄 모달 "HWPX" / "DOCX" 의 공용 본체 — 형식만 다르다. 프런트가 섹션마다 헤드리스 TipTap 으로 연 ProseMirror JSON 을
/// 보내면 Rust 가 파일로 쓴다(repo/doc_export/). 그림은 첨부 루트(`attachments/`) 안에서만 읽는다(다른 노트 폴더 그림 포함 — 섹션을 옮긴 노트).
///
/// async + spawn_blocking 인 이유: 그림 읽기·zip 압축·파일 쓰기가 오래 걸릴 수 있고, 동기 커맨드는 Tauri 가 직렬로 돌려서 다른 IPC
/// 전부가 기다린다(doc_import_html 과 같다). `exported_at` 은 건드리지 않으므로 이벤트도 내지 않는다(repo 주석 참고).
#[allow(clippy::too_many_arguments)]
async fn export_doc(
    state: State<'_, AppState>,
    format: doc_export::DocFormat,
    note_id: String,
    dest_path: String,
    title: String,
    sections: Vec<doc_export::DocExportSection>,
    paper: String,
    margin: String,
) -> Result<doc_export::ExportDocResult, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        doc_export::export(&db, &data_dir, &note_id, &dest_path, &title, &sections, &paper, &margin, format)
    })
    .await
    .map_err(|e| AppError::Io(format!("{} export worker failed: {e}", format.ext())))?
}

/// specs/commands/export.yaml export_hwpx (PLAN-2026-10-07 W3).
#[tauri::command(rename_all = "snake_case")]
pub async fn export_hwpx(
    state: State<'_, AppState>,
    note_id: String,
    dest_path: String,
    title: String,
    sections: Vec<doc_export::DocExportSection>,
    paper: String,
    margin: String,
) -> Result<doc_export::ExportDocResult, AppError> {
    export_doc(state, doc_export::DocFormat::Hwpx, note_id, dest_path, title, sections, paper, margin).await
}

/// specs/commands/export.yaml export_docx (PLAN-2026-10-07 W4). export_hwpx 와 입력·출력이 같고 형식만 OOXML 이다.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_docx(
    state: State<'_, AppState>,
    note_id: String,
    dest_path: String,
    title: String,
    sections: Vec<doc_export::DocExportSection>,
    paper: String,
    margin: String,
) -> Result<doc_export::ExportDocResult, AppError> {
    export_doc(state, doc_export::DocFormat::Docx, note_id, dest_path, title, sections, paper, margin).await
}

/// specs/commands/export.yaml export_html (PLAN-2026-10-07 W6) — 프런트가 만든 완성 HTML 의 `<img data-rel-path>` 를 첨부 루트
/// 안에서만 읽어 data: URI 로 채우고 파일 하나로 쓴다(repo/doc_export/html.rs). export_hwpx 와 같은 이유로 async + spawn_blocking
/// (그림 읽기·base64·쓰기가 오래 걸릴 수 있다), `exported_at` 은 건드리지 않으므로 이벤트도 내지 않는다.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_html(
    state: State<'_, AppState>,
    note_id: String,
    dest_path: String,
    html: String,
) -> Result<doc_export::ExportDocResult, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || doc_export::html::export_html(&db, &data_dir, &note_id, &dest_path, &html))
        .await
        .map_err(|e| AppError::Io(format!("html export worker failed: {e}")))?
}

/// specs/commands/export.yaml export_html_inline (W6 "서식 복사") — export_html 과 같은 그림 채우기, 파일 대신 문자열을 돌려준다
/// (프런트가 클립보드에 text/html 로 넣는다).
#[tauri::command(rename_all = "snake_case")]
pub async fn export_html_inline(
    state: State<'_, AppState>,
    note_id: String,
    html: String,
) -> Result<doc_export::html::InlinedHtml, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || doc_export::html::export_html_inline(&db, &data_dir, &note_id, &html))
        .await
        .map_err(|e| AppError::Io(format!("html inline worker failed: {e}")))?
}

/// specs/commands/export.yaml export_open 의 출력 `{}`.
#[derive(Serialize)]
pub struct ExportOpenOutput {}

/// 내보낸 파일을 기본 앱으로 열거나(reveal=false) 탐색기에서 선택해 보여 준다(reveal=true). 프런트 opener 권한은 `$RESOURCE`
/// 뿐이라 프런트에서 openPath 를 부르면 조용히 거부된다(CLAUDE.md 함정 7) — 그래서 Rust 가 연다(attachment_open 과 같은 opener 경로).
/// 아무 경로나 여는 명령이 되지 않게 확장자·일반 파일 검사를 먼저 통과해야 한다(`openable_export_path`).
///
/// async + spawn_blocking 인 이유: 검사의 `symlink_metadata` 가 도달 불가 UNC 경로(서버 공유 폴더)에서 ~21초 블로킹한다.
/// 동기 커맨드는 메인 스레드에서 돌아 그동안 창 전체가 멈췄다(W3 검증에서 실측). opener 는 호출 스레드에서 스스로 COM 을 초기화한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_open(app: tauri::AppHandle, path: String, reveal: bool) -> Result<ExportOpenOutput, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = doc_export::openable_export_path(&path)?.to_string_lossy().to_string();
        let opened = if reveal {
            app.opener().reveal_item_in_dir(target)
        } else {
            app.opener().open_path(target, None::<&str>)
        };
        opened.map_err(|e| AppError::Io(e.to_string()))?;
        Ok(ExportOpenOutput {})
    })
    .await
    .map_err(|e| AppError::Io(format!("export open worker failed: {e}")))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn export_all(state: State<AppState>, dest_dir: String) -> Result<ExportAllResult, AppError> {
    let conn = state.db.lock();
    transfer::export_all(&conn, &state.data_dir, Path::new(&dest_dir))
}

#[tauri::command(rename_all = "snake_case")]
pub fn import_bundle(
    state: State<AppState>,
    bundle_path: String,
    mode: String,
    target_workspace_id: Option<String>,
    update_existing: Option<bool>,
) -> Result<ImportResult, AppError> {
    let mut conn = state.db.lock();
    let out = transfer::import_bundle(
        &mut conn,
        &state.data_dir,
        Path::new(&bundle_path),
        &mode,
        target_workspace_id.as_deref(),
        update_existing.unwrap_or(false),
    )?;
    // QA8 Wave 4A — one bulk activity event for the import (import path inserts notes via raw
    // SQL, not notes::create, so it does not fan out per-note create rows).
    if out.imported_notes > 0 {
        let ws = target_workspace_id
            .clone()
            .or_else(|| crate::repo::folders::active_workspace_id(&conn).ok());
        if let Some(ws) = ws {
            let summary = format!("Imported {} notes", out.imported_notes);
            let payload = serde_json::json!({ "imported_notes": out.imported_notes, "mode": mode }).to_string();
            let _ = crate::repo::activity::record(
                &mut conn,
                &ws,
                None,
                crate::repo::activity::KIND_IMPORT,
                &summary,
                Some(&payload),
            );
        }
    }
    // 일괄 경로 — 노트마다 하나씩이 아니라 끝에 coarse 이벤트 하나만(이벤트 폭풍 금지).
    crate::events::publish(None, false);
    if mode == "replace" {
        publish_data_replaced();
    }
    Ok(out)
}

/// Notebook-scoped bundle export (workspace_id = 노트북). Self-sufficient for restore
/// (includes workspace_regions/eras/statuses). Re-import via import_bundle mode=add_notebook
/// or hash_merge.
#[tauri::command(rename_all = "snake_case")]
pub fn export_workspace_bundle(
    state: State<AppState>,
    id: String,
    dest_dir: String,
) -> Result<ExportAllResult, AppError> {
    let conn = state.db.lock();
    transfer::export_workspace_bundle(&conn, &state.data_dir, &id, Path::new(&dest_dir))
}

/// 데이터 전체가 갈아끼워졌다(초기화·백업 복원·대체 가져오기) — 데스크톱의 오래 사는 창(본 창·브리핑·활동)은
/// 이걸 받고 통째로 다시 불러온다. 노트북·폴더·설정·열린 탭까지 전부 무효라 coarse 재조회로는 모자란다
/// (본 창이 지워진 폴더·노트를 계속 보여 줬다). 설정 창은 스냅샷 안내 뒤 스스로 다시 불러온다.
/// SSE 로도 나가지만 폰(httpBridge SSE_EVENTS)은 모르는 이름이라 무시하고, 같이 나가는 coarse publish 로 따라온다.
fn publish_data_replaced() {
    crate::events::publish_event("data-replaced", serde_json::json!({}));
}

/// async 인 이유(backup_restore 와 같다, L-9): 전체 DB 스냅샷 + 빈 DB 마이그레이션 + 스왑 + 재마이그레이션이 초 단위라
/// 동기 커맨드(Tauri 는 메인 스레드에서 돌린다)면 그동안 창 전체가 멈췄다. `block_in_place` 로 이 워커 스레드에서 본체를 그대로
/// 돌린다 — 잠금 순서(db → read)와 `with_db_file_swap` 은 그대로다.
#[tauri::command(rename_all = "snake_case")]
pub async fn db_reset(state: State<'_, AppState>, confirm: String) -> Result<ResetResult, AppError> {
    let out = tokio::task::block_in_place(|| {
        let mut conn = state.db.lock();
        // 초기화도 복원처럼 DB 파일을 통째로 바꾼다 — 채팅 검색의 읽기 연결을 닫았다가 다시 연다(잠금 순서 db → read).
        state.with_db_file_swap(|| transfer::db_reset(&mut conn, &state.data_dir, &confirm))
    })?;
    crate::events::publish(None, false);
    publish_data_replaced();
    Ok(out)
}

#[tauri::command(rename_all = "snake_case")]
pub fn backup_create(state: State<AppState>, dest_path: String) -> Result<BackupResult, AppError> {
    let conn = state.db.lock();
    transfer::backup_create(&conn, &state.data_dir, Path::new(&dest_path))
}

/// async 인 이유(L-9): 압축 해제·검사·마이그레이션이 초~분 단위라 메인 스레드에서 돌면 창 전체가 멈췄다.
/// `read_db` 가 Arc 가 아니라 `spawn_blocking`('static)에 못 넣으므로 `block_in_place` 로 이 워커 스레드에서 본체를 그대로 돌린다
/// (다른 async 작업은 다른 워커로 옮겨진다). 잠금 순서(db → read)와 `with_db_file_swap` 은 그대로다.
#[tauri::command(rename_all = "snake_case")]
pub async fn backup_restore(
    state: State<'_, AppState>,
    zip_path: String,
    confirm: String,
) -> Result<RestoreResult, AppError> {
    let out = tokio::task::block_in_place(|| {
        let mut conn = state.db.lock();
        // DB 파일을 통째로 바꾼다 — 채팅 검색의 읽기 연결을 닫았다가 다시 연다(잠금 순서 db → read).
        state.with_db_file_swap(|| {
            transfer::backup_restore(&mut conn, &state.data_dir, Path::new(&zip_path), &confirm)
        })
    })?;
    crate::events::publish(None, false); // DB 통째 교체 — 클라이언트는 전부 다시 읽어야 한다.
    publish_data_replaced();
    Ok(out)
}

/// 설정 "데이터 폴더 열기" — data_dir 를 OS 파일 탐색기로. attachment_reveal(attachments.rs)과
/// 동일한 opener 패턴, 대상이 파일이 아니라 data_dir 자체라는 점만 다르다(open_path 는 디렉토리도
/// 그대로 탐색기로 연다 — reveal_item_in_dir 은 "이 파일을 담은 폴더를 열고 선택"이라 파일 전용).
#[tauri::command(rename_all = "snake_case")]
pub fn data_dir_open(app: tauri::AppHandle, state: State<AppState>) -> Result<Okay, AppError> {
    app.opener()
        .open_path(state.data_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(Okay { ok: true })
}

#[derive(Serialize)]
pub struct BackupAutoStatus {
    pub last_backup_at: Option<String>,
    pub interval: String,
    pub keep: i64,
    /// 리스크 감사 A: 마지막 자동 백업 시도가 실패했으면 "타임스탬프: 메시지", 없으면 None.
    pub last_error: Option<String>,
}

/// 설정 "자동 백업" 카드 상태 — 현재 스케줄 설정 + 마지막 auto 백업 시각.
#[tauri::command(rename_all = "snake_case")]
pub fn backup_auto_status(state: State<AppState>) -> Result<BackupAutoStatus, AppError> {
    let (interval, keep, last_error) = {
        let conn = state.db.lock();
        let settings = crate::repo::settings::get_all(&conn)?;
        let interval = settings
            .get("backup_auto_interval")
            .and_then(|v| v.as_str())
            .unwrap_or("weekly")
            .to_string();
        let keep = settings.get("backup_auto_keep").and_then(|v| v.as_i64()).unwrap_or(3);
        let last_error = settings
            .get("backup_auto_last_error")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        (interval, keep, last_error)
    };
    let last_backup_at = transfer::backup::auto_backup_last(&state.data_dir);
    Ok(BackupAutoStatus { last_backup_at, interval, keep, last_error })
}

/// 설정 "저장 및 백업" 카드의 복구 목록 — 자동 백업 zip 을 최신순 `limit`개(UI 가 보관 개수를 넘긴다).
#[tauri::command(rename_all = "snake_case")]
pub async fn backup_auto_list(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<transfer::backup::AutoBackupEntry>, AppError> {
    // 폴더 나열 + 파일마다 stat — 동기 커맨드로 두면 IPC 직렬 큐를 막는다(backup_auto_run 과 같은 이유).
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        transfer::backup::auto_backup_list(&data_dir, limit.clamp(1, 20) as usize)
    })
    .await
    .map_err(|e| AppError::Io(format!("backup list worker failed: {e}")))
}

/// 설정 "지금 백업" 버튼 — 스케줄과 무관하게 즉시 전체 zip 백업 + 회전(keep 개수는 현재 설정값).
/// async + spawn_blocking 인 이유: attachment_add_file(attachments.rs:15-44)과 동일 — Tauri는
/// 동기 커맨드를 직렬로 돌리므로, DB 락을 놓아도 전체 zip 쓰기(초~분 단위)가 sync fn 안에서
/// 일어나면 그동안 다른 모든 IPC 호출이 막힌다(attachments.rs 주석의 실측: 락을 전혀 안 건드리는
/// 커맨드조차 2ms→1,837ms).
#[tauri::command(rename_all = "snake_case")]
pub async fn backup_auto_run(state: State<'_, AppState>) -> Result<BackupResult, AppError> {
    let keep = {
        let conn = state.db.lock();
        let settings = crate::repo::settings::get_all(&conn)?;
        settings
            .get("backup_auto_keep")
            .and_then(|v| v.as_i64())
            .unwrap_or(3)
            .max(1) as usize
    };
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || transfer::backup::auto_backup_run(&data_dir, keep))
        .await
        .map_err(|e| AppError::Io(format!("backup worker failed: {e}")))?
}

/// 폴더 단위 Markdown 내보내기 — `dest_path` 는 폴더 대화상자가 고른 폴더, 그 아래 `{폴더 슬러그}/` 에 노트마다 `.md`
/// (W6 — 형식 인자는 없어졌다: 폴더 단위 HTML 은 쓸 일이 없다는 오너 결정 2026-10-08).
/// export_note 와 같은 이유(L-2)로 async + spawn_blocking, DB 잠금은 노트마다 짧게만.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_folder(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
) -> Result<transfer::ExportFolderResult, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        transfer::export::export_folder_shared(&db, &data_dir, &id, Path::new(&dest_path))
    })
    .await
    .map_err(|e| AppError::Io(format!("folder export worker failed: {e}")))?
}

/// Folder-scoped bundle export (distinct from export_folder above, which writes per-note
/// Markdown files) — produces the same brise-bundle.json + attachments/ shape as export_all but
/// filtered to one folder, so it can be handed to someone else and re-imported via import_bundle.
#[tauri::command(rename_all = "snake_case")]
pub fn export_folder_bundle(
    state: State<AppState>,
    id: String,
    dest_dir: String,
) -> Result<ExportAllResult, AppError> {
    let conn = state.db.lock();
    transfer::export_folder_bundle(&conn, &state.data_dir, &id, Path::new(&dest_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    fn seeded_note_id(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let state = app.state::<AppState>();
        let mut conn = state.db.lock();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap().note.id
    }

    fn sample_sections() -> Vec<doc_export::DocExportSection> {
        serde_json::from_value(serde_json::json!([
            { "name": "섹션", "doc": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "안녕" }] }] } }
        ]))
        .unwrap()
    }

    /// IPC 가 보내는 모양 그대로(`sections` 는 `{ name, doc }` 배열) 역직렬화되고, 응답 키가 스펙(ExportHwpxOutput)과 같다.
    #[test]
    fn export_hwpx_command_wires_state_validation_and_response_shape() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let out_dir = tempfile::tempdir().unwrap();
        let dest = out_dir.path().join("out.hwpx");
        let sections = sample_sections();
        let call = |note: &str, secs: Vec<doc_export::DocExportSection>, paper: &str| {
            tauri::async_runtime::block_on(export_hwpx(
                app.state::<AppState>(),
                note.to_string(),
                dest.to_string_lossy().into_owned(),
                "제목".to_string(),
                secs,
                paper.to_string(),
                "normal".to_string(),
            ))
        };
        assert!(matches!(call("no-such-note", sections.clone(), "a4-portrait"), Err(AppError::NotFound(_))));
        assert!(matches!(call(&note_id, vec![], "a4-portrait"), Err(AppError::Validation(_))));
        assert!(matches!(call(&note_id, sections.clone(), "a3"), Err(AppError::Validation(_))));
        assert!(!dest.exists());

        let out = call(&note_id, sections, "a4-landscape").unwrap();
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({ "written_path": dest.to_string_lossy(), "image_count": 0, "skipped_images": 0 })
        );
        let zip = std::fs::read(&dest).unwrap();
        assert_eq!(&zip[30..38], b"mimetype");
        // 응답 `{}` 모양(ExportOpenOutput).
        assert_eq!(serde_json::to_value(ExportOpenOutput {}).unwrap(), serde_json::json!({}));
    }

    /// export_html: 확장자·노트 검증, 응답 키가 스펙(ExportHtmlOutput)과 같고, 그림이 data: URI 로 채워진 파일이 생긴다.
    #[test]
    fn export_html_command_wires_state_validation_and_response_shape() {
        let (data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let src = data_dir.path().join("pic.png");
        let png = {
            let mut buf = std::io::Cursor::new(Vec::new());
            image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3])).write_to(&mut buf, image::ImageFormat::Png).unwrap();
            buf.into_inner()
        };
        std::fs::write(&src, &png).unwrap();
        let rel = {
            let state = app.state::<AppState>();
            let mut conn = state.db.lock();
            crate::repo::attachments::add_file(&mut conn, data_dir.path(), &note_id, &src.to_string_lossy()).unwrap().rel_path.unwrap()
        };
        let html = format!(r#"<p><img data-rel-path="{rel}" src=""></p>"#);
        let out_dir = tempfile::tempdir().unwrap();
        let call = |note: &str, dest: &std::path::Path| {
            tauri::async_runtime::block_on(export_html(
                app.state::<AppState>(),
                note.to_string(),
                dest.to_string_lossy().into_owned(),
                html.clone(),
            ))
        };
        let dest = out_dir.path().join("out.html");
        assert!(matches!(call("no-such-note", &dest), Err(AppError::NotFound(_))));
        assert!(matches!(call(&note_id, &out_dir.path().join("out.txt")), Err(AppError::Validation(_))));
        assert!(!dest.exists());
        let out = call(&note_id, &dest).unwrap();
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({ "written_path": dest.to_string_lossy(), "image_count": 1, "skipped_images": 0 })
        );
        assert!(std::fs::read_to_string(&dest).unwrap().starts_with(r#"<p><img src="data:image/png;base64,"#));
    }

    /// export_html_inline: 응답 키가 스펙(ExportHtmlInlineOutput)과 같다 · 없는 노트는 NOT_FOUND.
    #[test]
    fn export_html_inline_command_returns_html_and_counts() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let call = |note: &str, html: &str| {
            tauri::async_runtime::block_on(export_html_inline(app.state::<AppState>(), note.to_string(), html.to_string()))
        };
        assert!(matches!(call("no-such-note", "<p/>"), Err(AppError::NotFound(_))));
        let out = call(&note_id, r#"<b>x</b><img src="asset://localhost/x.png">"#).unwrap();
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({ "html": r#"<b>x</b><img src="">"#, "image_count": 0, "skipped_images": 1 })
        );
    }

    /// export_docx 도 같은 입력·검증·응답 모양 — 파일만 OOXML(`[Content_Types].xml` 이 있는 zip).
    #[test]
    fn export_docx_command_wires_state_validation_and_response_shape() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let out_dir = tempfile::tempdir().unwrap();
        let dest = out_dir.path().join("out.docx");
        let sections = sample_sections();
        let call = |note: &str, secs: Vec<doc_export::DocExportSection>, paper: &str| {
            tauri::async_runtime::block_on(export_docx(
                app.state::<AppState>(),
                note.to_string(),
                dest.to_string_lossy().into_owned(),
                "제목".to_string(),
                secs,
                paper.to_string(),
                "normal".to_string(),
            ))
        };
        assert!(matches!(call("no-such-note", sections.clone(), "a4-portrait"), Err(AppError::NotFound(_))));
        assert!(matches!(call(&note_id, vec![], "a4-portrait"), Err(AppError::Validation(_))));
        assert!(matches!(call(&note_id, sections.clone(), "a3"), Err(AppError::Validation(_))));
        assert!(!dest.exists());

        let out = call(&note_id, sections, "a4-landscape").unwrap();
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({ "written_path": dest.to_string_lossy(), "image_count": 0, "skipped_images": 0 })
        );
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        assert!(zip.by_name("[Content_Types].xml").is_ok() && zip.by_name("word/document.xml").is_ok());
    }

    /// 백업 복원은 DB 파일을 통째로 바꾼다. 채팅 검색의 읽기 연결(37ffdbe0)이 파일·-wal·-shm 을 쥔 채면
    /// Windows 는 지우기를 거부하고(os error 32 — 복원이 늘 실패), 다른 OS 에선 읽기 연결이 지워진 옛 파일을 계속 본다.
    #[test]
    fn backup_restore_with_read_handle_swaps_the_file_and_the_read_conn_sees_the_restored_db() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new_with_read_handle(conn, data_dir.path().to_path_buf()));
        let state = app.state::<AppState>();
        assert!(state.has_read_handle(), "파일 DB 면 읽기 연결이 열린다");
        let add_note = |title: &str| {
            let mut conn = state.db.lock();
            let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
            crate::repo::notes::create(&mut conn, &folder_id, Some(title.to_string()), None).unwrap();
        };
        let titles = || {
            state.with_read(|c| {
                let mut st = c.prepare("SELECT title FROM notes WHERE deleted_at IS NULL").unwrap();
                st.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect::<Vec<_>>()
            })
        };
        add_note("백업 전 노트");
        let zip_path = data_dir.path().join("backup.zip");
        transfer::backup_create(&state.db.lock(), data_dir.path(), &zip_path).unwrap();
        add_note("백업 뒤 노트");
        assert!(titles().contains(&"백업 뒤 노트".to_string()), "읽기 연결로 한 번 읽어 -wal·-shm 까지 열어 둔다");

        tauri::async_runtime::block_on(backup_restore(
            app.state::<AppState>(),
            zip_path.to_string_lossy().into_owned(),
            "RESTORE".to_string(),
        ))
        .expect("읽기 연결이 열려 있어도 복원이 돼야 한다");

        assert!(state.has_read_handle(), "복원 뒤 읽기 연결을 다시 연다");
        let after = titles();
        assert!(after.contains(&"백업 전 노트".to_string()), "{after:?}");
        assert!(!after.contains(&"백업 뒤 노트".to_string()), "읽기 연결이 복원된 DB 를 봐야 한다: {after:?}");
    }

    /// 초기화도 DB 파일 교체다 — 복원과 같은 이유로 읽기 연결이 열린 채여도 돼야 하고, 읽기 연결은 빈 DB 를 봐야 한다.
    #[test]
    fn db_reset_with_read_handle_swaps_the_file_and_the_read_conn_sees_the_empty_db() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new_with_read_handle(conn, data_dir.path().to_path_buf()));
        let state = app.state::<AppState>();
        {
            let mut conn = state.db.lock();
            let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
            crate::repo::notes::create(&mut conn, &folder_id, Some("초기화 전 노트".to_string()), None).unwrap();
        }
        let count = || state.with_read(|c| c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap());
        assert_eq!(count(), 1, "읽기 연결로 한 번 읽어 -wal·-shm 까지 열어 둔다");

        // db_reset 도 backup_restore 처럼 async(block_in_place) 커맨드다 — 같은 방식으로 돌린다.
        tauri::async_runtime::block_on(db_reset(app.state::<AppState>(), "RESET".to_string()))
            .expect("읽기 연결이 열려 있어도 초기화가 돼야 한다");

        assert!(state.has_read_handle(), "초기화 뒤 읽기 연결을 다시 연다");
        assert_eq!(count(), 0, "읽기 연결이 새 빈 DB 를 봐야 한다");
    }
}
