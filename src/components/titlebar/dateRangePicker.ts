/**
 * Airline-booking-style range selection — pure state machine, no DOM. Drives DateRangeCalendar's
 * click/drag handling and DateBadge's draft state (docs/DASHBOARD.md §2 popover redesign,
 * 2026-08-01 owner decision — grid replaces the old start `<input type=date>` + end number
 * spinners).
 *
 * Rule (owner spec): first click on a day = start, clearing any prior end. A later second click
 * = end (range highlighted between). A further click (once a range is already complete) starts a
 * new selection. A click on a day *before* the current start also starts a new selection (rather
 * than reversing/swapping) — same rule, "before" just means "not a later day". A single click
 * with no second click yet = start date only, no end. Drag-select goes straight to a complete
 * range on release, bypassing the two-click phase entirely.
 *
 * `phase` is the one bit of state the props (start/end triples) can't reconstruct on their own:
 * an existing note that already has a full-precision start with no end looks identical, prop-wise,
 * to "the user just picked this start and is now choosing an end" — but a fresh popover open must
 * treat the very next click as a new start, not as completing a stale range. DateBadge resets
 * `phase` to "idle" whenever the popover opens.
 */
import { formatEventDate, type EventDate, type EventEnd } from "./eventDate";

export type RangePhase = "idle" | "picking-end";

/** A grid day always has full year/month/day precision — unlike EventDate/EventEnd, which allow
 * nulls for the badge's coarser-precision states. */
export type ConcreteDate = { year: number; month: number; day: number };

export type PickResult = { start: EventDate; end: EventEnd; phase: RangePhase };

const EMPTY_END: EventEnd = { end_year: null, end_month: null, end_day: null };

/** True when `a` is chronologically before `b`. Missing month/day = earliest (0) — same
 * convention eventDate.ts::isStartAfterEnd already uses for coarse-precision boundaries. */
export function isBeforeDate(a: EventDate, b: EventDate): boolean {
  if (a.year !== b.year) return a.year < b.year;
  const am = a.month ?? 0;
  const bm = b.month ?? 0;
  if (am !== bm) return am < bm;
  return (a.day ?? 0) < (b.day ?? 0);
}

export function isSameDate(a: EventDate, b: EventDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** One grid-day click, given the picker's current draft start/phase (the existing end doesn't
 * matter here — this either clears it fresh or replaces it outright). */
export function pickDay(clicked: ConcreteDate, start: EventDate, phase: RangePhase): PickResult {
  if (phase === "picking-end" && !isBeforeDate(clicked, start)) {
    return {
      start,
      end: { end_year: clicked.year, end_month: clicked.month, end_day: clicked.day },
      phase: "idle",
    };
  }
  // idle (fresh selection), or clicked before the current start: either way, this day becomes
  // the new start and any prior end is dropped.
  return { start: clicked, end: EMPTY_END, phase: "picking-end" };
}

/** A completed drag gesture between two grid days (order-independent) — always a fresh, complete
 * range, same as picking start then a later end in two clicks. */
export function dragRange(a: ConcreteDate, b: ConcreteDate): PickResult {
  const [lo, hi] = isBeforeDate(b, a) ? [b, a] : [a, b];
  return {
    start: lo,
    end: { end_year: hi.year, end_month: hi.month, end_day: hi.day },
    phase: "idle",
  };
}

/** Grid cell highlight state, for DateRangeCalendar's rendering. */
export type CellHighlight = "start" | "end" | "in-range" | "none";

export function cellHighlight(day: ConcreteDate, start: EventDate, end: EventEnd): CellHighlight {
  const isStart = isSameDate(day, start);
  const hasEnd = end.end_year != null;
  const endDate: EventDate = { year: end.end_year ?? 0, month: end.end_month, day: end.end_day };
  const isEnd = hasEnd && isSameDate(day, endDate);
  if (isStart) return "start"; // same-day range (isStart && isEnd) still reads as "start" — one cell, one dot.
  if (isEnd) return "end";
  if (hasEnd && isBeforeDate(start, day) && isBeforeDate(day, endDate)) return "in-range";
  return "none";
}

/** Compact fallback-input value for one axis ("" when unset) — reuses the same YYYY[.MM[.DD]]
 * notation as the badge/double-click edit path (eventDate.ts::formatEventDate/parseEventDateInput). */
export function formatFallbackValue(year: number | null, month: number | null, day: number | null): string {
  if (year == null) return "";
  return formatEventDate(year, month, day);
}
