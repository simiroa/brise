import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { WorldMap, computeSeedTransform } from "./WorldMap";

// Root-cause regression (create-pin / first-marker-select / window resize / sidebar toggle all
// hit this): WorldMap used to reset the live pan/zoom transform to `defaultLocation` on *every*
// viewSize change, because `useEffect(() => setTransform(initialTransform), [initialTransform])`
// fired for both a real fly-to (`defaultLocation` change) and a mere container resize (a new
// ResizeObserver-reported size, e.g. MapFilmStrip swapping its populated/empty branch and
// nudging the canvas a few px). Fixed by separating "seed" (defaultLocation change, or the first
// real size for a still-unsized container) from "resize" (re-clamp the live transform only).
//
// Controllable ResizeObserver stub: captures the callback instead of auto-firing (unlike jsdom,
// which has no ResizeObserver at all, or the useElementSize.test.tsx stub, which fires
// synchronously on observe()) — each test decides exactly when a "resize" is reported.
let roCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  roCallback = null;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      roCallback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function fireResize(width: number, height: number) {
  act(() => {
    roCallback?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

function zoomIn(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 200, clientY: 150 })
    );
  });
}

function gTranslate(container: HTMLElement): { x: number; y: number } {
  const g = container.querySelector("svg > g") as SVGGElement;
  const m = /translate\(([^,]+),\s*([^)]+)\)/.exec(g.getAttribute("transform") || "");
  return { x: Number(m?.[1]), y: Number(m?.[2]) };
}

// QA8 1D: home button uses homeLocation when provided, not the fit/seed defaultLocation.
describe("WorldMap: home button targets homeLocation, not seed defaultLocation", () => {
  it("handleGoHome flies to homeLocation zoom even when seeded on a different defaultLocation", () => {
    const seed = { lat: 48.8566, lng: 2.3522, zoom: 20 };
    const home = { lat: 37.5665, lng: 126.978, zoom: 150 };
    const { container, getByLabelText } = render(
      <WorldMap width={400} height={300} defaultLocation={seed} homeLocation={home} />
    );
    const el = container.querySelector("[data-perf='world-map']") as HTMLElement;
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(20);

    act(() => {
      getByLabelText("Default location").click();
    });
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(150);
  });
});

