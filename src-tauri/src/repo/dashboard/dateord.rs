// repo: dashboard/dateord — proleptic YMD ordinal arithmetic. Shared by board pin/sort and
// calendar span clipping. Delegates to chrono's NaiveDate (proleptic Gregorian, supports
// ±262143 years) instead of a hand-rolled Howard-Hinnant reimplementation — app's valid year
// range is ±9999 (notes.year CHECK), comfortably inside chrono's range.
// ponytail: chrono 위임, 앱 범위 ±9999는 chrono 한계(±262143) 한참 안쪽.
use chrono::{Datelike, NaiveDate};

// Visibility widened from pub(super) to pub: repo::schedule::rrule reuses this ordinal arithmetic
// for RRULE occurrence expansion (PLAN-schedule-system.md §3.4 — "새 날짜 타입을 만들지 않는다").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NaiveYmd {
    pub y: i64,
    pub m: u32,
    pub d: u32,
}

impl NaiveYmd {
    pub fn to_iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }

    /// Proleptic ordinal (days since chrono's CE epoch). The absolute value has no meaning of its
    /// own — callers (board.rs/calendar.rs) only ever compare/clip ords produced by this same
    /// function, never a stored or externally-fixed number.
    ///
    /// Panics if `(y, m, d)` isn't a real calendar date. Only safe on triples already known-valid
    /// (constructed via days_in_month clamping, or an already-validated seed) — for a triple built
    /// straight from raw DB columns (write-time validation only checks numeric ranges, not calendar
    /// legality — e.g. day=30/month=2 passes), use `checked_ord` instead.
    pub fn to_ord(self) -> i64 {
        self.checked_ord()
            .expect("NaiveYmd out of chrono's supported year range or not a real calendar date")
    }

    /// Like `to_ord`, but returns `None` instead of panicking when `(y, m, d)` isn't a real
    /// calendar date (e.g. a stored Feb 30) or is outside chrono's supported year range.
    pub fn checked_ord(self) -> Option<i64> {
        NaiveDate::from_ymd_opt(self.y as i32, self.m, self.d).map(|d| d.num_days_from_ce() as i64)
    }
}

pub fn ord_to_ymd(ord: i64) -> NaiveYmd {
    let date = NaiveDate::from_num_days_from_ce_opt(ord as i32)
        .expect("ord out of chrono's supported year range");
    NaiveYmd {
        y: date.year() as i64,
        m: date.month(),
        d: date.day(),
    }
}

pub(super) fn is_leap(y: i64) -> bool {
    NaiveDate::from_ymd_opt(y as i32, 1, 1)
        .map(|d| d.leap_year())
        .unwrap_or(false)
}

pub fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ymd_ord_roundtrip_boundary_tests() {
        let cases = vec![
            NaiveYmd { y: 2024, m: 2, d: 29 },   // Leap day
            NaiveYmd { y: 2000, m: 2, d: 29 },   // Century leap year
            NaiveYmd { y: 1900, m: 2, d: 28 },   // Century non-leap year
            NaiveYmd { y: 2023, m: 12, d: 31 },  // Year boundary end
            NaiveYmd { y: 2024, m: 1, d: 1 },    // Year boundary start
            NaiveYmd { y: 0, m: 1, d: 1 },       // Year 0 boundary
            NaiveYmd { y: -44, m: 3, d: 15 },    // BC year
            NaiveYmd { y: -400, m: 2, d: 29 },   // BC century leap year
        ];
        for ymd in cases {
            let ord = ymd.to_ord();
            let back = ord_to_ymd(ord);
            assert_eq!(back.y, ymd.y, "Year mismatch for {ymd:?}");
            assert_eq!(back.m, ymd.m, "Month mismatch for {ymd:?}");
        }
    }
}
