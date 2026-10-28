// 커맨드: pet (commands/pet.yaml) — 얇은 배선만. 대화 로직·프롬프트·영속은 repo::pet,
// HTTP 왕복은 repo::ai::TextTransport / VisionTransport 그대로.
//
// 락 수명 규칙: DB 락(parking_lot Mutex)을 await 너머로 들고 가지 않는다 —
// (1) 락 안에서 설정·히스토리·RAG 를 모아 오고 → 락 해제 → (2) 프로바이더 호출(await) →
// (3) 다시 락 잡고 액션 실행 + 턴 저장. ai_* 커맨드가 쓰는 것과 같은 패턴이다.
use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::repo::ai::{self, TextTransport, VisionTransport};
use crate::repo::pet::{self, PetChatResult, PetMessage, PetNotification};
use crate::repo::{folders, settings};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 펫 대화가 쓰는 설정 묶음 — 한 번의 락으로 전부 읽는다(commands::ai::ai_gate_and_key 와 같은 취지).
struct PetAiConfig {
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    persona_preset: String,
    persona_prompt: String,
    user_name: String,
    chat_memory: Vec<String>,
    chat_read_history: bool,
    chat_read_files: bool,
}

fn read_pet_config(conn: &rusqlite::Connection) -> AppResult<PetAiConfig> {
    // 설정 조회 오류는 ai::read_ai_creds 와 달리 여기서 전파한다(커맨드 계약).
    let s = settings::get_all(conn)?;
    let creds = ai::read_ai_creds_from(&s);
    let str_of = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let user_name = str_of("user_name");
    let chat_memory = s
        .get("chat_memory")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| entry.as_object()?.get("text")?.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(PetAiConfig {
        provider: creds.provider,
        endpoint: creds.endpoint,
        api_key: creds.api_key,
        model: creds.model,
        ai_enabled: creds.ai_enabled,
        persona_preset: {
            let p = str_of("pet_persona_preset");
            if p.is_empty() { "secretary".to_string() } else { p }
        },
        persona_prompt: str_of("pet_persona_prompt"),
        user_name,
        chat_memory,
        chat_read_history: s.get("chat_read_history").and_then(|v| v.as_bool()).unwrap_or(true),
        chat_read_files: s.get("chat_read_files").and_then(|v| v.as_bool()).unwrap_or(true),
    })
}

