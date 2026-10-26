// 첨부 파일 REST — GET /api/v1/attachments/{note_id}/{*file}(파일 스트리밍) ·
// POST /api/v1/notes/{note_id}/attachments(raw-body 업로드). 휴지통 가드·쓰기 통지는 notes.rs 공용.
use super::auth::{authorized, unauthorized, TokenQuery};
use super::notes::{check_not_trashed, emit_remote_write};
use super::remote_policy::client_id;
use super::responses::app_error_response;
use super::ServerState;
use crate::db;
use crate::error::AppResult;
use crate::repo;
use axum::body::Body;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tokio::sync::watch;

/// 확장자 → 서빙 Content-Type. repo::attachments::kind_from_ext 의 분류와 한 쌍이다(audio 로
/// 분류된 확장자가 octet-stream 으로 나가면 폰 `<audio>` 가 재생을 못 한다).
pub(super) fn guess_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        // 폰 녹음기 산출물(MediaRecorder audio/webm;codecs=opus, 파일명 .weba)과 그 형제들.
        "weba" => "audio/webm",
        "webm" => "video/webm",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// GET /api/v1/attachments/{note_id}/{*file} — 첨부 원본을 스트리밍한다.
pub(super) async fn attachment_file(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxPath((note_id, file)): AxPath<(String, String)>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    // repo::paths::safe_rel 은 backup.rs 의 zip-slip 가드와 같은 검증(../, 절대경로, 드라이브
    // prefix 거부) — axum의 Path 추출자가 이미 percent-decode 를 마친 뒤라 "%2e%2e%2f" 도
    // 여기 도달할 때는 이미 "../" 로 풀려 있어 그대로 걸린다.
    let rel = match repo::paths::safe_rel(&format!("{note_id}/{file}")) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid path").into_response(),
    };
    let base = db::attachments_dir(&state.data_dir);
    let full = base.join(&rel);
    // canonicalize + prefix 재확인 — safe_rel 은 문자열 컴포넌트 검사만 하므로, 심볼릭 링크 등
    // 파일시스템 수준 이탈까지 막는 벨트-앤-브레이스.
    let (canon_base, canon_full) = match (std::fs::canonicalize(&base), std::fs::canonicalize(&full)) {
        (Ok(b), Ok(f)) => (b, f),
        _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !canon_full.starts_with(&canon_base) {
        return (StatusCode::BAD_REQUEST, "invalid path").into_response();
    }
    let mime = guess_mime(canon_full.extension().and_then(|e| e.to_str()).unwrap_or(""));
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    serve_file(&canon_full, mime, range).await
}

/// `Range: bytes=…` 한 구간의 해석 결과. 여러 구간(`a-b,c-d`)·문법 오류는 `Ignore`(RFC 9110 §14.2:
/// 모르는 Range 는 무시하고 200 전체) — 폰 `<video>`/`<audio>` 는 단일 구간만 보낸다.
#[derive(Debug, PartialEq)]
enum RangeSpec {
    Ignore,
    Unsatisfiable,
    Bytes(u64, u64), // 양끝 포함
}

fn parse_range(header: &str, len: u64) -> RangeSpec {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return RangeSpec::Ignore;
    };
    if spec.contains(',') {
        return RangeSpec::Ignore;
    }
    let Some((a, b)) = spec.trim().split_once('-') else {
        return RangeSpec::Ignore;
    };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // 접미 구간 "-N": 끝에서 N바이트.
        let Ok(n) = b.parse::<u64>() else { return RangeSpec::Ignore };
        if n == 0 || len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        return RangeSpec::Bytes(len.saturating_sub(n), len - 1);
    }
    let Ok(start) = a.parse::<u64>() else { return RangeSpec::Ignore };
    let end = if b.is_empty() {
        u64::MAX
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e,
            _ => return RangeSpec::Ignore, // 뒤집힌 구간·숫자 아님은 문법 오류
        }
    };
    if start >= len {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::Bytes(start, end.min(len - 1))
}

