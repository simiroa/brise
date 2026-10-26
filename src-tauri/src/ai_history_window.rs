//! AI 히스토리 창(#/ai-history). 생성·포커스·왜 OS 창인지는 `aux_window.rs` 참고.

use crate::aux_window::{ensure_owned_window, AuxWindowSpec};
use tauri::{AppHandle, Runtime};

pub const AI_HISTORY_LABEL: &str = "ai-history";

/// 이미 있으면 앞으로 가져온다(idempotent).
pub fn ensure_ai_history_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    ensure_owned_window(
        app,
        &AuxWindowSpec {
            label: AI_HISTORY_LABEL,
            title: "Brise — AI History",
            url: "index.html#/ai-history",
            width: 560.0,
            height: 640.0,
            min_width: 400.0,
            min_height: 360.0,
        },
    )
}
