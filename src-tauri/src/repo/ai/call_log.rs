// repo::ai::call_log — AI 호출 로그(PLAN-2026-09-05-ai-guardrails.md §3 C-1~C-3).
// 기록 지점은 단 두 곳: mod.rs 의 RealTextTransport::send_text / RealVisionTransport::send_vision
// (재시도·폴백 바깥에서 한 번) — Fake transport(테스트용)는 이 struct 를 안 쓰므로 자동 제외된다.
//
// 저장 위치 결정(§3 C-1): ai_history 재사용 기각(워크스페이스당 50행 캡, "본문 미저장" 감사
// 불변식과 성격이 다름) / 새 SQLite 테이블 기각(마이그레이션·워크스페이스 FK·동기화 대상이
// 되어버림) / tracing crate 기각(새 의존성) → JSONL 파일 + 회전, std::fs 몇 줄로 끝난다.
//
// 진행 중(outcome=None) + 최근 종료 항목을 프로세스 전역 링 버퍼(상한 CAP)에 함께 담아
// commands::ai::ai_calls_active/ai_calls_recent 가 읽는다. 종료된 항목만 ai-calls.jsonl 에
// append(2MB 넘으면 ai-calls.1.jsonl 로 1회 회전, 두 세대만 보관) — 파일 쓰기 실패는 호출을
// 실패시키지 않는다(로그는 부수 효과).
//
// ponytail: 로그 디렉터리(OnceLock<PathBuf>)와 verbose 플래그(AtomicBool)는 lib.rs 부팅 시
// `init()` 한 번으로 세팅한다. RealTextTransport::new/RealVisionTransport::new 호출부가
// commands/{ai,pet,collect,suggestions}.rs·collect/summary.rs·sync_server/ingest.rs 등
// 10곳 넘게 흩어져 있어, 매 생성자에 conn/AppState 를 새로 꿰어 커맨드마다 ai_debug_verbose 를
// 다시 읽게 하는 대신 전역 스냅샷을 택했다 — 설정을 바꿔도 앱 재시작 전까지는 반영되지 않는다.
// 핫리로드가 필요해지면 commands::settings::settings_set 이 이 AtomicBool 도 같이 갱신하도록
// 배선한다(현재는 그 파일을 이 웨이브 범위 밖으로 남겨둔다).
// http_status 필드도 항상 None이다: check_ai_status 가 상태 코드를 문자열 메시지에 녹여
// AppError 로 반환할 뿐 구조화된 코드로 넘기지 않아서다 — provider_send_text/vision 이
// (StatusCode, String) 같은 구조화 에러를 돌려주게 바뀌면 그때 채운다.

use super::transport;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

const CAP: usize = 300;
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
/// WG(2026-09-06) G3 — verbose(ai_debug_verbose) ON일 때는 한 줄이 prompt_head/response_head
/// (각 최대 2000자)까지 실려 4KB 가까이 커진다. 2MB 상한이면 500건마다 회전해 두 세대(≈1000건)
/// 만 남는데, 진단 목적으로 켠 verbose가 오히려 배치 작업 한 번에 로그를 통째로 밀어내 버린다 —
/// 켜져 있는 동안만 상한을 5배(10MB, ≈2500건×2세대)로 늘린다. OFF일 때는 기존 2MB 그대로.
const ROTATE_BYTES_VERBOSE: u64 = 10 * 1024 * 1024;
const VERBOSE_HEAD_CHARS: usize = 2000;
const LOG_FILE_NAME: &str = "ai-calls.jsonl";
const ROTATED_FILE_NAME: &str = "ai-calls.1.jsonl";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static VERBOSE: AtomicBool = AtomicBool::new(false);
static RING: OnceLock<Ring> = OnceLock::new();

tokio::task_local! {
    /// PLAN-2026-09-05 §3 C-1/C-2: 호출 컨텍스트. `commands::ai`의 각 AI 커맨드가 트랜스포트
    /// 호출까지(같은 태스크 안에서) 이 scope로 감싸면, `begin()`이 이 값을 읽어 op/caller/
    /// note_id/request_id를 채운다 — `TextTransport::send_text` 등 트레잇 시그니처를 바꾸지
    /// 않고도(테스트 목 7개를 그대로 둔 채) 호출 출처를 알아낸다.
    /// 함정(스폰 경계): `tokio::spawn`/`spawn_blocking`으로 태스크를 갈아타면 전파되지 않는다 —
    /// commands::ai의 각 커맨드는 진입부터 transport 호출까지 한 async fn 안에서 그대로
    /// 이어지므로(내부에 spawn 없음, WC 완료 보고 "task-local 전파" 절 참고) 문제 없다. 배경
    /// 경로(collect::summary/commands::pet/sync_server::ingest)는 이 scope를 아예 걸지 않으므로
    /// (해당 파일들은 이 웨이브의 수정 범위 밖) 항상 None — 현행과 동일한 동작.
    static CALL_CTX: CallCtx;
}

#[derive(Debug, Clone, Default)]
pub struct CallCtx {
    pub op: Option<String>,
    pub caller: Option<String>,
    pub note_id: Option<String>,
    pub request_id: Option<String>,
}

/// commands::ai의 각 AI 커맨드가 트랜스포트 호출까지 포함해 본문 전체를 감싼다 —
/// `CALL_CTX.scope`의 얇은 재수출.
pub async fn with_call_ctx<F: std::future::Future>(ctx: CallCtx, fut: F) -> F::Output {
    CALL_CTX.scope(ctx, fut).await
}

fn current_ctx() -> Option<CallCtx> {
    CALL_CTX.try_with(Clone::clone).ok()
}

/// lib.rs 부팅 시 한 번(app.manage(AppState) 직후) 호출한다. data_dir = DB 와 같은 앱 데이터
/// 디렉터리. 두 번째 호출은 조용히 무시된다(OnceLock) — 테스트가 아니라면 실제로 한 번뿐이다.
pub fn init(data_dir: PathBuf, verbose: bool) {
    let _ = LOG_DIR.set(data_dir);
    VERBOSE.store(verbose, Ordering::Relaxed);
}

pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// §3 C-3 핫리로드 — `commands::settings::settings_set`이 `ai_debug_verbose` 저장 성공 직후
/// 호출한다. `init()`이 부팅 시 심는 것과 같은 `AtomicBool`을 그대로 갱신하므로, 끄면 바로 다음
/// 호출부터 본문 캡처가 멈춘다(이전엔 재시작 전까지 계속 기록됐다 — 프라이버시 결함).
pub fn set_verbose(v: bool) {
    VERBOSE.store(v, Ordering::Relaxed);
}

fn ring() -> &'static Ring {
    RING.get_or_init(|| Ring::new(CAP))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallLogEntry {
    pub ts: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub provider: String,
    pub model: String,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub prompt_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_bytes: Option<usize>,
    /// ok | error | deadline | cancelled — None 이면 아직 진행 중(in-flight).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// ai_debug_verbose 가 켜져 있을 때만 채워진다(§3 C-3) — 앞 2000자, 본문 전체 아님.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_head: Option<String>,
    /// §3 C-2: 프런트가 실은 요청 id — CALL_CTX(with_call_ctx)에서만 채워진다(begin()에 별도
    /// 파라미터 없음). `ai_cancel_call`이 `request_id`로 넘어오면 이 필드가 일치하는 진행 중
    /// 호출 전부를 취소한다(같은 사용자 행동이 여러 실호출로 갈라지는 경우 — 예: 재시도 버튼을
    /// 두 번 눌러 이전 요청이 아직 살아 있는 경우 — 를 한 번에 정리하기 위함).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// I4 — 게이트 [버리기] 사유(wrong|too_long|bad_format|other, 검증은 commands::ai 쪽).
    /// JSONL은 append-only라 이미 기록된 줄엔 못 채운다(항상 None으로 직렬화) — 실제 사유는
    /// 별도 kind="annotation" 줄로 남는다(`annotate` 아래). 이 필드는 아직 파일에 안 쓰인
    /// 진행/최근 항목을 UI가 재부팅 전까지 바로 보여줄 수 있게 메모리 링에서만 채워진다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discard_reason: Option<String>,
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// verbose 인자를 받는 순수 버전 — 전역 `AtomicBool` 을 직접 흔드는 테스트 없이(병렬 테스트 간
/// 간섭 방지) 단위 테스트할 수 있도록 분리했다. 실사용은 아래 `capture_head`(전역 플래그 위임).
fn capture_head_for(text: &str, verbose: bool) -> Option<String> {
    verbose.then(|| truncate_chars(text, VERBOSE_HEAD_CHARS))
}

/// verbose 일 때만 Some(잘라낸 문자열) — 호출부(mod.rs)가 매번 `verbose()` 를 검사하지 않도록
/// 본문 캡처 여부 판단을 여기 한 곳에 모은다.
pub fn capture_head(text: &str) -> Option<String> {
    capture_head_for(text, verbose())
}

/// 호출 시작 — 링 버퍼에 outcome=None(in-flight) 항목을 넣고 id 를 돌려준다. op/caller/note_id 는
/// RealTextTransport::send_text/RealVisionTransport::send_vision 의 현재 시그니처로는 알 수 없어
/// None 으로 둔다(ponytail: 얻으려면 두 트레잇의 시그니처를 바꿔야 하고, 그건 이 웨이브가
/// "최소 변경" 원칙상 피하는 더 큰 리팩터다 — 필요해지면 op/caller 를 TextTransport::send_text
/// 파라미터에 추가하고 모든 구현체/목을 갱신).
#[allow(clippy::too_many_arguments)]
pub fn begin(
    op: Option<String>,
    caller: Option<String>,
    provider: String,
    model: String,
    note_id: Option<String>,
    prompt_bytes: usize,
    prompt_head: Option<String>,
) -> String {
    // §3 C-1: 명시적 인자가 항상 이긴다(vision이 op="vision"을 명시하는 것처럼) — CALL_CTX는
    // 인자가 None일 때만 채우는 폴백이다. request_id는 인자로 오지 않으므로 CTX가 유일한 출처.
    let ctx = current_ctx();
    let op = op.or_else(|| ctx.as_ref().and_then(|c| c.op.clone()));
    let caller = caller.or_else(|| ctx.as_ref().and_then(|c| c.caller.clone()));
    let note_id = note_id.or_else(|| ctx.as_ref().and_then(|c| c.note_id.clone()));
    let request_id = ctx.as_ref().and_then(|c| c.request_id.clone());
    let entry = CallLogEntry {
        ts: crate::util::now_iso(),
        id: crate::util::new_id(),
        op,
        caller,
        provider,
        model,
        fallback_used: false,
        note_id,
        attempts: 0,
        http_status: None,
        duration_ms: None,
        prompt_bytes,
        response_bytes: None,
        outcome: None,
        error: None,
        prompt_head,
        response_head: None,
        request_id,
        discard_reason: None,
    };
    let id = entry.id.clone();
    ring().push_begin(entry);
    id
}

/// 진짜 취소(§3 C-5 2단계) — `begin()`이 만든 id 하나당 취소 토큰을 하나 발급한다. 호출부
/// (`RealTextTransport::send_text`/`RealVisionTransport::send_vision`)가 요청을 보내기 직전에
/// 이걸 받아 `tokio::select!`로 `notified()`와 경합시킨다. 토큰이 없으면(이미 취소됐거나 끝났거나
/// 상한 초과로 밀려난 극단 상황) 그냥 select 없이 평소대로 진행한다 — 취소 기능이 실 호출을
/// 막지 않는다.
pub fn token(id: &str) -> Option<Arc<Notify>> {
    ring().token(id)
}

/// `ai_cancel_call` 커맨드가 직접 부른다. id가 아직 진행 중이면 신호를 보내고 true, 아니면(모르는
/// id · 이미 끝남 · 이미 한 번 취소됨) false — 토큰은 신호를 보낸 즉시 맵에서 제거되므로 같은 id
/// 두 번째 호출은 항상 false다.
pub fn cancel(id: &str) -> bool {
    ring().cancel(id)
}

/// §3 C-2 — `request_id`로 시작된 진행 중(outcome=None) 호출 전부를 취소한다. `ai_cancel_call`이
/// `id` 대신 `request_id`로 불렸을 때의 경로 — 프런트가 같은 사용자 행동을 여러 실호출로 쪼갠
/// 경우(예: 재시도 버튼을 두 번 눌러 이전 요청이 아직 살아 있는 경우)를 한 번에 정리한다.
/// 반환값은 실제로 신호가 나간 개수(끝난 호출·모르는 request_id는 세지 않는다).
pub fn cancel_by_request_id(request_id: &str) -> usize {
    ring().cancel_by_request_id(request_id)
}

/// 호출 종료 — `error` 는 항상 `transport::mask_secrets` 를 통과한 뒤 저장된다(호출부가 잊어도
/// 새지 않도록 이 함수 안에서 강제). 종료된 항목만 파일에 append 된다.
#[allow(clippy::too_many_arguments)]
pub fn finish(
    id: &str,
    attempts: u32,
    fallback_used: bool,
    duration_ms: i64,
    response_bytes: Option<usize>,
    outcome: &str,
    error: Option<String>,
    response_head: Option<String>,
) {
    let masked_error = error.map(|e| transport::mask_secrets(&e));
    let finished = ring().finish_by_id(id, |e| {
        e.attempts = attempts;
        e.fallback_used = fallback_used;
        e.duration_ms = Some(duration_ms);
        e.response_bytes = response_bytes;
        e.outcome = Some(outcome.to_string());
        e.error = masked_error;
        e.response_head = response_head;
    });
    if let Some(entry) = finished {
        if let Some(dir) = LOG_DIR.get() {
            append_line_in_dir(dir, &entry);
        }
    }
}

/// 진행 중(outcome=None) 항목 전부.
pub fn active() -> Vec<CallLogEntry> {
    ring().snapshot(|e| e.outcome.is_none())
}

/// 최근 종료된 항목 — 최신순, 최대 `limit`개.
pub fn recent(limit: usize) -> Vec<CallLogEntry> {
    let mut v = ring().snapshot(|e| e.outcome.is_some());
    v.reverse();
    v.truncate(limit);
    v
}

// ── 링 버퍼 ──────────────────────────────────────────────────────────────────────────────────

struct Ring {
    buf: Mutex<VecDeque<CallLogEntry>>,
    cap: usize,
    /// id별 취소 토큰. `push_begin`이 하나씩 발급하고, `cancel`(신호를 보낸 직후) 또는
    /// `finish_by_id`(호출이 정상/실패로 끝났을 때)가 제거한다 — 링 상한(300)과 별개로 이 맵이
    /// 무한정 자라지 않게 두 경로 모두에서 정리한다.
    tokens: Mutex<HashMap<String, Arc<Notify>>>,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Self { buf: Mutex::new(VecDeque::with_capacity(cap)), cap, tokens: Mutex::new(HashMap::new()) }
    }

    fn push_begin(&self, entry: CallLogEntry) {
        self.tokens.lock().unwrap().insert(entry.id.clone(), Arc::new(Notify::new()));
        let mut g = self.buf.lock().unwrap();
        if g.len() >= self.cap {
            let evicted = g.pop_front();
            if let Some(e) = evicted {
                self.tokens.lock().unwrap().remove(&e.id);
            }
        }
        g.push_back(entry);
    }

    fn token(&self, id: &str) -> Option<Arc<Notify>> {
        self.tokens.lock().unwrap().get(id).cloned()
    }

    /// 신호를 보낸 뒤 즉시 맵에서 제거한다 — 같은 id의 두 번째 `cancel()` 호출이 항상 false를
    /// 보도록 하는 지점이 여기다. 토큰 하나당 소비자(transport의 select)는 항상 하나뿐이므로
    /// `notify_one()`을 쓴다 — `notify_waiters()`와 달리 아직 아무도 `notified()`를 기다리고
    /// 있지 않은 찰나(취소가 요청 시작보다 먼저 도착하는 경우)에도 permit을 하나 저장해 두었다가
    /// 다음 `notified().await`를 즉시 통과시킨다.
    fn cancel(&self, id: &str) -> bool {
        let token = self.tokens.lock().unwrap().remove(id);
        match token {
            Some(notify) => {
                notify.notify_one();
                true
            }
            None => false,
        }
    }

    /// `request_id`가 일치하는 in-flight(outcome=None) id를 전부 모아 각각 `cancel()`한다.
    /// 스냅샷(id 목록)을 먼저 뜬 뒤 별도로 취소하는 이유는 `cancel()`이 다시 `tokens` 락을
    /// 잡기 때문 — `buf`를 순회하며 동시에 `tokens`도 잠그면 데드락은 아니지만(서로 다른
    /// Mutex) 불필요하게 락을 오래 쥔다.
    fn cancel_by_request_id(&self, request_id: &str) -> usize {
        let ids: Vec<String> = self
            .buf
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.outcome.is_none() && e.request_id.as_deref() == Some(request_id))
            .map(|e| e.id.clone())
            .collect();
        ids.iter().filter(|id| self.cancel(id)).count()
    }

    /// id 로 찾아 `mutate` 를 적용하고, 찾았으면 갱신된 항목의 복사본을 돌려준다(파일 append 용).
    /// 상한 초과로 이미 밀려난 in-flight 항목(300개 동시 호출 같은 극단 상황)은 조용히 no-op —
    /// 파일 로그는 못 남지만 호출 자체는 실패시키지 않는다.
    fn finish_by_id(&self, id: &str, mutate: impl FnOnce(&mut CallLogEntry)) -> Option<CallLogEntry> {
        self.tokens.lock().unwrap().remove(id);
        let mut g = self.buf.lock().unwrap();
        let entry = g.iter_mut().find(|e| e.id == id)?;
        mutate(entry);
        Some(entry.clone())
    }

    fn snapshot(&self, pred: impl Fn(&CallLogEntry) -> bool) -> Vec<CallLogEntry> {
        self.buf.lock().unwrap().iter().filter(|e| pred(e)).cloned().collect()
    }

    /// I4 — `request_id`가 일치하는 항목 전부(끝났든 진행 중이든)에 `discard_reason`을 채운다.
    /// 반환값은 실제로 채운 개수(모르는 request_id면 0).
    fn set_discard_reason_by_request_id(&self, request_id: &str, reason: &str) -> usize {
        let mut g = self.buf.lock().unwrap();
        let mut count = 0;
        for e in g.iter_mut() {
            if e.request_id.as_deref() == Some(request_id) {
                e.discard_reason = Some(reason.to_string());
                count += 1;
            }
        }
        count
    }
}

