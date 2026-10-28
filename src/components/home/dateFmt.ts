/**
 * Local date-format helpers shared across the home dashboard tabs — dedupes the
 * `padStart(2, "0")` combos that used to live separately in CalendarTab and grassGrid.
 */

import { toIsoDateLocal } from "../titlebar/dueDate";
export { toIsoDateLocal };

/** Today in local time as { year, month (0-11), day (YYYY-MM-DD) }. Shared by CalendarTab and CalendarExpanded. */
export function todayLocal(): { year: number; month: number; day: string } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth(),
    day: toIsoDateLocal(now),
  };
}

/** "YYYY-MM-DD" 에 n 일을 더한다 — UTC 산술이라 DST·타임존에 흔들리지 않는다. 형식이 깨졌으면 null.
 *  날짜 더하기의 **유일한 구현**이다(예전엔 달력 다이얼로그 파일의 `addDaysIso` 와 브리핑 훅 파일의 `dayAfter` 가 같은 계산을 따로 가졌다 —
 *  브리핑의 `dayAfter` 는 이 함수에 "깨졌으면 입력 그대로" 폴백을 얹은 얇은 별칭이다). */
export function addDaysIso(iso: string, days: number): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** "YYYY-MM" prefix for a given year + 1-based month (calendar month-nav comparisons). */
export function yearMonthPrefix(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, "0")}`;
}

/**
 * ISO 날짜 문자열("YYYY-MM-DD") → 그 요일의 비트(월=비트0 .. 일=비트6, ISO 순서 고정) —
 * `timeline_routines.weekday_mask` 와 같은 순서(specs/db/schemas/timeline_routines.sql 헤더).
 * UTC 로 파싱한다(다른 파싱 없는 순수 날짜 문자열 계산과 같은 관례 — parseIsoDay/calendarLayout
 * 와 동일하게 타임존에 흔들리지 않는다). 형식이 깨졌으면 0(어느 요일 비트와도 겹치지 않음 —
 * weekday_mask 는 1..127 만 유효하므로 필터에서 자연히 아무 루틴도 걸리지 않는다).
 */
export function isoWeekdayBit(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return 0;
  // JS getUTCDay(): 0=일 .. 6=토. ISO 순서(0=월..6=일)로 옮긴다.
  const isoIndex = (d.getUTCDay() + 6) % 7;
  return 1 << isoIndex;
}

/**
 * Weekday short labels ("Sun".."Sat", localized) for a calendar header — 2023-01-01 (UTC) was a
 * Sunday, used as a stable reference so the labels never depend on the actually-viewed year/month.
 * weekStart shifts the starting offset for a Monday-first grid. Shared by CalendarTab/
 * CalendarExpanded/DateRangeCalendar (Wave R1-b dedup — this Intl block was hand-copied 3x).
 */
export function weekdayShortLabels(uiLang: string, weekStart: "sunday" | "monday" = "sunday"): string[] {
  const fmt = new Intl.DateTimeFormat(uiLang || "en", { weekday: "short", timeZone: "UTC" });
  const offset = weekStart === "monday" ? 2 : 1;
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, offset + i))));
}

/** "August 2026" style long month label (UTC, month is 0-11). Shared by CalendarTab/CalendarExpanded. */
export function monthLongLabel(uiLang: string, year: number, month0: number): string {
  return new Intl.DateTimeFormat(uiLang || "en", { year: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month0, 1)),
  );
}

/**
 * Axis tick label for the home timeline (Wave 5 L5-2).
 * - year steps (≥1): "2026"
 * - month steps: "8월" / "Aug" / "août" (uiLang)
 * - day / week steps: "8/3"
 *
 * `fracYear` is the continuous axis domain (year + dayOfYear/daysInYear); calendar fields are
 * recovered by the layout helpers so leap years stay consistent with positioning.
 *
 * Not only ticks call this — item tooltips, the drag chips and the create popover format real
 * dates with it too (ItemsLayer.spanLabel, TimelineTab.fmtBoundary). So the year branch rounds
 * only a value sitting on a year boundary (a tick, which may arrive as 2026.9999999 from step
 * arithmetic — `parts` would floor that to Dec 31 of the year before); any other value is a date
 * inside a year and reads its own `parts.year`. Rounding everything turned 2026-07-29 into "2027"
 * on a year axis (2026-10-19 screen board).
 */
export function formatTimelineTick(
  fracYear: number,
  step: number,
  uiLang: string,
  parts: { year: number; month: number; day: number },
): string {
  if (step >= 1 - 1e-9) {
    const nearest = Math.round(fracYear);
    // 1e-6 yr ≈ 30 s — far below one day (≥ 1/366 yr), so no real date is mistaken for a boundary.
    return String(Math.abs(fracYear - nearest) < 1e-6 ? nearest : parts.year);
  }
  if (step >= 1 / 12 - 1e-9) {
    return formatMonthShort(parts.month, uiLang);
  }
  return `${parts.month}/${parts.day}`;
}

/** "8월" (ko) / "Aug" (en) / short month (fr) — 1-based month. */
export function formatMonthShort(month1: number, uiLang: string): string {
  const m = Math.min(12, Math.max(1, Math.round(month1)));
  if (uiLang === "ko") return `${m}월`;
  const locale = uiLang === "fr" ? "fr-FR" : "en-US";
  // Fixed non-leap year so Intl only depends on month.
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2001, m - 1, 1));
}

/** Compact view-range bound for the timeline header / brush aria (avoids long floats). */
export function formatTimelineViewBound(fracYear: number, span: number): string {
  if (!(span > 0) || span >= 2) return String(Math.round(fracYear));
  if (span >= 1 / 6) {
    // Month-ish window: YYYY-MM
    const y = Math.floor(fracYear);
    const monthFrac = (fracYear - y) * 12;
    const m = Math.min(12, Math.max(1, Math.floor(monthFrac) + 1));
    return `${y}-${String(m).padStart(2, "0")}`;
  }
  // Day-scale window: keep two decimals of fractional year (stable, short).
  return fracYear.toFixed(2);
}

/**
 * Shared year-range join for sidebar filter + dashboard timeline (Wave 5 L5-3).
 * Accepts already-formatted bound labels (integer years, YYYY-MM, or fractional strings)
 * so both surfaces never drift on separator / single-year collapse.
 * En dash (–) matches formatEventDateRange and brush aria-valuetext.
 */
export function formatYearRange(from: string | number, to: string | number): string {
  const a = String(from);
  const b = String(to);
  if (a === b) return a;
  return `${a} – ${b}`;
}
