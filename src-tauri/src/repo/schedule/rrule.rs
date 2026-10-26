// repo: schedule/rrule — RRULE 서브셋 파서 + occurrence 전개 (docs/PLAN-schedule-system.md §3).
//
// 순수 함수만이다: DB·시각(HH:MM)·타임존·설정을 일절 보지 않고 날짜만 다룬다. 시각과 알림 오프셋은
// notes 의 별도 컬럼이 갖고 있고(§3.1 "UNTIL 이 시각을 또 들면 두 번째 진실"), fire_at 조립은
// W5-3(schedule/mod.rs)의 몫이다.
//
// 날짜 산술은 repo::dashboard::dateord 의 프로렙틱 오디널을 그대로 쓴다 — 새 날짜 타입/크레이트를
// 만들지 않는다(§3.4). 그 오디널은 BCE(음수 연도)까지 커버하므로 여기 로직도 자연히 커버한다.
use crate::error::{AppError, AppResult};
use crate::repo::dashboard::dateord::{days_in_month, ord_to_ymd, NaiveYmd};
use serde::{Serialize, Serializer};

/// 한 번의 조회가 돌려줄 수 있는 occurrence 상한. 넘으면 자르고 `capped=true` 를 함께 돌려준다 —
/// `TIMELINE_ITEM_CAP` 의 "no silent cap" 관례와 같다(specs/commands/dashboard.yaml:66).
pub const OCCURRENCE_CAP: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// RRULE 의 `BYDAY` 코드. 선언 순서가 곧 월요일 시작 정렬 순서이고 `idx()` 와 일치한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Weekday {
    #[serde(rename = "MO")]
    Mo,
    #[serde(rename = "TU")]
    Tu,
    #[serde(rename = "WE")]
    We,
    #[serde(rename = "TH")]
    Th,
    #[serde(rename = "FR")]
    Fr,
    #[serde(rename = "SA")]
    Sa,
    #[serde(rename = "SU")]
    Su,
}

impl Weekday {
    fn from_code(code: &str) -> Option<Self> {
        Some(match code {
            "MO" => Self::Mo,
            "TU" => Self::Tu,
            "WE" => Self::We,
            "TH" => Self::Th,
            "FR" => Self::Fr,
            "SA" => Self::Sa,
            "SU" => Self::Su,
            _ => return None,
        })
    }

    /// 월요일 0 … 일요일 6.
    fn idx(self) -> i64 {
        self as i64
    }
}

/// 파싱 결과. `NoteSummary` 가 원문 `rrule` 과 함께 이걸 실어 내려보내면 프론트는 파서 없이 UI
/// 상태를 복원할 수 있다(§3.3). `until` 은 TS 계약대로 `"YYYY-MM-DD"` 문자열로 직렬화된다 —
/// RRULE 원문의 `YYYYMMDD` 는 저장 형식일 뿐 UI 형식이 아니다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RRuleParts {
    pub freq: Freq,
    pub interval: u32,
    /// 항상 월→일 오름차순. `expand` 가 주 안에서 순서대로 방문하는 데 의존한다.
    pub byday: Vec<Weekday>,
    /// TS 계약대로 `"YYYY-MM-DD" | null` 로 직렬화된다 — RRULE 원문의 `YYYYMMDD` 는 저장 형식일
    /// 뿐 UI 형식이 아니다.
    #[serde(serialize_with = "ser_until")]
    pub until: Option<NaiveYmd>,
}

fn ser_until<S: Serializer>(v: &Option<NaiveYmd>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(d) => s.serialize_str(&d.to_iso()),
        None => s.serialize_none(),
    }
}

