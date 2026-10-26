// crate::collect::summary — post_process="summary" 자동 요약(PLAN-2026-09-04-local-import §2.4,
// Q4). 하루치 프롬프트 기록(줄 단위로 쌓인 "- " 라인)만 모델에 보내 goal/recurring/unresolved
// 세 필드짜리 JSON 객체로 답을 받고(구조화 출력 — 2026-09-05 실측: Gemma가 평문 모드에서는
// 사고 과정을 답에 흘려 세 줄 계약이 깨진다, `send_json` 참고), 노트 첫 섹션 맨 위 "## 요약"
// 블록으로 upsert한다. 모델의 답변만 쓰고 원래 대화 응답은 절대 읽지 않는다(Q6 유지 — 프롬프트만
// 요약, 대화 자체를 요약하지 않는다). 블록 두 번째 줄의 summarized_at 마커로 SUMMARY_DEBOUNCE
// (30분) 안에는 재요약을 건너뛴다 — 마커가 노트 본문 자체에 있어 앱 재시작·동기화를 그대로
// 견딘다(runner 프로세스 메모리에 두면 재시작마다 잊는다). AI 호출은 이 파일 유일의 진짜
// 백그라운드 호출이라 RealTextTransport::background()(120초 예산, TEXT_OPERATION_DEADLINE의
// 45초보다 넉넉함 — `maybe_summarize` 참고)를 쓴다.
//
// 락 규율(docs/COLLECT.md §2.2): 이 파일의 함수는 conn을 짧게 열고 닫는다 — AI 네트워크 호출
// 동안 어떤 커넥션도 들고 있지 않는다. `conn_factory`는 매번 새 커넥션을 여는 클로저로, 호출자
// (collect::run_one)의 ingest용 conn과는 별개다 — 실제로 conn을 쥐는 구간은 ①크레덴셜/본문
// 읽기 ②upsert 트랜잭션, 이 둘뿐이고 그 사이(AI 호출)엔 아무 conn도 열려 있지 않다.

use super::CollectCtx;
use crate::error::{db as dberr, AppResult};
use crate::repo::ai::{self, RealTextTransport, TextTransport};
use crate::repo::collect::CollectSource;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::time::Duration;

const SUMMARY_HEADER: &str = "## 요약";

/// 블록 안에 박아 두는 마지막 요약 시각 마커. 노트 본문 자체에 저장해 재시작·동기화를 견딘다
/// (runner 프로세스 메모리나 별도 DB 컬럼이 아니다 — 이 소스의 요약 결과가 다른 기기로 동기화
/// 되면 그 기기의 다음 실행도 이 마커를 보고 판단해야 하므로).
const SUMMARY_MARKER_PREFIX: &str = "<!-- summarized_at: ";
const SUMMARY_MARKER_SUFFIX: &str = " -->";

/// 짧은 runner 주기(예: 15분)로 매번 재요약하면 하루 96회까지 AI 호출이 낭비된다 — 최근에 이미
/// 요약했으면 조용히 건너뛴다.
const SUMMARY_DEBOUNCE: Duration = Duration::from_secs(30 * 60);

/// 노트 본문 중 프롬프트 줄만 모아 모델에 보내는 상한. generate_from_prompt_inner의 32K 운영
/// 상한과는 별개로, 요약은 "오늘 뭘 했나"만 파악하면 되므로 최근 맥락 8천자면 충분하다는 판단
/// (ponytail: 하루치가 이보다 훨씬 길어지면 청크 분할이 필요해질 수 있음, 지금은 아니다).
const PROMPT_CHAR_CAP: usize = 8_000;

/// 최대 길이(문자) — build_summary_lines가 각 필드를 이 값으로 자른다. 모델이 지시를 무시하고
/// 길게 답해도 노트 요약 블록이 무한정 자라지 않게 하는 안전판.
const FIELD_CHAR_CAP: usize = 200;

