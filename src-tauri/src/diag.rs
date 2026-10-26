// diag — 앱 전역 진단 싱크 (AUDIT-2026-09-26-fallback-observability.md §7.1).
//
// 목적: 폴백이 "일어났다"가 릴리즈 빌드 디스크에 남는 곳이 repo/ai/call_log.rs 하나뿐이라는
// 구조적 구멍(§3 G1)에 대한 응답. 같은 레시피를 그대로 따른다 — JSONL + 회전 + 프로세스 전역
// 링버퍼, std::fs 만(§7.1이 tracing crate를 call_log 웨이브의 전례를 따라 다시 기각한다 — 새
// 크레이트 없음).
//
// 이 모듈이 아는 source는 "rust"(Rust 자체 코드, record/warn/error가 고정으로 쓴다) 또는
// 프런트가 보낸 창 라벨("main"/"settings"/"pet"/"pet-bubble"/"activity"/"ai-history"/
// "browser") 뿐이다 — 어느 쪽이든 record_from() 한 지점을 지난다.
//
// message는 300자로 절단해 저장한다(char 경계 안전 — truncate_chars, 바이트가 아니라 문자
// 단위). **노트 본문·전체 파일 경로를 절대 넣지 않는다** — repo/ai/call_log.rs의 "본문 미저장"
// 불변식과 같은 계약이다. 호출부가 이 불변식을 지키는지는 이 모듈이 강제할 수 없다(문자열만
// 보고 그게 노트 본문인지 구분할 방법이 없다) — 호출부 책임, 리뷰에서 잡는다.
//
// 디듀프(60초): 같은 (source, feature, code, level)이 60초 안에 다시 오면 파일에 새 줄을 또
// 쓰지 않고 기존 링 항목의 count만 올린다(파일 I/O가 실패 폭주 한 번마다 반복되는 것을 막는다).
// 60초가 지난 뒤 같은 키가 다시 오면(윈도 rollover) 그제서야 "그 버스트 동안 쌓인 count"를
// 담은 줄을 파일에 한 번 더 쓰고 새 윈도를 연다 — 그래서 파일에는 한 버스트당 "시작 1줄 +
// (버스트가 끝나고 다음 버스트가 실제로 시작될 때만) 마감 1줄"만 남는다.
// ponytail: 버스트가 끝난 뒤 같은 키가 다시는 안 오면 마감 줄은 안 쓰인다 — 파일만 보면 count가
// 실제보다 적어 보일 수 있다(프로세스가 살아있는 동안은 링 버퍼가 정확한 값을 갖고 있고,
// diag_recent가 파일+링을 합치므로 재시작 전까지는 문제없다). "간단하고 문서화된 규칙" 쪽을
// 택했다(§7.1 지시 — 정교한 회계보다 단순함 우선).
//
// 파일: diag.jsonl(2MB 넘으면 diag.1.jsonl로 1회 회전, 두 세대만 보관), 링 버퍼 상한 500 —
// 전부 repo/ai/call_log.rs와 같은 상수 성격, 이름만 다르다. LOG_DIR이 아직 안 채워졌으면(init()
// 전, 또는 이 함수를 안 부르는 단위 테스트) 파일 쓰기는 조용히 스킵되고 링 버퍼만 동작한다.
//
// notify_user()/worker_stopped()는 기록과 별개로 "사용자에게 보여줄 대기열"에 알림을 쌓는다.
// diag_take_notices 커맨드가 부팅 시 메인 창에서 한 번 가져가(drain) 표시한다.
//
// PINNED(다른 웨이브가 이 문자열 그대로에 의존한다 — 바꾸지 말 것):
//   - code="db_restored_from_backup", params={backup, quarantine} (각각 파일 **이름**만, 경로 아님)
//   - code="worker_stopped", params={worker}
//
// std::sync::Mutex 대신 parking_lot::Mutex를 쓴다 — record_from()은 "절대 패닉하지 않는다"는
// 계약이 있는데, std::sync::Mutex는 그 잠금을 쥔 코드가 패닉하면 poison되어 이후의 모든
// lock().unwrap()이 패닉한다(하필 install_panic_hook 안에서 diag::record_from을 다시 부르는
// 경로라 이중 패닉 위험까지 있다). parking_lot은 poison 자체가 없다(AppState가 이미 같은 이유로
// parking_lot을 쓴다, commands/mod.rs 주석 참고) — call_log.rs는 std::sync::Mutex를 쓰지만
// 그쪽엔 "절대 패닉 안 함" 계약이 없어 그대로 두고, 여기서만 갈아탄다.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const CAP: usize = 500;
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const LOG_FILE_NAME: &str = "diag.jsonl";
const ROTATED_FILE_NAME: &str = "diag.1.jsonl";
const MESSAGE_MAX_CHARS: usize = 300;
const DEDUPE_WINDOW: Duration = Duration::from_secs(60);
/// heartbeat()의 기본 기대 주기 — worker별로 다른 주기가 필요해지면
/// heartbeat_with_interval(worker, secs) 를 추가한다(지금은 호출부가 하나뿐이라 과설계 방지).
const DEFAULT_HEARTBEAT_EXPECTED_SECS: u64 = 60;
/// diag_status의 "stale" 판정 배수(기대 주기의 N배 동안 조용하면 stale).
const STALE_MULTIPLIER: u64 = 3;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static RING: OnceLock<Mutex<VecDeque<DiagEntry>>> = OnceLock::new();
static DEDUPE: OnceLock<Mutex<HashMap<String, DedupeWindow>>> = OnceLock::new();
static NOTICES: OnceLock<Mutex<Vec<Notice>>> = OnceLock::new();
static HEARTBEATS: OnceLock<Mutex<HashMap<String, WorkerBeat>>> = OnceLock::new();

