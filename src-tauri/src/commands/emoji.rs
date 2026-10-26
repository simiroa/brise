use super::AppState;
use crate::error::AppError;
use crate::repo::emoji::{
    self, EmojiDownloadResult, EmojiStyleStatus,
};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct EmojiBaseDir {
    pub base: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn emoji_base_dir(state: State<AppState>) -> Result<EmojiBaseDir, AppError> {
    let dir = crate::db::emoji_dir(&state.data_dir);
    Ok(EmojiBaseDir {
        base: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn emoji_style_status(state: State<AppState>) -> Result<EmojiStyleStatus, AppError> {
    Ok(emoji::emoji_style_status(&state.data_dir, &state.emoji_state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn emoji_download(
    state: State<AppState>,
    style: String,
) -> Result<EmojiDownloadResult, AppError> {
    let data_dir = state.data_dir.clone();
    let emoji_state = state.emoji_state.clone();
    emoji::start_emoji_download(data_dir, style, emoji_state, move |fut| {
        tauri::async_runtime::spawn(fut);
    })
}