fn summary_system_prompt(custom: Option<&str>) -> String {
    if let Some(p) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        format!(
            "{p}\n반드시 다음 세 필드로만 답하라 — goal(무엇을 하려고 했는지 한 문장), \
             recurring(반복해서 나타난 주제 한 문장), unresolved(아직 풀리지 않은 질문 한 문장). \
             각 필드는 설명·번호·머리말 없이 짧은 한 문장으로, 200자 이내."
        )
    } else {
        "아래는 하루치 작업 프롬프트 기록이다. 다음 세 필드로만 답하라 — goal(무엇을 하려고 \
         했는지 한 문장), recurring(반복해서 나타난 주제 한 문장), unresolved(아직 풀리지 않은 \
         질문 한 문장). 각 필드는 설명·번호·머리말 없이 짧은 한 문장으로, 200자 이내."
            .to_string()
    }
}

fn summary_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "goal": {"type": "string"},
            "recurring": {"type": "string"},
            "unresolved": {"type": "string"}
        },
        "required": ["goal", "recurring", "unresolved"]
    })
}

/// 모델 JSON 응답 → 노트에 실제로 붙는 세 줄. 각 필드는 trim + 개행 제거 + FIELD_CHAR_CAP 컷.
fn build_summary_lines(v: &serde_json::Value) -> String {
    let field = |key: &str| -> String {
        let raw = v.get(key).and_then(|x| x.as_str()).unwrap_or("");
        let collapsed = raw.replace(['\n', '\r'], " ");
        collapsed.trim().chars().take(FIELD_CHAR_CAP).collect::<String>()
    };
    format!("목표: {}\n반복: {}\n미해결: {}", field("goal"), field("recurring"), field("unresolved"))
}

/// 본문에서 "- "로 시작하는 프롬프트 줄만 추려 이어 붙인다. PROMPT_CHAR_CAP을 넘으면 뒤쪽
/// (최신) 문자만 남긴다 — 하루 안에서는 append가 시간순이라 꼬리가 가장 최근 프롬프트다.
/// 프롬프트 줄이 하나도 없으면 None(§2.4 "fewer than 1 line" 게이트).
fn extract_prompt_context(body: &str) -> Option<String> {
    let joined = body
        .lines()
        .filter(|l| l.trim_start().starts_with("- "))
        .collect::<Vec<_>>()
        .join("\n");
    if joined.trim().is_empty() {
        return None;
    }
    let char_count = joined.chars().count();
    if char_count <= PROMPT_CHAR_CAP {
        return Some(joined);
    }
    let skip = char_count - PROMPT_CHAR_CAP;
    Some(joined.chars().skip(skip).collect())
}

/// 기존 "## 요약" 블록의 두 번째 줄에서 summarized_at 마커를 읽는다. 헤더가 없거나, 헤더는
/// 있는데 마커 줄 형식이 안 맞거나(구버전 노트 — 마커 도입 이전에 만들어진 블록), 타임스탬프
/// 파싱이 실패하면 전부 None("한 번도 요약된 적 없음"으로 관대하게 처리 — 디바운스가 옛 노트를
/// 영영 건너뛰게 만들면 안 된다).
fn parse_summarized_at(existing_body: &str) -> Option<DateTime<Utc>> {
    let rest = existing_body.strip_prefix(SUMMARY_HEADER)?.strip_prefix('\n')?;
    let marker_line = rest.lines().next()?;
    let ts = marker_line.strip_prefix(SUMMARY_MARKER_PREFIX)?.strip_suffix(SUMMARY_MARKER_SUFFIX)?;
    DateTime::parse_from_rfc3339(ts).ok().map(|dt| dt.with_timezone(&Utc))
}

/// "## 요약" 블록을 노트 본문 맨 위에 upsert한다. 본문이 이미 그 헤더로 시작하면(재실행) 그
/// 헤더 뒤 첫 빈 줄까지를 통째로 새 블록으로 교체해 두 번째 블록이 쌓이지 않게 하고, 아니면
/// 그냥 앞에 붙인다. 블록 두 번째 줄에 summarized_at 마커를 함께 박아 디바운스 판정이 이
/// 함수가 만든 블록을 그대로 되읽을 수 있게 한다.
fn build_summary_section(existing_body: &str, summary_lines: &str) -> String {
    let marker = format!("{SUMMARY_MARKER_PREFIX}{}{SUMMARY_MARKER_SUFFIX}", crate::util::now_iso());
    let block = format!("{SUMMARY_HEADER}\n{marker}\n{}\n\n", summary_lines.trim());
    let (_, rest) = split_summary_block(existing_body);
    format!("{block}{rest}")
}