impl RRuleParts {
    /// `until` 을 UI 형식(`YYYY-MM-DD`)으로. W5-1 의 DTO 조립용.
    pub fn until_iso(&self) -> Option<String> {
        self.until.map(|d| d.to_iso())
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::Validation(msg.into())
}

// ── parse ────────────────────────────────────────────────────────────────────

/// RRULE 서브셋 문자열 → `RRuleParts` (§3.1).
///
/// 정규화하지 않는다: 소문자·공백·비표준 파트는 전부 거부한다. 저장 값이 곧 원문이어야 왕복이
/// 안전하기 때문에, 관대하게 받아 고쳐 쓰는 대신 거부한다.
///
/// seed(노트 시작일)에 의존하는 규칙(`UNTIL` < seed 거부, BCE seed 의 `UNTIL` 금지)은 여기서
/// 검사할 수 없다 — `parse_for_seed` 를 쓴다.
pub fn parse(s: &str) -> AppResult<RRuleParts> {
    if s.is_empty() {
        return Err(bad("rrule: empty string (store NULL for no repeat)"));
    }
    if s.chars().any(char::is_whitespace) {
        return Err(bad("rrule: whitespace is not allowed"));
    }

    let mut freq: Option<Freq> = None;
    let mut interval: Option<u32> = None;
    let mut byday: Option<Vec<Weekday>> = None;
    let mut until: Option<NaiveYmd> = None;

    for part in s.split(';') {
        let (key, val) = part
            .split_once('=')
            .ok_or_else(|| bad(format!("rrule: malformed part '{part}'")))?;
        match key {
            "FREQ" => {
                if freq.is_some() {
                    return Err(bad("rrule: duplicate key FREQ"));
                }
                freq = Some(match val {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return Err(bad(format!("rrule: unsupported FREQ '{val}'"))),
                });
            }
            "INTERVAL" => {
                if interval.is_some() {
                    return Err(bad("rrule: duplicate key INTERVAL"));
                }
                interval = Some(parse_interval(val)?);
            }
            "BYDAY" => {
                if byday.is_some() {
                    return Err(bad("rrule: duplicate key BYDAY"));
                }
                byday = Some(parse_byday(val)?);
            }
            "UNTIL" => {
                if until.is_some() {
                    return Err(bad("rrule: duplicate key UNTIL"));
                }
                until = Some(parse_until(val)?);
            }
            // COUNT / WKST / BYMONTHDAY / BYSETPOS / BYHOUR / TZID / 그 외 전부. 부분 지원은
            // "설정했는데 무시당하는" 조용한 오답을 낳으므로 거부가 유일하게 안전한 처리다.
            _ => return Err(bad(format!("rrule: unsupported part '{key}'"))),
        }
    }

    let freq = freq.ok_or_else(|| bad("rrule: FREQ is required"))?;
    let byday = byday.unwrap_or_default();
    if !byday.is_empty() && freq != Freq::Weekly {
        return Err(bad("rrule: BYDAY is only allowed with FREQ=WEEKLY"));
    }
    Ok(RRuleParts {
        freq,
        interval: interval.unwrap_or(1),
        byday,
        until,
    })
}

/// `parse` + seed 에 의존하는 §3.1 규칙 두 가지. 노트에 저장할 때(W5-1 의 I5)는 이쪽을 쓴다.
pub fn parse_for_seed(s: &str, seed: NaiveYmd) -> AppResult<RRuleParts> {
    let parts = parse(s)?;
    if let Some(u) = parts.until {
        // ponytail: BCE(음수 연도) 노트에는 반복 종료일을 달 수 없다 — DATE 문법이 4자리 양수뿐이라
        // 표현 수단이 없다. 실사용 0. 필요해지면 문법에 부호를 여는 것이 업그레이드 경로다.
        if seed.y < 1 {
            return Err(bad("rrule: UNTIL requires a positive-year start date"));
        }
        // occurrence 가 0개인 규칙은 사용자 오타이지 의도가 아니다.
        if u.to_ord() < seed.to_ord() {
            return Err(bad("rrule: UNTIL is before the start date"));
        }
    }
    Ok(parts)
}

fn parse_interval(v: &str) -> AppResult<u32> {
    let digits_only = !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    // 선행 0 도 거부한다: 같은 규칙이 두 가지 문자열로 저장되면 원문 비교가 깨진다.
    let canonical = digits_only && !(v.len() > 1 && v.starts_with('0'));
    let n = match (canonical, v.parse::<u32>()) {
        (true, Ok(n)) => n,
        _ => return Err(bad(format!("rrule: INTERVAL must be an integer, got '{v}'"))),
    };
    if !(1..=999).contains(&n) {
        return Err(bad(format!("rrule: INTERVAL out of range (1..999): {n}")));
    }
    Ok(n)
}

fn parse_byday(v: &str) -> AppResult<Vec<Weekday>> {
    let mut out: Vec<Weekday> = Vec::new();
    for code in v.split(',') {
        // 서수 접두(`2MO`)도 알 수 없는 코드도 여기서 함께 걸린다.
        let d = Weekday::from_code(code)
            .ok_or_else(|| bad(format!("rrule: unsupported BYDAY value '{code}'")))?;
        if out.contains(&d) {
            return Err(bad(format!("rrule: duplicate BYDAY value '{code}'")));
        }
        out.push(d);
    }
    out.sort();
    Ok(out)
}

fn parse_until(v: &str) -> AppResult<NaiveYmd> {
    // 8자리 정확히. RFC 5545 의 `YYYYMMDDTHHMMSSZ` 는 이 검사에서 걸려 거부된다(§3.1).
    if v.len() != 8 || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad(format!("rrule: UNTIL must be YYYYMMDD, got '{v}'")));
    }
    let y: i64 = v[0..4].parse().unwrap();
    let m: u32 = v[4..6].parse().unwrap();
    let d: u32 = v[6..8].parse().unwrap();
    if y < 1 {
        return Err(bad("rrule: UNTIL year must be positive"));
    }
    if !(1..=12).contains(&m) {
        return Err(bad(format!("rrule: UNTIL month out of range: {v}")));
    }
    if d < 1 || d > days_in_month(y, m) {
        return Err(bad(format!("rrule: UNTIL is not a real date: {v}")));
    }
    Ok(NaiveYmd { y, m, d })
}

// ── expand ───────────────────────────────────────────────────────────────────

// 오디널 1 = 0001-01-01 = 월요일(프로렙틱 그레고리력). 아래 두 헬퍼가 그 사실 하나에 얹혀 있고,
// `weekday_anchor_known_dates` 테스트가 그걸 못 박는다.
//
// ponytail: 주 경계는 ISO 월요일 고정이다. `settings.week_start`(settings_schema.rs:97)는 달력
// **표시** 전용 — 설정을 바꿨다고 반복 일정이 통째로 밀리면 안 되므로 여기서 읽지 않는다.
fn weekday_idx(ord: i64) -> i64 {
    (ord - 1).rem_euclid(7)
}

fn week_index(ord: i64) -> i64 {
    (ord - 1).div_euclid(7)
}

/// `n * interval` 만큼 점프할 때의 n: `base` 이상이 되는 최소 배수 계수.
fn jump_steps(delta: i64, interval: i64) -> i64 {
    if delta <= 0 {
        0
    } else {
        (delta + interval - 1) / interval
    }
}

fn push(out: &mut Vec<NaiveYmd>, capped: &mut bool, ord: i64) -> bool {
    if out.len() >= OCCURRENCE_CAP {
        *capped = true;
        return false;
    }
    out.push(ord_to_ymd(ord));
    true
}

