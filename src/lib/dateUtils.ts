/**
 * Centralized pure date/calendar/timeline utility functions for Brise.
 * Eliminates duplicate leap year, month days, date comparison, and range overlap calculations.
 */

/** Check whether a year is a leap year (Gregorian). */
export function isLeapYear(year: number): boolean {
  if (!Number.isFinite(year)) return false;
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Get the number of days in a month (1-indexed month: 1=Jan, 12=Dec). */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return 30;
  }
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

export type DateTriple = {
  year: number;
  month?: number | null;
  day?: number | null;
};

/**
 * Compare two date triples chronologically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareDates(a: DateTriple, b: DateTriple): number {
  if (a.year !== b.year) return a.year - b.year;
  const ma = a.month ?? 1;
  const mb = b.month ?? 1;
  if (ma !== mb) return ma - mb;
  const da = a.day ?? 1;
  const db = b.day ?? 1;
  return da - db;
}

/**
 * Convert year, month (1-12), day into fractional year representation for smooth continuous timelines.
 */
export function toFractionalYear(year: number, month?: number | null, day?: number | null): number {
  const m = month ? Math.max(1, Math.min(12, month)) : 1;
  const totalDays = daysInMonth(year, m);
  const d = day ? Math.max(1, Math.min(totalDays, day)) : 1;
  const monthFraction = (m - 1) / 12;
  const dayFraction = (d - 1) / (totalDays * 12);
  return year + monthFraction + dayFraction;
}

/**
 * Check if a date falls within a given closed range [start, end].
 */
export function isDateInRange(
  date: DateTriple,
  start?: DateTriple | null,
  end?: DateTriple | null,
): boolean {
  if (start && compareDates(date, start) < 0) return false;
  if (end && compareDates(date, end) > 0) return false;
  return true;
}

/**
 * Check if two 1D numeric ranges [startA, endA] and [startB, endB] overlap.
 */
export function doRangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  const [minA, maxA] = startA <= endA ? [startA, endA] : [endA, startA];
  const [minB, maxB] = startB <= endB ? [startB, endB] : [endB, startB];
  return Math.max(minA, minB) <= Math.min(maxA, maxB);
}

/**
 * Format date triple into a human-readable string.
 */
export function formatDateString(
  year: number,
  month?: number | null,
  day?: number | null,
): string {
  if (month == null || month <= 0) return `${year}`;
  const mm = String(month).padStart(2, "0");
  if (day == null || day <= 0) return `${year}-${mm}`;
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Format a date/timestamp relative to now (or a specified base time)
 * using Intl.RelativeTimeFormat (e.g. "5 minutes ago", "어제", "내일").
 */
export function formatRelativeTime(
  date: string | number | Date,
  lang: string = "en",
  baseTime: number | Date = Date.now(),
): string {
  const targetMs = typeof date === "number" ? date : new Date(date).getTime();
  if (!Number.isFinite(targetMs)) return "";
  const nowMs = typeof baseTime === "number" ? baseTime : new Date(baseTime).getTime();
  if (!Number.isFinite(nowMs)) return "";

  const diffMs = targetMs - nowMs;
  const abs = Math.abs(diffMs);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  const rtf = new Intl.RelativeTimeFormat(lang || "en", { numeric: "auto" });
  if (abs < MIN) return rtf.format(Math.round(diffMs / 1000), "second");
  if (abs < HOUR) return rtf.format(Math.round(diffMs / MIN), "minute");
  if (abs < DAY) return rtf.format(Math.round(diffMs / HOUR), "hour");
  return rtf.format(Math.round(diffMs / DAY), "day");
}