describe("WorldMap: resize must not reset the user's live zoom/pan", () => {
  it("(a) a viewSize-only change preserves k/pan — re-clamps, does not reseed to defaultLocation", () => {
    const { container } = render(
      <WorldMap width={400} height={300} defaultLocation={{ lat: 10, lng: 20, zoom: 5 }} />
    );
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(5);

    zoomIn(el);
    const zoomAfterUserZoom = Number(el.getAttribute("data-perf-zoom"));
    expect(zoomAfterUserZoom).toBeGreaterThan(5);

    // Same shape of change as MapFilmStrip's populated<->empty swap growing the canvas ~15px.
    fireResize(400, 315);

    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(zoomAfterUserZoom);
  });

  it("(b) a defaultLocation reference change re-seeds the transform at its own zoom (real fly-to)", () => {
    const { container, rerender } = render(
      <WorldMap width={400} height={300} defaultLocation={{ lat: 10, lng: 20, zoom: 5 }} />
    );
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;

    zoomIn(el);
    expect(Number(el.getAttribute("data-perf-zoom"))).toBeGreaterThan(5);

    act(() => {
      rerender(<WorldMap width={400} height={300} defaultLocation={{ lat: 30, lng: 40, zoom: 20 }} />);
    });

    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(20);
  });

  it("(c) an observer callback reporting an unchanged size is a no-op — zero renders", () => {
    const onRender = vi.fn<ProfilerOnRenderCallback>();
    render(
      <Profiler id="wm" onRender={onRender}>
        <WorldMap width={400} height={300} defaultLocation={{ lat: 10, lng: 20, zoom: 5 }} />
      </Profiler>
    );
    onRender.mockClear();

    fireResize(400, 300); // identical (floored) to the current viewSize

    // Skips the `setViewSize` call outright (ref-compared against the current size) rather than
    // calling it with an equal value and relying on React's same-reference bailout — that
    // bailout still re-renders the owning fiber once to confirm nothing changed, which is not
    // truly zero. Skipping the call is the stronger guarantee: no render at all.
    expect(onRender).not.toHaveBeenCalled();
  });

  it("corrects for the container's real size once it replaces the mount-time placeholder (no width/height props)", () => {
    // No width/height props: viewSize starts at WorldMap's own 800×450 defaults (the placeholder
    // every real caller — HomeMapPane, settings preview, left-panel expanded map — hits, since
    // none of them pass explicit dimensions). jsdom reports clientWidth/Height as 0, so the
    // layout effect's synchronous direct-measurement branch never corrects it; only the
    // ResizeObserver callback does, which this test fires manually to model the real, async
    // browser sequence. A transform seeded for 800×450 and merely re-clamped into 1200×700 would
    // still report the right zoom (clamping doesn't touch k here) but the wrong x/y — this must
    // actually re-seed, matching computeSeedTransform for the corrected size.
    const loc = { lat: 10, lng: 20, zoom: 50 };
    const { container } = render(<WorldMap defaultLocation={loc} />);

    fireResize(1200, 700);

    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(50);
    const { x, y } = gTranslate(container);
    const expected = computeSeedTransform(loc, 1200, 700);
    expect(x).toBeCloseTo(expected.x, 5);
    expect(y).toBeCloseTo(expected.y, 5);
  });

  it("corrects for the container's real size when the caller passes explicit-but-wrong dimensions (W7-e)", () => {
    // Regression: RegionExpanded used to pass a fixed width={320} height={220} into WorldMap
    // while its real container was `width:100%; minHeight:260` — an aspect ratio that never
    // matched. computeSeedTransform derives scale from width alone (WorldMap.tsx), so the seed
    // was computed against the wrong box before ResizeObserver ever fired, landing the camera on
    // the wrong spot until the user hit "home" (which recomputes against the by-then-correct
    // size). The fix is RegionExpanded no longer passing width/height at all — this test guards
    // the underlying mechanism generically: ANY caller passing wrong initial dimensions must
    // still self-correct once the real size arrives, the same way the "no width/height props"
    // case above does.
    const loc = { lat: 10, lng: 20, zoom: 50 };
    const { container } = render(<WorldMap width={320} height={220} defaultLocation={loc} />);

    // Real container (e.g. RegionExpanded's flex box) reports a size unrelated to the wrong
    // 320×220 placeholder.
    fireResize(900, 500);

    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(50);
    const { x, y } = gTranslate(container);
    const expected = computeSeedTransform(loc, 900, 500);
    expect(x).toBeCloseTo(expected.x, 5);
    expect(y).toBeCloseTo(expected.y, 5);
    // Guards against the regression concretely: the seed computed for the wrong placeholder
    // dimensions must NOT be what ends up on screen.
    const wrongSeed = computeSeedTransform(loc, 320, 220);
    expect(x).not.toBeCloseTo(wrongSeed.x, 5);
  });

  it("still seeds properly once a real size arrives for a container that mounted at 0×0", () => {
    const { container } = render(
      <WorldMap width={0} height={0} defaultLocation={{ lat: 10, lng: 20, zoom: 5 }} />
    );
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    // At 0×0 the seed collapses to the unclamped placeholder {k, x:0, y:0} — indistinguishable
    // from a mere re-clamp-of-placeholder. Assert on x/y (not just k) once a real size lands, to
    // prove this actually took the seed branch (centers on lng 20/lat 10, so x/y move off 0)
    // rather than the resize branch (which would just re-clamp {0,0} and leave it at 0,0).
    fireResize(400, 300);

    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(5);
    const { x, y } = gTranslate(container);
    expect(x).not.toBe(0);
    expect(y).not.toBe(0);
  });
});
