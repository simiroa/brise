// P3 수집 관문 러너 (docs/PLAN-2026-08-07-second-brain.md Q6) — 부팅 시 전용 스레드 하나, 이
// conn과 독립된 커넥션을 자체적으로 열고, 절대 부팅/저장 경로를 블로킹하지 않는다. 60초 tick마다
// enabled 소스 중 주기가 도래한 것만 실행한다(repo::collect::find_due — 주기 판정/클램프는 그
// 함수가 소유).
//
// 어댑터는 kind 문자열 → 함수 매치 하나로 디스패치한다(collect_for_kind) — 트레이트 오브젝트/동적
// 디스패치 없음, kind가 아직 2-3종뿐이라 과추상화하지 않는다(ponytail). 아직 실행 어댑터가 없는
// kind가 등록돼 있으면(향후 새 kind가 커맨드 레이어에만 먼저 붙는 경우) 조용히 스킵한다 —
// "not yet supported" 에러로 last_status를 더럽히지 않는다(브리프 지시).
//
// 러너는 fetch·ingest만 한다 — AI 호출 없음. 겹침 제안이 생긴다면 그래프 탭 로드 시
// related_sql 이 생산하며, 임베딩 워커는 없다.
mod browser_history;
#[cfg(test)]
mod smoke_local;
pub mod claude_prompts;
pub mod codex_prompts;
pub mod config;
/// 동기화 후 같은 폴더에 제목이 같은 "일자 노트"가 중복되면 하나로 합치는 수렴 규칙
/// (PLAN-2026-09-04-local-import.md, 동기화 수렴 규칙) — `ingest_item_parts`와
/// `sync_server::ingest.rs::append_visit`가 공유한다.
pub(crate) mod daynote;
/// 로컬 소스 감지 + 1클릭 가져오기(PLAN-2026-09-04-local-import.md §W7) —
/// commands::collect::{collect_detect_local, collect_import_local}가 쓴다. 러너 디스패치
/// (collect_for_kind) 대상이 아니다 — 이 모듈은 fetch/ingest를 하지 않고 미리보기·소스 등록만
/// 한다.
pub mod detect;
pub mod rss;
pub(crate) mod summary;
pub(crate) mod urlfilter;
pub mod web;
pub mod ytdlp;

use crate::error::{db as dberr, AppResult};
use crate::repo::{activity, collect as repo_collect, pet, suggestions};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::time::Duration;

const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// 인박스 노트 본문에 실제로 들어가는 항목 하나당 상한 — 모든 어댑터가 이 한 지점(ingest_item)을
/// 지나므로 어댑터별로 캡을 중복 구현하지 않는다(RSS 항목이 기사 전문을 실어 보내는 피드도 있어
/// 노트 하나가 지나치게 커지는 것을 여기서 막는다).
pub const ITEM_BODY_MAX_CHARS: usize = 20_000;

/// 항목 단위 seen 을 쓰는 소스(claude_prompts/codex_prompts/browser_history)가 한 항목(=하루치
/// 노트) 안에 실어 보내는 줄 하나. `guid`는 이 줄만의 collect_seen 키(항목 전체의 `guid`와는
/// 별개 — item.guid 는 이 경로에서 절대 클레임되지 않는다, PLAN-2026-09-04-local-import §2.1).
/// `dedupe_needle`은 이미 노트 본문에 있으면 줄을 건너뛰되 그래도 seen 처리할 문자열(예: URL) —
/// 없으면 그 검사를 하지 않는다.
#[derive(Debug, Clone)]
pub struct CollectedPart {
    pub guid: String,
    pub line: String,
    pub dedupe_needle: Option<String>,
}

/// 어댑터가 정규화해 돌려주는 항목 하나.
#[derive(Debug)]
pub struct CollectedItem {
    /// collect_seen 중복 판정 키 — 피드의 `<guid>`/`<id>`, 없으면 링크로 대체(각 어댑터가 결정).
    /// `parts`가 비어있지 않은 항목에서는 식별/미리보기용일 뿐 절대 클레임되지 않는다.
    pub guid: String,
    pub title: String,
    pub body_md: String,
    pub source_url: Option<String>,
    pub published_at: Option<String>,
    /// 비어 있으면(기본값) 기존 "항목 전체를 한 번에 seen 처리" 동작. 비어 있지 않으면
    /// ingest_item이 항목 단위가 아니라 줄 단위로 append/seen 판정한다(§2.1).
    pub parts: Vec<CollectedPart>,
}

/// 어댑터 실행 컨텍스트 — 비동기 fetch(reqwest)를 동기 컨텍스트에서 block_on 하기 위한
/// tokio 런타임 핸들과, 사이드카 바이너리가 사는 앱 데이터 경로.
pub struct CollectCtx<'a> {
    pub rt: &'a tokio::runtime::Runtime,
    /// yt-dlp sidecar lives under data_dir/bin
    pub data_dir: PathBuf,
    /// 이 소스가 마지막으로 성공적으로 돈 시각(ISO8601, source.last_run_at 그대로) — 한 번도
    /// 안 돌았으면 None. seen이 정본 판정이라 이 값은 IO 절약(파일 스캔 스킵)에만 쓰인다,
    /// 정확도를 위한 소스가 아니다(claude_prompts/codex_prompts의 mtime 스킵 참고).
    pub since: Option<String>,
}

/// kind → 어댑터 디스패치. `None`은 "이 kind는 아직 실행 어댑터가 없다"(러너가 스킵, status
/// 유지) — `Some(Err(_))`(fetch/parse 실패)와는 다른 신호다.
fn collect_for_kind(kind: &str, config: &str, ctx: &CollectCtx) -> Option<AppResult<Vec<CollectedItem>>> {
    match kind {
        "rss" => Some(rss::collect(config, ctx)),
        "claude_prompts" => Some(claude_prompts::collect(config, ctx)),
        "codex_prompts" => Some(codex_prompts::collect(config, ctx)),
        "web" => Some(web::collect(config, ctx)),
        "youtube" => Some(ytdlp::collect(config, ctx)),
        "browser_history" => Some(browser_history::collect(config, ctx)),
        _ => None,
    }
}

/// Run only the adapter for a source. Keeping this separate from database ingestion lets callers
/// snapshot a source under a DB lock, release that lock while RSS/filesystem work runs, and lock
/// again only for the short ingest/status phase.
pub fn collect_source(
    source: &repo_collect::CollectSource,
    rt: &tokio::runtime::Runtime,
    data_dir: PathBuf,
) -> Option<AppResult<Vec<CollectedItem>>> {
    let ctx = CollectCtx { rt, data_dir, since: source.last_run_at.clone() };
    let result = collect_for_kind(&source.kind, &source.config, &ctx)?;
    Some(match result {
        // 유튜브 채널을 구독하는 rss 피드는 제목+설명뿐이라 본문을 자막으로 보강한다. kind가
        // "youtube"(단일 영상, ytdlp::collect)인 경우는 이미 자막이 body_md라 대상 밖.
        Ok(items) if source.kind == "rss" => Ok(enrich_youtube_subtitles(items, &source.id, &ctx.data_dir)),
        other => other,
    })
}

/// 이번 실행에서 unseen 유튜브 항목에 쓸 자막 fetch 상한. yt-dlp를 직렬 호출하고 호출당
/// FETCH_TIMEOUT(60s, ytdlp.rs)이 걸리므로 이 값이 collect_source 한 번의 실행 시간 천장을 정한다.
/// ponytail: 캡을 넘는 unseen 항목은 이번 결과에서 제거되어 seen 처리되지 않으므로 다음 due
/// 주기에 자연히 다시 잡힌다 — 신규 채널 구독 시 15개 백필이 3주기에 걸쳐 이월 소화됨. 값을
/// 올리면 그만큼 그 주기의 collect_source 실행 시간도 늘어난다(체감 지연 트레이드오프).
const ENRICH_CAP: usize = 5;

/// sha256(input)의 앞 16 hex 문자 — claude_prompts/codex_prompts 어댑터가 항목 안 프롬프트 한
/// 줄마다 콘텐츠 주소 기반 part guid를 만드는 데 쓴다(sha2는 sync_server::ingest가 이미 쓰는
/// 의존성). 16 hex(64bit)면 한 소스 안에서 같은 (project,date) 묶음 안 프롬프트끼리 충돌할
/// 걱정이 사실상 없다 — collect_seen의 유일 판정 키는 (source_id, guid)라 소스가 다르면 애초에
/// 섞이지 않는다.
/// 프롬프트/방문 한 건 = 노트의 **한 줄**(part.line). 여러 줄짜리 프롬프트(붙여넣은 로그·코드)를 그대로
/// 두면 "- HH:MM text" 한 줄 규약이 깨져 요약의 줄 추출·중복 판정·미리보기가 전부 흔들린다 — 줄바꿈은
/// " ⏎ " 로 접는다. 길이 cap 은 호출자가 정한다(프롬프트 어댑터는 ITEM_BODY_MAX_CHARS — 긴 프롬프트를
/// 항목 상한까지 보존한다는 기존 결정, `prompts_longer_than_500_chars_are_preserved_until_the_item_cap`).
pub(crate) fn one_line(text: &str, cap: usize) -> String {
    let folded = text
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ⏎ ");
    if folded.chars().count() > cap {
        let mut s: String = folded.chars().take(cap).collect();
        s.push('…');
        s
    } else {
        folded
    }
}

/// 세션 파일 하나가 크기 초과/오픈 실패로 통째로 스킵될 때 그 사실을 노트 줄로 남긴다
/// (claude_prompts.rs/codex_prompts.rs 공유 — 둘 다 같은 "하루치 프롬프트 노트" 모양이라 두 번째
/// 사용처가 생긴 시점에 여기로 뽑았다). 조용히 사라지는 대신 "무엇이 빠졌는지"를 사용자가 노트에서
/// 볼 수 있게 한다. `date`는 파일 mtime의 로컬 날짜(파일 내용을 못 읽으므로 근사치 — ponytail:
/// codex는 경로에 정확한 날짜가 있지만 claude는 없어서 두 어댑터가 같은 근사를 공유한다) — 그
/// 날짜의 항목이 없으면 이 part만으로 새 항목(노트)이 생긴다. `guid`가 파일 경로 해시라 파일이
/// 그대로면(계속 너무 크면) 다음 run에서도 seen이라 같은 줄이 중복 append되지 않는다.
pub(crate) fn skip_notice_part(kind_prefix: &str, project: &str, date: &str, file: &Path, size_bytes: u64) -> CollectedPart {
    let mb = size_bytes / (1024 * 1024);
    let hash = sha256_hex16(&file.to_string_lossy());
    CollectedPart {
        guid: format!("{kind_prefix}:{project}:{date}:skipped:{hash}"),
        line: format!("- (건너뜀) 세션 파일 1개가 너무 커서 읽지 않았습니다 ({mb}MB)"),
        dedupe_needle: None,
    }
}

