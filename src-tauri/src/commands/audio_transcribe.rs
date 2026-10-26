// 커맨드: audio_transcribe · attachment_transcript_mark_inserted (commands/transcribe.yaml)
// PLAN-2026-10-06-s2-input.md §5.3-3 / §5.4 — 녹음(오디오 첨부)을 Gemini 로 받아쓴다. 결과는 **서버가
// 첨부 행(attachments.transcript)에 보관**하고 노트 본문에는 쓰지 않는다(D2② expected_updated_at 이
// 아직 없어 폰이 편집 중인 본문을 서버가 덮을 수 있다) — 삽입은 클라이언트가 한다.
use super::{AppState, Okay};
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::ai::{self, AudioTransport};
use crate::repo::{attachments, settings};
use rusqlite::{params, OptionalExtension};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::State;

/// 안정 에러 코드(메시지 접두) — 프런트가 사용자 말로 바꾸려고 매칭한다. 게이트(`ai_required`)와
/// 미지원 provider(`audio_unsupported_provider`)는 repo::ai 가 소유한다.
pub const ERR_AUDIO_TOO_LARGE: &str = "audio_too_large";
pub const ERR_AUDIO_MISSING: &str = "audio_file_missing";
pub const ERR_IN_PROGRESS: &str = "transcribe_in_progress";
pub const ERR_EMPTY: &str = "transcribe_empty";

/// Gemini inline_data 는 **요청 전체 20MB** 한도다. base64 는 4/3 로 부풀므로 원본 14MB(≈18.7MB)가
/// 상한 — 첨부 업로드 상한(25MB)보다 작다.
/// ponytail: 14MB ≈ opus 32kbps 로 약 58분. 더 긴 녹음은 Gemini Files API(업로드 후 file_data 참조)로
/// 올려야 한다 — 필요가 실측되면 transport 에 추가하고 이 상수만 풀면 된다.
pub const AUDIO_INLINE_MAX_BYTES: u64 = 14 * 1024 * 1024;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct AudioTranscript {
    pub text: String,
}

/// 같은 첨부에 대한 **동시** 전사를 막는 진행 중 집합 — 멱등 검사(저장된 transcript)는 첫 호출이
/// 끝나야 효력이 생기므로, 폰 재시도/중복 탭이 겹치면 외부 호출이 두 번 나가 비용이 두 배가 된다.
static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct InFlightGuard(String);

impl InFlightGuard {
    fn acquire(id: &str) -> Option<Self> {
        let mut g = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if g.get_or_insert_with(HashSet::new).insert(id.to_string()) {
            Some(Self(id.to_string()))
        } else {
            None
        }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut g = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(set) = g.as_mut() {
            set.remove(&self.0);
        }
    }
}

/// 확장자 → Gemini 가 받는 오디오 mime. 모르는 확장자는 None(= 오디오로 보내지 않는다).
/// ponytail: webm/m4a 는 Gemini 공식 목록(wav·mp3·aiff·aac·ogg·flac)에 없다 — 실기에서 거절되면
/// 녹음기를 지원 형식으로 맞추거나 여기서 변환 단계를 둔다. 거절은 일반 실패(재시도 가능)로 올라온다.
fn audio_mime(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mp3",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" | "mp4" => "audio/mp4",
        "webm" | "weba" => "audio/webm",
        _ => return None,
    })
}

struct AudioRow {
    name: String,
    rel_path: Option<String>,
    ext_path: Option<String>,
    transcript: Option<String>,
}

