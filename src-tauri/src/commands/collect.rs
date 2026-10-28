// 커맨드: collect (commands/collect.yaml) — P3 수집 관문
// (docs/PLAN-2026-08-07-second-brain.md Q6). collect_sources CRUD는 구조화 폼
// (collect_source_create/update)이 주 경로이고, collect_source_add_nl 은 자연어 단축 추가다.
// 실제 수집 실행(fetch·파싱·인박스 append)은 백그라운드 러너(crate::collect)가 별도 스레드에서 한다.
use super::AppState;
use crate::collect::config as source_config;
use crate::error::{AppError, AppResult};
use crate::repo::ai::{self, Provider, TextTransport};
use crate::repo::{collect, folders, settings};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

#[derive(Serialize)]
pub struct CollectSourceListResult {
    pub sources: Vec<collect::CollectSource>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<CollectSourceListResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    Ok(CollectSourceListResult {
        sources: collect::list(&conn, &ws)?,
    })
}

#[derive(Serialize)]
pub struct CollectHistoryResult {
    pub items: Vec<crate::models::CollectHistoryNote>,
}

/// 설정 > 수집 > 수집 이력 표 — 소스가 만든 노트를 최근 수집순으로(repo::briefing::collect_history). 브리핑에서 끈 소스의 노트도 포함한다.
// sync-ok: collected_at 부분 인덱스 + LIMIT ≤100, 발췌·태그 조회 없음 — 가벼운 읽기 한 번.
#[tauri::command(rename_all = "snake_case")]
pub fn collect_history(
    state: State<AppState>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<CollectHistoryResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    Ok(CollectHistoryResult {
        items: crate::repo::briefing::collect_history(&conn, &ws, limit.unwrap_or(30))?,
    })
}

#[derive(Serialize)]
pub struct OkResult {
    pub ok: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_set_enabled(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<OkResult, AppError> {
    let conn = state.db.lock();
    collect::set_enabled(&conn, &id, enabled)?;
    Ok(OkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_delete(state: State<AppState>, id: String) -> Result<OkResult, AppError> {
    let mut conn = state.db.lock();
    collect::delete(&mut conn, &id)?;
    Ok(OkResult { ok: true })
}

#[derive(Serialize)]
pub struct CollectSourceRunNowResult {
    pub ok: bool,
    pub added: i64,
    pub error: Option<String>,
}

/// "지금 실행" — 백그라운드 러너와 같은 crate::collect 어댑터·완료 경로를 재사용한다(중복 구현 없음).
/// 동기 커맨드라 fs/파싱(claude_prompts)이나 fetch(rss, ctx.rt.block_on)를 이 스레드에서 그대로
/// 블로킹 처리한다 — Tauri는 동기 커맨드 핸들러를 블로킹 스레드풀에서 돌리므로 async executor를
/// 막지 않는다(collect::start의 백그라운드 스레드와 동일한 전제). 실행마다 전용 런타임을 새로
/// 여는 이유도 같다(백그라운드 러너의 rt와 공유하지 않음 — 별도 스레드/수명).
#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_run_now(
    state: State<AppState>,
    id: String,
) -> Result<CollectSourceRunNowResult, AppError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;
    // Snapshot only the source metadata while holding the global DB mutex. RSS/network and
    // filesystem adapters can take seconds; keeping the mutex across that work used to block
    // autosave and every other command. The ingest/status phase reacquires it below.
    let source = {
        let conn = state.db.lock();
        collect::get(&conn, &id)?
            .ok_or_else(|| AppError::NotFound(format!("collect source not found: {id}")))?
    };
    let result = crate::collect::collect_source(&source, &rt, state.data_dir.clone());
    let (outcome, note_ids) = {
        let mut conn = state.db.lock();
        crate::collect::finish_run_now_collecting_notes(&mut conn, &source, result)?
    };
    // post_process="summary" 후처리 — 러너(run_one)와 같은 훅. 전역 락은 이미 놓았고(§2.2), AI 호출은
    // 초 단위라 별도 스레드에서 돌려 "지금 실행" 토스트를 기다리게 하지 않는다. 실패는 조용히 로그만.
    if !note_ids.is_empty() {
        let data_dir = state.data_dir.clone();
        let source = source.clone();
        std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                return;
            };
            let ctx = crate::collect::CollectCtx { rt: &rt, data_dir: data_dir.clone(), since: source.last_run_at.clone() };
            for note_id in &note_ids {
                crate::collect::summary::maybe_summarize(
                    || crate::db::open(&crate::db::db_path(&data_dir)),
                    &ctx,
                    &source,
                    note_id,
                );
            }
        });
    }
    Ok(CollectSourceRunNowResult {
        ok: outcome.ok,
        added: outcome.added,
        error: outcome.error,
    })
}

#[derive(Serialize)]
pub struct CollectSourceDryRunResult {
    pub ok: bool,
    pub items: Vec<crate::collect::DryRunItem>,
    pub error: Option<String>,
}

/// "드라이런" — 어댑터는 실행하되 collect_seen 및 DB 쓰기 없이 가져온 항목 미리보기만 반환한다.
/// collect_source_run_now와 동일한 락 분리 패턴(위 주석 참고) — 어댑터 fetch(네트워크/yt-dlp)
/// 동안 전역 DB 뮤텍스를 잡고 있지 않는다. 기수집(seen) 판정 phase만 재잠금한다.
#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_dry_run(
    state: State<AppState>,
    id: String,
) -> Result<CollectSourceDryRunResult, AppError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let source = {
        let conn = state.db.lock();
        collect::get(&conn, &id)?
            .ok_or_else(|| AppError::NotFound(format!("collect source not found: {id}")))?
    };
    let result = crate::collect::collect_source(&source, &rt, state.data_dir.clone());
    let conn = state.db.lock();
    let outcome = crate::collect::finish_dry_run(&conn, &source, result)?;
    Ok(CollectSourceDryRunResult {
        ok: outcome.ok,
        items: outcome.items,
        error: outcome.error,
    })
}

// ── yt-dlp 온디맨드 다운로드 (사용자 동의 후 — docs/COLLECT.md §2.4) ────────────────────────
// 설치본은 yt-dlp를 동봉하지 않는다(스토어 심사·유튜브 약관 노출 리스크 분리). 프론트의 동의
// 게이트(CollectSection.tsx::ensureYtdlp)가 유튜브 소스 저장/지금 실행/드라이런 전에 이 두
// 커맨드로 상태를 확인하고, 미설치면 사용자 동의를 받은 뒤에만 설치를 트리거한다.

