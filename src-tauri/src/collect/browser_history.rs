// crate::collect::browser_history — kind='browser_history' 수동 가져오기(PLAN-2026-09-04-
// local-import §2.3). Chrome/Edge 의 History sqlite 를 직접 읽어 사용자가 던진 "최근 브라우저
// 사용내역 가져오기" 요청을 채운다 — 익스텐션 없이 동작한다.
//
// 출력은 익스텐션 방문 기록(sync_server::ingest)과 **완전히 같은 모양**이다: 같은 제목 접두사
// (urlfilter::VISIT_NOTE_TITLE_PREFIX)로 같은 날짜 노트에 합쳐지고, 같은 줄 형식
// "- HH:MM [제목](url) · N분"을 쓴다. 검색결과 제외 정규식도 urlfilter 를 공유한다 — 둘 다
// "사람이 실제로 읽은 페이지"를 남기려는 같은 의도다.
//
// Windows 전용: `%LOCALAPPDATA%/.../User Data/<profile>/History` 레이아웃도, 실행 중 Chrome이
// 파일을 잠그는 것도(그래서 임시 복사본을 읽는다) 다 이 OS 특유다.

use super::config::{self as source_config, BrowserHistoryConfig, SourceConfig};
use super::urlfilter::{self, VISIT_NOTE_TITLE_PREFIX};
use super::{CollectCtx, CollectedItem, CollectedPart};
use crate::error::{db as dberr, io as ioerr, AppError, AppResult};
use chrono::TimeZone;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 한 run 이 훑는 visit 행 상한 — 초과분은 seen 처리되지 않으므로(collect_seen 은 이 함수 밖
/// ingest 단계 소관) 다음 run 이 자연히 이어받는다. ponytail: 캡을 넘기면 이월, 별도 페이지네이션
/// 없음.
///
/// 쿼리는 `visit_time DESC LIMIT`로 **가장 최근** 500건을 고른다(오래된 쪽이 아니라) — 사용자는
/// 최신 며칠을 먼저 보고 싶어하고, 이월된 과거 방문은 seen이 아니므로 다음 run에서 자연히
/// 채워진다. 잘라낸 결과는 다시 visit_time 오름차순으로 정렬해 노트 줄 순서가 시간순을
/// 유지하게 한다(2026-09-05: 이전엔 ASC LIMIT라 500건 초과 시 최신 날짜가 통째로 잘려나갔다 —
/// 실기 스모크테스트에서 08-29~09-03만 채워지고 09-04/09-05가 첫 run에서 빠지는 결함으로 발견).
pub(crate) const VISIT_LIMIT: i64 = 500;

/// Chrome/WebKit epoch(1601-01-01 UTC)와 Unix epoch(1970-01-01 UTC) 사이의 초 차이.
const CHROME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;

/// detect.rs가 크롬/엣지 프로필의 최근 방문 통계를 미리보기로 계산할 때도 같은 시각 변환을
/// 쓴다(pub(crate), PLAN-2026-09-04-local-import §W7).
pub(crate) fn chrome_time_from_unix_seconds(unix_seconds: i64) -> i64 {
    (unix_seconds + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000
}

pub(crate) fn unix_seconds_from_chrome_time(chrome_us: i64) -> i64 {
    chrome_us / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS
}

/// `browser` → `LOCALAPPDATA` 아래 벤더 하위경로. 순수 함수라 env var 없이 단위테스트 가능
/// (user_data_dir이 이 값에 LOCALAPPDATA를 붙인다). Vivaldi는 다른 셋과 달리 앱 이름 서브폴더가
/// 없다 — 실제 설치 경로가 `Vivaldi\User Data`(벤더=앱)라 통짜로 하나만 붙인다.
fn browser_user_data_subpath(browser: &str) -> PathBuf {
    match browser {
        "edge" => Path::new("Microsoft").join("Edge"),
        "brave" => Path::new("BraveSoftware").join("Brave-Browser"),
        "vivaldi" => PathBuf::from("Vivaldi"),
        "whale" => Path::new("Naver").join("Naver Whale"),
        _ => Path::new("Google").join("Chrome"),
    }
}

/// `<vendor>/<app>/User Data` — 프로필 하위 디렉터리들의 부모. detect.rs가 이 아래를 훑어
/// 프로필 목록(및 `Local State`의 표시 이름)을 찾는다(pub(crate), §W7).
#[cfg(windows)]
pub(crate) fn user_data_dir(browser: &str) -> AppResult<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| AppError::Validation("LOCALAPPDATA is not set".to_string()))?;
    Ok(Path::new(&local_app_data).join(browser_user_data_subpath(browser)).join("User Data"))
}