/// 비서/펫 노트 쓰기 게이트. 키 없음 = true (현재 fail-open). 클라 allow_write 와 AND.
fn chat_write_enabled(s: &std::collections::BTreeMap<String, serde_json::Value>) -> bool {
    s.get("chat_write_enabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// 이미지가 있으면 비전을 한 번 시도하고, 모델/프로바이더가 거절하면 텍스트로 강등한다.
/// 채팅을 이미지 때문에 끊지 않는 것이 목적 — 실패 이유는 vision_status 로 남긴다.
pub(crate) async fn send_pet_prompt<T: TextTransport, V: VisionTransport>(
    text: &T,
    vision: &V,
    provider: ai::Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    system_prompt: String,
    user_text: String,
    image: Option<(String, String)>,
) -> AppResult<(String, Option<String>)> {
    if let Some((image_base64, mime)) = image {
        let with_image = format!(
            "{user_text}\n\n[첨부 이미지] 이번 메시지에 이미지 1장이 붙어 있다. 이미지 내용도 참고해서 답한다."
        );
        match vision
            .send_vision(
                provider.clone(),
                endpoint.clone(),
                api_key.clone(),
                model.clone(),
                system_prompt.clone(),
                with_image,
                image_base64,
                mime,
            )
            .await
        {
            Ok(raw) => return Ok((raw, Some("used".to_string()))),
            Err(_) => {
                let fallback = format!(
                    "{user_text}\n\n[첨부 이미지] 이미지가 첨부됐지만 이 모델은 이미지를 읽지 못한다. 텍스트만으로 답한다."
                );
                let raw = text
                    .send_text(provider, endpoint, api_key, model, system_prompt, fallback)
                    .await?;
                return Ok((raw, Some("fallback_text".to_string())));
            }
        }
    }
    let raw = text
        .send_text(provider, endpoint, api_key, model, system_prompt, user_text)
        .await?;
    Ok((raw, None))
}

/// (1b) 질문 검색 RAG + 오늘 일정 + 프롬프트 합성 — 읽기만 한다(`AppState::with_read` 로 부른다).
/// 세 번째 값은 시스템 프롬프트에 **실제로 넣은** 근거 노트다 — `show_evidence` 턴이면 그대로
/// 카드(`result.hits`)가 된다(다시 검색하지 않는다). `chat_read_files` 가 꺼져 있으면 늘 비어 있다.
fn compose_chat_prompts(
    conn: &rusqlite::Connection,
    cfg: &PetAiConfig,
    workspace_id: &str,
    message: &str,
    active_note: Option<&pet::ActiveNoteContext>,
    history: &[pet::PetMessage],
) -> (String, String, Vec<pet::PetSearchHit>) {
    let empty_hits = Vec::new();
    let hits = if cfg.chat_read_files {
        pet::rag_hits(conn, workspace_id, pet::rag_query(message), 4)
    } else {
        empty_hits
    };
    let effective_active_note = if cfg.chat_read_files {
        active_note
    } else {
        None
    };
    let (ty, tm, td) = crate::util::today_ymd_local();
    let due = if cfg.chat_read_files {
        let today = crate::repo::dashboard::dateord::NaiveYmd { y: ty, m: tm as u32, d: td as u32 };
        // rag_hits 와 같은 자세 — 일정 조회 실패가 대화 전체를 막으면 안 된다. 이 기능이
        // 붙기 전엔 pet_chat 이 스케줄 테이블을 전혀 안 봤으므로, 여기서 `?` 로 전파하면
        // DB 사정으로 이 조회만 실패해도 챗 자체가 죽는 회귀가 된다.
        match crate::repo::schedule::due_today(conn, workspace_id, today) {
            Ok(items) => items,
            Err(e) => {
                crate::diag::warn("pet", "due_today_failed", format!("{e}"));
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let persona = pet::persona_prompt(&cfg.persona_preset, &cfg.persona_prompt);
    let system_prompt = pet::compose_system_prompt(
        &persona,
        &hits,
        effective_active_note,
        Some(&cfg.user_name),
        &cfg.chat_memory,
        (ty, tm, td),
        &due,
    );
    (system_prompt, pet::compose_user_text(history, message), hits)
}

/// `show_evidence` 를 받기 전의 시그니처 — 근거 카드 없이 한 턴(`show_evidence = false`).
/// 통합 테스트(`tests/automation_corpus.rs`)가 이 모양으로 부른다.
pub async fn pet_chat_inner<T: TextTransport, V: VisionTransport>(
    message: String,
    display_text: Option<String>,
    active_note_id: Option<String>,
    active_note_title: Option<String>,
    active_note_excerpt: Option<String>,
    image_base64: Option<String>,
    image_mime: Option<String>,
    allow_write: bool,
    state: &AppState,
    text: &T,
    vision: &V,
) -> AppResult<PetChatResult> {
    pet_chat_turn(
        message,
        display_text,
        active_note_id,
        active_note_title,
        active_note_excerpt,
        image_base64,
        image_mime,
        allow_write,
        false,
        None,
        state,
        text,
        vision,
    )
    .await
}

/// 한 턴. `show_evidence` 면 `answer` 응답에 프롬프트에 넣은 근거 노트를 `hits` 로 실어 보낸다 —
/// 카드가 "모델이 실제로 본 근거"가 되고, 어시스턴트 행 meta 로 저장돼 다시 열어도 남는다.
pub async fn pet_chat_turn<T: TextTransport, V: VisionTransport>(
    message: String,
    display_text: Option<String>,
    active_note_id: Option<String>,
    active_note_title: Option<String>,
    active_note_excerpt: Option<String>,
    image_base64: Option<String>,
    image_mime: Option<String>,
    allow_write: bool,
    show_evidence: bool,
    fail_text: Option<String>,
    state: &AppState,
    text: &T,
    vision: &V,
) -> AppResult<PetChatResult> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::Validation("pet message is empty".to_string()));
    }
    let message: String = message.chars().take(pet::PET_MESSAGE_CHAR_CAP).collect();
    let active_note = pet::ActiveNoteContext::from_parts(
        active_note_id,
        active_note_title,
        active_note_excerpt,
    );
    let (prepared_image, image_prep_failed) = match image_base64.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match pet::prepare_chat_vision_image(
            raw,
            image_mime.as_deref().unwrap_or(""),
        ) {
            Ok(img) => (Some(img), false),
            Err(_) => (None, true),
        },
        _ => (None, false),
    };

    // (1a) 락 안: 설정 + 히스토리 + **사용자 행 저장** + 프로바이더 해석 + 프라이버시 게이트.
    // session_id: 이 턴이 **시작한** 세션. 응답 대기 중에 새 세션이 열려도(트레이·펫 "새 세션 열기",
    // 사이드바 "새 세션", 폰의 세션 열기·전환) 답은 여기로 간다 — 완료 시점의 라이브가 아니다.
    // 사용자 행을 시작 시점에 쓰므로 그 세션은 더는 비어 있지 않다: 새 세션 열기는 그것을 보관하고,
    // 폰의 세션 열기(open_session)는 "빈 라이브 버리기"에 걸지 않는다. 히스토리는 저장 **전에** 읽는다
    // (이번 메시지가 프롬프트에 두 번 들어가지 않게).
    let (workspace_id, session_id, user_created_at, cfg, history, resolved) = {
        let conn = state.db.lock();
        let cfg = read_pet_config(&conn)?;
        let workspace_id = pet::active_workspace(&conn)?;
        let session_id = pet::ensure_live_session(&conn, &workspace_id)?;
        let history = if cfg.chat_read_history {
            pet::recent_messages(&conn, &workspace_id, pet::PET_CONTEXT_TURNS)?
        } else {
            Vec::new()
        };
        let user_meta = pet::user_message_meta(display_text.as_deref());
        let user = pet::append_message_to(
            &conn,
            &workspace_id,
            &session_id,
            "user",
            &message,
            user_meta.as_deref(),
        )?;
        // ai_* 커맨드와 같은 판정 — 로컬 ollama 는 동의 없이도, 그 외는 ai_enabled 필수.
        // 거부도 실패 행으로 남긴다(아래 outcome) — 사용자 행은 이미 있다.
        let resolved = ai::resolve_provider_and_endpoint(&cfg.provider, cfg.endpoint.clone())
            .and_then(|(provider, endpoint)| {
                if ai::privacy_gate_ok(&provider, &endpoint, cfg.ai_enabled) {
                    Ok((provider, endpoint))
                } else {
                    Err(AppError::Validation(
                        "cloud AI requires ai_enabled (Settings > AI)".to_string(),
                    ))
                }
            });
        (workspace_id, session_id, user.created_at, cfg, history, resolved)
    };
    // 다른 창(펫 말풍선·폰)이 대기 중에도 질문을 본다. 보낸 창은 대기 중이라 이 이벤트를 무시한다.
    emit_pet_chat_updated("append");

    let outcome: AppResult<PetChatResult> = async {
        let (provider, endpoint) = resolved?;

        // (1b) 쓰기 락 밖(읽기 연결): 질문 검색 RAG + 오늘 일정 + 프롬프트 합성. 질문 검색은 10만 노트에서
        // 수백 ms 걸릴 수 있어, 전역 `db` 잠금을 쥐면 그동안 자동 저장·다른 커맨드가 멈춘다. 읽기 연결은
        // 마지막으로 커밋된 상태를 본다 — 예전에 잠금 안에서 읽던 것과 같은 신선도. 읽기 연결이 없으면
        // (테스트·인메모리 DB) `with_read` 가 `db` 로 폴백한다.
        let (system_prompt, user_text, rag_hits) = state.with_read(|conn| {
            compose_chat_prompts(conn, &cfg, &workspace_id, &message, active_note.as_ref(), &history)
        });

        // (2) 락 밖: 프로바이더 왕복 1회(스트리밍/도구 라운드트립 없음). 이미지가 있고 비전을
        // 쓸 수 없으면 텍스트로 강등한다 — 채팅을 끊지 않는다.
        let (raw, mut vision_status) = send_pet_prompt(
            text,
            vision,
            provider,
            endpoint,
            cfg.api_key,
            cfg.model,
            system_prompt,
            user_text,
            prepared_image,
        )
        .await?;
        if image_prep_failed && vision_status.is_none() {
            vision_status = Some("fallback_text".to_string());
        }
        let action = pet::parse_action(&raw);

        // (3a) 쓰기 락 밖: `search` 액션의 근거 노트 검색 — (1b)와 같은 이유·같은 읽기 연결.
        let search_hits = state.with_read(|conn| pet::action_search_hits(conn, &workspace_id, &action));

        // (3) 다시 락: 액션 실행 + 턴 저장. 이미지 바이트는 넣지 않는다.
        // 쓰기 게이트는 이 락의 설정 값을 클라 플래그와 AND — 저장된 false 는 클라가 못 덮는다
        // (사이드바·펫 창·HTTP 가 같은 pet_chat_turn 을 탐).
        let mut conn = state.db.lock();
        let stored_write = chat_write_enabled(&settings::get_all(&conn)?);
        let mut result = pet::execute_action_prepared(
            &mut conn,
            &workspace_id,
            &action,
            &cfg.persona_preset,
            pet::ExecuteActionOpts {
                allow_write: allow_write && stored_write,
                has_active_note: active_note.is_some(),
            },
            search_hits,
        )?;
        result.vision_status = vision_status;
        // 근거 카드: 프롬프트에 넣은 그 노트들(rag_hits)을 그대로. `search` 액션은 자기 hits 를 이미
        // 채웠고, `chat_read_files` 가 꺼져 있으면 rag_hits 가 비어 있다 — 그래도 조건에 명시해 둔다.
        if show_evidence && cfg.chat_read_files && result.action == "answer" && !rag_hits.is_empty() {
            result.hits = rag_hits;
        }
        let assistant_meta = pet::assistant_message_meta(&result);
        result.user_created_at = Some(user_created_at.clone());
        // 시작 세션이 그새 사라졌으면 그건 대화 지우기(사용자가 직접 지움) 또는 보관 상한 정리다 —
        // 사용자 행이 있어 open_session 의 "빈 라이브 버리기"엔 걸리지 않는다. 지운 대화를 되살리거나
        // 지금 라이브(엉뚱한 대화)에 섞지 않고 답만 돌려준다.
        if pet::session_exists(&conn, &workspace_id, &session_id)? {
            let assistant = pet::append_message_to(
                &conn,
                &workspace_id,
                &session_id,
                "assistant",
                &result.reply,
                assistant_meta.as_deref(),
            )?;
            result.assistant_created_at = Some(assistant.created_at);
        } else {
            crate::diag::warn("pet", "chat_session_gone", String::new());
        }
        drop(conn);

        if let Some(ref note_id) = result.note_id {
            crate::events::publish(Some(note_id), true);
        }
        Ok(result)
    }
    .await;

    // 실패 기록은 여기 한 곳(예전 프런트 pet_chat_record_failure 를 흡수) — 사용자 행은 이미 있으므로
    // 실패 표시 어시스턴트 행만, 시작 세션에. 세션이 사라졌으면 위와 같은 이유로 남기지 않는다.
    if outcome.is_err() {
        let fail: String = fail_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(PET_FAIL_TEXT_FALLBACK)
            .chars()
            .take(pet::PET_MESSAGE_CHAR_CAP)
            .collect();
        let conn = state.db.lock();
        let recorded = pet::session_exists(&conn, &workspace_id, &session_id).and_then(|exists| {
            if !exists {
                crate::diag::warn("pet", "chat_session_gone", "failure".to_string());
                return Ok(());
            }
            let meta = pet::failed_assistant_meta();
            pet::append_message_to(&conn, &workspace_id, &session_id, "assistant", &fail, Some(&meta))
                .map(|_| ())
        });
        if let Err(e) = recorded {
            crate::diag::warn("pet", "chat_failure_record_failed", format!("{}", e.code()));
        }
    }
    outcome
}

/// 클라가 실패 문구(`fail_text`)를 안 보냈을 때만 — 데스크톱·폰·말풍선은 모두 i18n 문구를 보낸다.
const PET_FAIL_TEXT_FALLBACK: &str = "(no reply)";

const PET_CHAT_UPDATED_EVENT: &str = "pet-chat-updated";

/// 전역 이벤트 버스(crate::events)로 낸다 — AppHandle 인자를 받지 않는다. 폰(/api/v1/invoke →
/// dispatch.gen.rs)은 제네릭 런타임 AppHandle<R> 만 들고 있어 Wry 전용 `tauri::AppHandle` 파라미터를
/// 받는 커맨드를 부를 수 없고(2026-10-06 채팅 원격 개방), 버스는 데스크톱 웹뷰 emit 과 SSE 를
/// 한 번에 처리한다. mock 런타임 테스트에선 APP 핸들이 없어 SSE 버스로만 나간다(패닉 없음).
fn emit_pet_chat_updated(reason: &str) {
    crate::events::publish_event(PET_CHAT_UPDATED_EVENT, serde_json::json!({ "reason": reason }));
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pet_chat(
    message: String,
    active_note_id: Option<String>,
    active_note_title: Option<String>,
    active_note_excerpt: Option<String>,
    image_base64: Option<String>,
    image_mime: Option<String>,
    display_text: Option<String>,
    allow_write: Option<bool>,
    show_evidence: Option<bool>,
    fail_text: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetChatResult> {
    let fallback = crate::commands::ai::fallback_model_setting(&state);
    // I5(WI 잔여 항목): 이 배경 경로도 이제 call_log 호출 컨텍스트를 채운다 — 아래 어디에도
    // tokio::spawn 이 없어(pet_chat_turn → send_pet_prompt → transport 호출까지 같은 태스크) ai_*
    // 커맨드들과 같은 방식으로 감쌀 수 있다. op 는 "chat"(commands/ai.rs의 organize/translate 류와
    // 구분) — 이미지가 실려 vision 으로 강등되는 경우까지 포함해 이 커맨드 자체는 "채팅" 행동이다.
    let ctx = ai::call_log::CallCtx {
        op: Some("chat".to_string()),
        caller: Some("pet_chat".to_string()),
        note_id: active_note_id.clone(),
        request_id: None,
    };
    let result = ai::call_log::with_call_ctx(
        ctx,
        pet_chat_turn(
            message,
            display_text,
            active_note_id,
            active_note_title,
            active_note_excerpt,
            image_base64,
            image_mime,
            allow_write.unwrap_or(true),
            show_evidence.unwrap_or(false),
            fail_text,
            &state,
            // 폴백 모델은 ai_* 커맨드와 같은 경로로 읽는다(commands::ai) — 펫만 다른 규칙을 갖지 않는다.
            &ai::RealTextTransport::new(fallback.clone()),
            &ai::RealVisionTransport::new(fallback),
        ),
    )
    .await;
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            // 폰(원격) 채팅은 콘솔이 없어 실패 원인을 볼 곳이 진단 싱크뿐이다. code(VALIDATION=프라이버시
            // 게이트·빈 입력, IO=프로바이더/네트워크/타임아웃)와 프로바이더가 준 상태 문구만 남긴다 —
            // 노트 본문·프롬프트는 이 메시지에 들어가지 않는다(앞 160자로 캡).
            let msg: String = e.to_string().chars().take(160).collect();
            crate::diag::warn("pet", "chat_failed", format!("{}: {msg}", e.code()));
            // pet_chat_turn 이 실패 행을 시작 세션에 남겼다 — 다른 창도 다시 읽게.
            emit_pet_chat_updated("append");
            return Err(e);
        }
    };
    emit_pet_chat_updated("append");
    Ok(result)
}

#[derive(Serialize)]
pub struct PetChatHistoryResult {
    pub messages: Vec<PetMessage>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_chat_history(
    limit: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetChatHistoryResult> {
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let messages = pet::recent_messages(&conn, &ws, limit.unwrap_or(30).min(200))?;
    Ok(PetChatHistoryResult { messages })
}

#[derive(Serialize)]
pub struct PetChatClearResult {
    pub cleared: usize,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_chat_clear(
    state: tauri::State<'_, AppState>,
) -> AppResult<PetChatClearResult> {
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let cleared = pet::clear_messages(&conn, &ws)?;
    drop(conn);
    emit_pet_chat_updated("clear");
    Ok(PetChatClearResult { cleared })
}

// ── 세션 보관·불러오기 (사이드바 도구 메뉴). 펫 창 allowlist 밖. ──

#[derive(Serialize)]
pub struct PetSessionListResult {
    pub sessions: Vec<pet::PetSessionSummary>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_session_list(state: tauri::State<'_, AppState>) -> AppResult<PetSessionListResult> {
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let sessions = pet::list_sessions(&conn, &ws)?;
    Ok(PetSessionListResult { sessions })
}

#[derive(Serialize)]
pub struct PetSessionNewResult {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_id: Option<String>,
    pub messages: Vec<PetMessage>,
}

/// 사이드바 챗 도구 메뉴 "새 세션"과 트레이/펫 메뉴 "새 세션 열기"(tray.rs)가 같이 부른다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_session_new(
    state: tauri::State<'_, AppState>,
) -> AppResult<PetSessionNewResult> {
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let (session_id, archived_id) = pet::new_session(&conn, &ws)?;
    drop(conn);
    emit_pet_chat_updated("session");
    Ok(PetSessionNewResult {
        session_id,
        archived_id,
        messages: Vec::new(),
    })
}

#[derive(Serialize)]
pub struct PetSessionOpenResult {
    pub session_id: String,
    pub messages: Vec<PetMessage>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_session_open(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetSessionOpenResult> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(AppError::Validation("session_id is empty".to_string()));
    }
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let session_id = pet::open_session(&conn, &ws, &session_id)?;
    let messages = pet::recent_messages(&conn, &ws, 200)?;
    drop(conn);
    emit_pet_chat_updated("session");
    Ok(PetSessionOpenResult {
        session_id,
        messages,
    })
}

// ── T3 rewind / delete (사이드바 버블 툴바). pet_chat 인자(T4)와 별개 표면. ──

#[derive(Serialize)]
pub struct PetChatRewindResult {
    pub truncated: usize,
    pub messages: Vec<PetMessage>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_chat_rewind(
    created_at: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetChatRewindResult> {
    let created_at = created_at.trim().to_string();
    if created_at.is_empty() {
        return Err(AppError::Validation("created_at is empty".to_string()));
    }
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let truncated = pet::rewind_messages(&conn, &ws, &created_at)?;
    let messages = pet::recent_messages(&conn, &ws, 200)?;
    drop(conn);
    emit_pet_chat_updated("rewind");
    Ok(PetChatRewindResult {
        truncated,
        messages,
    })
}

#[derive(Serialize)]
pub struct PetChatDeleteResult {
    pub deleted: usize,
    pub messages: Vec<PetMessage>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_chat_delete(
    created_at: String,
    role: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetChatDeleteResult> {
    let created_at = created_at.trim().to_string();
    if created_at.is_empty() {
        return Err(AppError::Validation("created_at is empty".to_string()));
    }
    if role != "user" && role != "assistant" {
        return Err(AppError::Validation(
            "role must be user or assistant".to_string(),
        ));
    }
    let conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let deleted = pet::delete_message_turn(&conn, &ws, &created_at, &role)?;
    let messages = pet::recent_messages(&conn, &ws, 200)?;
    drop(conn);
    emit_pet_chat_updated("delete");
    Ok(PetChatDeleteResult { deleted, messages })
}

/// 사이드바 챗 드롭 — 첨부 테이블에 쓰지 않고 미리보기/추출만. 추출기는
/// repo::extraction::extract_markdown 을 감싼다.
const CHAT_ATTACH_EXCERPT_CHARS: usize = 4000;

#[derive(Debug, Serialize)]
pub struct PetChatReadAttachResult {
    pub kind: String,
    pub name: String,
    pub mime: Option<String>,
    pub base64: Option<String>,
    pub excerpt: Option<String>,
}

fn chat_image_mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn chat_attach_name(path: &std::path::Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

fn chat_attach_ext(path: &std::path::Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_chat_read_attach(path: String) -> AppResult<PetChatReadAttachResult> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(AppError::Validation("file not found".to_string()));
    }
    let name = chat_attach_name(p);
    let ext = chat_attach_ext(p);

    if let Some(mime) = chat_image_mime_for_ext(&ext) {
        let bytes = std::fs::read(p).map_err(crate::error::io)?;
        if bytes.is_empty() {
            return Err(AppError::Validation("image is empty".to_string()));
        }
        if bytes.len() > pet::PET_CHAT_IMAGE_BYTES_CAP {
            return Err(AppError::Validation("chat image exceeds 8MB".to_string()));
        }
        use base64::Engine as _;
        return Ok(PetChatReadAttachResult {
            kind: "image".into(),
            name,
            mime: Some(mime.into()),
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            excerpt: None,
        });
    }

    if matches!(ext.as_str(), "pdf" | "docx" | "txt" | "md" | "pptx") {
        // 어차피 CHAT_ATTACH_EXCERPT_CHARS 로 다시 줄이는 발췌라 1MB 절단 여부는 의미가 없다.
        let excerpt = crate::repo::extraction::extract_markdown(&path)
            .ok()
            .map(|(s, _truncated)| s.chars().take(CHAT_ATTACH_EXCERPT_CHARS).collect());
        return Ok(PetChatReadAttachResult {
            kind: "doc".into(),
            name,
            mime: None,
            base64: None,
            excerpt,
        });
    }

    Ok(PetChatReadAttachResult {
        kind: "file".into(),
        name,
        mime: None,
        base64: None,
        excerpt: None,
    })
}

#[derive(Serialize)]
pub struct PetNoteCreateResult {
    pub note_id: String,
    pub title: String,
}

/// AI 를 타지 않는 직접 저장("메모로 저장" 버튼 · 받아쓰기 메모) — 오프라인에서도 동작한다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_note_create(
    text: String,
    title: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetNoteCreateResult> {
    let mut conn = state.db.lock();
    let ws = pet::active_workspace(&conn)?;
    let (note_id, title) = pet::create_inbox_note(&mut conn, &ws, None, title.as_deref(), &text)?;
    drop(conn);
    crate::events::publish(Some(&note_id), true);
    Ok(PetNoteCreateResult { note_id, title })
}

#[derive(Debug, Clone, Serialize)]
pub struct PetConversationSaveResult {
    pub note_id: String,
    pub title: String,
}

/// 대화 저장 전용 입력 경계. `PetMessage`는 history 응답에도 쓰이는 공개 모델이라 그대로
/// 커맨드 입력으로 재사용하면 알 수 없는 필드가 조용히 섞인다. 로컬 창이라도 IPC 경계에서는
/// 입력 shape를 고정하고, 저장 직전에 role/text/timestamp를 검증한다.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PetConversationMessageInput {
    role: String,
    text: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct PetConversationSummaryEnvelope {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    summary: String,
}

/// 모델 응답은 구조화 JSON을 우선 사용하되, 작은 로컬 모델이 평문을 반환해도 내용을 버리지
/// 않는다. 빈 응답만 저장 전에 거부한다.
fn parse_conversation_summary(raw: &str) -> AppResult<(Option<String>, String)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::Validation("AI conversation summary is empty".to_string()));
    }
    if let Ok(parsed) = ai::extract_json::<PetConversationSummaryEnvelope>(raw) {
        let summary = parsed.summary.trim();
        if summary.is_empty() {
            return Err(AppError::Validation("AI conversation summary is empty".to_string()));
        }
        if summary.chars().count() > pet::PET_CONVERSATION_SUMMARY_CHAR_CAP {
            return Err(AppError::Validation(format!(
                "AI conversation summary exceeds {} characters",
                pet::PET_CONVERSATION_SUMMARY_CHAR_CAP
            )));
        }
        return Ok((
            parsed
                .title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            summary.to_string(),
        ));
    }
    if raw.chars().count() > pet::PET_CONVERSATION_SUMMARY_CHAR_CAP {
        return Err(AppError::Validation(format!(
            "AI conversation summary exceeds {} characters",
            pet::PET_CONVERSATION_SUMMARY_CHAR_CAP
        )));
    }
    Ok((None, raw.to_string()))
}

/// 대화 종료 후 호출하는 저장 경로. AI 요약이 성공한 뒤에만 노트 저장을 시작하므로, provider
/// 오류나 빈 응답으로 반쪽짜리 노트가 생기지 않는다. DB 락은 provider 왕복을 가로질러 잡지 않는다.
pub async fn pet_conversation_save_inner<T: TextTransport>(
    messages: Vec<PetMessage>,
    title: Option<String>,
    state: &AppState,
    transport: &T,
) -> AppResult<PetConversationSaveResult> {
    let summary_prompt = pet::conversation_summary_prompt(&messages)?;
    let (workspace_id, cfg, provider, endpoint) = {
        let conn = state.db.lock();
        let cfg = read_pet_config(&conn)?;
        let (provider, endpoint) = ai::resolve_provider_and_endpoint(&cfg.provider, cfg.endpoint.clone())?;
        if !ai::privacy_gate_ok(&provider, &endpoint, cfg.ai_enabled) {
            return Err(AppError::Validation(
                "cloud AI requires ai_enabled (Settings > AI)".to_string(),
            ));
        }
        let workspace_id = pet::active_workspace(&conn)?;
        (workspace_id, cfg, provider, endpoint)
    };

    let raw_summary = transport
        .send_text(
            provider,
            endpoint,
            cfg.api_key,
            cfg.model,
            pet::PET_CONVERSATION_SUMMARY_SYSTEM_PROMPT.to_string(),
            summary_prompt.clone(),
        )
        .await?;
    let (ai_title, summary) = parse_conversation_summary(&raw_summary)?;
    let title = title
        .or(ai_title)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut conn = state.db.lock();
    // 원문은 <untrusted_data>로 감싼 prompt라 history에는 저장하지 않는다. 노트와 감사 로그는
    // 같은 커밋 직전 hook에서 기록되므로 감사 로그 실패도 빈 노트를 남기지 않는다.
    let history_input = ai::summarize_prompt_for_history(&summary_prompt);
    let (note_id, title) = pet::save_conversation_with_history(
        &mut conn,
        &workspace_id,
        title.as_deref(),
        &messages,
        &summary,
        Some(&history_input),
    )?;
    drop(conn);
    crate::events::publish(Some(&note_id), true);
    Ok(PetConversationSaveResult { note_id, title })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pet_conversation_save(
    messages: Vec<PetConversationMessageInput>,
    title: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetConversationSaveResult> {
    let messages = messages
        .into_iter()
        .map(|message| PetMessage {
            role: message.role,
            text: message.text,
            created_at: message.created_at,
            meta: None,
        })
        .collect();
    let ctx = ai::call_log::CallCtx {
        op: Some("chat".to_string()),
        caller: Some("pet_conversation_save".to_string()),
        note_id: None,
        request_id: None,
    };
    ai::call_log::with_call_ctx(
        ctx,
        pet_conversation_save_inner(
            messages,
            title,
            &state,
            &ai::RealTextTransport::new(crate::commands::ai::fallback_model_setting(&state)),
        ),
    )
    .await
}

#[derive(Serialize)]
pub struct PetNotificationsResult {
    pub items: Vec<PetNotification>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_notifications(state: tauri::State<'_, AppState>) -> AppResult<PetNotificationsResult> {
    let conn = state.db.lock();
    let s = settings::get_all(&conn)?;
    let preset = s
        .get("pet_persona_preset")
        .and_then(|v| v.as_str())
        .unwrap_or("secretary")
        .to_string();
    let backup_pending = s
        .get("backup_nudge_pending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let ws = pet::active_workspace(&conn)?;
    Ok(PetNotificationsResult {
        items: pet::notifications(&conn, &ws, &preset, backup_pending)?,
    })
}

#[derive(Serialize)]
pub struct PetOpenMainResult {
    pub ok: bool,
}

// ── async 인 이유 (AppHangB1, 2026-08-05) ────────────────────────────────────
// Windows 에서 웹뷰 창을 **동기 커맨드 안에서** 만들거나 조작하면 메인(UI) 스레드가 데드락한다
// (wry #583 — Tauri 문서가 "창을 만드는 커맨드는 async 로"라고 명시). 동기 커맨드는 WebView2
// 의 IPC 콜백, 즉 UI 스레드에서 인라인 실행되는데, 창 생성/getter 는 이벤트 루프 디스패치를
// 기다리므로 자기 자신을 기다리는 꼴이 된다. 트레이 토글은 이벤트 루프 안에서 직접 돌아
// 멀쩡했고(W6부터), W7-h 가 추가한 설정 토글·말풍선 커맨드들이 지뢰였다 — W8-d 타이틀바
// 토글이 처음으로 밟아 앱 전체가 행으로 죽었다(이벤트 로그 AppHangB1, 강제 종료 0xcfffffff).
// 규칙: 창을 만들거나(ensure/destroy/open_bubble) 창 getter(outer_position 등)를 부르는
// 커맨드는 전부 async. 순수 DB/상태 커맨드(pet_set_position, pet_bubble_state, 에셋 계열)는
// 그대로 동기다.

/// 트레이 "열기"와 같은 경로(tray::show_and_focus) + note_id 가 있으면 메인 창에 알린다.
/// 펫 창은 별 웹뷰라 메인 앱의 스토어에 직접 닿을 수 없다 — 이벤트가 유일한 경로다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_open_main(note_id: Option<String>, app: tauri::AppHandle) -> AppResult<PetOpenMainResult> {
    crate::tray::show_and_focus(&app, crate::tray::RevealVia::Pet);
    if let Some(id) = note_id {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("pet-open-note", serde_json::json!({ "note_id": id }));
        }
    }
    Ok(PetOpenMainResult { ok: true })
}

#[derive(Serialize)]
pub struct PetCloseResult {
    pub closed: bool,
}

/// 펫 창의 우클릭 "펫 끄기" — W8-g: 마스터(pet_enabled)가 아니라 표시/숨김(pet_visible)만
/// 끈다(tray::set_pet_visible). 펫 쪽에서 하는 액션은 "지금 눈앞에서 치워라"이지 "기능을
/// 완전히 꺼라"가 아니다 — 마스터까지 꺼버리면 타이틀바 버튼(및 트레이 항목)이 통째로
/// 사라져서, 오너가 켜고 싶어도 Settings > 펫 을 다시 열어야만 되돌릴 수 있다(원 신고 증상과
/// 같은 함정). Settings > 펫에서 끄는 것만 마스터를 건드린다(pet_set_enabled).
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_close(app: tauri::AppHandle) -> AppResult<PetCloseResult> {
    crate::tray::set_pet_visible(&app, false);
    Ok(PetCloseResult { closed: true })
}

/// 펫 우클릭 = 트레이 우클릭(오너 2026-10-16: "정확히 같은 내용을 상속"). 항목 목록은
/// tray::build_tray_menu 하나뿐이고, 여기서는 그 메뉴를 펫 창 위에 네이티브로 띄운다 — 클릭은
/// 트레이 아이콘의 on_menu_event 가 그대로 받는다(Tauri 의 메뉴 이벤트는 전역). 펫 웹뷰에 두 번째
/// 목록을 두지 않는다. async: 창 조작(wry #583, 위 "async 인 이유").
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_menu_popup(window: tauri::Window, app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::tray::popup_menu_on(&app, &window).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(PetOkResult { ok: true })
}

#[derive(Serialize)]
pub struct PetThemeResult {
    pub theme: String,
    pub accent: String,
    pub font_scale: f64,
    /// 우클릭 메뉴에 "화면 저장"을 노출할지(capture_screenshot_enabled, 시드 없음 = OFF).
    /// 펫 창은 settings_get_all 이 금지돼 있어(pet_window.rs) 이 좁은 읽기에 얹는다 —
    /// PetBubbleApp.tsx 가 남겨 둔 "pet_theme 에 설정 한 칸을 더하는 것이 업그레이드 경로"
    /// 그대로다. 실효 게이트는 여기가 아니라 pet_screenshot_capture 안(Rust 강제, Q7).
    pub capture_screenshot: bool,
    pub surface_style: String,
    pub sheet_alpha: f64,
    pub ai_enabled: bool,
    /// W18 B2: 더블클릭 반응 설정. `settings_get_all` 이 펫 창에서 금지돼 값을 못 읽던 사고
    /// (AUDIT-2026-08-22-debris.md §1.1)의 수정 — 저장값 그대로 내려주고, 구값(search/open_note)
    /// 흡수는 프런트(PetApp.tsx)의 정규화에서 한다.
    pub pet_dblclick_action: String,
    /// F-P01 비서/펫 노트 쓰기 게이트. 펫 창은 settings_get_all 이 금지돼 이 좁은 읽기에 얹는다.
    /// 실효 게이트는 pet_chat_turn 의 클라 플래그 AND (키 없음 = true).
    pub chat_write_enabled: bool,
}

/// W8-h: 펫 창의 테마 상속. settings_get_all 이 펫 창에서 금지돼 있어(pet_window.rs 헤더) 필요한
/// 세 값만 좁게 노출한다. 순수 DB 읽기라 동기(async 규칙은 창을 만들거나 창 getter 를 부르는
/// 커맨드에만 적용된다 — 위 "async 인 이유" 참고). DB 값은 settings_schema::validate_setting 이
/// 쓰기 시점에 이미 검증하므로(theme∈{dark,light}, accent hex, font_scale 0.85~1.35) 여기서는
/// 그대로 신뢰하고, 시드 이전/누락 값에만 기본값으로 폴백한다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_theme(state: tauri::State<'_, AppState>) -> AppResult<PetThemeResult> {
    let conn = state.db.lock();
    let s = settings::get_all(&conn)?;
    Ok(PetThemeResult {
        theme: s.get("theme").and_then(|v| v.as_str()).unwrap_or("dark").to_string(),
        accent: s.get("accent").and_then(|v| v.as_str()).unwrap_or("#9cc5a4").to_string(),
        font_scale: s.get("font_scale").and_then(|v| v.as_f64()).unwrap_or(1.0),
        capture_screenshot: capture_screenshot_enabled(&s),
        surface_style: match s.get("surface_style").and_then(|v| v.as_str()) {
            Some("acrylic") | Some("mica") => "acrylic".into(),
            _ => "flat".into(),
        },
        sheet_alpha: s
            .get("sheet_alpha")
            .and_then(|v| v.as_f64())
            .or_else(|| s.get("mica_alpha").and_then(|v| v.as_f64()))
            .unwrap_or(0.85),
        ai_enabled: match s.get("ai_enabled") {
            Some(v) if v.as_bool() == Some(true) => true,
            Some(v) if v.as_str() == Some("true") || v.as_str() == Some("1") => true,
            _ => false,
        },
        pet_dblclick_action: s
            .get("pet_dblclick_action")
            .and_then(|v| v.as_str())
            .unwrap_or("new_note")
            .to_string(),
        chat_write_enabled: chat_write_enabled(&s),
    })
}

/// AI 챗을 쓸 수 있는지 — pet_chat_turn (1a)와 **같은 판정**(같은 자격 읽기 → 프로바이더 해석 →
/// privacy_gate_ok). 로컬 ollama 는 동의 없이도 열린다. 트레이/펫 메뉴 "새 세션 열기" 노출에 쓴다.
pub(crate) fn chat_available(s: &std::collections::BTreeMap<String, serde_json::Value>) -> bool {
    let c = ai::read_ai_creds_from(s);
    matches!(
        ai::resolve_provider_and_endpoint(&c.provider, c.endpoint),
        Ok((p, e)) if ai::privacy_gate_ok(&p, &e, c.ai_enabled)
    )
}

// ── 화면 저장 (docs/PLAN-2026-08-09-pet-capture.md Phase 1) ──────────────────

/// `capture_screenshot_enabled` — "0"/"1" 문자열, 시드 없음 = OFF(pet_enabled 와 같은 관례,
/// settings_schema.rs 참고). 신규 수집 채널은 기본 전부 OFF(Q7).
pub(crate) fn capture_screenshot_enabled(s: &std::collections::BTreeMap<String, serde_json::Value>) -> bool {
    s.get("capture_screenshot_enabled").and_then(|v| v.as_str()) == Some("1")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PetScreenshotAiSummaryStatus {
    Generated,
    /// AI privacy gate was closed, so no screenshot bytes left this device.
    Disabled,
    /// The image could not be prepared, the provider rejected it, or no usable text came back.
    UnsupportedOrFailed,
    /// The shared vision operation deadline elapsed; the image remains available for saving.
    Timeout,
}

impl PetScreenshotAiSummaryStatus {
    fn audit_value(self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::Disabled => "disabled",
            Self::UnsupportedOrFailed => "unsupported_or_failed",
            Self::Timeout => "timeout",
        }
    }
}

/// Converts the optional image-summary step into the command's stable public contract. `Ok(None)`
/// is reserved for the closed privacy gate; every other absence has a concrete failure status.
/// The raw provider error is deliberately not returned or persisted because it can contain
/// provider response fragments. The captured image is independent of this outcome.
fn screenshot_ai_summary_outcome(
    result: AppResult<Option<String>>,
) -> (String, PetScreenshotAiSummaryStatus) {
    match result {
        Ok(Some(summary)) if !summary.trim().is_empty() => {
            (summary.trim().to_string(), PetScreenshotAiSummaryStatus::Generated)
        }
        Ok(None) => (String::new(), PetScreenshotAiSummaryStatus::Disabled),
        Ok(Some(_)) => (String::new(), PetScreenshotAiSummaryStatus::UnsupportedOrFailed),
        // 리터럴을 여기 복제하지 않는다 — 판정 기준은 그 에러를 만드는 쪽의 상수 하나다.
        Err(AppError::Io(message)) if message == ai::DEADLINE_EXCEEDED => {
            (String::new(), PetScreenshotAiSummaryStatus::Timeout)
        }
        Err(_) => (String::new(), PetScreenshotAiSummaryStatus::UnsupportedOrFailed),
    }
}

/// Audit fields intentionally accept only non-sensitive metadata. Keeping this construction at
/// a narrow seam prevents a later caller from accidentally logging a window title, screenshot,
/// or model summary while adding observability.
fn screenshot_ai_audit_fields(
    external_attempted: bool,
    status: PetScreenshotAiSummaryStatus,
) -> (String, String) {
    (
        format!("[screen capture vision; external_attempted={external_attempted}]"),
        format!("[screen capture vision status={}]", status.audit_value()),
    )
}

#[derive(Serialize)]
pub struct PetScreenshotCaptureResult {
    /// 캡처한 창 제목 — 카드 문구와 노트 본문의 출처 줄에 쓴다.
    pub title: String,
    /// 첨부 파일명(screenshot-YYYYMMDD-HHMMSS.png).
    pub name: String,
    /// PNG 원본 base64 — 호출자가 attachment_add_bytes 로 그대로 넘긴다.
    pub data_base64: String,
    /// 비전 요약. 비어 있으면 `ai_summary_status`가 정확한 이유를 제공한다.
    pub summary: String,
    /// 선택적 비전 요약의 결과. 캡처·저장 가능 여부와는 독립적이다.
    pub ai_summary_status: PetScreenshotAiSummaryStatus,
}

/// 캡처(+폴더 저장, tray::capture_to_folder)가 끝난 PNG 에 선택적 비전 요약을 붙인다 —
/// 펫 카드 경로만 탄다. 트레이 직행 경로(펫 없음)는 폴더 저장으로 끝난다.
pub async fn pet_screenshot_capture_inner<T: ai::VisionTransport>(
    state: &AppState,
    transport: &T,
    capture: crate::repo::screenshot::Capture,
    name: String,
) -> AppResult<PetScreenshotCaptureResult> {
    use base64::Engine as _;

    let (cfg, workspace_id) = {
        let conn = state.db.lock();
        (read_pet_config(&conn)?, folders::active_workspace_id(&conn).ok())
    };

    let b64 = base64::engine::general_purpose::STANDARD;
    let data_base64 = b64.encode(&capture.png);

    // 비전 요약은 선택 단계다. 게이트가 닫히면 `disabled`로, 그 밖의 준비/프로바이더 오류는
    // 구체적인 실패 상태로 돌리되 이미 확보한 PNG의 저장 경로는 막지 않는다.
    let (summary_result, external_attempted) = match ai::resolve_provider_and_endpoint(&cfg.provider, cfg.endpoint.clone()) {
        Ok((provider, endpoint)) if !ai::privacy_gate_ok(&provider, &endpoint, cfg.ai_enabled) => (Ok(None), false),
        Ok((provider, endpoint)) => match crate::repo::screenshot::vision_image(&capture.png) {
            Ok(small) => (
                ai::describe_image_inner(
                    b64.encode(&small),
                    crate::repo::screenshot::VISION_MIME.to_string(),
                    capture.title.clone(),
                    provider,
                    endpoint,
                    cfg.api_key.clone(),
                    cfg.model.clone(),
                    cfg.ai_enabled,
                    transport,
                )
                .await
                .map(Some),
                true,
            ),
            Err(error) => (Err(error), false),
        },
        Err(error) => (Err(error), false),
    };
    let (summary, ai_summary_status) = screenshot_ai_summary_outcome(summary_result);

    // 캡처 화면·창 제목·요약 원문은 민감할 수 있어 history에는 절대 넣지 않는다. 외부 전송의
    // 시도 여부와 결과만 남긴다. history 실패는 선택적 요약 때문에 캡처 저장을 막지 않는다.
    if let Some(ws) = workspace_id {
        let conn = state.db.lock();
        let (input, result) = screenshot_ai_audit_fields(external_attempted, ai_summary_status);
        let _ = ai::record_history(&conn, &ws, None, "pet_screenshot", Some(&input), &result);
    }

    Ok(PetScreenshotCaptureResult {
        title: capture.title,
        name,
        data_base64,
        summary,
        ai_summary_status,
    })
}

/// "화면 저장"(펫이 떠 있을 때의 카드 경로) — **메인 창이 부른다**(pet_bubble_clip 과 같은 이유:
/// 저장·검색 경로가 전부 PET_ALLOWED_COMMANDS 밖이라 다리가 대행한다,
/// src/plugins/pet/bridge/petScreenshotBridge.ts). 게이트·캡처·폴더 저장은 트레이 직행 경로와
/// 같은 tray::capture_to_folder 한 곳이다 — 카드에서 고르기 전에도 파일은 이미 폴더에 있다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_screenshot_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetScreenshotCaptureResult> {
    let (capture, name) = crate::tray::capture_to_folder(&app).await?;
    let ctx = ai::call_log::CallCtx {
        op: Some("vision".to_string()),
        caller: Some("pet_screenshot_capture".to_string()),
        note_id: None,
        request_id: None,
    };
    ai::call_log::with_call_ctx(
        ctx,
        pet_screenshot_capture_inner(
            &state,
            &ai::RealVisionTransport::new(crate::commands::ai::fallback_model_setting(&state)),
            capture,
            name,
        ),
    )
    .await
}

/// 펫 없는 트레이 경로의 노트 본문 — 요약 단계가 없으므로 `petScreenshotBridge.ts::screenshotBody`
/// 가 요약 없이(`generated`, 빈 요약) 만드는 출처 한 줄과 **같은 문자열**이다. "AI 요약 꺼짐" 같은
/// 사유를 붙이지 않는다 — 이 경로는 요약을 시도조차 하지 않는다(오너 2026-10-16). 문구를 바꾸면 둘 다.
pub(crate) fn screenshot_note_body(title: &str) -> String {
    let title = if title.is_empty() { "제목 없는 창" } else { title };
    format!("화면 캡처: {title}")
}

/// 펫 창이 없을 때의 "화면 저장"(tray::run_capture) — 캡처·폴더 저장 직후 인박스 노트를 확인 없이
/// 만든다(오너 2026-10-16). **AI 비전 요약은 돌리지 않는다**(오너 2026-10-16 — 이미지가 외부로 나가는
/// 경로는 펫 카드 하나뿐). 저장·첨부는 카드 경로가 부르는 **같은 커맨드**(pet_note_create →
/// attachment_add_bytes)를 그대로 탄다. 파일은 그 전에 이미 폴더에 있다.
/// 반환 = 만든 노트 id. 첨부만 실패하면 노트는 남기고 에러를 돌려준다(카드 경로와 같은 분리).
pub async fn capture_to_inbox(app: &tauri::AppHandle) -> AppResult<String> {
    use base64::Engine as _;
    use tauri::Manager as _;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| AppError::Io("app state not ready".to_string()))?;
    let (capture, name) = crate::tray::capture_to_folder(app).await?;
    let body = screenshot_note_body(&capture.title);
    let title = Some(capture.title.clone()).filter(|t| !t.is_empty());
    let created = pet_note_create(body, title, state.clone())?;
    // ponytail: base64 왕복은 attachment_add_bytes 를 그대로 쓰려는 값 — 캡처 1장이라 무시할 비용.
    let data = base64::engine::general_purpose::STANDARD.encode(&capture.png);
    // 트레이 경로라 호출 창이 없다 — 라벨 없이(출처 모름) 알린다.
    crate::commands::attachments::attachment_add_bytes_in(state, None, created.note_id.clone(), name, data).await?;
    Ok(created.note_id)
}

// ── 창 (W7-h 창 분리) ────────────────────────────────────────────────────────
// 캐릭터 창은 고정 크기이고, 말풍선/채팅은 별도 창이다. 배치는 전부 Rust 가 한다 —
// 웹뷰에서는 모니터 작업영역을 볼 수 없고, 그게 예전 "화면 밖으로 펼쳐짐"의 직접 원인이었다.
// 자세한 이유는 pet_window.rs 헤더 주석.

#[derive(Serialize)]
pub struct PetOkResult {
    pub ok: bool,
}

/// 설정 화면의 펫 마스터 온오프(W8-g: "펫 사용"). 트레이 항목의 존재 자체와 타이틀바 버튼의
/// 렌더 여부가 이 값에 물려 있다(tray::set_pet_enabled → reconcile이 트레이 메뉴를 다시
/// 짠다). 별도 메커니즘을 만들면 트레이/타이틀바가 실제 상태와 어긋난다(pet_close 와 같은
/// 이유). 표시/숨기기(pet_visible)는 건드리지 않는다 — 타이틀바 버튼·트레이 항목 전용
/// pet_set_visible.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_set_enabled(enabled: bool, app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::tray::set_pet_enabled(&app, enabled);
    Ok(PetOkResult { ok: true })
}

/// 타이틀바(App.tsx, Pin 옆)의 펫 표시/숨기기(W8-g). 트레이 "펫 표시/숨기기"와 **같은**
/// 경로(tray::set_pet_visible)를 지난다 — 마스터는 건드리지 않는다. 펫 창을 만들거나
/// 파괴하므로(AppHangB1) async.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_set_visible(visible: bool, app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::tray::set_pet_visible(&app, visible);
    Ok(PetOkResult { ok: true })
}

/// 펫 창이 드래그로 옮겨진 뒤 좌표를 영속한다. settings_set 대신 전용 커맨드를 두는 이유는
/// 보안이다 — 펫 창의 커맨드 allowlist(pet_window::PET_ALLOWED_COMMANDS)에서 범용
/// settings_set 을 빼려면, 펫이 실제로 필요한 쓰기만 좁은 표면으로 노출해야 한다.
/// 좌표 영속 한 지점 — 드래그 저장(pet_set_position)과 기본 위치 복귀(pet_position_reset)가
/// 같은 두 키를 쓴다.
fn persist_position(conn: &mut rusqlite::Connection, x: i64, y: i64) -> AppResult<()> {
    let mut entries = std::collections::BTreeMap::new();
    entries.insert("pet_pos_x".to_string(), serde_json::json!(x));
    entries.insert("pet_pos_y".to_string(), serde_json::json!(y));
    settings::set(conn, &entries).map(|_| ())
}

/// 창을 실제로 그 좌표로 옮긴다(떠 있을 때만). 설정의 위치 선택기가 누르는 즉시 펫이 가야
/// 하고, 드래그 저장 경로에서는 이미 그 자리라 멱등한 no-op 이다.
fn move_pet_window(app: &tauri::AppHandle, x: i64, y: i64) {
    if let Some(win) = app.get_webview_window(crate::pet_window::PET_LABEL) {
        let _ = win.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
    }
}

/// 창을 옮기므로(AppHangB1 규칙) async 다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_set_position(
    x: i64,
    y: i64,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        persist_position(&mut conn, x, y)?;
    }
    move_pet_window(&app, x, y);
    Ok(PetOkResult { ok: true })
}

