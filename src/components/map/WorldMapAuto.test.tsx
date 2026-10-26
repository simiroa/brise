import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

/**
 * D4(AUDIT-2026-09-26): WorldMapGL 은 실제 maplibre-gl 없이 마운트조차 못 하므로(jsdom 에 WebGL
 * 없음), WorldMapGL.test.tsx 와 같은 방식으로 maplibre-gl 인스턴스를 통째로 목킹한다. 검증
 * 대상은 WorldMapAuto 가 WorldMapGL 의 "이미 치명"이라는 판단(onGlFatal)을 재분류 없이 그대로
 * SVG 폴백으로 옮기는가다 — WorldMapGL.tsx 는 실제 모듈을 그대로 쓴다(mock 하지 않는다).
 */
const H = vi.hoisted(() => {
  type Listener = (e?: unknown) => void;

  class FakeMap {
    static last: FakeMap | null = null;
    opts: Record<string, unknown>;
    listeners = new Map<string, Listener[]>();
    flyTo = vi.fn();
    fitBounds = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    remove = vi.fn();
    isStyleLoaded = () => true;
    getSource = vi.fn(() => ({ setData: vi.fn() }));
    getLayer = vi.fn((): unknown => undefined);
    setPaintProperty = vi.fn();
    setStyle = vi.fn((style: string) => { this.opts.style = style; });
    unproject = (p: [number, number]) => ({ lng: p[0] / 10, lat: p[1] / 10 });
    getCenter = () => ({ lat: 37.5, lng: 127 });
    getZoom = () => 7;
    getBounds = () => ({ getSouth: () => 1, getNorth: () => 2, getWest: () => 3, getEast: () => 4 });
    dragPan = { enable: vi.fn(), disable: vi.fn() };
    scrollZoom = { enable: vi.fn(), disable: vi.fn() };
    boxZoom = { enable: vi.fn(), disable: vi.fn() };
    dragRotate = { enable: vi.fn(), disable: vi.fn() };
    keyboard = { enable: vi.fn(), disable: vi.fn() };
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
    touchZoomRotate = { enable: vi.fn(), disable: vi.fn() };

    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      FakeMap.last = this;
    }
    on(ev: string, fn: Listener) {
      const arr = this.listeners.get(ev) ?? [];
      arr.push(fn);
      this.listeners.set(ev, arr);
      return this;
    }
    once(ev: string, fn: Listener) {
      return this.on(ev, fn);
    }
    off() {
      return this;
    }
    fire(ev: string, e?: unknown) {
      for (const fn of this.listeners.get(ev) ?? []) fn(e);
    }
  }

  class FakeMarker {
    static all: FakeMarker[] = [];
    lngLat: [number, number] = [0, 0];
    listeners = new Map<string, Listener[]>();
    remove = vi.fn();
    constructor(public opts: { element: HTMLElement; draggable?: boolean }) {
      FakeMarker.all.push(this);
    }
    setLngLat(v: [number, number]) {
      this.lngLat = v;
      return this;
    }
    addTo() {
      return this;
    }
    getLngLat() {
      return { lng: this.lngLat[0], lat: this.lngLat[1] };
    }
    on() {
      return this;
    }
  }

  class FakeBounds {
    pts: [number, number][] = [];
    extend(p: [number, number]) {
      this.pts.push(p);
      return this;
    }
  }
  return { FakeMap, FakeMarker, FakeBounds };
});
const { FakeMap } = H;

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: () => {},
  Map: H.FakeMap,
  Marker: H.FakeMarker,
  LngLatBounds: H.FakeBounds,
}));

// WorldMapGL 은 실제 모듈 그대로(React.lazy 로 동적 import 된다) — SVG 쪽만 얇은 스텁으로
// 바꿔 "GL이 떴는지 SVG로 폴백했는지"를 data-testid 하나로 구분한다.
vi.mock('./WorldMap', () => ({
  WorldMap: () => <div data-testid="svg-map-stub" />,
}));