/// `[from, to]` 구간에 **시작**이 떨어지는 occurrence 날짜들. 실체화 없이 매 조회마다 계산한다.
///
/// `seed` 는 노트의 시작 트리플(풀 정밀도). 시리즈 종료는 `parts.until` 이고, 실효 상한은
/// `min(to, until)` 이다. seed 이전은 절대 나오지 않는다.
///
/// 루프가 아니라 점프다(§3.4): seed 가 10년 전 `FREQ=DAILY` 여도 첫 occurrence 를 산술로 직접
/// 구하므로 조회 비용이 seed 와 `from` 사이 거리에 비례하지 않는다.
///
/// 다일 회차는 여기서 모른다 — 호출자가 `from` 을 `from − duration_days` 로 넓혀 부르고 결과
/// 스팬을 다시 잘라낸다(§3.4·§6.3).
pub fn expand(
    parts: &RRuleParts,
    seed: NaiveYmd,
    from: NaiveYmd,
    to: NaiveYmd,
) -> (Vec<NaiveYmd>, bool) {
    let seed_ord = seed.to_ord();
    let mut hi = to.to_ord();
    if let Some(u) = parts.until {
        hi = hi.min(u.to_ord());
    }
    // seed 이전에는 회차가 없다.
    let lo = from.to_ord().max(seed_ord);

    let mut out: Vec<NaiveYmd> = Vec::new();
    let mut capped = false;
    if hi < lo {
        return (out, capped);
    }
    let iv = parts.interval.max(1) as i64;

    match parts.freq {
        Freq::Daily => {
            let mut cur = seed_ord + jump_steps(lo - seed_ord, iv) * iv;
            while cur <= hi {
                if !push(&mut out, &mut capped, cur) {
                    break;
                }
                cur += iv;
            }
        }
        Freq::Weekly => {
            // BYDAY 생략 시 seed 의 요일 하나. parse 가 오름차순을 보장한다.
            let days: Vec<i64> = if parts.byday.is_empty() {
                vec![weekday_idx(seed_ord)]
            } else {
                parts.byday.iter().map(|d| d.idx()).collect()
            };
            let n = jump_steps(week_index(lo) - week_index(seed_ord), iv);
            // 그 주의 월요일부터 요일 오프셋을 더한다.
            let mut monday = seed_ord - weekday_idx(seed_ord) + n * iv * 7;
            'weeks: while monday <= hi {
                for d in &days {
                    let ord = monday + d;
                    if ord < lo {
                        continue; // seed 주 안의 seed 이전 요일, 혹은 from 이전
                    }
                    if ord > hi {
                        break 'weeks; // 요일 오름차순 → 이 주의 나머지도 이후 주도 전부 범위 밖
                    }
                    if !push(&mut out, &mut capped, ord) {
                        break 'weeks;
                    }
                }
                monday += iv * 7;
            }
        }
        Freq::Monthly => {
            let lo_ymd = ord_to_ymd(lo);
            let hi_ymd = ord_to_ymd(hi);
            let seed_mi = month_index(seed.y, seed.m);
            let hi_mi = month_index(hi_ymd.y, hi_ymd.m);
            let mut mi = seed_mi + jump_steps(month_index(lo_ymd.y, lo_ymd.m) - seed_mi, iv) * iv;
            while mi <= hi_mi {
                let y = mi.div_euclid(12);
                let m = (mi.rem_euclid(12) + 1) as u32;
                // 그 달에 없는 날은 건너뛴다(1/31 매월 → 2월 없음). RFC 5545 기본 동작.
                if seed.d <= days_in_month(y, m) {
                    let ord = NaiveYmd { y, m, d: seed.d }.to_ord();
                    if ord >= lo && ord <= hi && !push(&mut out, &mut capped, ord) {
                        break;
                    }
                }
                mi += iv;
            }
        }
        Freq::Yearly => {
            let lo_y = ord_to_ymd(lo).y;
            let hi_y = ord_to_ymd(hi).y;
            let mut y = seed.y + jump_steps(lo_y - seed.y, iv) * iv;
            while y <= hi_y {
                // 2/29 는 윤년에만. MONTHLY 와 같은 스킵 규칙.
                if seed.d <= days_in_month(y, seed.m) {
                    let ord = NaiveYmd {
                        y,
                        m: seed.m,
                        d: seed.d,
                    }
                    .to_ord();
                    if ord >= lo && ord <= hi && !push(&mut out, &mut capped, ord) {
                        break;
                    }
                }
                y += iv;
            }
        }
    }
    (out, capped)
}