/// 파일을 200(전체) 또는 206(단일 구간)으로 스트리밍한다 — 항상 Accept-Ranges·Content-Length 를 단다
/// (video 시킹·진행 표시가 이것에 기댄다). 인증·경로 검사는 호출부가 끝낸 뒤다.
async fn serve_file(path: &std::path::Path, mime: &'static str, range: Option<&str>) -> Response {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let spec = range.map(|r| parse_range(r, len)).unwrap_or(RangeSpec::Ignore);
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes");
    let built = match spec {
        RangeSpec::Unsatisfiable => builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .header(header::CONTENT_LENGTH, 0)
            .body(Body::empty()),
        RangeSpec::Bytes(start, end) => {
            if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
            }
            let n = end - start + 1;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, n)
                .body(Body::from_stream(tokio_util::io::ReaderStream::new(file.take(n))))
        }
        RangeSpec::Ignore => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, len)
            .body(Body::from_stream(tokio_util::io::ReaderStream::new(file))),
    };
    built.unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response())
}

/// 원격(모바일 데이터 요금제 위) 업로드는 desktop 로컬 드롭(repo::attachments::add_file 내부
/// MAX_ATTACHMENT_BYTES=200MB)보다 훨씬 보수적인 상한을 둔다. build_router 의 route-level
/// DefaultBodyLimit 오버라이드와 이 핸들러 내부의 명시적 재확인, 둘 다 이 값을 쓴다(레이어가
/// 요청을 통째로 거부하는 정상 경로가 주 방어선이고, 핸들러 안의 재확인은 벨트-앤-브레이스).
pub(super) const ATTACHMENT_UPLOAD_MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct AttachmentUploadQuery {
    token: Option<String>,
    /// 클라이언트가 보낸 원본 파일명 — 표시명(Attachment.name)과 kind 판별(확장자)에 쓰인다.
    /// 디스크 경로에는 절대 그대로 쓰지 않는다 — safe_attachment_basename 으로 새니타이즈한 뒤
    /// 임시 스테이징 파일명으로만 쓰고, 최종 저장 경로는 attachments::add_file 이 자체적으로
    /// 다시 short-id 접두사를 붙여 결정한다(desktop 드롭과 동일한 명명 규칙).
    filename: Option<String>,
    /// 첨부 메타(S2) — 폰이 아는 촬영/녹음 시각(RFC3339)과 좌표. **문자열로 받는다**: 숫자 필드로
    /// 받으면 깨진 값 하나가 업로드 전체를 400 으로 만든다 — 메타는 덤이므로 깨지면 버리고 첨부는 받는다
    /// (PhotoMeta::from_upload 가 검증).
    recorded_at: Option<String>,
    lat: Option<String>,
    lng: Option<String>,
}

enum SlotState {
    InProgress(watch::Receiver<Option<crate::models::Attachment>>),
    Done(crate::models::Attachment, Instant),
}

static UPLOAD_SLOTS: LazyLock<Mutex<HashMap<String, SlotState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_slots() -> std::sync::MutexGuard<'static, HashMap<String, SlotState>> {
    match UPLOAD_SLOTS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
static TEST_ADD_FILE_DELAYS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
static ACTIVE_TMP_DIRS: LazyLock<Mutex<HashMap<String, Vec<PathBuf>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
fn set_test_add_file_delay_ms(note_id: &str, ms: u64) {
    let mut map = match TEST_ADD_FILE_DELAYS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if ms == 0 {
        map.remove(note_id);
    } else {
        map.insert(note_id.to_string(), ms);
    }
}

#[cfg(test)]
fn get_test_add_file_delay_ms(note_id: &str) -> u64 {
    let map = match TEST_ADD_FILE_DELAYS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.get(note_id).copied().unwrap_or(0)
}

#[cfg(test)]
fn record_active_tmp_dir(note_id: &str, path: PathBuf) {
    let mut map = match ACTIVE_TMP_DIRS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.entry(note_id.to_string()).or_default().push(path);
}

#[cfg(test)]
fn get_active_tmp_dirs_for_note(note_id: &str) -> Vec<PathBuf> {
    let map = match ACTIVE_TMP_DIRS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.get(note_id).cloned().unwrap_or_default()
}

enum SlotClaim {
    AlreadyDone(crate::models::Attachment),
    Claimed(UploadClaimGuard),
}

struct UploadClaimGuard {
    key: String,
    tx: watch::Sender<Option<crate::models::Attachment>>,
    committed: bool,
}

