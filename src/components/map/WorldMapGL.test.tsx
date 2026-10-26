import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { kToGlZoom } from './mapZoomScale';

// jsdom 에는 WebGL 이 없어 진짜 maplibre 는 마운트조차 못 한다. 검증 대상은 렌더 결과가 아니라
// "WorldMapGL 이 지도 API 를 계약대로 부르는가" 이므로 인스턴스를 통째로 목킹한다.
const H = vi.hoisted(() => {
  type Listener = (e?: unknown) => void;

  class FakeMap {
    static last: FakeMap | null = null;
    // D4 회귀 테스트 전용: 다음 생성 시도를 강제로 실패시킨다(maplibregl.Map 생성 자체가 던지는
    // 케이스 재현 — 실제 WebGL 미지원 등). 테스트가 끝나면 반드시 null 로 되돌린다.
    static throwOnConstruct: unknown = null;
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
      if (FakeMap.throwOnConstruct) throw FakeMap.throwOnConstruct;
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
    on(ev: string, fn: Listener) {
      const arr = this.listeners.get(ev) ?? [];
      arr.push(fn);
      this.listeners.set(ev, arr);
      return this;
    }
    fire(ev: string) {
      for (const fn of this.listeners.get(ev) ?? []) fn();
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
const { FakeMap, FakeMarker } = H;

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: () => {},
  Map: H.FakeMap,
  Marker: H.FakeMarker,
  LngLatBounds: H.FakeBounds,
}));

import { WorldMapGL, MARKER_RADIUS_PX, MARKER_PULSE_RADIUS_PX } from './WorldMapGL';
import { MAP_STYLE_URLS } from './tileStyle';
import { useSettingsStore } from '../../stores/settings';

const lastEl = () => FakeMarker.all[FakeMarker.all.length - 1].opts.element;
const pin = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-pin]')!;

// jsdom 컨테이너는 clientWidth 0 → 컴포넌트의 800px 폴백이 쓰인다.
const W = 800;

beforeEach(() => {
  FakeMap.last = null;
  FakeMap.throwOnConstruct = null;
  FakeMarker.all = [];
  useSettingsStore.setState({ theme: 'dark' });
});

