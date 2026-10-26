import { describe, it, expect } from "vitest";
import { dayTone, headerTone, toneColor, recordTint } from "./calendarDay";

describe("calendarDay", () => {
  it("dayTone reads weekends from the date, and a holiday reads as a Sunday", () => {
    expect(dayTone("2026-08-15")).toBe("sat");
    expect(dayTone("2026-08-16")).toBe("sun");
    expect(dayTone("2026-08-17")).toBe(null);
    // Holiday wins on a plain weekday.
    expect(dayTone("2026-08-17", new Map([["2026-08-17", "대체공휴일"]]))).toBe("sun");
    expect(dayTone("not-a-date")).toBe(null);
  });

  it("headerTone follows the week start; toneColor maps to the shared vars", () => {
    expect([0, 6].map((i) => headerTone(i, "sunday"))).toEqual(["sun", "sat"]);
    expect([6, 5].map((i) => headerTone(i, "monday"))).toEqual(["sun", "sat"]);
    expect(headerTone(3, "sunday")).toBe(null);
    expect(toneColor("sun")).toBe("var(--danger)");
    expect(toneColor(null, "var(--faint)")).toBe("var(--faint)");
  });

  it("recordTint spans 8–38% accent and is null when there is nothing to paint", () => {
    expect(recordTint(0, 5)).toBeNull();
    expect(recordTint(3, 0)).toBeNull();
    expect(recordTint(1, 10)).toContain("11%");
    expect(recordTint(10, 10)).toContain("38%");
    // Never exceeds the ceiling even if a count outruns the observed max.
    expect(recordTint(99, 10)).toContain("38%");
  });
});