/// 파일 mtime을 로컬 날짜(YYYY-MM-DD)로 — `skip_notice_part`와 같은 이유로 claude_prompts.rs/
/// codex_prompts.rs가 공유한다: 크기 초과/오픈 실패로 내용을 못 읽는 파일이 그래도 어느 날짜
/// 노트에 스킵 안내를 남길지 정하는 근사치다. mtime을 못 얻으면(드묾) None — 어느 노트에 붙일지
/// 모르는 안내보다는 조용한 스킵이 낫다.
pub(crate) fn mtime_local_date(meta: &std::fs::Metadata) -> Option<String> {
    let modified = meta.modified().ok()?;
    let dt: chrono::DateTime<chrono::Local> = modified.into();
    Some(dt.format("%Y-%m-%d").to_string())
}

pub(crate) fn sha256_hex16(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

/// RSS 어댑터가 실어온 항목 중 유튜브 영상 링크가 있는 것만 자막으로 본문을 보강한다. 유튜브
/// 링크가 하나도 없으면 DB조차 열지 않는다(흔한 일반 rss 피드에 매 주기 쓸데없는 커넥션을 열지
/// 않기 위해). 있으면 자체 conn으로 seen만 조회하고 즉시 닫은 뒤(네트워크/yt-dlp 실행 중 conn을
/// 들고 있지 않는다), 실제 판정·캡·보강 로직은 순수 함수 enrich_youtube_items에 위임한다(테스트가
/// DB/네트워크 없이 그 함수만으로 검증한다).
fn enrich_youtube_subtitles(items: Vec<CollectedItem>, source_id: &str, data_dir: &Path) -> Vec<CollectedItem> {
    if !items.iter().any(|i| i.source_url.as_deref().is_some_and(is_youtube_url)) {
        return items;
    }
    let conn = match crate::db::open(&crate::db::db_path(data_dir)) {
        Ok(c) => c,
        Err(e) => {
            crate::diag::warn("collect", "youtube_enrich_db_open_failed", format!("skipping enrichment: {e}"));
            return items;
        }
    };
    let guids: Vec<String> = items.iter().map(|i| i.guid.clone()).collect();
    let seen = match repo_collect::seen_guids(&conn, source_id, &guids) {
        Ok(s) => s,
        Err(e) => {
            crate::diag::warn("collect", "youtube_enrich_seen_query_failed", format!("skipping enrichment: {e}"));
            return items;
        }
    };
    drop(conn); // seen 조회는 끝났다 — fetch(네트워크/yt-dlp) 동안 어떤 conn도 들고 있지 않는다.
    enrich_youtube_items(items, &seen, |url| ytdlp::fetch_subtitles(data_dir, url))
}

/// 순수 로직: seen·캡 판정과 fetch 클로저 호출만 한다(DB 조회/프로세스 실행은 호출자 책임) —
/// 테스트가 네트워크 없이 이 함수만으로 seen 스킵·성공 교체·캡 초과 이월·fetch 실패 폴백을 검증한다.
fn enrich_youtube_items(
    items: Vec<CollectedItem>,
    seen: &std::collections::HashSet<String>,
    fetch: impl Fn(&str) -> AppResult<String>,
) -> Vec<CollectedItem> {
    let mut out = Vec::with_capacity(items.len());
    let mut fetched = 0usize;
    for mut item in items {
        let is_yt_unseen = item.source_url.as_deref().is_some_and(is_youtube_url) && !seen.contains(&item.guid);
        if !is_yt_unseen {
            out.push(item);
            continue;
        }
        if fetched >= ENRICH_CAP {
            continue; // 캡 초과: seen 처리 안 됨 -> 다음 due 주기가 자연히 재시도(이월)
        }
        fetched += 1;
        let url = item.source_url.clone().unwrap_or_default();
        match fetch(&url) {
            Ok(body_md) => item.body_md = body_md, // 설명은 버리고 자막을 본문으로 삼는다
            Err(e) => {
                // U6(AUDIT-2026-09-26-fallback-observability.md §4): 예전엔 흔적 없이 설명으로만
                // ingest되고 guid가 곧장 seen 클레임돼(ingest_item_whole) 다시는 재시도되지 않았다.
                // 재시도 경로가 없으므로 seen 클레임 자체는 바꾸지 않되(지시대로), 진단에 남기고
                // 노트 본문에 기존 "(건너뜀)" 안내 관례(skip_notice_part, 위 참고)와 같은 모양의
                // 눈에 보이는 줄을 추가해 사용자가 "자막이 아니라 설명만 들어왔다"를 알 수 있게 한다.
                crate::diag::warn("collect", "youtube_enrich_failed", format!("subtitle fetch failed, ingesting description instead: {e}"));
                if !item.body_md.trim().is_empty() {
                    item.body_md.push_str("\n\n");
                }
                item.body_md.push_str("- (건너뜀) 자막을 가져오지 못해 영상 설명으로 대신 저장했습니다");
            }
        }
        out.push(item);
    }
    out
}

/// item.source_url이 유튜브 단일 영상 페이지(시청 URL)인지 판정한다 — 재생목록/채널/쇼츠 등
/// 그 외 유튜브 URL 형태는 대상 밖(ponytail: 필요해지면 shorts `/shorts/<id>` arm 추가).
fn is_youtube_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    match parsed.host_str().unwrap_or("") {
        "youtube.com" | "www.youtube.com" | "m.youtube.com" => {
            parsed.path() == "/watch" && parsed.query_pairs().any(|(k, _)| k == "v")
        }
        "youtu.be" => !parsed.path().trim_start_matches('/').is_empty(),
        _ => false,
    }
}

/// 앱 부팅 시 1회 호출 — 백그라운드 스레드를 띄우고 즉시 반환한다(블로킹 없음). embedding::start와
/// 동일한 실패 정책: conn/runtime 초기화 실패는 로그만 남기고 조용히 포기(부팅에 영향 없음).
pub fn start(data_dir: PathBuf) {
    std::thread::spawn(move || {
        // 강제 종료로 못 지워진 History 임시 복사본 정리(§hygiene wave) — conn/runtime 초기화보다
        // 먼저, 실패해도(권한 등) 부팅에 영향 없이 조용히 넘어간다(cleanup_stale_temp_copies 자체가
        // 그런 자세).
        browser_history::cleanup_stale_temp_copies(&data_dir);
        let conn = match crate::db::open(&crate::db::db_path(&data_dir)) {
            Ok(c) => c,
            Err(e) => {
                // G5(AUDIT-2026-09-26-fallback-observability.md §3): 이 return 은 스레드 자체를
                // 끝낸다 — 자동 수집이 그 세션 내내 조용히 안 돈다. worker_stopped 가 PINNED 알림을
                // 큐에 쌓아 부팅 화면에서 사용자가 볼 수 있게 한다.
                crate::diag::worker_stopped("collect", &format!("failed to open background connection: {e}"));
                return;
            }
        };
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                crate::diag::worker_stopped("collect", &format!("failed to build tokio runtime: {e}"));
                return;
            }
        };
        // 이번 프로세스가 시작된 시각 — "창을 열 때"(ON_OPEN_SENTINEL, repo::collect) 소스가
        // 부팅 후 딱 한 번만 도는 기준선. run_loop 전체 수명 동안 고정이다.
        let boot_at = crate::util::now_iso();
        run_loop(conn, &rt, data_dir, boot_at);
    });
}

fn run_loop(mut conn: Connection, rt: &tokio::runtime::Runtime, data_dir: PathBuf, boot_at: String) {
    loop {
        // G5/U7: 이 스레드가 살아있다는 신호 — TICK_INTERVAL(60초)이 diag의 기본 기대 주기와
        // 같아 heartbeat_with_interval 없이 그냥 heartbeat 로 충분하다(diag.rs 헤더 참고).
        crate::diag::heartbeat("collect");
        // repo::schedule::start 와 같은 이유 — 어댑터 하나의 패닉(깨진 피드 파싱, 의존성 깊은 곳의
        // unwrap 등)이 이 스레드를 끝내면 세션 내내 자동 수집이 멈춘다. 이번 주기만 버리고 다음
        // 주기에 상태를 새로 읽는다(패닉 메시지 자체는 diag 패닉 훅이 이미 남긴다).
        // AssertUnwindSafe: conn/rt 는 UnwindSafe 가 아니지만, 버려진 주기가 깨뜨린 불변식에
        // 기대는 곳이 없다 — 다음 주기가 DB 에서 새로 읽는다(schedule 과 같은 판단).
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_cycle(&mut conn, rt, &data_dir, &boot_at)
        }));
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(e)) => crate::diag::error("collect", "cycle_failed", format!("{e}")),
            Err(_) => crate::diag::error("collect", "cycle_panicked", "cycle discarded, runner continues"),
        }
        std::thread::sleep(TICK_INTERVAL);
    }
}

/// 한 tick: 주기가 도래한 enabled 소스를 전부 실행한다. 소스 하나의 실패가 나머지를 막지 않는다
/// — run_one이 에러를 흡수하고 last_status='error'로 기록한다. `boot_at`은 이번 앱 실행이
/// 시작된 시각(run_loop 수명 동안 고정) — ON_OPEN_SENTINEL 소스 판정에만 쓰인다.
pub fn run_cycle(conn: &mut Connection, rt: &tokio::runtime::Runtime, data_dir: &Path, boot_at: &str) -> AppResult<()> {
    // collect_paused_until — 사용자 명시적 일시중지 마스터 스위치. 미래 시각이면 find_due 자체를
    // 건너뛰어 자동 수집이 전부 멈춘다. "지금 실행" 버튼(collect_source_run_now)·visits(크롬
    // 익스텐션 수동)·link_suggest(에디터 붙여넣기) 같은 사용자 명시 트리거 경로는 영향받지
    // 않는다 — 자동 러너의 주기적 실행만 차단하는 것이 의도다.
    if is_collect_paused(conn) {
        return Ok(());
    }
    let now = crate::util::now_iso();
    let due = repo_collect::find_due(conn, &now, boot_at)?;
    for source in due {
        run_one(conn, &source, rt, data_dir);
    }
    Ok(())
}

/// collect_paused_until 이 미래 시각이면 true. 키가 없거나 빈 문자열이거나 과거 시각이면 false.
/// 시계가 과거로 가도 자동으로 풀린다(빈 문자열과 동등). validate_setting 가 형식을 보장하므로
/// 파싱 실패는 빈 문자열로 취급한다(방어적 — 조용한 실패보다 항상 켜진 채로 멈추는 게 안전).
fn is_collect_paused(conn: &Connection) -> bool {
    let raw = crate::repo::settings::get_all(conn)
        .ok()
        .and_then(|s| s.get("collect_paused_until").and_then(|v| v.as_str().map(String::from)))
        .unwrap_or_default();
    if raw.trim().is_empty() {
        return false;
    }
    match chrono::DateTime::parse_from_rfc3339(raw.trim()) {
        Ok(until) => until > chrono::Utc::now(),
        Err(_) => false, // 형식이 깨졌으면 OFF 로 폴백 — validate 가 막지만 망실 경로 대비.
    }
}