impl UploadClaimGuard {
    fn finish(mut self, att: crate::models::Attachment) {
        self.committed = true;
        let mut map = lock_slots();
        map.insert(self.key.clone(), SlotState::Done(att.clone(), Instant::now()));
        let _ = self.tx.send(Some(att));
    }
}

impl Drop for UploadClaimGuard {
    fn drop(&mut self) {
        if !self.committed {
            let mut map = lock_slots();
            if let Some(SlotState::InProgress(_)) = map.get(&self.key) {
                map.remove(&self.key);
            }
            let _ = self.tx.send(None);
        }
    }
}

fn upload_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-upload-id")
        .or_else(|| headers.get("idempotency-key"))
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_string)
}

async fn claim_upload_slot(key: &str) -> SlotClaim {
    loop {
        let in_progress_rx = {
            let mut map = lock_slots();
            let now = Instant::now();
            map.retain(|_, v| match v {
                SlotState::Done(_, ts) => now.duration_since(*ts) < std::time::Duration::from_secs(600),
                SlotState::InProgress(_) => true,
            });

            match map.get(key) {
                Some(SlotState::Done(att, _)) => return SlotClaim::AlreadyDone(att.clone()),
                Some(SlotState::InProgress(rx)) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    map.insert(key.to_string(), SlotState::InProgress(rx));
                    return SlotClaim::Claimed(UploadClaimGuard {
                        key: key.to_string(),
                        tx,
                        committed: false,
                    });
                }
            }
        };

        let mut rx = in_progress_rx;
        if rx.changed().await.is_ok() {
            if let Some(ref att) = *rx.borrow() {
                return SlotClaim::AlreadyDone(att.clone());
            }
        }
    }
}