describe('WorldMapGL 계약', () => {
  it('마운트 시 변환된 center/zoom 과 온라인 스타일로 Map 을 만든다', () => {
    const { container } = render(<WorldMapGL defaultLocation={{ lat: 37.5, lng: 127, zoom: 150 }} />);
    const m = FakeMap.last!;
    expect(m.opts.style).toBe(MAP_STYLE_URLS.dark); // 앱 기본 테마 = dark
    expect(m.opts.center).toEqual([127, 37.5]);
    expect(m.opts.zoom).toBeCloseTo(kToGlZoom(150, W), 9);
    // 내장 컨트롤은 끄고(펼침 박스 문제 회피), 대신 항상-보이는 텍스트 스트립으로 ODbL 문구를 낸다.
    expect(m.opts.attributionControl).toBe(false);
    expect(container.querySelector('[data-testid="map-attribution"]')?.textContent).toContain(
      'OpenStreetMap contributors'
    );
  });

  it('live=false 면 maplibregl.Map 을 생성하지 않는다', () => {
    render(<WorldMapGL live={false} />);
    expect(FakeMap.last).toBeNull();
  });

  it('defaultLocation 레퍼런스가 바뀌면 flyTo 한다', () => {
    const { rerender } = render(<WorldMapGL defaultLocation={{ lat: 0, lng: 0, zoom: 2 }} />);
    const m = FakeMap.last!;
    expect(m.flyTo).not.toHaveBeenCalled();
    rerender(<WorldMapGL defaultLocation={{ lat: 48.85, lng: 2.35, zoom: 320 }} />);
    expect(m.flyTo).toHaveBeenCalledWith({ center: [2.35, 48.85], zoom: kToGlZoom(320, W) });
  });

  it('moveend 에서 onViewChange 는 k 단위로, onViewportChange 는 bbox 로 보고한다', () => {
    const onViewChange = vi.fn();
    const onViewportChange = vi.fn();
    render(<WorldMapGL onViewChange={onViewChange} onViewportChange={onViewportChange} />);
    act(() => FakeMap.last!.fire('moveend'));
    expect(onViewChange).toHaveBeenCalledWith({
      lat: 37.5,
      lng: 127,
      zoom: (512 * 2 ** 7) / W, // glZoomToK(7, 800)
    });
    expect(onViewportChange).toHaveBeenCalledWith({ min_lat: 1, max_lat: 2, min_lng: 3, max_lng: 4 });
  });

  it('마커를 붙이고, 드래그 종료 시 onMarkerMove 를 부른다', () => {
    const onMarkerMove = vi.fn();
    render(
      <WorldMapGL
        markers={[{ id: 'n1', lat: 10, lng: 20 }]}
        onMarkerMove={onMarkerMove}
      />
    );
    const mk = FakeMarker.all[FakeMarker.all.length - 1];
    expect(mk.lngLat).toEqual([20, 10]);
    expect(mk.opts.draggable).toBe(true);
    mk.setLngLat([21, 11]);
    act(() => mk.fire('dragend'));
    expect(onMarkerMove).toHaveBeenCalledWith('n1', 11, 21);
  });

  it('마커 클릭이 onMarkerClick 으로 배선된다', async () => {
    const onMarkerClick = vi.fn();
    render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2 }]} onMarkerClick={onMarkerClick} />);
    const el = FakeMarker.all[FakeMarker.all.length - 1].opts.element;
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onMarkerClick).toHaveBeenCalledWith('n1');
  });

  it('마커 더블클릭은 그 장소로 flyTo 한다 (PICK_FLYTO_ZOOM, 현재가 더 깊으면 유지)', async () => {
    render(<WorldMapGL markers={[{ id: 'n1', lat: 10, lng: 20 }]} />);
    const m = FakeMap.last!;
    const el = FakeMarker.all[FakeMarker.all.length - 1].opts.element;
    await act(async () => {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    // getZoom()=7 → k≈81.9 < 320 이므로 목표 줌은 kToGlZoom(320, W).
    expect(m.flyTo).toHaveBeenCalledWith({ center: [20, 10], zoom: kToGlZoom(320, W) });
  });

  it('잠금 상태에선 마커 더블클릭 fly-to 를 하지 않는다', async () => {
    const user = userEvent.setup();
    render(<WorldMapGL markers={[{ id: 'n1', lat: 10, lng: 20 }]} />);
    const m = FakeMap.last!;
    await user.click(screen.getAllByRole('button')[0]); // 잠금
    const el = FakeMarker.all[FakeMarker.all.length - 1].opts.element;
    await act(async () => {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(m.flyTo).not.toHaveBeenCalled();
  });

  it('지도 클릭은 팬 직후엔 삼키고, 정지 상태에선 onMapClick 을 부른다', () => {
    const onMapClick = vi.fn();
    render(<WorldMapGL onMapClick={onMapClick} />);
    const m = FakeMap.last!;
    act(() => {
      m.fire('movestart');
      m.fire('move');
      m.fire('click', { lngLat: { lat: 5, lng: 6 } });
    });
    expect(onMapClick).not.toHaveBeenCalled();
    act(() => {
      m.fire('movestart'); // movedRef 리셋
      m.fire('click', { lngLat: { lat: 5, lng: 6 } });
    });
    expect(onMapClick).toHaveBeenCalledWith(5, 6);
  });

  it('잠금 버튼이 인터랙션 핸들러를 끈다', async () => {
    const user = userEvent.setup();
    render(<WorldMapGL />);
    const m = FakeMap.last!;
    m.dragPan.disable.mockClear();
    await user.click(screen.getAllByRole('button')[0]);
    expect(m.dragPan.disable).toHaveBeenCalled();
    expect(m.scrollZoom.disable).toHaveBeenCalled();
  });

  it('홈 버튼은 homeLocation 으로 fly 한다', async () => {
    const user = userEvent.setup();
    render(
      <WorldMapGL
        defaultLocation={{ lat: 0, lng: 0, zoom: 2 }}
        homeLocation={{ lat: 35, lng: 129, zoom: 150 }}
      />
    );
    const m = FakeMap.last!;
    await user.click(screen.getAllByRole('button')[1]);
    expect(m.flyTo).toHaveBeenCalledWith({ center: [129, 35], zoom: kToGlZoom(150, W) });
  });

  it('regionFocusPoints 레퍼런스가 오면 fitBounds 한다', () => {
    const { rerender } = render(<WorldMapGL />);
    rerender(<WorldMapGL regionFocusPoints={[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]} />);
    expect(FakeMap.last!.fitBounds).toHaveBeenCalled();
  });

  describe('테마 연동', () => {
    it('라이트 테마로 마운트하면 liberty 스타일을 쓴다', () => {
      useSettingsStore.setState({ theme: 'light' });
      render(<WorldMapGL />);
      expect(FakeMap.last!.opts.style).toBe(MAP_STYLE_URLS.light);
    });

    it('테마가 바뀌면 setStyle 로 즉시 전환하고, style.load 에서 커스텀 레이어를 다시 깐다', () => {
      render(<WorldMapGL pathLines={[{ id: 'p1', points: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] }]} />);
      const m = FakeMap.last!;
      act(() => m.fire('style.load'));
      expect(m.addLayer).toHaveBeenCalledTimes(1);

      act(() => useSettingsStore.setState({ theme: 'light' }));
      expect(m.setStyle).toHaveBeenCalledWith(MAP_STYLE_URLS.light);

      // setStyle 은 커스텀 소스/레이어를 날린다 → 다음 style.load 에서 재설치되어야 한다.
      m.getLayer.mockReturnValue(undefined);
      act(() => m.fire('style.load'));
      expect(m.addSource).toHaveBeenCalledTimes(2);
      expect(m.addLayer).toHaveBeenCalledTimes(2);
      // 재설치된 소스는 현재 pathLines 를 그대로 담고 있어야 한다(빈 배열로 리셋 금지).
      const data = m.addSource.mock.calls[1][1].data;
      expect(data.features[0].geometry.coordinates).toEqual([[2, 1], [4, 3]]);
    });

    it('이미 레이어가 있으면 중복 설치하지 않는다', () => {
      render(<WorldMapGL />);
      const m = FakeMap.last!;
      m.getLayer.mockReturnValue({ id: 'brise-paths-line' });
      act(() => m.fire('style.load'));
      expect(m.addLayer).not.toHaveBeenCalled();
    });
  });

  // 시각 확인이 불가하므로 SVG MarkerLayer 원본 상수와 값으로 고정한다.
  describe('마커 비주얼 (SVG MarkerLayer 패리티)', () => {
    it('비활성 노트 핀 = --text 65%, 반지름 4px, 1px 테두리 (accent 아님)', () => {
      render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2 }]} />);
      const p = pin(lastEl());
      expect(p.style.width).toBe(`${MARKER_RADIUS_PX.note.idle * 2}px`);
      expect(p.style.background).toBe('var(--text)');
      expect(p.style.opacity).toBe('0.65');
      expect(p.style.borderWidth).toBe('1px');
    });

    it('활성 노트 핀 = accent, 반지름 6px, 2px 테두리 + 헤일로 + 펄스 원', () => {
      render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2, active: true }]} />);
      const el = lastEl();
      const p = pin(el);
      expect(p.style.width).toBe(`${MARKER_RADIUS_PX.note.active * 2}px`);
      expect(p.style.background).toBe('var(--accent)');
      expect(p.style.opacity).toBe('1');
      expect(p.style.borderWidth).toBe('2px');
      const pulse = el.querySelector<HTMLElement>('.map-pulse-circle')!;
      expect(pulse.style.width).toBe(`${MARKER_PULSE_RADIUS_PX * 2}px`);
      // 헤일로: baseRadius * 1.8 (지름 = r * 3.6)
      const halo = Array.from(el.querySelectorAll<HTMLElement>('div')).find(
        (d) => d.style.opacity === '0.3'
      );
      expect(halo?.style.width).toBe(`${MARKER_RADIUS_PX.note.active * 3.6}px`);
    });

    it('primary 핀은 비활성이어도 accent + 2px, waypoint 는 color 채움 + 헤일로/펄스 없음', () => {
      render(
        <WorldMapGL
          markers={[
            { id: 'p', lat: 1, lng: 2, pinSize: 'primary' },
            { id: 'w', lat: 3, lng: 4, pinSize: 'waypoint', color: 'var(--info)', active: true },
          ]}
        />
      );
      const [pEl, wEl] = FakeMarker.all.slice(-2).map((m) => m.opts.element);
      expect(pin(pEl).style.background).toBe('var(--accent)');
      expect(pin(pEl).style.borderWidth).toBe('2px');
      expect(pin(pEl).style.width).toBe(`${MARKER_RADIUS_PX.primary.idle * 2}px`);
      expect(pin(wEl).style.background).toBe('var(--info)');
      expect(pin(wEl).style.borderColor).toBe('var(--surface-base)');
      expect(pin(wEl).style.opacity).toBe('1');
      // 활성 waypoint 라도 헤일로는 없다 (SVG: pinSize !== 'waypoint' 조건)
      expect(
        Array.from(wEl.querySelectorAll<HTMLElement>('div')).some((d) => d.style.opacity === '0.3')
      ).toBe(false);
    });

    it('region 라벨 박스는 active + region 일 때만, 10자 초과 시 말줄임', () => {
      const { rerender } = render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2, region: '서울' }]} />);
      expect(lastEl().querySelector('[data-region-label]')).toBeNull();
      rerender(
        <WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2, region: '아주아주긴지역이름입니다', active: true }]} />
      );
      const label = lastEl().querySelector<HTMLElement>('[data-region-label]')!;
      expect(label.textContent).toBe('아주아주긴지역이름…');
      expect(label.style.width).toBe('80px');
      expect(label.style.height).toBe('16px');
    });

    it('dim 은 마커 전체를 0.35 로 흐린다', () => {
      render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2, dim: true }]} />);
      expect(lastEl().style.opacity).toBe('0.35');
    });

    it('드래그 중엔 0.6 으로 흐리고 종료 시 되돌린다', () => {
      render(<WorldMapGL markers={[{ id: 'n1', lat: 1, lng: 2 }]} onMarkerMove={vi.fn()} />);
      const mk = FakeMarker.all[FakeMarker.all.length - 1];
      act(() => mk.fire('dragstart'));
      expect(mk.opts.element.style.opacity).toBe('0.6');
      act(() => mk.fire('dragend'));
      expect(mk.opts.element.style.opacity).toBe('1');
    });
  });

  it('비인터랙티브 핀은 클릭을 삼키지 않는다 (웨이포인트/임시 핀 위 클릭 = 빈 지도 클릭)', () => {
    render(<WorldMapGL markers={[{ id: 'wp:1', lat: 1, lng: 2, pinSize: 'waypoint', interactive: false }]} />);
    const el = FakeMarker.all[FakeMarker.all.length - 1].opts.element;
    expect(el.style.pointerEvents).toBe('none');
    expect(pin(el).style.pointerEvents).toBe('none');
  });

  it("치명적 map 'error' (스타일 로드 실패 등) 가 onGlError 로 전달된다", () => {
    const onGlError = vi.fn();
    render(<WorldMapGL onGlError={onGlError} />);
    act(() => FakeMap.last!.fire('error', { dataType: 'style', message: 'Failed to load style' }));
    expect(onGlError).toHaveBeenCalledWith({ dataType: 'style', message: 'Failed to load style' });
  });

  it('단순 타일 404 나 리소스 경고는 onGlError 를 트리거하지 않는다 (과민 폴백 방지)', () => {
    const onGlError = vi.fn();
    render(<WorldMapGL onGlError={onGlError} />);
    act(() => FakeMap.last!.fire('error', { tile: {}, message: 'tile 404' }));
    expect(onGlError).not.toHaveBeenCalled();
  });

  // D4(AUDIT-2026-09-26): webglcontextlost/8연속 타일 실패/Map 생성 실패는 WorldMapGL 자신이 이미
  // "복구 불가"라고 판단을 마친 경우다 — isFatalGlError 로 재분류될 여지가 있는 onGlError 가
  // 아니라 onGlFatal 로 직접 간다(재분류하면 세 경우 다 비치명으로 오판된다 — glErrorClassify.test.ts).
  it('webglcontextlost 이벤트는 재분류 없이 onGlFatal 로 전달된다 (onGlError 는 안 부른다)', () => {
    const onGlError = vi.fn();
    const onGlFatal = vi.fn();
    render(<WorldMapGL onGlError={onGlError} onGlFatal={onGlFatal} />);
    const originalEvent = { statusMessage: 'context lost' };
    act(() => FakeMap.last!.fire('webglcontextlost', { type: 'webglcontextlost', originalEvent }));
    expect(onGlFatal).toHaveBeenCalledWith({ type: 'webglcontextlost', originalEvent });
    expect(onGlError).not.toHaveBeenCalled();
  });

  it('초기 타일이 7회 연속 실패해도 폴백하지 않는다 (아직 치명 아님)', () => {
    const onGlFatal = vi.fn();
    render(<WorldMapGL onGlFatal={onGlFatal} />);
    const m = FakeMap.last!;
    act(() => {
      for (let i = 0; i < 7; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });
    expect(onGlFatal).not.toHaveBeenCalled();
  });

  it('초기 타일이 8회 연속 실패하면 재분류 없이 onGlFatal 로 폴백한다', () => {
    const onGlError = vi.fn();
    const onGlFatal = vi.fn();
    render(<WorldMapGL onGlError={onGlError} onGlFatal={onGlFatal} />);
    const m = FakeMap.last!;
    act(() => {
      for (let i = 0; i < 8; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });
    expect(onGlFatal).toHaveBeenCalledTimes(1);
    expect(onGlError).not.toHaveBeenCalled();
  });

  it('타일이 한 번이라도 로드되면 연속 실패 카운터가 리셋된다 (8회 누적으로 오폴백하지 않음)', () => {
    const onGlFatal = vi.fn();
    render(<WorldMapGL onGlFatal={onGlFatal} />);
    const m = FakeMap.last!;
    act(() => {
      for (let i = 0; i < 5; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
      m.fire('data', { dataType: 'source', isSourceLoaded: true });
      for (let i = 0; i < 7; i++) m.fire('error', { tile: {}, message: 'tile load failed' });
    });
    expect(onGlFatal).not.toHaveBeenCalled();
  });

  it('maplibregl.Map 생성 자체가 던지면 재분류 없이 onGlFatal 로 전달된다', () => {
    const onGlError = vi.fn();
    const onGlFatal = vi.fn();
    const boom = new Error('WebGL context creation failed');
    FakeMap.throwOnConstruct = boom;
    render(<WorldMapGL onGlError={onGlError} onGlFatal={onGlFatal} />);
    expect(onGlFatal).toHaveBeenCalledWith(boom);
    expect(onGlError).not.toHaveBeenCalled();
    // 생성이 실패했으니 인스턴스가 남지 않아야 한다.
    expect(FakeMap.last).toBeNull();
  });

  it('다크모드에서는 map-theme-tint 의 opacity 가 0 이고, 라인 레이어에 악센트 컬러가 적용된다', () => {
    useSettingsStore.setState({ theme: 'dark', accent: '#e06b9f' });
    render(<WorldMapGL />);
    const tint = screen.getByTestId('map-theme-tint');
    expect(tint.style.opacity).toBe('0');

    // FakeMap 에 레이어 모의 및 style.load 발화 검증
    const map = FakeMap.last!;
    map.getLayer.mockReturnValue({});
    act(() => map.fire('style.load'));

    // 육지/바다 구분 톤
    expect(map.setPaintProperty).toHaveBeenCalledWith('background', 'background-color', '#0b0d0c');
    expect(map.setPaintProperty).toHaveBeenCalledWith('water', 'fill-color', expect.any(String));
    // 도로는 악센트 컬러 (내부가 채워진 솔리드 스타일)
    expect(map.setPaintProperty).toHaveBeenCalledWith('highway_motorway_casing', 'line-color', expect.stringContaining('rgba('));
    expect(map.setPaintProperty).toHaveBeenCalledWith('highway_motorway_inner', 'line-color', expect.stringContaining('rgba('));
    expect(map.setPaintProperty).toHaveBeenCalledWith('highway_major_casing', 'line-color', expect.stringContaining('rgba('));
    // 글자는 고대비 선명화
    expect(map.setPaintProperty).toHaveBeenCalledWith('place_city', 'text-color', '#f0edf6');
  });
});
