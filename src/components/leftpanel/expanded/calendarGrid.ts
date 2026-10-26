/**
 * Pure month-grid math for CalendarExpanded (§2.2 HANDOFF-calendar-onboarding.md).
 * UTC throughout — note_record_histogram (axis:"union") buckets created_at/updated_at by UTC
 * calendar day (substr(ts,1,10)), so the grid must use the same day boundary the counts and the
 * day-click note lists (created_from/created_to, updated_from/updated_to) are keyed on. A note
 * created or edited at 23:30 local time near midnight can land in the UTC-adjacent day's cell;
 * this is the same documented cost the §2.8 date-range chips already accepted, not new here.
 */

import { daysInMonth } from "../../../lib/dateUtils";

export type CalendarCell = { day: string; dayOfMonth: number } | { day: null; dayOfMonth: null };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/**
 * UTC month grid, padded with null cells to full weeks — weekStart lets a caller (CalendarTab)
 * start weeks on Monday instead of Sunday (Wave R1-b dedup: this used to be a second, hand-synced
 * copy in home/calendarLayout.ts differing only in the weekStart offset; that file now re-exports
 * this one).
 */
export function buildCalendarGridCustom(
  year: number,
  month: number,
  weekStart: "sunday" | "monday" = "sunday",
): CalendarCell[] {
  const total = daysInMonth(year, month + 1);
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const padStart = weekStart === "monday" ? (firstWeekday + 6) % 7 : firstWeekday;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < padStart; i++) cells.push({ day: null, dayOfMonth: null });
  for (let d = 1; d <= total; d++) cells.push({ day: isoDay(year, month, d), dayOfMonth: d });
  while (cells.length % 7 !== 0) cells.push({ day: null, dayOfMonth: null });
  return cells;
}

/** Sunday-first weeks for a UTC month — same as buildCalendarGridCustom(year, month, "sunday"). */
export function buildCalendarGrid(year: number, month: number): CalendarCell[] {
  return buildCalendarGridCustom(year, month, "sunday");
}

/** Inclusive from/to for note_record_histogram covering the full UTC month. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: isoDay(year, month, 1), to: isoDay(year, month, daysInMonth(year, month + 1)) };
}

/** Add `delta` months to (year, month), rolling the year over as needed. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/**
 * PLAN-2026-09-11 사이드바 W2 D6 — 오늘 할 일 탭의 `day` 가 보는 달 밖이면 그 달({year, month
 * 0-11})을 준다(`dashboard_calendar` 를 하나 더 부를 달). 같은 달이면 null — 호출은 1회 그대로.
 * `day` 는 ISO "YYYY-MM-DD" 라 문자열 자리로 판정한다(Date 왕복 없음, UTC/로컬 표류 없음).
 */
export function dayFetchMonth(
  day: string,
  viewYear: number,
  viewMonth: number
): { year: number; month: number } | null {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1;
  return year === viewYear && month === viewMonth ? null : { year, month };
}