const reportFallbackMock = vi.fn();
vi.mock('../../lib/diag', () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

import { WorldMapAuto } from './WorldMapAuto';

beforeEach(() => {
  FakeMap.last = null;
  reportFallbackMock.mockClear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

/** GL 렌더가 Suspense 를 벗어나 실제 FakeMap 인스턴스를 만들 때까지 기다린다.
 *  React.lazy(() => import('./WorldMapGL')) 의 첫 동적 import 는 그 모듈 그래프(maplibre-gl 목,
 *  tileStyle, mapZoomScale 등)를 처음 불러오는 것이라 기본 waitFor 타임아웃(1000ms)보다 오래
 *  걸릴 수 있어 넉넉히 잡는다. */
async function waitForGlMount() {
  await waitFor(() => expect(FakeMap.last).not.toBeNull(), { timeout: 5000 });
  // Suspense fallback(SVG 스텁)이 실제로 걷혔는지도 함께 확인 — 안 그러면 아래 fire() 가
  // 아직 안 붙은 리스너에 쏘는 셈이라 통과해선 안 될 때도 통과해버릴 수 있다.
  await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).toBeNull());
}

describe('WorldMapAuto — GL의 이미-치명 판단은 재분류 없이 SVG 폴백으로 (D4)', () => {
  it('GL이 뜬 뒤엔 SVG 스텁이 없고, 실제 MapLibre webglcontextlost 이벤트 모양이 오면 SVG로 폴백한다', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();

    // maplibre-gl 의 실제 MapContextEvent 모양: { type, originalEvent }. message 필드가 없어
    // isFatalGlError 로 재분류하면 String() 이 "[object Object]"가 돼 늘 비치명으로 오판된다
    // (glErrorClassify.test.ts 회귀 고정) — WorldMapGL 이 onGlFatal 로 직접 넘겨야 여기서 잡힌다.
    const originalEvent = { statusMessage: 'context lost' };
    act(() => {
      FakeMap.last!.fire('webglcontextlost', { type: 'webglcontextlost', originalEvent });
    });

    await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).not.toBeNull());
  });

  it('초기 타일 8회 연속 실패도(map.on("error") 경유) 재분류 없이 SVG로 폴백한다', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();
    const m = FakeMap.last!;

    act(() => {
      for (let i = 0; i < 8; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });

    await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).not.toBeNull());
  });

  it('7회 연속 타일 실패만으로는 폴백하지 않는다 (GL 유지)', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();
    const m = FakeMap.last!;

    act(() => {
      for (let i = 0; i < 7; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });

    expect(screen.queryByTestId('svg-map-stub')).toBeNull();
  });

  it('스타일 로드 실패 같은 진짜 raw error 는 여전히 isFatalGlError 재분류를 거쳐 폴백한다(onGlError 경로 유지)', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();
    const m = FakeMap.last!;

    act(() => {
      m.fire('error', { dataType: 'style', message: 'Failed to load style' });
    });

    await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).not.toBeNull());
  });
});

// A(AUDIT-2026-09-26): GL→SVG 폴백이 실제로 일어날 때 reportFallback 이 정확히 한 번 불려야
// 한다 — onGlError 의 치명 재분류 경로와 onGlFatal 의 재분류 없는 경로 둘 다.
describe('WorldMapAuto — GL→SVG 폴백 계측(reportFallback, A)', () => {
  it('onGlFatal(재분류 없음) 폴백 시 reportFallback("map", "gl_fatal_error", ...) 을 한 번 호출한다', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();

    act(() => {
      FakeMap.last!.fire('webglcontextlost', { type: 'webglcontextlost', originalEvent: { statusMessage: 'lost' } });
    });

    await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).not.toBeNull());
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock).toHaveBeenCalledWith('map', 'gl_fatal_error', expect.any(String));
  });

  it('onGlError(재분류 경유) 폴백 시에도 reportFallback 을 호출한다', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();

    act(() => {
      FakeMap.last!.fire('error', { dataType: 'style', message: 'Failed to load style' });
    });

    await waitFor(() => expect(screen.queryByTestId('svg-map-stub')).not.toBeNull());
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock).toHaveBeenCalledWith('map', 'gl_fatal_error', 'Failed to load style');
  });

  it('비치명적 GL 경고(단순 타일 실패)는 reportFallback 을 호출하지 않는다', async () => {
    render(<WorldMapAuto />);
    await waitForGlMount();
    const m = FakeMap.last!;

    act(() => {
      for (let i = 0; i < 7; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });

    expect(screen.queryByTestId('svg-map-stub')).toBeNull();
    expect(reportFallbackMock).not.toHaveBeenCalled();
  });
});
