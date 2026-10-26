import { describe, it, expect } from "vitest";
import { isBeforeDate, isSameDate, pickDay, dragRange, cellHighlight, formatFallbackValue } from "./dateRangePicker";

const d = (year: number, month: number | null, day: number | null) => ({ year, month, day });
const noEnd = { end_year: null, end_month: null, end_day: null };

describe("isBeforeDate / isSameDate", () => {
  it("compares full-precision dates", () => {
    expect(isBeforeDate(d(2026, 7, 1), d(2026, 7, 5))).toBe(true);
    expect(isBeforeDate(d(2026, 7, 5), d(2026, 7, 1))).toBe(false);
    expect(isBeforeDate(d(2026, 7, 1), d(2026, 7, 1))).toBe(false);
  });
  it("treats missing month/day as earliest", () => {
    expect(isBeforeDate(d(2026, null, null), d(2026, 1, 1))).toBe(true);
    expect(isBeforeDate(d(2026, 1, 1), d(2026, null, null))).toBe(false);
  });
  it("isSameDate requires exact precision match, not just calendar equality", () => {
    expect(isSameDate(d(2026, 7, 1), d(2026, 7, 1))).toBe(true);
    expect(isSameDate(d(2026, 7, null), d(2026, 7, 1))).toBe(false);
  });
});

describe("pickDay — airline-booking two-click state machine", () => {
  const jul1 = { year: 2026, month: 7, day: 1 };
  const jul5 = { year: 2026, month: 7, day: 5 };
  const jun20 = { year: 2026, month: 6, day: 20 };

  it("first click (idle phase) sets start only — 'single selected day = start, no end'", () => {
    const r = pickDay(jul1, d(2026, null, null), "idle");
    expect(r).toEqual({ start: d(2026, 7, 1), end: noEnd, phase: "picking-end" });
  });

  it("second click on a later day completes the range and returns to idle", () => {
    const r = pickDay(jul5, d(2026, 7, 1), "picking-end");
    expect(r).toEqual({
      start: d(2026, 7, 1),
      end: { end_year: 2026, end_month: 7, end_day: 5 },
      phase: "idle",
    });
  });

  it("second click on the same day as start collapses to a same-day range", () => {
    const r = pickDay(jul1, d(2026, 7, 1), "picking-end");
    expect(r.end).toEqual({ end_year: 2026, end_month: 7, end_day: 1 });
    expect(r.phase).toBe("idle");
  });

  it("second click on an EARLIER day starts a new selection instead of reversing", () => {
    const r = pickDay(jun20, d(2026, 7, 1), "picking-end");
    expect(r).toEqual({ start: d(2026, 6, 20), end: noEnd, phase: "picking-end" });
  });

  it("a further click after a complete range starts a brand-new selection", () => {
    // phase "idle" is what a completed range looks like from the outside — DateBadge resets it
    // back to "idle" as soon as pickDay/dragRange produces a full range (see those implementations).
    const r = pickDay(jun20, d(2026, 7, 1), "idle");
    expect(r).toEqual({ start: d(2026, 6, 20), end: noEnd, phase: "picking-end" });
  });
});

describe("dragRange", () => {
  it("orders a reverse drag into start/end regardless of gesture direction", () => {
    const forward = dragRange({ year: 2026, month: 7, day: 1 }, { year: 2026, month: 7, day: 5 });
    const backward = dragRange({ year: 2026, month: 7, day: 5 }, { year: 2026, month: 7, day: 1 });
    expect(forward).toEqual(backward);
    expect(forward).toEqual({
      start: d(2026, 7, 1),
      end: { end_year: 2026, end_month: 7, end_day: 5 },
      phase: "idle",
    });
  });
});

describe("cellHighlight", () => {
  const start = d(2026, 7, 1);
  const end = { end_year: 2026, end_month: 7, end_day: 5 };

  it("marks the start and end cells", () => {
    expect(cellHighlight({ year: 2026, month: 7, day: 1 }, start, end)).toBe("start");
    expect(cellHighlight({ year: 2026, month: 7, day: 5 }, start, end)).toBe("end");
  });
  it("marks days strictly between as in-range", () => {
    expect(cellHighlight({ year: 2026, month: 7, day: 3 }, start, end)).toBe("in-range");
  });
  it("marks everything else none", () => {
    expect(cellHighlight({ year: 2026, month: 7, day: 20 }, start, end)).toBe("none");
    expect(cellHighlight({ year: 2026, month: 6, day: 30 }, start, end)).toBe("none");
  });
  it("a same-day range highlights just the one cell as start", () => {
    const sameDayEnd = { end_year: 2026, end_month: 7, end_day: 1 };
    expect(cellHighlight({ year: 2026, month: 7, day: 1 }, start, sameDayEnd)).toBe("start");
  });
  it("no highlight at all when there is no end and the cell isn't the start", () => {
    expect(cellHighlight({ year: 2026, month: 7, day: 2 }, start, noEnd)).toBe("none");
  });
});

describe("formatFallbackValue", () => {
  it("empty string when year is null", () => {
    expect(formatFallbackValue(null, null, null)).toBe("");
  });
  it("delegates to formatEventDate otherwise", () => {
    expect(formatFallbackValue(2026, 7, 1)).toBe("2026.07.01");
    expect(formatFallbackValue(2026, null, null)).toBe("2026");
  });
});
