import { describe, it, expect } from "vitest";
import {
  yearRangeLabel,
  yearRangeDisplay,
  expandToYearAxis,
  isFullYearRange,
  yearDensity,
  densityMarkWidth,
  yearAtFraction,
  nearestYearHandle,
  moveYearHandle,
} from "./yearAxis";

const padded = { min: 2025, max: 2028, dataMin: 2026, dataMax: 2027, padded: true };

describe("yearAxis", () => {
  it("label clips the padding years off (2025–2028 axis, notes in 2026–2027)", () => {
    expect(yearRangeLabel(2025, 2028, padded)).toBe("2026 – 2027");
    expect(yearRangeLabel(2025, 2026, padded)).toBe("2026");
    // Entirely inside the padding → nothing to clip to, keep the selection.
    expect(yearRangeDisplay(2027.5, 2028, { ...padded, dataMax: 2027 })).toEqual({ from: 2027.5, to: 2028 });
    // Empty corpus fallback: no data years → as-is.
    expect(yearRangeLabel(1926, 2026, { min: 1926, max: 2026, dataMin: null, dataMax: null })).toBe("1926 – 2026");
  });

  it("expandToYearAxis widens data-edge input back to the full axis", () => {
    expect(expandToYearAxis(2026, 2027, padded)).toEqual({ from: 2025, to: 2028 });
    expect(expandToYearAxis(2026, 2026, padded)).toEqual({ from: 2025, to: 2026 });
    expect(expandToYearAxis(1500, 1600, { min: 1000, max: 2000 })).toEqual({ from: 1500, to: 1600 });
  });

  it("isFullYearRange", () => {
    expect(isFullYearRange(2025, 2028, padded)).toBe(true);
    expect(isFullYearRange(2026, 2028, padded)).toBe(false);
  });

  it("yearDensity → fractions on the axis, skipping empty/outside years", () => {
    expect(yearDensity({ 2026: 1, 2027: 4, 1990: 3, 2028: 0 }, 2025, 2028)).toEqual([
      { year: 2026, frac: 1 / 3, count: 1 },
      { year: 2027, frac: 2 / 3, count: 4 },
    ]);
    expect(densityMarkWidth(1)).toBe(2);
    expect(densityMarkWidth(40)).toBe(8);
  });

  it("drag helpers: fraction→year, nearest handle, non-crossing move", () => {
    expect(yearAtFraction(0.5, 2000, 2030)).toBe(2015);
    expect(yearAtFraction(-1, 2000, 2030)).toBe(2000);
    expect(nearestYearHandle(2004, 2000, 2030)).toBe("from");
    expect(nearestYearHandle(2026, 2000, 2030)).toBe("to");
    expect(nearestYearHandle(2015, 2010, 2020)).toBe("to");
    expect(nearestYearHandle(2005, 2010, 2010)).toBe("from");
    const b = { min: 2000, max: 2030 };
    expect(moveYearHandle({ from: 2000, to: 2010 }, "from", 2020, b)).toEqual({ from: 2009, to: 2010 });
    expect(moveYearHandle({ from: 2000, to: 2010 }, "to", 1990, b)).toEqual({ from: 2000, to: 2001 });
    expect(moveYearHandle({ from: 2000, to: 2010 }, "to", 2099, b)).toEqual({ from: 2000, to: 2030 });
  });
});