/// 백그라운드 러너 1회 실행. `finish_run_now`가 아니라 `finish_run_now_collecting_notes`를 직접
/// 부르는 이유는 딱 하나 — post_process="summary" 소스가 이번 실행에서 쓴 노트 id를 받아 ingest용
/// conn이 (이 함수 안에서, 다른 스레드와 공유되지 않는) 자기 것뿐이라는 걸 알고 있는 유일한 지점이라
/// 여기서만 안전하게 요약을 걸 수 있어서다. "지금 실행"(commands::collect)은 state.db 전역 뮤텍스를
/// 들고 finish_run_now를 부르므로 거기서 곧장 요약을 걸면 그 뮤텍스를 네트워크 호출 동안 쥐게 된다
/// (§2.2 락 규율 위반) — 이번 웨이브는 그 경로를 건드리지 않고 백그라운드 러너에만 연결한다
/// (PLAN-2026-09-04-local-import §2.4, ponytail: 수동 실행 요약은 필요해지면 커맨드 계층에
/// snapshot→release→요약 3단계를 따로 추가).
fn run_one(conn: &mut Connection, source: &repo_collect::CollectSource, rt: &tokio::runtime::Runtime, data_dir: &Path) {
    let Some(result) = collect_source(source, rt, data_dir.to_path_buf()) else {
        return; // 미구현 kind — status 건드리지 않고 조용히 스킵
    };
    match finish_run_now_collecting_notes(conn, source, Some(result)) {
        // note_ids is only ever non-empty for post_process="summary" sources (ingest_items filters
        // it) — no need to re-check post_process here.
        Ok((_, note_ids)) => {
            let ctx = CollectCtx { rt, data_dir: data_dir.to_path_buf(), since: source.last_run_at.clone() };
            for note_id in note_ids {
                summary::maybe_summarize(|| crate::db::open(&crate::db::db_path(data_dir)), &ctx, source, &note_id);
            }
        }
        Err(e) => crate::diag::warn("collect", "record_result_failed", format!("source {}: {e}", source.id)),
    }
}

/// 항목 하나를 ingest한다 — `item.parts`가 비어 있으면 기존 "항목 전체를 한 번에 seen 처리"
/// 경로(`ingest_item_whole`), 아니면 줄 단위 append/seen 경로(`ingest_item_parts`, §2.1)로
/// 나뉜다. 반환값은 "실제로 뭔가 썼는가". 프로덕션 경로(`ingest_items`)는 note id가 필요해
/// `ingest_item_with_note_id`를 직접 부르므로, 이 bool 래퍼는 이제 테스트 전용이다.
#[cfg(test)]
fn ingest_item(conn: &mut Connection, source: &repo_collect::CollectSource, item: &CollectedItem) -> AppResult<bool> {
    ingest_item_with_note_id(conn, source, item).map(|note_id| note_id.is_some())
}

/// `ingest_item`과 같은 일을 하되, 실제로 노트를 썼으면 그 note id도 돌려준다 — summary
/// 후처리(run_one)가 "이번 실행에서 어느 노트에 요약을 걸어야 하는가"를 알려면 guid/bool만으로는
/// 부족하다. ingest_item은 기존 호출부(테스트 포함)를 위해 bool 시그니처를 그대로 유지한다.
fn ingest_item_with_note_id(conn: &mut Connection, source: &repo_collect::CollectSource, item: &CollectedItem) -> AppResult<Option<String>> {
    let note_id = if item.parts.is_empty() {
        ingest_item_whole(conn, source, item)?
    } else {
        ingest_item_parts(conn, source, item)?
    };
    // 모든 어댑터가 지나는 한 지점 — 출처 속성은 여기서만 찍는다(브리핑 "새 항목", migration v90).
    // 실패해도 노트는 이미 들어갔고 seen 도 기록됐다 → 수집을 되돌리지 말고 진단만 남긴다.
    if let Some(id) = &note_id {
        if let Err(e) = crate::repo::briefing::stamp_collected(conn, id, &source.id) {
            crate::diag::warn("collect", "stamp_origin_failed", format!("source {} note {}: {e}", source.id, id));
        }
    }
    Ok(note_id)
}

/// 이미 본 guid는 건너뛴다(멱등, collect_seen). 아니면 인박스(또는 지정 폴더)에 노트로 append 하고 collect_seen에
/// 기록한다 — 노트 생성은 펫의 "메모해줘"와 같은 경로(repo::pet::create_inbox_note)를 재사용한다.
/// 반환값은 실제로 쓴 노트의 id(collect_source_run_now의 added 카운트·summary 후처리 대상 판정용) —
/// 이미 seen이라 스킵한 경우 None.
fn ingest_item_whole(conn: &mut Connection, source: &repo_collect::CollectSource, item: &CollectedItem) -> AppResult<Option<String>> {
    let mut body: String = item.body_md.chars().take(ITEM_BODY_MAX_CHARS).collect();
    if body.trim().is_empty() {
        body = item.title.clone(); // create_inbox_note는 빈 본문을 거부한다 — 제목으로 대체
    }
    if let Some(url) = &item.source_url {
        body.push_str(&format!("\n\n---\n[출처]({url})"));
    }
    let title = if item.title.trim().is_empty() { None } else { Some(item.title.as_str()) };
    // Claim before creating the note. The PK-backed INSERT is the concurrency seam: a manual run
    // and the background runner cannot both create a note for the same source/guid. If note
    // creation fails, release the claim so the next run can retry it.
    if !repo_collect::claim_seen(conn, &source.id, &item.guid)? {
        return Ok(None);
    }
    match pet::create_inbox_note(conn, &source.workspace_id, source.target_folder_id.as_deref(), title, &body) {
        Ok((note_id, _)) => {
            // AI 후처리 제안 ('suggest'): suggestions 테이블에 pending 제안 적재 (§3.4)
            if source.post_process == "suggest" {
                if let Err(e) = insert_collect_post_process_suggestion(conn, source, &note_id) {
                    crate::diag::warn(
                        "collect",
                        "post_process_suggestion_failed",
                        format!("source {} note {}: {e}", source.id, note_id),
                    );
                }
            }
            Ok(Some(note_id))
        }
        Err(e) => {
            if let Err(release_err) = repo_collect::release_seen_claim(conn, &source.id, &item.guid) {
                // 클레임은 이미 됐는데(위 claim_seen) 노트 생성도 실패하고 release도 실패했다 —
                // 이 guid는 다시 못 잡는 채로 영영 seen에 남는다(그 항목은 재시도 없이 유실).
                // record_result_failed보다 심각한 등급(error)으로 남긴다.
                crate::diag::error(
                    "collect",
                    "release_seen_claim_failed",
                    format!("source {} guid {} stuck seen after ingest error: {release_err}", source.id, item.guid),
                );
            }
            Err(e)
        }
    }
}

/// `pet::create_inbox_note`가 target_folder_id를 고르는 규칙과 같다(그 함수는 이 조회를 노트
/// 생성과 한 몸으로 하고 있어 재사용할 수 없어 여기서 같은 조회를 반복한다) — target_folder_id가
/// 지정돼 있고 이 workspace 소유면 그대로, 아니면 인박스로 폴백.
fn resolve_target_folder_id(conn: &mut Connection, workspace_id: &str, folder_id: Option<&str>) -> AppResult<String> {
    if let Some(fid) = folder_id {
        let exists: bool = conn
            .query_row("SELECT 1 FROM folders WHERE id=?1 AND workspace_id=?2", params![fid, workspace_id], |_| Ok(true))
            .optional()
            .map_err(dberr)?
            .unwrap_or(false);
        if exists {
            return Ok(fid.to_string());
        }
    }
    crate::repo::folders::ensure_inbox_folder_id(conn, workspace_id)
}