#[derive(Serialize)]
pub struct PetPositionResetResult {
    pub x: i64,
    pub y: i64,
}

/// P7 "기본 위치로" — 기본 위치 규칙은 Rust 한 곳(pet_window::default_position)에만 있다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_position_reset(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetPositionResetResult> {
    let (fx, fy) = crate::pet_window::default_position(&app);
    let (x, y) = (fx.round() as i64, fy.round() as i64);
    {
        let mut conn = state.db.lock();
        persist_position(&mut conn, x, y)?;
    }
    move_pet_window(&app, x, y);
    Ok(PetPositionResetResult { x, y })
}

#[derive(Serialize)]
pub struct PetBubbleToggleResult {
    pub open: bool,
}

/// 펫을 클릭했을 때의 채팅 토글. 열림 여부의 진실은 Rust 쪽 창 존재 여부다(프런트에 플래그를
/// 두면 말풍선이 스스로 닫혔을 때 어긋난다).
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_bubble_toggle(app: tauri::AppHandle) -> AppResult<PetBubbleToggleResult> {
    let open = crate::pet_window::toggle_chat(&app)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(PetBubbleToggleResult { open })
}

#[derive(Serialize)]
pub struct PetBubbleNoticeResult {
    pub shown: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pet_bubble_notice(
    text: String,
    note_id: Option<String>,
    app: tauri::AppHandle,
) -> AppResult<PetBubbleNoticeResult> {
    let shown = crate::pet_window::show_notice(&app, text, note_id)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(PetBubbleNoticeResult { shown })
}

/// 클립보드 저장 확인 카드를 말풍선에 띄운다(Q9). `payload` 는 카드가 그대로 렌더할 JSON
/// (src/lib/petClipboardBridge.ts ClipCardPayload) — 펫 창이 아니라 **메인 창**이 부른다:
/// 라우팅(link_preview / search_notes)은 펫 allowlist 밖이라 메인 창이 대행하고, 그 결과를
/// 이 커맨드로 펫에게 돌려주는 구조다. 그래서 PET_ALLOWED_COMMANDS 에는 넣지 않는다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_bubble_clip(payload: String, app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::pet_window::show_clip(&app, payload).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(PetOkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pet_bubble_close(app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::pet_window::close_bubble(&app);
    Ok(PetOkResult { ok: true })
}