#[derive(Serialize)]
pub struct YtdlpStatusResult {
    pub installed: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn collect_ytdlp_status(state: State<AppState>) -> Result<YtdlpStatusResult, AppError> {
    Ok(YtdlpStatusResult {
        installed: crate::collect::ytdlp::ytdlp_installed(&state.data_dir),
    })
}

/// 다운로드 동안 어떤 conn도 빌리지 않는다 — 시그니처 자체가 `state.db`를 건드리지 않으므로
/// (collect_source_run_now/dry_run의 락 분리 패턴과 같은 원칙, §2.2) 컴파일 타임에 보장된다.
#[tauri::command(rename_all = "snake_case")]
pub async fn collect_ytdlp_install(state: State<'_, AppState>) -> Result<OkResult, AppError> {
    let data_dir = state.data_dir.clone();
    if crate::collect::ytdlp::ytdlp_installed(&data_dir) {
        return Ok(OkResult { ok: true }); // 멱등 — 이미 있으면 재다운로드하지 않는다.
    }
    crate::collect::ytdlp::ytdlp_download(&data_dir).await?;
    Ok(OkResult { ok: true })
}

/// 구조화 폼을 통한 새 소스 생성
#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_create(
    state: State<AppState>,
    workspace_id: Option<String>,
    kind: String,
    name: String,
    config: String,
    dry_run: Option<bool>,
    target_folder_id: Option<String>,
    post_process: Option<String>,
    post_process_model: Option<String>,
    interval_minutes: Option<i64>,
    show_in_briefing: Option<bool>,
) -> Result<collect::CollectSource, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let parsed_val: serde_json::Value = serde_json::from_str(&config)
        .map_err(|e| AppError::Validation(format!("invalid {kind} config json: {e}")))?;
    let normalized_config = source_config::normalize_value(&kind, &parsed_val)?;

    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("name must not be empty".to_string()));
    }

    let source = collect::create_with_options(
        &conn,
        collect::CreateCollectSourceParams {
            workspace_id: &ws,
            kind: &kind,
            name,
            config: &normalized_config,
            dry_run: dry_run.unwrap_or(false),
            target_folder_id: target_folder_id.as_deref(),
            post_process: post_process.as_deref().unwrap_or("none"),
            post_process_model: post_process_model.as_deref(),
            interval_minutes,
            show_in_briefing: show_in_briefing.unwrap_or(true),
        },
    )?;
    Ok(source)
}

/// Finding 3: `target_folder_id`/`post_process_model`/`interval_minutes` used to be
/// `Option<Option<T>>` (serde's standard "double Option" pattern — outer None = "leave alone",
/// `Some(None)` = "clear"). That needs `#[serde(deserialize_with = ...)]` on a struct field to
/// work, because `Option<T>::deserialize` unconditionally treats a present JSON `null` as the
/// *outer* None — verified empirically (see `clearing_semantics_tests` below): wrapping the inner
/// type in a custom newtype does NOT help, since Tauri's `CommandItem::deserialize_option` and
/// `serde_json::Value`'s own `deserialize_option` both short-circuit to `visit_none()` on null
/// *before* any inner type gets a chance to run. `#[tauri::command]` also doesn't accept
/// `#[serde(...)]` on bare fn parameters (only on struct fields), so the struct-field escape hatch
/// isn't available here either. The one caller (CollectSection.tsx saveForm) always sends every
/// field on every save — never omits one meaning "leave unchanged" — so there is nothing to lose
/// by collapsing to a single `Option<T>`: absent-or-null both mean "clear", present-with-a-value
/// means "set". That is the "always-Some" semantics: every call to this command sets these three
/// fields, full stop.
#[tauri::command(rename_all = "snake_case")]
pub fn collect_source_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    config: Option<String>,
    dry_run: Option<bool>,
    target_folder_id: Option<String>,
    post_process: Option<String>,
    post_process_model: Option<String>,
    interval_minutes: Option<i64>,
    show_in_briefing: Option<bool>,
) -> Result<collect::CollectSource, AppError> {
    let conn = state.db.lock();
    let current = collect::get(&conn, &id)?
        .ok_or_else(|| AppError::NotFound(format!("collect source not found: {id}")))?;

    let normalized_config = match config.as_deref() {
        Some(c) => {
            let parsed_val: serde_json::Value = serde_json::from_str(c)
                .map_err(|e| AppError::Validation(format!("invalid {} config json: {e}", current.kind)))?;
            Some(source_config::normalize_value(&current.kind, &parsed_val)?)
        }
        None => None,
    };

    let source = collect::update(
        &conn,
        &id,
        collect::UpdateCollectSourceParams {
            name: name.as_deref(),
            config: normalized_config.as_deref(),
            dry_run,
            target_folder_id: Some(target_folder_id.as_deref()),
            post_process: post_process.as_deref(),
            post_process_model: Some(post_process_model.as_deref()),
            interval_minutes: Some(interval_minutes),
            show_in_briefing, // None = 유지 (dry_run 과 같은 관례)
        },
    )?;
    Ok(source)
}

// ── 자연어 소스 추가 (AI 구조화) ─────────────────────────────────────────────────────────────

/// AI 응답 파싱 타입. docs/AI.md 계약 3(빈 값 스켈레톤): 시스템 프롬프트에 채워진 예시를 넣지
/// 않는다 — 모델이 그대로 베낀다. `config` 자체는 kind별 스키마로 한 번 더 파싱한다.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceDraft {
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default = "empty_config")]
    config: serde_json::Value,
}

fn empty_config() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

const ADD_NL_SYSTEM_PROMPT: &str = "You turn a user's natural-language request or a pasted URL into \
    a structured data-source registration for a personal notes app's collector. Respond with ONLY a \
    JSON object (no markdown fences, no commentary, no extra keys) matching this shape:\n\
    {\"kind\": \"\", \"name\": \"\", \"config\": {}}\n\
    Rules:\n\
    - kind must be exactly \"rss\", \"web\", \"claude_prompts\", \"codex_prompts\", or \"youtube\" — \
    nothing else.\n\
    - kind=\"rss\": config MUST include a \"url\" string (the feed URL itself — if the user gave a \
    site homepage instead of a feed link, resolve it to that site's actual RSS/Atom feed URL).\n\
    - kind=\"web\": config MUST include a \"url\" string (for a blog/site with no RSS feed).\n\
    - kind=\"youtube\": config MUST include a \"url\" string (a YouTube video OR channel URL — if the \
    user gave a channel URL, still return kind=\"youtube\" with that url; the server detects channel \
    URLs and converts the registration to an RSS subscription automatically before saving).\n\
    - kind=\"claude_prompts\": config may include a project substring and/or a directory under \
    ~/.claude/projects; it may also be {} when the user wants all projects.\n\
    - kind=\"codex_prompts\": local OpenAI Codex CLI session logs (~/.codex/sessions) — config may \
    include a project substring and/or a directory override; {} collects all projects.\n\
    - name: a short human-readable label for the source (e.g. the feed or site name). Never empty.\n\
    - If the input doesn't clearly describe a kind, still return your best guess (\"youtube\" if it \
    looks like a YouTube URL, \"rss\" if it looks like a feed URL, \"web\" if a regular site, \
    \"codex_prompts\" if it explicitly mentions Codex, otherwise \"claude_prompts\") rather than \
    refusing — validation happens after your response, not by you.";

