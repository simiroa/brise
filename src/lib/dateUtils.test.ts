import { describe, expect, it } from "vitest";
import {
  compareDates,
  daysInMonth,
  doRangesOverlap,
  formatDateString,
  formatRelativeTime,
  isDateInRange,
  isLeapYear,
  toFractionalYear,
} from "./dateUtils";

describe("dateUtils", () => {
  describe("isLeapYear", () => {
    it("identifies standard leap years and century exceptions correctly", () => {
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2000)).toBe(true);
      expect(isLeapYear(1900)).toBe(false);
      expect(isLeapYear(2023)).toBe(false);
    });
  });

  describe("daysInMonth", () => {
    it("returns correct days for February in leap and non-leap years", () => {
      expect(daysInMonth(2024, 2)).toBe(29);
      expect(daysInMonth(2023, 2)).toBe(28);
    });

    it("returns 30 for 30-day months and 31 for 31-day months", () => {
      expect(daysInMonth(2024, 4)).toBe(30);
      expect(daysInMonth(2024, 6)).toBe(30);
      expect(daysInMonth(2024, 9)).toBe(30);
      expect(daysInMonth(2024, 11)).toBe(30);
      expect(daysInMonth(2024, 1)).toBe(31);
      expect(daysInMonth(2024, 7)).toBe(31);
      expect(daysInMonth(2024, 8)).toBe(31);
      expect(daysInMonth(2024, 12)).toBe(31);
    });
  });

  describe("compareDates", () => {
    it("orders dates properly by year, month, and day", () => {
      expect(compareDates({ year: 2020 }, { year: 2024 })).toBeLessThan(0);
      expect(compareDates({ year: 2024, month: 5 }, { year: 2024, month: 8 })).toBeLessThan(0);
      expect(compareDates({ year: 2024, month: 5, day: 10 }, { year: 2024, month: 5, day: 15 })).toBeLessThan(0);
      expect(compareDates({ year: 2024, month: 5, day: 10 }, { year: 2024, month: 5, day: 10 })).toBe(0);
    });
  });

  describe("toFractionalYear", () => {
    it("converts year/month/day to monotonic float", () => {
      const start = toFractionalYear(2024, 1, 1);
      const mid = toFractionalYear(2024, 7, 1);
      const end = toFractionalYear(2024, 12, 31);
      expect(start).toBe(2024);
      expect(mid).toBeGreaterThan(start);
      expect(end).toBeGreaterThan(mid);
      expect(end).toBeLessThan(2025);
    });
  });

  describe("isDateInRange", () => {
    it("checks if date is inside bounds", () => {
      const date = { year: 2024, month: 6, day: 15 };
      expect(isDateInRange(date, { year: 2020 }, { year: 2025 })).toBe(true);
      expect(isDateInRange(date, { year: 2024, month: 6, day: 1 }, { year: 2024, month: 6, day: 30 })).toBe(true);
      expect(isDateInRange(date, { year: 2024, month: 7 }, { year: 2025 })).toBe(false);
    });
  });

  describe("doRangesOverlap", () => {
    it("determines 1D range overlap", () => {
      expect(doRangesOverlap(10, 20, 15, 25)).toBe(true);
      expect(doRangesOverlap(10, 20, 20, 30)).toBe(true);
      expect(doRangesOverlap(10, 20, 25, 35)).toBe(false);
      expect(doRangesOverlap(20, 10, 25, 15)).toBe(true); // Unordered
    });
  });

  describe("formatDateString", () => {
    it("formats year, year-month, year-month-day", () => {
      expect(formatDateString(2024)).toBe("2024");
      expect(formatDateString(2024, 5)).toBe("2024-05");
      expect(formatDateString(2024, 5, 9)).toBe("2024-05-09");
    });
  });

  describe("formatRelativeTime", () => {
    const base = new Date("2026-08-24T12:00:00Z").getTime();

    it("formats seconds, minutes, hours, and days relative to base time", () => {
      expect(formatRelativeTime(base - 10_000, "en", base)).toBe("10 seconds ago");
      expect(formatRelativeTime(base - 5 * 60_000, "en", base)).toBe("5 minutes ago");
      expect(formatRelativeTime(base - 2 * 3600_000, "en", base)).toBe("2 hours ago");
      expect(formatRelativeTime(base - 3 * 86400_000, "en", base)).toBe("3 days ago");
    });

    it("formats localized output in Korean", () => {
      expect(formatRelativeTime(base - 5 * 60_000, "ko", base)).toBe("5분 전");
      expect(formatRelativeTime(base - 2 * 3600_000, "ko", base)).toBe("2시간 전");
    });

    it("handles ISO strings and Date instances identically", () => {
      const iso = "2026-08-24T11:55:00Z";
      expect(formatRelativeTime(iso, "en", base)).toBe("5 minutes ago");
      expect(formatRelativeTime(new Date(iso), "en", base)).toBe("5 minutes ago");
    });

    it("returns empty string for invalid date input", () => {
      expect(formatRelativeTime("invalid-date", "en", base)).toBe("");
    });
  });
});
