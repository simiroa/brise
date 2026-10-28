use super::AppState;
use crate::error::AppError;
use crate::repo::fonts::{self, FontDownloadResult, FontStatus};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct FontsBaseDir {
    pub base: String,
}

// sync-ok: 경로 문자열 하나를 만든다(디스크·네트워크 없음).
#[tauri::command(rename_all = "snake_case")]
pub fn fonts_base_dir(state: State<AppState>) -> Result<FontsBaseDir, AppError> {
    Ok(FontsBaseDir {
        base: fonts::fonts_dir(&state.data_dir).to_string_lossy().to_string(),
    })
}

// sync-ok: 카탈로그 글꼴 수(~60)만큼 .complete 존재 확인뿐.
#[tauri::command(rename_all = "snake_case")]
pub fn font_status(state: State<AppState>) -> Result<FontStatus, AppError> {
    Ok(fonts::font_status(&state.data_dir, &state.font_state))
}

// sync-ok: 검증 후 백그라운드 태스크를 띄우고 바로 돌아온다(받기는 async 런타임에서).
#[tauri::command(rename_all = "snake_case")]
pub fn font_download(state: State<AppState>, id: String) -> Result<FontDownloadResult, AppError> {
    fonts::start_font_download(state.data_dir.clone(), id, state.font_state.clone(), |fut| {
        tauri::async_runtime::spawn(fut);
    })
}
