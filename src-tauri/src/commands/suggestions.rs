// 커맨드: suggestions (commands/suggestions.yaml) — P2 후행 제안
// (docs/PLAN-2026-08-07-second-brain.md Q5).
use super::AppState;
use crate::error::AppError;
use crate::repo::ai::{self, TextTransport};
use crate::repo::{folders, search, settings, suggestions, web_reader};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Suggestion {
    pub id: String,
    pub kind: String,
    pub note_id: String,
    pub note_title: String,
    pub related_note_id: String,
    pub related_note_title: String,
    pub payload: String,
    pub score: f64,
    pub created_at: String,
}

impl From<suggestions::SuggestionRow> for Suggestion {
    fn from(r: suggestions::SuggestionRow) -> Self {
        Self {
            id: r.id,
            kind: r.kind,
            note_id: r.note_id,
            note_title: r.note_title,
            related_note_id: r.related_note_id,
            related_note_title: r.related_note_title,
            payload: r.payload,
            score: r.score,
            created_at: r.created_at,
        }
    }
}

#[derive(Serialize)]
pub struct SuggestionsListResult {
    pub suggestions: Vec<Suggestion>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn suggestions_list(
    state: State<AppState>,
    workspace_id: Option<String>,
    status: Option<String>,
) -> Result<SuggestionsListResult, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let status = status.unwrap_or_else(|| "pending".to_string());
    let rows = suggestions::list(&conn, &ws, &status)?;
    Ok(SuggestionsListResult { suggestions: rows.into_iter().map(Suggestion::from).collect() })
}

