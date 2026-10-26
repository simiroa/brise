// repo: schedule — 일정·알림 (docs/PLAN-schedule-system.md §4·§5).
//
// W5-2 가 순수 파서/전개(rrule.rs)를 놓았고, W5-3 인 이 파일이 그 위에 판정·틱·발화를 얹는다:
//   · fire_at 계산(§5.2) — 회차 날짜 + 시각 − 오프셋, 로컬 벽시계 분 해상도
//   · due_in_window(§5.4 워터마크 창) / due_today(§7.4 헤더 벨)
//   · 분 단위 틱 스레드(§4.3) — embedding::start / collect::start 와 같은 모양의 세 번째 반복
//
// 시각 계산은 전부 **로컬 자정 기준 분 정수**로 한다. 문자열("YYYY-MM-DDTHH:MM")은 경계 계약
// (워터마크 설정 값, DueReminder.fire_at)에서만 쓰고 내부 비교는 정수로 한다 — 고정폭 문자열의
// 사전식 비교와 결과가 같지만, 파싱을 한 번만 하고 오프셋 뺄셈이 날짜 경계를 넘는 경우
// (1일 전 알림 → 전날)를 산술로 자연히 다룬다.
//
// 날짜 산술은 repo::dashboard::dateord 의 프로렙틱 오디널 그대로다 — 새 날짜 타입을 만들지
// 않는다(§3.4).
pub mod rrule;

use crate::error::{db as dberr, AppResult};
use crate::repo::dashboard::dateord::{days_in_month, ord_to_ymd, NaiveYmd};
use rusqlite::Connection;
use serde::Serialize;

/// 하루의 분. 오디널×MINS_PER_DAY + 자정 이후 분 = 이 모듈의 시간 좌표계.
const MINS_PER_DAY: i64 = 1440;

/// 틱 간격 — embedding::start(embedding/worker.rs) / collect::start(collect/mod.rs)와 같은 60초.
/// 분 경계에 정렬하지 않는다(§4.3): (after, now] 창 방식이라 sleep 드리프트가 발화를 놓치지 않고,
/// 정렬 코드는 순수 낭비다.
const TICK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// 앱이 꺼져 있던 동안을 소급 발화하는 상한(§5.4) — 사흘 만에 켜도 사흘치 토스트가 쏟아지지 않는다.
pub const CATCHUP_MAX_MIN: i64 = 60;

/// 앱 전체 마스터 스위치(기본 OFF). 꺼져 있으면 틱은 아무것도 쏘지 않고 **워터마크만 전진**한다.
pub const NOTIFICATIONS_ENABLED_KEY: &str = "notifications_enabled";
/// 종일 노트의 기준 시각("HH:MM", 기본 "00:00").
pub const ALL_DAY_AT_KEY: &str = "reminder_all_day_at";
/// 워터마크(기기-로컬, "YYYY-MM-DDTHH:MM"). 부재 = 첫 실행 → 과거를 소급 발화하지 않는다.
pub const LAST_TICK_KEY: &str = "reminder_last_tick_at";

const DEFAULT_ALL_DAY_AT: &str = "00:00";

/// "지남"(기존 칸반 핀 판정) / "도래"(신규 일정 알림). 두 판정은 다르고 섞으면 칸반 핀이 미래
/// 일정에도 붙는다(§1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderKind {
    Overdue,
    Due,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DueReminder {
    pub note_id: String,
    pub title: String,
    pub kind: ReminderKind,
    /// `Due` 일 때만 `Some` — 로컬 발화 시각 "YYYY-MM-DDTHH:MM"(초 없음, 분 해상도).
    pub fire_at: Option<String>,
    /// D3 철회(2026-09-07): 관련 날짜(note_dates)에서 온 알림이면 그 행 id, 노트 자신의 일정에서
    /// 온 것이면 `None`. 벨의 "완료"가 무엇을 끄는지 가른다 — 관련 날짜는
    /// note_date_set_remind(false), 노트는 상태 done(specs/commands/dashboard.yaml DueReminder).
    pub related_date_id: Option<String>,
}

// ── 시각 문자열 ↔ 분 좌표 ────────────────────────────────────────────────────