fn month_index(y: i64, m: u32) -> i64 {
    y * 12 + (m as i64 - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i64, m: u32, d: u32) -> NaiveYmd {
        NaiveYmd { y, m, d }
    }

    fn weekday_from_idx(i: i64) -> Weekday {
        [
            Weekday::Mo,
            Weekday::Tu,
            Weekday::We,
            Weekday::Th,
            Weekday::Fr,
            Weekday::Sa,
            Weekday::Su,
        ][i as usize]
    }

    fn iso(v: &[NaiveYmd]) -> Vec<String> {
        v.iter().map(|d| d.to_iso()).collect()
    }

    fn expand_iso(rule: &str, seed: NaiveYmd, from: NaiveYmd, to: NaiveYmd) -> Vec<String> {
        let (occ, capped) = expand(&parse(rule).unwrap(), seed, from, to);
        assert!(!capped, "unexpected cap for {rule}");
        iso(&occ)
    }

    // ── 문법: 수용 ────────────────────────────────────────────────────────────

    #[test]
    fn parse_accepts_minimal_and_defaults() {
        let p = parse("FREQ=DAILY").unwrap();
        assert_eq!(p.freq, Freq::Daily);
        assert_eq!(p.interval, 1); // INTERVAL 생략 = 1
        assert!(p.byday.is_empty());
        assert_eq!(p.until, None);
    }

    #[test]
    fn parse_accepts_all_four_freqs() {
        for (s, f) in [
            ("FREQ=DAILY", Freq::Daily),
            ("FREQ=WEEKLY", Freq::Weekly),
            ("FREQ=MONTHLY", Freq::Monthly),
            ("FREQ=YEARLY", Freq::Yearly),
        ] {
            assert_eq!(parse(s).unwrap().freq, f, "{s}");
        }
    }

    #[test]
    fn parse_accepts_key_order_and_full_rule() {
        let a = parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;UNTIL=20261231").unwrap();
        let b = parse("UNTIL=20261231;BYDAY=MO,WE,FR;INTERVAL=2;FREQ=WEEKLY").unwrap();
        assert_eq!(a, b); // 키 순서 무관
        assert_eq!(a.interval, 2);
        assert_eq!(a.byday, vec![Weekday::Mo, Weekday::We, Weekday::Fr]);
        assert_eq!(a.until, Some(ymd(2026, 12, 31)));
    }

    #[test]
    fn parse_sorts_byday_and_accepts_all_seven() {
        assert_eq!(
            parse("FREQ=WEEKLY;BYDAY=FR,MO").unwrap().byday,
            vec![Weekday::Mo, Weekday::Fr]
        );
        assert_eq!(
            parse("FREQ=WEEKLY;BYDAY=SU,SA,FR,TH,WE,TU,MO")
                .unwrap()
                .byday
                .len(),
            7
        );
    }

    #[test]
    fn parse_accepts_interval_bounds() {
        assert_eq!(parse("FREQ=DAILY;INTERVAL=1").unwrap().interval, 1);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=999").unwrap().interval, 999);
    }

    #[test]
    fn parse_accepts_until_leap_day() {
        assert_eq!(
            parse("FREQ=YEARLY;UNTIL=20240229").unwrap().until,
            Some(ymd(2024, 2, 29))
        );
    }

    // ── 문법: 거부 ────────────────────────────────────────────────────────────

    fn rejects(rule: &str) {
        assert!(parse(rule).is_err(), "should reject: {rule:?}");
    }

    #[test]
    fn parse_rejects_empty_and_whitespace() {
        rejects("");
        rejects(" ");
        rejects("FREQ=DAILY ");
        rejects(" FREQ=DAILY");
        rejects("FREQ=DAILY; INTERVAL=2");
        rejects("FREQ=WEEKLY;BYDAY=MO, TU");
    }

    #[test]
    fn parse_rejects_lowercase() {
        rejects("freq=daily");
        rejects("FREQ=Daily");
        rejects("Freq=DAILY");
        rejects("FREQ=WEEKLY;BYDAY=mo");
        rejects("FREQ=DAILY;interval=2");
    }

    #[test]
    fn parse_rejects_missing_or_bad_freq() {
        rejects("INTERVAL=2");
        rejects("BYDAY=MO");
        rejects("UNTIL=20261231");
        rejects("FREQ=HOURLY");
        rejects("FREQ=MINUTELY");
        rejects("FREQ=");
    }

    #[test]
    fn parse_rejects_duplicate_keys() {
        rejects("FREQ=DAILY;FREQ=WEEKLY");
        rejects("FREQ=DAILY;FREQ=DAILY");
        rejects("FREQ=DAILY;INTERVAL=2;INTERVAL=3");
        rejects("FREQ=WEEKLY;BYDAY=MO;BYDAY=TU");
        rejects("FREQ=DAILY;UNTIL=20261231;UNTIL=20271231");
    }

    #[test]
    fn parse_rejects_bad_interval() {
        rejects("FREQ=DAILY;INTERVAL=0");
        rejects("FREQ=DAILY;INTERVAL=1000");
        rejects("FREQ=DAILY;INTERVAL=-1");
        rejects("FREQ=DAILY;INTERVAL=1.5");
        rejects("FREQ=DAILY;INTERVAL=");
        rejects("FREQ=DAILY;INTERVAL=01"); // 선행 0 = 비정규 표기
        rejects("FREQ=DAILY;INTERVAL=+2");
        rejects("FREQ=DAILY;INTERVAL=2x");
        rejects("FREQ=DAILY;INTERVAL=999999999999999999999");
    }

    #[test]
    fn parse_rejects_byday_outside_weekly() {
        rejects("FREQ=DAILY;BYDAY=MO");
        rejects("FREQ=MONTHLY;BYDAY=MO");
        rejects("FREQ=YEARLY;BYDAY=MO");
    }

    #[test]
    fn parse_rejects_bad_byday() {
        rejects("FREQ=WEEKLY;BYDAY=2MO"); // 서수 접두
        rejects("FREQ=WEEKLY;BYDAY=-1SU");
        rejects("FREQ=WEEKLY;BYDAY=MO,MO"); // 중복
        rejects("FREQ=WEEKLY;BYDAY=");
        rejects("FREQ=WEEKLY;BYDAY=MO,");
        rejects("FREQ=WEEKLY;BYDAY=XX");
        rejects("FREQ=WEEKLY;BYDAY=MON");
    }

    #[test]
    fn parse_rejects_unsupported_parts() {
        for rule in [
            "FREQ=DAILY;COUNT=5",
            "FREQ=WEEKLY;WKST=MO",
            "FREQ=MONTHLY;BYMONTHDAY=15",
            "FREQ=MONTHLY;BYSETPOS=1",
            "FREQ=DAILY;BYHOUR=9",
            "FREQ=DAILY;BYMINUTE=30",
            "FREQ=DAILY;TZID=Asia/Seoul",
            "FREQ=WEEKLY;BYWEEKNO=3",
            "FREQ=YEARLY;BYMONTH=2",
            "FREQ=DAILY;DTSTART=20260101",
        ] {
            rejects(rule);
        }
    }

    #[test]
    fn parse_rejects_malformed_structure() {
        rejects("RRULE:FREQ=DAILY"); // iCalendar 라인 접두 없음
        rejects("FREQ=DAILY;"); // 빈 파트
        rejects(";FREQ=DAILY");
        rejects("FREQ=DAILY;;INTERVAL=2");
        rejects("DAILY"); // '=' 없음
        rejects("FREQ:DAILY");
    }

    #[test]
    fn parse_rejects_bad_until() {
        rejects("FREQ=DAILY;UNTIL=2026123"); // 7자리
        rejects("FREQ=DAILY;UNTIL=202612311"); // 9자리
        rejects("FREQ=DAILY;UNTIL=20260231"); // 2월 31일
        rejects("FREQ=DAILY;UNTIL=20260431"); // 4월 31일
        rejects("FREQ=DAILY;UNTIL=20260229"); // 2026 평년
        rejects("FREQ=DAILY;UNTIL=19000229"); // 세기 평년
        rejects("FREQ=DAILY;UNTIL=20261301"); // 13월
        rejects("FREQ=DAILY;UNTIL=20260001"); // 0월
        rejects("FREQ=DAILY;UNTIL=20261200"); // 0일
        rejects("FREQ=DAILY;UNTIL=00001231"); // 양수 연도만
        rejects("FREQ=DAILY;UNTIL=2026-12-31");
        rejects("FREQ=DAILY;UNTIL=20261231T000000Z"); // RFC 5545 시각형
        rejects("FREQ=DAILY;UNTIL=20261231Z");
        rejects("FREQ=DAILY;UNTIL=");
    }

    #[test]
    fn parse_accepts_century_leap_until() {
        assert!(parse("FREQ=DAILY;UNTIL=20000229").is_ok()); // 2000 은 윤년
    }

    // ── seed 의존 규칙 ────────────────────────────────────────────────────────

    #[test]
    fn parse_for_seed_until_boundaries() {
        let seed = ymd(2026, 8, 9);
        // 같은 날 = 포함 경계, 회차 1개 → 수용
        assert!(parse_for_seed("FREQ=DAILY;UNTIL=20260809", seed).is_ok());
        assert!(parse_for_seed("FREQ=DAILY;UNTIL=20260810", seed).is_ok());
        // 하루 전 → 거부
        assert!(parse_for_seed("FREQ=DAILY;UNTIL=20260808", seed).is_err());
        assert!(parse_for_seed("FREQ=DAILY;UNTIL=19990101", seed).is_err());
        // UNTIL 없으면 seed 와 무관하게 통과
        assert!(parse_for_seed("FREQ=DAILY", seed).is_ok());
    }

    #[test]
    fn parse_for_seed_bce_rejects_until_only() {
        let bce = ymd(-44, 3, 15);
        assert!(parse_for_seed("FREQ=YEARLY", bce).is_ok()); // BCE seed + 반복은 허용
        assert!(parse_for_seed("FREQ=YEARLY;UNTIL=00010101", bce).is_err());
        assert!(parse_for_seed("FREQ=YEARLY;UNTIL=20261231", bce).is_err());
        // 0년도 BCE 취급(양수 연도가 아니다)
        assert!(parse_for_seed("FREQ=YEARLY;UNTIL=20261231", ymd(0, 6, 1)).is_err());
        assert!(parse_for_seed("FREQ=YEARLY;UNTIL=20261231", ymd(1, 6, 1)).is_ok());
    }

    #[test]
    fn parse_for_seed_still_rejects_syntax() {
        assert!(parse_for_seed("FREQ=DAILY;COUNT=3", ymd(2026, 8, 9)).is_err());
    }

    // ── 요일 앵커 ─────────────────────────────────────────────────────────────

    #[test]
    fn weekday_anchor_known_dates() {
        // 오디널→요일 매핑은 전개 전체의 토대다. 알려진 날짜로 못 박는다.
        let cases = [
            (ymd(2026, 8, 9), 6),  // 일요일
            (ymd(2026, 8, 10), 0), // 월요일
            (ymd(2000, 1, 1), 5),  // 토요일
            (ymd(1970, 1, 1), 3),  // 목요일
            (ymd(1, 1, 1), 0),     // 프로렙틱 0001-01-01 = 월요일
            (ymd(2024, 2, 29), 3), // 목요일
        ];
        for (d, want) in cases {
            assert_eq!(weekday_idx(d.to_ord()), want, "{}", d.to_iso());
        }
        // 같은 주(월~일)는 같은 week_index, 다음 월요일은 +1
        assert_eq!(
            week_index(ymd(2026, 8, 10).to_ord()),
            week_index(ymd(2026, 8, 16).to_ord())
        );
        assert_eq!(
            week_index(ymd(2026, 8, 17).to_ord()),
            week_index(ymd(2026, 8, 10).to_ord()) + 1
        );
    }

    // ── expand: FREQ 4종 기본 ─────────────────────────────────────────────────

    #[test]
    fn expand_daily_basic() {
        let got = expand_iso(
            "FREQ=DAILY",
            ymd(2026, 8, 9),
            ymd(2026, 8, 9),
            ymd(2026, 8, 12),
        );
        assert_eq!(got, ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]);
    }

    #[test]
    fn expand_daily_interval() {
        let got = expand_iso(
            "FREQ=DAILY;INTERVAL=3",
            ymd(2026, 8, 9),
            ymd(2026, 8, 9),
            ymd(2026, 8, 20),
        );
        assert_eq!(
            got,
            ["2026-08-09", "2026-08-12", "2026-08-15", "2026-08-18"]
        );
    }

    #[test]
    fn expand_weekly_without_byday_uses_seed_weekday() {
        // seed 는 일요일 → 매주 일요일
        let got = expand_iso(
            "FREQ=WEEKLY",
            ymd(2026, 8, 9),
            ymd(2026, 8, 1),
            ymd(2026, 9, 1),
        );
        assert_eq!(
            got,
            ["2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30"]
        );
    }

    #[test]
    fn expand_weekly_multi_byday() {
        // seed 2026-08-10 은 월요일. BYDAY=MO,WE,FR
        let got = expand_iso(
            "FREQ=WEEKLY;BYDAY=MO,WE,FR",
            ymd(2026, 8, 10),
            ymd(2026, 8, 10),
            ymd(2026, 8, 23),
        );
        assert_eq!(
            got,
            [
                "2026-08-10",
                "2026-08-12",
                "2026-08-14",
                "2026-08-17",
                "2026-08-19",
                "2026-08-21"
            ]
        );
    }

    #[test]
    fn expand_weekly_byday_skips_days_before_seed_in_seed_week() {
        // seed 는 수요일(8/12)인데 BYDAY 에 월요일이 있다 → seed 주의 월요일(8/10)은 안 나온다.
        let got = expand_iso(
            "FREQ=WEEKLY;BYDAY=MO,WE",
            ymd(2026, 8, 12),
            ymd(2026, 8, 1),
            ymd(2026, 8, 20),
        );
        assert_eq!(got, ["2026-08-12", "2026-08-17", "2026-08-19"]);
    }

    #[test]
    fn expand_weekly_interval_anchors_on_seed_week() {
        let got = expand_iso(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
            ymd(2026, 8, 11), // 화요일
            ymd(2026, 8, 1),
            ymd(2026, 9, 15),
        );
        assert_eq!(
            got,
            [
                "2026-08-11",
                "2026-08-13",
                "2026-08-25",
                "2026-08-27",
                "2026-09-08",
                "2026-09-10"
            ]
        );
    }

    #[test]
    fn expand_monthly_basic_and_interval() {
        let got = expand_iso(
            "FREQ=MONTHLY",
            ymd(2026, 1, 15),
            ymd(2026, 1, 1),
            ymd(2026, 5, 31),
        );
        assert_eq!(
            got,
            [
                "2026-01-15",
                "2026-02-15",
                "2026-03-15",
                "2026-04-15",
                "2026-05-15"
            ]
        );
        let got = expand_iso(
            "FREQ=MONTHLY;INTERVAL=3",
            ymd(2026, 1, 15),
            ymd(2026, 1, 1),
            ymd(2026, 12, 31),
        );
        assert_eq!(
            got,
            ["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]
        );
    }

    #[test]
    fn expand_monthly_skips_months_without_the_day() {
        // 1/31 매월 → 31일 없는 달은 통째로 건너뛴다(RFC 5545 기본 동작, §3.4).
        let got = expand_iso(
            "FREQ=MONTHLY",
            ymd(2026, 1, 31),
            ymd(2026, 1, 1),
            ymd(2026, 12, 31),
        );
        assert_eq!(
            got,
            [
                "2026-01-31",
                "2026-03-31",
                "2026-05-31",
                "2026-07-31",
                "2026-08-31",
                "2026-10-31",
                "2026-12-31"
            ]
        );
        // 30일도 2월만 빠진다
        let got = expand_iso(
            "FREQ=MONTHLY",
            ymd(2026, 1, 30),
            ymd(2026, 1, 1),
            ymd(2026, 4, 30),
        );
        assert_eq!(got, ["2026-01-30", "2026-03-30", "2026-04-30"]);
        // 29일은 윤년 2월에는 나온다
        let got = expand_iso(
            "FREQ=MONTHLY",
            ymd(2024, 1, 29),
            ymd(2024, 1, 1),
            ymd(2024, 3, 31),
        );
        assert_eq!(got, ["2024-01-29", "2024-02-29", "2024-03-29"]);
    }

    #[test]
    fn expand_yearly_leap_day_only_in_leap_years() {
        let got = expand_iso(
            "FREQ=YEARLY",
            ymd(2024, 2, 29),
            ymd(2024, 1, 1),
            ymd(2040, 12, 31),
        );
        assert_eq!(
            got,
            [
                "2024-02-29",
                "2028-02-29",
                "2032-02-29",
                "2036-02-29",
                "2040-02-29"
            ]
        );
        // 1900 은 세기 평년 → 스킵
        let got = expand_iso(
            "FREQ=YEARLY",
            ymd(1896, 2, 29),
            ymd(1896, 1, 1),
            ymd(1908, 12, 31),
        );
        assert_eq!(got, ["1896-02-29", "1904-02-29", "1908-02-29"]);
    }

    #[test]
    fn expand_yearly_interval() {
        let got = expand_iso(
            "FREQ=YEARLY;INTERVAL=5",
            ymd(2000, 6, 1),
            ymd(2000, 1, 1),
            ymd(2016, 12, 31),
        );
        assert_eq!(got, ["2000-06-01", "2005-06-01", "2010-06-01", "2015-06-01"]);
    }

    // ── expand: 범위·UNTIL 경계 ───────────────────────────────────────────────

    #[test]
    fn expand_never_emits_before_seed() {
        let got = expand_iso(
            "FREQ=DAILY",
            ymd(2026, 8, 9),
            ymd(2026, 1, 1),
            ymd(2026, 8, 11),
        );
        assert_eq!(got, ["2026-08-09", "2026-08-10", "2026-08-11"]);
    }

    #[test]
    fn expand_empty_when_window_before_seed_or_inverted() {
        assert!(expand_iso(
            "FREQ=DAILY",
            ymd(2026, 8, 9),
            ymd(2026, 1, 1),
            ymd(2026, 8, 8)
        )
        .is_empty());
        assert!(expand_iso(
            "FREQ=DAILY",
            ymd(2026, 8, 9),
            ymd(2026, 8, 20),
            ymd(2026, 8, 10)
        )
        .is_empty());
    }

    #[test]
    fn expand_until_is_inclusive() {
        // UNTIL 당일 회차는 나오고, 그 다음은 안 나온다.
        let got = expand_iso(
            "FREQ=DAILY;UNTIL=20260812",
            ymd(2026, 8, 9),
            ymd(2026, 8, 9),
            ymd(2026, 8, 31),
        );
        assert_eq!(got, ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]);
    }

    #[test]
    fn expand_until_only_narrows_never_widens() {
        // UNTIL 이 to 보다 뒤면 to 가 이긴다
        let got = expand_iso(
            "FREQ=DAILY;UNTIL=20301231",
            ymd(2026, 8, 9),
            ymd(2026, 8, 9),
            ymd(2026, 8, 10),
        );
        assert_eq!(got, ["2026-08-09", "2026-08-10"]);
        // UNTIL 이 조회 창보다 앞이면 결과 없음
        assert!(expand_iso(
            "FREQ=DAILY;UNTIL=20260810",
            ymd(2026, 8, 9),
            ymd(2026, 8, 20),
            ymd(2026, 8, 31)
        )
        .is_empty());
    }

    #[test]
    fn expand_until_cuts_weekly_and_monthly_at_the_boundary_day() {
        let got = expand_iso(
            "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260819",
            ymd(2026, 8, 10),
            ymd(2026, 8, 10),
            ymd(2026, 12, 31),
        );
        assert_eq!(
            got,
            [
                "2026-08-10",
                "2026-08-12",
                "2026-08-14",
                "2026-08-17",
                "2026-08-19"
            ]
        );
        let got = expand_iso(
            "FREQ=MONTHLY;UNTIL=20260315",
            ymd(2026, 1, 15),
            ymd(2026, 1, 1),
            ymd(2026, 12, 31),
        );
        assert_eq!(got, ["2026-01-15", "2026-02-15", "2026-03-15"]);
    }

    #[test]
    fn expand_single_occurrence_when_until_equals_seed() {
        let seed = ymd(2026, 8, 9);
        let parts = parse_for_seed("FREQ=DAILY;UNTIL=20260809", seed).unwrap();
        let (occ, capped) = expand(&parts, seed, ymd(2026, 1, 1), ymd(2026, 12, 31));
        assert_eq!(iso(&occ), ["2026-08-09"]);
        assert!(!capped);
    }

    // ── expand: BCE ───────────────────────────────────────────────────────────

    #[test]
    fn expand_handles_bce_seed() {
        let got = expand_iso("FREQ=YEARLY", ymd(-44, 3, 15), ymd(-44, 1, 1), ymd(-40, 12, 31));
        assert_eq!(
            got,
            [
                "-044-03-15",
                "-043-03-15",
                "-042-03-15",
                "-041-03-15",
                "-040-03-15"
            ]
        );
        // BCE→CE 를 가로지르는 daily 점프(연도 0 이 존재하는 프로렙틱 번호 체계라 손으로 세면
        // 틀린다 — 순진한 루프와 대조한다).
        let p = parse("FREQ=DAILY;INTERVAL=10").unwrap();
        let (seed, from, to) = (ymd(-1, 12, 25), ymd(1, 1, 1), ymd(1, 1, 20));
        assert_eq!(
            expand(&p, seed, from, to),
            naive_expand(&p, seed, from, to)
        );
        assert_eq!(expand(&p, seed, from, to).0.len(), 2);
    }

    // ── expand: 점프 vs 순진한 루프 ───────────────────────────────────────────

    /// 참조 구현: seed 부터 하루씩 전진하며 규칙 적합 여부를 직접 검사한다. 느리지만 명백하다.
    /// `expand` 의 점프 산술은 이것과 항상 같은 답을 내야 한다.
    fn naive_expand(
        parts: &RRuleParts,
        seed: NaiveYmd,
        from: NaiveYmd,
        to: NaiveYmd,
    ) -> (Vec<NaiveYmd>, bool) {
        let seed_ord = seed.to_ord();
        let mut hi = to.to_ord();
        if let Some(u) = parts.until {
            hi = hi.min(u.to_ord());
        }
        let lo = from.to_ord().max(seed_ord);
        let iv = parts.interval as i64;
        let days: Vec<i64> = if parts.byday.is_empty() {
            vec![weekday_idx(seed_ord)]
        } else {
            parts.byday.iter().map(|d| d.idx()).collect()
        };
        let mut out = Vec::new();
        let mut capped = false;
        let mut ord = lo;
        while ord <= hi {
            let c = ord_to_ymd(ord);
            let hit = match parts.freq {
                Freq::Daily => (ord - seed_ord) % iv == 0,
                Freq::Weekly => {
                    (week_index(ord) - week_index(seed_ord)) % iv == 0
                        && days.contains(&weekday_idx(ord))
                }
                Freq::Monthly => {
                    c.d == seed.d && (month_index(c.y, c.m) - month_index(seed.y, seed.m)) % iv == 0
                }
                Freq::Yearly => c.m == seed.m && c.d == seed.d && (c.y - seed.y) % iv == 0,
            };
            if hit {
                if out.len() >= OCCURRENCE_CAP {
                    capped = true;
                    break;
                }
                out.push(c);
            }
            ord += 1;
        }
        (out, capped)
    }

    #[test]
    fn jump_matches_naive_loop_when_from_is_far_from_seed() {
        // 10년 전 seed. 점프 산술이 off-by-one 없이 첫 회차를 맞히는지가 핵심.
        let seed = ymd(2016, 1, 31);
        let from = ymd(2026, 8, 1);
        let to = ymd(2026, 10, 31);
        for rule in [
            "FREQ=DAILY",
            "FREQ=DAILY;INTERVAL=7",
            "FREQ=DAILY;INTERVAL=13",
            "FREQ=WEEKLY",
            "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH,SU",
            "FREQ=MONTHLY",
            "FREQ=MONTHLY;INTERVAL=5",
            "FREQ=YEARLY",
        ] {
            let p = parse(rule).unwrap();
            assert_eq!(
                expand(&p, seed, from, to),
                naive_expand(&p, seed, from, to),
                "{rule}"
            );
        }
    }

    // 결정론적 LCG — 새 크레이트를 붙이지 않으려고 8줄로 끝낸다.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn range(&mut self, lo: i64, hi: i64) -> i64 {
            lo + (self.next() % ((hi - lo + 1) as u64)) as i64
        }
    }

    #[test]
    fn property_jump_matches_naive_loop_on_random_cases() {
        let mut rng = Rng(0x5EED_1234_ABCD_0001);
        // 오디널 범위: 대략 BCE 100 ~ CE 2200. ord_to_ymd 로 만들면 항상 실재하는 날짜다.
        let (ord_lo, ord_hi) = (ymd(-100, 1, 1).to_ord(), ymd(2200, 12, 31).to_ord());
        let mut nonempty = 0;
        for case in 0..300 {
            let seed = ord_to_ymd(rng.range(ord_lo, ord_hi));
            // from 은 seed 근처로도 멀리로도 — 점프가 먼 거리에서 특히 위험하다.
            let from = if case % 2 == 0 {
                ord_to_ymd(seed.to_ord() + rng.range(-3000, 3000))
            } else {
                ord_to_ymd(rng.range(ord_lo, ord_hi))
            };
            let span = rng.range(0, 1200);
            // 1/3 은 창을 그대로 두고(= seed 이전으로 통째로 떨어지는 경우 포함), 2/3 은 시리즈
            // 시작 이후를 덮게 해서 실제 회차가 나오도록 한다.
            let base = if case % 3 == 0 {
                from.to_ord()
            } else {
                from.to_ord().max(seed.to_ord())
            };
            let to = ord_to_ymd(base + span);
            let freq = match rng.range(0, 3) {
                0 => Freq::Daily,
                1 => Freq::Weekly,
                2 => Freq::Monthly,
                _ => Freq::Yearly,
            };
            let interval = rng.range(1, 6) as u32;
            let byday: Vec<Weekday> = if freq == Freq::Weekly && rng.range(0, 1) == 1 {
                let mut v: Vec<Weekday> = (0..7)
                    .filter(|_| rng.range(0, 2) == 0)
                    .map(weekday_from_idx)
                    .collect();
                if v.is_empty() {
                    v.push(weekday_from_idx(rng.range(0, 6)));
                }
                v.sort();
                v
            } else {
                Vec::new()
            };
            // UNTIL 은 절반의 케이스에만, 그리고 seed 이후로만(파서 규칙과 같은 조건).
            let until = if rng.range(0, 1) == 1 {
                Some(ord_to_ymd(seed.to_ord() + rng.range(0, 2000)))
            } else {
                None
            };
            let parts = RRuleParts {
                freq,
                interval,
                byday,
                until,
            };
            let got = expand(&parts, seed, from, to);
            assert_eq!(
                got,
                naive_expand(&parts, seed, from, to),
                "case {case}: {parts:?} seed={} from={} to={}",
                seed.to_iso(),
                from.to_iso(),
                to.to_iso()
            );
            if !got.0.is_empty() {
                nonempty += 1;
            }
        }
        // 창이 통째로 seed 이전으로 떨어지면 양쪽 다 빈 결과라 아무것도 검증하지 못한다.
        // 실제로 회차가 나온 케이스가 충분한지 못 박는다.
        assert!(nonempty > 100, "property test was near-vacuous: {nonempty}");
    }

    #[test]
    fn property_month_end_and_leap_seeds_match_naive_loop() {
        // 무작위로는 잘 안 뽑히는 날(29·30·31일, 2/29)만 따로 두껍게.
        let mut rng = Rng(0xC0FF_EE00_1234_5678);
        let mut nonempty = 0;
        let seeds = [
            ymd(2024, 1, 29),
            ymd(2024, 1, 30),
            ymd(2024, 1, 31),
            ymd(2024, 2, 29),
            ymd(2023, 2, 28),
            ymd(2026, 3, 31),
            ymd(2000, 2, 29),
            ymd(1900, 2, 28),
            ymd(2026, 12, 31),
            ymd(-4, 2, 29),
        ];
        for seed in seeds {
            for freq in [Freq::Monthly, Freq::Yearly, Freq::Daily, Freq::Weekly] {
                for interval in [1u32, 2, 4, 7] {
                    let from = ord_to_ymd(seed.to_ord() + rng.range(-400, 900));
                    let to = ord_to_ymd(from.to_ord() + rng.range(0, 1500));
                    let parts = RRuleParts {
                        freq,
                        interval,
                        byday: Vec::new(),
                        until: None,
                    };
                    let got = expand(&parts, seed, from, to);
                    assert_eq!(
                        got,
                        naive_expand(&parts, seed, from, to),
                        "{parts:?} seed={}",
                        seed.to_iso()
                    );
                    if !got.0.is_empty() {
                        nonempty += 1;
                    }
                }
            }
        }
        assert!(nonempty > 100, "property test was near-vacuous: {nonempty}");
    }

    // ── expand: CAP ───────────────────────────────────────────────────────────

    #[test]
    fn expand_caps_and_reports_it() {
        let p = parse("FREQ=DAILY").unwrap();
        let seed = ymd(2026, 1, 1);
        // 정확히 CAP 개 → 자르지 않음
        let to = ord_to_ymd(seed.to_ord() + OCCURRENCE_CAP as i64 - 1);
        let (occ, capped) = expand(&p, seed, seed, to);
        assert_eq!(occ.len(), OCCURRENCE_CAP);
        assert!(!capped);
        // CAP+1 개가 있었으면 잘리고 capped=true
        let to = ord_to_ymd(seed.to_ord() + OCCURRENCE_CAP as i64);
        let (occ, capped) = expand(&p, seed, seed, to);
        assert_eq!(occ.len(), OCCURRENCE_CAP);
        assert!(capped);
        assert_eq!(occ[0], seed);
        // 무한 반복(UNTIL 없음) + 아주 넓은 창
        let (occ, capped) = expand(&p, seed, seed, ymd(2099, 12, 31));
        assert_eq!(occ.len(), OCCURRENCE_CAP);
        assert!(capped);
    }

    #[test]
    fn expand_caps_weekly_multi_byday() {
        let p = parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU").unwrap();
        let seed = ymd(2026, 1, 1);
        let (occ, capped) = expand(&p, seed, seed, ymd(2030, 12, 31));
        assert_eq!(occ.len(), OCCURRENCE_CAP);
        assert!(capped);
    }

    // ── 직렬화 계약 (§3.3) ────────────────────────────────────────────────────

    #[test]
    fn serializes_to_the_ts_contract() {
        let p = parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231").unwrap();
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["freq"], "WEEKLY");
        assert_eq!(j["interval"], 2);
        assert_eq!(j["byday"], serde_json::json!(["MO", "FR"]));
        assert_eq!(p.until_iso().as_deref(), Some("2026-12-31"));
        let p = parse("FREQ=DAILY").unwrap();
        assert_eq!(p.until_iso(), None);
    }
}
