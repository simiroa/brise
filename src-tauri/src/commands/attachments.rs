// 커맨드: attachments (commands/attachments.yaml)
use super::{AppState, Deleted, Okay};
use crate::error::AppError;
use crate::models::Attachment;
use crate::repo::attachment_query::{
    AttachmentQuery, AttachmentQueryResult, ATTACHMENT_QUERY_MAX_LIMIT,
};
use crate::repo::attachment_query as att_query;
use crate::repo::attachments::{self, OpenTarget};
use crate::repo::web_reader::{self, ReaderContent};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_add_file(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    note_id: String,
    file_path: String,
    mode: Option<String>,
) -> Result<Attachment, AppError> {
    let att = {
        let mut conn = state.db.lock();
        // mode="ref": 복사 없이 원본 경로만 저장(크기 상한 없음). 아래 후속 단계(썸네일·EXIF)는
        // rel_path 가 없으면 저절로 건너뛴다 — 참조 첨부에는 앱이 만들 파일이 없다.
        attachments::add_file_from_disk(
            &mut conn,
            &state.data_dir,
            &note_id,
            &file_path,
            mode.as_deref(),
        )?
    };
    thumb_follow_up(&state, &att).await;
    // async 커맨드라 invoke_handler 의 창 라벨 스코프 밖이다 — 호출 창 라벨을 직접 싣는다(events::publish_as). 안 그러면
    // window=null("출처 모를 local")로 나가 본 창이 자기 붙여넣기·드롭마다 트리를 통째로 다시 읽는다.
    crate::events::publish_as(Some(webview.label()), Some(&note_id), false);
    attachments::post_add::spawn_auto_meta(&state.data_dir, &note_id, &att, false, None);
    Ok(att)
}

/// 썸네일 후속 단계를 (1) DB 락 밖에서, (2) 커맨드 스레드 밖에서 돌린다 — 왜 spawn_blocking 이어야
/// 하는지는 post_add::ensure_thumb 주석(실측 1,837ms 스톨). 판정·생성은 거기 한 곳에만 있다.
async fn thumb_follow_up(state: &State<'_, AppState>, att: &Attachment) {
    let data_dir = state.data_dir.clone();
    let att = att.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        attachments::post_add::ensure_thumb(&data_dir, &att)
    })
    .await;
}

/// 클립보드 붙여넣기(에디터 paste) 전용 진입점 — clipboardData 의 File 은 디스크 경로가 없는
/// raw 바이트라 attachment_add_file(file_path 계약)을 그대로 못 쓴다. OS temp 에 짧게
/// 스테이징한 뒤 그 경로로 attachments::add_file 을 그대로 호출해, 해싱/썸네일/포지션 로직을
/// 새로 짜지 않는다 — sync_server::handlers::attachment_upload(원격 업로드) 와 스테이징을
/// post_add::stage_bytes 한 함수로 공유한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_add_bytes(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    note_id: String,
    name: String,
    data_base64: String,
) -> Result<Attachment, AppError> {
    attachment_add_bytes_in(state, Some(webview.label()), note_id, name, data_base64).await
}

/// attachment_add_bytes 의 본체 — `window` 는 호출한 웹뷰의 라벨(없으면 트레이 같은 창 없는 호출 → 출처 모름 publish).
/// 펫의 화면 저장(pet::capture_to_inbox)이 창 없이 부른다.
pub(crate) async fn attachment_add_bytes_in(
    state: State<'_, AppState>,
    window: Option<&str>,
    note_id: String,
    name: String,
    data_base64: String,
) -> Result<Attachment, AppError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppError::Validation(format!("invalid base64: {e}")))?;

    let tmp_dir = attachments::post_add::staging_dir("brise-paste");
    let tmp_path = {
        let tmp_dir = tmp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            attachments::post_add::stage_bytes(&tmp_dir, &name, &bytes)
        })
        .await
        .map_err(|e| AppError::Io(format!("stage worker join error: {e}")))?
        .map_err(|e| AppError::Io(e.to_string()))?
    };

    let file_path_str = tmp_path.to_string_lossy().to_string();
    let add_result = {
        let mut conn = state.db.lock();
        attachments::add_file(&mut conn, &state.data_dir, &note_id, &file_path_str)
    };
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let att = add_result?;

    thumb_follow_up(&state, &att).await;
    crate::events::publish_as(window, Some(&note_id), false); // attachment_add_file 주석 참고
    attachments::post_add::spawn_auto_meta(&state.data_dir, &note_id, &att, false, None);
    Ok(att)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_add_link(
    state: State<AppState>,
    note_id: String,
    name: String,
    url: String,
) -> Result<Attachment, AppError> {
    let mut conn = state.db.lock();
    let att = attachments::add_link(&mut conn, &note_id, &name, &url)?;
    crate::events::publish(Some(&note_id), false);
    Ok(att)
}