/// "HH:MM" → 자정 이후 분. DB CHECK(GLOB)는 자릿수 모양까지만 거르므로("24:00" 통과) 시/분 범위의
/// 실제 관문은 여기다. repo::notes::dates::validate_schedule_fields 와 settings_schema 의 `reminder_all_day_at` arm 이
/// 둘 다 이 함수 하나를 지난다 — 파서를 두 벌 두지 않는다.
pub fn parse_hhmm_min(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let h: i64 = s[0..2].parse().ok()?;
    let m: i64 = s[3..5].parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// "YYYY-MM-DDTHH:MM"(로컬 벽시계) → 분 좌표. 형식이 깨졌거나 실재하지 않는 날짜면 `None`
/// (백업 복원으로 흘러든 쓰레기 워터마크가 틱을 죽이지 않게 — 호출자는 "없음"으로 취급한다).
pub fn parse_stamp(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    let hm = parse_hhmm_min(&s[11..16])?;
    Some(NaiveYmd { y, m, d }.to_ord() * MINS_PER_DAY + hm)
}

/// 분 좌표 → "YYYY-MM-DDTHH:MM". `parse_stamp` 의 역함수.
pub fn format_stamp(total: i64) -> String {
    let ymd = ord_to_ymd(total.div_euclid(MINS_PER_DAY));
    let m = total.rem_euclid(MINS_PER_DAY);
    format!("{}T{:02}:{:02}", ymd.to_iso(), m / 60, m % 60)
}

/// 지금(로컬 벽시계, 분 해상도). 저장은 UTC(`now_iso`)지만 **비교는 로컬 벽시계**다 — 사용자가
/// 09:00 이라 적은 것은 로컬 09:00 이고, util::today_ymd_local 이 로컬을 쓰는 이유와 같다(§5.2).
pub fn now_local_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string()
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

/// 알림 후보 한 행. SQL 이 돌려주는 원시 컬럼을 판정이 쓰는 모양으로만 좁혀 담는다.
#[derive(Debug, Clone)]
struct ScheduleRow {
    id: String,
    title: String,
    /// 시작 트리플(풀 정밀도일 때만) — 발화의 유일한 기준일(§1.3). 반복의 seed 이기도 하다.
    start: Option<NaiveYmd>,
    start_time_min: Option<i64>,
    offset_min: i64,
    rrule: Option<String>,
    /// note_dates 행 중 position 0(대표)이면 `None`, 그 외 행이면 그 행 id.
    related_date_id: Option<String>,
}

fn full(y: Option<i64>, m: Option<i64>, d: Option<i64>) -> Option<NaiveYmd> {
    match (y, m, d) {
        (Some(y), Some(m), Some(d)) if (1..=12).contains(&m) && d >= 1 && d as u32 <= days_in_month(y, m as u32) => {
            Some(NaiveYmd { y, m: m as u32, d: d as u32 })
        }
        _ => None,
    }
}

/// 알림 후보 SQL — PLAN-2026-09-08-dates-rebuild.md W2(§1.3/①): W1 이후 모든 날짜가 `note_dates`
/// 행이므로(position 0 = 대표, notes.* 의 투영) 후보 조회는 이 한 질의뿐이다 — 옛
/// `candidates()`(notes 를 읽음) + `related_date_candidates()`(note_dates 를 읽음) 두 함수가 여기
/// 하나로 합쳐졌다. 제외 규칙은 옛 `candidates()` 그대로(아카이브·휴지통 제외,
/// `status='done'` 제외) — 단 remind 게이트는 `notes.remind` 가 아니라 **각 행의
/// `note_dates.remind`** 다(대표 행도 이제 이 컬럼을 갖는다 — project_primary 가 투영).
/// `related_date_id` 는 position 0 이면 `None`, 아니면 그 행 id.
///
/// 완료(status='done', 빌트인 키) 노트는 미래 일정도 알리지 않는다 — 칸반 핀의 done 면제와 같은
/// 판단(2026-08-09 오너 결정). 커스텀 workspace_statuses id 는 done 이 아니다(보드 칼럼 판정과 동일).
/// 앱 마스터(`notifications_enabled`)는 여기가 아니라 **틱 진입부**에서 본다: 조회 함수는 순수하게
/// 두고 마스터 스위치는 발화 경로에서만 판단한다(그래서 헤더 벨은 마스터가 꺼져 있어도 목록을
/// 보여줄 수 있다).
fn candidates(conn: &Connection, workspace_id: &str) -> AppResult<Vec<ScheduleRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT nd.id, nd.position, n.id, n.title,
                    nd.year, nd.month, nd.day, nd.start_time, nd.remind_offset_min, nd.rrule
             FROM note_dates nd
             JOIN notes n ON n.id = nd.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
               AND nd.remind = 1 AND (n.status IS NULL OR n.status <> 'done')",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            let date_id: String = r.get(0)?;
            let position: i64 = r.get(1)?;
            Ok(ScheduleRow {
                id: r.get(2)?,
                title: r.get(3)?,
                start: full(r.get(4)?, r.get(5)?, r.get(6)?),
                start_time_min: r.get::<_, Option<String>>(7)?.as_deref().and_then(parse_hhmm_min),
                offset_min: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                rrule: r.get(9)?,
                related_date_id: if position == 0 { None } else { Some(date_id) },
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

/// 이 노트가 만들어내는 발화 시각(분 좌표)들. `[from, to]` 는 **회차 날짜** 범위이고 반복 노트에만
/// 쓰인다 — 반복이 없으면 회차가 하나뿐이라 호출자의 정확한 창 필터가 그 역할을 대신한다.
///
/// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 발화는 **항상 시작일**이다 — 시각 유무·종료일
/// 존재와 무관하게 날짜가 움직이지 않는다(옛 `anchor`/`anchor_date` 가 하던 "시각 있으면 시작일,
/// 없으면 종료일" 추측은 사라졌다). 기간의 끝에 알림을 받고 싶으면 끝 날짜를 행으로 하나 더
/// 넣는다(§1.3).
///
/// 저장된 rrule 이 파싱되지 않으면 조용히 "반복 없음"이 아니라 **회차 0개**로 취급한다: 원문은
/// 저장 시점에 parse_for_seed 를 통과했으므로 여기서 실패한다는 것은 손상이고, 손상된 규칙을
/// "매일"처럼 취급해 엉뚱한 날 발화하는 쪽이 더 나쁘다.
fn fire_times(row: &ScheduleRow, all_day_min: i64, from: NaiveYmd, to: NaiveYmd) -> Vec<i64> {
    let time_min = row.start_time_min.unwrap_or(all_day_min);
    let dates: Vec<NaiveYmd> = match (&row.rrule, row.start) {
        (Some(r), Some(seed)) => match rrule::parse(r) {
            Ok(parts) => rrule::expand(&parts, seed, from, to).0,
            Err(_) => Vec::new(),
        },
        (Some(_), None) => Vec::new(),
        (None, _) => row.start.into_iter().collect(),
    };
    dates
        .into_iter()
        .map(|d| d.to_ord() * MINS_PER_DAY + time_min - row.offset_min)
        .collect()
}

fn all_day_min(conn: &Connection) -> i64 {
    crate::repo::settings::get_all(conn)
        .ok()
        .and_then(|s| s.get(ALL_DAY_AT_KEY).and_then(|v| v.as_str()).and_then(parse_hhmm_min))
        .unwrap_or_else(|| parse_hhmm_min(DEFAULT_ALL_DAY_AT).unwrap_or(0))
}

/// 회차 전개 상한 — 오프셋이 최대 28일이라 "지금 창"에 걸릴 수 있는 회차는 그만큼 미래까지다.
fn offset_days(offset_min: i64) -> i64 {
    (offset_min + MINS_PER_DAY - 1).div_euclid(MINS_PER_DAY)
}

/// `[lo, hi]`(분 좌표, 양끝 포함) 안에 발화가 떨어지는 Due 들. due_in_window/due_today 가 공유하는
/// 유일한 판정 지점 — 창의 모양만 다르다.
fn due_between(conn: &Connection, workspace_id: &str, lo: i64, hi: i64) -> AppResult<Vec<DueReminder>> {
    let all_day = all_day_min(conn);
    let mut out: Vec<DueReminder> = Vec::new();
    let rows = candidates(conn, workspace_id)?;
    for row in rows {
        // 발화가 [lo, hi] 에 들려면 회차 날짜는 [lo, hi + offset] 사이다. 하한은 lo 의 날짜로
        // 넉넉히 잡고(오프셋은 회차를 **앞으로** 당기므로 회차는 항상 발화 이후), 정확한 컷은
        // 아래 필터가 한다.
        let from = ord_to_ymd(lo.div_euclid(MINS_PER_DAY));
        let to = ord_to_ymd(hi.div_euclid(MINS_PER_DAY) + offset_days(row.offset_min));
        for t in fire_times(&row, all_day, from, to) {
            if t >= lo && t <= hi {
                out.push(DueReminder {
                    note_id: row.id.clone(),
                    title: row.title.clone(),
                    kind: ReminderKind::Due,
                    fire_at: Some(format_stamp(t)),
                    related_date_id: row.related_date_id.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| {
        a.fire_at
            .cmp(&b.fire_at)
            .then_with(|| a.note_id.cmp(&b.note_id))
            .then_with(|| a.related_date_id.cmp(&b.related_date_id))
    });
    Ok(out)
}

/// 틱 전용 — `(after, now]` **반개구간**에 fire_at 이 들어오는 Due 만(§5.4). 창이 단조 전진하는 한
/// 같은 fire_at 이 두 번 통과할 수 없다 = 발화 기록 테이블 없이 중복이 막힌다.
pub fn due_in_window(
    conn: &Connection,
    workspace_id: &str,
    after: &str,
    now: &str,
) -> AppResult<Vec<DueReminder>> {
    let (Some(a), Some(n)) = (parse_stamp(after), parse_stamp(now)) else {
        return Ok(Vec::new());
    };
    if n <= a {
        return Ok(Vec::new());
    }
    // (a, n] — 하한은 열려 있으므로 a+1 분부터.
    due_between(conn, workspace_id, a + 1, n)
}

/// 대시보드 헤더 벨 팝오버 전용(§7.4) — 오늘 하루치 Due 를 시각순으로, 그 앞에 미처리(Overdue)를
/// 얹는다. 위와 같은 판정 재사용.
///
/// **2026-09-07(GRILL-2026-09-07 D5)**: 벨이 오늘치만 보여주면 어제 울린 알림은 흔적 없이
/// 사라진다(발화 기록 테이블이 없다 — 위 tick() 의 ponytail 주석대로 유실을 수용하는 설계).
/// 미처리 판정을 새로 만들지 않고 칸반 핀과 완전히 같은 판정인 `dashboard::due_reminders` 를
/// 그대로 재사용한다 — 지금까지 그 질의의 유일한 소비자는 펫의 5분 폴링(repo/pet/mod.rs)이었고,
/// 이 함수가 두 번째 소비자가 된다(판정 자체는 1바이트도 안 바뀐다). 정렬은
/// overdue(오래된 것부터 — due_reminders 자신의 `ORDER BY end_year, end_month, end_day` 오름차순이
/// 이미 그 모양이다) 먼저, 그 뒤 due(시각 오름차순).
pub fn due_today(conn: &Connection, workspace_id: &str, today: NaiveYmd) -> AppResult<Vec<DueReminder>> {
    // board/calendar 와 같은 자세: 스코프 검증은 커맨드가 아니라 repo 가 한다(NOT_FOUND).
    crate::repo::dashboard::ensure_workspace(conn, workspace_id)?;
    let mut out = crate::repo::dashboard::due_reminders(conn, workspace_id)?;
    let lo = today.to_ord() * MINS_PER_DAY;
    out.extend(due_between(conn, workspace_id, lo, lo + MINS_PER_DAY - 1)?);
    Ok(out)
}

// ── 틱 ───────────────────────────────────────────────────────────────────────

fn advance_watermark(conn: &mut Connection, now: &str) -> AppResult<()> {
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(LAST_TICK_KEY.to_string(), serde_json::Value::String(now.to_string()));
    crate::repo::settings::set(conn, &entries).map(|_| ())
}

/// 틱 한 사이클의 **판정 전부** — 발화만 호출자(스레드)가 한다. `now` 를 주입받으므로 시계에
/// 의존하지 않고 테스트할 수 있다.
///
/// 흐름은 설계서 §5 흐름도 그대로다:
///   ① 마스터가 꺼져 있으면 아무것도 쏘지 않고 **워터마크만 전진**한다 — 전진시키지 않으면
///      나중에 켰을 때 그동안의 과거가 한꺼번에 쏟아진다.
///   ② 워터마크: 없으면 now(첫 실행, 소급 없음) · 미래면 now 로 클램프(백업 복원, §2.5) ·
///      `after = max(last_tick, now − CATCHUP_MAX)`.
///   ③ (after, now] 판정 → ④ 워터마크 전진.
///
/// ③ 이 실패하면 워터마크를 전진시키지 않는다(다음 틱이 같은 창을 다시 본다). 반대로 전진 이후의
/// 발화 중 프로세스가 죽으면 그 사이클은 유실된다 — 수용한다(§5.4: 리마인더이지 돈이 아니다).
/// ponytail: 유실을 못 견디게 되면 collect_seen 과 같은 모양의
/// `reminder_fired(note_id, occurrence_at)` 테이블이 업그레이드 경로다.
pub fn tick(conn: &mut Connection, now: &str) -> AppResult<Vec<DueReminder>> {
    let Some(now_min) = parse_stamp(now) else {
        return Ok(Vec::new());
    };
    let settings = crate::repo::settings::get_all(conn)?;
    let enabled = settings
        .get(NOTIFICATIONS_ENABLED_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !enabled {
        return Ok(Vec::new());
    }

    let last = settings
        .get(LAST_TICK_KEY)
        .and_then(|v| v.as_str())
        .and_then(parse_stamp)
        .unwrap_or(now_min)
        .min(now_min);
    let after = last.max(now_min - CATCHUP_MAX_MIN);

    let workspace_id = crate::repo::folders::active_workspace_id(conn)?;
    let due = due_in_window(conn, &workspace_id, &format_stamp(after), now)?;
    advance_watermark(conn, now)?;
    Ok(due)
}

/// 앱 부팅 시 1회 — 백그라운드 스레드를 띄우고 즉시 반환한다(블로킹 없음). embedding::start /
/// collect::start 와 동일한 패턴이고 실패 정책도 같다: 커넥션을 못 열면 로그만 남기고 조용히
/// 포기한다(부팅에 영향 없음). 차이는 AppHandle 을 들고 있다는 것뿐 — 알림을 쏘아야 하므로.
/// tokio 런타임은 필요 없다(네트워크 없음).
pub fn start(app: tauri::AppHandle, data_dir: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut conn = match crate::db::open(&crate::db::db_path(&data_dir)) {
            Ok(c) => c,
            Err(e) => {
                // G5(AUDIT-2026-09-26-fallback-observability.md §3): 이 return 은 스레드 자체를
                // 끝낸다 — 그 세션 내내 알림이 전혀 안 돈다. worker_stopped 가 PINNED 알림을
                // 큐에 쌓아 부팅 화면에서 사용자가 볼 수 있게 한다.
                crate::diag::worker_stopped("schedule", &format!("failed to open background connection: {e}"));
                return;
            }
        };
        loop {
            // 이 스레드가 살아있다는 신호 — TICK_INTERVAL(60초)이 diag의 기본 기대 주기와 같아
            // heartbeat_with_interval 없이 그냥 heartbeat 로 충분하다(diag.rs 헤더 참고).
            crate::diag::heartbeat("schedule");
            // A panic inside tick()/fire() (e.g. an unexpected malformed row) must not kill this
            // thread forever — that would silently stop all future reminders until app restart.
            // catch_unwind + AssertUnwindSafe: conn/app aren't UnwindSafe (interior mutability),
            // but we don't rely on any invariant broken by a panicked-and-discarded iteration —
            // next iteration just re-reads state fresh, same posture as the Err(e) branch below.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match tick(&mut conn, &now_local_stamp()) {
                    Ok(due) => {
                        if !due.is_empty() {
                            let preset = crate::repo::settings::get_all(&conn)
                                .ok()
                                .and_then(|s| s.get("pet_persona_preset").and_then(|v| v.as_str()).map(str::to_string))
                                .unwrap_or_default();
                            // D6(AUDIT-2026-09-26-fallback-observability.md §4): 워터마크는 이미
                            // 전진했다(tick 계약, advance-then-fire) — fire() 하나가 패닉해도 이
                            // 루프 전체가 죽지 않도록(그러면 이 틱의 나머지 리마인더가 통째로
                            // 유실된다) 리마인더 단위로 격리한다.
                            for_each_isolated(
                                &due,
                                |r| fire(&app, &preset, r),
                                |r| {
                                    crate::diag::error(
                                        "schedule",
                                        "fire_panic",
                                        format!(
                                            "fire() panicked for reminder note_id={} — this reminder is lost, others in the tick still ran",
                                            r.note_id
                                        ),
                                    );
                                },
                            );
                        }
                    }
                    Err(e) => crate::diag::error("schedule", "tick_failed", format!("{e}")),
                }
            }));
            if let Err(panic) = outcome {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "non-string panic payload".to_string());
                crate::diag::error("schedule", "tick_thread_panicked", format!("recovering: {msg}"));
            }
            std::thread::sleep(TICK_INTERVAL);
        }
    });
}

/// D6: 목록의 각 항목에 `f`를 적용하되, 하나가 패닉해도 나머지 항목은 계속 처리한다(`on_panic`을
/// 그 항목에 대해 호출하고 다음으로 넘어간다). fire() 하나가 패닉해도 이 틱의 나머지 리마인더가
/// 통째로 유실되지 않게 하는 지점이 이 함수다 — 실 발화 경로(위 루프)와 테스트(패닉하는 더미
/// 클로저)가 tauri AppHandle 없이도 같은 순수 루프를 공유해 격리 자체를 고정한다.
fn for_each_isolated<T>(items: &[T], f: impl Fn(&T), on_panic: impl Fn(&T)) {
    for item in items {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(item))).is_err() {
            on_panic(item);
        }
    }
}