/// POST /api/v1/notes/{note_id}/attachments — raw-body 업로드(multipart 의존성 추가 대신: 파일명은
/// 쿼리 파라미터로, 바디는 파일 바이트 그대로 — mobile 클라이언트가 단일 fetch(body: file)로 보낼
/// 수 있는 가장 단순한 형태). desktop attachment_add_file 커맨드가 쓰는 것과 완전히 같은
/// repo::attachments::add_file 경로를 재사용한다 — 해싱/썸네일 판정/position/정리(cascade)가 데스크톱
/// 드롭과 동일하게 동작해야 하므로 파일 배치 로직을 여기서 새로 짜지 않는다. add_file은 `file_path: &str`(디스크 경로)를 받고 그 경로의
/// file_name()/extension()으로 표시명·kind(kind_from_ext)를 파생하므로, 업로드 바이트를 OS temp
/// 아래 새 디렉토리에 새니타이즈된 원본 파일명 그대로 먼저 써 둔 뒤(임시 파일명이 uuid.tmp 식이면
/// 모든 업로드가 kind="doc"으로 오분류된다) 그 경로를 add_file 에 넘기고, 끝나면 임시 디렉토리를
/// 지운다. 스테이징과 커밋 후 후속 단계(썸네일·EXIF 경유지)는 desktop 커맨드와
/// repo::attachments::post_add 한 곳을 공유한다 — add_file 자체는 썸네일을 만들지 않는다.
pub(super) async fn attachment_upload(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxPath(note_id): AxPath<String>,
    Query(q): Query<AttachmentUploadQuery>,
    body: axum::body::Bytes,
) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    // DefaultBodyLimit(route-level, build_router) 이 주 방어선 — 여기는 벨트-앤-브레이스 재확인.
    if body.len() > ATTACHMENT_UPLOAD_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("attachment exceeds {}MB limit", ATTACHMENT_UPLOAD_MAX_BYTES / (1024 * 1024)),
        )
            .into_response();
    }

    let key_opt = upload_id(&headers).map(|uid| format!("{note_id}:{uid}"));
    let guard = if let Some(ref key) = key_opt {
        match claim_upload_slot(key).await {
            SlotClaim::AlreadyDone(att) => {
                return (StatusCode::CREATED, Json(att)).into_response();
            }
            SlotClaim::Claimed(g) => Some(g),
        }
    } else {
        None
    };

    let hint = repo::attachments::PhotoMeta::from_upload(
        q.recorded_at.as_deref(),
        q.lat.as_deref().and_then(|v| v.parse().ok()),
        q.lng.as_deref().and_then(|v| v.parse().ok()),
    );
    let hint = (hint != repo::attachments::PhotoMeta::default()).then_some(hint);
    let upload_name = q.filename.unwrap_or_else(|| "attachment".to_string());
    let data_dir = state.data_dir.clone();
    let tmp_dir = repo::attachments::post_add::staging_dir("brise-upload");
    #[cfg(test)]
    record_active_tmp_dir(&note_id, tmp_dir.clone());

    let client = client_id(&headers);

    // FIX2-A: 스테이징부터 add_file, finish, tmp_dir 정리까지를 tokio::spawn 한 작업이 guard와 함께 소유한다.
    // 핸들러 future가 클라이언트 타임아웃/연결종료로 drop되더라도(예: JoinHandle 만 취소)
    // 백그라운드 작업은 끝까지 돌아 슬롯을 Done으로 만들고 tmp_dir를 정리하므로
    // 재시도 시 중복 첨부가 생기거나 임시 폴더가 남지 않는다.
    let upload_task = tokio::spawn(async move {
        // M-18: 타임아웃은 staging(임시 수신)만 보호한다.
        let staged = tokio::time::timeout(std::time::Duration::from_secs(30), {
            let tmp_dir = tmp_dir.clone();
            let upload_name = upload_name.clone();
            let body = body.clone();
            tokio::task::spawn_blocking(move || {
                repo::attachments::post_add::stage_bytes(&tmp_dir, &upload_name, &body)
            })
        })
        .await;

        let att_tmp_path = match staged {
            Ok(Ok(Ok(path))) => path,
            Ok(Ok(Err(e))) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(crate::error::io(e));
            }
            Ok(Err(join_err)) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(crate::error::io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("stage worker join error: {join_err}"),
                )));
            }
            Err(_) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(crate::error::io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "attachment upload timed out",
                )));
            }
        };

        // M-18: add_file이 시작되면 완료될 때까지 await하고 실제 결과(성공 시 201)로 응답.
        let note_id_check = note_id.clone();
        let att_data_dir = data_dir.clone();
        let file_path_str = att_tmp_path.to_string_lossy().to_string();

        let add_result = tokio::task::spawn_blocking(move || -> AppResult<crate::models::Attachment> {
            #[cfg(test)]
            {
                let delay = get_test_add_file_delay_ms(&note_id_check);
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
            }
            let mut conn = db::open(&db::db_path(&att_data_dir))?;
            check_not_trashed(&conn, &note_id_check)?;
            repo::attachments::add_file(&mut conn, &att_data_dir, &note_id_check, &file_path_str)
        })
        .await;

        // M-18: tmp_dir 정리는 블로킹 작업이 끝난 후에만 수행.
        let _ = std::fs::remove_dir_all(&tmp_dir);

        let att = match add_result {
            Ok(Ok(att)) => att,
            Ok(Err(e)) => return Err(e),
            Err(e) => {
                return Err(crate::error::io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("worker join error: {e}"),
                )));
            }
        };

        if let Some(g) = guard {
            g.finish(att.clone());
        }

        // 데스크톱 attachment_add_file 커맨드와 동일한 후속 단계 — 썸네일은 add_file 안이 아니라
        // 여기서 별도로(DB 락 밖, spawn_blocking) 만든다. 실패해도 첨부 자체는 유효하다.
        {
            let thumb_data_dir = data_dir.clone();
            let thumb_att = att.clone();
            let _ = tokio::task::spawn_blocking(move || {
                repo::attachments::post_add::ensure_thumb(&thumb_data_dir, &thumb_att)
            })
            .await;
        }

        // 폰이 보낸 X-Brise-Client 를 실어 통지한다 — 없으면 폰이 자기 업로드를 "다른 기기의 변경"으로 오인한다(M-21).
        // invoke 경로와 같은 헤더 검증(remote_policy::client_id).
        crate::events::scope_remote(client.clone(), async { emit_remote_write(&note_id, false) }).await;

        // EXIF/업로드 메타 → 날짜·경유지 자동 반영 — 데스크톱 attachment_add_file 커맨드와 같은 커밋 후
        // 훅(repo::attachments::exif_region). 네트워크(지오코딩)가 끼므로 fire-and-forget. 나중에 다른
        // 스레드에서 나가는 통지에도 같은 client 를 씌운다.
        repo::attachments::post_add::spawn_auto_meta_remote(&data_dir, &note_id, &att, client, hint);

        Ok(att)
    });

    match upload_task.await {
        Ok(Ok(att)) => (StatusCode::CREATED, Json(att)).into_response(),
        Ok(Err(app_err)) => app_error_response(app_err),
        Err(join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("upload task join error: {join_err}"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn call(range: Option<&str>) -> Response {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.webm");
        std::fs::write(&p, (0u8..200).collect::<Vec<_>>()).unwrap();
        serve_file(&p, "video/webm", range).await
    }

    fn h(r: &Response, name: header::HeaderName) -> String {
        r.headers().get(name).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
    }

    async fn body(r: Response) -> Vec<u8> {
        to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    #[tokio::test]
    async fn no_range_is_200_with_length_and_accept_ranges() {
        let r = call(None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(h(&r, header::CONTENT_LENGTH), "200");
        assert_eq!(h(&r, header::ACCEPT_RANGES), "bytes");
        assert_eq!(body(r).await.len(), 200);
    }

    #[tokio::test]
    async fn bounded_range_is_206_with_those_bytes() {
        let r = call(Some("bytes=0-99")).await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 0-99/200");
        assert_eq!(h(&r, header::CONTENT_LENGTH), "100");
        assert_eq!(body(r).await, (0u8..100).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn open_ended_and_suffix_ranges() {
        let r = call(Some("bytes=150-")).await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 150-199/200");
        assert_eq!(body(r).await, (150u8..200).collect::<Vec<_>>());
        let r = call(Some("bytes=-10")).await;
        assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 190-199/200");
        assert_eq!(body(r).await, (190u8..200).collect::<Vec<_>>());
        // 끝이 파일을 넘으면 잘린다.
        let r = call(Some("bytes=190-9999")).await;
        assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 190-199/200");
    }

    #[tokio::test]
    async fn out_of_bounds_range_is_416() {
        let r = call(Some("bytes=200-300")).await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(h(&r, header::CONTENT_RANGE), "bytes */200");
    }

    #[test]
    fn multi_or_malformed_ranges_are_ignored() {
        assert_eq!(parse_range("bytes=0-1,5-6", 10), RangeSpec::Ignore);
        assert_eq!(parse_range("items=0-1", 10), RangeSpec::Ignore);
        assert_eq!(parse_range("bytes=5-2", 10), RangeSpec::Ignore);
        assert_eq!(parse_range("bytes=x-2", 10), RangeSpec::Ignore);
    }

    // kind_and_guess_mime_stay_in_sync_for_media 는 기능 카탈로그(specs/features/notes.yaml F-N04)가
    // handlers.rs 를 verify 경로로 이름 인용하므로 handlers.rs 의 tests 에 남아 있다.

    #[test]
    fn path_traversal_is_rejected_by_safe_rel() {
        assert!(repo::paths::safe_rel("note1/../../evil.txt").is_err());
        assert!(repo::paths::safe_rel("../evil.txt").is_err());
        // axum의 Path 추출자가 "%2e%2e%2f"를 이미 "../"로 percent-decode 한 뒤 이 값이 들어온다 —
        // 디코드된 형태로도 여전히 거부되는지가 실제로 방어선이 서는 지점이다.
        assert!(repo::paths::safe_rel("note1/../secret").is_err());
    }

    fn test_server_state(data_dir: std::path::PathBuf, token: &str) -> ServerState {
        ServerState {
            data_dir,
            token: token.to_string(),
            app_handle: None,
            sse_subscribers: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            shutdown: tokio::sync::watch::channel(()).1,
            ai_rate_limiter: std::sync::Arc::new(crate::sync_server::handlers::AiRateLimiter::new()),
        }
    }

    #[tokio::test]
    async fn upload_idempotency_retry_after_client_timeout_leaves_exactly_one_row() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(tmp.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("테스트 노트".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id;
        drop(conn);

        let state = test_server_state(tmp.path().to_path_buf(), "tok123");
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer tok123".parse().unwrap());
        headers.insert("x-upload-id", "upload-id-seq-1".parse().unwrap());

        let q = AttachmentUploadQuery {
            token: None,
            filename: Some("photo.png".to_string()),
            recorded_at: None,
            lat: None,
            lng: None,
        };
        let bytes = axum::body::Bytes::from_static(b"image raw bytes for idempotency test");

        // 첫 번째 업로드 (클라이언트 관점: 타임아웃으로 실패했다고 간주)
        let res1 = attachment_upload(
            State(state.clone()),
            headers.clone(),
            AxPath(note_id.clone()),
            Query(q),
            bytes.clone(),
        )
        .await;
        assert_eq!(res1.status(), StatusCode::CREATED);
        let body1 = to_bytes(res1.into_body(), usize::MAX).await.unwrap();
        let att1: crate::models::Attachment = serde_json::from_slice(&body1).unwrap();

        // 클라이언트 재시도 (동일한 x-upload-id 전송)
        let q2 = AttachmentUploadQuery {
            token: None,
            filename: Some("photo.png".to_string()),
            recorded_at: None,
            lat: None,
            lng: None,
        };
        let res2 = attachment_upload(
            State(state.clone()),
            headers.clone(),
            AxPath(note_id.clone()),
            Query(q2),
            bytes.clone(),
        )
        .await;
        assert_eq!(res2.status(), StatusCode::CREATED);
        let body2 = to_bytes(res2.into_body(), usize::MAX).await.unwrap();
        let att2: crate::models::Attachment = serde_json::from_slice(&body2).unwrap();

        // 멱등 응답: 동일한 attachment 반환
        assert_eq!(att1.id, att2.id);

        // DB에 첨부 행이 정확히 1개만 남았는지 검증
        let conn = db::open(&db::db_path(tmp.path())).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM attachments WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "클라이언트 재시도 후에도 DB에는 정확히 1개의 첨부 행만 남아야 한다");
    }

    #[tokio::test]
    async fn upload_idempotency_concurrent_retry_leaves_exactly_one_row() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(tmp.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("동시 재시도 노트".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id;
        drop(conn);

        let state = test_server_state(tmp.path().to_path_buf(), "tok123");
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer tok123".parse().unwrap());
        headers.insert("x-upload-id", "upload-id-concurrent-1".parse().unwrap());

        let bytes = axum::body::Bytes::from_static(b"concurrent upload bytes");

        let handle1 = {
            let state = state.clone();
            let headers = headers.clone();
            let note_id = note_id.clone();
            let bytes = bytes.clone();
            tokio::spawn(async move {
                let q = AttachmentUploadQuery {
                    token: None,
                    filename: Some("memo.webm".to_string()),
                    recorded_at: None,
                    lat: None,
                    lng: None,
                };
                attachment_upload(State(state), headers, AxPath(note_id), Query(q), bytes).await
            })
        };

        let handle2 = {
            let state = state.clone();
            let headers = headers.clone();
            let note_id = note_id.clone();
            let bytes = bytes.clone();
            tokio::spawn(async move {
                let q = AttachmentUploadQuery {
                    token: None,
                    filename: Some("memo.webm".to_string()),
                    recorded_at: None,
                    lat: None,
                    lng: None,
                };
                attachment_upload(State(state), headers, AxPath(note_id), Query(q), bytes).await
            })
        };

        let (res1, res2) = tokio::join!(handle1, handle2);
        let res1 = res1.unwrap();
        let res2 = res2.unwrap();
        assert_eq!(res1.status(), StatusCode::CREATED);
        assert_eq!(res2.status(), StatusCode::CREATED);

        let body1 = to_bytes(res1.into_body(), usize::MAX).await.unwrap();
        let att1: crate::models::Attachment = serde_json::from_slice(&body1).unwrap();
        let body2 = to_bytes(res2.into_body(), usize::MAX).await.unwrap();
        let att2: crate::models::Attachment = serde_json::from_slice(&body2).unwrap();

        assert_eq!(att1.id, att2.id);

        let conn = db::open(&db::db_path(tmp.path())).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM attachments WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "동시 업로드/재시도에서도 DB에는 정확히 1개의 첨부 행만 남아야 한다");
    }

    #[tokio::test]
    async fn upload_with_client_header_publishes_remote_write_tagged_with_client() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(tmp.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("M21 에코 테스트 노트".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id;
        drop(conn);

        let mut rx = crate::events::subscribe();

        let state = test_server_state(tmp.path().to_path_buf(), "tok123");
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer tok123".parse().unwrap());
        headers.insert("x-brise-client", "phone_client_xyz".parse().unwrap());

        let q = AttachmentUploadQuery {
            token: None,
            filename: Some("echo.png".to_string()),
            recorded_at: None,
            lat: None,
            lng: None,
        };
        let bytes = axum::body::Bytes::from_static(b"image bytes for M21");

        let res = attachment_upload(State(state), headers, AxPath(note_id.clone()), Query(q), bytes).await;
        assert_eq!(res.status(), StatusCode::CREATED);

        // 버스에서 발행된 이벤트를 찾아 태깅 검증 (M-21)
        let found = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Ok(msg) = rx.recv().await {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
                        if v["note_id"] == note_id.as_str() {
                            return v;
                        }
                    }
                }
            }
        })
        .await
        .expect("remote-note-write event must be published within timeout");

        assert_eq!(found["event"], "remote-note-write");
        assert_eq!(found["origin"], "remote");
        assert_eq!(found["client"], "phone_client_xyz", "X-Brise-Client 로 태깅된 client 필드가 포함되어야 한다 (M-21)");
    }

    #[tokio::test]
    async fn upload_idempotency_retry_after_client_abort_leaves_exactly_one_row() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(tmp.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let detail = crate::repo::notes::create_today_default(&mut conn, &folder_id, Some("클라이언트 abort 재시도 테스트".to_string()), None, None, None).unwrap();
        let note_id = detail.note.id;
        drop(conn);

        let state = test_server_state(tmp.path().to_path_buf(), "tok123");
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer tok123".parse().unwrap());
        headers.insert("x-upload-id", "upload-abort-retry-1".parse().unwrap());

        let bytes = axum::body::Bytes::from_static(b"image bytes for abort test");

        set_test_add_file_delay_ms(&note_id, 250);

        // 첫 번째 업로드: tokio::spawn 으로 띄우고 add_file 실행 도중에 abort() (클라이언트 타임아웃/연결종료 모사)
        let handle1 = {
            let state = state.clone();
            let headers = headers.clone();
            let note_id = note_id.clone();
            let bytes = bytes.clone();
            tokio::spawn(async move {
                let q = AttachmentUploadQuery {
                    token: None,
                    filename: Some("photo.png".to_string()),
                    recorded_at: None,
                    lat: None,
                    lng: None,
                };
                attachment_upload(State(state), headers, AxPath(note_id), Query(q), bytes).await
            })
        };

        // add_file 지연에 진입하도록 잠시 대기 후 핸들러 future 취소(abort)
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        handle1.abort();
        let _ = handle1.await;

        // 클라이언트 재시도 (동일한 x-upload-id 전송)
        let q2 = AttachmentUploadQuery {
            token: None,
            filename: Some("photo.png".to_string()),
            recorded_at: None,
            lat: None,
            lng: None,
        };
        let res2 = attachment_upload(
            State(state.clone()),
            headers.clone(),
            AxPath(note_id.clone()),
            Query(q2),
            bytes.clone(),
        )
        .await;

        set_test_add_file_delay_ms(&note_id, 0);

        assert_eq!(res2.status(), StatusCode::CREATED);
        let body2 = to_bytes(res2.into_body(), usize::MAX).await.unwrap();
        let att2: crate::models::Attachment = serde_json::from_slice(&body2).unwrap();
        assert!(!att2.id.is_empty());

        // DB에 첨부 행이 정확히 1개인지 검증
        let conn = db::open(&db::db_path(tmp.path())).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM attachments WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "클라이언트 abort 후 재시도 시 DB에는 정확히 1개의 첨부 행만 남아야 한다");

        // 백그라운드 태스크가 정상 완료되어 임시 폴더가 남아있지 않은지 검증
        let recorded = get_active_tmp_dirs_for_note(&note_id);
        for dir in recorded {
            assert!(!dir.exists(), "임시 디렉터리가 정리되어 남아있지 않아야 한다: {:?}", dir);
        }
    }
}
