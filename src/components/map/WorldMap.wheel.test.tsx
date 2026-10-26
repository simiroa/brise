import { describe, it, expect, beforeAll } from "vitest";
import { render, act } from "@testing-library/react";
import { WorldMap } from "./WorldMap";

// jsdom has no ResizeObserver; WorldMap's own layout effect is the only thing that needs one, so
// stub it locally rather than pulling in a real polyfill dependency for one test file.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("WorldMap wheel zoom", () => {
  it("registers wheel natively (non-passive) so preventDefault actually blocks page scroll", () => {
    // Root-cause regression: React registers the synthetic onWheel listener as PASSIVE at the
    // event-delegation root (react-dom-client.development.js ~L19251), so a plain onWheel prop's
    // e.preventDefault() is silently ignored and an ancestor scroll container (e.g. Settings'
    // map preview) scrolls underneath the zoom. WorldMap must attach wheel via addEventListener
    // with { passive: false } directly on its container instead.
    const { container } = render(<WorldMap width={400} height={300} />);
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(el).not.toBeNull();

    const evt = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 200, clientY: 150 });
    el.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });

  it("zooms in on wheel-up over the map", () => {
    const { container } = render(<WorldMap width={400} height={300} />);
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    const zoomBefore = Number(el.getAttribute("data-perf-zoom"));

    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 200, clientY: 150 }));
    });

    const zoomAfter = Number(el.getAttribute("data-perf-zoom"));
    expect(zoomAfter).toBeGreaterThan(zoomBefore);
  });

  it("leaves a plain (unmodified) wheel to the page — zoom is Ctrl/Cmd+wheel", () => {
    // 2026-09-08: unified with the dashboard timeline and ImagePreview. A plain wheel over the
    // map must scroll whatever page it sits in (Settings' map preview), not zoom it.
    const { container } = render(<WorldMap width={400} height={300} />);
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    const zoomBefore = Number(el.getAttribute("data-perf-zoom"));

    const evt = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true, clientX: 200, clientY: 150 });
    act(() => { el.dispatchEvent(evt); });

    expect(evt.defaultPrevented).toBe(false);
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(zoomBefore);
  });

  it("pans on a horizontal wheel instead of zooming out", () => {
    // A tilt wheel / trackpad swipe sends deltaX with deltaY === 0, which read as "not < 0" in
    // the zoom path and shrank the map on every notch. It must pan the transform instead.
    const { container } = render(<WorldMap width={400} height={300} />);
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 200, clientY: 150 }));
    });
    const zoomBefore = Number(el.getAttribute("data-perf-zoom"));
    const g = el.querySelector("svg g") as SVGGElement;
    const before = g.getAttribute("transform");

    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: 60, deltaY: 0, cancelable: true, bubbles: true, clientX: 200, clientY: 150 }));
    });

    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(zoomBefore);
    expect(g.getAttribute("transform")).not.toBe(before);
  });
});
