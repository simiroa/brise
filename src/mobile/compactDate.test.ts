import { describe, it, expect } from "vitest";
import { formatCompactDate } from "./compactDate";

const NOW = new Date(2026, 6, 29, 15, 0, 0); // 2026-07-29 15:00 local

describe("formatCompactDate", () => {
  it("formats a non-empty string for today and for an older date, in each supported locale", () => {
    for (const lang of ["ko", "en", "fr"]) {
      expect(formatCompactDate("2026-07-29T09:00:00.000Z", lang, NOW).length).toBeGreaterThan(0);
      expect(formatCompactDate("2020-01-01T09:00:00.000Z", lang, NOW).length).toBeGreaterThan(0);
    }
  });

  it("today shows the time of day; an older date shows month/day, plus the year only when it is not this year", () => {
    const sameDay = new Date(2026, 6, 29, 9, 5, 0).toISOString();
    const sameYear = new Date(2026, 2, 3, 9, 0, 0).toISOString();
    const otherYear = new Date(2020, 0, 1, 9, 0, 0).toISOString();
    expect(formatCompactDate(sameDay, "en", NOW)).toMatch(/\d{1,2}:05/);
    expect(formatCompactDate(sameYear, "en", NOW)).not.toMatch(/2026/);
    expect(formatCompactDate(sameYear, "en", NOW)).not.toMatch(/:/);
    expect(formatCompactDate(otherYear, "en", NOW)).toMatch(/2020/);
  });

  it("a timestamp ahead of now (clock skew) still counts as today; an invalid one renders empty", () => {
    const tomorrow = new Date(2026, 6, 30, 9, 5, 0).toISOString();
    expect(formatCompactDate(tomorrow, "en", NOW)).toMatch(/\d{1,2}:05/);
    expect(formatCompactDate("not-a-date", "en", NOW)).toBe("");
  });
});
