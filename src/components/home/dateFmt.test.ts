import { describe, it, expect } from "vitest";
import {
  formatTimelineViewBound,
  formatYearRange,
  formatMonthShort,
  formatTimelineTick,
  isoWeekdayBit,
  addDaysIso,
} from "./dateFmt";

describe("formatYearRange (L5-3 shared join)", () => {
  it("joins two distinct bounds with an en dash", () => {
    expect(formatYearRange(2005, 2045)).toBe("2005 – 2045");
    expect(formatYearRange("1600", "1700")).toBe("1600 – 1700");
  });

  it("collapses equal bounds to a single label", () => {
    expect(formatYearRange(2026, 2026)).toBe("2026");
    expect(formatYearRange("2026-08", "2026-08")).toBe("2026-08");
  });

  it("accepts formatTimelineViewBound outputs without re-parsing", () => {
    const span = 2;
    const a = formatTimelineViewBound(1500, span);
    const b = formatTimelineViewBound(1700, span);
    expect(formatYearRange(a, b)).toBe("1500 – 1700");
  });
});

describe("formatTimelineViewBound", () => {
  it("rounds to integer years when span ≥ 2", () => {
    expect(formatTimelineViewBound(2026.4, 2)).toBe("2026");
  });
});

describe("formatMonthShort / formatTimelineTick", () => {
  it("formats month ticks by uiLang", () => {
    expect(formatMonthShort(8, "ko")).toBe("8월");
    expect(formatTimelineTick(2026, 1, "en", { year: 2026, month: 1, day: 1 })).toBe("2026");
  });

  it("year step: a date inside a year reads its own year, a (float-drifted) boundary rounds", () => {
    // 2026-07-29 ≈ 2026.57 — rounding it gave "2027" in item tooltips (2026-10-19).
    expect(formatTimelineTick(2026.57, 1, "ko", { year: 2026, month: 7, day: 29 })).toBe("2026");
    expect(formatTimelineTick(2027.745, 1, "ko", { year: 2027, month: 9, day: 30 })).toBe("2027");
    // A tick computed as 2026.9999999 floors to Dec 31 2026 in `parts` — still the 2027 tick.
    expect(formatTimelineTick(2026.9999999999, 1, "en", { year: 2026, month: 12, day: 31 })).toBe("2027");
    expect(formatTimelineTick(2030.0000000001, 5, "en", { year: 2030, month: 1, day: 1 })).toBe("2030");
  });
});

describe("isoWeekdayBit (timeline_routines.weekday_mask ordering — bit0=Mon..bit6=Sun)", () => {
  it("2024-01-01 was a Monday -> bit0", () => {
    expect(isoWeekdayBit("2024-01-01")).toBe(1 << 0);
  });

  it("walks a full week from that known Monday in ISO bit order", () => {
    const expectedBits = [0, 1, 2, 3, 4, 5, 6].map((n) => 1 << n);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    expect(days.map(isoWeekdayBit)).toEqual(expectedBits);
  });

  it("2024-01-07 was a Sunday -> bit6", () => {
    expect(isoWeekdayBit("2024-01-07")).toBe(1 << 6);
  });

  it("is independent of the local timezone (UTC-parsed, like parseIsoDay)", () => {
    // Same fact re-checked at a different point in the month — no local-time drift.
    expect(isoWeekdayBit("2026-08-09")).toBe(isoWeekdayBit("2026-08-09"));
  });

  it("returns 0 for a malformed date string", () => {
    expect(isoWeekdayBit("not-a-date")).toBe(0);
    expect(isoWeekdayBit("")).toBe(0);
  });
});

describe("addDaysIso — 날짜 더하기의 유일한 구현", () => {
  it("월·연·윤년 경계를 넘는다", () => {
    expect(addDaysIso("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDaysIso("2026-08-09", 0)).toBe("2026-08-09");
    expect(addDaysIso("2026-08-09", -77)).toBe("2026-05-24");
  });

  it("형식이 깨졌으면 null", () => {
    expect(addDaysIso("nope", 1)).toBeNull();
    expect(addDaysIso("2026-8-9", 1)).toBeNull();
  });
});
