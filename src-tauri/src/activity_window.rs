//! 활동 이력 창(#/activity). 생성·포커스·왜 OS 창인지는 `aux_window.rs` 참고.

use crate::aux_window::{ensure_owned_window, AuxWindowSpec};
use tauri::{AppHandle, Runtime};

pub const ACTIVITY_LABEL: &str = "activity";

/// 이미 있으면 앞으로 가져온다(idempotent).
pub fn ensure_activity_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    ensure_owned_window(
        app,
        &AuxWindowSpec {
            label: ACTIVITY_LABEL,
            title: "Brise — Activity",
            url: "index.html#/activity",
            width: 520.0,
            height: 640.0,
            min_width: 400.0,
            min_height: 360.0,
        },
    )
}