// ── 파일 append + 회전 ──────────────────────────────────────────────────────────────────────

/// WG(2026-09-06) G3 — 판정 지점 하나: verbose 여부로 회전 상한을 고른다. `append_line_in_dir`이
/// 매 호출마다 이 함수를 통해서만 상한을 얻는다(리터럴을 여러 곳에 흩어놓지 않는다).
fn rotate_limit() -> u64 {
    if verbose() { ROTATE_BYTES_VERBOSE } else { ROTATE_BYTES }
}

/// `limit` 넘으면 `ai-calls.1.jsonl` 로 한 번 회전(기존 세대는 덮어씀 = 두 세대만 보관). Windows의
/// `rename` 은 대상 파일이 이미 있으면 실패하므로(POSIX 와 달리 덮어쓰지 않음) 먼저 지운다.
fn rotate_if_needed(path: &Path, rotated_path: &Path, limit: u64) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= limit {
        return;
    }
    let _ = std::fs::remove_file(rotated_path);
    let _ = std::fs::rename(path, rotated_path);
}

/// 회전 판정 + append 한 지점 — `CallLogEntry`(finish) 도, 아래 `AnnotationLine`(annotate) 도
/// 이 함수 하나를 지난다(append-only 파일에 줄 종류만 다르게 쌓인다).
fn append_json_line<T: Serialize>(dir: &Path, value: &T) {
    let path = dir.join(LOG_FILE_NAME);
    let rotated = dir.join(ROTATED_FILE_NAME);
    rotate_if_needed(&path, &rotated, rotate_limit());
    let Ok(line) = serde_json::to_string(value) else { return };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

fn append_line_in_dir(dir: &Path, entry: &CallLogEntry) {
    append_json_line(dir, entry);
}

// ── I4: 게이트 [버리기] 사유 주석(annotation) ──────────────────────────────────────────────────

/// `kind="annotation"` 로 `CallLogEntry` 줄과 구분한다 — `ai_calls_summary`(아래)가 두 줄 종류를
/// 한 파일에서 갈라 읽는다.
#[derive(Debug, Clone, Serialize)]
struct AnnotationLine<'a> {
    kind: &'static str,
    ts: &'a str,
    request_id: &'a str,
    discard_reason: &'a str,
}