#[derive(Serialize)]
pub struct PetBubbleStateResult {
    pub mode: String,
    pub text: String,
    pub note_id: Option<String>,
}

/// 말풍선 창이 마운트 직후 자기 내용을 가져간다(URL 로 텍스트를 실어 보내면 이스케이프 문제).
#[tauri::command(rename_all = "snake_case")]
pub fn pet_bubble_state() -> AppResult<PetBubbleStateResult> {
    let p = crate::pet_window::bubble_payload().unwrap_or_default();
    Ok(PetBubbleStateResult { mode: p.mode, text: p.text, note_id: p.note_id })
}

/// 알림 말풍선이 자기 내용 높이를 재서 알려온다 — 창을 그 높이로 맞추고 다시 배치한다.
/// 예전에는 CSS `max-height: 84px; overflow: hidden` 이라 긴 알림이 조용히 잘렸다.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_bubble_resize(height: f64, app: tauri::AppHandle) -> AppResult<PetOkResult> {
    crate::pet_window::resize_bubble(&app, height);
    Ok(PetOkResult { ok: true })
}

// ── 에셋 ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PetAssetsListResult {
    pub items: Vec<pet::PetAsset>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_assets_list(state: tauri::State<'_, AppState>) -> AppResult<PetAssetsListResult> {
    let conn = state.db.lock();
    Ok(PetAssetsListResult { items: pet::list_assets(&conn, &state.data_dir)? })
}