fn ring() -> &'static Mutex<VecDeque<DiagEntry>> {
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}
fn dedupe_map() -> &'static Mutex<HashMap<String, DedupeWindow>> {
    DEDUPE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn notices() -> &'static Mutex<Vec<Notice>> {
    NOTICES.get_or_init(|| Mutex::new(Vec::new()))
}
fn heartbeats() -> &'static Mutex<HashMap<String, WorkerBeat>> {
    HEARTBEATS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// lib.rs 부팅 시 한 번(app.manage(AppState) 직후, repo::ai::call_log::init 바로 옆) 호출한다.
/// 두 번째 호출은 조용히 무시된다(OnceLock). data_dir = DB와 같은 앱 데이터 디렉터리.
/// init() 전에도(그리고 이 함수를 안 부르는 단위 테스트에서도) record_from()은 링 버퍼만으로
/// 동작한다 — 파일에는 안 남을 뿐 패닉하지 않는다.
pub fn init(data_dir: PathBuf) {
    // 첫 실행에는 data_dir 이 아직 없다(db::bootstrap 이 만든다) — init 이 부트스트랩 앞으로 옮겨진
    // 뒤라, 여기서 만들지 않으면 부팅 초기 기록이 파일에 못 남는다(append 가 조용히 실패).
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = LOG_DIR.set(data_dir);
}