/// AI 호출 + JSON 파싱 + kind별 검증까지 — DB 접근 없음(테스트 가능, C3 link_suggest의
/// RealTextTransport 선례와 같은 TextTransport 목킹 패턴). 반환값은 (kind, name, config JSON 문자열).
/// 실제 저장은 커맨드가 이 반환값으로 한다.
async fn resolve_source_draft<T: TextTransport>(
    input: &str,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<(String, String, String)> {
    if !ai::privacy_gate_ok(&provider, &endpoint, ai_enabled) {
        return Err(AppError::Validation(
            "collect_source_add_nl requires ai_enabled (Settings > AI)".to_string(),
        ));
    }
    let raw = transport
        .send_text(
            provider,
            endpoint,
            api_key,
            model,
            ADD_NL_SYSTEM_PROMPT.to_string(),
            input.to_string(),
        )
        .await?;
    let draft: SourceDraft = ai::extract_json(&raw)?;
    normalize_and_validate_draft(draft)
}

fn normalize_and_validate_draft(draft: SourceDraft) -> AppResult<(String, String, String)> {
    let kind = draft.kind.trim().to_string();
    if kind != "rss" && kind != "claude_prompts" && kind != "codex_prompts" && kind != "web" && kind != "youtube" {
        return Err(AppError::Validation(format!(
            "AI returned an unsupported source kind: {kind:?}"
        )));
    }
    if kind == "rss" || kind == "web" || kind == "youtube" {
        let has_url = draft
            .config
            .get("url")
            .and_then(|value| value.as_str())
            .is_some_and(|url| !url.trim().is_empty());
        if !has_url {
            return Err(AppError::Validation(
                format!("could not determine a URL for this {kind} source — try pasting the URL directly"),
            ));
        }
    }
    let config = source_config::normalize_value(&kind, &draft.config)?;
    let name = {
        let n = draft.name.trim();
        if n.is_empty() {
            kind.clone()
        } else {
            n.to_string()
        }
    };
    Ok((kind, name, config))
}

/// (kind, name, config, post_process) 로컬 초안. `rewrite_youtube_channel_draft`와 같은 자세로
/// DB·네트워크 접근 없는 순수 함수 — AI가 꺼져 있어도 두 로컬 가족(클로드/코덱스 대화, 브라우저
/// 기록)은 등록되게 한다(PLAN-2026-09-04-local-import §2.5). URL이 섞여 있으면 rss/web/youtube일
/// 수 있으니 손대지 않고 AI 경로로 넘긴다.
fn local_kind_draft(text: &str) -> Option<(&'static str, &'static str, serde_json::Value, &'static str)> {
    let lower = text.to_lowercase();
    if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
        return None;
    }

    let has_claude = lower.contains("클로드") || lower.contains("claude");
    let has_codex = lower.contains("코덱스") || lower.contains("codex");
    let has_chat_word = ["대화", "프롬프트", "세션", "chat", "prompt", "session"]
        .iter()
        .any(|w| lower.contains(w));
    // "AI 대화"처럼 제품명 없이 생성 AI만 가리켜도 걸리게 한다 — 기본은 클로드(ADD_NL_SYSTEM_PROMPT의
    // AI 경로 규칙과 동일: 코덱스가 명시될 때만 코덱스).
    // "ai" 는 토큰 단위로만 본다 — contains 면 "email 대화"·"detail 세션" 같은 문장도 걸린다.
    let has_ai_token = lower.split(|c: char| !c.is_alphanumeric()).any(|t| t == "ai");
    if has_chat_word && (has_claude || has_codex || has_ai_token) {
        if has_codex && !has_claude {
            return Some(("codex_prompts", "코덱스 대화", serde_json::json!({}), "summary"));
        }
        return Some(("claude_prompts", "클로드 대화", serde_json::json!({}), "summary"));
    }

    let has_browser_word = ["브라우저", "크롬", "chrome", "엣지", "edge"]
        .iter()
        .any(|w| lower.contains(w));
    let has_history_word = ["기록", "방문", "히스토리", "history"]
        .iter()
        .any(|w| lower.contains(w));
    if has_browser_word && has_history_word {
        let browser = if lower.contains("엣지") || lower.contains("edge") { "edge" } else { "chrome" };
        return Some((
            "browser_history",
            "브라우저 기록",
            serde_json::json!({ "browser": browser }),
            "none",
        ));
    }

    None
}