/// 설정 화면의 드래그앤드롭이 넘겨주는 OS 경로를 받아 앱 데이터 폴더로 **복사**한다.
/// cycle_ms: PNG 스프라이트 시트 재생 속도(ms) — 그 외 형식엔 repo::pet::set_asset 이 무시한다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_asset_set(
    mood: String,
    path: String,
    frames: Option<u32>,
    cycle_ms: Option<u32>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        pet::set_asset(
            &mut conn,
            &state.data_dir,
            &mood,
            std::path::Path::new(&path),
            frames,
            cycle_ms,
        )?;
    }
    // 펫 창뿐 아니라 설정(main) 창의 PetSprite 미리보기도 이 이벤트를 듣는다 — 전체 브로드캐스트.
    let _ = app.emit("pet-assets-changed", ());
    Ok(PetOkResult { ok: true })
}

/// 등록 전 미리보기 — 저장은 하지 않고 pet_asset_set 과 같은 검증(형식/2MB)만 거쳐 데이터 URL로
/// 돌려준다. 설정 화면이 프레임 수·재생 속도를 확정하기 전에 실제로 움직이는 모습을 보여준다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_asset_preview(path: String) -> AppResult<pet::PetAssetPreview> {
    pet::preview_asset(std::path::Path::new(&path))
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_asset_clear(
    mood: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        pet::clear_asset(&mut conn, &state.data_dir, &mood)?;
    }
    // 위 pet_asset_set 과 동일 — 펫 창 + 설정 창 둘 다 갱신해야 한다.
    let _ = app.emit("pet-assets-changed", ());
    Ok(PetOkResult { ok: true })
}

// ── Codex v2 펫 패키지 ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PetPackagesListResult {
    pub items: Vec<pet::PetPackage>,
}

/// 목록 조회는 (1) DB 락 안에서 선택된 id만 꺼내고 → 락 해제 → (2) 디렉토리 스캔+헤더 검사를
/// spawn_blocking 워커에서 한다. 예전엔 동기 커맨드가 db.lock()을 쥔 채 설치 패키지 전부의
/// 아틀라스를 풀 디코드했다 — 그 동안 메인 창의 다른 DB 커맨드가 전부 막혔다(attachment_add_file
/// 의 썸네일 사고와 같은 패턴, commands/pet.rs 헤더 규칙 참고).
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_packages_list(state: tauri::State<'_, AppState>) -> AppResult<PetPackagesListResult> {
    let selected = {
        let conn = state.db.lock();
        pet::selected_package_id(&conn)?
    };
    let data_dir = state.data_dir.clone();
    let items = tauri::async_runtime::spawn_blocking(move || pet::list_packages_fs(&data_dir, selected.as_deref()))
        .await
        .map_err(|e| AppError::Io(format!("pet packages list worker join error: {e}")))??;
    Ok(PetPackagesListResult { items })
}

#[derive(Serialize)]
pub struct PetPackageAssetResult {
    pub data_url: String,
}

/// 위와 같은 두 단계 패턴 — DB 락은 id 해석에만, 파일 읽기+base64 인코딩은 spawn_blocking.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_package_asset(
    id: Option<String>,
    preview: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> AppResult<PetPackageAssetResult> {
    let id = {
        let conn = state.db.lock();
        pet::resolve_package_id(&conn, id.as_deref())?
    };
    let data_dir = state.data_dir.clone();
    let preview = preview.unwrap_or(false);
    let data_url = tauri::async_runtime::spawn_blocking(move || {
        pet::read_package_asset_fs(&data_dir, &id, preview)
    })
    .await
    .map_err(|e| AppError::Io(format!("pet package asset worker join error: {e}")))??;
    Ok(PetPackageAssetResult { data_url })
}

/// P2: 입력은 pet.json 파일 · 폴더 · zip · 단일 이미지. 방언은 repo 가 판정한다.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_package_install(
    path: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        pet::install_from_path(&mut conn, &state.data_dir, std::path::Path::new(&path))?;
    }
    let _ = app.emit("pet-packages-changed", ());
    Ok(PetOkResult { ok: true })
}

async fn download_pet_package(mut current: reqwest::Url, dest: &std::path::Path) -> AppResult<()> {
    const FETCH_TIMEOUT_SECS: u64 = 30;
    let mut hops = 0;
    let resp = loop {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;
        let resp = client
            .get(current.clone())
            .header("User-Agent", "Brise/1.0")
            .send()
            .await
            .map_err(|e| AppError::Io(format!("pet package download failed: {e}")))?;
        if resp.status().is_redirection() {
            if hops >= pet::PET_URL_MAX_REDIRECTS {
                return Err(AppError::Io("too many redirects".to_string()));
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| AppError::Io("redirect without a valid Location header".to_string()))?;
            let next = current
                .join(location)
                .map_err(|e| AppError::Io(format!("bad redirect target: {e}")))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(AppError::Validation("pet_install:bad_url".into()));
            }
            current = next;
            hops += 1;
            continue;
        }
        break resp;
    };
    if !resp.status().is_success() {
        return Err(AppError::Io(format!("pet package http {}", resp.status())));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(crate::error::io)?;
    }
    let mut file = std::fs::File::create(dest).map_err(crate::error::io)?;
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("pet package read failed: {e}")))?;
        written = written.saturating_add(chunk.len() as u64);
        if written > pet::PET_URL_MAX_BYTES {
            drop(file);
            let _ = std::fs::remove_file(dest);
            return Err(AppError::Validation("pet_install:too_large".into()));
        }
        file.write_all(&chunk).map_err(crate::error::io)?;
    }
    Ok(())
}

/// 카탈로그 zip URL 설치. http(s) 만. 펫 창 allowlist 밖.
#[tauri::command(rename_all = "snake_case")]
pub async fn pet_package_install_url(
    url: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    let parsed = pet::parse_pet_install_url(&url)?;
    let dest_name = pet::download_file_name_for_url(&parsed);
    let dest = state.data_dir.join(".pet_import").join(dest_name);
    download_pet_package(parsed, &dest).await?;
    let install_path = dest.clone();
    let data_dir = state.data_dir.clone();
    let result = {
        let mut conn = state.db.lock();
        pet::install_from_path(&mut conn, &data_dir, &install_path)
    };
    let _ = std::fs::remove_file(&dest);
    result?;
    let _ = app.emit("pet-packages-changed", ());
    Ok(PetOkResult { ok: true })
}