/// `ai_call_annotate` 커맨드가 부른다. `discard_reason` 값 검증(wrong|too_long|bad_format|other)은
/// commands::ai 쪽 — 여기는 이미 검증된 문자열을 그대로 기록만 한다.
/// 링에서 같은 `request_id`로 시작된 항목 전부(끝났든 진행 중이든)에 `discard_reason` 필드를
/// 채운다 — 재시도로 한 request_id에 호출이 여럿 걸렸어도 전부 반영한다.
pub fn annotate(request_id: &str, discard_reason: &str) {
    ring().set_discard_reason_by_request_id(request_id, discard_reason);
    if let Some(dir) = LOG_DIR.get() {
        let ts = crate::util::now_iso();
        append_json_line(dir, &AnnotationLine { kind: "annotation", ts: &ts, request_id, discard_reason });
    }
}

// ── I3: 최근 N일 집계(ai_calls_summary) ────────────────────────────────────────────────────────

const KNOWN_OUTCOMES: [&str; 4] = ["ok", "error", "deadline", "cancelled"];

#[derive(Debug, Clone, Default, Serialize)]
pub struct CallsSummary {
    pub total: u32,
    /// ok|error|deadline|cancelled — 넷 다 항상 키로 존재한다(관측 0건이어도 0).
    pub by_outcome: HashMap<String, u32>,
    pub by_provider: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p90_duration_ms: Option<i64>,
    pub discard_reasons: HashMap<String, u32>,
}

/// 정렬된 슬라이스에서 nearest-rank 백분위수. 평균 없이 실제 관측값 하나를 돌려준다(중간값이
/// 짝수 개일 때도) — ms 단위 정수 그대로 보여주는 진단 지표라 보간이 필요 없다.
fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let rank = (p * n as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(n - 1);
    Some(sorted[index])
}

/// `ai_calls_summary` 커맨드 — 메모리 링(300건·재부팅 시 소실)이 아니라 **파일**
/// (`ai-calls.jsonl` + 회전분 `.1`)을 읽는다. `LOG_DIR` 미설정(테스트가 `init()`을 안 부른
/// 경우)은 전부 0으로 돌아간다 — 에러가 아니다. 실제 파일 스캔은 `summarize_from_dir`
/// (아래, dir 인자를 받는 순수 버전 — `LOG_DIR`는 부팅 시 한 번만 채워지는 전역 OnceLock이라
/// 테스트가 임의 temp dir로 이 경로를 검증하려면 전역을 거치지 않는 갈래가 필요하다).
pub fn summarize(days: u32) -> CallsSummary {
    match LOG_DIR.get() {
        Some(dir) => summarize_from_dir(dir, days),
        None => empty_summary(),
    }
}

fn empty_summary() -> CallsSummary {
    let mut result = CallsSummary::default();
    for outcome in KNOWN_OUTCOMES {
        result.by_outcome.insert(outcome.to_string(), 0);
    }
    result
}

