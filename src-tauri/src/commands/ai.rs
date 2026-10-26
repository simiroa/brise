use crate::commands::AppState;
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::ai::{self, AiOrganizeResult, ConnectionTest};
use crate::repo::{activity, attachments, folders, fts, notes, settings};
use crate::util::{new_id, now_iso, today_ymd_local};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// §6-A 전역 AI 정책 사다리(docs/PLAN-2026-08-30-ai-surface-and-clients.md §2·§6-A) — §2 의
/// 3계층(손질/정돈/수집)과 값이 같다. 여기서는 "이 커맨드가 요구하는 최소 레벨"로 쓴다: 사용자가
/// 정책을 낮추면(=Gather 쪽으로) 그 위 레벨을 요구하는 커맨드는 전부 거부된다. 선언 순서가 곧
/// 랭크다(derive(PartialOrd, Ord) 는 variant 선언 순서를 따른다) — Gather < Refine < Organize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AiPolicyLevel {
    Gather,
    Refine,
    Organize,
}

impl AiPolicyLevel {
    /// 알 수 없는 값(오타·구버전 프런트가 보낸 값)과 결측 키는 전부 Organize(가장 넓음)로
    /// 폴백한다 — settings_schema.rs::default_settings 의 시드값("organize")과 반드시 같아야
    /// 한다("기존 동작 유지, 회귀 없음" 요구).
    fn parse(raw: &str) -> Self {
        match raw {
            "gather" => AiPolicyLevel::Gather,
            "refine" => AiPolicyLevel::Refine,
            _ => AiPolicyLevel::Organize,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            AiPolicyLevel::Gather => "gather",
            AiPolicyLevel::Refine => "refine",
            AiPolicyLevel::Organize => "organize",
        }
    }
}

fn read_ai_policy_level(state: &AppState) -> AppResult<AiPolicyLevel> {
    let conn = state.db.lock();
    let s = settings::get_all(&conn)?;
    Ok(s.get("ai_policy_level")
        .and_then(|v| v.as_str())
        .map(AiPolicyLevel::parse)
        .unwrap_or(AiPolicyLevel::Organize))
}

/// 정책 레벨 검사만 떼어낸 진입점 — `ai_apply_organize`/`ai_apply_plan` 처럼 모델 호출이 없어
/// `ai_gate_and_key` 를 아예 안 타는 커맨드도 이 함수를 직접 부른다. 요구 레벨 인자를
/// `ai_gate_and_key` 한 곳에 붙이는 것만으로는 이 둘을 못 덮으므로(§6-A: "여기에 요구 레벨
/// 인자를 붙여 호출처마다 가드를 흩지 않는다"), 실제 단일 지점은 이 함수다 — `ai_gate_and_key`
/// 도 내부에서 이 함수를 호출한다.
pub(crate) fn require_ai_policy_level(state: &AppState, required: AiPolicyLevel) -> AppResult<()> {
    let current = read_ai_policy_level(state)?;
    if current < required {
        return Err(crate::error::AppError::Validation(format!(
            "action requires AI policy level '{}' or higher, but the current policy is '{}' (Settings > AI Features)",
            required.as_str(),
            current.as_str()
        )));
    }
    Ok(())
}

