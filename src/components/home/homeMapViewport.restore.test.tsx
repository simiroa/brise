/**
 * Dashboard Map session viewport restore: pan/zoom survives HomeMapPane-style unmount/remount
 * (note open → home, or home inner-tab away from map), and other WorldMap consumers stay isolated.
 *
 * W8 "아를리트" 수정 이후 저장 단위는 픽셀 transform({k,x,y})이 아니라 **지리**({lat,lng,zoom})다
 * (stores/ui.ts::homeMapView 주석 참고). 복원도 별도 prop 없이 defaultLocation seed 경로를 그대로
 * 탄다 — 이 파일은 그 왕복(onViewChange 저장 → defaultLocation 복원)과, 저장 당시와 **다른
 * 뷰포트 크기**에서 복원해도 지리적 중심이 보존된다는 회귀(픽셀 저장 시절엔 서울이 사하라
 * "아를리트"로 이동했다)를 고정한다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { WorldMap, computeSeedTransform, screenToLngLat } from "../map/WorldMap";
import { useUiStore } from "../../stores/ui";

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
  useUiStore.setState({ homeMapView: null });
});

function fireResize(width: number, height: number) {
  act(() => {
    roCallback?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

function zoomIn(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        cancelable: true,
        bubbles: true,
        clientX: 200,
        clientY: 150,
      }),
    );
  });
}

function mapZoom(container: HTMLElement): number {
  const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
  return Number(el.getAttribute("data-perf-zoom"));
}

describe("dashboard map viewport session restore", () => {
  it("restores pan/zoom after unmount/remount; a bare WorldMap does not inherit it", () => {
    const seed = { lat: 10, lng: 20, zoom: 5 };
    const setHomeMapView = useUiStore.getState().setHomeMapView;

    // HomeMapPane wiring: commit the live geographic view into the session store.
    const first = render(
      <WorldMap width={400} height={300} defaultLocation={seed} onViewChange={setHomeMapView} />,
    );
    const firstEl = first.container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(mapZoom(first.container)).toBe(5);

    zoomIn(firstEl);
    const zoomAfterGesture = mapZoom(first.container);
    expect(zoomAfterGesture).toBeGreaterThan(5);
    expect(useUiStore.getState().homeMapView?.zoom).toBe(zoomAfterGesture);

    // Unmount = leave dashboard / leave map inner tab.
    first.unmount();

    // Remount: HomeMapPane seeds mapLocation from the stored view → defaultLocation.
    const saved = useUiStore.getState().homeMapView;
    expect(saved).not.toBeNull();
    const second = render(
      <WorldMap width={400} height={300} defaultLocation={saved!} onViewChange={setHomeMapView} />,
    );
    expect(mapZoom(second.container)).toBe(zoomAfterGesture);

    // Size correction re-seeds the same *geography* at the new size (seed path owns this).
    fireResize(480, 360);
    expect(mapZoom(second.container)).toBe(zoomAfterGesture);

    second.unmount();

    // Other WorldMap consumers (RegionExpanded / RegionFilter / picker) never read the session
    // store — they seed from their own defaultLocation.
    const other = render(
      <WorldMap width={320} height={220} defaultLocation={{ lat: 37.5665, lng: 126.978, zoom: 50 }} />,
    );
    expect(mapZoom(other.container)).toBe(50);
    expect(mapZoom(other.container)).not.toBe(zoomAfterGesture);
  });

  // 아를리트 회귀: 저장은 큰 뷰포트(1580×760)에서, 복원은 다른 크기(800×450 플레이스홀더든
  // 접힌 패널이든)에서 일어나도 화면 중심의 지리 좌표가 그대로여야 한다. 픽셀 transform 을
  // 저장하던 시절에는 x 가 작은 크기의 클램프 하한에 핀돼 서울(126.98E)이 사하라(≈2E) 벨트로
  // 이동했고, k=150 이라 도시 라벨 LOD 가 켜져 "아를리트"가 보였다.
  it("restoring at a different viewport size preserves the geographic center (Arlit regression)", () => {
    const setHomeMapView = useUiStore.getState().setHomeMapView;
    const seoul = { lat: 37.5665, lng: 126.978, zoom: 150 };

    // Save at a large viewport.
    const big = render(
      <WorldMap width={1580} height={760} defaultLocation={seoul} onViewChange={setHomeMapView} />,
    );
    const saved = useUiStore.getState().homeMapView;
    expect(saved).not.toBeNull();
    expect(saved!.lat).toBeCloseTo(seoul.lat, 3);
    expect(saved!.lng).toBeCloseTo(seoul.lng, 3);
    big.unmount();

    // Restore at a much smaller viewport — the stored view seeds via defaultLocation.
    const small = render(
      <WorldMap width={800} height={450} defaultLocation={saved!} onViewChange={setHomeMapView} />,
    );
    const el = small.container.querySelector('[data-perf="world-map"]') as HTMLElement;
    expect(Number(el.getAttribute("data-perf-zoom"))).toBe(150);

    // The re-saved view (seed echo through onViewChange) must still be Seoul, not the Sahara.
    const restored = useUiStore.getState().homeMapView!;
    expect(restored.lat).toBeCloseTo(seoul.lat, 2);
    expect(restored.lng).toBeCloseTo(seoul.lng, 2);
    small.unmount();
  });

  // 0×0 조건부 마운트(HomeTab 은 map 탭일 때만 렌더) — 실측 크기가 오면 저장된 지리 뷰로
  // 정확히 seed 되어야 한다(seed 경로가 hasRealSize 를 기다리므로 플레이스홀더 오염이 없다).
  it("a restored view survives a 0×0 mount — seeds at the real size once it arrives", () => {
    const restored = { lat: 37.5665, lng: 126.978, zoom: 120 };
    const { container } = render(
      <WorldMap width={0} height={0} defaultLocation={restored} />,
    );

    fireResize(950, 320);

    expect(mapZoom(container)).toBe(120);
    // Seeded for the *real* size: the screen center inverts back to the stored geography.
    const el = container.querySelector('[data-perf="world-map"]') as HTMLElement;
    const k = Number(el.getAttribute("data-perf-zoom"));
    expect(k).toBe(120);
  });

  it("screenToLngLat round-trips the seed center at any viewport size (pure math)", () => {
    // The invariant the whole restore path rests on: seed(view, w, h) centers `view` for (w, h).
    // If this breaks, the component tests above fail too — this pinpoints the math layer.
    const view = { lat: 37.5665, lng: 126.978, zoom: 150 };
    for (const [w, h] of [
      [1580, 760],
      [800, 450],
      [320, 220],
    ] as const) {
      const t = computeSeedTransform(view, w, h);
      const center = screenToLngLat(w / 2, h / 2, w, h, t);
      expect(center).not.toBeNull();
      expect(center!.lat).toBeCloseTo(view.lat, 2);
      expect(center!.lng).toBeCloseTo(view.lng, 2);
    }
  });
});