/// 항목 단위(§2.1) ingest — claude_prompts/codex_prompts/browser_history처럼 한 항목이 "하루치
/// 노트"를 대표하고, 실제 seen 판정은 그 안의 각 줄(part)마다 이뤄지는 소스용. item.guid는 절대
/// 클레임하지 않는다(날짜 묶음 자체가 seen이 되면 그날 이후 늘어난 줄이 영영 안 들어온다 —
/// PLAN-2026-09-04-local-import §2.1 Q3).
///
/// 자세는 sync_server::ingest.rs::append_visit과 같다: 같은 target 폴더에 item.title 노트가
/// 있으면 그 첫 섹션에 직접 UPDATE + fts_upsert(activity_log 없음 — 워크스페이스당 2000행
/// 상한을 하루치 줄 append가 밀어내지 않도록), 없으면 pet::create_inbox_note로 새로 만든다.
fn ingest_item_parts(conn: &mut Connection, source: &repo_collect::CollectSource, item: &CollectedItem) -> AppResult<Option<String>> {
    let folder_id = resolve_target_folder_id(conn, &source.workspace_id, source.target_folder_id.as_deref())?;
    // 동기화 후 같은 제목의 노트가 두 개 이상 있으면(각 기기가 따로 만든 경우) 여기서 하나로
    // 합친다 — append_visit도 같은 헬퍼를 써서 두 쓰기 경로가 항상 같은 생존자(가장 오래된
    // 노트)에 합의한다.
    let existing = daynote::find_or_merge_day_note(conn, &source.workspace_id, &folder_id, &item.title)?;

    // browser_history 어댑터는 conn이 없어 collect_excluded_domains를 스스로 걸러낼 수 없다
    // (PLAN-2026-09-04-local-import §2.3) — 유일하게 conn을 쥐고 있는 여기서 대신 거른다.
    // dedupe_needle이 "(url)" 모양이라는 어댑터 계약에서 URL을 다시 뽑아 판정한다.
    //
    // D5(AUDIT-2026-09-26-fallback-observability.md §4): 설정 읽기 자체가 실패하면(옛 동작은
    // 빈 목록으로 폴백해 fail-open이었다) 이번 사이클엔 아예 아무것도 ingest/클레임하지 않고
    // 통째로 건너뛴다 — 어떤 URL도 클레임되지 않으므로 다음 사이클에 자연히 재시도된다. 제외
    // 목록을 못 읽은 채로 계속 진행하면 사용자가 명시적으로 뺀 도메인이 그 창만큼은 영구히
    // ingest되는 프라이버시 사고가 재현된다.
    let excluded_domains = if source.kind == "browser_history" {
        match urlfilter::read_excluded_domains(conn) {
            Ok(v) => v,
            Err(e) => {
                crate::diag::warn(
                    "collect",
                    "excluded_domains_unreadable",
                    format!("settings read failed, skipping this cycle for source {}: {e}", source.id),
                );
                return Ok(None);
            }
        }
    } else {
        Vec::new()
    };
    let parts: Vec<&CollectedPart> = item
        .parts
        .iter()
        .filter(|p| {
            if excluded_domains.is_empty() {
                return true;
            }
            let url = p.dedupe_needle.as_deref().and_then(|n| n.strip_prefix('(')).and_then(|n| n.strip_suffix(')'));
            !url.is_some_and(|url| urlfilter::host_excluded(url, &excluded_domains))
        })
        .collect();

    // Running scratch body used only to decide dedupe_needle hits — starts from the existing
    // note's body (or empty, if we are about to create one) and grows as parts in this same
    // batch are accepted, so two parts in one run that dedupe against each other are also caught.
    let mut scratch_body = existing.as_ref().map(|(_, _, b)| b.clone()).unwrap_or_default();
    let mut new_lines: Vec<&str> = Vec::new();
    for part in parts {
        // Claim first — an already-seen part is skipped outright regardless of dedupe_needle.
        if !repo_collect::claim_seen(conn, &source.id, &part.guid)? {
            continue;
        }
        if let Some(needle) = &part.dedupe_needle {
            if scratch_body.contains(needle.as_str()) {
                continue; // claimed above, but the line itself is redundant — do not append it
            }
        }
        if !scratch_body.is_empty() {
            scratch_body.push('\n');
        }
        scratch_body.push_str(&part.line);
        new_lines.push(&part.line);
    }
    if new_lines.is_empty() {
        return Ok(None);
    }
    let appended = new_lines.join("\n");

    let note_id = match existing {
        Some((note_id, section_id, _)) => {
            let now = crate::util::now_iso();
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) // 첫 문장이 읽기 — 승격 실패 방지
                .map_err(dberr)?;
            // 덧붙일 바탕은 트랜잭션 안에서 다시 읽는다 — 위에서 읽은 본문은 claim_seen 루프 동안 낡을 수 있고,
            // 그 사이 편집기 자동 저장이 들어왔으면 낡은 본문 + 새 줄로 그 편집을 덮게 된다.
            let old_body: String = tx
                .query_row("SELECT body_md FROM sections WHERE id=?1", [&section_id], |r| r.get(0))
                .map_err(dberr)?;
            let next_body = format!("{}\n{appended}", old_body.trim_end());
            crate::repo::sections::write_body_tx(&tx, &note_id, &section_id, &next_body, &now)?;
            crate::repo::fts::fts_upsert(&tx, &note_id)?;
            tx.commit().map_err(dberr)?;
            note_id
        }
        None => {
            let title = if item.title.trim().is_empty() { None } else { Some(item.title.as_str()) };
            let (note_id, _) =
                pet::create_inbox_note(conn, &source.workspace_id, source.target_folder_id.as_deref(), title, &appended)?;
            note_id
        }
    };

    // Same "once per note write" AI post-process suggestion as the whole-item path.
    if source.post_process == "suggest" {
        if let Err(e) = insert_collect_post_process_suggestion(conn, source, &note_id) {
            crate::diag::warn(
                "collect",
                "post_process_suggestion_failed",
                format!("source {} note {}: {e}", source.id, note_id),
            );
        }
    }
    Ok(Some(note_id))
}

/// 수집 후처리 제안 삽입 — 실제 INSERT는 repo::suggestions가 소유(테이블 쓰기를 한 곳에 모으는
/// 정책). 여기선 collect 소스에서 payload를 조립해 넘기기만 한다.
fn insert_collect_post_process_suggestion(
    conn: &mut Connection,
    source: &repo_collect::CollectSource,
    note_id: &str,
) -> AppResult<()> {
    let payload = serde_json::json!({
        "source_id": source.id,
        "source_name": source.name,
        "post_process_model": source.post_process_model,
    })
    .to_string();
    suggestions::insert_collect_post_process(conn, &source.workspace_id, note_id, &payload)
}

/// `collect_source_run_now` 결과 — 커맨드 계층(commands::collect)이 그대로 프론트에 직렬화해
/// 돌려준다.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunNowOutcome {
    pub ok: bool,
    pub added: i64,
    pub error: Option<String>,
}

/// `collect_source_dry_run` 항목 하나
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DryRunItem {
    pub title: String,
    pub guid: String,
    pub seen: bool,
    pub preview: String,
}

/// `collect_source_dry_run` 결과
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DryRunOutcome {
    pub ok: bool,
    pub items: Vec<DryRunItem>,
    pub error: Option<String>,
}

fn ingest_error_message(source_id: &str, failures: &[(String, String)]) -> String {
    let details = failures
        .iter()
        .map(|(guid, error)| format!("{guid}: {error}"))
        .collect::<Vec<_>>()
        .join("; ");
    format!("failed to ingest {} item(s) from source {source_id}: {details}", failures.len())
}

/// `note_ids`는 이번 실행에서 실제로 쓴 노트 id들 — post_process="summary"가 아닌 소스에서는
/// 항상 비워둔다(불필요한 후처리 대상 수집을 하지 않는다).
fn ingest_items(
    conn: &mut Connection,
    source: &repo_collect::CollectSource,
    items: &[CollectedItem],
) -> (i64, Vec<(String, String)>, Vec<String>) {
    let mut added = 0;
    let mut failures = Vec::new();
    let mut note_ids = Vec::new();
    for item in items {
        match ingest_item_with_note_id(conn, source, item) {
            Ok(Some(note_id)) => {
                added += 1;
                if source.post_process == "summary" && !note_ids.contains(&note_id) {
                    note_ids.push(note_id);
                }
            }
            Ok(None) => {}
            Err(e) => failures.push((item.guid.clone(), e.to_string())),
        }
    }
    (added, failures, note_ids)
}

/// Complete the ingest/status half of a source run. Adapter work must already be finished before
/// calling this function; callers can therefore hold the DB mutex only for this short phase.
/// `None` means the kind has no adapter yet and intentionally leaves source status untouched.
pub fn finish_run_now(
    conn: &mut Connection,
    source: &repo_collect::CollectSource,
    result: Option<AppResult<Vec<CollectedItem>>>,
) -> AppResult<RunNowOutcome> {
    finish_run_now_collecting_notes(conn, source, result).map(|(outcome, _note_ids)| outcome)
}

/// `finish_run_now`와 완전히 같은 일을 하고, 추가로 이번 실행에서 쓴 노트 id들을 함께 돌려준다 —
/// 백그라운드 러너(`run_one`)가 post_process="summary" 노트에 `summary::maybe_summarize`를
/// 거는 데 쓴다(§2.4). `finish_run_now`는 시그니처를 그대로 유지한다 — commands::collect가
/// 직접 그 3-인자 시그니처를 부르므로, note id를 노출하려면 이 내부 함수를 새로 두는 쪽이
/// 기존 커맨드 계층을 건드리지 않는다.
pub fn finish_run_now_collecting_notes(
    conn: &mut Connection,
    source: &repo_collect::CollectSource,
    result: Option<AppResult<Vec<CollectedItem>>>,
) -> AppResult<(RunNowOutcome, Vec<String>)> {
    // A source may be deleted while an out-of-lock adapter fetch is in flight. Do not ingest into
    // a deleted source's workspace or write a status row that no longer has an owner.
    if repo_collect::get(conn, &source.id)?.is_none() {
        return Err(crate::error::AppError::NotFound(format!("collect source not found: {}", source.id)));
    }
    // Every ingest path (collect_source_run_now, run_one/background, run_now) converges here —
    // guarding once at this chokepoint is the fix, not per-caller. The background loop already
    // excludes dry_run via find_due's `WHERE dry_run = 0`, but the "지금 실행" button reaches this
    // function too and must never write real notes for a dry-run source (found in review: it did).
    if source.dry_run {
        return Ok((
            RunNowOutcome {
                ok: false,
                added: 0,
                error: Some(format!(
                    "source '{}' is in dry-run mode — use the dry-run preview instead of run-now",
                    source.name
                )),
            },
            Vec::new(),
        ));
    }
    let Some(result) = result else {
        return Ok((
            RunNowOutcome {
                ok: false,
                added: 0,
                error: Some(format!("no collector adapter for kind '{}'", source.kind)),
            },
            Vec::new(),
        ));
    };
    match result {
        Ok(items) => {
            let (added, failures, note_ids) = ingest_items(conn, source, &items);
            // One activity row per run (never per line) when this run actually added something —
            // every ingest path (background run_one, "지금 실행") converges on finish_run_now, so
            // logging here once covers both without duplicating the check per caller.
            if added > 0 {
                let summary = format!("{} {added}건", source.name);
                if let Err(e) = activity::record(conn, &source.workspace_id, None, activity::KIND_COLLECT, &summary, None) {
                    crate::diag::warn("collect", "activity_record_failed", format!("source {}: {e}", source.id));
                }
            }
            if failures.is_empty() {
                // browser_history가 이번 run에서 VISIT_LIMIT만큼 꽉 채워 돌려줬다면 History에
                // 더 가져올 방문이 남아 있다는 뜻이다(§backfill continuation, PLAN-2026-09-04-
                // local-import hygiene wave) — "partial"로 기록하면 repo::collect::is_due가
                // 주기와 무관하게 다음 tick에 바로 다시 집어 들게 한다. 다른 kind는 VISIT_LIMIT과
                // 우연히 part 수가 같아도 이 분기를 절대 타지 않는다(kind 검사가 먼저다).
                let total_parts: usize = items.iter().map(|i| i.parts.len()).sum();
                let status = if source.kind == "browser_history" && total_parts == browser_history::VISIT_LIMIT as usize {
                    "partial"
                } else {
                    "ok"
                };
                repo_collect::record_result(conn, &source.id, status, None)?;
                Ok((RunNowOutcome { ok: true, added, error: None }, note_ids))
            } else {
                let msg = ingest_error_message(&source.id, &failures);
                repo_collect::record_result(conn, &source.id, "error", Some(&msg))?;
                Ok((RunNowOutcome { ok: false, added, error: Some(msg) }, note_ids))
            }
        }
        Err(e) => {
            let msg = e.to_string();
            repo_collect::record_result(conn, &source.id, "error", Some(&msg))?;
            Ok((RunNowOutcome { ok: false, added: 0, error: Some(msg) }, Vec::new()))
        }
    }
}