/// 본문 맨 위 "## 요약" 블록(헤더 + 마커 + 내용 + 구분 빈 줄, 즉 첫 "\n\n" 까지)과 나머지로 나눈다 —
/// 블록 경계 규칙의 단일 지점. `build_summary_section`(교체)과 daynote 병합(최신 요약 승리)이
/// 같은 경계를 쓴다(예전엔 daynote 가 이 규칙을 복제해 들고 있었다).
pub(super) fn split_summary_block(body: &str) -> (Option<&str>, &str) {
    let Some(rest) = body.strip_prefix(SUMMARY_HEADER) else {
        return (None, body);
    };
    let cut = SUMMARY_HEADER.len() + rest.find("\n\n").map(|i| i + 2).unwrap_or(rest.len());
    (Some(&body[..cut]), &body[cut..])
}

/// 실제 로직 — 테스트가 가짜 `TextTransport`로 (a)게이트 닫힘/줄 없음 (b)정상 삽입 (c)재실행 시
/// 교체 (d)`post_process_model` 오버라이드를 검증한다. 프로덕션 경로(`maybe_summarize`)는 이
/// 함수를 `RealTextTransport` + `ctx.rt.block_on`으로 감싼다.
async fn summarize_with_transport<T: TextTransport>(
    conn_factory: &impl Fn() -> AppResult<Connection>,
    source: &CollectSource,
    note_id: &str,
    transport: &T,
) -> AppResult<()> {
    // a. 짧은 커넥션 — 크레덴셜 + 노트 본문만 읽고 바로 닫는다(락 규율).
    let (provider_str, endpoint, api_key, model, ai_enabled, context) = {
        let conn = conn_factory()?;
        let creds = ai::read_ai_creds(&conn);
        let body: Option<String> = conn
            .query_row(
                "SELECT body_md FROM sections WHERE note_id = ?1 ORDER BY position LIMIT 1",
                params![note_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(dberr)?;
        let Some(body) = body else { return Ok(()) }; // 노트가 그새 사라짐 — 조용히 종료
        if let Some(last) = parse_summarized_at(&body) {
            // signed_duration_since가 음수면(마커가 미래 — 시계 오차 극단 상황) to_std()가 Err를
            // 돌려주는데, Duration::ZERO로 접어 "방금 요약함"과 동일하게 취급한다 — 안전한 쪽으로
            // 기운다(호출 낭비보다 스킵이 낫다).
            let age = Utc::now().signed_duration_since(last).to_std().unwrap_or(Duration::ZERO);
            if age < SUMMARY_DEBOUNCE {
                return Ok(()); // 최근에 이미 요약함 — 조용히 스킵, transport 호출 없음
            }
        }
        let Some(context) = extract_prompt_context(&body) else { return Ok(()) }; // 줄 0개
        (creds.provider, creds.endpoint, creds.api_key, creds.model, creds.ai_enabled, context)
    }; // conn 드롭 — 이후 AI 호출 동안 어떤 conn도 들고 있지 않는다.

    let Ok((provider, ep)) = ai::resolve_provider_and_endpoint(&provider_str, endpoint) else {
        return Ok(());
    };
    if !ai::privacy_gate_ok(&provider, &ep, ai_enabled) {
        return Ok(()); // 게이트 닫힘 — 자동 백그라운드 작업이라 조용히 스킵(에러로 표면화 안 함)
    }

    // b. conn을 놓은 뒤에만 네트워크 호출. post_process_model이 설정 모델을 덮어쓴다.
    // generate_from_prompt_inner(평문 경로)는 여기서 쓰지 않는다 — Gemma가 평문 모드에서
    // 사고 과정을 답에 흘려 세 줄 계약이 깨지므로(2026-09-05 실측), send_json으로 직접
    // 구조화 출력을 받는다. 게이트는 위에서 이미 확인했으니 여기선 그대로 호출.
    let model_opt = source.post_process_model.clone().or(model);
    let custom_prompt = serde_json::from_str::<serde_json::Value>(&source.config)
        .ok()
        .and_then(|v| v.get("prompt").and_then(|p| p.as_str()).map(str::to_string));
    let sys_prompt = summary_system_prompt(custom_prompt.as_deref());
    let json = transport
        .send_json(provider, ep, api_key, model_opt, sys_prompt, context, summary_schema())
        .await?;
    let generated = build_summary_lines(&json);

    // c. 새 커넥션으로 다시 읽어(그 사이 편집됐을 수 있는 최신 본문 기준) upsert.
    upsert_summary_block(conn_factory, note_id, &generated)
}

fn upsert_summary_block(
    conn_factory: &impl Fn() -> AppResult<Connection>,
    note_id: &str,
    summary_lines: &str,
) -> AppResult<()> {
    let mut conn = conn_factory()?;
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT id, body_md FROM sections WHERE note_id = ?1 ORDER BY position LIMIT 1",
            params![note_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?;
    let Some((section_id, body)) = existing else {
        return Ok(()); // 노트가 그새 사라짐 — 쓸 곳이 없다
    };
    let next_body = build_summary_section(&body, summary_lines);
    let now = crate::util::now_iso();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) // 첫 문장이 읽기(write_body_tx 판정) — 승격 실패 방지
        .map_err(dberr)?;
    crate::repo::sections::write_body_tx(&tx, note_id, &section_id, &next_body, &now)?;
    crate::repo::fts::fts_upsert(&tx, note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(())
}

/// `collect::run_one`이 부르는 실제 진입점 — `RealTextTransport` + `ctx.rt.block_on`으로 네트워크
/// 호출을 감싼다. 실패는 전부 삼킨다: 노트 자체는 이미 성공적으로 ingest됐고, 이건 그 위에 얹는
/// 자동 후처리일 뿐이라 실패해도 소스의 last_error를 더럽히지 않는다(§2.4 "실패는 조용히 스킵").
pub(crate) fn maybe_summarize(
    conn_factory: impl Fn() -> AppResult<Connection>,
    ctx: &CollectCtx,
    source: &CollectSource,
    note_id: &str,
) {
    let transport = RealTextTransport::background();
    if let Err(e) = ctx.rt.block_on(summarize_with_transport(&conn_factory, source, note_id, &transport)) {
        crate::diag::warn("collect", "summary_post_process_failed", format!("source {}: {e}", source.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// 고정 JSON 응답을 돌려주며 마지막 호출의 model_opt를 기록하는 가짜 트랜스포트.
    /// `send_json`을 직접 오버라이드한다 — summary.rs는 이제 send_text가 아니라 send_json을
    /// 부르므로, send_text만 구현한 트랜스포트로는 이 경로를 재현할 수 없다(그건 아래
    /// FencedJsonText가 default send_json 경로를 검증하는 몫).
    struct RecordingText {
        response: serde_json::Value,
        calls: AtomicUsize,
        last_model: Mutex<Option<String>>,
    }

    impl RecordingText {
        fn new(goal: &str, recurring: &str, unresolved: &str) -> Self {
            Self {
                response: serde_json::json!({"goal": goal, "recurring": recurring, "unresolved": unresolved}),
                calls: AtomicUsize::new(0),
                last_model: Mutex::new(None),
            }
        }
    }

    impl TextTransport for RecordingText {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            unreachable!("summary.rs calls send_json, not send_text")
        }

        async fn send_json(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
            _schema: serde_json::Value,
        ) -> AppResult<serde_json::Value> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last_model.lock().unwrap() = model_opt;
            Ok(self.response.clone())
        }
    }

    /// send_json을 오버라이드하지 않는(=default 트레잇 구현에 의존하는) 가짜 — Gemma가 실제로
    /// 돌려주는 것처럼 ```json ... ``` 펜스로 감싼 문자열을 send_text에서 반환해, default
    /// send_json이 관대한 파서로 이걸 정상 파싱하는지 통합 경로(summarize_with_transport)로
    /// 검증한다.
    struct FencedJsonText(String);
    impl TextTransport for FencedJsonText {
        async fn send_text(
            &self,
            _provider: ai::Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            Ok(self.0.clone())
        }
    }

    /// 테스트 전용 소스 — collect_sources 행 없이 CollectSource 구조체만 필요한 필드로 직접 만든다
    /// (repo::collect.rs의 is_due 테스트들과 같은 패턴).
    fn test_source(post_process: &str, post_process_model: Option<&str>) -> CollectSource {
        CollectSource {
            id: "src1".into(),
            workspace_id: "ws1".into(),
            kind: "claude_prompts".into(),
            name: "Claude 프롬프트".into(),
            config: "{}".into(),
            enabled: true,
            dry_run: false,
            show_in_briefing: true,
            target_folder_id: None,
            post_process: post_process.into(),
            post_process_model: post_process_model.map(str::to_string),
            interval_minutes: None,
            last_run_at: None,
            last_status: None,
            last_error: None,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        }
    }

    /// tempdir + db::bootstrap로 파일 기반 DB를 만든다 — maybe_summarize는 conn_factory로 매번
    /// 새 커넥션을 열므로(락 규율), in-memory Connection(collect/mod.rs 테스트가 쓰는 방식)으로는
    /// 재현할 수 없다(경로로 재오픈이 안 됨).
    fn bootstrap_note(dir: &std::path::Path, body: &str) -> String {
        let mut conn = crate::db::bootstrap(dir).unwrap();
        let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
        let (note_id, _) = crate::repo::pet::create_inbox_note(&mut conn, &ws, None, Some("Test Note"), body).unwrap();
        note_id
    }

    fn conn_factory(dir: &std::path::Path) -> impl Fn() -> AppResult<Connection> {
        let path = crate::db::db_path(dir);
        move || crate::db::open(&path)
    }

    fn section_body(dir: &std::path::Path, note_id: &str) -> String {
        let conn = crate::db::open(&crate::db::db_path(dir)).unwrap();
        conn.query_row("SELECT body_md FROM sections WHERE note_id = ?1", params![note_id], |r| r.get(0)).unwrap()
    }

    /// 디바운스 윈도 밖 상태를 재현하려고 노트 본문을 직접 덮어쓴다(실제 대기 없이).
    fn set_section_body(dir: &std::path::Path, note_id: &str, body: &str) {
        let conn = crate::db::open(&crate::db::db_path(dir)).unwrap();
        conn.execute("UPDATE sections SET body_md=?1 WHERE note_id=?2", params![body, note_id]).unwrap();
    }

    /// 본문의 마커 줄(두 번째 줄)만 `minutes`분 전 시각으로 바꿔 넣는다 — SUMMARY_DEBOUNCE
    /// 판정을 실제 대기 없이 재현한다.
    fn age_marker(body: &str, minutes: i64) -> String {
        let marker_line = body.lines().nth(1).expect("body must already have a marker line");
        let aged_at = (Utc::now() - chrono::Duration::minutes(minutes)).to_rfc3339();
        let aged_marker = format!("{SUMMARY_MARKER_PREFIX}{aged_at}{SUMMARY_MARKER_SUFFIX}");
        body.replacen(marker_line, &aged_marker, 1)
    }

    /// "## 요약\n<!-- summarized_at: … -->\n목표: …\n반복: …\n미해결: …\n\n" 접두를 마커의
    /// 정확한 타임스탬프 값은 무시하고(형식만 확인) 검증한다 — now()를 테스트가 재현할 필요가
    /// 없게.
    fn assert_summary_block_prefix(body: &str, goal: &str, recurring: &str, unresolved: &str) {
        let marker_line = body.lines().nth(1).unwrap_or("");
        assert!(
            marker_line.starts_with(SUMMARY_MARKER_PREFIX) && marker_line.ends_with(SUMMARY_MARKER_SUFFIX),
            "marker line malformed: {marker_line:?}"
        );
        let expected =
            format!("{SUMMARY_HEADER}\n{marker_line}\n목표: {goal}\n반복: {recurring}\n미해결: {unresolved}\n\n");
        assert!(body.starts_with(&expected), "got: {body:?}");
    }

    #[tokio::test]
    async fn gate_closed_makes_no_ai_call_and_leaves_body_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        {
            // 기본값(provider=ollama+루프백)은 ai_enabled 없이도 게이트가 열린다(privacy_gate_ok)
            // — 실제로 닫힌 게이트를 재현하려면 원격 provider + ai_enabled=false(기본값)가 필요.
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_provider".to_string(), serde_json::json!("openai"));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트\n- 두번째 프롬프트");
        let source = test_source("summary", None);
        let transport = RecordingText::new("A", "B", "C");

        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &transport).await.unwrap();

        assert_eq!(transport.calls.load(Ordering::SeqCst), 0, "원격 provider + ai_enabled=false면 게이트가 닫혀 있어야 한다");
        assert_eq!(section_body(dir.path(), &note_id), "- 첫 프롬프트\n- 두번째 프롬프트");
    }

    #[tokio::test]
    async fn no_prompt_lines_makes_no_ai_call() {
        let dir = tempfile::tempdir().unwrap();
        // ai_enabled를 켜서 게이트는 통과시키되, 본문에 "- " 줄이 하나도 없어 컷되는 경로.
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "그냥 평문, 프롬프트 줄 아님");
        let source = test_source("summary", None);
        let transport = RecordingText::new("A", "B", "C");

        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &transport).await.unwrap();

        assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
        assert_eq!(section_body(dir.path(), &note_id), "그냥 평문, 프롬프트 줄 아님");
    }

    #[tokio::test]
    async fn fake_transport_response_is_prepended_as_a_summary_block() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트\n- 두번째 프롬프트");
        let source = test_source("summary", None);
        let transport = RecordingText::new("A", "B", "C");

        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &transport).await.unwrap();

        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        let body = section_body(dir.path(), &note_id);
        assert_summary_block_prefix(&body, "A", "B", "C");
        assert!(body.contains("- 첫 프롬프트"), "original prompt lines must survive below the block");
    }

    #[tokio::test]
    async fn fenced_json_response_from_a_send_text_only_transport_still_parses_via_default_send_json() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트");
        let source = test_source("summary", None);
        let transport = FencedJsonText(
            "```json\n{\"goal\":\"A\",\"recurring\":\"B\",\"unresolved\":\"C\"}\n```".to_string(),
        );

        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &transport).await.unwrap();

        let body = section_body(dir.path(), &note_id);
        assert_summary_block_prefix(&body, "A", "B", "C");
    }

    /// 디바운스 윈도 밖(마커를 31분 전으로 강제 노화)이면 재실행이 다시 AI를 부르고, 블록이
    /// 두 개로 쌓이지 않고 그 자리에서 통째로 교체된다.
    #[tokio::test]
    async fn rerunning_after_the_debounce_window_replaces_the_existing_block_instead_of_stacking_a_second_one() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트");
        let source = test_source("summary", None);

        let first = RecordingText::new("A", "B", "C");
        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &first).await.unwrap();
        assert_eq!(first.calls.load(Ordering::SeqCst), 1);

        // 실제 30분 대기 없이 디바운스 윈도를 지난 것처럼 마커를 늙힌다.
        let aged = age_marker(&section_body(dir.path(), &note_id), 31);
        set_section_body(dir.path(), &note_id, &aged);

        let second = RecordingText::new("X", "Y", "Z");
        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &second).await.unwrap();

        assert_eq!(second.calls.load(Ordering::SeqCst), 1, "디바운스 윈도 밖이면 다시 불러야 한다");
        let body = section_body(dir.path(), &note_id);
        assert_eq!(body.matches("## 요약").count(), 1, "must not stack a second block");
        assert_summary_block_prefix(&body, "X", "Y", "Z");
        assert!(!body.contains("목표: A"), "the stale first summary must be gone");
        assert!(body.contains("- 첫 프롬프트"));
    }

    /// 재실행이 30분 안이면(마커가 최근) transport를 아예 부르지 않고 본문도 손대지 않는다 —
    /// 짧은 runner 주기(예: 15분)에서 매번 재요약하는 낭비를 막는 디바운스의 핵심 계약.
    #[tokio::test]
    async fn rerun_within_the_debounce_window_skips_the_ai_call_and_leaves_the_block_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트");
        let source = test_source("summary", None);

        let first = RecordingText::new("A", "B", "C");
        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &first).await.unwrap();
        assert_eq!(first.calls.load(Ordering::SeqCst), 1);
        let body_after_first = section_body(dir.path(), &note_id);

        let second = RecordingText::new("X", "Y", "Z");
        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &second).await.unwrap();

        assert_eq!(second.calls.load(Ordering::SeqCst), 0, "재실행이 30분 안이면 transport를 부르면 안 된다");
        assert_eq!(section_body(dir.path(), &note_id), body_after_first, "본문이 바뀌면 안 된다");
    }

    #[tokio::test]
    async fn post_process_model_override_reaches_the_transport() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ai_enabled".to_string(), serde_json::json!(true));
            entries.insert("ai_model".to_string(), serde_json::json!("settings-default-model"));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        let note_id = bootstrap_note(dir.path(), "- 첫 프롬프트");
        let source = test_source("summary", Some("override-model"));
        let transport = RecordingText::new("A", "B", "C");

        summarize_with_transport(&conn_factory(dir.path()), &source, &note_id, &transport).await.unwrap();

        assert_eq!(transport.last_model.lock().unwrap().as_deref(), Some("override-model"));
    }

    #[test]
    fn extract_prompt_context_keeps_only_dash_lines_and_caps_to_the_newest_tail() {
        assert_eq!(extract_prompt_context("just text"), None);
        assert_eq!(extract_prompt_context("- one\n- two"), Some("- one\n- two".to_string()));

        let long_line = "- ".to_string() + &"x".repeat(PROMPT_CHAR_CAP);
        let capped = extract_prompt_context(&format!("- old\n{long_line}")).unwrap();
        assert!(capped.chars().count() <= PROMPT_CHAR_CAP);
        assert!(capped.ends_with('x'), "must keep the tail (newest), not the head");
    }

    #[test]
    fn build_summary_lines_trims_collapses_newlines_and_caps_each_field() {
        let v = serde_json::json!({
            "goal": "  줄바꿈\n있는\r\n목표  ",
            "recurring": "x".repeat(FIELD_CHAR_CAP + 50),
            "unresolved": ""
        });
        let lines = build_summary_lines(&v);
        assert_eq!(lines, format!("목표: 줄바꿈 있는  목표\n반복: {}\n미해결: ", "x".repeat(FIELD_CHAR_CAP)));
    }

    #[test]
    fn build_summary_section_prepends_or_replaces_the_top_block() {
        let fresh = build_summary_section("- line one", "무엇: A\n반복: B\n미해결: C");
        let marker_line = fresh.lines().nth(1).unwrap();
        assert!(marker_line.starts_with(SUMMARY_MARKER_PREFIX) && marker_line.ends_with(SUMMARY_MARKER_SUFFIX));
        assert_eq!(fresh, format!("## 요약\n{marker_line}\n무엇: A\n반복: B\n미해결: C\n\n- line one"));

        let replaced = build_summary_section(&fresh, "무엇: X\n반복: Y\n미해결: Z");
        let marker_line2 = replaced.lines().nth(1).unwrap();
        assert!(marker_line2.starts_with(SUMMARY_MARKER_PREFIX) && marker_line2.ends_with(SUMMARY_MARKER_SUFFIX));
        assert_eq!(replaced, format!("## 요약\n{marker_line2}\n무엇: X\n반복: Y\n미해결: Z\n\n- line one"));
    }

    #[test]
    fn parse_summarized_at_reads_the_marker_and_is_tolerant_of_missing_or_malformed_ones() {
        assert_eq!(parse_summarized_at("no header here"), None, "헤더 자체가 없음");
        assert_eq!(
            parse_summarized_at("## 요약\n목표: A\n반복: B\n미해결: C\n\n- x"),
            None,
            "마커 도입 이전 구버전 블록 — 두 번째 줄이 필드 줄"
        );
        assert_eq!(
            parse_summarized_at("## 요약\n<!-- summarized_at: not-a-date -->\n목표: A\n\n"),
            None,
            "형식은 맞지만 타임스탬프 파싱 실패"
        );

        let body = build_summary_section("- x", "목표: A\n반복: B\n미해결: C");
        let parsed = parse_summarized_at(&body).expect("build_summary_section이 만든 블록은 파싱돼야 한다");
        assert!(
            Utc::now().signed_duration_since(parsed).num_seconds() < 5,
            "방금 만든 마커는 현재 시각과 거의 같아야 한다"
        );
    }
}