/// 각주(Wave 4). 본문 앵커 mark 는 프론트가 심고, 이 커맨드는 각주 본문 첨부 행만 만든다.
/// 저장은 add_footnote(.md + rel_path)이 전담; kind='footnote', anchor_text→url.
#[tauri::command(rename_all = "snake_case")]
pub fn attachment_add_footnote(
    state: State<AppState>,
    note_id: String,
    text: String,
    anchor_text: Option<String>,
) -> Result<Attachment, AppError> {
    let mut conn = state.db.lock();
    let att = attachments::add_footnote(
        &mut conn,
        &state.data_dir,
        &note_id,
        &text,
        anchor_text.as_deref(),
    )?;
    crate::events::publish(Some(&note_id), false);
    Ok(att)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_add_internal(
    state: State<AppState>,
    note_id: String,
    target_note_id: String,
    name: String,
) -> Result<Attachment, AppError> {
    let mut conn = state.db.lock();
    let att = attachments::add_internal(&mut conn, &note_id, &target_note_id, &name)?;
    crate::events::publish(Some(&note_id), false);
    Ok(att)
}

/// 시트 차트 라이브 참조(PLAN-2026-09-20 §2.3) — attachment_add_internal 규약 그대로.
#[tauri::command(rename_all = "snake_case")]
pub fn attachment_add_chart(
    state: State<AppState>,
    note_id: String,
    section_id: String,
    chart_id: String,
    name: String,
) -> Result<Attachment, AppError> {
    let conn = state.db.lock();
    let att = attachments::add_chart_ref(&conn, &note_id, &section_id, &chart_id, &name)?;
    crate::events::publish(Some(&note_id), false);
    Ok(att)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_remove(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let mut conn = state.db.lock();
    let deleted = attachments::remove(&mut conn, &state.data_dir, &id)?;
    crate::events::publish(None, false); // attachment id 만 알고 note_id 는 모른다 — coarse.
    Ok(Deleted { deleted })
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_rename(state: State<AppState>, id: String, name: String) -> Result<Attachment, AppError> {
    let mut conn = state.db.lock();
    let att = attachments::rename(&mut conn, &id, &name)?;
    crate::events::publish(None, false); // attachment id 만 알고 note_id 는 모른다 — coarse.
    Ok(att)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_open(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<Okay, AppError> {
    let target = {
        let conn = state.db.lock();
        attachments::open(&conn, &state.data_dir, &id)?
    };
    match target {
        // 실행형(.exe/.bat/…)은 열면 곧바로 실행된다 — 폴더에서 보기로 돌려 사용자가 직접 결정하게 한다.
        OpenTarget::File(path) if attachments::is_executable_ext(&path) => app
            .opener()
            .reveal_item_in_dir(path.to_string_lossy().to_string())
            .map_err(|e| AppError::Io(e.to_string()))?,
        OpenTarget::File(path) => app
            .opener()
            .open_path(path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| AppError::Io(e.to_string()))?,
        OpenTarget::Link(url) => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::Io(e.to_string()))?,
    }
    Ok(Okay { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachment_reveal(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<Okay, AppError> {
    let target = {
        let conn = state.db.lock();
        attachments::open(&conn, &state.data_dir, &id)?
    };
    match target {
        OpenTarget::File(path) => app
            .opener()
            .reveal_item_in_dir(path.to_string_lossy().to_string())
            .map_err(|e| AppError::Io(e.to_string()))?,
        OpenTarget::Link(_) => {
            return Err(AppError::Validation(
                "Link attachments do not have a file location".to_string(),
            ));
        }
    }
    Ok(Okay { ok: true })
}


/// Link-attachment "reader view": fetches the page server-side and returns extracted plain text.
/// Explicit user action only (invoked from the preview pane's own click) — never called as
/// background prefetch, since fetching a remote URL is a privacy-relevant network call.
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_fetch_reader(
    state: State<'_, AppState>,
    id: String,
) -> Result<ReaderContent, AppError> {
    let url = {
        let conn = state.db.lock();
        attachments::link_url(&conn, &id)?
    };
    web_reader::fetch_reader(&url).await
}

#[derive(serde::Serialize)]
pub struct AttachmentText {
    pub text: String,
    /// 파일이 프리뷰 상한을 넘어 **앞부분만** 담겼다. 프런트가 그 사실을 반드시 보여줘야 한다.
    pub truncated: bool,
}

/// 텍스트 프리뷰(각주 목록·DocPreview .md/.txt)의 본문 읽기 — asset 프로토콜 fetch 대체.
#[tauri::command(rename_all = "snake_case")]
pub fn attachment_read_text(
    state: State<AppState>,
    id: String,
) -> Result<AttachmentText, AppError> {
    let conn = state.db.lock();
    let (text, truncated) = attachments::read_text(&conn, &state.data_dir, &id)?;
    Ok(AttachmentText { text, truncated })
}

#[derive(serde::Serialize)]
pub struct AttachmentsBaseDir {
    pub base: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn attachments_base_dir(state: State<AppState>) -> Result<AttachmentsBaseDir, AppError> {
    let dir = crate::db::attachments_dir(&state.data_dir);
    Ok(AttachmentsBaseDir {
        base: dir.to_string_lossy().to_string(),
    })
}

#[derive(serde::Serialize)]
pub struct AttachmentThumbEntry {
    pub id: String,
    pub rel_path: String,
}

#[derive(serde::Serialize)]
pub struct AttachmentThumbs {
    pub thumbs: Vec<AttachmentThumbEntry>,
}

/// Lazy/on-demand thumbnails for a note's image attachments.
///
/// The DB lock is held only while reading rows, and the decode/encode runs on a blocking
/// thread — both are required. Dropping the lock alone is not enough: Tauri runs synchronous
/// commands serially, so a sync command doing ~300ms of image work per attachment stalls every
/// other command (measured: attachments_base_dir, which touches no lock, went 2ms → 1,837ms).
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_thumbs(
    state: State<'_, AppState>,
    note_id: String,
) -> Result<AttachmentThumbs, AppError> {
    let candidates = {
        let conn = state.db.lock();
        attachments::thumb_candidates(&conn, &note_id)?
    };
    generate_thumbs_for_candidates(state.data_dir.clone(), candidates).await
}

/// Workspace gallery page — bounded read, newest insertion first. Sync: DB + ≤limit stat().
#[tauri::command(rename_all = "snake_case")]
pub fn attachment_query(
    state: State<'_, AppState>,
    kinds: Option<Vec<String>>,
    query: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
    workspace_id: Option<String>,
    sort: Option<String>,
) -> Result<AttachmentQueryResult, AppError> {
    let q = AttachmentQuery {
        kinds: kinds.unwrap_or_default(),
        query,
        offset: offset.unwrap_or(0),
        limit,
        workspace_id,
        sort,
    };
    let conn = state.db.lock();
    att_query::query(&conn, &state.data_dir, q)
}

/// Generate thumbnails for exactly the attachment ids on screen (gallery page).
///
/// Same lock/decode rules as `attachment_thumbs`: read rows under the DB lock, drop it, then
/// decode on a blocking worker so other commands are not stalled. `ids` is capped at
/// ATTACHMENT_QUERY_MAX_LIMIT so one call cannot become unbounded work.
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_thumbs_for_ids(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<AttachmentThumbs, AppError> {
    let ids: Vec<String> = ids.into_iter().take(ATTACHMENT_QUERY_MAX_LIMIT as usize).collect();
    let candidates = {
        let conn = state.db.lock();
        att_query::thumb_candidates_for_ids(&conn, &ids)?
    };
    generate_thumbs_for_candidates(state.data_dir.clone(), candidates).await
}

async fn generate_thumbs_for_candidates(
    data_dir: std::path::PathBuf,
    candidates: Vec<(String, String)>,
) -> Result<AttachmentThumbs, AppError> {
    let thumbs = tauri::async_runtime::spawn_blocking(move || {
        candidates
            .into_iter()
            .filter_map(|(id, rel_path)| {
                attachments::ensure_thumb_for_attachment(&data_dir, &rel_path)
                    .map(|rel_path| AttachmentThumbEntry { id, rel_path })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| AppError::Io(format!("thumbnail worker failed: {e}")))?;
    Ok(AttachmentThumbs { thumbs })
}