/// 소스 하나를 주기 무시하고 지금 1회 실행한다. run_one/run_cycle(백그라운드 러너)과 완전히 같은
/// 경로(collect_for_kind 디스패치 → ingest_item → record_result)를 재사용한다 — 중복 구현 없음,
/// 차이는 due 여부를 안 보고(호출 자체가 "지금 실행" 의사) 결과를 호출자에게 그대로 돌려준다는
/// 점뿐이다. run_one과 달리 에러를 삼키지 않고 Ok(RunNowOutcome{ok:false, ..})로 표면화한다 —
/// "지금 실행" 버튼을 누른 사용자는 실패 사유를 바로 봐야 한다(3단계 UI).
pub fn run_now(conn: &mut Connection, id: &str, rt: &tokio::runtime::Runtime, data_dir: PathBuf) -> AppResult<RunNowOutcome> {
    let source = repo_collect::get(conn, id)?
        .ok_or_else(|| crate::error::AppError::NotFound(format!("collect source not found: {id}")))?;
    let result = collect_source(&source, rt, data_dir);
    finish_run_now(conn, &source, result)
}

/// Seen-check phase only — adapter work (fetch/parse) must already be finished before calling
/// this. Mirrors `finish_run_now`'s split so callers can snapshot the source under a DB lock,
/// release it for the (possibly slow) adapter fetch, then re-lock only for this short phase.
///
/// 불변식:
/// 1. 어댑터(fetch/파싱)는 호출자가 락 없이 이미 실행해 둔다.
/// 2. `claim_seen` 을 호출하지 않아 DB 쓰기 0건.
/// 3. `collect_seen` 행을 조회하여 각 항목의 기수집 여부(`seen`)만 판정.
/// 4. `record_result`를 호출하지 않아 `last_run_at`과 주기 시계가 변경되지 않음.
pub fn finish_dry_run(
    conn: &Connection,
    source: &repo_collect::CollectSource,
    result: Option<AppResult<Vec<CollectedItem>>>,
) -> AppResult<DryRunOutcome> {
    // A source may be deleted while an out-of-lock adapter fetch is in flight (same guard as
    // finish_run_now) — don't report seen-state for a source that no longer exists.
    if repo_collect::get(conn, &source.id)?.is_none() {
        return Err(crate::error::AppError::NotFound(format!("collect source not found: {}", source.id)));
    }
    let Some(result) = result else {
        return Ok(DryRunOutcome {
            ok: false,
            items: Vec::new(),
            error: Some(format!("no collector adapter for kind '{}'", source.kind)),
        });
    };
    match result {
        Ok(items) => {
            // 항목 하나당 is_seen SELECT를 쏘던 N+1(100건 RSS = 100쿼리)을 청크당 배치 쿼리 1회로.
            // parts가 있는 항목은 item.guid가 절대 클레임되지 않으므로(§2.1) item.guid로 seen을
            // 물으면 언제나 false다 — part guid들도 같은 배치에 함께 담아 판정한다.
            let mut guids: Vec<String> = Vec::new();
            for item in &items {
                if item.parts.is_empty() {
                    guids.push(item.guid.clone());
                } else {
                    guids.extend(item.parts.iter().map(|p| p.guid.clone()));
                }
            }
            let seen_set = repo_collect::seen_guids(conn, &source.id, &guids)?;
            let mut dry_items = Vec::new();
            for item in items {
                if item.parts.is_empty() {
                    let seen = seen_set.contains(&item.guid);
                    let preview: String = item.body_md.chars().take(200).collect();
                    dry_items.push(DryRunItem { title: item.title, guid: item.guid, seen, preview });
                } else {
                    // 새 것/기수집 판정과 preview 둘 다 part 단위로 낸다: seen은 "이 항목에 더
                    // 붙을 줄이 하나도 없다"는 뜻이고, preview는 실제 노트에 새로 붙을 줄들만
                    // 보여준다(이미 seen인 줄까지 섞으면 "뭐가 새로 들어오는지"를 못 보여준다).
                    let unseen_lines: Vec<&str> =
                        item.parts.iter().filter(|p| !seen_set.contains(&p.guid)).map(|p| p.line.as_str()).collect();
                    let seen = unseen_lines.is_empty();
                    let preview: String = unseen_lines.join("\n").chars().take(200).collect();
                    dry_items.push(DryRunItem { title: item.title, guid: item.guid, seen, preview });
                }
            }
            Ok(DryRunOutcome {
                ok: true,
                items: dry_items,
                error: None,
            })
        }
        Err(e) => Ok(DryRunOutcome {
            ok: false,
            items: Vec::new(),
            error: Some(e.to_string()),
        }),
    }
}