#[derive(Serialize)]
pub struct OkResult {
    pub ok: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub fn suggestion_set_status(
    state: State<AppState>,
    id: String,
    status: String,
) -> Result<OkResult, AppError> {
    let conn = state.db.lock();
    suggestions::set_status(&conn, &id, &status)?;
    Ok(OkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn graph_suggestion_accept(
    state: State<AppState>,
    id: String,
) -> Result<OkResult, AppError> {
    let note_id = suggestions::graph_suggestion_accept(&mut state.db.lock(), &id)?;
    crate::events::publish(Some(&note_id), false);
    Ok(OkResult { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn graph_suggestion_dismiss(
    state: State<AppState>,
    id: String,
) -> Result<OkResult, AppError> {
    let (note_id, related_note_id) = suggestions::graph_suggestion_dismiss(&mut state.db.lock(), &id)?;
    crate::events::publish(Some(&note_id), false);
    crate::events::publish(Some(&related_note_id), false);
    Ok(OkResult { ok: true })
}

// ── P2 3단계: 링크 붙여넣기 후행 제안 (docs/PLAN-2026-08-07-second-brain.md Q5) ────────────────

/// AI 컨텍스트로 넘길 페이지 텍스트 상한 — ai::AI_TEXT_CHAR_CAP(8192, 정리/생성 본문 정책)의
/// 절반보다도 좁게 잡는다: 여기서 필요한 건 2-3문장 요약뿐이라 전체 기사를 다 보낼 이유가 없다.
const LINK_SUMMARY_MAX_CHARS: usize = 4000;

#[derive(Serialize)]
pub struct LinkSuggestResult {
    pub ok: bool,
}

/// link_suggest / link_preview 가 공유하는 파이프라인 결과. `link_proposal` 은 **어떤 행도 쓰지
/// 않는다** — suggestions 행 삽입은 link_suggest 만의 몫이고, 펫 클립보드 저장(Q9)은 사용자가
/// 확인 카드에서 승낙하기 전까지 아무것도 저장하면 안 되기 때문에 이 둘이 갈린다.
struct LinkProposal {
    workspace_id: String,
    title: String,
    summary: String,
    target_note_id: Option<String>,
    target_note_title: Option<String>,
    score: f32,
}

#[derive(Serialize)]
struct LinkSuggestionPayload<'a> {
    url: &'a str,
    summary: &'a str,
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_note_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_note_title: Option<&'a str>,
}

/// 에디터에서 단독 URL을 붙여넣었을 때 프런트가 fire-and-forget(callSilent)으로 호출한다
/// (src/components/EditorPanel.tsx handleImagePaste 옆 — soleUrlFromPasteText). 실효 게이트는
/// suggestions::link_suggestions_active 한 지점 — 아래 link_proposal 이 외부 fetch 전에 확인해
/// OFF면 조용히 { ok: false }를 돌려준다(에러 아님, 프런트가 매 붙여넣기마다 토스트를 띄우지
/// 않는다). 중복 방지는 이 커맨드만의 관심사라 여기 남는다: 같은 note_id+url의 pending 제안이
/// 이미 있으면 fetch 전에 no-op.
///
/// attachment_fetch_reader의 "명시적 사용자 액션에서만 fetch, 백그라운드 프리페치 금지" 원칙의
/// 의도적 예외 — link_suggestions 옵트인 설정 자체가 그 명시적 동의를 대신한다(설정 힌트에
/// "붙여넣은 링크를 가져와 요약하기 위해 해당 사이트에 접속함"을 명시, src/i18n/*.json
/// settings.link_suggestions_hint).
#[tauri::command(rename_all = "snake_case")]
pub async fn link_suggest(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    note_id: String,
    url: String,
) -> Result<LinkSuggestResult, AppError> {
    // 락은 블록으로 끊는다 — 바로 아래 link_proposal 이 같은 락을 다시 잡는다(재진입 불가).
    let duplicate = {
        let conn = state.db.lock();
        suggestions::has_pending_link(&conn, &note_id, &url)?
    };
    if duplicate {
        return Ok(LinkSuggestResult { ok: false });
    }
    let Some(p) = link_proposal(&state, workspace_id, &url, Some(&note_id)).await? else {
        return Ok(LinkSuggestResult { ok: false });
    };

    let related_note_id = p.target_note_id.clone().unwrap_or_else(|| note_id.clone());
    let payload = serde_json::to_string(&LinkSuggestionPayload {
        url: &url,
        summary: &p.summary,
        title: &p.title,
        target_note_id: p.target_note_id.as_deref(),
        target_note_title: p.target_note_title.as_deref(),
    })
    .unwrap_or_else(|_| "{}".to_string());
    // The suggestion and its outbound-AI audit entry are one logical write. If either fails,
    // rollback so the caller never sees an accepted result with a missing audit trail.
    let mut conn = state.db.lock();
    let tx = conn.transaction().map_err(crate::error::db)?;
    suggestions::insert_link(&tx, &p.workspace_id, &note_id, &related_note_id, &url, p.score, &payload)?;
    ai::record_history(&tx, &p.workspace_id, Some(&note_id), "link_suggest", Some(&url), &p.summary)?;
    tx.commit().map_err(crate::error::db)?;

    Ok(LinkSuggestResult { ok: true })
}

#[derive(Serialize)]
pub struct LinkPreviewResult {
    pub ok: bool,
    pub title: String,
    pub summary: String,
    pub target_note_id: Option<String>,
    pub target_note_title: Option<String>,
}

/// 같은 파이프라인을 **저장 없이** 돌려주는 형제 커맨드 — 펫 우클릭 "클립보드 저장"(Q9,
/// docs/PLAN-2026-08-08-presets-schedule.md)이 쓴다. link_suggest 와 갈린 이유는 두 가지다:
/// (1) 클립보드에는 출처 노트가 없는데 suggestions 행은 note_id NOT NULL + notes 조인이라 넣을
/// 수가 없고, (2) Q9 의 "확인 후에만 저장" 이 확인 전 어떤 쓰기도 금지한다. 게이트/중복/요약
/// 프롬프트를 프런트에서 다시 구현하지 않으려고 커맨드로 낸다.
///
/// 게이트 OFF(ai_enabled && link_suggestions)거나 본문을 못 뽑으면 ok:false — 에러가 아니다.
/// 호출자는 그때 "라우팅 없이 인박스에 그대로 저장"으로 강등한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn link_preview(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    url: String,
) -> Result<LinkPreviewResult, AppError> {
    let Some(p) = link_proposal(&state, workspace_id, &url, None).await? else {
        return Ok(LinkPreviewResult {
            ok: false,
            title: String::new(),
            summary: String::new(),
            target_note_id: None,
            target_note_title: None,
        });
    };
    // 아직 아무것도 저장하지 않았지만 **외부 fetch + AI 호출은 이미 일어났다** — 감사 기록은
    // 수락 여부가 아니라 호출 사실을 남기는 것이라 여기서 바로 기록한다(link_suggest 와 달리
    // 같은 트랜잭션에 묶을 상대 행이 없다).
    {
        let conn = state.db.lock();
        ai::record_history(&conn, &p.workspace_id, None, "link_preview", Some(&url), &p.summary)?;
    }
    Ok(LinkPreviewResult {
        ok: true,
        title: p.title,
        summary: p.summary,
        target_note_id: p.target_note_id,
        target_note_title: p.target_note_title,
    })
}

/// 게이트 확인 → 외부 fetch → AI 요약 → 대상 노트 후보(하이브리드 검색). 게이트 OFF이거나 본문이
/// 비면 Ok(None)(에러 아님). `exclude_note_id` 는 대상 후보에서 뺄 노트 — 붙여넣기 경로에서는
/// 자기 자신, 클립보드 경로에서는 없음.
async fn link_proposal(
    state: &tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    url: &str,
    exclude_note_id: Option<&str>,
) -> Result<Option<LinkProposal>, AppError> {
    let (ws, creds, model) = {
        let conn = state.db.lock();
        if !suggestions::link_suggestions_active(&conn) {
            return Ok(None);
        }
        let ws = match workspace_id {
            Some(w) => w,
            None => folders::active_workspace_id(&conn)?,
        };
        // 설정 조회 오류는 ai::read_ai_creds 와 달리 여기서 전파한다(커맨드 계약).
        let s = settings::get_all(&conn)?;
        let creds = ai::read_ai_creds_from(&s);
        // link_suggestions_model(빈 문자열·부재)이면 전역 ai_model 로 폴백 — 둘 다 trim 후 비면
        // Ollama 기본 모델이 transport 안에서 정해진다. 프로바이더 자체는 게이트가 검증하므로
        // 여기서 enum 검증을 다시 하지 않는다.
        let model = s
            .get("link_suggestions_model")
            .and_then(|v| v.as_str())
            .filter(|m| !m.trim().is_empty())
            .map(str::to_string)
            .or_else(|| creds.model.clone());
        (ws, creds, model)
    };

    // 락 밖: 외부 fetch — repo::web_reader(attachment_fetch_reader가 쓰는 것과 동일한 추출기).
    let reader = web_reader::fetch_reader(url).await?;
    let page_text: String = reader.text.chars().take(LINK_SUMMARY_MAX_CHARS).collect();
    if page_text.trim().is_empty() {
        return Ok(None);
    }

    // 락 밖: AI 요약. TextTransport(프라이버시 게이트가 이미 이 함수 진입 시 ai_enabled=true를
    // 보장하므로 privacy_gate_ok 재확인은 불필요 — link_suggestions_active가 ai_enabled를 포함하는
    // 더 엄격한 조건)/프로바이더 해석은 재사용하지만, generate_from_prompt_inner의 "선택적 배경"
    // 프레이밍("use only if relevant … you may write content that goes beyond it")은 "이 텍스트를
    // 정확히 요약"이라는 용도와 안 맞아 시스템 프롬프트를 직접 구성한다.
    let (p, ep) = ai::resolve_provider_and_endpoint(&creds.provider, creds.endpoint)?;
    let transport = ai::RealTextTransport::new(crate::commands::ai::fallback_model_setting(state));
    let system_prompt = "You summarize a web page for the user's personal notes app. Respond with \
        EXACTLY two lines and nothing else:\nTITLE: <a short descriptive title, under 60 characters>\n\
        SUMMARY: <a 2-3 sentence summary, written in the same language as the page>"
        .to_string();
    let user_text = format!(
        "Page URL: {url}\nPage title (may be missing): {}\n\nPage text:\n{page_text}",
        reader.title.as_deref().unwrap_or("")
    );
    let raw = transport.send_text(p, ep, creds.api_key, model, system_prompt, user_text).await?;
    let (title, summary) = parse_title_summary(&raw, reader.title.as_deref(), &page_text);

    // 다시 락: 대상 노트 후보(FTS 검색, 제외 노트가 있으면 건너뛴다).
    let conn = state.db.lock();
    let res = search::search(&conn, &summary, Some(search::FULL_SPAN_FROM), Some(search::FULL_SPAN_TO), Some(ws.clone()), None)?;
    let target = res.results.into_iter().find(|n| Some(n.id.as_str()) != exclude_note_id);
    Ok(Some(LinkProposal {
        workspace_id: ws,
        title,
        summary,
        score: if target.is_some() { 1.0 } else { 0.0 },
        target_note_id: target.as_ref().map(|t| t.id.clone()),
        target_note_title: target.as_ref().map(|t| t.title.clone()),
    }))
}

/// 모델 응답에서 "TITLE: … / SUMMARY: …" 두 줄을 뽑는다. 모델이 형식을 안 지키면(드묾) 추출한
/// 페이지 제목/본문 앞부분으로 조용히 강등한다 — 후행 제안은 실패해도 사용자가 알아챌 필요 없는
/// 배경 작업이라, 파싱 실패를 에러로 올리지 않는다.
fn parse_title_summary(raw: &str, page_title: Option<&str>, page_text: &str) -> (String, String) {
    let mut title: Option<String> = None;
    let mut summary: Option<String> = None;
    for line in raw.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("TITLE:").or_else(|| line.strip_prefix("Title:")) {
            title = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("SUMMARY:").or_else(|| line.strip_prefix("Summary:")) {
            summary = Some(rest.trim().to_string());
        }
    }
    let title = title
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| page_title.unwrap_or("").to_string());
    let summary = summary
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| page_text.chars().take(240).collect());
    (title, summary)
}

#[cfg(test)]
mod link_suggest_tests {
    use super::*;

    #[test]
    fn parse_title_summary_extracts_labeled_lines() {
        let raw = "TITLE: Sejong the Great\nSUMMARY: King Sejong promulgated Hangul in 1443. It remains in use today.";
        let (title, summary) = parse_title_summary(raw, None, "fallback text");
        assert_eq!(title, "Sejong the Great");
        assert!(summary.contains("Hangul"));
    }

    #[test]
    fn parse_title_summary_falls_back_when_the_model_ignores_the_format() {
        let raw = "Sure! Here's a summary of the page you asked about.";
        let (title, summary) = parse_title_summary(raw, Some("Page Title"), "the actual extracted body text");
        assert_eq!(title, "Page Title", "no TITLE: line — falls back to the extracted page title");
        assert_eq!(summary, "the actual extracted body text", "no SUMMARY: line — falls back to page text head");
    }

    #[test]
    fn parse_title_summary_accepts_lowercase_labels() {
        let raw = "Title: lower\nSummary: case labels too";
        let (title, summary) = parse_title_summary(raw, None, "fallback");
        assert_eq!(title, "lower");
        assert_eq!(summary, "case labels too");
    }
}
