/**
 * Public holidays by region — consumed by the dashboard calendar (month + year grids) to paint a
 * day number red and label it. Setting key `holiday_region` (settings_schema.rs allowlist,
 * docs/SETTINGS.md §2.2), surfaced in 설정 > 달력 및 일정 (moved there 2026-09-19 —
 * docs/PLAN-2026-09-19-calendar-schedule.md §0; it used to sit under 보기/지역).
 *
 * **2027·2028 설날은 중국 춘절과 하루 다르다**(2026-09-19 정정). 두 해 모두 합삭이 UTC 15~16시라
 * 베이징(UTC+8)에선 그날 밤, 서울(UTC+9)에선 **다음 날 0시대**다 — 음력 1월 1일이 한국에서 하루 늦다
 * (2027-02-07, 2028-01-27). 이 표는 원래 춘절 날짜(02-06, 01-26)로 들어가 있었고, 음력 기념일
 * (lib/lunar.ts, ICU dangi = 한국 기준)이 들어오면서 "표의 설날"과 "음력 1.1 표시일"이 다른 날에
 * 찍히게 돼 드러났다. holidays.test.ts 가 표의 음력 공휴일 전부를 lunar.ts 와 대조해 봉인한다 —
 * 표를 2031 이후로 늘릴 때 같은 실수를 테스트가 잡는다.
 *
 * ponytail: static table, 2024–2030 only. Korean lunar holidays (설날·추석·부처님오신날) and the
 * 대체공휴일 rules (관공서의 공휴일에 관한 규정 §3) are baked in as resolved dates rather than
 * computed — a lunar-calendar converter + substitution engine is more code than seven years of
 * data. Names are Korean only (proper nouns; the UI locale doesn't change what the day is called
 * on Korean calendars). Upgrade path when the table runs out: extend the rows, or fetch from a
 * holiday API (e.g. Nager.Date) into the same Map shape — callers only see holidaysForYear().
 */
import type { HolidayRegion } from "../stores/settings";
import { reportFallback } from "./diag";

export const HOLIDAY_REGIONS = ["none", "kr"] as const;