/// 3채널 병행 발화(§5.3). 하나가 실패해도 나머지는 나간다 — OS 알림은 "찌르기", 클릭 가능한
/// 표면은 펫 말풍선이 담당한다(펫 말풍선의 노트 열기 경로는 이미 있다: pet_open_main →
/// pet-open-note → selectNote).
fn fire(app: &tauri::AppHandle, preset: &str, r: &DueReminder) {
    use tauri_plugin_notification::NotificationExt;
    let text = crate::repo::pet::schedule_notice_text(preset, &r.title);

    let os_result = app.notification().builder().title(&r.title).body(&text).show();
    // 채팅 말풍선이 떠 있으면 show_notice 가 Ok(false)로 양보한다(기존 정책 유지) — 그건 실패가
    // 아니다. OS 알림도 이 채널도 둘 다 진짜 실패했을 때만(Err) 사용자가 이 발화를 아예 놓친
    // 것이므로 그때만 diag에 남긴다.
    let pet_result = crate::pet_window::show_notice(app, text.clone(), Some(r.note_id.clone()));
    crate::events::emit_desktop_json(
        "app-notice",
        serde_json::json!({ "text": text, "note_id": r.note_id }),
    );
    if os_result.is_err() && pet_result.is_err() {
        crate::diag::warn(
            "schedule",
            "delivery_failed",
            format!("both OS notification and pet notice failed for reminder note_id={}", r.note_id),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;
    use rusqlite::params;
    use std::collections::BTreeMap;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn ws_and_folder(conn: &Connection) -> (String, String) {
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws], |r| r.get(0))
            .unwrap();
        (ws, folder)
    }

    /// remind=1 인 노트 하나. PLAN-2026-09-08-dates-rebuild.md W1 이후 `candidates()`(위)는
    /// `note_dates`(position=0)를 직접 읽으므로, `notes` 테이블에 raw UPDATE 를 치면 투영이
    /// 어긋나 후보에 반영되지 않는다 — 반드시 project_primary 를 부르는 공개 API(repo::notes::
    /// set_event_precision/set_event_end/set_schedule/update)를 거친다(커맨드 경로의 I1~I5 검증도
    /// 그대로 받는다).
    #[allow(clippy::too_many_arguments)]
    fn note(
        conn: &mut Connection,
        folder: &str,
        title: &str,
        start: (i64, Option<i64>, Option<i64>),
        end: Option<(i64, i64, i64)>,
        start_time: Option<&str>,
        offset: Option<i64>,
        rrule: Option<&str>,
    ) -> String {
        let id = notes::create(conn, folder, Some(title.into()), Some(start.0)).unwrap().note.id;
        notes::set_event_precision(conn, &id, start.1, start.2).unwrap();
        if let Some((ey, em, ed)) = end {
            notes::set_event_end(conn, &id, Some(ey), Some(em), Some(ed)).unwrap();
        }
        notes::set_schedule(
            conn,
            &id,
            start_time.map(String::from),
            None,
            offset,
            rrule.map(String::from),
        )
        .unwrap();
        notes::update(conn, &id, None, None, None, Some(true)).unwrap();
        id
    }

    fn set(conn: &mut Connection, key: &str, value: serde_json::Value) {
        let mut e = BTreeMap::new();
        e.insert(key.to_string(), value);
        crate::repo::settings::set(conn, &e).unwrap();
    }

    fn fired(conn: &Connection, ws: &str, after: &str, now: &str) -> Vec<String> {
        due_in_window(conn, ws, after, now)
            .unwrap()
            .into_iter()
            .map(|r| format!("{}@{}", r.title, r.fire_at.unwrap()))
            .collect()
    }

    // 완료 노트는 미래 일정도 알리지 않는다(칸반 핀의 done 면제와 동일 판단, 2026-08-09 오너 결정).
    // 커스텀 상태 id 는 done 이 아니므로 계속 울린다.
    #[test]
    fn done_status_excluded_from_due_but_custom_status_is_not() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let done = note(&mut conn, &folder, "done-note", (2026, Some(8), Some(12)), None, Some("09:00"), None, None);
        let custom = note(&mut conn, &folder, "custom-note", (2026, Some(8), Some(12)), None, Some("09:00"), None, None);
        conn.execute("UPDATE notes SET status='done' WHERE id=?1", [&done]).unwrap();
        conn.execute("UPDATE notes SET status='some-custom-id' WHERE id=?1", [&custom]).unwrap();

        let hits = fired(&conn, &ws, "2026-08-12T08:59", "2026-08-12T09:00");
        assert_eq!(hits, vec!["custom-note@2026-08-12T09:00".to_string()]);
    }

    // ── 좌표 변환 ────────────────────────────────────────────────────────────

    #[test]
    fn stamp_round_trips_and_rejects_garbage() {
        for s in ["2026-08-09T00:00", "2026-12-31T23:59", "2024-02-29T09:05"] {
            assert_eq!(format_stamp(parse_stamp(s).unwrap()), s);
        }
        for bad in [
            "",
            "2026-08-09",
            "2026-08-09T24:00",
            "2026-13-01T00:00",
            "2026-02-29T09:05", // 평년의 2/29 — 실재하지 않는 날짜
            "2026-08-09 00:00",
            "26-08-09T00:00",
        ] {
            assert!(parse_stamp(bad).is_none(), "{bad} must be rejected");
        }
        // 오프셋이 자정을 넘어가도 산술이 자연히 전날로 간다.
        assert_eq!(format_stamp(parse_stamp("2026-08-09T00:00").unwrap() - 1), "2026-08-08T23:59");
    }

    #[test]
    fn hhmm_range_is_enforced_beyond_the_glob_check() {
        assert_eq!(parse_hhmm_min("00:00"), Some(0));
        assert_eq!(parse_hhmm_min("23:59"), Some(1439));
        // DB CHECK 의 GLOB 가 통과시키는 값들 — 실제 관문은 여기다.
        assert_eq!(parse_hhmm_min("24:00"), None);
        assert_eq!(parse_hhmm_min("29:59"), None);
        assert_eq!(parse_hhmm_min("7:00"), None);
        assert_eq!(parse_hhmm_min("0700"), None);
    }

    // ── Overdue / Due 분기 ───────────────────────────────────────────────────

    #[test]
    fn overdue_path_is_untouched_by_the_due_path() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        // 종료일이 과거 + remind → 기존 Overdue(칸반 핀과 같은 판정).
        note(&mut conn, &folder, "지난 일", (2000, Some(1), Some(1)), Some((2000, 1, 2)), None, None, None);
        // 미래 시각 일정 → Due 이지만 Overdue 목록에는 절대 나오면 안 된다.
        note(&mut conn, &folder, "다음 주", (2999, Some(1), Some(1)), None, Some("09:00"), None, None);

        let overdue = crate::repo::dashboard::due_reminders(&conn, &ws).unwrap();
        assert_eq!(overdue.len(), 1);
        assert_eq!(overdue[0].title, "지난 일");
        assert_eq!(overdue[0].kind, ReminderKind::Overdue);
        assert_eq!(overdue[0].fire_at, None, "Overdue 는 발화 시각 개념이 없다");
    }

    #[test]
    fn timed_note_fires_at_start_time_minus_offset() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "미팅", (2026, Some(8), Some(9)), None, Some("09:00"), Some(15), None);

        // 정확히 창 안(08:45).
        assert_eq!(fired(&conn, &ws, "2026-08-09T08:44", "2026-08-09T08:45"), vec!["미팅@2026-08-09T08:45"]);
        // 창 밖(발화 1분 뒤에 시작하는 창).
        assert!(fired(&conn, &ws, "2026-08-09T08:45", "2026-08-09T08:46").is_empty());
        assert!(fired(&conn, &ws, "2026-08-09T08:43", "2026-08-09T08:44").is_empty());
    }

    #[test]
    fn offset_crossing_midnight_fires_on_the_previous_day() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        // 1일 전(1440분) 알림 — 09:00 일정이 전날 09:00 에 울린다.
        note(&mut conn, &folder, "발표", (2026, Some(8), Some(10)), None, Some("09:00"), Some(1440), None);
        assert_eq!(fired(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00"), vec!["발표@2026-08-09T09:00"]);
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 발화는 항상 시작일 — 기간이 있어도 종료일은
    /// 더 이상 기준이 아니다(이 웨이브가 뒤집는 규칙, 옛 이름은 "종료일에 울린다"였다).
    #[test]
    fn period_note_fires_at_the_start_date_at_the_configured_hour() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        // 종일(시각 없음) + 기간 → 기준은 **시작일** 자정(기본 00:00).
        note(&mut conn, &folder, "여행", (2026, Some(8), Some(1)), Some((2026, 8, 12)), None, None, None);
        assert_eq!(fired(&conn, &ws, "2026-07-31T23:59", "2026-08-01T00:00"), vec!["여행@2026-08-01T00:00"]);
        // 종료일엔 더 이상 울리지 않는다.
        assert!(fired(&conn, &ws, "2026-08-11T23:59", "2026-08-12T00:00").is_empty());

        // 설정을 09:00 으로 바꾸면 기준 시각이 따라간다(날짜는 여전히 시작일).
        set(&mut conn, ALL_DAY_AT_KEY, serde_json::json!("09:00"));
        assert_eq!(fired(&conn, &ws, "2026-08-01T08:59", "2026-08-01T09:00"), vec!["여행@2026-08-01T09:00"]);
    }

    #[test]
    fn all_day_note_without_an_end_triple_falls_back_to_the_start_date() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "기념일", (2026, Some(8), Some(9)), None, None, None, None);
        assert_eq!(fired(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00"), vec!["기념일@2026-08-09T00:00"]);
    }

    #[test]
    fn year_only_note_never_fires() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "1998년", (1998, None, None), None, None, None, None);
        assert!(fired(&conn, &ws, "1997-12-31T00:00", "2100-01-01T00:00").is_empty());
    }

    #[test]
    fn archived_and_deleted_notes_do_not_fire() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let a = note(&mut conn, &folder, "보관", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        let d = note(&mut conn, &folder, "삭제", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        conn.execute("UPDATE notes SET archived_at='x' WHERE id=?1", params![a]).unwrap();
        conn.execute("UPDATE notes SET deleted_at='x' WHERE id=?1", params![d]).unwrap();
        assert!(fired(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").is_empty());
    }

    #[test]
    fn remind_off_is_still_the_note_level_gate() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let id = note(&mut conn, &folder, "시각만", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        notes::update(&mut conn, &id, None, None, None, Some(false)).unwrap();
        assert!(fired(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").is_empty());
    }

    // ── 반복 전개 발화 ───────────────────────────────────────────────────────

    #[test]
    fn weekly_repeat_fires_once_per_occurrence() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        // 2026-08-10 은 월요일. 매주 월·수 10:00.
        note(
            &mut conn,
            &folder,
            "스탠드업",
            (2026, Some(8), Some(10)),
            None,
            Some("10:00"),
            None,
            Some("FREQ=WEEKLY;BYDAY=MO,WE"),
        );
        assert_eq!(fired(&conn, &ws, "2026-08-10T09:59", "2026-08-10T10:00"), vec!["스탠드업@2026-08-10T10:00"]);
        assert!(fired(&conn, &ws, "2026-08-11T09:59", "2026-08-11T10:00").is_empty(), "화요일엔 회차가 없다");
        assert_eq!(fired(&conn, &ws, "2026-08-12T09:59", "2026-08-12T10:00"), vec!["스탠드업@2026-08-12T10:00"]);
        // 넉넉한 창 하나면 그 사이 회차가 전부 정확히 한 번씩 나온다(8/10 월, 8/12 수, 8/17 월).
        assert_eq!(
            fired(&conn, &ws, "2026-08-09T00:00", "2026-08-17T23:59"),
            vec![
                "스탠드업@2026-08-10T10:00",
                "스탠드업@2026-08-12T10:00",
                "스탠드업@2026-08-17T10:00"
            ]
        );
    }

    #[test]
    fn repeat_until_stops_the_series() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(
            &mut conn,
            &folder,
            "약",
            (2026, Some(8), Some(9)),
            None,
            Some("08:00"),
            None,
            Some("FREQ=DAILY;UNTIL=20260811"),
        );
        assert_eq!(fired(&conn, &ws, "2026-08-11T07:59", "2026-08-11T08:00").len(), 1, "UNTIL 은 포함 경계");
        assert!(fired(&conn, &ws, "2026-08-12T07:59", "2026-08-12T08:00").is_empty());
    }

    #[test]
    fn repeat_with_a_one_day_offset_fires_the_day_before_each_occurrence() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(
            &mut conn,
            &folder,
            "월간 보고",
            (2026, Some(1), Some(15)),
            None,
            Some("14:00"),
            Some(1440),
            Some("FREQ=MONTHLY"),
        );
        // 8월 회차(8/15 14:00)의 알림은 8/14 14:00 — 회차 전개 창이 오프셋만큼 미래를 봐야 잡힌다.
        assert_eq!(fired(&conn, &ws, "2026-08-14T13:59", "2026-08-14T14:00"), vec!["월간 보고@2026-08-14T14:00"]);
    }

    #[test]
    fn corrupt_rrule_yields_no_occurrences_rather_than_wrong_ones() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let id = note(&mut conn, &folder, "손상", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        // 파서를 우회해 직접 심는다(저장 경로로는 들어올 수 없는 값). candidates() 가 이제
        // note_dates(position=0)를 읽으므로 거기 직접 심는다 — notes.rrule 은 그 투영일 뿐이다.
        conn.execute("UPDATE note_dates SET rrule='FREQ=HOURLY' WHERE note_id=?1 AND position=0", params![id]).unwrap();
        assert!(fired(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").is_empty());
    }

    // ── 관련 날짜(note_dates) 알림 — D3 철회(2026-09-07 D10) ────────────────────

    /// remind=1 인 관련 날짜는 종일(settings.reminder_all_day_at)에 발화하고, DueReminder 의
    /// related_date_id 가 그 note_dates 행 id 로 채워진다. 노트 자신은 remind 를 켜지 않는다 —
    /// 관련 날짜 알림이 노트의 remind 플래그와 독립임을 같이 고정한다.
    #[test]
    fn related_date_with_remind_on_fires_all_day_and_carries_related_date_id() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("행사".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();

        let due = due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].note_id, n.note.id);
        assert_eq!(due[0].title, "행사");
        assert_eq!(due[0].kind, ReminderKind::Due);
        assert_eq!(due[0].fire_at.as_deref(), Some("2026-08-09T00:00"));
        assert_eq!(due[0].related_date_id.as_deref(), Some(date_id.as_str()));

        // 기준 시각 설정을 따라간다(notes 의 종일 규칙과 동일 판정 지점).
        set(&mut conn, ALL_DAY_AT_KEY, serde_json::json!("09:00"));
        let due2 = due_in_window(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").unwrap();
        assert_eq!(due2.len(), 1);
        assert_eq!(due2[0].fire_at.as_deref(), Some("2026-08-09T09:00"));
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 기간을 가진 관련 날짜는 **시작일**에 발화한다
    /// (종료일이 아니다) — 이 웨이브가 뒤집는 규칙(옛 이름·주석은 "종료일에 발화"였다).
    #[test]
    fn related_date_with_a_period_fires_on_the_start_date_not_the_end_date() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("워크숍".into()), Some(2020)).unwrap();
        let date_id =
            notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), Some(2026), Some(8), Some(11), None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();

        // 종료일엔 발화하지 않는다.
        assert!(
            due_in_window(&conn, &ws, "2026-08-10T23:59", "2026-08-11T00:00").unwrap().is_empty(),
            "발화는 항상 시작일 — 기간이 있어도 종료일은 기준이 아니다"
        );

        // 시작일에 발화한다.
        let due = due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].related_date_id.as_deref(), Some(date_id.as_str()));
    }

    #[test]
    fn related_date_with_remind_off_never_fires() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("행사".into()), Some(2020)).unwrap();
        notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), None, None, None, None, None, false, None, None, None).unwrap();
        // set_remind 를 호출하지 않는다 — 기본값 0.
        assert!(due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap().is_empty());
    }

    /// 아카이브된 노트의 관련 날짜는 remind=1 이어도 발화하지 않는다 — candidates() 의 아카이브
    /// 제외 규칙은 position 0/그 외 모든 행에 똑같이 적용된다(W2 통합 이후 한 질의뿐이므로).
    #[test]
    fn archived_notes_related_dates_do_not_fire() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("보관됨".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();
        conn.execute("UPDATE notes SET archived_at='x' WHERE id=?1", [&n.note.id]).unwrap();

        assert!(due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap().is_empty());
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(①): 후보 조회가 하나로 합쳐진 뒤에도 position 0(대표)
    /// 행과 그 외 행이 같은 경로로 후보가 되고, `related_date_id` 는 position 0 일 때만 `None`
    /// 이라는 겉 계약이 유지된다는 것을 한 노트 안에서 직접 고정한다.
    #[test]
    fn primary_and_related_dates_share_the_same_candidate_path() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        // 대표(position 0): notes::create + set_event_precision + remind 로 세운다.
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder, Some("메인 행사".into()), Some(2026), Some(8), Some(9), None, None,
        )
        .unwrap();
        notes::update(&mut conn, &n.note.id, None, None, None, Some(true)).unwrap();
        // 관련 날짜(position 1): 같은 노트에 하나 더.
        let related_id = notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(20), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &related_id, true).unwrap();

        let due = due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].related_date_id, None, "position 0 은 related_date_id 가 None");

        let due2 = due_in_window(&conn, &ws, "2026-08-19T23:59", "2026-08-20T00:00").unwrap();
        assert_eq!(due2.len(), 1);
        assert_eq!(
            due2[0].related_date_id.as_deref(),
            Some(related_id.as_str()),
            "position 0 이 아닌 행은 자기 id 가 related_date_id"
        );
    }

    // ── 관련 날짜 시각·오프셋 (V75, PLAN-2026-09-07-reminder-2tier.md §4) ───────

    /// start_time 이 있는 관련 날짜는 settings.reminder_all_day_at 이 아니라 그 시각에 발화한다.
    #[test]
    fn related_date_with_start_time_fires_at_that_time_not_all_day_at() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        set(&mut conn, ALL_DAY_AT_KEY, serde_json::json!("09:00"));
        let n = notes::create(&mut conn, &folder, Some("미팅".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), None, None, None, None, None, false, None, None, None).unwrap();
        notes::date_set_schedule(&mut conn, &date_id, true, Some("14:00".into()), None).unwrap();

        // 종일 기준 시각(09:00)에는 울리지 않는다.
        assert!(due_in_window(&conn, &ws, "2026-08-08T23:59", "2026-08-09T00:00").unwrap().is_empty());
        assert!(due_in_window(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").unwrap().is_empty());
        // 저장된 시각(14:00)에 울린다.
        let due = due_in_window(&conn, &ws, "2026-08-09T13:59", "2026-08-09T14:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].fire_at.as_deref(), Some("2026-08-09T14:00"));
        assert_eq!(due[0].related_date_id.as_deref(), Some(date_id.as_str()));
    }

    /// remind_offset_min 이 관련 날짜의 발화 시각을 그만큼 앞당긴다 — 대표 날짜(offset_crossing_
    /// midnight_fires_on_the_previous_day)와 동일한 fire_times 판정 지점을 지난다는 것을 고정한다.
    #[test]
    fn related_date_remind_offset_min_shifts_fire_time_earlier() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("발표".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(10), None, None, None, None, None, false, None, None, None).unwrap();
        notes::date_set_schedule(&mut conn, &date_id, true, Some("09:00".into()), Some(1440)).unwrap();

        // 1일 전(1440분) 오프셋 — 전날 09:00 에 울린다.
        assert_eq!(
            due_in_window(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").unwrap().len(),
            1
        );
        // 당일 09:00 에는 이미 지나간 창이라 다시 울리지 않는다.
        assert!(due_in_window(&conn, &ws, "2026-08-10T08:59", "2026-08-10T09:00").unwrap().is_empty());
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 기간(date~end_date)을 가진 관련 날짜에
    /// start_time 을 넣어도 발화 기준일은 그대로 **시작일**이다 — 발화는 시각 유무와 무관하게
    /// 항상 시작일이므로 "시각이 있어서 시작일로 옮겨간다"는 조건부 규칙(옛 anchor_date)은 이제
    /// 없다. 시각은 그 시작일의 몇 시에 울리는지만 정한다.
    #[test]
    fn related_date_with_a_period_and_start_time_still_fires_on_the_start_date() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("워크숍".into()), Some(2020)).unwrap();
        let date_id =
            notes::date_add(&mut conn, &n.note.id, 2026, Some(8), Some(9), Some(2026), Some(8), Some(11), None, None, false, None, None, None).unwrap();
        notes::date_set_schedule(&mut conn, &date_id, true, Some("10:00".into()), None).unwrap();

        // 시작일(8/9)의 저장된 시각(10:00)에 울린다.
        let due = due_in_window(&conn, &ws, "2026-08-09T09:59", "2026-08-09T10:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].related_date_id.as_deref(), Some(date_id.as_str()));
        // 종료일(8/11)에는 울리지 않는다 — 시각이 있어도 발화 기준일은 시작일 고정.
        assert!(
            due_in_window(&conn, &ws, "2026-08-11T09:59", "2026-08-11T10:00").unwrap().is_empty(),
            "발화는 시각 유무와 무관하게 시작일 고정"
        );
    }

    // ── 워터마크 ─────────────────────────────────────────────────────────────

    #[test]
    fn window_is_half_open_so_a_fire_never_repeats_across_ticks() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "미팅", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        // 경계 위의 두 연속 창 — 정확히 한 쪽만 잡아야 한다.
        assert_eq!(fired(&conn, &ws, "2026-08-09T08:59", "2026-08-09T09:00").len(), 1);
        assert_eq!(fired(&conn, &ws, "2026-08-09T09:00", "2026-08-09T09:01").len(), 0);
    }

    #[test]
    fn first_run_does_not_backfire_and_seeds_the_watermark() {
        let mut conn = setup();
        let (_ws, folder) = ws_and_folder(&conn);
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        note(&mut conn, &folder, "어제", (2026, Some(8), Some(8)), None, Some("09:00"), None, None);

        // 워터마크 없음 = 첫 실행 → after = now, 과거를 소급 발화하지 않는다.
        assert!(tick(&mut conn, "2026-08-09T12:00").unwrap().is_empty());
        let s = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(s.get(LAST_TICK_KEY).and_then(|v| v.as_str()), Some("2026-08-09T12:00"));
    }

    #[test]
    fn catchup_is_clamped_to_one_hour() {
        let mut conn = setup();
        let (_ws, folder) = ws_and_folder(&conn);
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        // 사흘 전 워터마크 — 앱이 사흘 꺼져 있었다.
        set(&mut conn, LAST_TICK_KEY, serde_json::json!("2026-08-06T12:00"));
        note(&mut conn, &folder, "이틀전", (2026, Some(8), Some(7)), None, Some("09:00"), None, None);
        note(&mut conn, &folder, "방금", (2026, Some(8), Some(9)), None, Some("11:30"), None, None);

        let due = tick(&mut conn, "2026-08-09T12:00").unwrap();
        let titles: Vec<_> = due.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["방금"], "CATCHUP_MAX(1시간) 밖의 과거는 쏟아지지 않는다");
    }

    #[test]
    fn master_off_does_not_write_watermark() {
        let mut conn = setup();
        let (_ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "미팅", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        // 기본값이 OFF 라 아무것도 설정하지 않은 상태가 곧 마스터 OFF.
        assert!(tick(&mut conn, "2026-08-09T09:00").unwrap().is_empty());
        // 알림 OFF 로 tick 을 돌려도 last_tick 키가 생기지 않는다.
        assert!(
            crate::repo::settings::get_all(&conn).unwrap().get(LAST_TICK_KEY).is_none(),
        );

        // 나중에 켜도 CATCHUP_MAX_MIN(60분)에 의해 그 이전 과거는 쏟아지지 않는다.
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        assert!(tick(&mut conn, "2026-08-09T10:30").unwrap().is_empty());
    }

    #[test]
    fn a_future_watermark_from_a_restored_backup_is_clamped_to_now() {
        let mut conn = setup();
        let (_ws, folder) = ws_and_folder(&conn);
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        set(&mut conn, LAST_TICK_KEY, serde_json::json!("2030-01-01T00:00"));
        note(&mut conn, &folder, "미팅", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);

        // 클램프 직후의 한 틱은 창이 (now, now] 라 비어 있지만, 워터마크가 현재로 되돌아온다.
        // 클램프가 없으면 워터마크가 2030 에 박혀 **영원히** 아무것도 울리지 않는다.
        assert!(tick(&mut conn, "2026-08-09T08:59").unwrap().is_empty());
        assert_eq!(
            crate::repo::settings::get_all(&conn).unwrap().get(LAST_TICK_KEY).and_then(|v| v.as_str()),
            Some("2026-08-09T08:59"),
        );
        // 다음 틱부터는 정상 동작.
        let due = tick(&mut conn, "2026-08-09T09:00").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].fire_at.as_deref(), Some("2026-08-09T09:00"));
    }

    #[test]
    fn a_garbage_watermark_is_treated_as_absent() {
        let mut conn = setup();
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        // validate_setting 을 우회해 직접 심는다(구버전/손상 값 시나리오).
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, '\"garbage\"')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![LAST_TICK_KEY],
        )
        .unwrap();
        assert!(tick(&mut conn, "2026-08-09T09:00").unwrap().is_empty());
    }

    #[test]
    fn tick_only_looks_at_the_active_workspace() {
        let mut conn = setup();
        let (_ws, folder) = ws_and_folder(&conn);
        set(&mut conn, NOTIFICATIONS_ENABLED_KEY, serde_json::json!(true));
        set(&mut conn, LAST_TICK_KEY, serde_json::json!("2026-08-09T08:59"));

        let other_ws = crate::repo::workspaces::create(&mut conn, "다른 노트북").unwrap();
        let other_folder: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&other_ws.id], |r| r.get(0))
            .unwrap();
        note(&mut conn, &other_folder, "남의 일정", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);
        note(&mut conn, &folder, "내 일정", (2026, Some(8), Some(9)), None, Some("09:00"), None, None);

        let due = tick(&mut conn, "2026-08-09T09:00").unwrap();
        assert_eq!(due.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["내 일정"]);
    }

    // ── 틱 스레드 패닉 복구 ──────────────────────────────────────────────────
    //
    // start()'s loop isn't itself unit-testable (real std::thread + tauri::AppHandle + on-disk
    // DB) — this pins the exact catch_unwind/AssertUnwindSafe/downcast idiom used inside it: a
    // panic inside the wrapped closure must be caught (not propagate and kill the thread) and a
    // human-readable message must be extractable, so the next loop iteration still runs.
    #[test]
    fn tick_cycle_panic_is_caught_and_loop_would_continue() {
        let mut iterations_survived = 0;
        for should_panic in [true, false, true] {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if should_panic {
                    panic!("simulated tick panic");
                }
            }));
            if let Err(panic) = outcome {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "non-string panic payload".to_string());
                assert_eq!(msg, "simulated tick panic");
            }
            // Reached regardless of whether this iteration's closure panicked — proves control
            // flow returns to the loop instead of unwinding the whole thread.
            iterations_survived += 1;
        }
        assert_eq!(iterations_survived, 3);
    }

    // ── 리마인더 단위 격리(D6) ───────────────────────────────────────────────
    //
    // 실제 fire()는 tauri::AppHandle(알림 플러그인)을 요구해 유닛 테스트로 직접 몰기 어렵다 —
    // 대신 fire() 호출부가 실제로 쓰는 순수 루프(for_each_isolated)를 더미 클로저로 구동해
    // "하나가 패닉해도 나머지 전부가 시도된다"는 핵심 계약을 AppHandle 없이 고정한다.
    #[test]
    fn for_each_isolated_processes_every_item_even_when_one_panics() {
        use std::cell::RefCell;
        let items = vec![1, 2, 3];
        let attempted: RefCell<Vec<i32>> = RefCell::new(Vec::new());
        let panicked: RefCell<Vec<i32>> = RefCell::new(Vec::new());

        for_each_isolated(
            &items,
            |&i| {
                attempted.borrow_mut().push(i);
                if i == 2 {
                    panic!("simulated fire() panic");
                }
            },
            |&i| panicked.borrow_mut().push(i),
        );

        assert_eq!(*attempted.borrow(), vec![1, 2, 3], "패닉한 항목도 시도됐고, 그 뒤 항목들도 이어서 시도됐다");
        assert_eq!(*panicked.borrow(), vec![2], "패닉한 항목만 on_panic 콜백을 받는다");
    }

    #[test]
    fn for_each_isolated_is_a_no_op_when_nothing_panics() {
        use std::cell::RefCell;
        let items = vec!["a", "b"];
        let attempted: RefCell<Vec<&str>> = RefCell::new(Vec::new());
        let panicked: RefCell<Vec<&str>> = RefCell::new(Vec::new());

        for_each_isolated(&items, |s| attempted.borrow_mut().push(*s), |s| panicked.borrow_mut().push(*s));

        assert_eq!(*attempted.borrow(), vec!["a", "b"]);
        assert!(panicked.borrow().is_empty());
    }

    // ── due_today ────────────────────────────────────────────────────────────

    /// due_today 는 Due 창(오늘)엔 호출자가 넘긴 `today` 를 쓰지만, 안에서 부르는
    /// dashboard::due_reminders(Overdue)는 **실제** 벽시계 오늘(today_ymd_local)로 판정한다 —
    /// due_today 자체의 기존 설계다(이 함수는 그걸 바꾸지 않는다). 2026-09-07 전에는 종료일 없는
    /// 시각 있는 노트가 애초에 Overdue 후보가 아니었으니 무해했지만, anchor 통일 이후로는
    /// remind=1·풀 정밀도 시작일 노트가 실제 오늘보다 과거면 Overdue 로도 잡힌다. 그래서 아래
    /// "오늘/내일" 노트들은 하드코딩된 날짜 대신 **실제 오늘** 기준으로 만든다 — 그래야 테스트가
    /// 실행 시점과 무관하게 "당일(Overdue 아님)"을 유지한다.
    fn real_today() -> NaiveYmd {
        let (y, m, d) = crate::util::today_ymd_local();
        NaiveYmd { y, m: m as u32, d: d as u32 }
    }

    #[test]
    fn due_today_lists_the_days_fires_in_time_order() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let today = real_today();
        let tomorrow = ord_to_ymd(today.to_ord() + 1);
        note(&mut conn, &folder, "저녁", (today.y, Some(today.m as i64), Some(today.d as i64)), None, Some("18:00"), None, None);
        note(&mut conn, &folder, "아침", (today.y, Some(today.m as i64), Some(today.d as i64)), None, Some("09:00"), None, None);
        // 내일 일정 + 1일 전 오프셋 → 오늘 목록에 든다.
        note(
            &mut conn, &folder, "내일 준비",
            (tomorrow.y, Some(tomorrow.m as i64), Some(tomorrow.d as i64)),
            None, Some("12:00"), Some(1440), None,
        );
        // 내일 일정(오프셋 없음) → 오늘 목록에 없다.
        note(
            &mut conn, &folder, "내일",
            (tomorrow.y, Some(tomorrow.m as i64), Some(tomorrow.d as i64)),
            None, Some("12:00"), None, None,
        );

        let items = due_today(&conn, &ws, today).unwrap();
        assert_eq!(
            items.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            vec!["아침", "내일 준비", "저녁"]
        );
        assert!(items.iter().all(|r| r.kind == ReminderKind::Due && r.fire_at.is_some()));
    }

    #[test]
    fn due_today_ignores_the_master_switch() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let today = real_today();
        note(&mut conn, &folder, "아침", (today.y, Some(today.m as i64), Some(today.d as i64)), None, Some("09:00"), None, None);
        // 마스터는 기본 OFF — 그래도 "예정된 알림이 무엇인지"는 보여준다(§5.1).
        assert_eq!(due_today(&conn, &ws, today).unwrap().len(), 1);
    }

    // GRILL-2026-09-07 D5: 벨이 미처리(overdue)를 오늘치(due) 앞에 얹는다.
    #[test]
    fn due_today_prepends_overdue_oldest_first_then_due_by_time() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        let today = real_today();
        // 종료일이 실제 "오늘"(테스트 실행 시각)보다 한참 과거인 두 미처리 — 나중 것부터 만들어
        // due_reminders 자신의 ORDER BY(end date ASC)가 실제로 정렬을 하는지도 같이 확인한다.
        note(&mut conn, &folder, "최근 미처리", (2010, Some(6), Some(1)), Some((2010, 6, 2)), None, None, None);
        note(&mut conn, &folder, "오래된 미처리", (2000, Some(1), Some(1)), Some((2000, 1, 2)), None, None, None);
        // 오늘 도래하는 두 건(시각 오름차순으로 나와야 한다) — 당일이라 Overdue 로는 안 잡힌다.
        note(&mut conn, &folder, "저녁", (today.y, Some(today.m as i64), Some(today.d as i64)), None, Some("18:00"), None, None);
        note(&mut conn, &folder, "아침", (today.y, Some(today.m as i64), Some(today.d as i64)), None, Some("09:00"), None, None);

        let items = due_today(&conn, &ws, today).unwrap();
        assert_eq!(
            items.iter().map(|r| (r.kind, r.title.as_str())).collect::<Vec<_>>(),
            vec![
                (ReminderKind::Overdue, "오래된 미처리"),
                (ReminderKind::Overdue, "최근 미처리"),
                (ReminderKind::Due, "아침"),
                (ReminderKind::Due, "저녁"),
            ]
        );
    }

    // 회귀 고정: due_today 가 due_reminders 를 호출하게 됐어도, 펫 5분 폴링이 직접 부르는
    // dashboard::due_reminders 자체의 판정/반환 타입은 그대로다(이 웨이브가 건드리지 않은 경로).
    #[test]
    fn pet_polling_path_is_unaffected_by_the_bell_now_sharing_due_reminders() {
        let mut conn = setup();
        let (ws, folder) = ws_and_folder(&conn);
        note(&mut conn, &folder, "지난 일", (2000, Some(1), Some(1)), Some((2000, 1, 2)), None, None, None);
        let direct = crate::repo::dashboard::due_reminders(&conn, &ws).unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].kind, ReminderKind::Overdue);
        assert_eq!(direct[0].fire_at, None);
    }
}