#[cfg(windows)]
pub(crate) fn history_path(browser: &str, profile: &str) -> AppResult<PathBuf> {
    Ok(user_data_dir(browser)?.join(profile).join("History"))
}

#[cfg(windows)]
pub fn collect(config: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match source_config::parse("browser_history", config)? {
        SourceConfig::BrowserHistory(cfg) => cfg,
        _ => unreachable!("kind parser returned the wrong config"),
    };
    let path = history_path(&cfg.browser, &cfg.profile)?;
    collect_from_path(&path, &cfg, ctx)
}

#[cfg(not(windows))]
pub fn collect(_config: &str, _ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    Err(AppError::Validation(
        "browser history import is Windows-only".to_string(),
    ))
}

/// 복사본이 스코프를 벗어나면(정상 반환이든 `?`로 인한 조기 반환이든) 항상 삭제한다 — Chrome이
/// 실행 중이라 원본 History 는 못 건드리고 읽기 전용으로 뜬 복사본만 남긴다.
pub(crate) struct TempCopyGuard(PathBuf);
impl Drop for TempCopyGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// History sqlite를 `data_dir/tmp/`로 복사한 뒤 읽기 전용으로 연다 — collect_from_path와
/// detect.rs(프로필 미리보기 통계)가 공유하는 진입점(pub(crate), §W7). 반환된 가드가 스코프를
/// 벗어나면 복사본이 삭제된다.
/// 복사본 + 읽기 전용 커넥션. **필드 순서가 곧 drop 순서다** — `conn` 이 먼저 닫히고 그다음 가드가
/// 파일을 지운다. 튜플 `(conn, guard)` 로 돌려주던 시절엔 지역 변수가 역순으로 drop 돼 가드가 열린
/// 파일을 지우려다 Windows 에서 조용히 실패, `data_dir/tmp` 에 복사본이 쌓였다(2026-09-05 실기 스모크).
pub(crate) struct TempHistory {
    pub(crate) conn: rusqlite::Connection,
    _guard: TempCopyGuard,
}

