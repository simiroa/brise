// 커맨드: slides (commands/slides.yaml)
use super::AppState;
use crate::error::AppError;
use crate::repo::attachments::{self, OpenTarget};
use crate::repo::{settings, slide_render};
use rusqlite::OptionalExtension;
use tauri::State;

#[derive(serde::Serialize)]
pub struct SlidePreview {
    /// 변환된 pdf 의 절대 경로(프런트가 convertFileSrc 로 연다). None 이면 폴백.
    pub pdf_path: Option<String>,
    pub reason: Option<String>,
}

impl SlidePreview {
    fn fallback(reason: &str) -> Self {
        Self { pdf_path: None, reason: Some(reason.to_string()) }
    }
}

/// pptx 첨부를 pdf 로 변환해 경로를 돌려준다. **에러를 던지지 않는다** — 변환기 부재·실패·
/// 타임아웃은 전부 정상 경로이고(토스트가 뜨면 안 된다), 프런트는 reason 을 보고 폴백한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn slide_preview_render(
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<SlidePreview, AppError> {
    let (mode, override_path, name, target) = {
        let conn = state.db.lock();
        let s = settings::get_all(&conn).unwrap_or_default();
        let mode = s.get("slide_preview").and_then(|v| v.as_str()).unwrap_or("auto").to_string();
        let over = s.get("soffice_path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name: Option<String> = conn
            .query_row("SELECT name FROM attachments WHERE id=?1", [&attachment_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        // 경로 해석은 attachment_open 과 같은 관문을 쓴다(reference 모드 file:// 첨부 포함).
        let target = attachments::open(&conn, &state.data_dir, &attachment_id);
        (mode, over, name, target)
    };

    if mode == "off" {
        return Ok(SlidePreview::fallback("disabled"));
    }
    let Some(name) = name else {
        return Ok(SlidePreview::fallback(slide_render::REASON_UNSUPPORTED));
    };
    if !slide_render::is_slide(&name) {
        return Ok(SlidePreview::fallback(slide_render::REASON_UNSUPPORTED));
    }
    let Ok(OpenTarget::File(src)) = target else {
        return Ok(SlidePreview::fallback(slide_render::REASON_FAILED));
    };
    let Some(soffice) = slide_render::soffice_path(&override_path) else {
        return Ok(SlidePreview::fallback(slide_render::REASON_NO_CONVERTER));
    };
    // 심층 방어(AUDIT-2026-10-23 R1): 변환기가 데이터 폴더(첨부 업로드가 닿는 곳) 안에 있으면 실행하지 않는다.
    // 원격 settings_set 은 remote_policy 가 막지만, 어떤 경로로든 첨부로 올라온 exe 가 변환기가 되는 일은 없어야 한다.
    if slide_render::is_inside_dir(&soffice, &state.data_dir) {
        crate::diag::warn("slides", "soffice_inside_data_dir", "converter path points into the data dir; refusing to run it");
        return Ok(SlidePreview::fallback(slide_render::REASON_NO_CONVERTER));
    }

    // 분 단위가 걸릴 수 있다 — 커맨드 스레드를 붙잡지 않는다(attachment_thumbs 와 같은 이유).
    let data_dir = state.data_dir.clone();
    let id = attachment_id.clone();
    let done = tauri::async_runtime::spawn_blocking(move || {
        slide_render::render(&data_dir, &id, &src, &soffice)
    })
    .await;
    Ok(match done {
        Ok(Ok(pdf)) => SlidePreview { pdf_path: Some(pdf.to_string_lossy().to_string()), reason: None },
        Ok(Err(reason)) => SlidePreview::fallback(reason),
        Err(_) => SlidePreview::fallback(slide_render::REASON_FAILED),
    })
}