/// Convenience wrapper used by tests (and any caller that doesn't need the lock split): fetch and
/// seen-check in one call, holding `conn` for the whole duration. Production code (the
/// `collect_source_dry_run` command) calls `collect_source` + `finish_dry_run` directly instead,
/// releasing the DB mutex during the adapter fetch (see Finding 1 — dry_run used to hold the
/// global DB lock across network/yt-dlp work).
pub fn dry_run(conn: &Connection, id: &str, rt: &tokio::runtime::Runtime, data_dir: PathBuf) -> AppResult<DryRunOutcome> {
    let source = repo_collect::get(conn, id)?
        .ok_or_else(|| crate::error::AppError::NotFound(format!("collect source not found: {id}")))?;
    let result = collect_source(&source, rt, data_dir);
    finish_dry_run(conn, &source, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_folds_newlines_and_caps_length() {
        assert_eq!(one_line("a

  b  
c", 100), "a ⏎ b ⏎ c");
        let long = one_line(&"x".repeat(600), 500);
        assert_eq!(long.chars().count(), 501);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn skip_notice_part_names_the_size_and_is_stable_for_the_same_file() {
        let file = std::path::Path::new("C:/fake/huge.jsonl");
        let a = skip_notice_part("claude", "ProjA", "2026-09-05", file, 126 * 1024 * 1024);
        assert_eq!(a.guid, format!("claude:ProjA:2026-09-05:skipped:{}", sha256_hex16(&file.to_string_lossy())));
        assert_eq!(a.line, "- (건너뜀) 세션 파일 1개가 너무 커서 읽지 않았습니다 (126MB)");
        assert!(a.dedupe_needle.is_none());

        // Same file, same run parameters -> same guid (so a repeat run is seen and does not
        // append the notice line twice).
        let b = skip_notice_part("claude", "ProjA", "2026-09-05", file, 126 * 1024 * 1024);
        assert_eq!(a.guid, b.guid);
    }
    use crate::util::now_iso;
    use rusqlite::params;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute("INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', ?1)", params![now_iso()]).unwrap();
        conn
    }

    fn item(guid: &str, title: &str, body: &str) -> CollectedItem {
        CollectedItem {
            guid: guid.to_string(),
            title: title.to_string(),
            body_md: body.to_string(),
            source_url: Some("https://example.com/a".to_string()),
            published_at: None,
            parts: Vec::new(),
        }
    }

    fn part(guid: &str, line: &str, dedupe_needle: Option<&str>) -> CollectedPart {
        CollectedPart { guid: guid.to_string(), line: line.to_string(), dedupe_needle: dedupe_needle.map(str::to_string) }
    }

    /// parts를 실어 보내는 항목 하나 — item.guid는 식별용일 뿐 절대 클레임되지 않는다.
    fn item_with_parts(guid: &str, title: &str, parts: Vec<CollectedPart>) -> CollectedItem {
        CollectedItem {
            guid: guid.to_string(),
            title: title.to_string(),
            body_md: String::new(),
            source_url: None,
            published_at: None,
            parts,
        }
    }

    #[test]
    fn ingest_item_creates_an_inbox_note_and_marks_the_guid_seen() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Feed", "{}").unwrap();
        ingest_item(&mut conn, &source, &item("g1", "Title A", "Body A")).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title = 'Title A'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        assert!(repo_collect::is_seen(&conn, &source.id, "g1").unwrap());

        let body: String = conn.query_row(
            "SELECT s.body_md FROM sections s JOIN notes n ON n.id = s.note_id WHERE n.title = 'Title A'",
            [], |r| r.get(0),
        ).unwrap();
        assert!(body.contains("Body A"));
        assert!(body.contains("https://example.com/a"), "source link footer must be appended");

        // 출처 속성(migration v90) — 수집 커밋 경로가 찍는다.
        let (origin, at): (Option<String>, Option<String>) = conn
            .query_row("SELECT origin_source_id, collected_at FROM notes WHERE title = 'Title A'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(origin.as_deref(), Some(source.id.as_str()));
        assert!(at.is_some());
    }

    /// guid 중복 시 재수집 안 함 — 두 번째 ingest는 이미 seen이므로 노트를 또 만들지 않는다.
    #[test]
    fn ingest_item_skips_a_guid_already_seen_for_that_source() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Feed", "{}").unwrap();
        ingest_item(&mut conn, &source, &item("g1", "Title A", "Body A")).unwrap();
        // Same guid, different content (simulates a re-fetch of an unchanged feed) — must be a no-op.
        ingest_item(&mut conn, &source, &item("g1", "Title A (edited)", "Body A v2")).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "the second ingest of the same guid must not create a second note");
    }

    #[test]
    fn ingest_item_releases_its_claim_when_note_creation_fails() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Feed", "{}").unwrap();

        // An entirely empty item is rejected by create_inbox_note. A failed ingest must not
        // leave a collect_seen claim behind, otherwise a later retry would be lost forever.
        let empty = CollectedItem {
            guid: "retry-me".to_string(),
            title: String::new(),
            body_md: String::new(),
            source_url: None,
            published_at: None,
            parts: Vec::new(),
        };
        let err = ingest_item(&mut conn, &source, &empty).unwrap_err();
        assert!(matches!(err, crate::error::AppError::Validation(_)));
        assert!(!repo_collect::is_seen(&conn, &source.id, "retry-me").unwrap());

        let recovered = item("retry-me", "Recovered", "Body");
        assert!(ingest_item(&mut conn, &source, &recovered).unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn finish_run_now_reports_partial_ingest_failures_and_successful_count() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Feed", "{}").unwrap();
        let empty = CollectedItem {
            guid: "bad".to_string(),
            title: String::new(),
            body_md: String::new(),
            source_url: None,
            published_at: None,
            parts: Vec::new(),
        };
        let result = Some(Ok(vec![item("ok", "Good", "Body"), empty]));

        let outcome = finish_run_now(&mut conn, &source, result).unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.added, 1);
        assert!(outcome.error.as_deref().is_some_and(|e| e.contains("bad")));
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("error"));
        assert!(after.last_error.as_deref().is_some_and(|e| e.contains("bad")));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn run_one_skips_a_source_whose_kind_has_no_adapter_yet_without_touching_status() {
        let mut conn = test_conn();
        // claude_prompts now has a real adapter (P3 2단계) — use a still-unimplemented kind here
        // to keep exercising the "collect_for_kind returns None" branch.
        let source = repo_collect::create(&conn, "ws1", "some_future_kind", "Future", "{}").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        run_one(&mut conn, &source, &rt, &std::env::temp_dir());

        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status, None, "unimplemented adapter kinds must not mark ok/error");
        assert_eq!(after.last_run_at, None);
    }

    /// collect_source_run_now(3단계 "지금 실행" 버튼)의 핵심 경로 — claude_prompts 어댑터를
    /// 실제로 실행해 노트가 생기고 collect_seen이 갱신되는지, 재실행 시 added=0(멱등)인지 확인.
    /// 실제 ~/.claude 는 절대 건드리지 않는다 — dir을 tempdir로 override.
    #[test]
    fn run_now_ingests_items_and_is_idempotent_on_a_second_call() {
        let mut conn = test_conn();
        // The Claude adapter is intentionally restricted to ~/.claude/projects. Keep the test
        // isolated with a unique child there instead of bypassing the same production guard.
        let dir = config::claude_projects_root().join(format!("brise-collect-run-now-test-{}", uuid::Uuid::new_v4()));
        let proj_dir = dir.join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let yesterday = (chrono::Local::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"hello"}},"timestamp":"{yesterday}T09:00:00.000Z"}}"#
        );
        std::fs::write(proj_dir.join("s1.jsonl"), line).unwrap();

        let config = serde_json::json!({ "dir": dir.to_str().unwrap() }).to_string();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Prompts", &config).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let outcome = run_now(&mut conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.added, 1);
        assert_eq!(outcome.error, None);
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("ok"));

        // Same day, no new content — must be a no-op (guid already seen).
        let outcome2 = run_now(&mut conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(outcome2.ok);
        assert_eq!(outcome2.added, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_now_returns_not_found_for_an_unknown_source_id() {
        let mut conn = test_conn();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(matches!(run_now(&mut conn, "nope", &rt, std::env::temp_dir()), Err(crate::error::AppError::NotFound(_))));
    }

    /// Finding 4: a dry_run source must never write real notes via "지금 실행" (collect_source_run_now
    /// → this same run_now/finish_run_now path). The background scheduler already excludes dry_run
    /// via find_due's `WHERE dry_run = 0`; this covers the other route into ingestion.
    #[test]
    fn run_now_refuses_to_ingest_for_a_dry_run_source() {
        let mut conn = test_conn();
        let source = repo_collect::create_with_options(
            &conn,
            repo_collect::CreateCollectSourceParams {
                workspace_id: "ws1",
                kind: "claude_prompts",
                name: "Dry Run Only",
                config: "{}",
                dry_run: true,
                target_folder_id: None,
                post_process: "none",
                post_process_model: None,
                interval_minutes: None,
                show_in_briefing: true,
            },
        )
        .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let outcome = run_now(&mut conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.added, 0);
        assert!(outcome.error.as_deref().is_some_and(|e| e.contains("dry-run")));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        // last_run_at/last_status must stay untouched too — run-now on a dry-run source is a no-op.
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_run_at, None);
        assert_eq!(after.last_status, None);
    }

    #[test]
    fn run_one_records_an_error_status_when_the_adapter_fails_without_stopping_the_loop() {
        let mut conn = test_conn();
        // rss with no url in config -> the adapter returns Err(Validation).
        let source = repo_collect::create(&conn, "ws1", "rss", "Bad Feed", "{}").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        run_one(&mut conn, &source, &rt, &std::env::temp_dir());

        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("error"));
        assert!(after.last_error.is_some());
        assert!(after.last_run_at.is_some(), "last_run_at must advance even on failure (backoff until next interval)");
    }

    /// Finding 1: the production command (collect_source_dry_run) no longer holds the DB lock
    /// across the adapter fetch — it calls `collect_source` (no conn) and only re-locks for
    /// `finish_dry_run`. Exercise that exact split directly instead of the `dry_run` convenience
    /// wrapper, so a regression back to "one function holding conn the whole time" doesn't hide.
    #[test]
    fn finish_dry_run_reports_seen_state_after_an_out_of_lock_fetch() {
        let conn = test_conn();
        let dir = config::claude_projects_root().join(format!("brise-collect-finish-dry-run-test-{}", uuid::Uuid::new_v4()));
        let proj_dir = dir.join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let yesterday = (chrono::Local::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"split test"}},"timestamp":"{yesterday}T09:00:00.000Z"}}"#
        );
        std::fs::write(proj_dir.join("s1.jsonl"), line).unwrap();
        let config = serde_json::json!({ "dir": dir.to_str().unwrap() }).to_string();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Split Feed", &config).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // Adapter fetch happens with no conn borrowed at all (collect_source takes rt/data_dir only).
        let result = collect_source(&source, &rt, std::env::temp_dir());
        // finish_dry_run only needs conn for the short seen-check phase that follows.
        let outcome = finish_dry_run(&conn, &source, result).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.items.len(), 1);
        assert_eq!(outcome.items[0].seen, false);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id = ?1", [&source.id], |r| r.get::<_, i64>(0)).unwrap(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finish_dry_run_errors_for_a_source_deleted_mid_fetch() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Deleted Mid Fetch", "{}").unwrap();
        repo_collect::delete(&mut conn, &source.id).unwrap();

        let err = finish_dry_run(&conn, &source, Some(Ok(Vec::new()))).unwrap_err();
        assert!(matches!(err, crate::error::AppError::NotFound(_)));
    }

    #[test]
    fn dry_run_does_not_claim_seen_or_write_notes_and_keeps_last_run_at_null() {
        let mut conn = test_conn();
        let dir = config::claude_projects_root().join(format!("brise-collect-dry-run-test-{}", uuid::Uuid::new_v4()));
        let proj_dir = dir.join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        let yesterday = (chrono::Local::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"dry run test"}},"timestamp":"{yesterday}T09:00:00.000Z"}}"#
        );
        std::fs::write(proj_dir.join("s1.jsonl"), line).unwrap();

        let config = serde_json::json!({ "dir": dir.to_str().unwrap() }).to_string();
        let source = repo_collect::create_with_options(
            &conn,
            repo_collect::CreateCollectSourceParams {
                workspace_id: "ws1",
                kind: "claude_prompts",
                name: "Dry Run Feed",
                config: &config,
                dry_run: true,
                target_folder_id: None,
                post_process: "none",
                post_process_model: None,
                interval_minutes: None,
                show_in_briefing: true,
            },
        ).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        // 1. 드라이런 실행
        let outcome = dry_run(&conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.items.len(), 1);
        assert_eq!(outcome.items[0].seen, false);
        assert!(outcome.items[0].preview.contains("dry run test"));

        // 검증: collect_seen 행 0건, notes 행 0건, last_run_at 은 None 그대로
        let seen_count: i64 = conn.query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id = ?1", [&source.id], |r| r.get(0)).unwrap();
        assert_eq!(seen_count, 0, "dry_run must not claim seen");
        let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE title LIKE '%dry run%'", [], |r| r.get(0)).unwrap();
        assert_eq!(note_count, 0, "dry_run must not create notes");
        let after_dry = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after_dry.last_run_at, None, "dry_run must not advance last_run_at");

        // 2. 이어서 실제 run_now 실행 -> 정상 적재되는지 확인 (과거 항목 유실 방지 불변식 검증).
        // Finding 4: dry_run 소스는 run_now가 거부하므로(위 run_now_refuses_to_ingest_for_a_dry_run_source
        // 참고), 실제 사용자 플로우대로 dry_run을 끈 뒤 실행한다.
        repo_collect::update(&conn, &source.id, repo_collect::UpdateCollectSourceParams {
            dry_run: Some(false),
            ..Default::default()
        }).unwrap();
        let actual_run = run_now(&mut conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(actual_run.ok);
        assert_eq!(actual_run.added, 1);
        let seen_after: i64 = conn.query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id = ?1", [&source.id], |r| r.get(0)).unwrap();
        assert_eq!(seen_after, 1);

        // 3. 다시 드라이런 실행 시 seen=true 반환 확인
        let outcome_seen = dry_run(&conn, &source.id, &rt, std::env::temp_dir()).unwrap();
        assert!(outcome_seen.ok);
        assert_eq!(outcome_seen.items.len(), 1);
        assert_eq!(outcome_seen.items[0].seen, true);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ingest_item_respects_target_folder_and_creates_post_process_suggestion() {
        let mut conn = test_conn();
        let folder = crate::repo::folders::create(&mut conn, "Feed Folder", Some("ws1".to_string()), None, None, None).unwrap();

        let source = repo_collect::create_with_options(
            &conn,
            repo_collect::CreateCollectSourceParams {
                workspace_id: "ws1",
                kind: "rss",
                name: "AI Suggest Feed",
                config: "{}",
                dry_run: false,
                target_folder_id: Some(&folder.id),
                post_process: "suggest",
                post_process_model: Some("gpt-4o"),
                interval_minutes: None,
                show_in_briefing: true,
            },
        ).unwrap();

        ingest_item(&mut conn, &source, &item("guid-suggest-1", "AI Note", "Content")).unwrap();

        // 1. 지정 폴더에 생성되었는지 확인
        let note_folder: String = conn.query_row("SELECT folder_id FROM notes WHERE title = 'AI Note'", [], |r| r.get(0)).unwrap();
        assert_eq!(note_folder, folder.id);

        // 2. suggestions 테이블에 pending 제안이 생성되었는지 확인
        let (sugg_kind, sugg_status, payload): (String, String, String) = conn.query_row(
            "SELECT kind, status, payload FROM suggestions WHERE workspace_id = 'ws1' AND kind = 'collect_post_process'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(sugg_kind, "collect_post_process");
        assert_eq!(sugg_status, "pending");
        assert!(payload.contains("gpt-4o"));
    }

    #[test]
    fn is_collect_paused_off_when_explicitly_empty_or_past() {
        // "키 없음" 은 더 이상 이 테스트로 재현할 수 없다: settings::get_all() 은 DB에 행이
        // 없는 키를 항상 default_settings() 값으로 채우고, collect_paused_until 의 시드가
        // far-future 로 바뀌었으므로 `DELETE FROM settings WHERE key=...` 후에도 get_all() 이
        // 다시 far-future 를 채워 is_collect_paused 는 true(paused)를 반환한다 — "키 없음"과
        // "새 DB 초기 상태"가 이제 동일한 시나리오가 됐다. 그 케이스는
        // fresh_db_starts_paused_by_default 로 옮겼다. 여기서는 명시적으로 값을 쓴
        // 두 OFF 케이스만 검증한다.
        //
        // 빈 문자열 → OFF
        let mut conn = test_conn();
        crate::repo::settings::set(
            &mut conn,
            &std::collections::BTreeMap::from([("collect_paused_until".to_string(), serde_json::json!(""))]),
        )
        .unwrap();
        assert!(!super::is_collect_paused(&conn));
        // 과거 시각 → OFF
        let mut conn = test_conn();
        crate::repo::settings::set(
            &mut conn,
            &std::collections::BTreeMap::from([(
                "collect_paused_until".to_string(),
                serde_json::json!("2000-01-01T00:00:00+00:00"),
            )]),
        )
        .unwrap();
        assert!(!super::is_collect_paused(&conn));
    }

    #[test]
    fn fresh_db_starts_paused_by_default() {
        // default_settings 가 collect_paused_until 을 far-future 로 시드 — 새 DB는 수집이
        // 꺼진 채 시작한다("수집 크론 기본값 OFF" 결정). settings::get_all() 은 DB에 저장된
        // 행이 없는 키를 항상 이 기본값으로 채우므로, 이 키를 한 번도 명시적으로 설정한 적
        // 없는 연결(신규 DB든, 이 키에 대해서만 행이 없는 기존 DB든)은 모두 이 경로를 탄다.
        let conn = test_conn();
        assert!(super::is_collect_paused(&conn));
    }

    #[test]
    fn is_collect_paused_rejects_malformed_in_validation() {
        // 형식 오류는 validate_setting 이 먼저 막는다(파싱 실패 = VALIDATION). settings::set
        // 자체가 실패하므로 is_collect_paused 가 잘못된 값을 볼 일은 없다 — 망실 경로(직접 SQL
        // 인서트 등)에서만 폴백 분기가 동작한다. 여기선 "막힌다"만 확인.
        let mut conn = test_conn();
        let result = crate::repo::settings::set(
            &mut conn,
            &std::collections::BTreeMap::from([(
                "collect_paused_until".to_string(),
                serde_json::json!("not-a-date"),
            )]),
        );
        assert!(result.is_err(), "validate_setting 이 형식 오류를 막아야 한다");
    }

    #[test]
    fn is_collect_paused_on_when_future_timestamp() {
        let mut conn = test_conn();
        crate::repo::settings::set(
            &mut conn,
            &std::collections::BTreeMap::from([(
                "collect_paused_until".to_string(),
                serde_json::json!("2099-12-31T23:59:59+00:00"),
            )]),
        )
        .unwrap();
        assert!(super::is_collect_paused(&conn));
    }

    fn youtube_item(guid: &str, url: &str) -> CollectedItem {
        CollectedItem {
            guid: guid.to_string(),
            title: "A Video".to_string(),
            body_md: "description only".to_string(),
            source_url: Some(url.to_string()),
            published_at: None,
            parts: Vec::new(),
        }
    }

    /// ① seen guid는 fetch 클로저가 호출되지 않고 원본 body 유지.
    #[test]
    fn enrich_youtube_items_skips_fetch_for_already_seen_guids() {
        let items = vec![youtube_item("g1", "https://www.youtube.com/watch?v=abc123")];
        let seen: std::collections::HashSet<String> = ["g1".to_string()].into_iter().collect();
        let calls = std::cell::RefCell::new(0);
        let out = enrich_youtube_items(items, &seen, |_url| {
            *calls.borrow_mut() += 1;
            Ok("SUBS".to_string())
        });
        assert_eq!(*calls.borrow(), 0, "seen guid must not trigger a fetch");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].body_md, "description only", "seen item's body must stay untouched");
    }

    /// ② unseen 유튜브 항목은 body가 자막으로 교체된다.
    #[test]
    fn enrich_youtube_items_replaces_body_for_an_unseen_youtube_item() {
        let items = vec![youtube_item("g1", "https://www.youtube.com/watch?v=abc123")];
        let seen = std::collections::HashSet::new();
        let out = enrich_youtube_items(items, &seen, |_url| Ok("SUBTITLES HERE".to_string()));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].body_md, "SUBTITLES HERE");
    }

    /// ③ 캡 초과 unseen 유튜브 항목은 결과에서 제거된다. 비유튜브 항목은 캡과 무관하게 유지.
    #[test]
    fn enrich_youtube_items_drops_unseen_youtube_items_beyond_the_cap_but_keeps_non_youtube_items() {
        let mut items: Vec<CollectedItem> = (0..ENRICH_CAP + 2)
            .map(|i| youtube_item(&format!("g{i}"), &format!("https://youtu.be/vid{i}")))
            .collect();
        items.push(item("non-yt", "Regular Post", "regular body")); // 기존 item() 헬퍼 = 비유튜브 URL
        let seen = std::collections::HashSet::new();
        let calls = std::cell::RefCell::new(0);
        let out = enrich_youtube_items(items, &seen, |_url| {
            *calls.borrow_mut() += 1;
            Ok("SUBS".to_string())
        });
        assert_eq!(*calls.borrow(), ENRICH_CAP, "only the cap's worth of youtube items may be fetched");
        assert_eq!(out.len(), ENRICH_CAP + 1, "capped items are dropped; the non-youtube item survives");
        assert!(out.iter().any(|i| i.guid == "non-yt"), "non-youtube items are never capped");
        assert!(
            out.iter().all(|i| i.guid != format!("g{ENRICH_CAP}")),
            "the unseen youtube item past the cap must be dropped, not just left unfetched"
        );
    }

    /// ④ fetch 실패 항목은 원본 body 유지 + 결과에 포함(재시도보다 링크+설명이라도 저장).
    /// U6: 흔적 없이 사라지던 실패가 이제 노트 본문에 눈에 보이는 안내 줄로 남는다(§4).
    #[test]
    fn enrich_youtube_items_keeps_original_body_and_still_includes_the_item_when_fetch_fails() {
        let items = vec![youtube_item("g1", "https://www.youtube.com/watch?v=abc123")];
        let seen = std::collections::HashSet::new();
        let out = enrich_youtube_items(items, &seen, |_url| {
            Err(crate::error::AppError::Validation("no subtitles found for video".to_string()))
        });
        assert_eq!(out.len(), 1, "fetch failure must not drop the item");
        assert!(out[0].body_md.starts_with("description only"), "original body must survive a fetch failure");
        assert!(out[0].body_md.contains("건너뜀"), "must add a visible marker so the user knows the transcript is missing (U6)");
    }

    /// ⑤ youtu.be/watch?v= 판정과 비유튜브 URL 통과.
    #[test]
    fn is_youtube_url_recognizes_watch_and_short_links_and_rejects_others() {
        assert!(is_youtube_url("https://www.youtube.com/watch?v=abc123"));
        assert!(is_youtube_url("https://youtube.com/watch?v=abc123"));
        assert!(is_youtube_url("https://m.youtube.com/watch?v=abc123"));
        assert!(is_youtube_url("https://youtu.be/abc123"));
        assert!(!is_youtube_url("https://example.com/watch?v=abc123"), "non-youtube host");
        assert!(!is_youtube_url("https://www.youtube.com/channel/UC123"), "channel url, not a watch page");
        assert!(!is_youtube_url("not a url"));
    }

    /// PLAN-2026-09-04-local-import §2.1 — parts 경로의 핵심 왕복: 같은 (project,date) 항목을
    /// 두 번 ingest해도 노트는 하나, 두 번째 run에서 새 줄만 append되고, item.guid는 절대
    /// collect_seen에 클레임되지 않으며(날짜 묶음 자체가 seen이 되면 그 뒤로 늘어난 줄이 영영
    /// 안 들어온다), 각 part guid는 개별적으로 seen에 남는다.
    #[test]
    fn parts_append_to_the_same_day_note_and_claim_each_part() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Prompts", "{}").unwrap();

        let first_run = item_with_parts(
            "claude:proj:2026-09-04",
            "클로드 프롬프트 — proj 2026-09-04",
            vec![part("p1", "- 09:00 first prompt", None), part("p2", "- 09:05 second prompt", None)],
        );
        assert!(ingest_item(&mut conn, &source, &first_run).unwrap());

        let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(note_count, 1);
        let body: String = conn
            .query_row(
                "SELECT s.body_md FROM sections s JOIN notes n ON n.id = s.note_id WHERE n.title = ?1",
                [&first_run.title],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(body, "- 09:00 first prompt\n- 09:05 second prompt");
        assert!(!repo_collect::is_seen(&conn, &source.id, &first_run.guid).unwrap(), "item.guid must never be claimed");
        assert!(repo_collect::is_seen(&conn, &source.id, "p1").unwrap());
        assert!(repo_collect::is_seen(&conn, &source.id, "p2").unwrap());

        // Second run: p1/p2 already seen (re-fetch of the same JSONL lines), p3 is new.
        let second_run = item_with_parts(
            "claude:proj:2026-09-04",
            "클로드 프롬프트 — proj 2026-09-04",
            vec![part("p1", "- 09:00 first prompt", None), part("p2", "- 09:05 second prompt", None), part("p3", "- 09:10 third prompt", None)],
        );
        assert!(ingest_item(&mut conn, &source, &second_run).unwrap());

        let note_count_after: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(note_count_after, 1, "same-day re-ingest must append to the existing note, not create a second one");
        let body_after: String = conn
            .query_row(
                "SELECT s.body_md FROM sections s JOIN notes n ON n.id = s.note_id WHERE n.title = ?1",
                [&first_run.title],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(body_after, "- 09:00 first prompt\n- 09:05 second prompt\n- 09:10 third prompt");
        assert!(repo_collect::is_seen(&conn, &source.id, "p3").unwrap());

        // A third run with nothing new must be a no-op (Ok(false), no further writes).
        let third_run = item_with_parts(
            "claude:proj:2026-09-04",
            "클로드 프롬프트 — proj 2026-09-04",
            vec![part("p1", "- 09:00 first prompt", None), part("p3", "- 09:10 third prompt", None)],
        );
        assert!(!ingest_item(&mut conn, &source, &third_run).unwrap(), "no unseen parts means no write");
    }

    /// dedupe_needle이 이미 본문에 있으면 줄은 붙지 않지만 그 part guid는 그래도 클레임된다
    /// (browser_history 어댑터가 재방문 URL을 다시 fetch해도 재방문마다 줄이 늘어나지 않게 하는
    /// 메커니즘 — §2.1).
    #[test]
    fn parts_with_a_dedupe_needle_already_in_the_body_are_claimed_but_not_appended() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "Visits", "{}").unwrap();

        let first = item_with_parts(
            "visits:2026-09-04",
            "브라우징 기록 — 2026-09-04",
            vec![part("v1", "- 09:00 [Example](https://example.com/a) · 5분", Some("(https://example.com/a)"))],
        );
        assert!(ingest_item(&mut conn, &source, &first).unwrap());

        // Re-fetch of the same visit: same URL (dedupe_needle hit), different guid (visit id
        // differs because the browser history row differs) — must be claimed, not appended.
        let second = item_with_parts(
            "visits:2026-09-04",
            "브라우징 기록 — 2026-09-04",
            vec![part("v2", "- 09:30 [Example](https://example.com/a) · 5분", Some("(https://example.com/a)"))],
        );
        assert!(!ingest_item(&mut conn, &source, &second).unwrap(), "dedupe_needle hit must not write");
        assert!(repo_collect::is_seen(&conn, &source.id, "v2").unwrap(), "still claimed even though not appended");

        let body: String = conn
            .query_row("SELECT s.body_md FROM sections s JOIN notes n ON n.id = s.note_id WHERE n.title = ?1", [&first.title], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "- 09:00 [Example](https://example.com/a) · 5분", "second line must not have been appended");
    }

    /// 동기화 수렴 규칙(daynote::find_or_merge_day_note) 왕복 — 두 기기가 동기화 전에 각자 만든
    /// 같은 제목의 노트가 인박스에 두 개 있어도, ingest_item_parts는 그중 하나(가장 오래된 것)에
    /// 새 줄을 붙이고 나머지는 소프트 삭제한다. append_visit도 같은 헬퍼를 쓴다는 계약은
    /// sync_server::ingest.rs 쪽 테스트가 별도로 증명한다.
    #[test]
    fn ingest_item_parts_merges_pre_existing_duplicate_day_notes() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Prompts", "{}").unwrap();
        let folder_id = crate::repo::folders::ensure_inbox_folder_id(&mut conn, "ws1").unwrap();
        let title = "클로드 프롬프트 — proj 2026-09-05";
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('dup-old', ?1, ?2, 2026, '2026-09-05T08:00:00.000Z', '2026-09-05T08:00:00.000Z')",
            params![folder_id, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES ('dup-old-s', 'dup-old', '', '- 08:00 from device A', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('dup-new', ?1, ?2, 2026, '2026-09-05T09:00:00.000Z', '2026-09-05T09:00:00.000Z')",
            params![folder_id, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES ('dup-new-s', 'dup-new', '', '- 09:00 from device B', 0)",
            [],
        )
        .unwrap();

        let run = item_with_parts(
            "claude:proj:2026-09-05",
            title,
            vec![part("p1", "- 09:30 from this run", None)],
        );
        assert!(ingest_item(&mut conn, &source, &run).unwrap());

        let alive: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM notes WHERE title = ?1 AND deleted_at IS NULL").unwrap();
            stmt.query_map([title], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(alive, vec!["dup-old".to_string()], "the two pre-existing duplicates must collapse into the older one");
        let body: String = conn.query_row("SELECT body_md FROM sections WHERE id = 'dup-old-s'", [], |r| r.get(0)).unwrap();
        assert_eq!(body, "- 08:00 from device A\n- 09:00 from device B\n- 09:30 from this run");
    }

    /// 드라이런의 새/기수집 카운트가 item.guid가 아니라 part guid 기준으로 나오는지 — parts가
    /// 있는 항목은 item.guid가 절대 클레임되지 않아 item.guid로만 seen을 물으면 항상 false가
    /// 나온다(사실상 카운트 자체가 무의미해진다). 쓰기 0건도 함께 확인.
    #[test]
    fn finish_dry_run_counts_new_and_seen_by_part_guid() {
        let conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Prompts", "{}").unwrap();
        // p1 already seen from a prior real run; p2 is new.
        repo_collect::claim_seen(&conn, &source.id, "p1").unwrap();

        let day_item = item_with_parts(
            "claude:proj:2026-09-04",
            "클로드 프롬프트 — proj 2026-09-04",
            vec![part("p1", "- 09:00 old prompt", None), part("p2", "- 09:10 new prompt", None)],
        );
        let outcome = finish_dry_run(&conn, &source, Some(Ok(vec![day_item]))).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.items.len(), 1, "one row per item, not one per part");
        assert!(!outcome.items[0].seen, "an item with any unseen part must report seen=false");
        assert_eq!(outcome.items[0].preview, "- 09:10 new prompt", "preview must only include the unseen line");

        // Zero-write invariant still holds for the parts path.
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id = ?1", [&source.id], |r| r.get::<_, i64>(0)).unwrap(), 1, "only the pre-seeded claim, dry_run must not add its own");

        // Once every part is seen, the item reports seen=true and an empty preview.
        repo_collect::claim_seen(&conn, &source.id, "p2").unwrap();
        let all_seen_item = item_with_parts(
            "claude:proj:2026-09-04",
            "클로드 프롬프트 — proj 2026-09-04",
            vec![part("p1", "- 09:00 old prompt", None), part("p2", "- 09:10 new prompt", None)],
        );
        let outcome2 = finish_dry_run(&conn, &source, Some(Ok(vec![all_seen_item]))).unwrap();
        assert!(outcome2.items[0].seen);
        assert_eq!(outcome2.items[0].preview, "");
    }

    /// browser_history가 VISIT_LIMIT(500)을 정확히 채운 run은 "History에 더 가져올 방문이
    /// 남아있다"는 뜻이므로 last_status가 "ok"가 아니라 "partial"로 기록돼야 한다
    /// (§backfill continuation) — repo::collect::is_due가 이 상태를 주기와 무관하게 즉시
    /// due로 취급한다.
    #[test]
    fn finish_run_now_marks_browser_history_partial_when_it_hits_the_visit_cap() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "browser_history", "Chrome", "{}").unwrap();
        let capped_parts: Vec<CollectedPart> = (0..browser_history::VISIT_LIMIT as usize)
            .map(|i| part(&format!("p{i}"), &format!("- line {i}"), None))
            .collect();
        let capped_item = item_with_parts("browser:chrome:Default:2026-09-05", "브라우징 기록 — 2026-09-05", capped_parts);

        let outcome = finish_run_now(&mut conn, &source, Some(Ok(vec![capped_item]))).unwrap();
        assert!(outcome.ok);
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("partial"));
    }

    #[test]
    fn finish_run_now_keeps_ok_status_for_browser_history_below_the_visit_cap() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "browser_history", "Chrome", "{}").unwrap();
        let below_cap = item_with_parts(
            "browser:chrome:Default:2026-09-05",
            "브라우징 기록 — 2026-09-05",
            vec![part("p1", "- line", None)],
        );

        let outcome = finish_run_now(&mut conn, &source, Some(Ok(vec![below_cap]))).unwrap();
        assert!(outcome.ok);
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("ok"), "below the cap must stay a plain ok run");
    }

    /// D5(AUDIT-2026-09-26-fallback-observability.md §4): 설정 테이블 자체를 못 읽으면(마이그레이션
    /// 손상 등을 흉내 — 테이블을 직접 지운다) 예전처럼 빈 목록으로 폴백해 전부 통과시키는 대신
    /// (fail-open) 이번 사이클 전체를 건너뛴다 — 아무 것도 클레임되지 않으므로 다음 사이클에
    /// 자연히 재시도된다(fail-closed).
    ///
    /// target_folder_id를 미리 만든 폴더로 명시해 두는 이유: `resolve_target_folder_id`가 그러면
    /// `ensure_inbox_folder_id`(그 자체도 settings를 읽는다 — inbox 위치를 settings 키에 영속하는
    /// 무관한 기존 동작)를 아예 안 거치고 지나가므로, settings 테이블을 지웠을 때 이 테스트가
    /// 실제로 겨냥하는 지점(`urlfilter::read_excluded_domains`)에서만 실패가 나게 격리된다.
    #[test]
    fn browser_history_ingest_skips_the_cycle_without_claiming_when_excluded_domains_are_unreadable() {
        let mut conn = test_conn();
        let folder = crate::repo::folders::ensure_inbox_folder_id(&mut conn, "ws1").unwrap();
        let source = repo_collect::create_with_options(
            &conn,
            repo_collect::CreateCollectSourceParams {
                workspace_id: "ws1",
                kind: "browser_history",
                name: "Chrome",
                config: "{}",
                dry_run: false,
                target_folder_id: Some(&folder),
                post_process: "none",
                post_process_model: None,
                interval_minutes: None,
                show_in_briefing: true,
            },
        )
        .unwrap();
        conn.execute("DROP TABLE settings", []).unwrap();

        let day_item = item_with_parts(
            "browser:chrome:Default:2026-09-05",
            "브라우징 기록 — 2026-09-05",
            vec![part("v1", "- 09:00 something", None)],
        );
        let wrote = ingest_item(&mut conn, &source, &day_item).unwrap();
        assert!(!wrote, "settings read 실패는 이번 사이클을 건너뛴다");
        assert!(
            !repo_collect::is_seen(&conn, &source.id, "v1").unwrap(),
            "클레임되지 않아야 다음 사이클에 자연히 재시도된다"
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "노트도 쓰이지 않는다");
    }

    /// 다른 kind는 우연히 part 수가 VISIT_LIMIT과 같아도 "partial"로 잘못 표시되지 않는다 —
    /// kind == "browser_history" 검사가 총 part 수 비교보다 먼저다.
    #[test]
    fn finish_run_now_never_marks_partial_for_a_non_browser_history_kind() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "claude_prompts", "Prompts", "{}").unwrap();
        let coincidentally_capped: Vec<CollectedPart> =
            (0..browser_history::VISIT_LIMIT as usize).map(|i| part(&format!("p{i}"), &format!("- line {i}"), None)).collect();
        let item = item_with_parts("claude:proj:2026-09-05", "클로드 프롬프트 — proj 2026-09-05", coincidentally_capped);

        let outcome = finish_run_now(&mut conn, &source, Some(Ok(vec![item]))).unwrap();
        assert!(outcome.ok);
        let after = repo_collect::get(&conn, &source.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("ok"));
    }

    /// added>0인 run마다 activity_log에 KIND_COLLECT 행이 정확히 하나 남는다(줄 단위 아님) —
    /// docs/PLAN-2026-09-04-local-import §2.1.
    #[test]
    fn finish_run_now_records_one_activity_row_when_items_were_added() {
        let mut conn = test_conn();
        let source = repo_collect::create(&conn, "ws1", "rss", "My Feed", "{}").unwrap();
        let result = Some(Ok(vec![item("g1", "A", "Body A"), item("g2", "B", "Body B")]));

        let outcome = finish_run_now(&mut conn, &source, result).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.added, 2);

        let rows = activity::list(&conn, "ws1", Some(50)).unwrap();
        let collect_rows: Vec<_> = rows.iter().filter(|r| r.kind == activity::KIND_COLLECT).collect();
        assert_eq!(collect_rows.len(), 1, "exactly one row per run, not per item");
        assert_eq!(collect_rows[0].summary, "My Feed 2건");
        assert_eq!(collect_rows[0].note_id, None);

        // A run that adds nothing must not append a row.
        let noop = finish_run_now(&mut conn, &source, Some(Ok(vec![item("g1", "A", "Body A")]))).unwrap();
        assert_eq!(noop.added, 0);
        let rows_after = activity::list(&conn, "ws1", Some(50)).unwrap();
        assert_eq!(
            rows_after.iter().filter(|r| r.kind == activity::KIND_COLLECT).count(),
            1,
            "a no-op run must not add a second activity row"
        );
    }
}
