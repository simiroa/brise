import { describe, it, expect } from "vitest";
import { screenToLngLat, lngLatToScreen, computeFitTransform } from "./WorldMap";

describe("WorldMap coordinate conversion round trips", () => {
  it("converts screen to lngLat and back to screen at unzoomed identity transform (k=1, x=0, y=0)", () => {
    const viewWidth = 600;
    const viewHeight = 400;
    const transform = { k: 1, x: 0, y: 0 };
    const originalScreen = { x: 300, y: 200 }; // Center of the map view

    const lngLat = screenToLngLat(originalScreen.x, originalScreen.y, viewWidth, viewHeight, transform);
    expect(lngLat).not.toBeNull();

    if (lngLat) {
      const backToScreen = lngLatToScreen(lngLat.lat, lngLat.lng, viewWidth, viewHeight, transform);
      expect(backToScreen).not.toBeNull();
      if (backToScreen) {
        expect(backToScreen.x).toBeCloseTo(originalScreen.x, 1);
        expect(backToScreen.y).toBeCloseTo(originalScreen.y, 1);
      }
    }
  });

  it("converts screen to lngLat and back to screen at zoomed and panned transform (k=3.5, x=-120, y=45)", () => {
    const viewWidth = 600;
    const viewHeight = 400;
    const transform = { k: 3.5, x: -120, y: 45 };
    const originalScreen = { x: 250, y: 180 };

    const lngLat = screenToLngLat(originalScreen.x, originalScreen.y, viewWidth, viewHeight, transform);
    expect(lngLat).not.toBeNull();

    if (lngLat) {
      const backToScreen = lngLatToScreen(lngLat.lat, lngLat.lng, viewWidth, viewHeight, transform);
      expect(backToScreen).not.toBeNull();
      if (backToScreen) {
        expect(backToScreen.x).toBeCloseTo(originalScreen.x, 1);
        expect(backToScreen.y).toBeCloseTo(originalScreen.y, 1);
      }
    }
  });
});

describe("computeFitTransform (W7-e Task 2: region-filter fly-to-fit)", () => {
  it("returns null for zero markers — caller must leave the current view alone", () => {
    expect(computeFitTransform([], 900, 500)).toBeNull();
  });

  it("returns null for a non-positive viewport", () => {
    expect(computeFitTransform([{ lat: 10, lng: 20 }], 0, 0)).toBeNull();
  });

  it("centers a single marker without zooming to the absolute max", () => {
    const t = computeFitTransform([{ lat: 48.8566, lng: 2.3522 }], 900, 500);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.k).toBeLessThan(400); // wheel's absolute max — a single note must not snap there
    expect(t.k).toBeGreaterThan(1);
    // The marker should land at the viewport center.
    const screen = lngLatToScreen(48.8566, 2.3522, 900, 500, t);
    expect(screen).not.toBeNull();
    if (screen) {
      expect(screen.x).toBeCloseTo(450, 0);
      expect(screen.y).toBeCloseTo(250, 0);
    }
  });

  it("fits a spread of markers so every one stays on screen", () => {
    const points = [
      { lat: 48.8566, lng: 2.3522 }, // Paris
      { lat: 52.52, lng: 13.405 }, // Berlin
      { lat: 41.9028, lng: 12.4964 }, // Rome
    ];
    const w = 900;
    const h = 500;
    const t = computeFitTransform(points, w, h);
    expect(t).not.toBeNull();
    if (!t) return;
    for (const p of points) {
      const screen = lngLatToScreen(p.lat, p.lng, w, h, t);
      expect(screen).not.toBeNull();
      if (screen) {
        expect(screen.x).toBeGreaterThanOrEqual(0);
        expect(screen.x).toBeLessThanOrEqual(w);
        expect(screen.y).toBeGreaterThanOrEqual(0);
        expect(screen.y).toBeLessThanOrEqual(h);
      }
    }
  });

  it("caps zoom for a tight cluster instead of zooming in indefinitely", () => {
    const t = computeFitTransform(
      [
        { lat: 37.5665, lng: 126.978 },
        { lat: 37.5666, lng: 126.9781 }, // ~15m away — near-coincident
      ],
      900,
      500
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.k).toBeLessThanOrEqual(30);
  });
});