/// 모든 ai_* 커맨드가 통과하는 단일 지점 — 한 번의 lock 으로 프라이버시 게이트 값(ai_enabled)과
/// api_key 폴백을 함께 해결한다.
///
/// 예전에는 커맨드마다 ai_enabled 만 읽고 api_key 인자는 그대로 흘려보냈다. 그런데 동기화 웹
/// 클라이언트는 보안 하드닝(sync_server::handlers 가 settings 응답에서 ai_api_key 를 제거)
/// 때문에 키를 애초에 받지 못해 항상 None 을 보내고, 그래서 브라우저에서는 AI 가 전부 "키 없음"
/// 으로 실패했다. 키를 원격으로 내려보내는 대신 서버(데스크톱)가 자기 DB 의 키로 대신 호출하게
/// 하는 폴백이다 — 키는 여전히 이 프로세스를 벗어나지 않는다.
///
/// 명시적으로 넘어온 키가 항상 이긴다(데스크톱 웹뷰는 지금까지처럼 인자로 보낸다).
/// 빈 문자열은 "설정 안 함"으로 본다 — migrations.rs 의 시드 기본값이 `""` 이라서
/// 그냥 Some("") 로 넘기면 프로바이더가 빈 Authorization 헤더로 401 을 맞는다.
///
/// `required_level`: 이 커맨드가 요구하는 최소 정책 레벨. `ai_test_connection` 처럼 정책과
/// 무관한 커맨드는 `None` 을 넘겨 이 검사를 건너뛴다(§6-A: "연결 확인·조회는 게이트를 걸지
/// 마라"). 정책 검사는 privacy 게이트(ai_enabled)와 독립이다 — 로컬 Ollama 라도 정책 사다리는
/// 그대로 적용된다.
fn ai_gate_and_key(
    state: &AppState,
    api_key: Option<String>,
    required_level: Option<AiPolicyLevel>,
) -> AppResult<(bool, Option<String>)> {
    if let Some(required) = required_level {
        require_ai_policy_level(state, required)?;
    }
    let conn = state.db.lock();
    let s = settings::get_all(&conn)?;
    let enabled = s.get("ai_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let stored = s.get("ai_api_key").and_then(|v| v.as_str());
    Ok((enabled, pick_api_key(api_key, stored)))
}

/// `ai_model_fallback` — 기본 모델 호출이 재시도할 만한 실패로 끝났을 때 Real*Transport 가 딱 한
/// 번 갈아탈 모델. 프런트는 이 값을 커맨드 인자로 보내지 않는다(모델 설정은 "고급"에 접혀 있고,
/// 폴백은 사용자가 매 호출 고를 성질이 아니다) — 서버가 자기 DB 에서 읽는다. 빈 값은 "설정 안 함"
/// (gemini 는 그때 repo::ai::DEFAULT_GEMINI_FALLBACK_MODEL 로 떨어진다).
pub(crate) fn fallback_model_setting(state: &AppState) -> Option<String> {
    let conn = state.db.lock();
    settings::get_all(&conn)
        .ok()?
        .get("ai_model_fallback")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// ai_gate_and_key 의 결정 규칙만 떼어낸 순수 함수 — DB 없이 테스트하려고 분리했다.
/// 인자 우선, 그 다음 저장된 키, 양쪽 모두 빈 문자열은 "설정 안 함"으로 본다.
fn pick_api_key(arg: Option<String>, stored: Option<&str>) -> Option<String> {
    arg.filter(|k| !k.is_empty())
        .or_else(|| stored.filter(|k| !k.is_empty()).map(str::to_string))
}

// ── AI 정리(organize): propose ↔ apply 분리 (P0-1/P0-2) ─────────────────────────────────────
// ai_organize_note는 이제 "제안만" 한다 — DB에 절대 쓰지 않는다. 사용자가 AiConfirmModal에서
// Apply를 눌러야만 ai_apply_organize가 실제로 커밋한다(Cancel = clearProposal은 아무것도
// 되돌릴 필요가 없다 — 애초에 아무것도 안 바뀌었으므로). 예전엔 여기서 confidence>=0.5면
// 곧장 notes::apply_ai_organize를 호출해 커밋한 뒤 "확인" 모달을 띄웠는데, Cancel에 롤백이
// 없어 모달이 눈속임이었다(P0-2). 그리고 이 함수엔 translate/cleanup/generate와 달리
// 프라이버시 게이트가 아예 없어서 ai_enabled=false여도 노트 본문(최대 8192자)이 클라우드로
// 나갔다(P0-1) — 아래에서 게이트를 다른 세 커맨드와 동일하게 맨 앞에서 검사한다.
// ── AI 정리(organize): propose ↔ apply 분리 (P0-1/P0-2) ─────────────────────────────────────
#[allow(clippy::too_many_arguments)]
pub async fn ai_organize_note_inner<T: ai::TextTransport>(
    id: String,
    fields: Option<Vec<String>>,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    custom_prompt: Option<String>,
    origin: Option<String>,
    state: &AppState,
    transport: &T,
) -> AppResult<AiOrganizeResult> {
    // origin은 감사 배선용 폐쇄 화이트리스트 — 수집 후처리 카드 수락 경로("collect_post_process")
    // 하나만 허용한다. 그 외 값(오타·미래의 지어낸 값)은 조용히 무시하지 않고 즉시 거부해 감사
    // 로그가 알 수 없는 action_type으로 새는 것을 막는다.
    if let Some(o) = origin.as_deref() {
        if o != "collect_post_process" {
            return Err(crate::error::AppError::Validation(format!(
                "unknown origin: {o}"
            )));
        }
    }

    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;

    // organize(제안)는 §6-A 정책 사다리의 최상단(organize) 요구 — 막히면 이걸 재사용하는
    // 자동 후처리(ai_post_process)도 함께 막힌다(의도된 동작, PLAN §6-A).
    let (ai_enabled, api_key) = ai_gate_and_key(state, api_key, Some(AiPolicyLevel::Organize))?;
    if !ai::privacy_gate_ok(&p, &ep, ai_enabled) {
        return Err(crate::error::AppError::Validation(
            "cloud AI requires ai_enabled (Settings > AI)".to_string(),
        ));
    }

    let (body_md, folder_candidates, candidate_tags, workspace_id, folder_rules) = {
        let conn = state.db.lock();
        let detail = notes::note_detail(&conn, &id)?;
        let folder_ai_excluded: bool = conn
            .query_row(
                "SELECT ai_excluded FROM folders WHERE id=?1",
                [&detail.note.folder_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(crate::error::db)?
            .map(|v| v != 0)
            .unwrap_or(false);
        if folder_ai_excluded {
            return Err(crate::error::AppError::Validation(
                "folder is excluded from AI (ai_excluded)".to_string(),
            ));
        }
        let mut body = String::new();
        for sec in detail.sections {
            // 시트 섹션은 JSON 이 아니라 TSV 로 모델에 준다 (specs/features/sheet.md: "AI 컨텍스트도 TSV").
            body.push_str(&crate::repo::sheet::section_text(
                &sec.body_md,
                &sec.kind,
                Some(crate::repo::sheet::FTS_MAX_ROWS),
            ));
            body.push('\n');
        }
        // 확장 2(FOLDER INFERENCE): 노트가 속한 워크스페이스의 폴더 전체를 후보로 준다 — 모델은
        // 이 목록 밖의 이름을 지어낼 수 없고(system prompt 지시), 그래도 지어내면
        // resolve_folder_name이 서버 측에서 걸러낸다(아래).
        let workspace_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&detail.note.folder_id],
                |r| r.get(0),
            )
            .map_err(crate::error::db)?;
        let folder_rules: Option<String> = conn
            .query_row(
                "SELECT rules FROM folders WHERE id=?1",
                [&detail.note.folder_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(crate::error::db)?
            .flatten();
        let candidates: Vec<(String, String)> = folders::list_meta(&conn, Some(workspace_id.clone()))?
            .folders
            .into_iter()
            .map(|f| (f.id, f.name))
            .collect();
        // 노트북(=workspace) 태그 어휘: 사용 빈도 상위 AI_TAG_VOCAB_CAP개 — 프롬프트에 후보로
        // 넣어 기존 태그를 우선 재사용하게 한다(동률은 이름 오름차순, tag_vocabulary_top).
        let counts = notes::tag_counts(&conn, &workspace_id)?;
        let tag_vocab = ai::tag_vocabulary_top(&counts, ai::AI_TAG_VOCAB_CAP);
        (body, candidates, tag_vocab, workspace_id, folder_rules)
    };

    let requested_fields = fields.unwrap_or_else(|| vec!["title".into(), "tags".into(), "year".into(), "region".into(), "folder".into()]);
    let candidate_names: Vec<String> = folder_candidates.iter().map(|(_, name)| name.clone()).collect();
    let merged_prompt = ai::merge_organize_guidance(custom_prompt.as_deref(), folder_rules.as_deref());
    let proposal = match ai::propose_with_transport(
        p,
        ep,
        api_key,
        model,
        body_md,
        candidate_names,
        candidate_tags,
        merged_prompt,
        transport,
    )
    .await {
        Ok(proposal) => {
            record_ai_audit(
                state,
                Some(&workspace_id),
                Some(&id),
                origin_audit_event(&origin, ai::AiAuditEvent::OrganizeProposed),
                Some("metadata proposal"),
                "[metadata proposal completed]",
            );
            proposal
        }
        Err(error) => {
            let summary = ai::summarize_error_for_history(&error);
            record_ai_audit(
                state,
                Some(&workspace_id),
                Some(&id),
                origin_audit_event(&origin, ai::AiAuditEvent::OrganizeFailed),
                Some("metadata proposal"),
                &summary,
            );
            return Err(error);
        }
    };

    let want_title = requested_fields.iter().any(|f| f == "title");
    let want_year = requested_fields.iter().any(|f| f == "year");
    let want_tags = requested_fields.iter().any(|f| f == "tags");
    let want_region = requested_fields.iter().any(|f| f == "region");
    let want_folder = requested_fields.iter().any(|f| f == "folder");

    let title = if want_title { proposal.title } else { None };
    let year = if want_year { proposal.year } else { None };
    let tag_names = if want_tags { proposal.tags } else { None };
    let region = if want_region { proposal.region } else { None };
    let mut lat = proposal.lat;
    let mut lng = proposal.lng;

    // Region research & geocode path
    if want_region {
        if let Some(ref reg_str) = region {
            if !reg_str.trim().is_empty() && (lat.is_none() || lng.is_none()) {
                if let Ok(geo_results) = crate::repo::geocode::geocode_search(reg_str, None).await {
                    if let Some(first) = geo_results.first() {
                        lat = Some(first.lat);
                        lng = Some(first.lng);
                    }
                }
            }
        }
    }

    let (folder_id, folder_name) = if want_folder {
        match proposal.folder {
            Some(raw) => match ai::resolve_folder_name(&raw, &folder_candidates) {
                Some((id, name)) => (Some(id), Some(name)),
                None => (None, None), // 지어낸 이름/오타 — 조용히 "제안 없음"으로
            },
            None => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(AiOrganizeResult {
        title,
        year,
        tag_names,
        region,
        folder_id,
        folder_name,
        lat,
        lng,
        source_urls: proposal.source_urls,
        confidence: proposal.confidence,
    })
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn ai_organize_note(
    id: String,
    fields: Option<Vec<String>>,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    custom_prompt: Option<String>,
    origin: Option<String>,
    request_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<AiOrganizeResult> {
    let fallback_model = fallback_model_setting(&state);
    let transport = ai::RealTextTransport::new(fallback_model);
    // PLAN-2026-09-05 §3 C-1: 이 커맨드 본문 전체(트랜스포트 호출까지 같은 태스크 안에서 이어짐 —
    // 아래 어디에도 tokio::spawn 이 없다)를 with_call_ctx 로 감싼다. call_log::begin 이 이 값을
    // 읽어 op/caller/note_id 를 채운다.
    // AUDIT-2026-09-05-ai-guard-friction §2-4(권장 6): 배치 정리(AiBatchOrganizeModal)가 한
    // 배치를 하나의 request_id로 묶어 [중단] 시 ai_cancel_call{request_id}로 진행 중 호출을
    // 실제로 끊을 수 있게 한다 — ai_generate_from_prompt 등 다른 세 커맨드와 동일한 배선.
    let ctx = ai::call_log::CallCtx {
        op: Some("organize".to_string()),
        caller: Some("ai_organize_note".to_string()),
        note_id: Some(id.clone()),
        request_id,
    };
    ai::call_log::with_call_ctx(
        ctx,
        ai_organize_note_inner(id, fields, provider, endpoint, api_key, model, custom_prompt, origin, &state, &transport),
    )
    .await
}

/// origin="collect_post_process" 호출은 성공/실패 모두 `default`(organize.proposed/failed) 대신
/// 단일 `AiAuditEvent::CollectPostProcess`로 기록된다 — ai_organize_note_inner 진입부의 화이트리스트
/// 검증을 이미 통과했으므로 여기선 "collect_post_process"인지만 다시 본다.
fn origin_audit_event(origin: &Option<String>, default: ai::AiAuditEvent) -> ai::AiAuditEvent {
    match origin.as_deref() {
        Some("collect_post_process") => ai::AiAuditEvent::CollectPostProcess,
        _ => default,
    }
}

/// ai_apply_organize의 반환 타입 — 실제로 변경된 필드 목록만 담는다.
#[derive(Debug, Serialize)]
pub struct AiApplyOrganizeResult {
    pub applied: Vec<String>,
}

fn normalize_blank(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// W6: folder name for the `organize.applied` history line (best-effort — a missing/renamed-away
/// folder falls back to a placeholder rather than failing the whole apply). Capped like
/// `summarize_error_for_history`'s error text so a pathological name can't bloat `ai_history`.
const FOLDER_HISTORY_NAME_CAP: usize = 60;

fn folder_display_name(tx: &Transaction, folder_id: &str) -> String {
    let name: Option<String> = tx
        .query_row("SELECT name FROM folders WHERE id=?1", [folder_id], |row| row.get(0))
        .optional()
        .ok()
        .flatten();
    match name {
        Some(n) => {
            let truncated: String = n.chars().take(FOLDER_HISTORY_NAME_CAP).collect();
            if n.chars().count() > FOLDER_HISTORY_NAME_CAP { format!("{truncated}…") } else { truncated }
        }
        None => "?".to_string(),
    }
}

fn workspace_for_note(conn: &rusqlite::Connection, note_id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT f.workspace_id FROM notes n JOIN folders f ON f.id=n.folder_id WHERE n.id=?1",
        [note_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(dberr)?
    .ok_or_else(|| AppError::NotFound(format!("note not found: {note_id}")))
}

fn active_workspace_id(state: &AppState) -> Option<String> {
    let conn = state.db.lock();
    folders::active_workspace_id(&conn).ok()
}

/// Audit persistence is intentionally best-effort for AI requests: a durable history failure
/// must not turn a successful provider response into an error, and must never replace the
/// provider error a caller needs to handle. User-approved mutations call ai::record_history(&tx, ..)
/// directly inside their own transaction instead (Transaction derefs to Connection).
fn record_ai_audit(
    state: &AppState,
    workspace_id: Option<&str>,
    note_id: Option<&str>,
    event: ai::AiAuditEvent,
    input: Option<&str>,
    result: &str,
) {
    let workspace_id = workspace_id.map(str::to_string).or_else(|| active_workspace_id(state));
    let Some(workspace_id) = workspace_id else { return; };
    let conn = state.db.lock();
    let _ = ai::record_history(&conn, &workspace_id, note_id, event.action_type(), input, result);
}

/// I2(PLAN-2026-09-05 §5-8 업그레이드 경로) — `clear_fields`가 받아들이는 값. `title`은 여기 없다:
/// `apply_ai_organize_in_tx`는 title을 그대로 저장하고(정규화 없음) 빈 문자열도 유효한 값이라
/// `title: Some("")`을 그냥 보내면 이미 지워진다 — 별도 clear 시맨틱이 필요 없다(commands/ai.rs
/// 헤더 보고 참고). `source_urls`도 여기 없다: "전부 지움"이 아니라 "이 URL들을 지움"이 필요해서
/// 별도 `remove_source_urls` 입력으로 분리했다(add_link_if_absent_tx의 짝).
const CLEARABLE_FIELDS: [&str; 3] = ["location", "region", "year"];

/// Validate every proposed value before opening the write transaction. This deliberately treats
/// an invalid URL as an error rather than silently skipping it: partial user-approved metadata is
/// harder to reason about than a clear retryable validation error.
#[allow(clippy::too_many_arguments)]
fn validate_metadata_apply(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    folder_id: Option<&str>,
    year: Option<i64>,
    region: Option<&str>,
    lat: Option<f64>,
    lng: Option<f64>,
    source_urls: Option<&[String]>,
    clear_fields: Option<&[String]>,
    remove_source_urls: Option<&[String]>,
) -> AppResult<()> {
    if let Some(folder_id) = folder_id {
        let folder_workspace: Option<String> = conn
            .query_row("SELECT workspace_id FROM folders WHERE id=?1", [folder_id], |row| row.get(0))
            .optional()
            .map_err(dberr)?;
        match folder_workspace {
            None => return Err(AppError::NotFound(format!("folder not found: {folder_id}"))),
            Some(found) if found != workspace_id => return Err(AppError::Validation("folder must belong to the note workspace".to_string())),
            Some(_) => {}
        }
    }
    match (lat, lng) {
        (None, None) => {}
        (Some(lat), Some(lng)) if lat.is_finite() && lng.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng) => {}
        (Some(_), Some(_)) => return Err(AppError::Validation("location is outside valid latitude/longitude bounds".to_string())),
        _ => return Err(AppError::Validation("both lat and lng must be provided together".to_string())),
    }
    if let Some(urls) = source_urls {
        for url in urls {
            if !attachments::is_safe_link_url(url.trim()) {
                return Err(AppError::Validation(format!("invalid url: {}", url.trim())));
            }
        }
    }
    if let Some(fields) = clear_fields {
        for f in fields {
            if !CLEARABLE_FIELDS.contains(&f.as_str()) {
                return Err(AppError::Validation(format!(
                    "unknown clear_fields value: {f} (expected one of {CLEARABLE_FIELDS:?})"
                )));
            }
        }
        if fields.iter().any(|f| f == "location") && (lat.is_some() || lng.is_some()) {
            return Err(AppError::Validation("clear_fields has 'location' but lat/lng was also provided".to_string()));
        }
        if fields.iter().any(|f| f == "region") && region.is_some() {
            return Err(AppError::Validation("clear_fields has 'region' but region was also provided".to_string()));
        }
        if fields.iter().any(|f| f == "year") && year.is_some() {
            return Err(AppError::Validation("clear_fields has 'year' but year was also provided".to_string()));
        }
    }
    if let Some(remove_urls) = remove_source_urls {
        for url in remove_urls {
            if !attachments::is_safe_link_url(url.trim()) {
                return Err(AppError::Validation(format!("invalid url: {}", url.trim())));
            }
        }
        if let Some(add_urls) = source_urls {
            let removing: HashSet<&str> = remove_urls.iter().map(|u| u.trim()).collect();
            if add_urls.iter().any(|u| removing.contains(u.trim())) {
                return Err(AppError::Validation("source_urls and remove_source_urls must not share a url".to_string()));
            }
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn ai_apply_organize(
    id: String,
    title: Option<String>,
    year: Option<i64>,
    tag_names: Option<Vec<String>>,
    region: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    source_urls: Option<Vec<String>>,
    folder_id: Option<String>,
    clear_fields: Option<Vec<String>>,
    remove_source_urls: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> AppResult<AiApplyOrganizeResult> {
    ai_apply_organize_inner(id, title, year, tag_names, region, lat, lng, source_urls, folder_id, clear_fields, remove_source_urls, &state)
}

#[allow(clippy::too_many_arguments)]
pub fn ai_apply_organize_inner(
    id: String,
    title: Option<String>,
    year: Option<i64>,
    tag_names: Option<Vec<String>>,
    region: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    source_urls: Option<Vec<String>>,
    folder_id: Option<String>,
    clear_fields: Option<Vec<String>>,
    remove_source_urls: Option<Vec<String>>,
    state: &AppState,
) -> AppResult<AiApplyOrganizeResult> {
    // §6-A: ai_apply_organize 는 모델을 호출하지 않아 ai_gate_and_key 를 안 탄다 — 같은
    // require_ai_policy_level 을 여기서 직접 부른다(단일 판정 지점 재사용, 두 번째 지점을 새로
    // 만들지 않는다).
    require_ai_policy_level(state, AiPolicyLevel::Organize)?;
    let mut conn = state.db.lock();
    let current = notes::note_summary(&conn, &id)?;
    let workspace_id = workspace_for_note(&conn, &id)?;
    validate_metadata_apply(
        &conn,
        &workspace_id,
        folder_id.as_deref(),
        year,
        region.as_deref(),
        lat,
        lng,
        source_urls.as_deref(),
        clear_fields.as_deref(),
        remove_source_urls.as_deref(),
    )?;

    let tx = conn.transaction().map_err(dberr)?;
    let mut applied = notes::apply_ai_organize_in_tx(&tx, &current, title, year, tag_names)?;
    let now = now_iso();
    // W6 (§1.5 진짜 갭): folder move captured here for the history line below — not the note
    // body/title, just which of the user's OWN pre-existing folders it left and entered
    // (docs/AI.md §3.1: AI folder suggestions only ever name an existing folder). Kept out of
    // invariant_ai_history_audit.rs's "no private content" scope on that basis.
    let mut folder_move: Option<(String, String)> = None;
    if let Some(fid) = folder_id.filter(|fid| fid != &current.folder_id) {
        tx.execute("UPDATE notes SET folder_id=?1, updated_at=?2 WHERE id=?3", params![fid, now, id]).map_err(dberr)?;
        applied.push("folder".to_string());
        let from_name = folder_display_name(&tx, &current.folder_id);
        let to_name = folder_display_name(&tx, &fid);
        folder_move = Some((from_name, to_name));
    }
    if let Some(reg) = region {
        let normalized = normalize_blank(&reg);
        if current.region != normalized {
            tx.execute("UPDATE notes SET region=?1, updated_at=?2 WHERE id=?3", params![normalized, now_iso(), id]).map_err(dberr)?;
            applied.push("region".to_string());
        }
    }
    if let (Some(la), Some(ln)) = (lat, lng) {
        if current.lat != Some(la) || current.lng != Some(ln) {
            tx.execute("UPDATE notes SET lat=?1, lng=?2, updated_at=?3 WHERE id=?4", params![la, ln, now_iso(), id]).map_err(dberr)?;
            applied.push("location".to_string());
        }
    }
    if let Some(urls) = source_urls {
        let mut saw = HashSet::new();
        let mut inserted = false;
        for url in urls {
            let url = url.trim().to_string();
            if saw.insert(url.clone()) && attachments::add_link_if_absent_tx(&tx, &id, &url)? {
                inserted = true;
            }
        }
        if inserted { applied.push("attachments".to_string()); }
    }
    // I2(PLAN-2026-09-05 §5-8 업그레이드 경로) — 명시적 지우기. `region`/`lat`·`lng`/`source_urls`
    // 의 "생략=미변경" 관례로는 표현 못 하던 "빈 값에서 채운 좌표"와 "추가된 출처 링크"의 되돌리기를
    // 여기서 완성한다. `validate_metadata_apply`가 이미 같은 필드의 값 입력과 충돌하지 않음을
    // 보장했으므로 여기서는 순수하게 적용만 한다.
    if let Some(fields) = &clear_fields {
        if fields.iter().any(|f| f == "region") && current.region.is_some() {
            tx.execute("UPDATE notes SET region=NULL, updated_at=?1 WHERE id=?2", params![now_iso(), id]).map_err(dberr)?;
            applied.push("region_cleared".to_string());
        }
        if fields.iter().any(|f| f == "location") && (current.lat.is_some() || current.lng.is_some()) {
            tx.execute("UPDATE notes SET lat=NULL, lng=NULL, updated_at=?1 WHERE id=?2", params![now_iso(), id]).map_err(dberr)?;
            applied.push("location_cleared".to_string());
        }
        if fields.iter().any(|f| f == "year") && current.year != 0 {
            // W1 투영 규율(repo::notes::update/apply_ai_organize 과 같은 이유): notes.year 는
            // position=0 note_dates 행의 사본이라, 여기서 직접 0 을 써도 다음 날짜 mutation 의
            // project_primary 가 옛 연도로 되돌려 놓는다.
            tx.execute(
                "UPDATE note_dates SET year=0 WHERE note_id=?1 AND position=0",
                params![id],
            )
            .map_err(dberr)?;
            crate::repo::notes::dates::project_primary(&tx, &id)?;
            applied.push("year_cleared".to_string());
        }
    }
    if let Some(remove_urls) = remove_source_urls {
        let mut seen = HashSet::new();
        let mut removed_any = false;
        for url in remove_urls {
            let url = url.trim().to_string();
            if seen.insert(url.clone()) && notes::remove_link_by_url_tx(&tx, &id, &url)? {
                removed_any = true;
            }
        }
        if removed_any { applied.push("attachments_removed".to_string()); }
    }
    let result_text = match &folder_move {
        Some((from, to)) => format!("[metadata applied · {} fields · folder: \"{from}\" → \"{to}\"]", applied.len()),
        None => format!("[metadata applied · {} fields]", applied.len()),
    };
    ai::record_history(
        &tx,
        &workspace_id,
        Some(&id),
        ai::AiAuditEvent::OrganizeApplied.action_type(),
        Some("metadata proposal"),
        &result_text,
    )?;
    tx.commit().map_err(dberr)?;

    crate::events::publish(Some(&id), false);
    Ok(AiApplyOrganizeResult { applied })
}

// ── Agent-plan apply: a narrow, durable mutation boundary ────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPlanActionKind {
    CreateNote,
    UpdateNote,
    DeleteNote,
    MergeNotes,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiPlanActionPayload {
    pub note_id: Option<String>,
    pub source_note_ids: Option<Vec<String>>,
    pub title: Option<String>,
    pub body_md: Option<String>,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiPlanAction {
    pub action_id: String,
    pub kind: AiPlanActionKind,
    pub payload: AiPlanActionPayload,
}

/// App-hydrated plan scope. Model output never supplies this: it proves which current notes and
/// folders the user reviewed, and makes an old plan fail closed if its target changes meanwhile.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiPlanScope {
    pub note_revisions: HashMap<String, String>,
    pub note_folder_ids: HashMap<String, String>,
    pub folder_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPlanActionStatus {
    Applied,
    AlreadyApplied,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiPlanActionResult {
    pub action_id: String,
    pub status: AiPlanActionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn validate_execution_key(label: &str, value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(AppError::Validation(format!("{label} must be 1..=128 characters")));
    }
    Ok(())
}

fn receipt_for(
    conn: &rusqlite::Connection,
    execution_id: &str,
    action_id: &str,
) -> AppResult<Option<(String, String, Option<String>, Option<String>)>> {
    conn.query_row(
        "SELECT payload_hash, status, note_id, error FROM ai_plan_action_receipts WHERE execution_id=?1 AND action_id=?2",
        params![execution_id, action_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .optional()
    .map_err(dberr)
}

fn record_failed_receipt(
    conn: &rusqlite::Connection,
    execution_id: &str,
    action_id: &str,
    payload_hash: &str,
    error: &AppError,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO ai_plan_action_receipts(execution_id, action_id, payload_hash, status, note_id, error, created_at)
         VALUES (?1, ?2, ?3, 'failed', NULL, ?4, ?5)
         ON CONFLICT(execution_id, action_id) DO UPDATE SET
           status='failed', note_id=NULL, error=excluded.error, created_at=excluded.created_at",
        params![execution_id, action_id, payload_hash, error.to_string(), now_iso()],
    )
    .map_err(dberr)?;
    Ok(())
}

fn action_payload_hash(action: &AiPlanAction) -> AppResult<String> {
    let canonical = serde_json::to_vec(action)
        .map_err(|error| AppError::Validation(format!("could not serialize plan action: {error}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical);
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_scoped_folder_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    scope: &AiPlanScope,
    folder_id: &str,
) -> AppResult<()> {
    if !scope.folder_ids.iter().any(|id| id == folder_id) {
        return Err(AppError::Validation("plan folder is outside the approved scope".to_string()));
    }
    let actual_workspace: Option<String> = tx
        .query_row("SELECT workspace_id FROM folders WHERE id=?1", [folder_id], |row| row.get(0))
        .optional()
        .map_err(dberr)?;
    match actual_workspace {
        None => Err(AppError::NotFound(format!("folder not found: {folder_id}"))),
        Some(actual) if actual != workspace_id => Err(AppError::Validation("plan folder is outside the approved workspace".to_string())),
        Some(_) => Ok(()),
    }
}

fn validate_scoped_note_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    scope: &AiPlanScope,
    note_id: &str,
) -> AppResult<()> {
    let expected_revision = scope.note_revisions.get(note_id)
        .ok_or_else(|| AppError::Validation("plan note is outside the approved scope".to_string()))?;
    let expected_folder = scope.note_folder_ids.get(note_id)
        .ok_or_else(|| AppError::Validation("plan note folder is outside the approved scope".to_string()))?;
    let row: Option<(String, String, String)> = tx.query_row(
        "SELECT n.updated_at, n.folder_id, f.workspace_id FROM notes n JOIN folders f ON f.id=n.folder_id WHERE n.id=?1",
        [note_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(dberr)?;
    let Some((actual_revision, actual_folder, actual_workspace)) = row else {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    };
    if actual_workspace != workspace_id {
        return Err(AppError::Validation("plan note is outside the approved workspace".to_string()));
    }
    if &actual_revision != expected_revision || &actual_folder != expected_folder {
        return Err(AppError::Conflict("plan is stale; note changed after review".to_string()));
    }
    Ok(())
}

fn require_body<'a>(payload: &'a AiPlanActionPayload, kind: &str) -> AppResult<&'a str> {
    payload.body_md.as_deref().ok_or_else(|| AppError::Validation(format!("{kind} requires body_md")))
}

fn require_note_id<'a>(payload: &'a AiPlanActionPayload, kind: &str) -> AppResult<&'a str> {
    payload.note_id.as_deref().filter(|id| !id.trim().is_empty())
        .ok_or_else(|| AppError::Validation(format!("{kind} requires note_id")))
}

fn create_plan_note_tx(
    tx: &Transaction<'_>,
    folder_id: &str,
    title: Option<&str>,
    body_md: &str,
) -> AppResult<String> {
    let note_id = new_id();
    let now = now_iso();
    let (year, month, day) = today_ymd_local();
    tx.execute(
        "INSERT INTO notes(id, folder_id, title, year, month, day, is_favorite, exported_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7)",
        params![note_id, folder_id, title.unwrap_or("Untitled Note"), year, month, day, now],
    ).map_err(dberr)?;
    // PLAN-2026-09-08-dates-rebuild.md W1: 이 경로도 노트 생성 경로다 — position=0 행을 함께 심는다
    // (repo::notes::create_with_sections_with_hook 과 동일 이유, repo::notes::dates::insert_primary_row).
    crate::repo::notes::dates::insert_primary_row(
        tx, &note_id, year, Some(month), Some(day), None, None, None, None, None, false, None, None, &now,
    )?;
    tx.execute(
        "INSERT INTO sections(id, note_id, name, body_md, position, updated_at)
         VALUES (?1, ?2, 'Overview', ?3, 0, ?4)",
        params![new_id(), note_id, body_md, now],
    ).map_err(dberr)?;
    fts::fts_upsert(tx, &note_id)?;
    Ok(note_id)
}

fn apply_plan_action(
    conn: &mut rusqlite::Connection,
    workspace_id: &str,
    scope: &AiPlanScope,
    execution_id: &str,
    payload_hash: &str,
    action: &AiPlanAction,
) -> AppResult<String> {
    validate_execution_key("execution_id", execution_id)?;
    validate_execution_key("action_id", &action.action_id)?;

    // Every scope check happens after the transaction has started. The DB mutex excludes local
    // writers while this command runs, and this second boundary keeps future callers from
    // accidentally validating a stale plan outside its mutation transaction.
    let tx = conn.transaction().map_err(dberr)?;
    let workspace_exists: bool = tx.query_row("SELECT 1 FROM workspaces WHERE id=?1", [workspace_id], |_| Ok(true))
        .optional().map_err(dberr)?.unwrap_or(false);
    if !workspace_exists {
        return Err(AppError::NotFound(format!("workspace not found: {workspace_id}")));
    }
    let audit_note_id = match action.kind {
        AiPlanActionKind::CreateNote => {
            let folder_id = action.payload.folder_id.as_deref().filter(|id| !id.trim().is_empty())
                .ok_or_else(|| AppError::Validation("create_note requires folder_id".to_string()))?;
            require_body(&action.payload, "create_note")?;
            validate_scoped_folder_tx(&tx, workspace_id, scope, folder_id)?;
            None
        }
        AiPlanActionKind::UpdateNote | AiPlanActionKind::DeleteNote => {
            let note_id = require_note_id(&action.payload, match action.kind { AiPlanActionKind::UpdateNote => "update_note", _ => "delete_note" })?;
            validate_scoped_note_tx(&tx, workspace_id, scope, note_id)?;
            if matches!(action.kind, AiPlanActionKind::UpdateNote) && action.payload.title.is_none() && action.payload.body_md.is_none() {
                return Err(AppError::Validation("update_note requires title or body_md".to_string()));
            }
            Some(note_id.to_string())
        }
        AiPlanActionKind::MergeNotes => {
            let sources = action.payload.source_note_ids.as_deref().unwrap_or_default();
            if sources.len() < 2 || sources.iter().collect::<HashSet<_>>().len() != sources.len() {
                return Err(AppError::Validation("merge_notes requires at least two distinct source_note_ids".to_string()));
            }
            let folder_id = action.payload.folder_id.as_deref().filter(|id| !id.trim().is_empty())
                .ok_or_else(|| AppError::Validation("merge_notes requires folder_id".to_string()))?;
            require_body(&action.payload, "merge_notes")?;
            validate_scoped_folder_tx(&tx, workspace_id, scope, folder_id)?;
            for source_id in sources {
                validate_scoped_note_tx(&tx, workspace_id, scope, source_id)?;
            }
            sources.first().cloned()
        }
    };
    let note_id = match action.kind {
        AiPlanActionKind::CreateNote => {
            let note_id = create_plan_note_tx(
                &tx,
                action.payload.folder_id.as_deref().unwrap(),
                action.payload.title.as_deref(),
                action.payload.body_md.as_deref().unwrap(),
            )?;
            activity::record_tx(
                &tx,
                &workspace_id,
                Some(&note_id),
                activity::KIND_CREATE,
                action.payload.title.as_deref().unwrap_or("Untitled Note"),
                None,
            )?;
            note_id
        }
        AiPlanActionKind::UpdateNote => {
            let note_id = action.payload.note_id.as_deref().unwrap();
            let current_title: String = tx.query_row("SELECT title FROM notes WHERE id=?1", [note_id], |row| row.get(0)).map_err(dberr)?;
            let current_section: (String, String) = tx.query_row(
                "SELECT id, body_md FROM sections WHERE note_id=?1 ORDER BY position LIMIT 1", [note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(dberr)?.ok_or_else(|| AppError::Validation("update_note requires an existing section".to_string()))?;
            let title_changed = action.payload.title.as_deref().is_some_and(|title| title != current_title);
            let body_changed = action.payload.body_md.as_deref().is_some_and(|body| body != current_section.1);
            // 한 동작 = 한 시각. 예전엔 now_iso() 를 쓰기마다 따로 불러 제목·본문·노트 시각이 어긋났다.
            let now = now_iso();
            if title_changed {
                tx.execute("UPDATE notes SET title=?1, updated_at=?2 WHERE id=?3", params![action.payload.title.as_deref(), now, note_id]).map_err(dberr)?;
            }
            if let Some(body) = action.payload.body_md.as_deref().filter(|_| body_changed) {
                crate::repo::sections::write_body_tx(&tx, note_id, &current_section.0, body, &now)?;
            }
            if title_changed || body_changed { fts::fts_upsert(&tx, note_id)?; }
            if body_changed {
                let activity_title = action.payload.title.as_deref().unwrap_or(&current_title);
                activity::record_tx(&tx, &workspace_id, Some(note_id), activity::KIND_EDIT, activity_title, None)?;
            }
            note_id.to_string()
        }
        AiPlanActionKind::DeleteNote => {
            let note_id = action.payload.note_id.as_deref().unwrap();
            let title: String = tx.query_row("SELECT title FROM notes WHERE id=?1", [note_id], |row| row.get(0)).map_err(dberr)?;
            tx.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![now_iso(), note_id]).map_err(dberr)?;
            fts::fts_delete(&tx, note_id)?;
            activity::record_tx(&tx, &workspace_id, Some(note_id), activity::KIND_DELETE, &title, None)?;
            note_id.to_string()
        }
        AiPlanActionKind::MergeNotes => {
            let note_id = create_plan_note_tx(
                &tx,
                action.payload.folder_id.as_deref().unwrap(),
                action.payload.title.as_deref(),
                action.payload.body_md.as_deref().unwrap(),
            )?;
            activity::record_tx(
                &tx,
                &workspace_id,
                Some(&note_id),
                activity::KIND_CREATE,
                action.payload.title.as_deref().unwrap_or("Untitled Note"),
                None,
            )?;
            for source_id in action.payload.source_note_ids.as_deref().unwrap() {
                let title: String = tx.query_row("SELECT title FROM notes WHERE id=?1", [source_id], |row| row.get(0)).map_err(dberr)?;
                tx.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![now_iso(), source_id]).map_err(dberr)?;
                fts::fts_delete(&tx, source_id)?;
                activity::record_tx(&tx, &workspace_id, Some(source_id), activity::KIND_DELETE, &title, None)?;
            }
            note_id
        }
    };
    tx.execute(
        "INSERT INTO ai_plan_action_receipts(execution_id, action_id, payload_hash, status, note_id, error, created_at)
         VALUES (?1, ?2, ?3, 'applied', ?4, NULL, ?5)
         ON CONFLICT(execution_id, action_id) DO UPDATE SET
           status='applied', note_id=excluded.note_id, error=NULL, created_at=excluded.created_at",
        params![execution_id, action.action_id, payload_hash, note_id, now_iso()],
    ).map_err(dberr)?;
    ai::record_history(
        &tx,
        workspace_id,
        audit_note_id.as_deref(),
        ai::AiAuditEvent::PlanApplied.action_type(),
        None,
        &format!("[plan action applied · {:?}]", action.kind),
    )?;
    tx.commit().map_err(dberr)?;
    Ok(note_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_apply_plan(
    workspace_id: String,
    scope: AiPlanScope,
    execution_id: String,
    actions: Vec<AiPlanAction>,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<AiPlanActionResult>> {
    ai_apply_plan_inner(workspace_id, scope, execution_id, actions, &state)
}

pub fn ai_apply_plan_inner(
    workspace_id: String,
    scope: AiPlanScope,
    execution_id: String,
    actions: Vec<AiPlanAction>,
    state: &AppState,
) -> AppResult<Vec<AiPlanActionResult>> {
    // §6-A: ai_apply_plan 도 모델을 호출하지 않아 ai_gate_and_key 를 안 탄다 — 같은 이유로 직접
    // 호출한다. http:false(specs/commands/ai.yaml) 라 sync_server 로는 원래도 원격 호출이
    // 불가능하지만, 로컬(데스크톱 IPC)에서는 여전히 도달 가능하므로 정책은 여기서도 지킨다.
    require_ai_policy_level(state, AiPolicyLevel::Organize)?;
    validate_execution_key("execution_id", &execution_id)?;
    let mut conn = state.db.lock();
    let mut results = Vec::with_capacity(actions.len());
    for action in actions {
        validate_execution_key("action_id", &action.action_id)?;
        let payload_hash = action_payload_hash(&action)?;
        if let Some((stored_hash, status, note_id, error)) = receipt_for(&conn, &execution_id, &action.action_id)? {
            if stored_hash != payload_hash {
                return Err(AppError::Conflict("plan action id was reused with a different payload".to_string()));
            }
            if status != "applied" {
                // Failure receipts preserve observability, but the identical payload is
                // retryable after a transient external condition is removed. A changed payload
                // above is CONFLICT and must receive a new action id after fresh review.
            } else {
            results.push(AiPlanActionResult {
                action_id: action.action_id,
                status: AiPlanActionStatus::AlreadyApplied,
                note_id,
                error,
            });
            continue;
            }
        }
        match apply_plan_action(&mut conn, &workspace_id, &scope, &execution_id, &payload_hash, &action) {
            Ok(note_id) => {
                crate::events::publish(Some(&note_id), false);
                results.push(AiPlanActionResult { action_id: action.action_id, status: AiPlanActionStatus::Applied, note_id: Some(note_id), error: None });
            }
            Err(error) => {
                record_failed_receipt(&conn, &execution_id, &action.action_id, &payload_hash, &error)?;
                results.push(AiPlanActionResult { action_id: action.action_id, status: AiPlanActionStatus::Failed, note_id: None, error: Some(error.to_string()) });
            }
        }
    }
    Ok(results)
}

// P1 security fix: every sibling ai_* command (organize/translate/cleanup/generate) calls
// ai::privacy_gate_ok(&p, &ep, ai_enabled) before making a network call — this one didn't. Since
// it's http:true, it's reachable via POST /api/v1/invoke with just the sync token, and it makes
// an arbitrary outbound GET/POST from the desktop with no gate at all — a port-scan/metadata-
// oracle SSRF primitive. Split into a network-free gate check (ai_test_connection_gate, directly
// unit-testable — the whole point is that it must return before any network call happens) and the
// thin command wrapper that reads ai_enabled from settings, exactly like the sibling commands do.
fn ai_test_connection_gate(provider: &ai::Provider, endpoint: &str, ai_enabled: bool) -> AppResult<()> {
    if !ai::privacy_gate_ok(provider, endpoint, ai_enabled) {
        return Err(crate::error::AppError::Validation(
            "cloud AI requires ai_enabled (Settings > AI)".to_string(),
        ));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_test_connection(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<ConnectionTest> {
    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;

    // 정책과 무관한 커맨드(§6-A) — 연결 확인일 뿐 손질/정돈/수집 어느 것도 수행하지 않는다.
    let (ai_enabled, api_key) = ai_gate_and_key(&state, api_key, None)?;
    ai_test_connection_gate(&p, &ep, ai_enabled)?;

    ai::test_connection(p, ep, api_key).await
}

/// 온보딩 "연결 테스트" — AI 를 켜기 **전에** 연결을 확인한다(specs/commands/ai.yaml 참고).
/// ai_enabled 게이트가 없으므로 http: false(데스크톱 IPC 전용)로만 노출된다 — 위 게이트가 막는
/// 원격 SSRF 경로는 여전히 닫혀 있다. 키는 설정 폴백 없이 인자로만 받는다.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_test_connection_before_enable(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> AppResult<ConnectionTest> {
    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;
    ai::test_connection(p, ep, api_key).await
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenRouterConnection {
    pub api_key: String,
}

/// OpenRouter 로그인 연결 — 브라우저 OAuth(PKCE)로 **사용자 소유** 키를 받아 그대로 돌려준다.
/// 설정에 쓰지 않는 이유와 다른 프로바이더에 같은 걸 못 하는 이유는 repo::ai::oauth 헤더 참고.
///
/// AI 정책 사다리(§6-A)도 프라이버시 게이트도 타지 않는다 — 아직 노트가 한 글자도 나가지 않고,
/// 오가는 건 OpenRouter 계정의 인가 코드뿐이다. 받은 키를 실제로 쓰는 순간(organize/translate/…)
/// 에는 그쪽 커맨드의 게이트가 이미 강제한다. 여기서 한 번 더 막으면 "AI 를 켜려면 먼저 AI 를
/// 켜야 하는" 잠금이 된다.
// rename_all: 지금은 사용자 인자가 없어 무해하지만, 인자가 하나라도 늘면 Tauri 가 camelCase 를
// 기대하게 되어 프런트의 snake_case 호출이 조용히 깨진다(CLAUDE.md §7 과 같은 부류의 침묵 실패).
// tests/invariant_ipc.rs::test_all_commands_have_snake_case_rename 이 이 규약을 전수 강제한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_openrouter_connect(app: tauri::AppHandle) -> AppResult<OpenRouterConnection> {
    Ok(OpenRouterConnection {
        api_key: ai::openrouter_connect(&app).await?,
    })
}

#[cfg(test)]
mod ai_test_connection_gate_tests {
    use super::*;

    #[test]
    fn cloud_provider_without_ai_enabled_is_rejected_before_any_network_call() {
        let err = ai_test_connection_gate(&ai::Provider::OpenAI, "https://api.openai.com/v1", false)
            .unwrap_err();
        assert!(matches!(err, crate::error::AppError::Validation(_)));
    }

    #[test]
    fn local_ollama_loopback_does_not_require_ai_enabled() {
        assert!(ai_test_connection_gate(&ai::Provider::Ollama, "http://localhost:11434", false).is_ok());
    }

    #[test]
    fn remote_ollama_endpoint_still_requires_ai_enabled() {
        let err = ai_test_connection_gate(&ai::Provider::Ollama, "https://ollama.example.com", false)
            .unwrap_err();
        assert!(matches!(err, crate::error::AppError::Validation(_)));
    }

    #[test]
    fn cloud_provider_with_ai_enabled_passes_the_gate() {
        assert!(ai_test_connection_gate(&ai::Provider::OpenAI, "https://api.openai.com/v1", true).is_ok());
    }

    // api_key 폴백(2026-08-02): 동기화 웹 클라이언트는 보안 하드닝 때문에 ai_api_key 를 아예
    // 못 받아 항상 None 을 보낸다 — 그때 서버가 자기 DB 의 키로 대신 호출해야 브라우저에서
    // AI 가 동작한다. 키가 원격으로 나가지 않는다는 점은 그대로다.
    #[test]
    fn stored_key_is_used_when_the_caller_sends_none() {
        assert_eq!(pick_api_key(None, Some("sk-stored")), Some("sk-stored".to_string()));
    }

    #[test]
    fn an_explicit_key_always_beats_the_stored_one() {
        assert_eq!(
            pick_api_key(Some("sk-arg".to_string()), Some("sk-stored")),
            Some("sk-arg".to_string())
        );
    }

    #[test]
    fn empty_strings_count_as_unset_on_both_sides() {
        // migrations.rs 의 ai_api_key 시드 기본값이 "" 라, 빈 문자열을 그대로 흘리면
        // 프로바이더가 빈 Authorization 헤더로 401 을 뱉는다.
        assert_eq!(pick_api_key(Some(String::new()), Some("sk-stored")), Some("sk-stored".to_string()));
        assert_eq!(pick_api_key(Some(String::new()), Some("")), None);
        assert_eq!(pick_api_key(None, None), None);
    }
}

#[derive(Debug, Serialize)]
pub struct AiTranslateResult {
    pub translated: String,
}

pub async fn ai_translate_text_inner<T: ai::TranslateTransport>(
    text: String,
    target_lang: String,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    state: &AppState,
    transport: &T,
) -> AppResult<AiTranslateResult> {
    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;

    let (ai_enabled, api_key) = ai_gate_and_key(state, api_key, Some(AiPolicyLevel::Refine))?;

    let translated = match ai::translate_inner(text, target_lang, p, ep, api_key, model, ai_enabled, transport).await {
        Ok(translated) => {
            let summary = ai::summarize_completion_for_history("translation", &translated);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::TranslateSucceeded,
                Some("translation request"),
                &summary,
            );
            translated
        }
        Err(error) => {
            let summary = ai::summarize_error_for_history(&error);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::TranslateFailed,
                Some("translation request"),
                &summary,
            );
            return Err(error);
        }
    };

    Ok(AiTranslateResult { translated })
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn ai_translate_text(
    text: String,
    target_lang: String,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<AiTranslateResult> {
    // §3 C-1/C-2: op/caller 는 게이트가 쓰는 프런트 액션 이름과 맞추고, request_id 는 프런트가
    // ai_cancel_call 에서 같은 값으로 취소를 걸 수 있도록 그대로 실어 나른다.
    let ctx = ai::call_log::CallCtx {
        op: Some("translate".to_string()),
        caller: Some("ai_translate_text".to_string()),
        note_id: None,
        request_id,
    };
    ai::call_log::with_call_ctx(
        ctx,
        ai_translate_text_inner(text, target_lang, provider, endpoint, api_key, model, &state, &ai::RealTranslateTransport::new(fallback_model_setting(&state))),
    )
    .await
}

#[derive(Debug, Serialize)]
pub struct AiCleanupResult {
    pub cleaned: String,
}

pub async fn ai_cleanup_text_inner<T: ai::TextTransport>(
    text: String,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    state: &AppState,
    transport: &T,
) -> AppResult<AiCleanupResult> {
    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;

    let (ai_enabled, api_key) = ai_gate_and_key(state, api_key, Some(AiPolicyLevel::Refine))?;

    let cleaned = match ai::cleanup_text_inner(text, p, ep, api_key, model, ai_enabled, transport).await {
        Ok(cleaned) => {
            let summary = ai::summarize_completion_for_history("cleanup", &cleaned);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::CleanupSucceeded,
                Some("cleanup request"),
                &summary,
            );
            cleaned
        }
        Err(error) => {
            let summary = ai::summarize_error_for_history(&error);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::CleanupFailed,
                Some("cleanup request"),
                &summary,
            );
            return Err(error);
        }
    };
    Ok(AiCleanupResult { cleaned })
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn ai_cleanup_text(
    text: String,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<AiCleanupResult> {
    let ctx = ai::call_log::CallCtx {
        op: Some("cleanup".to_string()),
        caller: Some("ai_cleanup_text".to_string()),
        note_id: None,
        request_id,
    };
    ai::call_log::with_call_ctx(
        ctx,
        ai_cleanup_text_inner(text, provider, endpoint, api_key, model, &state, &ai::RealTextTransport::new(fallback_model_setting(&state))),
    )
    .await
}

#[derive(Debug, Serialize)]
pub struct AiGenerateResult {
    pub generated: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn ai_generate_from_prompt_inner<T: ai::TextTransport>(
    prompt: String,
    context_text: Option<String>,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    purpose: Option<String>,
    state: &AppState,
    transport: &T,
) -> AppResult<AiGenerateResult> {
    let (p, ep) = ai::resolve_provider_and_endpoint(&provider, endpoint)?;

    let (ai_enabled, api_key) = ai_gate_and_key(state, api_key, Some(AiPolicyLevel::Refine))?;

    let history_input = ai::summarize_prompt_for_history(&prompt);
    let generated = match ai::generate_from_prompt_inner(prompt, context_text, p, ep, api_key, model, purpose, ai_enabled, transport).await {
        Ok(generated) => {
            let summary = ai::summarize_completion_for_history("generation", &generated);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::GenerateSucceeded,
                Some(&history_input),
                &summary,
            );
            generated
        }
        Err(error) => {
            let summary = ai::summarize_error_for_history(&error);
            record_ai_audit(
                state,
                None,
                None,
                ai::AiAuditEvent::GenerateFailed,
                Some(&history_input),
                &summary,
            );
            return Err(error);
        }
    };

    Ok(AiGenerateResult { generated })
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn ai_generate_from_prompt(
    prompt: String,
    context_text: Option<String>,
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
    preset_id: Option<String>,
    purpose: Option<String>,
    state: tauri::State<'_, AppState>,
) -> AppResult<AiGenerateResult> {
    let ctx = ai::call_log::CallCtx {
        op: preset_id.or_else(|| Some("generate".to_string())),
        caller: Some("ai_generate_from_prompt".to_string()),
        note_id: None,
        request_id,
    };
    ai::call_log::with_call_ctx(
        ctx,
        ai_generate_from_prompt_inner(prompt, context_text, provider, endpoint, api_key, model, purpose, &state, &ai::RealTextTransport::new(fallback_model_setting(&state))),
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_get_history(
    workspace_id: String,
    limit: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ai::AiHistoryItem>> {
    let conn = state.db.lock();
    ai::get_history(&conn, &workspace_id, limit)
}

#[derive(Serialize)]
pub struct AiGetUsageResult {
    pub rows: Vec<ai::AiUsageRow>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_get_usage(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    since: Option<String>,
) -> AppResult<AiGetUsageResult> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let rows = ai::get_usage(&conn, &ws, since.as_deref())?;
    Ok(AiGetUsageResult { rows })
}

// ── PLAN-2026-09-05 §3 C-4: 호출 로그 조회 (진행 중 / 최근 종료) ────────────────────────────
// 둘 다 DB 접근 없음 — repo::ai::call_log 의 프로세스 전역 링 버퍼를 그대로 읽는다.

#[derive(Serialize)]
pub struct AiCallsResult {
    pub items: Vec<ai::call_log::CallLogEntry>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_calls_active() -> AppResult<AiCallsResult> {
    Ok(AiCallsResult { items: ai::call_log::active() })
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_calls_recent(limit: Option<usize>) -> AppResult<AiCallsResult> {
    Ok(AiCallsResult { items: ai::call_log::recent(limit.unwrap_or(300)) })
}

// ── PLAN-2026-09-05 §3 C-5 2단계(W5) / §3 C-2(WC): 진짜 취소 ────────────────────────────────
// id 또는 request_id 중 하나로 부를 수 있다 — id는 기존 계약(한 호출만 취소), request_id는
// "그 request_id로 시작된 진행 중 호출 전부"를 취소한다(§3 C-2: 프런트가 같은 사용자 행동을
// 여러 실호출로 쪼갠 경우 — 예: 재시도 버튼을 두 번 눌러 이전 요청이 아직 살아 있는 경우 —
// 를 한 번에 정리). `cancelled` 필드는 기존 프런트 하위호환용으로 유지(count>0과 동치),
// `count`가 새로 추가된 실제 취소 개수.
#[derive(Serialize)]
pub struct AiCancelCallResult {
    pub cancelled: bool,
    pub count: u32,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_cancel_call(id: Option<String>, request_id: Option<String>) -> AppResult<AiCancelCallResult> {
    let count: u32 = match (id, request_id) {
        (Some(id), _) => u32::from(ai::call_log::cancel(&id)),
        (None, Some(request_id)) => ai::call_log::cancel_by_request_id(&request_id) as u32,
        (None, None) => {
            return Err(AppError::Validation("ai_cancel_call requires id or request_id".to_string()));
        }
    };
    Ok(AiCancelCallResult { cancelled: count > 0, count })
}

// ── I3(docs/AUDIT-2026-09-05-ai-guard-friction.md 잔여): ai-calls.jsonl 최근 N일 집계 ─────────
const AI_CALLS_SUMMARY_MIN_DAYS: u32 = 1;
const AI_CALLS_SUMMARY_MAX_DAYS: u32 = 90;

#[tauri::command(rename_all = "snake_case")]
pub fn ai_calls_summary(days: u32) -> AppResult<ai::call_log::CallsSummary> {
    if !(AI_CALLS_SUMMARY_MIN_DAYS..=AI_CALLS_SUMMARY_MAX_DAYS).contains(&days) {
        return Err(AppError::Validation(format!(
            "days must be {AI_CALLS_SUMMARY_MIN_DAYS}..={AI_CALLS_SUMMARY_MAX_DAYS}, got {days}"
        )));
    }
    Ok(ai::call_log::summarize(days))
}

// ── I4: 게이트 [버리기] 사유 주석 ────────────────────────────────────────────────────────────────
const DISCARD_REASONS: [&str; 4] = ["wrong", "too_long", "bad_format", "other"];

#[derive(Debug, Serialize)]
pub struct AiCallAnnotateResult {
    pub ok: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn ai_call_annotate(request_id: String, discard_reason: String) -> AppResult<AiCallAnnotateResult> {
    if !DISCARD_REASONS.contains(&discard_reason.as_str()) {
        return Err(AppError::Validation(format!(
            "unknown discard_reason: {discard_reason} (expected one of {DISCARD_REASONS:?})"
        )));
    }
    ai::call_log::annotate(&request_id, &discard_reason);
    Ok(AiCallAnnotateResult { ok: true })
}

// ── §6-A 전역 AI 정책 레벨 게이트 테스트 (docs/PLAN-2026-08-30-ai-surface-and-clients.md §6-A) ──
#[cfg(test)]
mod ai_policy_level_tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // ── 순수 판정 로직(DB 없이) ───────────────────────────────────────────────────────────────
    #[test]
    fn parse_maps_the_three_known_strings_and_falls_back_unknown_to_organize() {
        assert_eq!(AiPolicyLevel::parse("gather"), AiPolicyLevel::Gather);
        assert_eq!(AiPolicyLevel::parse("refine"), AiPolicyLevel::Refine);
        assert_eq!(AiPolicyLevel::parse("organize"), AiPolicyLevel::Organize);
        // 오타/미래값/빈 문자열 — 전부 기존 동작(무제한)을 유지하는 Organize 로 폴백.
        assert_eq!(AiPolicyLevel::parse("bogus"), AiPolicyLevel::Organize);
        assert_eq!(AiPolicyLevel::parse(""), AiPolicyLevel::Organize);
    }

    #[test]
    fn ladder_order_is_gather_lt_refine_lt_organize() {
        assert!(AiPolicyLevel::Gather < AiPolicyLevel::Refine);
        assert!(AiPolicyLevel::Refine < AiPolicyLevel::Organize);
        assert!(AiPolicyLevel::Gather < AiPolicyLevel::Organize);
        assert!(!(AiPolicyLevel::Organize < AiPolicyLevel::Gather));
    }

    // ── DB 왕복 헬퍼 ──────────────────────────────────────────────────────────────────────────
    fn build_state_with_policy(dir: &std::path::Path, level: &str) -> AppState {
        let mut conn = crate::db::bootstrap(dir).unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("ai_policy_level".to_string(), json!(level));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        AppState::new(conn, dir.to_path_buf())
    }

    fn seed_note(state: &AppState) -> String {
        let mut conn = state.db.lock();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders ORDER BY position LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = notes::create_today_default(&mut conn, &folder_id, Some("정책 테스트 노트".to_string()), Some(2026), Some(8), Some(30)).unwrap();
        detail.note.id
    }

    fn is_policy_validation_error(err: &AppError) -> bool {
        matches!(err, AppError::Validation(msg) if msg.contains("AI policy level"))
    }

    struct GateFakeTransport {
        calls: Arc<AtomicUsize>,
    }
    impl GateFakeTransport {
        fn new() -> Self {
            Self { calls: Arc::new(AtomicUsize::new(0)) }
        }
    }
    impl ai::TextTransport for GateFakeTransport {
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
            Ok("ok".to_string())
        }
    }
    impl ai::TranslateTransport for GateFakeTransport {
        async fn translate(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            text: String,
            _target_lang: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(format!("tr:{text}"))
        }
    }

    // ── refine 요구 커맨드: ai_cleanup_text (3×2 매트릭스의 절반) ───────────────────────────────
    // gather 정책에서 거부되고, refine·organize 정책(사다리는 누적)에서는 허용된다. 거부 시
    // transport 가 아예 호출되지 않는 것까지 확인한다(정책 게이트가 네트워크 호출보다 먼저다).
    #[tokio::test]
    async fn cleanup_text_is_rejected_under_gather_policy_before_any_network_call() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "gather");
        let transport = GateFakeTransport::new();
        let calls = transport.calls.clone();

        let err = ai_cleanup_text_inner("hello".into(), "ollama".into(), None, None, None, &state, &transport)
            .await
            .unwrap_err();

        assert!(is_policy_validation_error(&err), "expected a policy-level Validation error, got {err:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "the transport must never be called once the policy gate rejects");
    }

    #[tokio::test]
    async fn cleanup_text_is_allowed_under_refine_policy() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "refine");
        let transport = GateFakeTransport::new();
        let calls = transport.calls.clone();

        let result = ai_cleanup_text_inner("hello".into(), "ollama".into(), None, None, None, &state, &transport).await;

        assert!(result.is_ok(), "refine should satisfy cleanup_text's refine requirement, got {result:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cleanup_text_is_allowed_under_organize_policy() {
        // 사다리는 누적이다 — organize 는 refine 이 허용하는 모든 것을 포함한다.
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "organize");
        let transport = GateFakeTransport::new();

        let result = ai_cleanup_text_inner("hello".into(), "ollama".into(), None, None, None, &state, &transport).await;

        assert!(result.is_ok(), "organize should satisfy cleanup_text's refine requirement, got {result:?}");
    }

    // ── organize 요구 커맨드: ai_apply_organize (3×2 매트릭스의 나머지 절반) ────────────────────
    // gather·refine 둘 다 거부하고(정확히 오너가 지목한 사례 — "refine 에서 ai_apply_organize 가
    // 거부"), organize 에서만 통과해 실제로 title 이 바뀐다.
    #[test]
    fn apply_organize_is_rejected_under_gather_and_refine_but_allowed_under_organize() {
        for (level, should_pass) in [("gather", false), ("refine", false), ("organize", true)] {
            let dir = tempfile::tempdir().unwrap();
            let state = build_state_with_policy(dir.path(), level);
            let note_id = seed_note(&state);

            let result = ai_apply_organize_inner(
                note_id,
                Some("새 제목".to_string()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                &state,
            );

            if should_pass {
                let applied = result.unwrap_or_else(|e| panic!("level={level} should allow ai_apply_organize, got {e:?}"));
                assert!(applied.applied.contains(&"title".to_string()));
            } else {
                let err = result.unwrap_err();
                assert!(is_policy_validation_error(&err), "level={level} should reject with a policy Validation error, got {err:?}");
            }
        }
    }

    // ── 나머지 refine 커맨드(translate/generate) 배선 확인 — gather 에서 전부 거부 ─────────────
    #[tokio::test]
    async fn translate_text_is_rejected_under_gather_policy() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "gather");
        let transport = GateFakeTransport::new();

        let err = ai_translate_text_inner("hello".into(), "fr".into(), "ollama".into(), None, None, None, &state, &transport)
            .await
            .unwrap_err();
        assert!(is_policy_validation_error(&err), "got {err:?}");
    }

    #[tokio::test]
    async fn generate_from_prompt_is_rejected_under_gather_policy() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "gather");
        let transport = GateFakeTransport::new();

        let err = ai_generate_from_prompt_inner("write something".into(), None, "ollama".into(), None, None, None, None, &state, &transport)
            .await
            .unwrap_err();
        assert!(is_policy_validation_error(&err), "got {err:?}");
    }

    #[tokio::test]
    async fn generate_from_prompt_is_allowed_under_refine_policy() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "refine");
        let transport = GateFakeTransport::new();

        let result = ai_generate_from_prompt_inner("write something".into(), None, "ollama".into(), None, None, None, None, &state, &transport).await;
        assert!(result.is_ok(), "got {result:?}");
    }

    // ── organize_note(제안) — organize 요구, gather/refine 에서 거부 ────────────────────────────
    // 노트 조회보다 게이트가 먼저 돈다는 사실 자체를 이용해 존재하지 않는 id 로도 검증할 수 있다.
    #[tokio::test]
    async fn organize_note_is_rejected_under_gather_and_refine() {
        for level in ["gather", "refine"] {
            let dir = tempfile::tempdir().unwrap();
            let state = build_state_with_policy(dir.path(), level);
            let transport = GateFakeTransport::new();
            let calls = transport.calls.clone();

            let err = ai_organize_note_inner(
                "nonexistent-note-id".into(),
                None,
                "ollama".into(),
                None,
                None,
                None,
                None,
                None,
                &state,
                &transport,
            )
            .await
            .unwrap_err();

            assert!(is_policy_validation_error(&err), "level={level}, got {err:?}");
            assert_eq!(calls.load(Ordering::SeqCst), 0, "level={level}: transport must not be reached");
        }
    }

    #[tokio::test]
    async fn organize_note_gate_passes_under_organize_policy() {
        // 정책 게이트만 검증한다 — 그 뒤 실제 노트 조회는 존재하지 않는 id 라 NotFound 류로
        // 실패하지만, 그 오류가 "정책" 오류가 아니라는 사실이 게이트를 통과했다는 증거다.
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "organize");
        let transport = GateFakeTransport::new();

        let err = ai_organize_note_inner(
            "nonexistent-note-id".into(),
            None,
            "ollama".into(),
            None,
            None,
            None,
            None,
            None,
            &state,
            &transport,
        )
        .await
        .unwrap_err();

        assert!(!is_policy_validation_error(&err), "policy gate should have passed, got {err:?}");
    }

    // ── ai_apply_plan — organize 요구, gather/refine 거부, organize 에서 게이트 통과 ───────────
    #[test]
    fn apply_plan_is_rejected_under_gather_and_refine() {
        for level in ["gather", "refine"] {
            let dir = tempfile::tempdir().unwrap();
            let state = build_state_with_policy(dir.path(), level);

            let err = ai_apply_plan_inner(
                "nonexistent-workspace".into(),
                AiPlanScope::default(),
                "exec-1".into(),
                vec![],
                &state,
            )
            .unwrap_err();

            assert!(is_policy_validation_error(&err), "level={level}, got {err:?}");
        }
    }

    #[test]
    fn apply_plan_gate_passes_under_organize_policy() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state_with_policy(dir.path(), "organize");

        // 빈 actions 목록 자체는 유효하다 — 게이트를 통과했다면 빈 결과 벡터로 성공한다.
        let result = ai_apply_plan_inner("nonexistent-workspace".into(), AiPlanScope::default(), "exec-1".into(), vec![], &state);
        assert!(result.is_ok(), "empty actions list should pass the policy gate and return Ok, got {result:?}");
        assert_eq!(result.unwrap().len(), 0);
    }

    // ── test_connection/get_history/get_usage 는 정책과 무관 — 게이트를 안 거는 것 자체가 계약.
    // ai_test_connection_gate_tests 모듈(위)의 기존 테스트들이 이미 ai_enabled 게이트만 검증하고
    // 있고, ai_gate_and_key(&state, api_key, None) 호출은 정책 검사를 아예 건너뛰므로 여기서
    // 추가로 검증할 정책 분기가 없다 — 이 사실 자체가 계약(§6-A: "게이트를 걸지 마라").
}

// ── I3/I4: 커맨드 레벨 입력 검증 ─────────────────────────────────────────────────────────────────
#[cfg(test)]
mod ai_calls_summary_and_annotate_tests {
    use super::*;

    #[test]
    fn ai_calls_summary_rejects_days_outside_1_to_90() {
        assert!(matches!(ai_calls_summary(0).unwrap_err(), AppError::Validation(_)));
        assert!(matches!(ai_calls_summary(91).unwrap_err(), AppError::Validation(_)));
        assert!(ai_calls_summary(1).is_ok());
        assert!(ai_calls_summary(90).is_ok());
    }

    #[test]
    fn ai_call_annotate_rejects_an_unknown_discard_reason() {
        let err = ai_call_annotate("req-1".to_string(), "not_a_real_reason".to_string()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn ai_call_annotate_accepts_every_known_discard_reason() {
        for reason in DISCARD_REASONS {
            let result = ai_call_annotate(format!("req-{reason}"), reason.to_string());
            assert!(result.is_ok(), "reason={reason} should be accepted, got {result:?}");
        }
    }
}

// ── I2(PLAN-2026-09-05 §5-8 업그레이드 경로): clear_fields / remove_source_urls ─────────────────
#[cfg(test)]
mod ai_apply_organize_clear_tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn build_state(dir: &std::path::Path) -> AppState {
        let mut conn = crate::db::bootstrap(dir).unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("ai_policy_level".to_string(), json!("organize"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        AppState::new(conn, dir.to_path_buf())
    }

    fn seed_note(state: &AppState) -> String {
        let mut conn = state.db.lock();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders ORDER BY position LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = notes::create_today_default(&mut conn, &folder_id, Some("정리 테스트 노트".to_string()), Some(2020), Some(1), Some(1)).unwrap();
        detail.note.id
    }

    #[test]
    fn clear_fields_location_resets_lat_lng_to_null() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        let filled = ai_apply_organize_inner(note_id.clone(), None, None, None, None, Some(48.8566), Some(2.3522), None, None, None, None, &state).unwrap();
        assert!(filled.applied.contains(&"location".to_string()));

        let cleared = ai_apply_organize_inner(note_id.clone(), None, None, None, None, None, None, None, None, Some(vec!["location".to_string()]), None, &state).unwrap();
        assert!(cleared.applied.contains(&"location_cleared".to_string()));

        let conn = state.db.lock();
        let (lat, lng): (Option<f64>, Option<f64>) = conn
            .query_row("SELECT lat, lng FROM notes WHERE id=?1", [&note_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(lat, None);
        assert_eq!(lng, None);
    }

    #[test]
    fn clear_fields_is_a_noop_when_the_field_is_already_empty() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        // region은 이미 비어 있다 — 지울 게 없으니 "region_cleared"가 applied에 없어야 한다
        // (다른 set_* 함수들의 "값이 같으면 applied에서 빠진다" 관례와 동일).
        let result = ai_apply_organize_inner(note_id, None, None, None, None, None, None, None, None, Some(vec!["region".to_string()]), None, &state).unwrap();
        assert!(!result.applied.contains(&"region_cleared".to_string()));
    }

    #[test]
    fn remove_source_urls_deletes_a_previously_added_link() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        let added = ai_apply_organize_inner(note_id.clone(), None, None, None, None, None, None, Some(vec!["https://example.com/a".to_string()]), None, None, None, &state).unwrap();
        assert!(added.applied.contains(&"attachments".to_string()));

        let removed = ai_apply_organize_inner(note_id.clone(), None, None, None, None, None, None, None, None, None, Some(vec!["https://example.com/a".to_string()]), &state).unwrap();
        assert!(removed.applied.contains(&"attachments_removed".to_string()));

        let conn = state.db.lock();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE note_id=?1 AND kind='link'", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn clear_fields_rejects_an_unknown_value() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        // "title"/"source_urls"는 clear_fields에 없다(위 CLEARABLE_FIELDS 헤더 주석 참고) — 둘 다
        // VALIDATION이어야 한다.
        let err = ai_apply_organize_inner(note_id.clone(), None, None, None, None, None, None, None, None, Some(vec!["title".to_string()]), None, &state).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err2 = ai_apply_organize_inner(note_id, None, None, None, None, None, None, None, None, Some(vec!["source_urls".to_string()]), None, &state).unwrap_err();
        assert!(matches!(err2, AppError::Validation(_)));
    }

    #[test]
    fn clear_fields_conflicts_with_a_value_for_the_same_field() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        let err = ai_apply_organize_inner(note_id, None, None, None, Some("Seoul".to_string()), None, None, None, None, Some(vec!["region".to_string()]), None, &state).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn remove_source_urls_rejects_a_url_shared_with_source_urls() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path());
        let note_id = seed_note(&state);

        let err = ai_apply_organize_inner(
            note_id,
            None, None, None, None, None, None,
            Some(vec!["https://example.com/a".to_string()]),
            None,
            None,
            Some(vec!["https://example.com/a".to_string()]),
            &state,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}

