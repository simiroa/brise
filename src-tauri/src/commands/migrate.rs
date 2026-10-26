// 커맨드: migrate — 다른 앱 → Brise 마이그레이션 (commands/migrate.yaml)
use super::AppState;
use crate::error::AppError;
use crate::repo::transfer::migrate;
use std::path::Path;
use tauri::State;

/// 1번째 마이그레이션 슬라이스: Markdown 폴더 + YAML 프론트매터. `note_ids` 는 "임포트한 N개를
/// AI로 정리" 배치 진입점 — 프론트가 이 배열을 그대로 ai_organize_note에 순회해 돌린다.
#[tauri::command(rename_all = "snake_case")]
pub fn migration_import_markdown(
    state: State<AppState>,
    folder_id: String,
    source_dir: String,
) -> Result<MigrationImportOutput, AppError> {
    let mut conn = state.db.lock();
    let result =
        migrate::markdown::import_markdown_folder(&mut conn, &folder_id, Path::new(&source_dir))?;
    // 일괄 임포트 — 노트당 하나가 아니라 끝에 coarse 하나(이벤트 폭풍 금지).
    crate::events::publish(None, false);
    Ok(MigrationImportOutput {
        imported: result.imported,
        skipped: result.skipped,
        note_ids: result.note_ids,
    })
}

/// 2번째 마이그레이션 슬라이스: Notion "Export as Markdown & CSV" zip. 출력 계약은
/// migration_import_markdown 과 동일.
#[tauri::command(rename_all = "snake_case")]
pub fn migration_import_notion(
    state: State<AppState>,
    folder_id: String,
    zip_path: String,
) -> Result<MigrationImportOutput, AppError> {
    let mut conn = state.db.lock();
    let result = migrate::notion::import_notion_zip(&mut conn, &folder_id, Path::new(&zip_path))?;
    crate::events::publish(None, false);
    Ok(MigrationImportOutput {
        imported: result.imported,
        skipped: result.skipped,
        note_ids: result.note_ids,
    })
}

/// 3번째(마지막) 마이그레이션 슬라이스: Evernote ENEX export. 출력 계약은 앞선 두 슬라이스와 동일.
#[tauri::command(rename_all = "snake_case")]
pub fn migration_import_enex(
    state: State<AppState>,
    folder_id: String,
    enex_path: String,
) -> Result<MigrationImportOutput, AppError> {
    let mut conn = state.db.lock();
    let result = migrate::enex::import_enex_file(&mut conn, &folder_id, Path::new(&enex_path))?;
    crate::events::publish(None, false);
    Ok(MigrationImportOutput {
        imported: result.imported,
        skipped: result.skipped,
        note_ids: result.note_ids,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct MigrationImportOutput {
    pub imported: i64,
    pub skipped: i64,
    pub note_ids: Vec<String>,
}
