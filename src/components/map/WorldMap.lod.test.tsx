import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { WorldMap } from "./WorldMap";

// jsdom has no ResizeObserver — same minimal stub as WorldMap.resize.test.tsx. Explicit
// width/height props mean the layout effect's zero-size measurement is a no-op, so tests never
// need it to actually fire.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("WorldMap LOD tiers mount only past their own zoom threshold", () => {
  it("admin1 / capital / city tiers are all absent well below every threshold (k=5)", async () => {
    const { container } = render(
      <WorldMap width={800} height={600} defaultLocation={{ lat: 37.5665, lng: 126.978, zoom: 5 }} />
    );
    // Give any stray dynamic import a moment to resolve, then assert it changed nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll('[data-tier="admin1"]').length).toBe(0);
    expect(container.querySelectorAll('[data-tier="capital"]').length).toBe(0);
    expect(container.querySelectorAll('[data-tier="city-dot"]').length).toBe(0);
  });

  it("capitals mount past k=8 and cities mount past k=20, both viewport-culled (not the full dataset)", async () => {
    const { container } = render(
      <WorldMap width={800} height={600} defaultLocation={{ lat: 37.5665, lng: 126.978, zoom: 25 }} />
    );
    await waitFor(
      () => {
        expect(container.querySelectorAll('[data-tier="capital"]').length).toBeGreaterThan(0);
      },
      { timeout: 10000 }
    );
    await waitFor(
      () => {
        expect(container.querySelectorAll('[data-tier="city-dot"]').length).toBeGreaterThan(0);
      },
      { timeout: 10000 }
    );
    // Sanity: nowhere near the full ~2200-city dataset — bbox culling is doing real work.
    expect(container.querySelectorAll('[data-tier="city-dot"]').length).toBeLessThan(500);
  }, 15000);

  it("city labels stay capped at 40 even over a dense region", async () => {
    const { container } = render(
      // Central/eastern China just past the label threshold (k=33): dense enough that the
      // city-dot count comfortably exceeds the label cap.
      <WorldMap width={900} height={700} defaultLocation={{ lat: 32, lng: 115, zoom: 33 }} />
    );
    await waitFor(
      () => {
        expect(container.querySelectorAll('[data-tier="city-dot"]').length).toBeGreaterThan(40);
      },
      { timeout: 10000 }
    );
    await waitFor(
      () => {
        expect(container.querySelectorAll('[data-tier="city-label"]').length).toBeGreaterThan(0);
      },
      { timeout: 10000 }
    );
    expect(container.querySelectorAll('[data-tier="city-label"]').length).toBeLessThanOrEqual(40);
  }, 15000);
});