/// `candidates`(collect_detect_local과 같은 소스) 중 `browser`에 해당하는 것을 골라 최근
/// 방문이 가장 많은(`recent_count`) 프로필 디렉터리명을 돌려준다. 후보가 없거나(그 브라우저가
/// 설치돼 있지 않음) 최댓값이 동률이면 "Default"로 안전하게 폴백한다 — 어느 쪽이든
/// `browser_history` 어댑터가 실제 실행 시점에 그 프로필의 존재 여부로 스스로 성공/실패를
/// 가른다(§2.3, 오늘과 같은 동작).
fn pick_most_active_profile(candidates: &[crate::collect::detect::LocalCandidate], browser: &str) -> String {
    let prefix = format!("{browser}:");
    let matches: Vec<&crate::collect::detect::LocalCandidate> =
        candidates.iter().filter(|c| c.kind == "browser_history" && c.key.starts_with(&prefix)).collect();
    let Some(best) = matches.iter().max_by_key(|c| c.recent_count) else {
        return "Default".to_string();
    };
    let tied = matches.iter().filter(|c| c.recent_count == best.recent_count).count() > 1;
    if tied {
        return "Default".to_string();
    }
    best.key.strip_prefix(&prefix).unwrap_or("Default").to_string()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn collect_source_add_nl(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    input: String,
) -> Result<collect::CollectSource, AppError> {
    let trimmed = input.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Validation("input must not be empty".to_string()));
    }

    // 로컬 kind 는 AI 를 아예 건드리지 않는다 — ai_history/ai_usage 에도 안 남는다(실제 AI 호출이
    // 없었으므로). interval_minutes=0 은 ON_OPEN_SENTINEL("창을 열 때").
    if let Some((kind, name, config_value, post_process)) = local_kind_draft(&trimmed) {
        let conn = state.db.lock();
        let ws = match workspace_id {
            Some(w) => w,
            None => folders::active_workspace_id(&conn)?,
        };
        // "크롬 기록 가져와" 는 프로필을 특정하지 않는다 — local_kind_draft 는 항상 profile 없이
        // (정규화 시 기본값 "Default") 반환하므로, 실제로 최근에 쓰인 프로필이 따로 있어도 늘
        // Default만 가져와지는 결함이 있었다(F-C11). 등록 직전에 그 브라우저 후보를 감지해 방문이
        // 가장 활발한 프로필을 고른다. `detect::import_local_source`를 그대로 재사용하면 폴더
        // ("수집 — 브라우징")·중복 등록 방지(같은 browser+profile 소스가 있으면 그걸 반환)까지
        // 한 곳에서 처리된다 — 여기서 create_with_options를 다시 조립할 필요가 없다.
        if kind == "browser_history" {
            let browser = config_value.get("browser").and_then(|v| v.as_str()).unwrap_or("chrome").to_string();
            let existing = collect::list(&conn, &ws)?;
            drop(conn); // 후보 감지는 프로필별 History 파일을 여는 파일 IO — 락을 쥔 채로 하지 않는다(§2.2 락 규율).
            let candidates = crate::collect::detect::detect_candidates(&state.data_dir, &existing);
            let profile = pick_most_active_profile(&candidates, &browser);
            let mut conn = state.db.lock();
            return crate::collect::detect::import_local_source(&mut conn, &ws, &format!("{browser}:{profile}"));
        }
        let config = source_config::normalize_value(kind, &config_value)?;
        return collect::create_with_options(
            &conn,
            collect::CreateCollectSourceParams {
                workspace_id: &ws,
                kind,
                name,
                config: &config,
                dry_run: false,
                target_folder_id: None,
                post_process,
                post_process_model: None,
                interval_minutes: Some(0),
                show_in_briefing: true,
            },
        );
    }

    let (ws, creds) = {
        let conn = state.db.lock();
        let ws = match workspace_id {
            Some(w) => w,
            None => folders::active_workspace_id(&conn)?,
        };
        // 설정 조회 오류는 ai::read_ai_creds 와 달리 여기서 전파한다(커맨드 계약).
        let s = settings::get_all(&conn)?;
        (ws, ai::read_ai_creds_from(&s))
    };

    let (provider, ep) = ai::resolve_provider_and_endpoint(&creds.provider, creds.endpoint)?;
    let transport = ai::RealTextTransport::new(crate::commands::ai::fallback_model_setting(&state));
    let (kind, name, config) = resolve_source_draft(
        &trimmed, provider, ep, creds.api_key, creds.model, creds.ai_enabled, &transport,
    )
    .await?;
    // ADD_NL_SYSTEM_PROMPT tells the model a channel URL is still kind="youtube" — the actual
    // youtube adapter (collect::ytdlp) is single-video-only and hangs for its 60s timeout on a
    // channel URL. Fix the wiring here, before the draft is persisted.
    let (kind, name, config) = rewrite_youtube_channel_draft(kind, name, config).await?;

    // Source creation and the audit record are one logical write. A successful external AI
    // registration must never be returned while its required ai_history row is missing.
    let mut conn = state.db.lock();
    let tx = conn.transaction().map_err(crate::error::db)?;
    let source = collect::create(&tx, &ws, &kind, &name, &config)?;
    ai::record_history(
        &tx,
        &ws,
        None,
        "collect_source_add_nl",
        Some(&trimmed),
        &format!("kind={kind} name={name}"),
    )?;
    tx.commit().map_err(crate::error::db)?;
    Ok(source)
}

// ── 유튜브 채널 URL → RSS 피드 해석 ──────────────────────────────────────────────────────────
// 채널 구독은 채널 RSS(`/feeds/videos.xml?channel_id=UC...`)를 kind='rss'로 등록하면 되지만, 요즘
// 채널 URL은 대부분 `@handle` 형태라 channel_id 추출에 페이지 fetch가 필요하다
// (docs/PLAN-2026-08-23-collect-advanced.md §4/W4).

#[derive(Debug, Serialize)]
pub struct ResolveYoutubeChannelResult {
    pub feed_url: String,
}

const YOUTUBE_HOSTS: &[&str] = &["youtube.com", "www.youtube.com", "m.youtube.com"];