pub(crate) fn open_temp_readonly_copy(source_path: &Path, data_dir: &Path) -> AppResult<TempHistory> {
    if !source_path.exists() {
        return Err(AppError::NotFound(format!(
            "browser history database not found: {}",
            source_path.display()
        )));
    }
    let tmp_dir = data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(ioerr)?;
    let tmp_path = tmp_dir.join(format!("history-{}.db", uuid::Uuid::new_v4()));
    std::fs::copy(source_path, &tmp_path).map_err(ioerr)?;
    let guard = TempCopyGuard(tmp_path.clone());
    let conn = rusqlite::Connection::open_with_flags(&tmp_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(dberr)?;
    // (아래 Ok 가 struct 를 조립한다)
    Ok(TempHistory { conn, _guard: guard })
}

/// 부팅 시 1회(`collect::start`) — 강제 종료로 정리되지 못한 `data_dir/tmp/history-*.db` 임시
/// 복사본을 지운다. `TempCopyGuard`의 Drop은 정상 종료 경로에서만 실행되므로, 앱이 History 복사본을
/// 읽는 도중 강제 종료되면 그 파일이 `tmp/`에 영구히 남는다(2026-09-05 실기 스모크에서도 관측된
/// 종류의 잔여물). `tmp/`가 아예 없으면(한 번도 브라우저 기록을 읽은 적 없음) 조용히 지나간다.
pub(crate) fn cleanup_stale_temp_copies(data_dir: &Path) {
    let tmp_dir = data_dir.join("tmp");
    let Ok(entries) = std::fs::read_dir(&tmp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("history-") && name.ends_with(".db") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 임시 복사본의 sqlite 헤더가 손상됐다고 볼 수 있는 에러인가 — Chrome이 쓰는 도중 복사됐거나
/// 디스크 오류로 헤더가 깨진 경우 한 번 더 복사하면 회복될 수 있다(파일이 아예 없거나 권한
/// 문제인 다른 에러는 재시도해도 소용없으니 그대로 표면화한다).
fn is_corrupt_copy_error(err: &AppError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("malformed") || msg.contains("not a database")
}

/// `attempt`를 손상 판정 에러에 한해 최대 두 번(원 시도 + 재시도 1회) 실행한다. 매 호출이 새
/// `open_temp_readonly_copy`(새 복사본)를 만드는 클로저라는 전제에서 "재시도 = 재복사"가 성립한다.
/// 순수 함수로 뽑아 두어 테스트가 실제 History 파일 없이도 재시도 횟수(정확히 2회, 그 이상은
/// 포기)를 검증한다.
fn with_corrupt_copy_retry<T>(mut attempt: impl FnMut() -> AppResult<T>) -> AppResult<T> {
    match attempt() {
        Ok(v) => Ok(v),
        Err(e) if is_corrupt_copy_error(&e) => attempt(),
        Err(e) => Err(e),
    }
}

/// 실제 fetch — `collect()`가 OS별 경로를 정한 뒤 호출한다. 테스트는 합성 History sqlite를
/// 만들어 이 함수를 직접 호출해 OS 게이트를 우회한다.
fn collect_from_path(source_path: &Path, cfg: &BrowserHistoryConfig, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let now = chrono::Utc::now();
    let backfill_floor = now - chrono::Duration::days(cfg.backfill_days);
    let since_floor = ctx
        .since
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc) - chrono::Duration::days(1));
    let lower_bound = match since_floor {
        Some(since_floor) => since_floor.max(backfill_floor),
        None => backfill_floor,
    };
    let lower_bound_chrome = chrome_time_from_unix_seconds(lower_bound.timestamp());
    let min_duration_us = cfg.min_seconds * 1_000_000;

    // 손상된 복사본(가비지/부분 쓰기)이면 한 번 재복사해 재시도한다 — 재복사 자체가 이 클로저를
    // 다시 부르는 것과 같다(매 시도가 새 open_temp_readonly_copy).
    let mut rows: Vec<(i64, String, String, i64, i64)> = with_corrupt_copy_retry(|| {
        let temp = open_temp_readonly_copy(source_path, &ctx.data_dir)?;
        let conn = &temp.conn;
        let mut stmt = conn
            .prepare(
                "SELECT v.id, u.url, u.title, v.visit_time, v.visit_duration
                 FROM visits v JOIN urls u ON u.id = v.url
                 WHERE u.hidden = 0 AND v.visit_duration >= ?1 AND v.visit_time > ?2
                 ORDER BY v.visit_time DESC LIMIT ?3",
            )
            .map_err(dberr)?;
        let rows = stmt
            .query_map(rusqlite::params![min_duration_us, lower_bound_chrome, VISIT_LIMIT], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(dberr)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr)?;
        drop(stmt);
        drop(temp); // 파일 조회는 끝났다 — conn 이 닫힌 뒤 TempCopyGuard 가 복사본을 지운다(필드 순서).
        Ok(rows)
    })?;

    // 쿼리는 최신순(DESC)으로 캡을 걸었으니, 노트 줄 순서를 시간순으로 되돌리려면 다시
    // visit_time 오름차순으로 정렬한다 — date -> (parts, lines) 순서가 곧 이 정렬을 따른다.
    rows.sort_by_key(|(_, _, _, visit_time, _)| *visit_time);
    let mut parts_by_date: BTreeMap<String, Vec<CollectedPart>> = BTreeMap::new();
    let mut lines_by_date: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (visit_id, url, title, visit_time, visit_duration) in rows {
        if urlfilter::is_search_result(&url) {
            continue;
        }
        let Ok(parsed) = reqwest::Url::parse(&url) else { continue };
        if !matches!(parsed.scheme(), "http" | "https") {
            continue;
        }
        let unix_seconds = unix_seconds_from_chrome_time(visit_time);
        let Some(local_dt) = chrono::Local.timestamp_opt(unix_seconds, 0).single() else { continue };
        let date = local_dt.format("%Y-%m-%d").to_string();
        let secs = visit_duration / 1_000_000;
        // 노트에 영구 저장되기 전에 자격증명 성격 쿼리 파라미터를 없앤다 — 호스트/스킴 판정은
        // 이미 원본 url로 끝났으므로 여기서 스크러빙해도 위 필터에 영향을 주지 않는다.
        let url = urlfilter::scrub_url(&url);
        let line = format!(
            "- {} [{}]({url}) · {}",
            local_dt.format("%H:%M"),
            urlfilter::link_label(&title, &url),
            urlfilter::humanize_seconds(secs)
        );
        parts_by_date.entry(date.clone()).or_default().push(CollectedPart {
            guid: format!("visit:{}:{}:{visit_id}", cfg.browser, cfg.profile),
            line: line.clone(),
            dedupe_needle: Some(format!("({url})")),
        });
        lines_by_date.entry(date).or_default().push(line);
    }

    Ok(parts_by_date
        .into_iter()
        .map(|(date, parts)| {
            let body_md = lines_by_date.remove(&date).unwrap_or_default().join("\n");
            CollectedItem {
                guid: format!("browser:{}:{}:{date}", cfg.browser, cfg.profile),
                title: format!("{VISIT_NOTE_TITLE_PREFIX}{date}"),
                body_md,
                source_url: None,
                published_at: None,
                parts,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(rt: &tokio::runtime::Runtime, data_dir: PathBuf, since: Option<String>) -> CollectCtx<'_> {
        CollectCtx { rt, data_dir, since }
    }

    fn cfg(min_seconds: i64, backfill_days: i64) -> BrowserHistoryConfig {
        BrowserHistoryConfig { browser: "chrome".to_string(), profile: "Default".to_string(), min_seconds, backfill_days, prompt: None }
    }

    /// urls/visits 두 테이블만 있는 합성 History sqlite. `urls`: (id, url, title, hidden).
    /// `visits`: (id, url_id, visit_time_chrome, visit_duration_us).
    fn build_history_db(dir: &Path, urls: &[(i64, &str, &str, i64)], visits: &[(i64, i64, i64, i64)]) -> PathBuf {
        let path = dir.join("History");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
             CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, visit_duration INTEGER);",
        )
        .unwrap();
        for (id, url, title, hidden) in urls {
            conn.execute(
                "INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?1,?2,?3,0,0,0,?4)",
                rusqlite::params![id, url, title, hidden],
            )
            .unwrap();
        }
        for (id, url_id, visit_time, visit_duration) in visits {
            conn.execute(
                "INSERT INTO visits (id, url, visit_time, visit_duration) VALUES (?1,?2,?3,?4)",
                rusqlite::params![id, url_id, visit_time, visit_duration],
            )
            .unwrap();
        }
        path
    }

    /// 로컬 타임존 기준 (y,m,d,hh,mm) 을 크롬 시각(µs)으로. 테스트가 기대하는 날짜/시각 문자열도
    /// 같은 로컬 변환으로 함께 돌려줘 테스트 머신 타임존과 무관하게 일치를 보장한다.
    fn local_chrome_time(y: i32, m: u32, d: u32, hh: u32, mm: u32) -> (i64, String, String) {
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(hh, mm, 0).unwrap();
        let local_dt = chrono::Local.from_local_datetime(&naive).unwrap();
        let chrome = chrome_time_from_unix_seconds(local_dt.timestamp());
        (chrome, local_dt.format("%Y-%m-%d").to_string(), local_dt.format("%H:%M").to_string())
    }

    /// 어제(로컬) hh:mm — 기본 backfill_days=7 안에 항상 들어오는 안전한 최근 시각.
    fn yesterday_chrome_time(hh: u32, mm: u32) -> (i64, String, String) {
        let d = chrono::Local::now().date_naive() - chrono::Duration::days(1);
        local_chrome_time(d.year(), d.month(), d.day(), hh, mm)
    }

    use chrono::Datelike;

    #[test]
    fn converts_chrome_time_to_the_correct_local_date_and_hh_mm() {
        let dir = tempfile::tempdir().unwrap();
        let (chrome_time, date, hh_mm) = yesterday_chrome_time(9, 15);
        build_history_db(
            dir.path(),
            &[(1, "https://example.com/a", "Example Page", 0)],
            &[(1, 1, chrome_time, 120 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].guid, format!("browser:chrome:Default:{date}"));
        assert_eq!(items[0].title, format!("브라우징 기록 — {date}"));
        assert!(items[0].body_md.contains(&format!("- {hh_mm} [Example Page](https://example.com/a) · 2분")));
    }

    #[test]
    fn filters_visits_shorter_than_min_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        let (t2, ..) = yesterday_chrome_time(9, 5);
        build_history_db(
            dir.path(),
            &[(1, "https://example.com/short", "Short", 0), (2, "https://example.com/long", "Long", 0)],
            &[(1, 1, t1, 5 * 1_000_000), (2, 2, t2, 60 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert_eq!(items.len(), 1);
        assert!(!items[0].body_md.contains("short"));
        assert!(items[0].body_md.contains("long"));
    }

    #[test]
    fn only_visits_within_the_backfill_window_are_returned() {
        // Unix-time offsets from "now" rather than local calendar dates: with backfill_days=1 the
        // window is exactly the last 24h, and "yesterday 9am" straddles that boundary depending on
        // what time of day the test happens to run (found flaky — see git history). Offsetting
        // directly from `Utc::now()` keeps "recent"/"old" unambiguously inside/outside regardless
        // of wall-clock time.
        let dir = tempfile::tempdir().unwrap();
        let recent = chrome_time_from_unix_seconds((chrono::Utc::now() - chrono::Duration::hours(2)).timestamp());
        let old = chrome_time_from_unix_seconds((chrono::Utc::now() - chrono::Duration::days(10)).timestamp());
        build_history_db(
            dir.path(),
            &[(1, "https://example.com/recent", "Recent", 0), (2, "https://example.com/old", "Old", 0)],
            &[(1, 1, recent, 60 * 1_000_000), (2, 2, old, 60 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // backfill_days=1 (24h window): "old" (10 days ago) must fall outside it, "recent" (2h ago)
        // inside it.
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 1), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        let all_lines: String = items.iter().map(|i| i.body_md.as_str()).collect::<Vec<_>>().join("\n");
        assert!(all_lines.contains("recent"));
        assert!(!all_lines.contains("old"), "a visit older than the backfill window must be excluded");
    }

    #[test]
    fn search_result_and_non_http_urls_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        let (t2, ..) = yesterday_chrome_time(9, 5);
        let (t3, ..) = yesterday_chrome_time(9, 10);
        build_history_db(
            dir.path(),
            &[
                (1, "https://www.google.com/search?q=cats", "Google Search", 0),
                (2, "chrome://settings", "Settings", 0),
                (3, "https://example.com/real-article", "Real Article", 0),
            ],
            &[(1, 1, t1, 60 * 1_000_000), (2, 2, t2, 60 * 1_000_000), (3, 3, t3, 60 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts.len(), 1, "only the real article visit must survive");
        assert!(items[0].body_md.contains("Real Article"));
    }

    #[test]
    fn hidden_urls_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        build_history_db(
            dir.path(),
            &[(1, "https://example.com/hidden", "Hidden", 1)],
            &[(1, 1, t1, 60 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert!(items.is_empty(), "hidden=1 urls must never surface");
    }

    #[test]
    fn part_guid_and_dedupe_needle_follow_the_shared_visit_line_contract() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        build_history_db(dir.path(), &[(1, "https://example.com/a", "A", 0)], &[(42, 1, t1, 60 * 1_000_000)]);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts.len(), 1);
        let part = &items[0].parts[0];
        assert_eq!(part.guid, "visit:chrome:Default:42");
        assert_eq!(part.dedupe_needle.as_deref(), Some("(https://example.com/a)"));
    }

    #[test]
    fn caps_at_500_visits_per_run_keeping_the_newest() {
        // §fix 2026-09-05: the cap must drop the OLDEST visits, not the newest — a real-data smoke
        // test showed the opposite (ASC LIMIT) silently dropping the most recent days' visits on
        // the first run. `page0` is the oldest (visit_time = t+0) and must be the one excluded;
        // `page1..page500` (the newest 500) must all survive.
        let dir = tempfile::tempdir().unwrap();
        let d = chrono::Local::now().date_naive() - chrono::Duration::days(1);
        let mut urls = Vec::new();
        let mut visits = Vec::new();
        let mut url_strs = Vec::new();
        for i in 0..501i64 {
            url_strs.push(format!("https://example.com/page{i}"));
        }
        for (i, u) in url_strs.iter().enumerate() {
            urls.push((i as i64 + 1, u.as_str(), "Page", 0));
            let (t, ..) = local_chrome_time(d.year(), d.month(), d.day(), 0, 0);
            visits.push((i as i64 + 1, i as i64 + 1, t + i as i64, 60 * 1_000_000));
        }
        build_history_db(dir.path(), &urls, &visits);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        let total_parts: usize = items.iter().map(|i| i.parts.len()).sum();
        assert_eq!(total_parts, 500, "run must cap at VISIT_LIMIT, leaving the rest for the next run");
        let all_lines: String = items.iter().map(|i| i.body_md.as_str()).collect::<Vec<_>>().join("\n");
        assert!(!all_lines.contains("page0)"), "the oldest visit must be the one dropped by the cap");
        assert!(all_lines.contains("page1)"), "the newest 500 visits (page1..page500) must all survive");
        assert!(all_lines.contains("page500)"), "the newest visit must survive");
    }

    #[test]
    fn the_temporary_copy_is_removed_after_a_run() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        build_history_db(dir.path(), &[(1, "https://example.com/a", "A", 0)], &[(1, 1, t1, 60 * 1_000_000)]);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        let tmp_dir = dir.path().join("tmp");
        let leftover: Vec<_> = std::fs::read_dir(&tmp_dir).unwrap().collect();
        assert!(leftover.is_empty(), "the temp History copy must be deleted after the run, found: {leftover:?}");
    }

    #[test]
    fn missing_history_file_is_a_not_found_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope").join("History");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = collect_from_path(&missing, &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap_err();
        assert!(matches!(err, AppError::NotFound(msg) if msg.contains(&missing.display().to_string())));
    }

    #[test]
    fn sensitive_query_params_are_scrubbed_from_the_line_and_dedupe_needle() {
        let dir = tempfile::tempdir().unwrap();
        let (t1, ..) = yesterday_chrome_time(9, 0);
        build_history_db(
            dir.path(),
            &[(1, "https://example.com/a?token=secret123&q=cats", "A", 0)],
            &[(1, 1, t1, 60 * 1_000_000)],
        );
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let items = collect_from_path(&dir.path().join("History"), &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None)).unwrap();

        assert_eq!(items.len(), 1);
        assert!(!items[0].body_md.contains("token=secret123"), "the token query param must not reach the note");
        assert!(items[0].body_md.contains("q=cats"), "a non-sensitive query param must survive");
        assert_eq!(items[0].parts[0].dedupe_needle.as_deref(), Some("(https://example.com/a?q=cats)"));
    }

    #[test]
    fn user_data_subpath_maps_each_supported_browser() {
        assert_eq!(browser_user_data_subpath("chrome"), Path::new("Google").join("Chrome"));
        assert_eq!(browser_user_data_subpath("edge"), Path::new("Microsoft").join("Edge"));
        assert_eq!(browser_user_data_subpath("brave"), Path::new("BraveSoftware").join("Brave-Browser"));
        assert_eq!(browser_user_data_subpath("vivaldi"), PathBuf::from("Vivaldi"));
        assert_eq!(browser_user_data_subpath("whale"), Path::new("Naver").join("Naver Whale"));
    }

    #[test]
    fn cleanup_stale_temp_copies_removes_leftover_history_copies_but_not_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_dir = dir.path().join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        std::fs::write(tmp_dir.join("history-abc123.db"), b"stale").unwrap();
        std::fs::write(tmp_dir.join("keep-me.txt"), b"unrelated").unwrap();

        cleanup_stale_temp_copies(dir.path());

        assert!(!tmp_dir.join("history-abc123.db").exists(), "a leftover history-*.db copy must be deleted");
        assert!(tmp_dir.join("keep-me.txt").exists(), "unrelated files must be left alone");
    }

    #[test]
    fn cleanup_stale_temp_copies_is_a_noop_when_the_tmp_dir_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        cleanup_stale_temp_copies(dir.path()); // must not panic
    }

    #[test]
    fn with_corrupt_copy_retry_retries_once_on_a_corrupt_copy_error_then_gives_up() {
        let calls = std::cell::Cell::new(0);
        let result: AppResult<()> = with_corrupt_copy_retry(|| {
            calls.set(calls.get() + 1);
            Err(AppError::Db("database disk image is malformed".to_string()))
        });
        assert!(result.is_err());
        assert_eq!(calls.get(), 2, "must attempt exactly twice: the original attempt plus one retry");
    }

    #[test]
    fn with_corrupt_copy_retry_does_not_retry_other_kinds_of_errors() {
        let calls = std::cell::Cell::new(0);
        let result: AppResult<()> = with_corrupt_copy_retry(|| {
            calls.set(calls.get() + 1);
            Err(AppError::NotFound("nope".to_string()))
        });
        assert!(result.is_err());
        assert_eq!(calls.get(), 1, "non-corruption errors must not be retried");
    }

    /// 진짜 가비지 파일(sqlite 헤더가 아예 아님)로 collect_from_path 를 끝까지 돌려도 결국 에러로
    /// 표면화되는지 — 정확한 재시도 횟수는 위 with_corrupt_copy_retry 단위테스트가 결정론적으로
    /// 검증하므로, 여기서는 (다른 테스트와 병렬 실행되는) OPEN_TEMP_COPY_ATTEMPTS 전역 카운터에
    /// 의존하지 않고 종단 동작(끝내 실패)만 확인한다.
    #[test]
    fn a_garbage_history_file_never_becomes_valid_and_ends_in_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("History");
        std::fs::write(&path, b"this is not a sqlite database, just garbage bytes").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        let result = collect_from_path(&path, &cfg(15, 7), &ctx(&rt, dir.path().to_path_buf(), None));
        assert!(result.is_err(), "a file that never becomes a valid sqlite db must end in an error");
    }
}
