import { describe, it, expect } from "vitest";
import {
  IMAGE_WIDTH_DEFAULT,
  IMAGE_WIDTH_MAX,
  IMAGE_WIDTH_MIN,
  MOBILE_IMAGE_WIDTH_STEPS,
  clampImageWidthPct,
  formatImageWidth,
  parseImageWidth,
  widthFromDrag,
  isMobileWidthStepActive,
} from "./imageResize";

describe("imageResize (D5)", () => {
  it("clamps to [MIN, MAX] and rounds", () => {
    expect(clampImageWidthPct(0)).toBe(IMAGE_WIDTH_MIN);
    expect(clampImageWidthPct(-5)).toBe(IMAGE_WIDTH_MIN);
    expect(clampImageWidthPct(150)).toBe(IMAGE_WIDTH_MAX);
    expect(clampImageWidthPct(40.4)).toBe(40);
    expect(clampImageWidthPct(40.6)).toBe(41);
    expect(clampImageWidthPct(Number.NaN)).toBe(IMAGE_WIDTH_DEFAULT);
  });

  it("formats as percent strings", () => {
    expect(formatImageWidth(40)).toBe("40%");
    expect(formatImageWidth(100)).toBe("100%");
    expect(formatImageWidth(999)).toBe("100%");
  });

  it("parses stored attrs, bare numbers, and junk", () => {
    expect(parseImageWidth("70%")).toBe(70);
    expect(parseImageWidth("25")).toBe(25);
    expect(parseImageWidth(null)).toBe(IMAGE_WIDTH_DEFAULT);
    expect(parseImageWidth("")).toBe(IMAGE_WIDTH_DEFAULT);
    expect(parseImageWidth("wide")).toBe(IMAGE_WIDTH_DEFAULT);
  });

  it("computes drag width from pointer delta relative to parent width", () => {
    // Start 40%, drag +50px on a 200px column → +25% → 65%
    expect(
      widthFromDrag({
        startWidthPct: 40,
        startClientX: 100,
        clientX: 150,
        parentWidthPx: 200,
      }),
    ).toBe("65%");

    // Drag past the right edge — hard-capped at 100%
    expect(
      widthFromDrag({
        startWidthPct: 90,
        startClientX: 0,
        clientX: 500,
        parentWidthPx: 200,
      }),
    ).toBe("100%");

    // Drag left past floor
    expect(
      widthFromDrag({
        startWidthPct: 20,
        startClientX: 100,
        clientX: 0,
        parentWidthPx: 200,
      }),
    ).toBe(`${IMAGE_WIDTH_MIN}%`);

    // Zero parent width: keep start (avoid /0)
    expect(
      widthFromDrag({
        startWidthPct: 40,
        startClientX: 0,
        clientX: 50,
        parentWidthPx: 0,
      }),
    ).toBe("40%");
  });

  it("mobile steps are exactly 25/40/100", () => {
    expect([...MOBILE_IMAGE_WIDTH_STEPS]).toEqual([25, 40, 100]);
  });

  it("isMobileWidthStepActive lights the middle step for missing width", () => {
    expect(isMobileWidthStepActive(undefined, 40)).toBe(true);
    expect(isMobileWidthStepActive(null, 40)).toBe(true);
    expect(isMobileWidthStepActive("", 40)).toBe(true);
    expect(isMobileWidthStepActive("25%", 25)).toBe(true);
    expect(isMobileWidthStepActive("25%", 40)).toBe(false);
    expect(isMobileWidthStepActive("100%", 100)).toBe(true);
  });
});