/// 첨부 행을 읽고 **이 노트의 audio 인지** 검증한다(다른 노트의 첨부를 id 만으로 전사하지 못하게).
fn load_audio_row(state: &AppState, note_id: &str, attachment_id: &str) -> AppResult<AudioRow> {
    let conn = state.db.lock();
    let row: Option<(String, String, String, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT note_id, kind, name, rel_path, ext_path, transcript FROM attachments WHERE id=?1",
            [attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (owner, kind, name, rel_path, ext_path, transcript) =
        row.ok_or_else(|| AppError::NotFound(format!("attachment not found: {attachment_id}")))?;
    if owner != note_id {
        return Err(AppError::Validation("attachment does not belong to this note".to_string()));
    }
    if kind != "audio" {
        return Err(AppError::Validation("only audio attachments can be transcribed".to_string()));
    }
    Ok(AudioRow { name, rel_path, ext_path, transcript })
}

/// 파일을 읽어 base64 로 — 크기는 **읽기 전에** metadata 로 거른다(거대 참조 파일을 메모리에 올리지 않는다).
fn read_audio_base64(state: &AppState, row: &AudioRow) -> AppResult<(String, &'static str)> {
    use base64::Engine as _;
    let path = attachments::file_path_of(&state.data_dir, row.rel_path.as_deref(), row.ext_path.as_deref())
        .ok_or_else(|| AppError::Validation(format!("{ERR_AUDIO_MISSING}: attachment has no file")))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mime = audio_mime(ext)
        .or_else(|| audio_mime(std::path::Path::new(&row.name).extension().and_then(|e| e.to_str()).unwrap_or("")))
        .ok_or_else(|| AppError::Validation("unsupported audio format for transcription".to_string()))?;
    let meta = std::fs::metadata(&path)
        .map_err(|_| AppError::NotFound(format!("{ERR_AUDIO_MISSING}: file is not on disk")))?;
    if meta.len() > AUDIO_INLINE_MAX_BYTES {
        return Err(AppError::Validation(format!(
            "{ERR_AUDIO_TOO_LARGE}: {} bytes exceeds the {AUDIO_INLINE_MAX_BYTES} byte transcription limit",
            meta.len()
        )));
    }
    let bytes = std::fs::read(&path).map_err(crate::error::io)?;
    Ok((base64::engine::general_purpose::STANDARD.encode(bytes), mime))
}

/// 본체 — transport 를 주입받아 목으로 검증한다. 순서(바꾸면 비용·보안 불변식이 깨진다):
/// 행 검증(노트 일치·audio) → **저장된 전사가 있으면 그대로 반환(외부 호출 0)** → 동시 호출 차단 →
/// 파일 읽기(상한) → 게이트·전사(transcribe_audio_inner) → 저장 → 알림.
pub async fn audio_transcribe_inner<T: AudioTransport>(
    state: &AppState,
    transport: &T,
    note_id: &str,
    attachment_id: &str,
) -> AppResult<AudioTranscript> {
    let row = load_audio_row(state, note_id, attachment_id)?;
    if let Some(done) = row.transcript.as_deref().filter(|t| !t.trim().is_empty()) {
        return Ok(AudioTranscript { text: done.to_string() });
    }
    let _guard = InFlightGuard::acquire(attachment_id)
        .ok_or_else(|| AppError::Conflict(format!("{ERR_IN_PROGRESS}: transcription already running")))?;

    // 게이트가 닫혀 있으면 파일을 읽기 전에 끊는다(오디오를 메모리에 올릴 이유가 없다) — 게이트 판정
    // 자체는 transcribe_audio_inner 가 한 번 더 한다(단일 관문, 여기는 조기 반환용 설정 읽기만).
    let creds = {
        let conn = state.db.lock();
        ai::read_ai_creds_from(&settings::get_all(&conn)?)
    };
    let (provider, endpoint) = ai::resolve_provider_and_endpoint(&creds.provider, creds.endpoint.clone())?;
    if !creds.ai_enabled || !ai::privacy_gate_ok(&provider, &endpoint, creds.ai_enabled) {
        return Err(AppError::Validation(ai::AUDIO_AI_REQUIRED.to_string()));
    }
    // 텍스트를 만들어 노트에 들이는 AI 라 번역·정리·생성과 같은 사다리(Refine)를 요구한다.
    // 저장된 전사를 돌려주는 위의 멱등 반환은 모델 호출이 아니라 이 검사 앞에 있다.
    crate::commands::ai::require_ai_policy_level(&state, crate::commands::ai::AiPolicyLevel::Refine)?;

    let (b64, mime) = read_audio_base64(state, &row)?;
    let result = ai::transcribe_audio_inner(
        b64,
        mime.to_string(),
        provider,
        endpoint,
        creds.api_key,
        creds.model,
        creds.ai_enabled,
        transport,
    )
    .await;
    let text = match result {
        Ok(t) if t.is_empty() => {
            crate::diag::warn("transcribe", "empty", "model returned an empty transcript");
            return Err(AppError::Io(format!("{ERR_EMPTY}: model returned no text")));
        }
        Ok(t) => t,
        Err(e) => {
            // 메시지에는 키·엔드포인트·경로·본문이 없다(post_chat 이 mask_secrets 를 거친다) — 종류만 남긴다.
            crate::diag::warn("transcribe", "failed", e.code());
            return Err(e);
        }
    };

    // 저장: 동시 경쟁(가드 밖 다른 프로세스 등)에서도 먼저 쓴 전사를 덮지 않는다(NULL 일 때만).
    let stored = {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE attachments SET transcript=?1, transcript_inserted=0 WHERE id=?2 AND transcript IS NULL",
            params![text, attachment_id],
        )
        .map_err(dberr)?;
        conn.query_row("SELECT transcript FROM attachments WHERE id=?1", [attachment_id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
        .map_err(dberr)?
        .flatten()
        .unwrap_or(text)
    };
    crate::events::publish(Some(note_id), false);
    Ok(AudioTranscript { text: stored })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn audio_transcribe(
    state: State<'_, AppState>,
    note_id: String,
    attachment_id: String,
) -> AppResult<AudioTranscript> {
    // 자격(provider/endpoint/api_key)은 **서버가 자기 DB 에서만** 읽는다 — 인자로 받지 않으므로 원격 호출자가
    // 엔드포인트를 바꿔 키를 빼돌릴 수 없다(sync_server 가 ai_* 접두 커맨드에만 거는 strip 과 무관하게 안전).
    let ctx = ai::call_log::CallCtx {
        op: Some("audio_transcribe".to_string()),
        caller: Some("audio_transcribe".to_string()),
        note_id: Some(note_id.clone()),
        request_id: None,
    };
    ai::call_log::with_call_ctx(
        ctx,
        audio_transcribe_inner(&state, &ai::RealAudioTransport, &note_id, &attachment_id),
    )
    .await
}

/// 전사 블록을 본문에 삽입한 뒤 클라이언트가 부른다 — 같은 전사의 중복 삽입을 막는 플래그만 올린다.
#[tauri::command(rename_all = "snake_case")]
pub fn attachment_transcript_mark_inserted(state: State<AppState>, attachment_id: String) -> AppResult<Okay> {
    let note_id: Option<String> = {
        let conn = state.db.lock();
        let found = conn
            .query_row(
                "SELECT note_id, transcript IS NOT NULL FROM attachments WHERE id=?1",
                [&attachment_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()
            .map_err(dberr)?;
        match found {
            None => return Err(AppError::NotFound(format!("attachment not found: {attachment_id}"))),
            Some((_, false)) => {
                return Err(AppError::Validation("attachment has no transcript to mark".to_string()))
            }
            Some((nid, true)) => {
                conn.execute("UPDATE attachments SET transcript_inserted=1 WHERE id=?1", [&attachment_id])
                    .map_err(dberr)?;
                Some(nid)
            }
        }
    };
    crate::events::publish(note_id.as_deref(), false);
    Ok(Okay { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::ai::{AudioTransport, Provider};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeAudio {
        calls: Arc<AtomicUsize>,
        reply: Result<String, ()>,
    }

    impl FakeAudio {
        fn ok(t: &str) -> Self {
            Self { calls: Arc::new(AtomicUsize::new(0)), reply: Ok(t.to_string()) }
        }
        fn failing() -> Self {
            Self { calls: Arc::new(AtomicUsize::new(0)), reply: Err(()) }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl AudioTransport for FakeAudio {
        async fn send_audio(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
            _audio_base64: String,
            _mime: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.reply.clone().map_err(|_| AppError::Io("provider down".to_string()))
        }
    }

    struct Fx {
        state: AppState,
        _dir: tempfile::TempDir,
        note_id: String,
        other_note_id: String,
        audio_id: String,
        other_audio_id: String,
        image_id: String,
    }

    /// 인메모리 DB + 실제 파일(첨부 저장소)을 갖춘 픽스처. ai_enabled/provider 는 호출 쪽이 정한다.
    fn fx(ai_enabled: bool, provider: &str) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        crate::db::migrations::seed(&mut conn).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        for id in ["n1", "n2"] {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES (?1, ?2, 't', 1000, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')",
                params![id, folder_id],
            )
            .unwrap();
        }
        let att_dir = crate::db::attachments_dir(dir.path());
        // IN_FLIGHT 는 프로세스 전역이라 병렬 테스트끼리 id 가 겹치면 서로를 "진행 중"으로 막는다.
        let uniq = crate::util::new_id();
        let ids = [
            (format!("a-audio-{uniq}"), "n1", "memo.m4a", "audio"),
            (format!("a-other-{uniq}"), "n2", "other.m4a", "audio"),
            (format!("a-image-{uniq}"), "n1", "p.png", "image"),
        ];
        for (id, note, file, kind) in ids.iter() {
            let rel = format!("{note}/{file}");
            let full = att_dir.join(&rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, b"fake-bytes").unwrap();
            conn.execute(
                "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 10, 0, '2026-10-06T00:00:00Z')",
                params![id, note, file, kind, rel],
            )
            .unwrap();
        }
        // ai_enabled 는 노트북 범위 키라 settings 표에 직접 넣으면 get_all 이 무시한다 — 실제 쓰기 경로로.
        let mut entries = std::collections::BTreeMap::new();
        entries.insert("ai_enabled".to_string(), serde_json::json!(ai_enabled));
        entries.insert("ai_provider".to_string(), serde_json::json!(provider));
        settings::set(&mut conn, &entries).unwrap();
        Fx {
            state: AppState::new(conn, dir.path().to_path_buf()),
            _dir: dir,
            note_id: "n1".into(),
            other_note_id: "n2".into(),
            audio_id: ids[0].0.clone(),
            other_audio_id: ids[1].0.clone(),
            image_id: ids[2].0.clone(),
        }
    }

    fn stored(f: &Fx, id: &str) -> (Option<String>, i64) {
        let conn = f.state.db.lock();
        conn.query_row("SELECT transcript, transcript_inserted FROM attachments WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap()
    }

    #[tokio::test]
    async fn success_saves_transcript_and_returns_trimmed_text() {
        let f = fx(true, "gemini");
        let t = FakeAudio::ok("  안녕하세요.  ");
        let out = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap();
        assert_eq!(out.text, "안녕하세요.");
        assert_eq!(stored(&f, &f.audio_id), (Some("안녕하세요.".to_string()), 0));
        assert_eq!(t.calls(), 1);
    }

    /// 음성 테스트: 멱등 가드(저장된 전사가 있으면 즉시 반환)를 빼면 두 번째 호출도 외부로 나가 실패한다.
    #[tokio::test]
    async fn second_call_returns_stored_transcript_with_zero_external_calls() {
        let f = fx(true, "gemini");
        let t = FakeAudio::ok("처음");
        audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap();
        let again = FakeAudio::ok("다른 결과");
        let out = audio_transcribe_inner(&f.state, &again, &f.note_id, &f.audio_id).await.unwrap();
        assert_eq!(out.text, "처음");
        assert_eq!(again.calls(), 0, "멱등: 두 번째 호출은 외부 호출 0");
    }

    #[tokio::test]
    async fn stored_transcript_is_returned_even_when_ai_is_off() {
        let f = fx(false, "gemini");
        f.state.db.lock().execute("UPDATE attachments SET transcript='있던 글' WHERE id=?1", [&f.audio_id]).unwrap();
        let t = FakeAudio::ok("x");
        let out = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap();
        assert_eq!(out.text, "있던 글");
        assert_eq!(t.calls(), 0);
    }

    /// 정책 사다리: gather 로 잠가 둔 사용자의 오디오는 첫 호출부터 외부로 나가지 않는다.
    #[tokio::test]
    async fn gather_policy_blocks_transcription_with_zero_external_calls() {
        let f = fx(true, "gemini");
        {
            let mut conn = f.state.db.lock();
            let mut e = std::collections::BTreeMap::new();
            e.insert("ai_policy_level".to_string(), serde_json::json!("gather"));
            settings::set(&mut conn, &e).unwrap();
        }
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "{err}");
        assert_eq!(t.calls(), 0);
        assert_eq!(stored(&f, &f.audio_id).0, None);
    }

    #[tokio::test]
    async fn gate_off_fails_with_stable_code_and_never_calls_transport() {
        let f = fx(false, "gemini");
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Validation(m) if m.starts_with("ai_required")), "{err}");
        assert_eq!(t.calls(), 0);
        assert_eq!(stored(&f, &f.audio_id).0, None);
    }

    #[tokio::test]
    async fn non_gemini_provider_is_unsupported_without_calling_transport() {
        let f = fx(true, "openai");
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Validation(m) if m.starts_with("audio_unsupported_provider")), "{err}");
        assert_eq!(t.calls(), 0);
    }

    /// 음성 테스트: 노트 일치 검사를 빼면 다른 노트의 첨부가 전사된다.
    #[tokio::test]
    async fn attachment_of_another_note_is_rejected() {
        let f = fx(true, "gemini");
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.other_audio_id).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = audio_transcribe_inner(&f.state, &t, &f.other_note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls(), 0);
        assert_eq!(stored(&f, &f.other_audio_id).0, None);
    }

    #[tokio::test]
    async fn non_audio_and_missing_attachments_are_rejected() {
        let f = fx(true, "gemini");
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.image_id).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, "nope").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert_eq!(t.calls(), 0);
    }

    #[tokio::test]
    async fn provider_failure_stores_nothing_and_a_retry_can_succeed() {
        let f = fx(true, "gemini");
        let broken = FakeAudio::failing();
        let err = audio_transcribe_inner(&f.state, &broken, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(broken.calls(), 1);
        assert_eq!(stored(&f, &f.audio_id).0, None, "실패는 저장하지 않는다");
        // 실패 뒤에도 진행 중 표시가 남지 않아 재시도가 된다.
        let ok = FakeAudio::ok("됐다");
        let out = audio_transcribe_inner(&f.state, &ok, &f.note_id, &f.audio_id).await.unwrap();
        assert_eq!(out.text, "됐다");
    }

    #[tokio::test]
    async fn empty_model_output_is_an_error_and_not_stored() {
        let f = fx(true, "gemini");
        let t = FakeAudio::ok("   ");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Io(m) if m.starts_with("transcribe_empty")), "{err}");
        assert_eq!(stored(&f, &f.audio_id).0, None);
    }

    #[tokio::test]
    async fn oversized_file_is_rejected_before_any_external_call() {
        let f = fx(true, "gemini");
        let path = crate::db::attachments_dir(&f.state.data_dir).join("n1/memo.m4a");
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(AUDIO_INLINE_MAX_BYTES + 1).unwrap();
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Validation(m) if m.starts_with("audio_too_large")), "{err}");
        assert_eq!(t.calls(), 0);
    }

    #[tokio::test]
    async fn concurrent_call_for_the_same_attachment_is_refused() {
        let f = fx(true, "gemini");
        let _held = InFlightGuard::acquire(&f.audio_id).unwrap();
        let t = FakeAudio::ok("x");
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Conflict(m) if m.starts_with("transcribe_in_progress")), "{err}");
        assert_eq!(t.calls(), 0);
    }

    #[test]
    fn audio_mime_covers_recorder_formats_and_rejects_unknown() {
        assert_eq!(audio_mime("M4A"), Some("audio/mp4"));
        assert_eq!(audio_mime("webm"), Some("audio/webm"));
        assert_eq!(audio_mime("pdf"), None);
    }

    #[tokio::test]
    async fn truncated_transcript_is_an_error_and_not_stored() {
        let f = fx(true, "gemini");
        struct TruncatedAudio;
        impl AudioTransport for TruncatedAudio {
            async fn send_audio(
                &self,
                _provider: Provider,
                _endpoint: String,
                _api_key: Option<String>,
                _model_opt: Option<String>,
                _system_prompt: String,
                _user_text: String,
                _audio_base64: String,
                _mime: String,
            ) -> AppResult<String> {
                Err(AppError::Validation("AI response was truncated (exceeded maximum output tokens)".to_string()))
            }
        }
        let t = TruncatedAudio;
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Validation(m) if m.contains("truncated")), "{err}");
        assert_eq!(stored(&f, &f.audio_id).0, None, "잘린 전사는 DB에 절대 저장되지 않아야 한다");
    }

    #[tokio::test]
    async fn client_timeout_transcript_is_an_error_and_not_stored() {
        let f = fx(true, "gemini");
        struct TimeoutAudio;
        impl AudioTransport for TimeoutAudio {
            async fn send_audio(
                &self,
                _provider: Provider,
                _endpoint: String,
                _api_key: Option<String>,
                _model_opt: Option<String>,
                _system_prompt: String,
                _user_text: String,
                _audio_base64: String,
                _mime: String,
            ) -> AppResult<String> {
                Err(AppError::Io("request timed out: client timeout".to_string()))
            }
        }
        let t = TimeoutAudio;
        let err = audio_transcribe_inner(&f.state, &t, &f.note_id, &f.audio_id).await.unwrap_err();
        assert!(matches!(&err, AppError::Io(m) if m.contains("timed out")), "{err}");
        assert_eq!(stored(&f, &f.audio_id).0, None, "타임아웃 시 DB에 저장되지 않아야 한다");
    }
}
