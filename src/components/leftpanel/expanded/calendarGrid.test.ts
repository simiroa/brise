import { describe, it, expect } from "vitest";
import { buildCalendarGrid, dayFetchMonth, monthRange, shiftMonth } from "./calendarGrid";

describe("calendarGrid", () => {

  it("buildCalendarGrid pads to full weeks and aligns weekdays", () => {
    // 2026-07: July 1 2026 is a Wednesday (UTC) -> 3 leading blanks.
    const cells = buildCalendarGrid(2026, 6);
    expect(cells.length % 7).toBe(0);
    expect(cells.slice(0, 3)).toEqual([
      { day: null, dayOfMonth: null },
      { day: null, dayOfMonth: null },
      { day: null, dayOfMonth: null },
    ]);
    expect(cells[3]).toEqual({ day: "2026-07-01", dayOfMonth: 1 });
    const realCells = cells.filter((c) => c.day !== null);
    const lastReal = realCells[realCells.length - 1];
    expect(lastReal).toEqual({ day: "2026-07-31", dayOfMonth: 31 });
  });

  it("monthRange spans the full UTC month inclusive", () => {
    expect(monthRange(2024, 1)).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("shiftMonth rolls the year over in both directions", () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 5, 1)).toEqual({ year: 2026, month: 6 });
  });

  // W2 D6 — 보는 달 안이면 null(호출 1회), 밖이면 그 달(경계 fetch). month 는 0-11.
  it("dayFetchMonth: same month → null, other month → that month", () => {
    expect(dayFetchMonth("2026-08-15", 2026, 7)).toBeNull();
    expect(dayFetchMonth("2026-08-15", 2026, 8)).toEqual({ year: 2026, month: 7 });
    expect(dayFetchMonth("2026-01-01", 2025, 11)).toEqual({ year: 2026, month: 0 });
  });
});
