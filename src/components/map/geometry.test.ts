import { describe, it, expect } from "vitest";
import { clampMapTransform, minCoverZoom } from "./geometry";

/**
 * Independent check of the "no blank space" invariant — derived from the
 * clip square directly (not from clampMapTransform's own algebra):
 *   world screen-space rect = [x, viewWidth*k + x] × [(H/2-W/2)*k + y, (H/2+W/2)*k + y]
 * A clamped transform must have that rect cover the viewport exactly or overflow it,
 * never leave a gap.
 */
function coversViewport(w: number, h: number, t: { k: number; x: number; y: number }) {
  const left = t.x;
  const right = w * t.k + t.x;
  const top = (h / 2 - w / 2) * t.k + t.y;
  const bottom = (h / 2 + w / 2) * t.k + t.y;
  return left <= 1e-6 && right >= w - 1e-6 && top <= 1e-6 && bottom >= h - 1e-6;
}

describe("minCoverZoom", () => {
  it("is 1 for landscape/square viewports (world already covers on width)", () => {
    expect(minCoverZoom(800, 450)).toBe(1);
    expect(minCoverZoom(500, 500)).toBe(1);
  });

  it("scales with aspect ratio for portrait viewports (the tall-window case)", () => {
    expect(minCoverZoom(400, 800)).toBe(2);
    expect(minCoverZoom(300, 900)).toBe(3);
  });
});

describe("clampMapTransform — no blank space, any zoom/aspect", () => {
  const cases: Array<[number, number]> = [
    [800, 450], // landscape
    [400, 800], // portrait — "세로가 넓은 창"
    [300, 900], // very tall/narrow
    [600, 600], // square
  ];

  for (const [w, h] of cases) {
    it(`covers a ${w}x${h} viewport at the zoom floor`, () => {
      const clamped = clampMapTransform(w, h, { k: 0.01, x: 0, y: 0 });
      expect(coversViewport(w, h, clamped)).toBe(true);
      expect(clamped.k).toBeCloseTo(minCoverZoom(w, h), 6);
    });

    it(`covers a ${w}x${h} viewport when panned far past the edge`, () => {
      const clamped = clampMapTransform(w, h, { k: 50, x: 999999, y: -999999 });
      expect(coversViewport(w, h, clamped)).toBe(true);
    });

    it(`covers a ${w}x${h} viewport at a valid in-range transform (identity-preserving)`, () => {
      const k = Math.max(3, minCoverZoom(w, h) + 1);
      // Midpoint of the valid x/y range at this k — guaranteed in-bounds regardless of aspect.
      const minX = w * (1 - k);
      const minY = h - (h / 2 + w / 2) * k;
      const maxY = (w / 2 - h / 2) * k;
      const t = { k, x: minX / 2, y: (minY + maxY) / 2 };
      const clamped = clampMapTransform(w, h, t);
      expect(coversViewport(w, h, clamped)).toBe(true);
      // Already in-bounds — clamp must be a no-op (identity), not just "covers".
      expect(clamped).toEqual(t);
    });
  }

  it("floor is tight — at k = minCoverZoom one axis has zero pan slack", () => {
    const w = 400;
    const h = 800;
    const clamped = clampMapTransform(w, h, { k: 0, x: 0, y: 0 });
    // Vertical: world height == viewport height exactly at the floor → y range collapses.
    const top = (h / 2 - w / 2) * clamped.k + clamped.y;
    const bottom = (h / 2 + w / 2) * clamped.k + clamped.y;
    expect(top).toBeCloseTo(0, 6);
    expect(bottom).toBeCloseTo(h, 6);
  });

  it("matches the sidebar map's real transform unchanged — well within bounds", () => {
    // RegionFilter/RegionExpanded sidebar map: small panel, moderate zoom, Seoul-ish center.
    // Regression guard for "사이드바 지도 동작이 변하지 않음": clamp must be identity here.
    const w = 300;
    const h = 200;
    const k = 50;
    // x/y as WorldMap's initialTransform would compute them for lat=37.5, lng=127 roughly centered.
    const t = { k, x: -12640, y: -3211 };
    expect(clampMapTransform(w, h, t)).toEqual(t);
  });

  it("degenerate viewport sizes return the input untouched", () => {
    const t = { k: 5, x: 10, y: 20 };
    expect(clampMapTransform(0, 100, t)).toEqual(t);
    expect(clampMapTransform(100, 0, t)).toEqual(t);
    expect(clampMapTransform(-5, 100, t)).toEqual(t);
  });
});
