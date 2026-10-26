import { describe, expect, it } from "vitest";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useFluidHover, type FluidHoverApi } from "./FluidHover";

/** jsdom 은 레이아웃이 없다 — 행마다 30px 상자를 흉내낸다. */
function fakeRects(host: HTMLElement) {
  host.querySelectorAll<HTMLElement>("button").forEach((b, i) => {
    b.getBoundingClientRect = () =>
      ({ x: 0, y: i * 30, width: 100, height: 30, top: i * 30, left: 0, right: 100, bottom: i * 30 + 30, toJSON() {} }) as DOMRect;
  });
}

describe("useFluidHover from", () => {
  it("포인터가 들어오면 from 이 가리키는 행에서 세션이 시작된다", () => {
    let api: FluidHoverApi | null = null;
    function Host() {
      const ref = useRef<HTMLDivElement>(null);
      api = useFluidHover(ref, { from: () => ref.current?.querySelector('[data-selected="true"]') });
      return (
        <div ref={ref} {...api.handlers}>
          <button className="menu-row">a</button>
          <button className="menu-row" data-selected="true">b</button>
          <button className="menu-row">c</button>
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Host />));
    fakeRects(host);

    act(() => api!.handlers.onMouseEnter());
    expect(api!.activeIndex).toBe(1);

    // 이후 이동은 평소처럼 가장 가까운 행으로
    act(() => api!.handlers.onMouseMove({ clientX: 10, clientY: 75 }));
    expect(api!.activeIndex).toBe(2);

    act(() => root.unmount());
    host.remove();
  });

  it("from 이 없거나 목록 밖이면 세션은 빈 상태로 시작한다", () => {
    let api: FluidHoverApi | null = null;
    function Host() {
      const ref = useRef<HTMLDivElement>(null);
      api = useFluidHover(ref, { from: () => document.body });
      return (
        <div ref={ref} {...api.handlers}>
          <button className="menu-row">a</button>
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Host />));
    fakeRects(host);
    act(() => api!.handlers.onMouseEnter());
    expect(api!.activeIndex).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