#[derive(Serialize)]
pub struct PetPackagesImportResult {
    pub installed: Vec<String>,
    pub failed: Vec<pet::PetInstallFailure>,
}

/// `%USERPROFILE%/.codex/pets` (또는 CODEX_HOME / HOME) 하위 폴더를 일괄 설치.
#[tauri::command(rename_all = "snake_case")]
pub fn pet_packages_import_codex(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetPackagesImportResult> {
    let pets_root = pet::default_codex_pets_dir().ok_or_else(|| {
        AppError::Io("codex pets directory not found".to_string())
    })?;
    let result = {
        let mut conn = state.db.lock();
        pet::import_codex_pets(&mut conn, &state.data_dir, &pets_root)?
    };
    let _ = app.emit("pet-packages-changed", ());
    Ok(PetPackagesImportResult {
        installed: result.installed,
        failed: result.failed,
    })
}

/// P4: 패키지 폴더 삭제. 선택 중이던 것이면 선택도 비운다(repo).
#[tauri::command(rename_all = "snake_case")]
pub fn pet_package_remove(
    id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        pet::remove_package(&mut conn, &state.data_dir, &id)?;
    }
    let _ = app.emit("pet-packages-changed", ());
    Ok(PetOkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn pet_package_select(
    id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<PetOkResult> {
    {
        let mut conn = state.db.lock();
        pet::select_package(&mut conn, &state.data_dir, &id)?;
    }
    let _ = app.emit("pet-packages-changed", ());
    Ok(PetOkResult { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 펫 없는 트레이 화면 저장의 노트 본문 — petScreenshotBridge.test.ts 의 screenshotBody 기대값과 같은 문자열.
    #[test]
    fn screenshot_note_body_matches_card_path() {
        // = screenshotBody("메모장", "") / screenshotBody("", "") (요약 없음, 사유 없음)
        assert_eq!(screenshot_note_body("메모장"), "화면 캡처: 메모장");
        assert_eq!(screenshot_note_body(""), "화면 캡처: 제목 없는 창");
    }
    use std::collections::BTreeMap;
    use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};

    struct SummaryTransport {
        response: Option<String>,
        calls: Arc<AtomicUsize>,
    }

    impl SummaryTransport {
        fn json(response: &str) -> Self {
            Self { response: Some(response.to_string()), calls: Arc::new(AtomicUsize::new(0)) }
        }

        fn failing() -> Self {
            Self { response: None, calls: Arc::new(AtomicUsize::new(0)) }
        }
    }

    impl TextTransport for SummaryTransport {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.response
                .clone()
                .ok_or_else(|| AppError::Io("summary transport failed".to_string()))
        }
    }

    fn sample_conversation() -> Vec<PetMessage> {
        vec![
            PetMessage {
                role: "user".into(),
                text: "이번 주말에 부산에 갈까?".into(),
                created_at: "2026-08-08T09:00:00Z".into(),
                meta: None,
            },
            PetMessage {
                role: "assistant".into(),
                text: "좋아요. 교통편부터 비교해 보죠.".into(),
                created_at: "2026-08-08T09:00:02Z".into(),
                meta: None,
            },
        ]
    }

    #[test]
    fn chat_write_enabled_is_true_when_missing_and_respects_false() {
        let empty = BTreeMap::new();
        assert!(chat_write_enabled(&empty));
        let mut off = BTreeMap::new();
        off.insert("chat_write_enabled".to_string(), serde_json::json!(false));
        assert!(!chat_write_enabled(&off));
        let mut on = BTreeMap::new();
        on.insert("chat_write_enabled".to_string(), serde_json::json!(true));
        assert!(chat_write_enabled(&on));
    }

    /// read_pet_config 의 폴백 규칙만 떼어 본다 — 빈 문자열(마이그레이션 시드 기본값)이
    /// "미설정"으로 취급되지 않으면 프로바이더가 빈 Authorization 헤더로 401 을 맞는다
    /// (commands::ai::pick_api_key 와 같은 함정).
    #[test]
    fn blank_settings_fall_back_instead_of_being_sent_as_empty_strings() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let cfg = read_pet_config(&conn).unwrap();
        assert_eq!(cfg.provider, "ollama", "시드 기본 provider");
        assert_eq!(cfg.endpoint, None, "빈 endpoint 는 미지정");
        assert_eq!(cfg.api_key, None);
        assert_eq!(cfg.model, None);
        assert!(!cfg.ai_enabled);
        assert_eq!(cfg.persona_preset, "secretary", "저장된 적 없으면 담백형");

        let mut entries = BTreeMap::new();
        entries.insert("pet_persona_preset".to_string(), serde_json::json!("friend"));
        entries.insert("ai_model".to_string(), serde_json::json!("llama3.2"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let cfg = read_pet_config(&conn).unwrap();
        assert_eq!(cfg.persona_preset, "friend");
        assert_eq!(cfg.model.as_deref(), Some("llama3.2"));
    }

    #[test]
    fn empty_structured_summary_is_not_saved_as_raw_json() {
        let err = parse_conversation_summary(r#"{"title":"제목","summary":"   "}"#)
            .expect_err("empty structured summary must be rejected");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn pet_chat_read_attach_txt_excerpt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.txt");
        std::fs::write(&path, "hello attach").unwrap();
        let res = pet_chat_read_attach(path.to_string_lossy().into()).unwrap();
        assert_eq!(res.kind, "doc");
        assert_eq!(res.name, "note.txt");
        assert_eq!(res.excerpt.as_deref(), Some("hello attach"));
        assert!(res.base64.is_none());
    }

    #[test]
    fn pet_chat_read_attach_png_base64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pic.png");
        std::fs::write(&path, [0x89, b'P', b'N', b'G', 0, 1, 2, 3]).unwrap();
        let res = pet_chat_read_attach(path.to_string_lossy().into()).unwrap();
        assert_eq!(res.kind, "image");
        assert_eq!(res.mime.as_deref(), Some("image/png"));
        assert_eq!(res.name, "pic.png");
        assert!(res.base64.as_ref().is_some_and(|b| !b.is_empty()));
    }

    #[test]
    fn pet_chat_read_attach_unknown_is_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.zip");
        std::fs::write(&path, [0u8; 8]).unwrap();
        let res = pet_chat_read_attach(path.to_string_lossy().into()).unwrap();
        assert_eq!(res.kind, "file");
        assert_eq!(res.name, "a.zip");
        assert!(res.excerpt.is_none());
        assert!(res.base64.is_none());
    }

    #[test]
    fn pet_chat_read_attach_missing_file() {
        let err = pet_chat_read_attach("/no/such/brise-chat-attach.txt".into()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn screenshot_summary_status_preserves_why_the_optional_ai_step_was_absent() {
        assert_eq!(
            screenshot_ai_summary_outcome(Ok(None)),
            (String::new(), PetScreenshotAiSummaryStatus::Disabled),
        );
        assert_eq!(
            screenshot_ai_summary_outcome(Ok(Some("  회의 일정  ".to_string()))),
            ("회의 일정".to_string(), PetScreenshotAiSummaryStatus::Generated),
        );
        assert_eq!(
            screenshot_ai_summary_outcome(Err(AppError::Io(ai::DEADLINE_EXCEEDED.to_string()))),
            (String::new(), PetScreenshotAiSummaryStatus::Timeout),
        );
        assert_eq!(
            screenshot_ai_summary_outcome(Err(AppError::Validation("model cannot accept images".to_string()))),
            (String::new(), PetScreenshotAiSummaryStatus::UnsupportedOrFailed),
        );
    }

    #[test]
    fn screenshot_ai_audit_contains_only_attempt_and_status_metadata() {
        let (input, result) = screenshot_ai_audit_fields(true, PetScreenshotAiSummaryStatus::Timeout);

        assert_eq!(input, "[screen capture vision; external_attempted=true]");
        assert_eq!(result, "[screen capture vision status=timeout]");
    }

    #[tokio::test]
    async fn conversation_save_summarizes_then_persists_note_and_audit_history() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let transport = SummaryTransport::json(
            r#"{"title":"부산 주말 여행","summary":"부산 여행을 검토하고 교통편을 비교하기로 했다."}"#,
        );
        let result = pet_conversation_save_inner(
            sample_conversation(),
            None,
            &state,
            &transport,
        )
        .await
        .unwrap();
        assert_eq!(result.title, "부산 주말 여행");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let conn = state.db.lock();
        let section_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sections WHERE note_id=?1", [&result.note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(section_count, 2);
        let (action, note_id, prompt): (String, Option<String>, String) = conn
            .query_row(
                "SELECT action_type, note_id, prompt_or_input FROM ai_history ORDER BY created_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(action, "pet_conversation_summary");
        assert_eq!(note_id.as_deref(), Some(result.note_id.as_str()));
        assert!(!prompt.contains("부산에 갈까"), "원문은 audit prompt에 저장하지 않는다");
    }

    #[tokio::test]
    async fn conversation_summary_failure_does_not_create_a_partial_note() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let transport = SummaryTransport::failing();
        let before: i64 = state
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        let result = pet_conversation_save_inner(sample_conversation(), None, &state, &transport).await;
        assert!(result.is_err());
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        let conn = state.db.lock();
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        let history: i64 = conn.query_row("SELECT COUNT(*) FROM ai_history", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        assert_eq!(history, 0);
    }

    #[tokio::test]
    async fn audit_failure_rolls_back_the_conversation_note() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_pet_conversation_audit
             BEFORE INSERT ON ai_history WHEN NEW.action_type='pet_conversation_summary'
             BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
        )
        .unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let transport = SummaryTransport::json(
            r#"{"title":"부산 주말 여행","summary":"교통편을 비교한다."}"#,
        );
        let before: i64 = state
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        let result = pet_conversation_save_inner(sample_conversation(), None, &state, &transport).await;
        assert!(result.is_err());
        let conn = state.db.lock();
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after, "감사 로그 실패 시 노트도 rollback되어야 한다");
    }

    struct CountingText {
        calls: Arc<AtomicUsize>,
        reply: String,
    }
    impl TextTransport for CountingText {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.reply.clone())
        }
    }
    struct CountingVision {
        calls: Arc<AtomicUsize>,
        ok: bool,
    }
    impl VisionTransport for CountingVision {
        async fn send_vision(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
            _image_base64: String,
            _mime: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.ok {
                Ok(r#"{"action":"answer","text":"사진 봤어요"}"#.to_string())
            } else {
                Err(AppError::Io("model cannot accept images".to_string()))
            }
        }
    }

    #[tokio::test]
    async fn send_pet_prompt_falls_back_to_text_when_vision_fails() {
        let text = CountingText { calls: Arc::new(AtomicUsize::new(0)), reply: "텍스트만".into() };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let (raw, status) = send_pet_prompt(
            &text,
            &vision,
            ai::Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "sys".into(),
            "안녕".into(),
            Some(("AAAA".into(), "image/jpeg".into())),
        )
        .await
        .unwrap();
        assert_eq!(raw, "텍스트만");
        assert_eq!(status.as_deref(), Some("fallback_text"));
        assert_eq!(vision.calls.load(Ordering::SeqCst), 1);
        assert_eq!(text.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn send_pet_prompt_uses_vision_when_it_works_and_skips_it_without_an_image() {
        let text = CountingText { calls: Arc::new(AtomicUsize::new(0)), reply: "텍스트".into() };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: true };
        let (raw, status) = send_pet_prompt(
            &text,
            &vision,
            ai::Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "sys".into(),
            "안녕".into(),
            Some(("AAAA".into(), "image/jpeg".into())),
        )
        .await
        .unwrap();
        assert!(raw.contains("사진 봤어요"));
        assert_eq!(status.as_deref(), Some("used"));
        assert_eq!(vision.calls.load(Ordering::SeqCst), 1);
        assert_eq!(text.calls.load(Ordering::SeqCst), 0);

        let (raw2, status2) = send_pet_prompt(
            &text,
            &vision,
            ai::Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "sys".into(),
            "안녕".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(raw2, "텍스트");
        assert_eq!(status2, None);
        assert_eq!(text.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pet_chat_inner_returns_persisted_message_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let text = CountingText {
            calls: Arc::new(AtomicUsize::new(0)),
            reply: r#"{"action":"answer","text":"안녕"}"#.into(),
        };
        let vision = CountingVision {
            calls: Arc::new(AtomicUsize::new(0)),
            ok: false,
        };
        let result = pet_chat_inner(
            "하이".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        let user_at = result.user_created_at.expect("user_created_at");
        let assistant_at = result.assistant_created_at.expect("assistant_created_at");
        assert!(!user_at.is_empty());
        assert!(!assistant_at.is_empty());
        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        let messages = pet::recent_messages(&conn, &ws, 10).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].created_at, user_at);
        assert_eq!(messages[0].meta, None);
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].created_at, assistant_at);
        assert_eq!(messages[1].meta, None, "plain answer stores no meta");
    }

    /// 응답 대기 중(프로바이더 왕복 한가운데) 다른 경로가 새 세션을 연다 — 트레이/펫 "새 세션 열기"·
    /// 사이드바·폰과 같은 pet::new_session.
    struct NewSessionMidway<'a> {
        state: &'a AppState,
    }
    impl TextTransport for NewSessionMidway<'_> {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            let conn = self.state.db.lock();
            let ws = pet::active_workspace(&conn).unwrap();
            pet::new_session(&conn, &ws).unwrap();
            Ok(r#"{"action":"answer","text":"늦은 답"}"#.into())
        }
    }

    #[tokio::test]
    async fn late_reply_goes_to_the_session_it_started_in_not_the_new_live() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let session_a = {
            let conn = state.db.lock();
            let ws = pet::active_workspace(&conn).unwrap();
            // 비어 있지 않아야 new_session 이 A 를 보관한다.
            pet::append_message(&conn, &ws, "user", "이전 질문", None).unwrap();
            pet::ensure_live_session(&conn, &ws).unwrap()
        };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let result = pet_chat_inner(
            "새 질문".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            &state,
            &NewSessionMidway { state: &state },
            &vision,
        )
        .await
        .unwrap();
        assert_eq!(result.reply, "늦은 답");

        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        let live_b = pet::ensure_live_session(&conn, &ws).unwrap();
        assert_ne!(live_b, session_a, "새 세션이 열렸어야 한다");
        assert!(pet::recent_messages(&conn, &ws, 10).unwrap().is_empty(), "새 라이브 B 는 비어 있어야 한다");
        let texts: Vec<String> = conn
            .prepare("SELECT text FROM pet_messages WHERE session_id = ?1 ORDER BY created_at, rowid")
            .unwrap()
            .query_map([&session_a], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(texts, vec!["이전 질문", "새 질문", "늦은 답"], "턴 전체가 시작 세션 A 에");
        let count: i64 = conn
            .query_row("SELECT message_count FROM pet_sessions WHERE id = ?1", [&session_a], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3, "보관된 A 의 개수도 갱신");
    }

    /// 왕복 한가운데 임의 DB 조작(`during`)을 하고 `reply`(None = 프로바이더 오류)를 돌려준다.
    struct Midway<'a, F: Fn(&rusqlite::Connection, &str, &str) + Send + Sync> {
        state: &'a AppState,
        during: F,
        reply: Option<&'static str>,
    }
    impl<F: Fn(&rusqlite::Connection, &str, &str) + Send + Sync> TextTransport for Midway<'_, F> {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            user_text: String,
        ) -> AppResult<String> {
            {
                let conn = self.state.db.lock();
                let ws = pet::active_workspace(&conn).unwrap();
                (self.during)(&conn, &ws, &user_text);
            }
            match self.reply {
                Some(r) => Ok(r.to_string()),
                None => Err(AppError::Io("provider down".to_string())),
            }
        }
    }

    fn session_rows(conn: &rusqlite::Connection, session_id: &str) -> Vec<(String, String, Option<String>)> {
        conn.prepare("SELECT role, text, meta FROM pet_messages WHERE session_id = ?1 ORDER BY created_at, rowid")
            .unwrap()
            .query_map([session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    async fn midway_turn<F: Fn(&rusqlite::Connection, &str, &str) + Send + Sync>(
        state: &AppState,
        during: F,
        reply: Option<&'static str>,
    ) -> AppResult<PetChatResult> {
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        pet_chat_turn(
            "새 질문".into(),
            None, None, None, None, None, None,
            true,
            false,
            Some("실패했어요".into()),
            state,
            &Midway { state, during, reply },
            &vision,
        )
        .await
    }

    fn live_id(state: &AppState) -> String {
        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        pet::ensure_live_session(&conn, &ws).unwrap()
    }

    #[tokio::test]
    async fn user_row_is_saved_before_the_provider_round_trip_and_not_sent_twice() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::bootstrap(dir.path()).unwrap(), dir.path().to_path_buf());
        let a = live_id(&state);
        let a2 = a.clone();
        let result = midway_turn(
            &state,
            move |conn, _ws, user_text| {
                let rows = session_rows(conn, &a2);
                assert_eq!(rows.len(), 1, "왕복 전에 사용자 행이 이미 있어야 한다");
                assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("user", "새 질문"));
                assert_eq!(user_text.matches("새 질문").count(), 1, "히스토리는 저장 전에 읽는다");
            },
            Some(r#"{"action":"answer","text":"답"}"#),
        )
        .await
        .unwrap();
        let conn = state.db.lock();
        let rows = session_rows(&conn, &a);
        assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), vec!["새 질문", "답"]);
        let msgs = pet::recent_messages(&conn, &pet::active_workspace(&conn).unwrap(), 10).unwrap();
        assert_eq!(result.user_created_at.as_deref(), Some(msgs[0].created_at.as_str()));
        assert_eq!(result.assistant_created_at.as_deref(), Some(msgs[1].created_at.as_str()));
        let count: i64 = conn
            .query_row("SELECT message_count FROM pet_sessions WHERE id = ?1", [&a], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn new_session_during_wait_archives_the_start_session_with_its_user_row() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::bootstrap(dir.path()).unwrap(), dir.path().to_path_buf());
        let a = live_id(&state); // 비어 있던 라이브 — 사용자 행이 시작 시 들어가 보관 대상이 된다.
        midway_turn(
            &state,
            |conn, ws, _| {
                let (_, archived) = pet::new_session(conn, ws).unwrap();
                assert!(archived.is_some(), "시작 세션은 비어 있지 않아 보관돼야 한다");
            },
            Some(r#"{"action":"answer","text":"늦은 답"}"#),
        )
        .await
        .unwrap();
        let conn = state.db.lock();
        let (title, closed): (String, Option<String>) = conn
            .query_row("SELECT title, closed_at FROM pet_sessions WHERE id = ?1", [&a], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert!(closed.is_some());
        assert_eq!(title, "새 질문", "보관 제목 = 첫 사용자 줄");
        assert_eq!(session_rows(&conn, &a).len(), 2);
        assert_ne!(pet::ensure_live_session(&conn, &pet::active_workspace(&conn).unwrap()).unwrap(), a);
    }

    #[tokio::test]
    async fn open_session_during_wait_does_not_delete_the_start_session() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::bootstrap(dir.path()).unwrap(), dir.path().to_path_buf());
        // 보관된 세션 C 하나 + 빈 라이브 A.
        let c = {
            let conn = state.db.lock();
            let ws = pet::active_workspace(&conn).unwrap();
            pet::append_message(&conn, &ws, "user", "옛 대화", None).unwrap();
            pet::new_session(&conn, &ws).unwrap().1.unwrap()
        };
        let a = live_id(&state);
        let c2 = c.clone();
        midway_turn(
            &state,
            move |conn, ws, _| {
                pet::open_session(conn, ws, &c2).unwrap();
            },
            Some(r#"{"action":"answer","text":"늦은 답"}"#),
        )
        .await
        .unwrap();
        let conn = state.db.lock();
        assert!(pet::session_exists(&conn, &pet::active_workspace(&conn).unwrap(), &a).unwrap());
        assert_eq!(
            session_rows(&conn, &a).iter().map(|r| r.1.as_str()).collect::<Vec<_>>(),
            vec!["새 질문", "늦은 답"]
        );
        assert_eq!(live_id_conn(&conn), c);
    }

    fn live_id_conn(conn: &rusqlite::Connection) -> String {
        pet::ensure_live_session(conn, &pet::active_workspace(conn).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn failure_lands_in_the_start_session_without_a_duplicate_user_row() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::bootstrap(dir.path()).unwrap(), dir.path().to_path_buf());
        let a = live_id(&state);
        let err = midway_turn(
            &state,
            |conn, ws, _| {
                pet::new_session(conn, ws).unwrap();
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        let conn = state.db.lock();
        let rows = session_rows(&conn, &a);
        assert_eq!(rows.len(), 2, "user 1 + 실패 행 1 — 사용자 행 중복 없음");
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("user", "새 질문"));
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str()), ("assistant", "실패했어요"));
        let meta: serde_json::Value = serde_json::from_str(rows[1].2.as_deref().unwrap()).unwrap();
        assert_eq!(meta["failed"], true);
        assert!(session_rows(&conn, &live_id_conn(&conn)).is_empty(), "새 라이브에는 아무것도 없다");
    }

    #[tokio::test]
    async fn privacy_gate_refusal_is_recorded_as_a_failed_turn() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("ai_provider".to_string(), serde_json::json!("openai"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let a = live_id(&state);
        let err = midway_turn(&state, |_, _, _| panic!("게이트가 막으면 왕복이 없어야 한다"), None)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let conn = state.db.lock();
        let rows = session_rows(&conn, &a);
        assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), vec!["새 질문", "실패했어요"]);
    }

    #[tokio::test]
    async fn clear_during_wait_drops_the_reply_instead_of_resurrecting_the_thread() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::bootstrap(dir.path()).unwrap(), dir.path().to_path_buf());
        let result = midway_turn(
            &state,
            |conn, ws, _| {
                pet::clear_messages(conn, ws).unwrap();
            },
            Some(r#"{"action":"answer","text":"늦은 답"}"#),
        )
        .await
        .unwrap();
        assert_eq!(result.reply, "늦은 답");
        assert!(result.assistant_created_at.is_none());
        let n: i64 = state.db.lock().query_row("SELECT COUNT(*) FROM pet_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "사용자가 지운 대화를 되살리지 않는다");
    }

    #[test]
    fn chat_available_uses_the_chat_privacy_gate() {
        let s = |pairs: &[(&str, serde_json::Value)]| -> BTreeMap<String, serde_json::Value> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
        };
        // 기본값 = 로컬 ollama — 동의(ai_enabled) 없이도 챗이 열린다.
        assert!(chat_available(&s(&[])));
        // 클라우드는 ai_enabled 필수.
        assert!(!chat_available(&s(&[("ai_provider", serde_json::json!("openai"))])));
        assert!(chat_available(&s(&[
            ("ai_provider", serde_json::json!("openai")),
            ("ai_enabled", serde_json::json!(true)),
        ])));
        // 원격 ollama 엔드포인트도 동의 없이는 막힌다.
        assert!(!chat_available(&s(&[("ai_endpoint", serde_json::json!("https://ollama.example.com"))])));
    }

    #[tokio::test]
    async fn pet_chat_inner_persists_display_text_and_result_meta() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let text = CountingText {
            calls: Arc::new(AtomicUsize::new(0)),
            reply: r#"{"action":"create_note","text":"우유","title":"장보기"}"#.into(),
        };
        let vision = CountingVision {
            calls: Arc::new(AtomicUsize::new(0)),
            ok: false,
        };
        let result = pet_chat_inner(
            "적어 둬".into(),
            Some("  메모  ".into()),
            None,
            None,
            None,
            None,
            None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        assert_eq!(result.action, "create_note");
        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        let messages = pet::recent_messages(&conn, &ws, 10).unwrap();
        assert_eq!(messages.len(), 2);
        let user_meta: serde_json::Value =
            serde_json::from_str(messages[0].meta.as_deref().unwrap()).unwrap();
        assert_eq!(user_meta["display_text"], "메모");
        let asst_meta: serde_json::Value =
            serde_json::from_str(messages[1].meta.as_deref().unwrap()).unwrap();
        assert_eq!(asst_meta["note_id"], result.note_id.clone().unwrap());
        assert_eq!(asst_meta["note_title"], "장보기");
        assert!(asst_meta.get("failed").is_none());
    }

    #[tokio::test]
    async fn pet_chat_inner_and_write_gate_blocks_when_setting_off() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("chat_write_enabled".to_string(), serde_json::json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let state = AppState::new(conn, dir.path().to_path_buf());
        let text = CountingText {
            calls: Arc::new(AtomicUsize::new(0)),
            reply: r#"{"action":"create_note","text":"권한 없이 메모","title":"메모"}"#.into(),
        };
        let vision = CountingVision {
            calls: Arc::new(AtomicUsize::new(0)),
            ok: false,
        };
        let before: i64 = state
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        let result = pet_chat_inner(
            "적어 둬".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        assert_eq!(result.action, "create_section");
        assert!(result.note_id.is_none());
        let after: i64 = state
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after, "stored chat_write_enabled=false must block create_note even when the client sends allow_write=true");
    }

    /// P7: 위치 영속 왕복 — pet_position_reset 이 default_position 결과를 넘기는 그 경로다
    /// (default_position 자체는 살아 있는 AppHandle/모니터가 필요해 여기서 부르지 않는다).
    #[test]
    fn position_round_trips_through_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        persist_position(&mut conn, 1744, 884).unwrap();
        let s = settings::get_all(&conn).unwrap();
        assert_eq!(s.get("pet_pos_x").and_then(|v| v.as_i64()), Some(1744));
        assert_eq!(s.get("pet_pos_y").and_then(|v| v.as_i64()), Some(884));
        persist_position(&mut conn, -1900, -40).unwrap();
        let s = settings::get_all(&conn).unwrap();
        assert_eq!(s.get("pet_pos_x").and_then(|v| v.as_i64()), Some(-1900), "보조 모니터 음수 좌표");
    }

    // ── 읽기 연결(HANDOFF-2026-10-08 Wave A): 채팅 검색·프롬프트 합성은 전역 `db` 잠금 밖에서 ──

    struct CapturingText {
        reply: String,
        system_prompts: Arc<parking_lot::Mutex<Vec<String>>>,
    }
    impl TextTransport for CapturingText {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            self.system_prompts.lock().push(system_prompt);
            Ok(self.reply.clone())
        }
    }

    /// 파일 DB + 근거가 될 노트 한 개("부산 여행 계획").
    fn file_db_with_note(dir: &std::path::Path) -> (rusqlite::Connection, String) {
        let mut conn = crate::db::bootstrap(dir).unwrap();
        let ws = pet::active_workspace(&conn).unwrap();
        let action = pet::PetAction {
            action: "create_note".into(),
            text: "해운대에서 부산 여행 일정을 정리했다".into(),
            title: Some("부산 여행 계획".into()),
            ..Default::default()
        };
        pet::execute_action(&mut conn, &ws, &action, "secretary").unwrap();
        (conn, ws)
    }

    #[test]
    fn chat_retrieval_runs_while_write_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, ws) = file_db_with_note(dir.path());
        let state = AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        assert!(state.has_read_handle(), "파일 DB 면 읽기 연결이 열려야 한다");
        let cfg = read_pet_config(&state.db.lock()).unwrap();
        let search = pet::PetAction {
            action: "search".into(),
            query: Some("부산 여행".into()),
            ..Default::default()
        };

        // 다른 커맨드(자동 저장 등)가 쓰기 잠금을 쥐고 있는 동안 (1b)·(3a) 를 그대로 돌린다.
        let guard = state.db.lock();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let out = state.with_read(|c| {
                    let prompts = compose_chat_prompts(c, &cfg, &ws, "부산 여행 어땠지?", None, &[]);
                    (prompts, pet::action_search_hits(c, &ws, &search))
                });
                let _ = tx.send(out);
            });
            let got = rx.recv_timeout(std::time::Duration::from_secs(10));
            drop(guard); // 실패해도 스레드가 끝나게 — scope 가 join 에서 멈추지 않도록.
            let ((system_prompt, _user_text, _rag_hits), hits) =
                got.expect("쓰기 잠금이 잡혀 있어도 채팅 검색은 기다리지 않아야 한다");
            assert!(system_prompt.contains("부산 여행 계획"), "RAG 근거가 프롬프트에 들어가야 한다");
            let hits = hits.expect("search 액션이면 Some");
            assert!(hits.iter().any(|h| h.title == "부산 여행 계획"));
        });
    }

    #[tokio::test]
    async fn pet_chat_inner_with_read_handle_sees_committed_writes_and_keeps_search_hits() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(dir.path()).unwrap();
        let state = AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        assert!(state.has_read_handle());
        // 읽기 연결을 연 **뒤** 쓰기 연결로 커밋한 노트도 보여야 한다(WAL — 마지막 커밋 상태).
        {
            let mut conn = state.db.lock();
            let ws = pet::active_workspace(&conn).unwrap();
            let action = pet::PetAction {
                action: "create_note".into(),
                text: "해운대에서 부산 여행 일정을 정리했다".into(),
                title: Some("부산 여행 계획".into()),
                ..Default::default()
            };
            pet::execute_action(&mut conn, &ws, &action, "secretary").unwrap();
        }
        let prompts = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let text = CapturingText {
            reply: r#"{"action":"search","query":"부산 여행","text":""}"#.into(),
            system_prompts: Arc::clone(&prompts),
        };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let result = pet_chat_inner(
            "부산 여행 어땠지?".into(),
            None, None, None, None, None, None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        assert_eq!(result.action, "search");
        assert!(result.hits.iter().any(|h| h.title == "부산 여행 계획"), "검색 액션의 근거 노트");
        assert!(prompts.lock()[0].contains("부산 여행 계획"), "(1b) RAG 근거");
        // 턴 저장은 여전히 쓰기 연결로 — 메타에 근거가 남는다.
        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        let messages = pet::recent_messages(&conn, &ws, 10).unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages[1].meta.as_deref().unwrap_or("").contains("부산 여행 계획"));
    }

    #[tokio::test]
    async fn in_memory_db_falls_back_to_write_conn_and_logs_it() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        assert!(!state.has_read_handle(), "인메모리 DB 는 읽기 연결을 열 수 없다");
        assert!(
            crate::diag::recent(500)
                .iter()
                .any(|e| e.feature == "pet" && e.code == "read_conn_unavailable"),
            "폴백은 진단에 남아야 한다(CLAUDE.md 함정 11)"
        );
        let text = CountingText {
            calls: Arc::new(AtomicUsize::new(0)),
            reply: r#"{"action":"search","query":"없는 낱말","text":""}"#.into(),
        };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let result = pet_chat_inner(
            "아무 질문이나 해볼까".into(),
            None, None, None, None, None, None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        assert_eq!(result.action, "search");
        assert_eq!(text.calls.load(Ordering::SeqCst), 1);
    }

    // ── 근거 카드(HANDOFF-2026-10-09 Wave S): 프롬프트에 넣은 RAG 노트가 곧 카드 ──

    /// `compose_system_prompt` 의 RAG 블록 머리줄(행동 규칙 문장에도 "[내 노트]" 낱말이 있어 그걸로는 못 가른다).
    const RAG_BLOCK: &str = "[내 노트] 아래는 사용자의 노트에서 찾은 발췌다";
    const EVIDENCE_Q: &str = "부산 여행 어땠지?";

    /// 파일 DB + 근거 노트 + (선택) chat_read_files=false 로 한 턴을 돌린다. 캡처한 시스템 프롬프트도 돌려준다.
    async fn evidence_turn(
        reply: &str,
        show_evidence: bool,
        read_files: bool,
    ) -> (tempfile::TempDir, AppState, PetChatResult, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let (mut conn, _ws) = file_db_with_note(dir.path());
        if !read_files {
            let mut entries = BTreeMap::new();
            entries.insert("chat_read_files".to_string(), serde_json::json!(false));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let state = AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        let prompts = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let text = CapturingText { reply: reply.into(), system_prompts: Arc::clone(&prompts) };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let result = pet_chat_turn(
            EVIDENCE_Q.into(),
            None, None, None, None, None, None,
            true,
            show_evidence,
            None,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        let captured = prompts.lock().clone();
        (dir, state, result, captured)
    }

    fn assistant_meta_hit_ids(state: &AppState) -> Option<Vec<String>> {
        let conn = state.db.lock();
        let ws = pet::active_workspace(&conn).unwrap();
        let messages = pet::recent_messages(&conn, &ws, 10).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].role, "assistant");
        let meta: serde_json::Value = serde_json::from_str(messages[1].meta.as_deref()?).unwrap();
        Some(
            meta["hits"]
                .as_array()?
                .iter()
                .map(|h| h["note_id"].as_str().unwrap().to_string())
                .collect(),
        )
    }

    #[tokio::test]
    async fn show_evidence_answer_returns_the_injected_rag_notes_and_persists_them() {
        let (_dir, state, result, prompts) =
            evidence_turn(r#"{"action":"answer","text":"해운대 일정을 정리하셨어요"}"#, true, true).await;
        assert_eq!(result.action, "answer");
        // 프롬프트에 넣은 그 노트들 — 같은 질의로 RAG 를 다시 돌린 결과와 같아야 한다(한 번만 검색).
        let expected = state.with_read(|c| {
            let ws = pet::active_workspace(c).unwrap();
            pet::rag_hits(c, &ws, pet::rag_query(EVIDENCE_Q), 4)
        });
        assert!(!expected.is_empty(), "근거 노트가 검색돼야 테스트가 의미 있다");
        assert_eq!(result.hits, expected);
        assert_eq!(prompts.len(), 1);
        for h in &result.hits {
            assert!(prompts[0].contains(&format!("- {}: ", h.title)), "카드 = 프롬프트에 실제로 넣은 노트");
        }
        // 다시 열어도 남는다 — 어시스턴트 행 meta 를 히스토리로 읽어 확인.
        let ids = assistant_meta_hit_ids(&state).expect("meta.hits");
        assert_eq!(ids, expected.iter().map(|h| h.note_id.clone()).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn without_show_evidence_answer_has_no_hits() {
        let (_dir, state, result, prompts) =
            evidence_turn(r#"{"action":"answer","text":"정리하셨어요"}"#, false, true).await;
        assert_eq!(result.action, "answer");
        assert!(result.hits.is_empty());
        assert!(prompts[0].contains(RAG_BLOCK), "RAG 주입은 그대로 — 카드만 안 보낸다");
        assert_eq!(assistant_meta_hit_ids(&state), None);
        drop(state);

        // 옛 시그니처(pet_chat_inner)는 show_evidence=false 와 같다.
        let dir = tempfile::tempdir().unwrap();
        let (conn, _ws) = file_db_with_note(dir.path());
        let state = AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        let text = CapturingText {
            reply: r#"{"action":"answer","text":"정리하셨어요"}"#.into(),
            system_prompts: Arc::new(parking_lot::Mutex::new(Vec::new())),
        };
        let vision = CountingVision { calls: Arc::new(AtomicUsize::new(0)), ok: false };
        let result = pet_chat_inner(
            EVIDENCE_Q.into(),
            None, None, None, None, None, None,
            true,
            &state,
            &text,
            &vision,
        )
        .await
        .unwrap();
        assert!(result.hits.is_empty());
    }

    #[tokio::test]
    async fn chat_read_files_off_sends_no_note_content_and_no_evidence() {
        let (_dir, state, result, prompts) =
            evidence_turn(r#"{"action":"answer","text":"모르겠어요"}"#, true, false).await;
        assert_eq!(result.action, "answer");
        assert!(result.hits.is_empty(), "노트 읽기가 꺼져 있으면 근거 카드도 없다");
        assert!(!prompts[0].contains(RAG_BLOCK), "RAG 블록이 프롬프트에 없어야 한다");
        assert!(!prompts[0].contains("부산 여행 계획"));
        assert!(!prompts[0].contains("해운대"));
        assert_eq!(assistant_meta_hit_ids(&state), None);
    }

    #[tokio::test]
    async fn search_action_hits_are_unchanged_by_show_evidence() {
        let reply = r#"{"action":"search","query":"부산 여행","text":""}"#;
        let (_dir, state, on, _) = evidence_turn(reply, true, true).await;
        let expected = state.with_read(|c| {
            let ws = pet::active_workspace(c).unwrap();
            let action = pet::parse_action(reply);
            pet::action_search_hits(c, &ws, &action).unwrap()
        });
        assert_eq!(on.action, "search");
        assert_eq!(on.hits, expected, "search 액션은 자기 질의로 찾은 hits 그대로");
        // 다른 DB(같은 노트, 다른 id)라 제목·발췌로 비교한다.
        let (_dir2, _state2, off, _) = evidence_turn(reply, false, true).await;
        let strip = |hs: &[pet::PetSearchHit]| {
            hs.iter().map(|h| (h.title.clone(), h.snippet.clone())).collect::<Vec<_>>()
        };
        assert_eq!(strip(&off.hits), strip(&on.hits));
    }

    #[test]
    fn open_read_only_refuses_missing_file_and_does_not_create_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.db");
        assert!(crate::db::open_read_only(&path).is_err());
        assert!(!path.exists(), "읽기 연결은 DB 를 만들면 안 된다");
    }
}