/** Rows are [MM-DD, name]. One row per day; a day shared by two holidays gets one merged label. */
const KR: Record<number, [string, string][]> = {
  2024: [
    ["01-01", "신정"], ["02-09", "설날 연휴"], ["02-10", "설날"], ["02-11", "설날 연휴"], ["02-12", "대체공휴일"],
    ["03-01", "삼일절"], ["04-10", "국회의원 선거일"], ["05-05", "어린이날"], ["05-06", "대체공휴일"],
    ["05-15", "부처님오신날"], ["06-06", "현충일"], ["08-15", "광복절"], ["09-16", "추석 연휴"], ["09-17", "추석"],
    ["09-18", "추석 연휴"], ["10-01", "국군의 날"], ["10-03", "개천절"], ["10-09", "한글날"], ["12-25", "크리스마스"],
  ],
  2025: [
    ["01-01", "신정"], ["01-27", "임시공휴일"], ["01-28", "설날 연휴"], ["01-29", "설날"], ["01-30", "설날 연휴"],
    ["03-01", "삼일절"], ["03-03", "대체공휴일"], ["05-05", "어린이날 · 부처님오신날"], ["05-06", "대체공휴일"],
    ["06-03", "대통령 선거일"], ["06-06", "현충일"], ["08-15", "광복절"], ["10-03", "개천절"], ["10-05", "추석 연휴"],
    ["10-06", "추석"], ["10-07", "추석 연휴"], ["10-08", "대체공휴일"], ["10-09", "한글날"], ["12-25", "크리스마스"],
  ],
  2026: [
    ["01-01", "신정"], ["02-16", "설날 연휴"], ["02-17", "설날"], ["02-18", "설날 연휴"], ["03-01", "삼일절"],
    ["03-02", "대체공휴일"], ["05-05", "어린이날"], ["05-24", "부처님오신날"], ["05-25", "대체공휴일"],
    ["06-03", "지방선거일"], ["06-06", "현충일"], ["08-15", "광복절"], ["08-17", "대체공휴일"], ["09-24", "추석 연휴"],
    ["09-25", "추석"], ["09-26", "추석 연휴"], ["10-03", "개천절"], ["10-05", "대체공휴일"], ["10-09", "한글날"],
    ["12-25", "크리스마스"],
  ],
  2027: [
    ["01-01", "신정"], ["02-06", "설날 연휴"], ["02-07", "설날"], ["02-08", "설날 연휴"], ["02-09", "대체공휴일"],
    ["03-01", "삼일절"], ["05-05", "어린이날"], ["05-13", "부처님오신날"], ["06-06", "현충일"], ["08-15", "광복절"],
    ["08-16", "대체공휴일"], ["09-14", "추석 연휴"], ["09-15", "추석"], ["09-16", "추석 연휴"], ["10-03", "개천절"],
    ["10-04", "대체공휴일"], ["10-09", "한글날"], ["10-11", "대체공휴일"], ["12-25", "크리스마스"], ["12-27", "대체공휴일"],
  ],
  2028: [
    ["01-01", "신정"], ["01-26", "설날 연휴"], ["01-27", "설날"], ["01-28", "설날 연휴"], ["03-01", "삼일절"],
    ["04-12", "국회의원 선거일"], ["05-02", "부처님오신날"], ["05-05", "어린이날"], ["06-06", "현충일"],
    ["08-15", "광복절"], ["10-02", "추석 연휴"], ["10-03", "추석 · 개천절"], ["10-04", "추석 연휴"],
    ["10-05", "대체공휴일"], ["10-09", "한글날"], ["12-25", "크리스마스"],
  ],
  2029: [
    ["01-01", "신정"], ["02-12", "설날 연휴"], ["02-13", "설날"], ["02-14", "설날 연휴"], ["03-01", "삼일절"],
    ["05-05", "어린이날"], ["05-07", "대체공휴일"], ["05-20", "부처님오신날"], ["05-21", "대체공휴일"],
    ["06-06", "현충일"], ["08-15", "광복절"], ["09-21", "추석 연휴"], ["09-22", "추석"], ["09-23", "추석 연휴"],
    ["09-24", "대체공휴일"], ["10-03", "개천절"], ["10-09", "한글날"], ["12-25", "크리스마스"],
  ],
  2030: [
    ["01-01", "신정"], ["02-02", "설날 연휴"], ["02-03", "설날"], ["02-04", "설날 연휴"], ["02-05", "대체공휴일"],
    ["03-01", "삼일절"], ["05-05", "어린이날"], ["05-06", "대체공휴일"], ["05-09", "부처님오신날"],
    ["06-06", "현충일"], ["08-15", "광복절"], ["09-11", "추석 연휴"], ["09-12", "추석"], ["09-13", "추석 연휴"],
    ["10-03", "개천절"], ["10-09", "한글날"], ["12-25", "크리스마스"],
  ],
};

const EMPTY: ReadonlyMap<string, string> = new Map();

// A(AUDIT-2026-09-26): 표 밖 연도는 매 호출(달력 렌더마다 몇 번씩)마다 조용히 빈 맵을 돌려준다 —
// 흔적을 남기되 렌더마다 스팸이 되지 않게 연도별로 세션 1회만 보고한다(diag.ts 자체 디듀프는
// (feature,code,level) 하나만 보므로 여러 해가 동시에 표 밖이면 첫 해만 남고 나머지는 씹힌다).
const reportedMissingYears = new Set<number>();

/** ISO day (YYYY-MM-DD) → holiday name for one year. Empty for region "none" or a year past the table. */
export function holidaysForYear(region: HolidayRegion, year: number): ReadonlyMap<string, string> {
  if (region !== "kr") return EMPTY;
  const rows = KR[year];
  if (!rows) {
    if (!reportedMissingYears.has(year)) {
      reportedMissingYears.add(year);
      reportFallback("holidays", "year_out_of_table", `year=${year}`);
    }
    return EMPTY;
  }
  return new Map(rows.map(([md, name]) => [`${year}-${md}`, name]));
}