/// 파싱 실패 줄(다른 프로세스가 쓰는 도중의 부분 줄 등)은 건너뛴다. 파일이 없으면 전부 0.
fn summarize_from_dir(dir: &Path, days: u32) -> CallsSummary {
    let mut result = empty_summary();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(days));
    let mut durations: Vec<i64> = Vec::new();
    for name in [LOG_FILE_NAME, ROTATED_FILE_NAME] {
        let Ok(contents) = std::fs::read_to_string(dir.join(name)) else { continue };
        for line in contents.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some(ts_str) = value.get("ts").and_then(|v| v.as_str()) else { continue };
            let Ok(ts) = chrono::DateTime::parse_from_rfc3339(ts_str) else { continue };
            if ts.with_timezone(&chrono::Utc) < cutoff {
                continue;
            }
            if value.get("kind").and_then(|v| v.as_str()) == Some("annotation") {
                if let Some(reason) = value.get("discard_reason").and_then(|v| v.as_str()) {
                    *result.discard_reasons.entry(reason.to_string()).or_insert(0) += 1;
                }
                continue;
            }
            // finish()가 append한 CallLogEntry 줄 — begin()은 파일에 아무것도 쓰지 않으므로
            // 여기 도달하는 줄은 전부 종료된 호출이다.
            result.total += 1;
            if let Some(outcome) = value.get("outcome").and_then(|v| v.as_str()) {
                *result.by_outcome.entry(outcome.to_string()).or_insert(0) += 1;
            }
            if let Some(provider) = value.get("provider").and_then(|v| v.as_str()) {
                *result.by_provider.entry(provider.to_string()).or_insert(0) += 1;
            }
            if let Some(d) = value.get("duration_ms").and_then(|v| v.as_i64()) {
                durations.push(d);
            }
        }
    }
    durations.sort_unstable();
    result.median_duration_ms = percentile(&durations, 0.5);
    result.p90_duration_ms = percentile(&durations, 0.9);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str) -> CallLogEntry {
        CallLogEntry {
            ts: "2026-09-05T00:00:00.000Z".to_string(),
            id: id.to_string(),
            op: Some("generate".to_string()),
            caller: None,
            provider: "ollama".to_string(),
            model: "llama3.1".to_string(),
            fallback_used: false,
            note_id: None,
            attempts: 1,
            http_status: None,
            duration_ms: Some(42),
            prompt_bytes: 10,
            response_bytes: Some(20),
            outcome: Some("ok".to_string()),
            error: None,
            prompt_head: None,
            response_head: None,
            request_id: None,
            discard_reason: None,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brise-call-log-test-{tag}-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── 링 버퍼: 상한 300 초과 시 오래된 항목이 밀린다 ──────────────────────────────────────
    #[test]
    fn ring_evicts_oldest_entry_once_cap_is_exceeded() {
        let ring = Ring::new(3);
        for i in 0..4 {
            ring.push_begin(sample_entry(&format!("id-{i}")));
        }
        let ids: Vec<String> = ring.buf.lock().unwrap().iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids, vec!["id-1", "id-2", "id-3"], "id-0 must have been evicted");
    }

    #[test]
    fn finish_by_id_updates_in_place_and_ignores_unknown_id() {
        let ring = Ring::new(10);
        ring.push_begin(sample_entry("a"));
        let updated = ring.finish_by_id("a", |e| e.outcome = Some("ok".to_string()));
        assert!(updated.is_some());
        assert_eq!(updated.unwrap().outcome.as_deref(), Some("ok"));
        assert!(ring.finish_by_id("missing", |e| e.outcome = Some("ok".to_string())).is_none());
    }

    // ── 파일 회전: 2MB 경계 ──────────────────────────────────────────────────────────────────
    #[test]
    fn rotate_if_needed_moves_oversized_file_and_overwrites_previous_generation() {
        let dir = temp_dir("rotate");
        let path = dir.join(LOG_FILE_NAME);
        let rotated = dir.join(ROTATED_FILE_NAME);
        std::fs::write(&rotated, b"stale-generation").unwrap();
        std::fs::write(&path, vec![b'x'; (ROTATE_BYTES + 1) as usize]).unwrap();

        rotate_if_needed(&path, &rotated, ROTATE_BYTES);

        assert!(!path.exists(), "oversized file must have been moved away");
        let rotated_contents = std::fs::read(&rotated).unwrap();
        assert_eq!(rotated_contents.len(), (ROTATE_BYTES + 1) as usize, "rotated file must be the just-moved one, not the stale generation");
    }

    #[test]
    fn rotate_if_needed_leaves_small_file_alone() {
        let dir = temp_dir("no-rotate");
        let path = dir.join(LOG_FILE_NAME);
        std::fs::write(&path, b"small").unwrap();
        let rotated = dir.join(ROTATED_FILE_NAME);

        rotate_if_needed(&path, &rotated, ROTATE_BYTES);

        assert!(path.exists());
        assert!(!rotated.exists());
    }

    // ── G3(WG, 2026-09-06): verbose 시 회전 상한 10MB ───────────────────────────────────────
    #[test]
    fn rotate_limit_is_2mb_when_verbose_off_and_10mb_when_verbose_on() {
        set_verbose(false);
        assert_eq!(rotate_limit(), ROTATE_BYTES);
        set_verbose(true);
        assert_eq!(rotate_limit(), ROTATE_BYTES_VERBOSE);
        set_verbose(false); // 전역 AtomicBool — 다른 테스트에 새지 않도록 원복
    }

    #[test]
    fn rotate_if_needed_with_verbose_limit_does_not_rotate_a_file_only_just_over_the_2mb_limit() {
        let dir = temp_dir("rotate-verbose-under");
        let path = dir.join(LOG_FILE_NAME);
        let rotated = dir.join(ROTATED_FILE_NAME);
        // 비verbose 상한(2MB)은 넘지만 verbose 상한(10MB)은 안 넘는 크기 — verbose 회전 판정은
        // 이걸 건드리지 않아야 한다.
        std::fs::write(&path, vec![b'x'; (ROTATE_BYTES + 1) as usize]).unwrap();

        rotate_if_needed(&path, &rotated, ROTATE_BYTES_VERBOSE);

        assert!(path.exists(), "under the 10MB verbose limit — must not rotate");
        assert!(!rotated.exists());
    }

    #[test]
    fn rotate_if_needed_with_verbose_limit_rotates_past_10mb() {
        let dir = temp_dir("rotate-verbose-over");
        let path = dir.join(LOG_FILE_NAME);
        let rotated = dir.join(ROTATED_FILE_NAME);
        std::fs::write(&path, vec![b'x'; (ROTATE_BYTES_VERBOSE + 1) as usize]).unwrap();

        rotate_if_needed(&path, &rotated, ROTATE_BYTES_VERBOSE);

        assert!(!path.exists(), "past the 10MB verbose limit — must rotate");
        assert!(rotated.exists());
    }

    #[test]
    fn append_line_in_dir_writes_one_jsonl_line_per_call() {
        let dir = temp_dir("append");
        append_line_in_dir(&dir, &sample_entry("a"));
        append_line_in_dir(&dir, &sample_entry("b"));
        let contents = std::fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["id"], "a");
    }

    // ── mask_secrets 통과: 키 문자열이 파일에 남지 않는다 ──────────────────────────────────
    #[test]
    fn finish_masks_secrets_in_error_before_it_reaches_the_ring_or_file() {
        let dir = temp_dir("mask");
        let mut entry = sample_entry("secret-1");
        entry.outcome = None; // in-flight 상태로 시작
        let ring = Ring::new(10);
        ring.push_begin(entry);

        let raw_error = "claude request failed with status 401 — check your API key: Bearer sk-abcdefgh12345678";
        let masked = transport::mask_secrets(raw_error);
        let finished = ring
            .finish_by_id("secret-1", |e| {
                e.outcome = Some("error".to_string());
                e.error = Some(masked.clone());
            })
            .unwrap();

        assert!(!finished.error.as_deref().unwrap().contains("sk-abcdefgh12345678"));
        append_line_in_dir(&dir, &finished);
        let contents = std::fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(!contents.contains("sk-abcdefgh12345678"), "raw key must never reach the log file");
    }

    #[test]
    fn public_finish_applies_mask_secrets_even_if_caller_passes_a_raw_key() {
        // begin()/finish() 는 전역 링을 쓰므로, 다른 테스트와 값이 섞이지 않도록 이 테스트만의
        // provider 접두사로 검색한다(전역 상태를 초기화할 방법이 없다 — OnceLock).
        let id = begin(
            Some("generate".to_string()),
            None,
            "ollama-mask-test".to_string(),
            "llama3.1".to_string(),
            None,
            5,
            None,
        );
        finish(
            &id,
            1,
            false,
            10,
            None,
            "error",
            Some("Bearer sk-shouldbemasked1234".to_string()),
            None,
        );
        let entry = active()
            .into_iter()
            .chain(recent(CAP))
            .find(|e| e.id == id)
            .expect("entry must still be in the ring (finish updates in place, does not remove)");
        assert!(!entry.error.unwrap().contains("sk-shouldbemasked1234"));
    }

    // ── verbose 본문 캡처(전역 AtomicBool 을 건드리지 않는 순수 버전으로 테스트 — 병렬 테스트
    //    간 간섭을 피한다) ────────────────────────────────────────────────────────────────────
    #[test]
    fn capture_head_returns_none_when_verbose_is_off() {
        assert_eq!(capture_head_for("hello world", false), None);
    }

    #[test]
    fn capture_head_truncates_to_2000_chars_when_verbose_is_on() {
        let long = "a".repeat(3000);
        let head = capture_head_for(&long, true).unwrap();
        assert_eq!(head.chars().count(), VERBOSE_HEAD_CHARS);
    }

    #[test]
    fn serialized_entry_omits_prompt_and_response_head_when_absent() {
        let entry = sample_entry("no-body");
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("prompt_head"));
        assert!(!json.contains("response_head"));
    }

    // ── 진짜 취소(W5, §3 C-5 2단계): 토큰 발급/신호/정리 ────────────────────────────────────
    #[test]
    fn cancel_signals_once_then_returns_false_for_the_same_id() {
        let ring = Ring::new(10);
        ring.push_begin(sample_entry("in-flight"));
        assert!(ring.token("in-flight").is_some(), "begin() must issue a token immediately");

        assert!(ring.cancel("in-flight"), "first cancel finds the token and signals it");
        assert!(!ring.cancel("in-flight"), "second cancel on the same id must be false — signal only fires once");
        assert!(ring.token("in-flight").is_none(), "the token is removed once consumed by cancel");
    }

    #[test]
    fn cancel_returns_false_for_an_unknown_id() {
        let ring = Ring::new(10);
        assert!(!ring.cancel("never-existed"));
    }

    #[test]
    fn cancel_returns_false_once_the_call_has_finished() {
        let ring = Ring::new(10);
        ring.push_begin(sample_entry("done-soon"));
        ring.finish_by_id("done-soon", |e| e.outcome = Some("ok".to_string()));
        assert!(!ring.cancel("done-soon"), "finish() must clean up the token so a late cancel is a no-op");
    }

    #[tokio::test]
    async fn cancel_notify_one_stores_a_permit_even_if_no_one_is_waiting_yet() {
        // ai_cancel_call이 요청 시작보다 먼저 도착하는 극단 타이밍 — notify_one()이 permit을
        // 저장해 두었다가 나중에 오는 notified().await를 즉시 통과시켜야 한다(유실 금지).
        let ring = Ring::new(10);
        ring.push_begin(sample_entry("early-cancel"));
        let token = ring.token("early-cancel").unwrap();
        assert!(ring.cancel("early-cancel"));
        tokio::time::timeout(std::time::Duration::from_millis(200), token.notified())
            .await
            .expect("a cancel that arrived before anyone awaited notified() must not be lost");
    }

    /// begin → cancel → finish(outcome="cancelled") 전체 경로 — 취소된 호출이 JSONL에
    /// outcome:"cancelled" 로 남는다는 계약을 공개 API(전역 링)로 확인한다. 다른 테스트와 값이
    /// 섞이지 않도록 이 테스트만의 provider 접두사로 찾는다(전역 상태 — OnceLock이라 리셋 불가).
    #[tokio::test]
    async fn public_cancel_then_finish_records_cancelled_outcome() {
        let id = begin(
            None,
            None,
            "ollama-cancel-test".to_string(),
            "llama3.1".to_string(),
            None,
            5,
            None,
        );
        assert!(token(&id).is_some());
        assert!(cancel(&id));
        assert!(!cancel(&id), "signal fires once");

        finish(&id, 1, false, 12, None, "cancelled", None, None);

        let entry = active()
            .into_iter()
            .chain(recent(CAP))
            .find(|e| e.id == id)
            .expect("finished entry stays in the ring");
        assert_eq!(entry.outcome.as_deref(), Some("cancelled"));
    }

    #[test]
    fn serialized_entry_includes_head_fields_when_present() {
        let mut entry = sample_entry("with-body");
        entry.prompt_head = Some("hi".to_string());
        entry.response_head = Some("bye".to_string());
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"prompt_head\":\"hi\""));
        assert!(json.contains("\"response_head\":\"bye\""));
    }

    // ── task-local CALL_CTX(W-C1, §3 C-1/C-2) ───────────────────────────────────────────────
    // 다른 테스트와 값이 섞이지 않도록 이 테스트들만의 provider 접두사로 찾는다(전역 링 — 병렬
    // 테스트 간 공유, OnceLock이라 리셋 불가. 기존 mask/cancel 테스트들과 같은 자세).
    #[tokio::test]
    async fn begin_fills_op_caller_note_id_and_request_id_from_call_ctx_when_present() {
        let ctx = CallCtx {
            op: Some("generate".to_string()),
            caller: Some("ai_generate_from_prompt".to_string()),
            note_id: Some("note-ctx-1".to_string()),
            request_id: Some("req-ctx-1".to_string()),
        };
        let id = with_call_ctx(ctx, async {
            begin(None, None, "ollama-ctx-test".to_string(), "llama3.1".to_string(), None, 5, None)
        })
        .await;

        let entry = active().into_iter().chain(recent(CAP)).find(|e| e.id == id).expect("entry must be in the ring");
        assert_eq!(entry.op.as_deref(), Some("generate"));
        assert_eq!(entry.caller.as_deref(), Some("ai_generate_from_prompt"));
        assert_eq!(entry.note_id.as_deref(), Some("note-ctx-1"));
        assert_eq!(entry.request_id.as_deref(), Some("req-ctx-1"));
        finish(&id, 1, false, 1, None, "ok", None, None);
    }

    #[test]
    fn begin_outside_any_call_ctx_scope_leaves_op_caller_note_id_request_id_none() {
        // 현행 동작 회귀 가드: with_call_ctx 없이 부르면(배경 경로가 그렇다) 이전과 똑같이 전부
        // None이어야 한다.
        let id = begin(None, None, "ollama-noctx-test".to_string(), "llama3.1".to_string(), None, 5, None);
        let entry = active().into_iter().chain(recent(CAP)).find(|e| e.id == id).expect("entry must be in the ring");
        assert!(entry.op.is_none());
        assert!(entry.caller.is_none());
        assert!(entry.note_id.is_none());
        assert!(entry.request_id.is_none());
        finish(&id, 1, false, 1, None, "ok", None, None);
    }

    #[tokio::test]
    async fn explicit_op_argument_always_beats_call_ctx() {
        // vision처럼 호출부가 op를 명시하는 경우 — CTX에 다른 op가 떠 있어도 인자가 이긴다.
        let ctx = CallCtx { op: Some("generate".to_string()), ..Default::default() };
        let id = with_call_ctx(ctx, async {
            begin(Some("vision".to_string()), None, "ollama-explicit-op-test".to_string(), "m".to_string(), None, 1, None)
        })
        .await;
        let entry = active().into_iter().chain(recent(CAP)).find(|e| e.id == id).expect("entry must be in the ring");
        assert_eq!(entry.op.as_deref(), Some("vision"));
        finish(&id, 1, false, 1, None, "ok", None, None);
    }

    // ── ai_debug_verbose 핫리로드(W-C3) ──────────────────────────────────────────────────────
    #[test]
    fn set_verbose_hot_toggles_capture_head_without_restart() {
        // capture_head()는 전역 VERBOSE를 직접 읽는다 — settings_set::set_verbose가 갱신하는 바로
        // 그 플래그. 끄면 다음 호출부터 즉시 본문 캡처가 멈춘다는 계약을 검증한다.
        set_verbose(true);
        assert!(capture_head("hello").is_some(), "verbose on: capture_head must return Some");
        set_verbose(false);
        assert!(capture_head("hello").is_none(), "verbose off: capture_head must return None immediately, no restart needed");
    }

    // ── request_id 취소(W-C2) ────────────────────────────────────────────────────────────────
    #[test]
    fn cancel_by_request_id_cancels_only_in_flight_entries_with_the_matching_id() {
        let ring = Ring::new(10);
        let mut e1 = sample_entry("rid-a");
        e1.outcome = None;
        e1.request_id = Some("req-x".to_string());
        let mut e2 = sample_entry("rid-b");
        e2.outcome = None;
        e2.request_id = Some("req-x".to_string());
        let mut e3 = sample_entry("rid-c");
        e3.outcome = None;
        e3.request_id = Some("req-y".to_string());
        ring.push_begin(e1);
        ring.push_begin(e2);
        ring.push_begin(e3);

        let count = ring.cancel_by_request_id("req-x");

        assert_eq!(count, 2);
        assert!(ring.token("rid-a").is_none(), "cancelled token must be consumed");
        assert!(ring.token("rid-b").is_none());
        assert!(ring.token("rid-c").is_some(), "a different request_id must be untouched");
    }

    #[test]
    fn cancel_by_request_id_ignores_finished_calls_and_unknown_ids() {
        let ring = Ring::new(10);
        let mut done = sample_entry("rid-done");
        done.outcome = None; // starts in-flight so push_begin issues a token …
        done.request_id = Some("req-z".to_string());
        ring.push_begin(done);
        ring.finish_by_id("rid-done", |e| e.outcome = Some("ok".to_string())); // … then finishes.

        assert_eq!(ring.cancel_by_request_id("req-z"), 0, "a finished call must not be re-cancelled");
        assert_eq!(ring.cancel_by_request_id("never-seen"), 0);
    }

    #[test]
    fn public_cancel_by_request_id_returns_zero_for_an_unknown_id() {
        assert_eq!(cancel_by_request_id("no-such-request-id-anywhere"), 0);
    }

    #[tokio::test]
    async fn public_cancel_by_request_id_cancels_a_ctx_tagged_call() {
        let ctx = CallCtx { request_id: Some("global-req-2".to_string()), ..Default::default() };
        let id = with_call_ctx(ctx, async {
            begin(None, None, "ollama-reqid-scoped-test".to_string(), "llama3.1".to_string(), None, 5, None)
        })
        .await;

        assert_eq!(cancel_by_request_id("global-req-2"), 1);
        assert_eq!(cancel_by_request_id("global-req-2"), 0, "signal fires once per call");

        finish(&id, 1, false, 1, None, "cancelled", None, None);
        let entry = active().into_iter().chain(recent(CAP)).find(|e| e.id == id).expect("entry stays in the ring");
        assert_eq!(entry.outcome.as_deref(), Some("cancelled"));
    }

    // ── I4: 게이트 [버리기] 사유 주석 ────────────────────────────────────────────────────────────
    #[test]
    fn set_discard_reason_by_request_id_fills_every_matching_entry_and_ignores_unknown_id() {
        let ring = Ring::new(10);
        let mut e1 = sample_entry("dr-a");
        e1.request_id = Some("req-dr".to_string());
        let mut e2 = sample_entry("dr-b");
        e2.request_id = Some("req-dr".to_string());
        let mut e3 = sample_entry("dr-c");
        e3.request_id = Some("req-other".to_string());
        ring.push_begin(e1);
        ring.push_begin(e2);
        ring.push_begin(e3);

        let count = ring.set_discard_reason_by_request_id("req-dr", "too_long");

        assert_eq!(count, 2);
        let entries = ring.snapshot(|_| true);
        assert_eq!(entries.iter().find(|e| e.id == "dr-a").unwrap().discard_reason.as_deref(), Some("too_long"));
        assert_eq!(entries.iter().find(|e| e.id == "dr-b").unwrap().discard_reason.as_deref(), Some("too_long"));
        assert!(entries.iter().find(|e| e.id == "dr-c").unwrap().discard_reason.is_none());
        assert_eq!(ring.set_discard_reason_by_request_id("no-such-request-id", "other"), 0);
    }

    #[test]
    fn append_json_line_writes_an_annotation_line_distinguishable_by_kind() {
        let dir = temp_dir("annotate");
        append_json_line(&dir, &AnnotationLine { kind: "annotation", ts: "2026-09-06T00:00:00.000Z", request_id: "req-1", discard_reason: "wrong" });
        let contents = std::fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(value["kind"], "annotation");
        assert_eq!(value["request_id"], "req-1");
        assert_eq!(value["discard_reason"], "wrong");
    }

    // ── I3: ai_calls_summary ────────────────────────────────────────────────────────────────────
    #[test]
    fn summarize_from_dir_returns_all_zero_when_the_file_is_missing() {
        let dir = temp_dir("summary-missing");
        let summary = summarize_from_dir(&dir, 30);
        assert_eq!(summary.total, 0);
        assert_eq!(summary.by_outcome.get("ok"), Some(&0));
        assert_eq!(summary.by_outcome.get("error"), Some(&0));
        assert_eq!(summary.by_outcome.get("deadline"), Some(&0));
        assert_eq!(summary.by_outcome.get("cancelled"), Some(&0));
        assert!(summary.median_duration_ms.is_none());
        assert!(summary.p90_duration_ms.is_none());
        assert!(summary.discard_reasons.is_empty());
    }

    fn finished_entry_json(id: &str, ts: &str, provider: &str, outcome: &str, duration_ms: i64) -> String {
        let mut e = sample_entry(id);
        e.ts = ts.to_string();
        e.provider = provider.to_string();
        e.outcome = Some(outcome.to_string());
        e.duration_ms = Some(duration_ms);
        serde_json::to_string(&e).unwrap()
    }

    #[test]
    fn summarize_from_dir_aggregates_outcomes_providers_and_percentiles_within_the_window() {
        let dir = temp_dir("summary-agg");
        let now = chrono::Utc::now();
        let recent_ts = |secs_ago: i64| (now - chrono::Duration::seconds(secs_ago)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let old_ts = (now - chrono::Duration::days(40)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let mut lines = vec![
            finished_entry_json("s1", &recent_ts(10), "ollama", "ok", 100),
            finished_entry_json("s2", &recent_ts(20), "ollama", "ok", 200),
            finished_entry_json("s3", &recent_ts(30), "openai", "error", 300),
            // 30일 밖 — 집계에서 제외되어야 한다.
            finished_entry_json("s-old", &old_ts, "ollama", "ok", 9999),
        ];
        // annotation 줄도 같은 파일에 섞여 들어간다.
        let ann_ts = recent_ts(5);
        lines.push(serde_json::to_string(&AnnotationLine { kind: "annotation", ts: &ann_ts, request_id: "req-1", discard_reason: "wrong" }).unwrap());
        std::fs::write(dir.join(LOG_FILE_NAME), lines.join("\n") + "\n").unwrap();
        // 파싱 실패 줄(부분 쓰기 시뮬레이션) — 회귀 없이 건너뛰어야 한다.
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join(LOG_FILE_NAME)).unwrap();
        use std::io::Write;
        writeln!(f, "not json").unwrap();

        let summary = summarize_from_dir(&dir, 30);

        assert_eq!(summary.total, 3, "the 40-day-old entry must be excluded by the 30-day window");
        assert_eq!(summary.by_outcome.get("ok"), Some(&2));
        assert_eq!(summary.by_outcome.get("error"), Some(&1));
        assert_eq!(summary.by_provider.get("ollama"), Some(&2));
        assert_eq!(summary.by_provider.get("openai"), Some(&1));
        assert_eq!(summary.discard_reasons.get("wrong"), Some(&1));
        // durations sorted: [100, 200, 300] — median(rank ceil(0.5*3)=2 -> idx1)=200, p90(rank ceil(0.9*3)=3 -> idx2)=300
        assert_eq!(summary.median_duration_ms, Some(200));
        assert_eq!(summary.p90_duration_ms, Some(300));
    }
}