/// `UC` + 정확히 22자의 `[0-9A-Za-z_-]` — 실제 유튜브 채널 id 형식.
fn is_channel_id(s: &str) -> bool {
    s.len() == 24
        && s.starts_with("UC")
        && s[2..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn channel_feed_url(channel_id: &str) -> String {
    format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
}

/// 채널 페이지 raw HTML에서 채널 id를 뽑는다 — 순수 함수(네트워크 없음, 픽스처 문자열로 테스트
/// 가능). 인라인 `ytInitialData` JSON의 `"channelId":"UC..."`를 우선 시도하고, 없으면
/// `<meta itemprop="identifier" content="UC...">`를 시도한다.
/// ponytail: 메타 태그는 itemprop이 content보다 먼저 오는 속성 순서만 인식한다 — 실제 유튜브
/// 채널 페이지가 다른 순서로 바뀌면 이 정규식에 대안 순서를 추가한다.
fn extract_channel_id(html: &str) -> Option<String> {
    use std::sync::OnceLock;
    static RE_JSON: OnceLock<regex::Regex> = OnceLock::new();
    static RE_META: OnceLock<regex::Regex> = OnceLock::new();
    let re_json = RE_JSON.get_or_init(|| regex::Regex::new(r#""channelId":"(UC[0-9A-Za-z_-]{22})""#).unwrap());
    let re_meta = RE_META
        .get_or_init(|| regex::Regex::new(r#"<meta itemprop="identifier" content="(UC[0-9A-Za-z_-]{22})">"#).unwrap());
    re_json
        .captures(html)
        .or_else(|| re_meta.captures(html))
        .map(|c| c[1].to_string())
}

/// 채널 페이지를 fetch해 raw HTML을 반환한다. repo::web_reader::fetch_reader는 <article> 텍스트만
/// 추출해 채널 id가 들어있는 <script>/<meta>를 이미 걷어낸 뒤라 재사용할 수 없다(그 함수의 파일
/// 상단 주석 참고) — SSRF 가드(repo::web_reader::guard_public_host)만 재사용하고, 나머지는
/// collect::rss::fetch_feed_xml과 동일한 패턴(매 리다이렉트 hop마다 호스트 재검증, 크기 캡).
async fn fetch_youtube_channel_html(url: &reqwest::Url) -> AppResult<String> {
    const FETCH_TIMEOUT_SECS: u64 = 10;
    const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024; // 3MB
    const MAX_REDIRECTS: usize = 5;

    let mut current = url.clone();
    let mut hops = 0;
    let resp = loop {
        let pinned = crate::repo::web_reader::guard_public_host(&current).await?;
        let host = current
            .host_str()
            .ok_or_else(|| AppError::Validation(format!("url has no host: {current}")))?
            .to_string();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, pinned)
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;
        // 브라우저를 사칭하지 않는다(repo::web_reader::fetch_reader와 동일 원칙) — 정직한 UA로 단일
        // 사용자 요청 fetch임을 밝힌다. ponytail: 유튜브가 이 UA에 축소된 HTML을 내려주기 시작하면
        // 이 지점에서 UA 전략을 다시 본다.
        let resp = client
            .get(current.clone())
            .header("User-Agent", "Brise-Collect/1.0")
            .header("Accept", "text/html")
            .send()
            .await
            .map_err(|e| AppError::Io(format!("channel page fetch failed: {e}")))?;

        if resp.status().is_redirection() {
            if hops >= MAX_REDIRECTS {
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
                return Err(AppError::Validation(format!(
                    "refusing to follow non-http(s) redirect to {next}"
                )));
            }
            current = next;
            hops += 1;
            continue;
        }
        break resp;
    };

    if !resp.status().is_success() {
        return Err(AppError::Io(format!("channel page http {}", resp.status())));
    }

    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("channel page read failed: {e}")))?;
        if body.len() + chunk.len() > MAX_PAGE_BYTES {
            return Err(AppError::Validation("channel page is too large".to_string()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// 유튜브 채널 URL(`/@handle`·`/channel/UC...`·`/c/...`·`/user/...`) 또는 이미 완성된 채널 RSS 피드
/// URL을 받아 RSS 피드 URL로 해석한다. DB 접근 없음(State 없음).
#[tauri::command(rename_all = "snake_case")]
pub async fn collect_resolve_youtube_channel(url: String) -> Result<ResolveYoutubeChannelResult, AppError> {
    let trimmed = url.trim();
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|_| AppError::Validation(format!("not a valid url: {trimmed}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::Validation(format!("not a fetchable http(s) url: {trimmed}")));
    }
    let host = parsed.host_str().unwrap_or("");
    if !YOUTUBE_HOSTS.contains(&host) {
        return Err(AppError::Validation(format!("not a youtube.com url: {host}")));
    }

    let path = parsed.path();

    // 이미 채널 피드 URL이면 그대로 반환 — 멱등.
    if path == "/feeds/videos.xml" && parsed.query_pairs().any(|(k, _)| k == "channel_id") {
        return Ok(ResolveYoutubeChannelResult { feed_url: trimmed.to_string() });
    }

    // /channel/UC... — 네트워크 없이 순수 변환(뒤에 /videos 같은 탭 세그먼트가 붙어도 첫 세그먼트만 본다).
    if let Some(rest) = path.strip_prefix("/channel/") {
        let id = rest.split('/').next().unwrap_or("");
        return if is_channel_id(id) {
            Ok(ResolveYoutubeChannelResult { feed_url: channel_feed_url(id) })
        } else {
            Err(AppError::Validation(format!("not a recognizable channel id: {id}")))
        };
    }

    // /@handle, /c/..., /user/... — 페이지를 fetch해 raw HTML에서 채널 id를 추출.
    if path.starts_with("/@") || path.starts_with("/c/") || path.starts_with("/user/") {
        let html = fetch_youtube_channel_html(&parsed).await?;
        return match extract_channel_id(&html) {
            Some(id) => Ok(ResolveYoutubeChannelResult { feed_url: channel_feed_url(&id) }),
            None => Err(AppError::Validation("could not find a channel id on that page".to_string())),
        };
    }

    Err(AppError::Validation(format!("not a youtube channel url: {path}")))
}

/// path가 `/watch`가 아니고 host가 `youtu.be`(항상 단일 영상 단축링크)도 아니면서 `/@`·`/channel/`·
/// `/c/`·`/user/` 중 하나로 시작하면 채널형으로 본다 — collect_source_add_nl이 실제로 fetch를
/// 태우기 전에 미리 걸러내는 게이트(단일 영상 URL에 대해 collect_resolve_youtube_channel을 불러
/// VALIDATION을 받는 것을 피한다).
fn youtube_url_is_channel_shaped(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.host_str() == Some("youtu.be") {
        return false;
    }
    let path = parsed.path();
    if path == "/watch" {
        return false;
    }
    path.starts_with("/@") || path.starts_with("/channel/") || path.starts_with("/c/") || path.starts_with("/user/")
}

/// add_nl의 시스템 프롬프트(ADD_NL_SYSTEM_PROMPT)는 채널 URL도 kind="youtube"로 분류하도록
/// 안내한다 — 실제 단일영상 전용 어댑터(collect::ytdlp)로 넘기기 전에 여기서 채널형 URL만 걸러
/// RSS로 바꾼다. DB 접근 없음(resolve_source_draft와 동일하게 목 트랜스포트 없이도 테스트 가능).
async fn rewrite_youtube_channel_draft(kind: String, name: String, config: String) -> AppResult<(String, String, String)> {
    if kind != "youtube" {
        return Ok((kind, name, config));
    }
    let url = serde_json::from_str::<serde_json::Value>(&config)
        .ok()
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string));
    let Some(url) = url.filter(|u| youtube_url_is_channel_shaped(u)) else {
        return Ok((kind, name, config));
    };
    let resolved = collect_resolve_youtube_channel(url).await?;
    let rss_config = source_config::normalize_value("rss", &serde_json::json!({ "url": resolved.feed_url }))?;
    Ok(("rss".to_string(), name, rss_config))
}

#[cfg(test)]
mod youtube_channel_tests {
    use super::*;

    // ── extract_channel_id: 픽스처 문자열, 네트워크 없음 ────────────────────────────────────
    #[test]
    fn extract_channel_id_finds_the_inline_json_channel_id() {
        let html = r#"<html><body><script>var ytInitialData = {"metadata":{"channelId":"UC_x5XG1OV2P6uZZ5FSM9Ttw"}};</script></body></html>"#;
        assert_eq!(extract_channel_id(html).as_deref(), Some("UC_x5XG1OV2P6uZZ5FSM9Ttw"));
    }

    #[test]
    fn extract_channel_id_falls_back_to_the_meta_tag() {
        let id = format!("UC{}", "A".repeat(22));
        let html = format!(
            r#"<html><head><meta itemprop="identifier" content="{id}"></head><body>no script here</body></html>"#
        );
        assert_eq!(extract_channel_id(&html).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn extract_channel_id_returns_none_when_neither_pattern_is_present() {
        let html = r#"<html><head><title>Some Channel</title></head><body>nothing useful here</body></html>"#;
        assert_eq!(extract_channel_id(html), None);
    }

    // ── collect_resolve_youtube_channel: 네트워크 없는 경로들 ───────────────────────────────
    #[tokio::test]
    async fn resolves_a_channel_id_url_without_any_network_call() {
        let id = format!("UC{}", "b".repeat(22));
        let res = collect_resolve_youtube_channel(format!("https://www.youtube.com/channel/{id}"))
            .await
            .unwrap();
        assert_eq!(res.feed_url, format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}"));
    }

    #[tokio::test]
    async fn resolves_a_channel_id_url_with_a_trailing_tab_segment() {
        let id = format!("UC{}", "c".repeat(22));
        let res = collect_resolve_youtube_channel(format!("https://www.youtube.com/channel/{id}/videos"))
            .await
            .unwrap();
        assert_eq!(res.feed_url, format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}"));
    }

    #[tokio::test]
    async fn rejects_a_non_youtube_host() {
        let err = collect_resolve_youtube_channel("https://evil.example.com/channel/UCxxxx".to_string())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn an_already_resolved_feed_url_is_returned_unchanged() {
        let feed = "https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw";
        let res = collect_resolve_youtube_channel(feed.to_string()).await.unwrap();
        assert_eq!(res.feed_url, feed);
    }

    #[tokio::test]
    async fn rejects_a_channel_path_with_a_malformed_id() {
        let err = collect_resolve_youtube_channel("https://www.youtube.com/channel/not-a-real-id".to_string())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // ── collect_source_add_nl 배선: youtube 초안이 채널형이면 rss로 바뀐다 ──────────────────
    #[tokio::test]
    async fn rewrite_converts_a_channel_shaped_youtube_draft_to_rss() {
        let id = format!("UC{}", "d".repeat(22));
        let (kind, name, config) = rewrite_youtube_channel_draft(
            "youtube".to_string(),
            "Some Channel".to_string(),
            serde_json::json!({ "url": format!("https://www.youtube.com/channel/{id}") }).to_string(),
        )
        .await
        .unwrap();
        assert_eq!(kind, "rss");
        assert_eq!(name, "Some Channel");
        assert!(config.contains(&format!("channel_id={id}")));
    }

    #[tokio::test]
    async fn rewrite_leaves_a_single_video_youtube_draft_untouched() {
        let original_config = serde_json::json!({ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).to_string();
        let (kind, _name, config) = rewrite_youtube_channel_draft(
            "youtube".to_string(),
            "A Video".to_string(),
            original_config.clone(),
        )
        .await
        .unwrap();
        assert_eq!(kind, "youtube");
        assert_eq!(config, original_config);
    }

    #[tokio::test]
    async fn rewrite_leaves_non_youtube_kinds_untouched() {
        let original_config = serde_json::json!({ "url": "https://example.com/feed" }).to_string();
        let (kind, _name, config) =
            rewrite_youtube_channel_draft("rss".to_string(), "Feed".to_string(), original_config.clone())
                .await
                .unwrap();
        assert_eq!(kind, "rss");
        assert_eq!(config, original_config);
    }
}

/// Finding 3 regression: proves the exact deserialization mechanism `collect_source_update`'s
/// plain `Option<T>` parameters rely on, using `serde_json::from_value` the same way Tauri's
/// `CommandItem::deserialize_option` does for a present JSON key (it delegates straight to
/// `Value::deserialize_option`, so a plain `serde_json::from_value` call over the same JSON shape
/// is an exact stand-in — no tauri::test/mock-app scaffolding needed for this narrow claim).
#[cfg(test)]
mod clearing_semantics_tests {
    #[test]
    fn a_present_null_deserializes_to_none_clear_and_a_present_value_to_some_set() {
        let cleared: Option<String> = serde_json::from_value(serde_json::Value::Null).unwrap();
        let set: Option<String> = serde_json::from_value(serde_json::json!("folder-1")).unwrap();
        assert_eq!(cleared, None, "JSON null must mean \"clear\"");
        assert_eq!(set, Some("folder-1".to_string()), "a real value must mean \"set to this\"");
    }
}

#[cfg(test)]
mod add_nl_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct MockText {
        response: String,
        calls: Arc<AtomicUsize>,
    }

    impl MockText {
        fn new(response: &str) -> Self {
            Self {
                response: response.to_string(),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl TextTransport for MockText {
        async fn send_text(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.response.clone())
        }
    }

    #[tokio::test]
    async fn resolves_a_valid_rss_draft_with_url() {
        let t = MockText::new(
            r#"{"kind":"rss","name":"Example Blog","config":{"url":"https://example.com/feed.xml"}}"#,
        );
        let (kind, name, config) = resolve_source_draft(
            "subscribe me to https://example.com blog",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap();
        assert_eq!(kind, "rss");
        assert_eq!(name, "Example Blog");
        assert!(config.contains("https://example.com/feed.xml"));
        assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rejects_an_rss_draft_missing_a_url() {
        let t = MockText::new(r#"{"kind":"rss","name":"No URL","config":{}}"#);
        let err = resolve_source_draft(
            "some vague request",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn accepts_a_claude_prompts_draft_registration_only() {
        let t = MockText::new(r#"{"kind":"claude_prompts","name":"My Prompts","config":{}}"#);
        let (kind, name, _config) = resolve_source_draft(
            "collect my claude session prompts",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap();
        assert_eq!(kind, "claude_prompts");
        assert_eq!(name, "My Prompts");
    }

    #[tokio::test]
    async fn rejects_an_unsupported_kind_from_the_model() {
        let t = MockText::new(r#"{"kind":"twitter","name":"X","config":{}}"#);
        let err = resolve_source_draft(
            "follow my twitter",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn rejects_unknown_rss_config_fields_from_the_model() {
        let t = MockText::new(
            r#"{"kind":"rss","name":"Feed","config":{"url":"https://example.com/feed","headers":{"Authorization":"secret"}}}"#,
        );
        let err = resolve_source_draft(
            "subscribe to this feed",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn rejects_claude_dir_outside_the_expected_projects_root() {
        let t = MockText::new(
            r#"{"kind":"claude_prompts","name":"Prompts","config":{"dir":"C:/Users/Public"}}"#,
        );
        let err = resolve_source_draft(
            "collect my Claude prompts",
            Provider::Ollama,
            "http://localhost:11434".to_string(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    /// A2와 동일한 프라이버시 게이트 계약(repo::ai::privacy_gate_ok) — 클라우드 프로바이더는
    /// ai_enabled 없이 절대 호출되면 안 된다(트랜스포트가 아예 안 불림).
    #[tokio::test]
    async fn cloud_provider_without_ai_enabled_never_calls_the_transport() {
        let t = MockText::new(r#"{"kind":"rss","name":"n","config":{"url":"https://x.com/feed"}}"#);
        let err = resolve_source_draft(
            "add this feed",
            Provider::OpenAI,
            "https://api.openai.com/v1".to_string(),
            Some("key".to_string()),
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn falls_back_to_kind_as_name_when_the_model_leaves_name_blank() {
        let draft = SourceDraft {
            kind: "rss".to_string(),
            name: "  ".to_string(),
            config: serde_json::json!({"url": "https://x.com/feed"}),
        };
        let (_, name, _) = normalize_and_validate_draft(draft).unwrap();
        assert_eq!(name, "rss");
    }

    // ── local_kind_draft: AI 없이 로컬 규칙만으로 등록되는 두 가족 ───────────────────────────
    #[test]
    fn local_kind_draft_recognizes_claude_prompts() {
        let (kind, name, config, pp) = local_kind_draft("클로드 대화 가져와줘").unwrap();
        assert_eq!(kind, "claude_prompts");
        assert_eq!(name, "클로드 대화");
        assert_eq!(config, serde_json::json!({}));
        assert_eq!(pp, "summary");
    }

    #[test]
    fn local_kind_draft_recognizes_codex_prompts_when_codex_is_named() {
        let (kind, name, ..) = local_kind_draft("코덱스 세션 좀 모아줘").unwrap();
        assert_eq!(kind, "codex_prompts");
        assert_eq!(name, "코덱스 대화");
    }

    #[test]
    fn local_kind_draft_defaults_to_claude_when_both_are_named() {
        let (kind, ..) = local_kind_draft("클로드랑 코덱스 대화 둘 다 수집해줘").unwrap();
        assert_eq!(kind, "claude_prompts");
    }

    #[test]
    fn local_kind_draft_defaults_to_claude_for_generic_ai_chat() {
        let (kind, ..) = local_kind_draft("AI 대화 세션 수집해줘").unwrap();
        assert_eq!(kind, "claude_prompts");
    }

    #[test]
    fn local_kind_draft_recognizes_browser_history_defaulting_to_chrome() {
        let (kind, name, config, pp) = local_kind_draft("브라우저 방문 기록 가져오기").unwrap();
        assert_eq!(kind, "browser_history");
        assert_eq!(name, "브라우저 기록");
        assert_eq!(config, serde_json::json!({ "browser": "chrome" }));
        assert_eq!(pp, "none");
    }

    #[test]
    fn local_kind_draft_recognizes_browser_history_with_edge() {
        let (_, _, config, _) = local_kind_draft("엣지 히스토리 수집해줘").unwrap();
        assert_eq!(config, serde_json::json!({ "browser": "edge" }));
    }

    #[test]
    fn local_kind_draft_returns_none_for_a_url_so_the_ai_path_still_runs() {
        assert!(local_kind_draft("https://example.com/feed.xml 구독해줘").is_none());
    }

    #[test]
    fn local_kind_draft_returns_none_when_neither_family_is_mentioned() {
        assert!(local_kind_draft("고양이 사진 블로그 구독하고 싶어").is_none());
        // "ai" 는 토큰이어야 한다 — email/detail 안의 "ai" 로 클로드 대화가 등록되면 안 된다.
        assert!(local_kind_draft("email 대화 내용 정리해줘").is_none());
    }

    // ── pick_most_active_profile: 챗 등록이 브라우저 프로필을 고르는 규칙(F-C11) ────────────────
    fn candidate(key: &str, recent_count: i64) -> crate::collect::detect::LocalCandidate {
        crate::collect::detect::LocalCandidate {
            key: key.to_string(),
            kind: "browser_history".to_string(),
            label: String::new(),
            detail: String::new(),
            recent_count,
            last_seen_at: None,
            source_id: None,
            config: "{}".to_string(),
        }
    }

    #[test]
    fn pick_most_active_profile_prefers_the_highest_recent_count() {
        let candidates = vec![candidate("chrome:Default", 3), candidate("chrome:Work", 10), candidate("edge:Default", 50)];
        assert_eq!(pick_most_active_profile(&candidates, "chrome"), "Work");
    }

    #[test]
    fn pick_most_active_profile_falls_back_to_default_on_a_tie() {
        let candidates = vec![candidate("chrome:Default", 5), candidate("chrome:Work", 5)];
        assert_eq!(pick_most_active_profile(&candidates, "chrome"), "Default");
    }

    #[test]
    fn pick_most_active_profile_falls_back_to_default_when_the_browser_has_no_candidates() {
        let candidates = vec![candidate("edge:Default", 50)];
        assert_eq!(pick_most_active_profile(&candidates, "chrome"), "Default");
        assert_eq!(pick_most_active_profile(&[], "chrome"), "Default");
    }

    #[test]
    fn pick_most_active_profile_ignores_candidates_of_other_kinds_even_with_a_matching_key_prefix() {
        // Same "chrome:" prefix, higher count, but wrong kind — must not win over the real
        // browser_history candidate.
        let mut fake = candidate("chrome:Ghost", 999);
        fake.kind = "claude_prompts".to_string();
        let candidates = vec![fake, candidate("chrome:Work", 1)];
        assert_eq!(pick_most_active_profile(&candidates, "chrome"), "Work");
    }
}

// ── collect_get_stats (commands/collect.yaml) ──────────────────────────────────────────────
// 수집 탭 상단 "이번 주 AI 호출" 카드. ai_usage 테이블을 action_type·provider 별로 그룹핑해서
// 수집 경로(link_suggest·link_preview·collect_post_process)만 보여준다. 다른 AI 호출
// (organize·translate 등) 은 AiHistoryPanel.tsx 가 이미 보여주므로 중복 노출하지 않는다.
#[derive(Serialize)]
pub struct CollectProviderStat {
    pub provider: String,
    pub calls: i64,
}

#[derive(Serialize)]
pub struct CollectActionStat {
    pub action_type: String,
    pub calls: i64,
    pub providers: Vec<CollectProviderStat>,
}

#[derive(Serialize)]
pub struct CollectStatsResult {
    pub per_action: Vec<CollectActionStat>,
    pub total_today: i64,
    pub total_since: i64,
}

/// 수집 경로로 한정하는 action_type 화이트리스트 — collect_get_stats 가 노이즈를 거른다.
/// 새 수집-관련 action_type 이 생기면 여기에 추가.
const COLLECT_ACTION_TYPES: &[&str] = &["link_suggest", "link_preview", "collect_post_process"];

#[tauri::command(rename_all = "snake_case")]
pub fn collect_get_stats(
    state: State<AppState>,
    workspace_id: Option<String>,
    since: Option<String>,
) -> Result<CollectStatsResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    // since 가 없으면 7일 전(로컬 캘린더일) — 카드 라벨이 "오늘/7일" 이라서 한 주가 자연스럽다.
    // ai_usage 의 day 컬럼은 today_ymd_local 로 채워지므로( repo::ai::history::record_usage) 같은
    // 형식으로 비교해야 한다.
    let since_day = since.unwrap_or_else(|| {
        let now = chrono::Local::now().date_naive();
        (now - chrono::Duration::days(7)).format("%Y-%m-%d").to_string()
    });
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let placeholders = COLLECT_ACTION_TYPES.len();
    let qmarks = std::iter::repeat("?").take(placeholders).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT day, action_type, provider, calls FROM ai_usage \
         WHERE workspace_id = ?1 AND day >= ?2 AND action_type IN ({qmarks})"
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&ws, &since_day];
    for a in COLLECT_ACTION_TYPES {
        params.push(a);
    }

    let mut stmt = conn.prepare_cached(&sql).map_err(crate::error::db)?;
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(crate::error::db)?;

    let mut per_action_map: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut per_action_providers: std::collections::BTreeMap<String, std::collections::BTreeMap<String, i64>> =
        std::collections::BTreeMap::new();
    let mut total_today: i64 = 0;
    let mut total_since: i64 = 0;

    for row in rows {
        let (day, action_type, provider, calls) = row.map_err(crate::error::db)?;
        *per_action_map.entry(action_type.clone()).or_insert(0) += calls;
        *per_action_providers
            .entry(action_type.clone())
            .or_default()
            .entry(provider.clone())
            .or_insert(0) += calls;
        total_since += calls;
        if day == today {
            total_today += calls;
        }
    }

    let per_action: Vec<CollectActionStat> = per_action_map
        .into_iter()
        .map(|(action_type, calls)| {
            let providers = per_action_providers
                .remove(&action_type)
                .unwrap_or_default()
                .into_iter()
                .map(|(provider, calls)| CollectProviderStat { provider, calls })
                .collect();
            CollectActionStat { action_type, calls, providers }
        })
        .collect();

    Ok(CollectStatsResult {
        per_action,
        total_today,
        total_since,
    })
}

// ── 로컬 소스 감지 + 1클릭 가져오기 (PLAN-2026-09-04-local-import.md §W7) ───────────────────────
// 실제 탐지/등록 로직은 crate::collect::detect 가 갖고 있다(순수 함수라 State<AppState> 없이
// 단위 테스트 가능) — 여기는 conn을 빌리고 workspace_id 를 해석하는 얇은 래퍼일 뿐이다.

#[derive(Serialize)]
pub struct CollectDetectLocalResult {
    pub candidates: Vec<crate::collect::detect::LocalCandidate>,
}

/// 크롬/엣지 프로필별 최근 방문 통계와 클로드/코덱스 세션 로그 존재 여부를 미리 훑어 후보
/// 목록을 반환한다 — 아무것도 등록/실행하지 않는다(순수 조회). 파일시스템 스캔(특히 프롬프트
/// 어댑터 쪽)은 수 ms~수백 ms가 걸릴 수 있으므로 DB 락은 워크스페이스 해석·기존 소스 조회가
/// 끝나는 즉시 놓는다(§2.2 락 규율).
#[tauri::command(rename_all = "snake_case")]
pub fn collect_detect_local(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<CollectDetectLocalResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let existing = collect::list(&conn, &ws)?;
    drop(conn);
    let candidates = crate::collect::detect::detect_candidates(&state.data_dir, &existing);
    Ok(CollectDetectLocalResult { candidates })
}

#[derive(Serialize)]
pub struct CollectDetectChatSessionsResult {
    pub sessions: Vec<crate::collect::detect::DetectedChatSession>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn collect_detect_chat_sessions() -> Result<CollectDetectChatSessionsResult, AppError> {
    let sessions = crate::collect::detect::detect_chat_sessions();
    Ok(CollectDetectChatSessionsResult { sessions })
}

/// `collect_detect_local`이 보여준 후보 하나를 1클릭으로 등록한다. 이미 같은 kind(프롬프트)
/// 또는 같은 browser+profile(브라우저 기록) 소스가 있으면 새로 만들지 않고 그 소스를 그대로
/// 반환 — 프리셋 버튼을 두 번 눌러도 중복 소스가 안 생긴다.
#[tauri::command(rename_all = "snake_case")]
pub fn collect_import_local(
    state: State<AppState>,
    workspace_id: Option<String>,
    key: String,
) -> Result<collect::CollectSource, AppError> {
    let mut conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    crate::collect::detect::import_local_source(&mut conn, &ws, &key)
}

#[cfg(test)]
mod collect_stats_tests {
    use super::*;
    use crate::db;

    fn seed_usage(conn: &rusqlite::Connection, ws: &str, day: &str, action: &str, provider: &str, calls: i64) {
        conn.execute(
            "INSERT INTO ai_usage (workspace_id, day, action_type, provider, calls) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (workspace_id, day, action_type, provider) DO UPDATE SET calls = calls + ?5",
            rusqlite::params![ws, day, action, provider, calls],
        )
        .unwrap();
    }

    #[test]
    fn collect_stats_filters_to_collect_action_types() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(dir.path()).unwrap();
        let ws = "ws1";
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        // 수집 외 action_type 은 결과에서 제외되어야 한다(노이즈).
        seed_usage(&conn, ws, &today, "organize", "ollama", 100);
        seed_usage(&conn, ws, &today, "translate", "ollama", 100);
        // 수집 경로 — 두 종류, 다른 provider.
        seed_usage(&conn, ws, &today, "link_suggest", "ollama", 3);
        seed_usage(&conn, ws, &today, "link_suggest", "gemini", 2);
        seed_usage(&conn, ws, &today, "link_preview", "ollama", 1);

        let placeholders = COLLECT_ACTION_TYPES.len();
        let qmarks = std::iter::repeat("?").take(placeholders).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT action_type, COALESCE(SUM(calls),0) FROM ai_usage \
             WHERE workspace_id = ?1 AND day = ?2 AND action_type IN ({qmarks}) \
             GROUP BY action_type ORDER BY action_type"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&ws, &today];
        for a in COLLECT_ACTION_TYPES {
            params.push(a);
        }
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map(params.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        // link_preview=1, link_suggest=5; organize/translate 는 필터링.
        assert_eq!(
            rows,
            vec![
                ("link_preview".to_string(), 1),
                ("link_suggest".to_string(), 5),
            ]
        );
    }
}