/// diag_status 출력의 log_dir — 설정 안 됐으면 빈 문자열(에러 아님).
pub fn log_dir_display() -> String {
    LOG_DIR.get().map(|p| p.display().to_string()).unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// 커맨드 계층(diag_record)이 프런트가 보낸 문자열을 검증할 때 쓴다 — 잘못된 값은 VALIDATION.
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "info" => Some(Level::Info),
            "warn" => Some(Level::Warn),
            "error" => Some(Level::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagEntry {
    pub id: String,
    pub ts: String,
    pub level: String,
    pub source: String,
    pub feature: String,
    pub code: String,
    pub message: String,
    pub count: u32,
}

/// 부팅 시 메인 창이 drain해 표시하는 사용자 알림 한 건. code는 PINNED(모듈 헤더 참고).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notice {
    pub feature: String,
    pub code: String,
    pub params: HashMap<String, String>,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatus {
    pub name: String,
    pub last_beat: Option<String>,
    /// "alive" | "stale" | "stopped"
    pub state: String,
}

struct DedupeWindow {
    window_start: Instant,
    ring_id: String,
    count: u32,
}

struct WorkerBeat {
    last_instant: Instant,
    last_ts: String,
    expected_secs: u64,
    stopped: bool,
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// source/feature/code 는 맵 키가 된다 — 원격(sync 토큰 보유 기기)도 diag_record 를 부를 수
/// 있어서, 길이를 안 자르면 호출자가 고른 크기의 키로 전역 맵을 키울 수 있다.
const KEY_MAX_CHARS: usize = 64;
/// 디듀프 맵이 이 크기를 넘으면 만료된 창(60초 지난 키)을 걷어낸다 — 서로 다른 키를 계속 보내는
/// 호출자에게도 메모리 상한이 생긴다. ponytail: 걷어낸 창의 최종 count 는 파일로 flush 하지 않는다
/// (링 버퍼에는 남아 diag_recent 로 보인다).
const DEDUPE_MAP_SOFT_CAP: usize = 1024;

/// 저장 전 마지막 관문 — 노트 본문은 호출자 규약으로 막고, 여기서는 **어떤 호출자든** 흘릴 수 있는
/// 것을 지운다(AppError 메시지를 그대로 옮기는 프런트 logError·Rust `format!("{e}")` 가 대표):
/// 절대 경로 → 파일 이름만(사용자 이름·폴더 구조 노출 방지), URL 쿼리/프래그먼트 → 제거(토큰),
/// API 키·Bearer 토큰 → ***. 경로 정규식은 공백에서 끊겨 공백 든 경로는 앞부분만 줄어들 수 있다
/// (ponytail: 완벽한 경로 파서가 아니라 누설을 줄이는 쪽 — 뒤쪽 조각은 사용자 이름을 담지 않는다).
fn scrub_message(input: &str) -> String {
    use regex::Regex;
    static RE_WIN_PATH: OnceLock<Regex> = OnceLock::new();
    static RE_HOME_PATH: OnceLock<Regex> = OnceLock::new();
    static RE_URL_QUERY: OnceLock<Regex> = OnceLock::new();
    static RE_SK: OnceLock<Regex> = OnceLock::new();
    static RE_BEARER: OnceLock<Regex> = OnceLock::new();
    static RE_KEY: OnceLock<Regex> = OnceLock::new();
    let win = RE_WIN_PATH.get_or_init(|| Regex::new(r#"(?i)\b[A-Z]:[\\/][^\s"'<>|]*"#).unwrap());
    let home = RE_HOME_PATH.get_or_init(|| Regex::new(r#"/(?:Users|home)/[^\s"'<>]*"#).unwrap());
    let url_q = RE_URL_QUERY.get_or_init(|| Regex::new(r#"(https?://[^\s?#"'<>]+)[?#][^\s"'<>]*"#).unwrap());
    let sk = RE_SK.get_or_init(|| Regex::new(r"sk-[A-Za-z0-9_-]{8,}").unwrap());
    let bearer = RE_BEARER.get_or_init(|| Regex::new(r"(?i)Bearer\s+\S+").unwrap());
    let key = RE_KEY.get_or_init(|| Regex::new(r"(?i)(api[-_]?key|token)\s*[=:]\s*\S+").unwrap());

    let basename = |caps: &regex::Captures| -> String {
        let m = &caps[0];
        let trimmed = m.trim_end_matches(['\\', '/']);
        trimmed.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    };
    let s = win.replace_all(input, basename);
    let s = home.replace_all(&s, basename);
    let s = url_q.replace_all(&s, "$1?…");
    let s = sk.replace_all(&s, "***");
    let s = bearer.replace_all(&s, "Bearer ***");
    key.replace_all(&s, "$1=***").into_owned()
}

fn dedupe_key(source: &str, feature: &str, code: &str, level: Level) -> String {
    // \u{1}(SOH)을 구분자로 쓴다 — source/feature/code는 자유 문자열이라 콜론 등 흔한 구분자가
    // 값 안에 나올 수 있다. 실사용 문자열에 SOH가 들어올 일은 없다.
    format!("{source}\u{1}{feature}\u{1}{code}\u{1}{}", level.as_str())
}

fn push_ring(entry: DiagEntry) {
    let mut g = ring().lock();
    if g.len() >= CAP {
        g.pop_front();
    }
    g.push_back(entry);
}

fn bump_ring_count(id: &str, count: u32) {
    let mut g = ring().lock();
    if let Some(e) = g.iter_mut().find(|e| e.id == id) {
        e.count = count;
    }
}

fn ring_entry_by_id(id: &str) -> Option<DiagEntry> {
    ring().lock().iter().find(|e| e.id == id).cloned()
}

/// `limit` 넘으면 회전(기존 세대는 덮어씀 = 두 세대만 보관). Windows의 `rename`은 대상 파일이
/// 이미 있으면 실패하므로(POSIX와 달리 덮어쓰지 않음) 먼저 지운다 — repo/ai/call_log.rs와 동일.
fn rotate_if_needed(path: &Path, rotated_path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= ROTATE_BYTES {
        return;
    }
    let _ = std::fs::remove_file(rotated_path);
    let _ = std::fs::rename(path, rotated_path);
}

/// 회전 판정 + append 한 지점, dir을 인자로 받는 순수 버전 — 테스트가 전역 LOG_DIR을 거치지
/// 않고 임의 temp dir로 검증할 수 있게(repo/ai/call_log.rs의 append_line_in_dir과 동일 패턴).
fn append_entry_to_dir(dir: &Path, entry: &DiagEntry) {
    let path = dir.join(LOG_FILE_NAME);
    let rotated = dir.join(ROTATED_FILE_NAME);
    rotate_if_needed(&path, &rotated);
    let Ok(line) = serde_json::to_string(entry) else { return };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

fn append_to_file(entry: &DiagEntry) {
    let Some(dir) = LOG_DIR.get() else { return };
    append_entry_to_dir(dir, entry);
}

#[cfg(debug_assertions)]
fn debug_eprintln(entry: &DiagEntry) {
    eprintln!("[diag] {} {} {}:{} {}", entry.level, entry.source, entry.feature, entry.code, entry.message);
}
#[cfg(not(debug_assertions))]
fn debug_eprintln(_entry: &DiagEntry) {}

fn new_entry(level: Level, source: &str, feature: &str, code: &str, message: &str) -> DiagEntry {
    DiagEntry {
        id: crate::util::new_id(),
        ts: crate::util::now_iso(),
        level: level.as_str().to_string(),
        source: source.to_string(),
        feature: feature.to_string(),
        code: code.to_string(),
        message: message.to_string(),
        count: 1,
    }
}

/// 디듀프 판정만 떼어낸 순수 함수 — `now`/`existing`을 인자로 받아 실제 벽시계나 전역 맵 없이
/// 단위 테스트할 수 있다(60초를 실제로 기다리는 테스트를 안 만들기 위한 분리).
enum Decision {
    /// 기존 윈도 안 — 링 항목 count만 올리고 파일에는 안 쓴다.
    Bump,
    /// 새 윈도 시작. `Some(id)`면 방금 만료된 윈도의 최종 count를 그 ring id로 먼저 flush한다.
    Fresh { flush_ring_id: Option<String> },
}

fn decide(now: Instant, existing: Option<&DedupeWindow>) -> Decision {
    match existing {
        Some(w) if now.duration_since(w.window_start) < DEDUPE_WINDOW => Decision::Bump,
        Some(w) => Decision::Fresh { flush_ring_id: Some(w.ring_id.clone()) },
        None => Decision::Fresh { flush_ring_id: None },
    }
}

/// 진짜 기록 지점 — record()/warn()/error()(source="rust" 고정)와 commands::diag::diag_record
/// (프런트가 보낸 임의 source)가 전부 여길 지난다. 절대 패닉하지 않는다(모듈 헤더의 parking_lot
/// 선택 참고) — 파일 쓰기 실패는 그냥 무시된다(로그는 부수 효과, call_log와 같은 태도).
pub fn record_from(source: &str, level: Level, feature: &str, code: &str, message: &str) {
    let source = truncate_chars(source, KEY_MAX_CHARS);
    let feature = truncate_chars(feature, KEY_MAX_CHARS);
    let code = truncate_chars(code, KEY_MAX_CHARS);
    let (source, feature, code) = (source.as_str(), feature.as_str(), code.as_str());
    let message = truncate_chars(&scrub_message(message), MESSAGE_MAX_CHARS);
    let now = Instant::now();
    let key = dedupe_key(source, feature, code, level);

    let mut map = dedupe_map().lock();
    let decision = decide(now, map.get(&key));
    match decision {
        Decision::Bump => {
            // expect 대신 if-let — 이 임계 구역에서 패닉하면 패닉 훅이 같은 스레드에서 이 락을 다시
            // 잡으려다 교착한다(parking_lot 은 재진입 불가). decide 가 Bump 를 줬으면 항상 Some 이다.
            if let Some(window) = map.get_mut(&key) {
                window.count += 1;
                bump_ring_count(&window.ring_id, window.count);
            }
        }
        Decision::Fresh { flush_ring_id } => {
            if let Some(id) = flush_ring_id {
                if let Some(final_entry) = ring_entry_by_id(&id) {
                    append_to_file(&final_entry);
                }
            }
            if map.len() >= DEDUPE_MAP_SOFT_CAP {
                map.retain(|_, w| now.duration_since(w.window_start) < DEDUPE_WINDOW);
            }
            let entry = new_entry(level, source, feature, code, &message);
            debug_eprintln(&entry);
            push_ring(entry.clone());
            append_to_file(&entry);
            map.insert(key, DedupeWindow { window_start: now, ring_id: entry.id, count: 1 });
        }
    }
}

/// Rust 자체 코드용 편의 함수 — source는 항상 "rust"다(프런트발 호출은 commands::diag::
/// diag_record가 record_from을 직접 부른다, source가 창 라벨로 달라지므로).
pub fn record(level: Level, feature: &str, code: &str, message: impl AsRef<str>) {
    record_from("rust", level, feature, code, message.as_ref());
}

pub fn warn(feature: &str, code: &str, message: impl AsRef<str>) {
    record(Level::Warn, feature, code, message);
}

pub fn error(feature: &str, code: &str, message: impl AsRef<str>) {
    record(Level::Error, feature, code, message);
}

fn format_params(params: &[(&str, String)]) -> String {
    params.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ")
}

fn push_notice(feature: &str, code: &str, params: &[(&str, String)]) {
    let notice = Notice {
        feature: feature.to_string(),
        code: code.to_string(),
        params: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        ts: crate::util::now_iso(),
    };
    notices().lock().push(notice);
}

/// 기록 + 사용자 알림 대기열에 push. 항상 Warn 레벨로 기록한다(ponytail: 더 세분화된 레벨이
/// 필요해지면 notify_user_at(level, ...)로 쪼갠다 — worker_stopped()처럼 Error가 필요한
/// 호출부는 이 함수를 안 거치고 record_from을 직접 부른다, 아래).
pub fn notify_user(feature: &str, code: &str, params: &[(&str, String)]) {
    let message = format_params(params);
    record_from("rust", Level::Warn, feature, code, &message);
    push_notice(feature, code, params);
}

/// PINNED code="worker_stopped", params={worker}(모듈 헤더 참고) — 다른 웨이브가 이 정확한
/// 문자열에 의존한다. reason은 진단 로그 메시지에만 싣는다(알림 params에는 안 넣는다 — 계약은
/// worker 하나뿐이라 단순하게 유지, 필요해지면 params에 추가해도 하위호환은 깨지지 않는다).
pub fn worker_stopped(worker: &str, reason: &str) {
    let message = format!("{worker} stopped: {reason}");
    record_from("rust", Level::Error, "worker", "worker_stopped", &message);
    push_notice("worker", "worker_stopped", &[("worker", worker.to_string())]);
    mark_stopped(worker);
}

fn mark_stopped(worker: &str) {
    let mut map = heartbeats().lock();
    let beat = map.entry(worker.to_string()).or_insert_with(|| WorkerBeat {
        last_instant: Instant::now(),
        last_ts: crate::util::now_iso(),
        expected_secs: DEFAULT_HEARTBEAT_EXPECTED_SECS,
        stopped: false,
    });
    beat.stopped = true;
}

/// 워커가 살아있다는 신호. 등록되지 않은 worker면 새로 만든다(기본 기대 주기 60초).
pub fn heartbeat(worker: &str) {
    let mut map = heartbeats().lock();
    let beat = map.entry(worker.to_string()).or_insert_with(|| WorkerBeat {
        last_instant: Instant::now(),
        last_ts: crate::util::now_iso(),
        expected_secs: DEFAULT_HEARTBEAT_EXPECTED_SECS,
        stopped: false,
    });
    beat.last_instant = Instant::now();
    beat.last_ts = crate::util::now_iso();
    beat.stopped = false;
}

/// diag_status 커맨드 — heartbeat()/worker_stopped()로 한 번이라도 등록된 워커만 나온다.
pub fn worker_statuses() -> Vec<WorkerStatus> {
    let map = heartbeats().lock();
    let now = Instant::now();
    let mut out: Vec<WorkerStatus> = map
        .iter()
        .map(|(name, beat)| {
            let state = if beat.stopped {
                "stopped"
            } else if now.duration_since(beat.last_instant) > Duration::from_secs(beat.expected_secs * STALE_MULTIPLIER) {
                "stale"
            } else {
                "alive"
            };
            WorkerStatus { name: name.clone(), last_beat: Some(beat.last_ts.clone()), state: state.to_string() }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// diag_take_notices 커맨드 — 대기열을 비우고 돌려준다(drain, 두 번째 호출은 빈 배열).
pub fn take_notices() -> Vec<Notice> {
    std::mem::take(&mut *notices().lock())
}

/// 파싱 실패 줄(다른 프로세스가 쓰는 도중의 부분 줄 등)은 건너뛴다 — dir 인자를 받는 순수
/// 버전(테스트용, repo/ai/call_log.rs::summarize_from_dir과 동일 패턴).
fn read_entries_from_dir(dir: &Path) -> Vec<DiagEntry> {
    let mut out = Vec::new();
    for name in [LOG_FILE_NAME, ROTATED_FILE_NAME] {
        let Ok(contents) = std::fs::read_to_string(dir.join(name)) else { continue };
        for line in contents.lines() {
            if let Ok(entry) = serde_json::from_str::<DiagEntry>(line) {
                out.push(entry);
            }
        }
    }
    out
}

fn read_file_entries() -> Vec<DiagEntry> {
    LOG_DIR.get().map(|dir| read_entries_from_dir(dir)).unwrap_or_default()
}

/// diag_recent 커맨드 — 파일(재시작 후에도 남음) + 아직 파일에 안 쓰인 링 버퍼(디듀프 윈도
/// 안에서 count만 오른 최신 값)를 id로 합쳐(링 쪽이 더 최신이라 우선) 최신순 최대 limit개.
pub fn recent(limit: usize) -> Vec<DiagEntry> {
    let mut merged: HashMap<String, DiagEntry> = HashMap::new();
    for e in read_file_entries() {
        merged.insert(e.id.clone(), e);
    }
    for e in ring().lock().iter().cloned() {
        merged.insert(e.id.clone(), e); // 링이 더 최신(count 갱신) — 파일 값을 덮어쓴다.
    }
    let mut all: Vec<DiagEntry> = merged.into_values().collect();
    all.sort_by(|a, b| b.ts.cmp(&a.ts));
    all.truncate(limit);
    all
}

/// 부팅 시 lib.rs가 한 번 부른다(기존 훅을 저장해 체인 — 다른 패닉 훅이 있으면 그것도 계속
/// 불린다). windows_subsystem="windows"라 release 빌드의 panic은 이게 없으면 완전히
/// 사라진다(§3 G1) — 콘솔이 없어 어차피 안 보였다.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".to_string()
        };
        record_from("rust", Level::Error, "panic", "panic", &format!("{msg} at {location}"));
        previous(info);
    }));
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brise-diag-test-{tag}-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_entry(id: &str) -> DiagEntry {
        DiagEntry {
            id: id.to_string(),
            ts: "2026-09-26T00:00:00.000Z".to_string(),
            level: "warn".to_string(),
            source: "rust".to_string(),
            feature: "test".to_string(),
            code: "sample".to_string(),
            message: "hello".to_string(),
            count: 1,
        }
    }

    // ── Level ────────────────────────────────────────────────────────────────────────────────
    #[test]
    fn level_parse_and_as_str_roundtrip() {
        for (s, lvl) in [("info", Level::Info), ("warn", Level::Warn), ("error", Level::Error)] {
            assert_eq!(Level::parse(s), Some(lvl));
            assert_eq!(lvl.as_str(), s);
        }
        assert_eq!(Level::parse("critical"), None, "정의되지 않은 레벨은 None");
    }

    // ── truncate_chars: char 경계 안전 ──────────────────────────────────────────────────────
    #[test]
    fn truncate_chars_counts_characters_not_bytes() {
        // 한글 1글자는 UTF-8로 3바이트 — 바이트 기준으로 잘랐다면 이 문자열 중간에서 깨졌을 것.
        let s = "가".repeat(400);
        let truncated = truncate_chars(&s, MESSAGE_MAX_CHARS);
        assert_eq!(truncated.chars().count(), MESSAGE_MAX_CHARS);
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok(), "잘린 결과는 항상 유효한 UTF-8");
    }

    #[test]
    fn truncate_chars_leaves_short_strings_alone() {
        assert_eq!(truncate_chars("hi", MESSAGE_MAX_CHARS), "hi");
    }

    // ── decide(): 순수 디듀프 판정 (벽시계를 실제로 기다리지 않고 검증) ────────────────────────
    #[test]
    fn decide_returns_fresh_without_flush_id_when_no_existing_window() {
        let now = Instant::now();
        match decide(now, None) {
            Decision::Fresh { flush_ring_id } => assert!(flush_ring_id.is_none()),
            Decision::Bump => panic!("첫 발생은 Bump가 아니어야 한다"),
        }
    }

    #[test]
    fn decide_returns_bump_within_the_60s_window() {
        let window = DedupeWindow { window_start: Instant::now(), ring_id: "r1".to_string(), count: 3 };
        match decide(Instant::now(), Some(&window)) {
            Decision::Bump => {}
            Decision::Fresh { .. } => panic!("윈도 안이면 Bump여야 한다"),
        }
    }

    #[test]
    fn decide_returns_fresh_with_flush_id_after_the_window_expires() {
        let expired_start = Instant::now() - Duration::from_secs(61);
        let window = DedupeWindow { window_start: expired_start, ring_id: "r2".to_string(), count: 7 };
        match decide(Instant::now(), Some(&window)) {
            Decision::Fresh { flush_ring_id } => assert_eq!(flush_ring_id.as_deref(), Some("r2")),
            Decision::Bump => panic!("60초 지났으면 Fresh(rollover)여야 한다"),
        }
    }

    // ── record_from + recent(): 공개 API 왕복. 전역 링 버퍼를 공유하므로(OnceLock, 리셋 불가)
    //    다른 테스트와 안 섞이도록 각 테스트 전용 feature/code 문자열을 쓴다(call_log.rs의
    //    provider 접두사 관례와 동일).
    #[test]
    fn record_from_and_recent_roundtrip() {
        record_from("rust", Level::Info, "feat-roundtrip", "code-roundtrip", "hello world");
        let found = recent(500)
            .into_iter()
            .find(|e| e.feature == "feat-roundtrip" && e.code == "code-roundtrip")
            .expect("recent()에 방금 기록한 항목이 있어야 한다");
        assert_eq!(found.message, "hello world");
        assert_eq!(found.count, 1);
        assert_eq!(found.source, "rust");
        assert_eq!(found.level, "info");
    }

    #[test]
    fn record_from_dedupes_within_window_bumping_count_on_the_same_ring_entry() {
        record_from("rust", Level::Warn, "feat-dedupe", "code-dedupe", "first");
        record_from("rust", Level::Warn, "feat-dedupe", "code-dedupe", "second");
        record_from("rust", Level::Warn, "feat-dedupe", "code-dedupe", "third");
        let matches: Vec<_> =
            recent(500).into_iter().filter(|e| e.feature == "feat-dedupe" && e.code == "code-dedupe").collect();
        assert_eq!(matches.len(), 1, "60초 안의 반복은 새 항목을 만들지 않는다");
        assert_eq!(matches[0].count, 3);
    }

    #[test]
    fn record_from_truncates_message_to_300_chars() {
        let long = "x".repeat(500);
        record_from("rust", Level::Error, "feat-trunc", "code-trunc", &long);
        let found = recent(500).into_iter().find(|e| e.feature == "feat-trunc" && e.code == "code-trunc").unwrap();
        assert_eq!(found.message.chars().count(), MESSAGE_MAX_CHARS);
    }

    #[test]
    fn different_levels_for_the_same_source_feature_code_do_not_dedupe_together() {
        record_from("rust", Level::Warn, "feat-level-split", "code-level-split", "warn msg");
        record_from("rust", Level::Error, "feat-level-split", "code-level-split", "error msg");
        let matches: Vec<_> = recent(500)
            .into_iter()
            .filter(|e| e.feature == "feat-level-split" && e.code == "code-level-split")
            .collect();
        assert_eq!(matches.len(), 2, "level이 다르면 별개 디듀프 키다");
    }

    // ── notify_user / worker_stopped / take_notices ────────────────────────────────────────
    // take_notices()는 전역 대기열을 통째로 drain한다(설계상 그렇다 — 부팅 시 메인 창이 한 번에
    // 다 가져간다) — 두 테스트가 병렬로(cargo test 기본값) notify_user/worker_stopped +
    // take_notices()를 부르면 서로의 알림을 가로챌 수 있다. 이 정적 락으로 그 두 테스트만
    // 직렬화한다(실 런타임엔 소비자가 하나뿐이라 이 경합 자체가 없다 — 테스트 전용 문제).
    // 다른 모듈의 테스트도 take_notices() 를 부르면 이 락을 잡아야 한다(db::tests 가 그렇다) —
    // 따로 만든 락끼리는 서로를 막지 못한다.
    pub(crate) static NOTICE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn notify_user_records_a_warn_entry_and_queues_a_notice() {
        let _guard = NOTICE_TEST_LOCK.lock();
        notify_user("feat-notify", "code-notify-unique", &[("backup", "b.zip".to_string())]);
        let found =
            recent(500).into_iter().find(|e| e.feature == "feat-notify" && e.code == "code-notify-unique").unwrap();
        assert_eq!(found.level, "warn");

        let notices = take_notices();
        let n = notices.iter().find(|n| n.code == "code-notify-unique").expect("알림 대기열에 있어야 한다");
        assert_eq!(n.params.get("backup").map(String::as_str), Some("b.zip"));

        // drain 계약: 두 번째 take_notices()는 이미 가져간 걸 다시 안 준다(다른 테스트가 그
        // 사이 뭘 넣었을 수 있어 "완전히 빈 배열"은 못 주장하지만, 방금 것은 사라졌어야 한다).
        let second = take_notices();
        assert!(!second.iter().any(|n| n.code == "code-notify-unique"));
    }

    #[test]
    fn worker_stopped_records_error_queues_pinned_notice_and_marks_worker_stopped() {
        let _guard = NOTICE_TEST_LOCK.lock();
        worker_stopped("test-worker-ws1", "connection refused");
        let found = recent(500).into_iter().find(|e| e.feature == "worker" && e.code == "worker_stopped");
        assert!(found.is_some(), "error 레벨 진단 항목이 남아야 한다");

        let notices = take_notices();
        let n = notices.iter().find(|n| n.code == "worker_stopped" && n.params.get("worker").map(String::as_str) == Some("test-worker-ws1"));
        assert!(n.is_some(), "PINNED code=worker_stopped, params={{worker}}");

        let status = worker_statuses().into_iter().find(|w| w.name == "test-worker-ws1").unwrap();
        assert_eq!(status.state, "stopped");
    }

    // ── heartbeat / worker_statuses ─────────────────────────────────────────────────────────
    #[test]
    fn heartbeat_marks_worker_alive() {
        heartbeat("test-worker-alive1");
        let status = worker_statuses().into_iter().find(|w| w.name == "test-worker-alive1").unwrap();
        assert_eq!(status.state, "alive");
        assert!(status.last_beat.is_some());
    }

    #[test]
    fn worker_without_any_heartbeat_or_stop_call_is_absent_from_status() {
        assert!(worker_statuses().into_iter().all(|w| w.name != "never-registered-worker-xyz"));
    }

    // ── rotate_if_needed / append_entry_to_dir / read_entries_from_dir: dir 인자 순수 버전 ──
    #[test]
    fn rotate_if_needed_moves_oversized_file_and_overwrites_previous_generation() {
        let dir = temp_dir("rotate");
        let path = dir.join(LOG_FILE_NAME);
        let rotated = dir.join(ROTATED_FILE_NAME);
        std::fs::write(&rotated, b"stale-generation").unwrap();
        std::fs::write(&path, vec![b'x'; (ROTATE_BYTES + 1) as usize]).unwrap();

        rotate_if_needed(&path, &rotated);

        assert!(!path.exists());
        let rotated_contents = std::fs::read(&rotated).unwrap();
        assert_eq!(rotated_contents.len(), (ROTATE_BYTES + 1) as usize);
    }

    #[test]
    fn rotate_if_needed_leaves_small_file_alone() {
        let dir = temp_dir("no-rotate");
        let path = dir.join(LOG_FILE_NAME);
        std::fs::write(&path, b"small").unwrap();
        let rotated = dir.join(ROTATED_FILE_NAME);

        rotate_if_needed(&path, &rotated);

        assert!(path.exists());
        assert!(!rotated.exists());
    }

    #[test]
    fn append_entry_to_dir_writes_one_jsonl_line_per_call() {
        let dir = temp_dir("append");
        append_entry_to_dir(&dir, &sample_entry("a"));
        append_entry_to_dir(&dir, &sample_entry("b"));
        let contents = std::fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["id"], "a");
    }

    #[test]
    fn read_entries_from_dir_skips_unparseable_lines_and_missing_files() {
        let dir = temp_dir("read");
        assert!(read_entries_from_dir(&dir).is_empty(), "파일이 아예 없으면 빈 벡터");

        append_entry_to_dir(&dir, &sample_entry("ok-1"));
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join(LOG_FILE_NAME)).unwrap();
        use std::io::Write;
        writeln!(f, "not json").unwrap();

        let entries = read_entries_from_dir(&dir);
        assert_eq!(entries.len(), 1, "깨진 줄은 건너뛰고 유효한 줄만 반환");
        assert_eq!(entries[0].id, "ok-1");
    }

    // 리뷰(2026-09-26): 프런트 logError 가 AppError 메시지를 그대로 옮기고, Rust 쪽도 format!("{e}")
    // 를 넘긴다 — 경로(사용자 이름)·URL 토큰·키가 diag.jsonl 에 영구 저장되던 누설을 싱크에서 막는다.
    #[test]
    fn scrub_message_strips_paths_url_queries_and_secrets() {
        assert_eq!(
            scrub_message(r"file missing: C:\Users\alice\Documents\secret-plan.txt (os error 2)"),
            "file missing: secret-plan.txt (os error 2)"
        );
        assert_eq!(scrub_message("open /Users/bob/notes/x.md failed"), "open x.md failed");
        assert!(!scrub_message("invalid url: file:///C:/Users/alice/a.txt").contains("alice"));
        assert_eq!(
            scrub_message("GET https://api.example.com/v1/x?token=abc#frag failed"),
            "GET https://api.example.com/v1/x?… failed"
        );
        let secrets = scrub_message("401 key sk-abcdefghijklmnop, Bearer xyz, api_key=zzz");
        assert!(!secrets.contains("sk-abc") && !secrets.contains("xyz") && !secrets.contains("zzz"), "{secrets}");
        // 경로·URL 이 없는 평범한 메시지는 그대로.
        assert_eq!(scrub_message("status 429 at 12:30"), "status 429 at 12:30");
    }

    #[test]
    fn record_from_clamps_caller_supplied_keys_and_scrubs_message() {
        let long = "f".repeat(500);
        let code = format!("clamp-test-{}", crate::util::new_id());
        record_from(&long, Level::Info, &long, &code, r"C:\Users\carol\x.txt");
        let entry = recent(1000).into_iter().find(|e| e.code == code).expect("recorded");
        assert_eq!(entry.source.chars().count(), KEY_MAX_CHARS);
        assert_eq!(entry.feature.chars().count(), KEY_MAX_CHARS);
        assert_eq!(entry.message, "x.txt");
    }
}
