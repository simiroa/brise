import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre v6 resolves its worker at RUNTIME as `./maplibre-gl-worker.mjs` next to its own module
// URL. Vite cannot see that, so no built output (desktop release, phone /app) ever contained the
// file: the server answered the worker request with index.html, the worker died, and the map stayed
// a blank dark canvas — only `tauri dev` worked, because the dev server serves node_modules
// (found on the phone 2026-10-06). `?worker&url` makes Vite bundle the worker together with its
// own import (maplibre-gl-shared.mjs) and hands us the emitted URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
maplibregl.setWorkerUrl?.(maplibreWorkerUrl);
import { registerNoteDropHandler, noteDropTargetProps } from '../../lib/noteDrag';
import { MapControlBar } from './MapControlBar';
import { mapStyleUrl } from './tileStyle';
import { kToGlZoom, glZoomToK, REGION_FIT_PADDING, PICK_FLYTO_ZOOM } from './mapZoomScale';
import { FACTORY_DEFAULT_MAP_LOCATION, useSettingsStore } from '../../stores/settings';
import { DEFAULT_ACCENT } from '../../lib/accentPalette';
import type { WorldMapProps, MapLocation, MapMarker } from './WorldMap';
import { isFatalGlError } from './glErrorClassify';

/**
 * MapLibre GL 렌더러. 기존 SVG `WorldMap` 과 **같은 props 계약**(WorldMapProps)을 구현한다 —
 * 호스트(HomeMapPane / RegionExpanded / RegionFilter / RegionPickerDialog / RegionPreview)는
 * 어느 쪽이 렌더되는지 몰라야 한다. 온라인/오프라인 선택은 WorldMapAuto 가 한다.
 *
 * 줌 단위: 바깥(props·콜백·설정 저장값)은 전부 기존 SVG 의 k 를 유지하고, 안쪽 MapLibre zoom
 * 으로의 변환은 mapZoomScale.ts 의 kToGlZoom/glZoomToK 에서만 한다. 노트북 설정에 이미 저장된
 * k 값(예: 150)이 그대로 살아야 하기 때문.
 */
export interface WorldMapGLProps extends WorldMapProps {
  /**
   * map.on('error') 로 들어온, 아직 치명도가 불분명한 원시 이벤트. isFatalGlError 로 재분류할
   * 여지가 있는 쪽만 여기로 온다 — WorldMapAuto 가 그 분류기를 다시 돌려 폴백 여부를 정한다.
   */
  onGlError?: (e: unknown) => void;
  /**
   * D4(AUDIT-2026-09-26): 이 컴포넌트 자신이 "복구 불가"라고 이미 판단을 마친 경우(Map 생성
   * 자체 실패, 초기 타일 8회 연속 실패, webglcontextlost) 전달하는 콜백. onGlError 와 달리
   * WorldMapAuto 가 isFatalGlError 로 다시 판별하지 않는다 — 8연속 타일 실패는 도메인 판단
   * (연속 횟수)이라 문자열 분류기가 재현할 수 없고, webglcontextlost 이벤트는 String() 하면
   * "[object Object]"가 돼 항상 비치명으로 오판된다. 그 결과 GL 이 이미 포기를 선언했는데도
   * WorldMapAuto 가 SVG 폴백으로 안 넘어가 지도가 빈 채로 남았다(WorldMapAuto.tsx:50 참고).
   */
  onGlFatal?: (e: unknown) => void;
  /**
   * maplibre 생성 옵션에 그대로 흘려보내는 스냅샷용 플래그(공간 지도 스냅샷 모달이 유일하게
   * 켠다). WebGL 컨텍스트는 귀하므로 상주 지도는 절대 켜지 않는다 — toDataURL 로 방금 그린
   * 프레임을 읽으려면 preserveDrawingBuffer 가 필요하다(maplibre 계약).
   */
  preserveDrawingBuffer?: boolean;
}

const PATH_SOURCE = 'brise-paths';
const PATH_LAYER = 'brise-paths-line';

function accentColor(): string {
  const v = typeof getComputedStyle === 'function'
    ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    : '';
  return v || DEFAULT_ACCENT;
}

export function hexToRgba(hex: string, alpha: number): string {
  let c = (hex || '').replace('#', '').trim();
  if (c.length === 3) {
    c = c.split('').map((ch) => ch + ch).join('');
  }
  const num = parseInt(c, 16);
  if (isNaN(num) || c.length !== 6) {
    return `rgba(156, 197, 164, ${alpha})`;
  }
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function resolveCssColor(cssVar: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  try {
    const temp = document.createElement('div');
    temp.style.color = cssVar;
    document.body.appendChild(temp);
    const computed = getComputedStyle(temp).color;
    document.body.removeChild(temp);
    return computed || fallback;
  } catch {
    return fallback;
  }
}

// isFatalGlError 는 glErrorClassify.ts 로 옮겼다(2026-09-19) — maplibre-gl 을 전혀 쓰지 않는
// 순수 판별인데 이 파일의 정적 import 'maplibre-gl' 옆에 있다는 이유만으로, 그 함수 하나만
// 필요한 WorldMapAuto.tsx 가 이 파일을 정적 import 하면서 React.lazy 분리를 무효화시켰다
// (glErrorClassify.ts 헤더 주석 참고). 위에서 import 해 이 파일 안(아래 411행)에서 그대로 쓰고,
// 기존 호출부(테스트의 `from "./WorldMapGL"` import 등)를 깨지 않도록 여기서 재수출도 한다.
export { isFatalGlError };

/**
 * 다크모드 전용 맵 스타일 튜닝:
 * - 바다는 앱 기본 바탕색(var(--app-sheet-base))으로 일체화하고, 육지는 안정된 딥 차콜(#0b0d0c)로 명확히 분리합니다.
 * - 도로 라인은 내부가 꽉 찬 솔리드 실선(filled style)으로 렌더링합니다.
 * - 글자 라벨(도시, 국가, 도로명 등)은 밝은 고대비(#f0edf6)와 짙은 헤일로로 선명하게 표시합니다.
 */
export function applyMapDarkTheme(map: maplibregl.Map, accentHex: string) {
  try {
    // setPaintProperty<K extends keyof AllPaintProperties> 는 레이어마다 다른 속성명을 이 헬퍼
    // 하나로 받는 것과 상충한다(제네릭 K 는 호출부마다 리터럴 하나로 좁혀야 함). AllPaintProperties
    // 는 maplibre-gl 이 재수출하지 않는 내부 타입이라 여기서 이름을 가져올 수 없어, 함수 타입을
    // 통째로 넓혀 캐스트한다 — 다양한 실제 prop 이름(line-color/fill-color/text-color/
    // background-color 등)에 대해 이미 vitest 계약 테스트(WorldMapGL.test.tsx)로 값까지 고정돼 있다.
    const setPaintPropertyUnchecked = map.setPaintProperty as (
      layerId: string,
      name: string,
      value: unknown
    ) => void;
    const setSafe = (id: string, prop: string, val: unknown) => {
      try {
        if (map.getLayer?.(id)) {
          setPaintPropertyUnchecked(id, prop, val);
        }
      } catch {
        // 레이어가 없는 경우 안전하게 통과
      }
    };

    // 앱의 기본 바탕면 색상 추출 (바다가 앱의 바탕과 일체화되도록 반영)
  const appBg = resolveCssColor('var(--app-sheet-base)', resolveCssColor('var(--surface-base)', '#171b1a'));

  // 1. 바다는 앱 기본 바탕색으로 일체화, 육지는 안정된 딥 차콜로 분리
  // 바다/해양/호수: 앱 기본 바탕면 색상 + 섬세한 해안선 외곽선
  setSafe('water', 'fill-color', appBg);
  setSafe('water', 'fill-outline-color', 'rgba(255, 255, 255, 0.18)');
  setSafe('waterway', 'line-color', appBg);

  // 육지 기본 바탕: 바다(앱 바탕)와 은은하게 구분되는 딥 차콜 블랙 (#0b0d0c)
  setSafe('background', 'background-color', '#0b0d0c');
  setSafe('landcover_ice_shelf', 'fill-color', '#0b0d0c');
  setSafe('landcover_glacier', 'fill-color', '#0b0d0c');
  setSafe('landuse_residential', 'fill-color', '#0b0d0c');
  setSafe('landcover_wood', 'fill-color', '#090b0a');
  setSafe('landuse_park', 'fill-color', '#090b0a');
  setSafe('building', 'fill-color', '#141615');
  setSafe('building', 'fill-outline-color', '#0b0d0c');
  setSafe('aeroway-area', 'fill-color', '#0b0d0c');
  setSafe('road_area_pier', 'fill-color', '#0b0d0c');

  // 2. 도로 라인: 톤을 차분하게 낮춘 솔리드 라인 스타일 ("도로 색 톤다운")
  // 고속도로/순환도로: 차분하고 은은한 악센트 톤으로 꽉 찬 실선 렌더링
  setSafe('highway_motorway_casing', 'line-color', hexToRgba(accentHex, 0.20));
  setSafe('highway_motorway_inner', 'line-color', hexToRgba(accentHex, 0.38));
  setSafe('highway_motorway_subtle', 'line-color', hexToRgba(accentHex, 0.18));
  // 주요 간선도로: 고속도로보다 한 단계 더 은은하게 정돈
  setSafe('highway_major_casing', 'line-color', hexToRgba(accentHex, 0.16));
  setSafe('highway_major_inner', 'line-color', hexToRgba(accentHex, 0.30));
  setSafe('highway_major_subtle', 'line-color', hexToRgba(accentHex, 0.14));
  // 일반 도로 및 소로
  setSafe('highway_minor', 'line-color', hexToRgba(accentHex, 0.12));
  setSafe('highway_path', 'line-color', hexToRgba(accentHex, 0.08));
  // 행정 구역 경계선
  setSafe('boundary_state', 'line-color', hexToRgba(accentHex, 0.22));
  setSafe('boundary_country_z0-4', 'line-color', hexToRgba(accentHex, 0.32));
  setSafe('boundary_country_z5-', 'line-color', hexToRgba(accentHex, 0.32));
  // 철도
  setSafe('railway', 'line-color', hexToRgba(accentHex, 0.12));
  setSafe('railway_transit', 'line-color', hexToRgba(accentHex, 0.12));
  setSafe('railway_minor', 'line-color', hexToRgba(accentHex, 0.08));

  // 3. 텍스트 라벨 선명화 ("글자는 잘보이게")
  const placeLayers = [
    'place_city_large',
    'place_city',
    'place_town',
    'place_village',
    'place_suburb',
    'place_other',
    'place_state',
    'place_country_major',
    'place_country_minor',
    'place_country_other',
  ];
  for (const layerId of placeLayers) {
    setSafe(layerId, 'text-color', '#f0edf6');
    setSafe(layerId, 'text-halo-color', 'rgba(0, 0, 0, 0.92)');
    setSafe(layerId, 'text-halo-width', 1.6);
    setSafe(layerId, 'text-halo-blur', 1);
  }
  setSafe('highway_name_other', 'text-color', '#e8e6e4');
  setSafe('highway_name_other', 'text-halo-color', 'rgba(0, 0, 0, 0.9)');
  setSafe('highway_name_other', 'text-halo-width', 1.3);
  setSafe('highway_name_motorway', 'text-color', '#ffffff');
  setSafe('highway_name_motorway', 'text-halo-color', 'rgba(0, 0, 0, 0.9)');
  setSafe('highway_name_motorway', 'text-halo-width', 1.3);
  setSafe('water_name', 'text-color', '#c8d8e6');
  setSafe('water_name', 'text-halo-color', 'rgba(0, 0, 0, 0.9)');
  setSafe('water_name', 'text-halo-width', 1.3);
  } catch (err) {
    console.warn('[map] applyMapDarkTheme safe error:', err);
  }
}

/**
 * SVG `MarkerLayer` 의 화면 픽셀 상수 — GL 마커는 이 값을 그대로 쓴다.
 * (SVG 는 `sizePx / transform.k` 로 그린 뒤 k 배 스케일되는 그룹 안에 들어가 결국 화면상
 *  반지름이 sizePx 로 고정됐다. DOM 마커는 애초에 픽셀 고정이라 같은 값이 그대로 맞다.)
 */
export const MARKER_RADIUS_PX = {
  primary: { active: 8, idle: 7 },
  note: { active: 6, idle: 4 },
  waypoint: { active: 3.5, idle: 3.5 },
} as const;
/** 활성 핀 주변 펄스 원 반지름(MarkerLayer 의 r={18 / k}). */
export const MARKER_PULSE_RADIUS_PX = 18;

function dot(styles: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-50%);border-radius:50%;${styles}`;
  return d;
}

/**
 * SVG MarkerLayer 와 같은 비주얼을 DOM 으로 만든다: 펄스 원 → 활성 헤일로 → 핀 → region 라벨 박스.
 * 컨테이너는 0×0 이라 MapLibre 가 좌표에 정확히 앉히고, 자식만 중앙 정렬된다.
 */
function markerEl(m: MapMarker): HTMLElement {
  const el = document.createElement('div');
  el.className = 'gl-marker';
  const size = m.pinSize ?? 'note';
  const active = !!m.active;
  const interactive = m.interactive !== false;
  const r = MARKER_RADIUS_PX[size][active ? 'active' : 'idle'];
  const strokeW = active || size === 'primary' ? 2 : 1;

  el.style.cssText = [
    'position:relative',
    'width:0',
    'height:0',
    // 컨테이너는 클릭을 삼키지 않는다 — 비인터랙티브 핀(웨이포인트/임시 핀) 위 클릭은 SVG 와
    // 똑같이 빈 지도 클릭으로 떨어져야 한다.
    'pointer-events:none',
    `opacity:${m.dim ? 0.35 : 1}`,
  ].join(';');

  if (active) {
    // 펄스: 애니메이션이 transform 을 덮어쓰므로 중앙 정렬용 래퍼를 따로 둔다.
    const wrap = dot('width:0;height:0');
    const pulse = document.createElement('div');
    pulse.className = 'map-pulse-circle';
    pulse.style.cssText = [
      'position:absolute',
      `left:${-MARKER_PULSE_RADIUS_PX}px`,
      `top:${-MARKER_PULSE_RADIUS_PX}px`,
      `width:${MARKER_PULSE_RADIUS_PX * 2}px`,
      `height:${MARKER_PULSE_RADIUS_PX * 2}px`,
      'border-radius:50%',
      'background:var(--accent)',
      'border-style:solid;border-width:1px;border-color:var(--accent)',
      'box-sizing:border-box',
    ].join(';');
    wrap.appendChild(pulse);
    el.appendChild(wrap);

    if (size !== 'waypoint') {
      el.appendChild(
        dot(`width:${r * 3.6}px;height:${r * 3.6}px;background:var(--accent);opacity:0.3`)
      );
    }
  }

  const fill =
    size === 'waypoint'
      ? (m.color ?? 'var(--surface-base)')
      : active || size === 'primary'
        ? 'var(--accent)'
        : 'var(--text)';
  const stroke =
    size === 'waypoint' ? (m.color ? 'var(--surface-base)' : 'var(--accent)') : 'var(--surface-base)';

  const pin = dot(
    [
      `width:${r * 2}px`,
      `height:${r * 2}px`,
      `background:${fill}`,
      // 단축 `border:` 는 var() 가 섞이면 jsdom 이 파싱을 통째로 버린다 — 롱핸드로 쓴다.
      `border-style:solid;border-width:${strokeW}px;border-color:${stroke}`,
      'box-sizing:content-box',
      `opacity:${size === 'waypoint' ? 1 : active ? 1 : 0.65}`,
      interactive ? 'pointer-events:auto;cursor:pointer' : 'pointer-events:none',
    ].join(';')
  );
  pin.dataset.pin = 'true';
  el.appendChild(pin);

  // 활성 + region 일 때만 뜨는 이름 박스 (SVG: 핀 위 10px, 80×16, 10자 초과 시 말줄임).
  if (active && m.region) {
    const label = document.createElement('div');
    label.dataset.regionLabel = 'true';
    label.textContent = m.region.length > 10 ? `${m.region.slice(0, 9)}…` : m.region;
    label.style.cssText = [
      'position:absolute',
      'left:-40px',
      'bottom:10px',
      'width:80px',
      'height:16px',
      'line-height:14px',
      'text-align:center',
      'font-size:10px',
      'font-weight:400',
      'color:var(--text)',
      'background:var(--surface-base)',
      'border:1px solid var(--divider)',
      'border-radius:3px',
      'opacity:0.9',
      'box-sizing:border-box',
      'user-select:none',
      'pointer-events:none',
    ].join(';');
    el.appendChild(label);
  }

  return el;
}

export const WorldMapGL: React.FC<WorldMapGLProps> = ({
  markers = [],
  pathLines = [],
  regionFocusPoints,
  onMarkerClick,
  onMapClick,
  onMapContextMenu,
  onDropNote,
  onMarkerMove,
  onViewportChange,
  defaultLocation,
  homeLocation,
  onViewChange,
  frameless = false,
  live = true,
  onGlError,
  onGlFatal,
  preserveDrawingBuffer = false,
  isLocked: propLocked,
  onToggleLock,
  hideControls = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [internalLocked, setInternalLocked] = useState(false);
  const isLocked = propLocked !== undefined ? propLocked : internalLocked;
  const setIsLocked = onToggleLock ? onToggleLock : setInternalLocked;

  // 콜백/최신 props 는 ref 로 읽는다 — 맵 인스턴스는 마운트 시 1회만 만들고 리스너를 다시 달지
  // 않기 위해서. (SVG 쪽 onViewChangeRef 와 같은 패턴.)
  const cb = useRef({ onMapClick, onMapContextMenu, onViewChange, onViewportChange, onDropNote, onMarkerMove, onMarkerClick, onGlError, onGlFatal });
  cb.current = { onMapClick, onMapContextMenu, onViewChange, onViewportChange, onDropNote, onMarkerMove, onMarkerClick, onGlError, onGlFatal };
  const lockedRef = useRef(isLocked);
  lockedRef.current = isLocked;
  const movedRef = useRef(false);

  const viewWidth = useCallback(() => containerRef.current?.clientWidth || 800, []);

  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);

  // pathLines 는 style.load(스타일 교체 포함) 때 소스를 다시 채워야 해서 ref 로도 들고 있는다.
  const pathLinesRef = useRef(pathLines);
  pathLinesRef.current = pathLines;
  const pathFeatures = useCallback(
    () => ({
      type: 'FeatureCollection' as const,
      features: pathLinesRef.current.map((l) => ({
        type: 'Feature' as const,
        properties: { id: l.id },
        geometry: { type: 'LineString' as const, coordinates: l.points.map((p) => [p.lng, p.lat]) },
      })),
    }),
    []
  );

  /**
   * 커스텀 소스/레이어 설치. `setStyle` 은 스타일에 딸린 것을 전부 갈아엎으므로 초기 로드와
   * 테마 전환 후 모두 이 함수를 다시 태운다 ('style.load' 는 두 경우 다 발화).
   */
  const installLayers = useCallback(
    (map: maplibregl.Map) => {
      if (map.getLayer?.(PATH_LAYER)) return;
      map.addSource(PATH_SOURCE, { type: 'geojson', data: pathFeatures() });
      map.addLayer({
        id: PATH_LAYER,
        type: 'line',
        source: PATH_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // GL 페인트 속성은 CSS 변수를 못 읽으므로 지금 시점의 --accent 를 스냅샷한다. 테마 전환
        // 시엔 이 함수가 다시 돌므로 새 테마의 accent 로 갱신된다.
        // SVG 경로선과 같은 값(strokeWidth 1.75 / strokeOpacity 0.55).
        paint: { 'line-color': accentColor(), 'line-width': 1.75, 'line-opacity': 0.55 },
      });
    },
    [pathFeatures]
  );
  const installRef = useRef(installLayers);
  installRef.current = installLayers;

  // --- 맵 생성 (마운트 1회) ---
  useEffect(() => {
    if (!live) return;
    const el = containerRef.current;
    if (!el) return;
    const w = el.clientWidth || 800;
    const seed = defaultLocation ?? FACTORY_DEFAULT_MAP_LOCATION;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: mapStyleUrl(useSettingsStore.getState().theme),
        center: [seed.lng, seed.lat],
        zoom: kToGlZoom(seed.zoom, w),
        attributionControl: false,
        canvasContextAttributes: { preserveDrawingBuffer },
      });
    } catch (e) {
      console.warn('[map] maplibregl.Map 인스턴스 생성 실패 — SVG 지도로 폴백합니다.', e);
      // 이미 판단이 끝난 치명적 상황(map 객체 자체가 없다) — onGlFatal 로 보낸다(D4, 재분류 없음).
      cb.current.onGlFatal?.(e);
      return;
    }
    mapRef.current = map;

    let consecutiveTileErrors = 0;
    let hasLoadedAnyTile = false;

    map.on('error', (e: unknown) => {
      // 1. 치명적인 오류 (스타일 자체 로드 불가, WebGL 컨텍스트 오류 등)
      if (isFatalGlError(e)) {
        console.warn('[map] 치명적 MapLibre 오류 감지 — SVG 지도로 폴백합니다.', e);
        cb.current.onGlError?.(e);
        return;
      }

      // 2. 초기 로드 시 타일이 연속해서 대량 실패하는 경우 (완전 오프라인/서버 차단 상태)
      const errObj = (e as Record<string, unknown>)?.error ?? e;
      const isTileError = Boolean((e as Record<string, unknown>)?.tile) || /tile/i.test(String((errObj as Record<string, unknown>)?.message || ''));
      if (isTileError && !hasLoadedAnyTile) {
        consecutiveTileErrors++;
        if (consecutiveTileErrors >= 8) {
          console.warn('[map] 초기 타일 8회 연속 로드 실패 — 오프라인으로 간주하여 폴백합니다.', e);
          // isFatalGlError 는 이 판단(연속 횟수)을 못 한다 — onGlFatal 로 직접 보낸다(D4).
          cb.current.onGlFatal?.(e);
          return;
        }
      }

      // 3. 단순 단발성 타일 404, 글리프(폰트) 누락, 스프라이트 누락, 취소(abort) 등은 정상 렌더링 유지
      console.warn('[map] 비치명적 MapLibre 리소스 경고 (지도 렌더링 유지):', e);
    });

    map.on('data', (e: { dataType?: string; isSourceLoaded?: boolean }) => {
      if (e.dataType === 'source' && e.isSourceLoaded) {
        hasLoadedAnyTile = true;
        consecutiveTileErrors = 0;
      }
    });

    map.on('webglcontextlost', (e: unknown) => {
      console.warn('[map] WebGL 컨텍스트 손실 — SVG 지도로 폴백합니다.', e);
      // isFatalGlError(e) 는 이 이벤트를 String() 하면 "[object Object]"가 돼 항상 비치명으로
      // 오판한다 — 재분류 없이 onGlFatal 로 직접 보낸다(D4, AUDIT-2026-09-26).
      cb.current.onGlFatal?.(e);
    });

    // 'style.load' 는 최초 로드와 setStyle(테마 전환) 양쪽에서 발화한다.
    map.on('style.load', () => {
      installRef.current(map);
      if (useSettingsStore.getState().theme === 'dark') {
        applyMapDarkTheme(map, useSettingsStore.getState().accent || DEFAULT_ACCENT);
      }
    });

    // 팬/줌을 "클릭 아님"으로 구분 — SVG 쪽 hasMoved 와 같은 역할.
    map.on('movestart', () => { movedRef.current = false; });
    map.on('move', () => { movedRef.current = true; });

    const report = () => {
      const c = map.getCenter();
      const k = glZoomToK(map.getZoom(), el.clientWidth || w);
      cb.current.onViewChange?.({ lat: c.lat, lng: c.lng, zoom: k });
      const b = map.getBounds();
      cb.current.onViewportChange?.({
        min_lat: b.getSouth(),
        max_lat: b.getNorth(),
        min_lng: b.getWest(),
        max_lng: b.getEast(),
      });
    };
    map.on('moveend', report);
    map.once('idle', report);

    map.on('click', (e: maplibregl.MapMouseEvent) => {
      if (lockedRef.current || movedRef.current) return;
      cb.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng);
    });
    map.on('contextmenu', (e: maplibregl.MapMouseEvent) => {
      // 우클릭 드래그(팬) 직후 뜨는 contextmenu는 무시 — click 핸들러와 같은 movedRef 가드.
      if (lockedRef.current || movedRef.current) return;
      cb.current.onMapContextMenu?.(e.lngLat.lat, e.lngLat.lng, e.originalEvent.clientX, e.originalEvent.clientY);
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // --- 잠금: 인터랙션 핸들러 on/off ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const h of ['dragPan', 'scrollZoom', 'boxZoom', 'dragRotate', 'keyboard', 'doubleClickZoom', 'touchZoomRotate'] as const) {
      const handler = map[h] as { enable?: () => void; disable?: () => void } | undefined;
      if (isLocked) handler?.disable?.();
      else handler?.enable?.();
    }
  }, [isLocked]);

  // --- defaultLocation 레퍼런스 변경 = fly-to (마운트 시드는 위에서 이미 반영됨) ---
  const seedRef = useRef<MapLocation | undefined>(defaultLocation);
  useEffect(() => {
    if (defaultLocation === seedRef.current) return;
    seedRef.current = defaultLocation;
    const map = mapRef.current;
    if (!map || !defaultLocation) return;
    map.flyTo({ center: [defaultLocation.lng, defaultLocation.lat], zoom: kToGlZoom(defaultLocation.zoom, viewWidth()) });
  }, [defaultLocation, viewWidth]);

  // --- regionFocusPoints: fit-to-bounds fly ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !regionFocusPoints || regionFocusPoints.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of regionFocusPoints) b.extend([p.lng, p.lat]);
    // REGION_FIT_PADDING(0.85 = 뷰포트의 85%만 채움)을 픽셀 패딩으로 환산 — 같은 "여백" 의도.
    const pad = Math.round(((1 - REGION_FIT_PADDING) / 2) * Math.min(viewWidth(), containerRef.current?.clientHeight || 400));
    map.fitBounds(b, { padding: Math.max(24, pad), maxZoom: kToGlZoom(30, viewWidth()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionFocusPoints]);

  // --- 마커 동기화 ---
  const markerObjs = useRef(new Map<string, maplibregl.Marker>());
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = markerObjs.current;
    const seen = new Set<string>();

    for (const m of markers) {
      seen.add(m.id);
      const draggable = !!onMarkerMove && !isLocked && m.interactive !== false;
      const existing = live.get(m.id);
      if (existing) existing.remove(); // 상태(active/dim/draggable)가 DOM/옵션에 박혀 있어 재생성이 가장 단순하다.
      const el = markerEl(m);
      const marker = new maplibregl.Marker({ element: el, draggable }).setLngLat([m.lng, m.lat]).addTo(map);
      if (draggable) {
        // SVG 는 드래그 중 고스트 핀을 그리고 원본을 0.6 으로 흐렸다. GL 은 마커 자체가 따라오므로
        // 고스트는 불필요하고, 흐림만 같은 값으로 재현한다.
        marker.on('dragstart', () => { el.style.opacity = '0.6'; });
        marker.on('dragend', () => {
          el.style.opacity = m.dim ? '0.35' : '1';
          const p = marker.getLngLat();
          cb.current.onMarkerMove?.(m.id, p.lat, p.lng);
        });
      }
      if (m.interactive !== false) {
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          cb.current.onMarkerClick?.(m.id);
        });
        // 더블클릭 = 그 장소로 카메라 이동(검색 픽과 같은 PICK_FLYTO_ZOOM, 이미 더 깊으면 유지).
        // stopPropagation 으로 지도 기본 더블클릭 줌(빈 곳 확대)과 충돌하지 않는다. 앞서 발화하는
        // 단일 클릭 2회(선택)는 멱등이라 그대로 둔다 — 디바운스보다 단순.
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          if (lockedRef.current) return;
          const target = kToGlZoom(PICK_FLYTO_ZOOM, viewWidth());
          map.flyTo({ center: [m.lng, m.lat], zoom: Math.max(map.getZoom(), target) });
        });
      }
      live.set(m.id, marker);
    }

    for (const [id, marker] of live) {
      if (!seen.has(id)) {
        marker.remove();
        live.delete(id);
      }
    }
  }, [markers, onMarkerMove, isLocked, viewWidth]);

  useEffect(() => {
    const live = markerObjs.current;
    return () => {
      for (const m of live.values()) m.remove();
      live.clear();
    };
  }, []);

  // --- pathLines ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(PATH_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src?.setData) return;
      src.setData(pathFeatures());
    };
    if (map.isStyleLoaded?.()) apply();
    else map.once('style.load', apply);
  }, [pathLines, pathFeatures]);

  // --- 테마 전환: 스타일 교체 (커스텀 레이어는 위 'style.load' 훅이 다시 깐다) ---
  const themeRef = useRef(theme);
  useEffect(() => {
    if (themeRef.current === theme) return;
    themeRef.current = theme;
    mapRef.current?.setStyle(mapStyleUrl(theme));
  }, [theme]);

  // 악센트/테마 변경 시 다크모드 GL 레이어 색상 및 커스텀 경로선 즉각 갱신
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (theme === 'dark') {
      applyMapDarkTheme(map, accent || DEFAULT_ACCENT);
    }
    if (map.getLayer?.(PATH_LAYER)) {
      try {
        map.setPaintProperty(PATH_LAYER, 'line-color', accentColor());
      } catch {}
    }
  }, [accent, theme]);

  // --- 노트 트리 드롭 ---
  useEffect(() => {
    if (!onDropNote || isLocked) return;
    return registerNoteDropHandler((noteId, targetId, clientX, clientY) => {
      const map = mapRef.current;
      const el = containerRef.current;
      if (targetId !== 'map' || !map || !el) return;
      const rect = el.getBoundingClientRect();
      const p = map.unproject([clientX - rect.left, clientY - rect.top]);
      onDropNote(noteId, p.lat, p.lng);
    });
  }, [onDropNote, isLocked]);

  const handleGoHome = useCallback(() => {
    const loc = homeLocation ?? defaultLocation ?? FACTORY_DEFAULT_MAP_LOCATION;
    mapRef.current?.flyTo({ center: [loc.lng, loc.lat], zoom: kToGlZoom(loc.zoom, viewWidth()) });
  }, [homeLocation, defaultLocation, viewWidth]);

  const dropHandlers = onDropNote && !isLocked ? noteDropTargetProps('map') : {};

  return (
    <div
      className="map-drop-zone"
      data-perf="world-map-gl"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        borderRadius: frameless ? 0 : 'var(--radius-md)',
        border: frameless ? 'none' : '1px solid var(--line)',
        overflow: 'hidden',
      }}
      {...dropHandlers}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {live && (
        <>
          {/* 다크모드에서는 soft-light 블렌드 오버레이가 검은 배경을 탁한 와인/갈색으로 들뜨게 하므로
              opacity를 0으로 숨겨 순수 흑색을 유지하고, 라인은 MapLibre 레이어(line-color)가 직접
              악센트 색상을 표현합니다. 라이트모드에서는 기존의 은은한 soft-light 틴트를 유지합니다. */}
          <div
            aria-hidden
            data-testid="map-theme-tint"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--accent)',
              mixBlendMode: 'soft-light',
              opacity: theme === 'dark' ? 0 : 'var(--dim-faint)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />

          {!hideControls && (
            <MapControlBar
              isLocked={isLocked}
              onToggleLock={() => setIsLocked((v) => !v)}
              onGoHome={handleGoHome}
            />
          )}

          {/* ODbL 필수 저작자표시 — 항상 보이는 한 줄 텍스트(펼침 박스 없음). 클릭 통과. */}
          <div
            data-testid="map-attribution"
            style={{
              position: 'absolute',
              bottom: 2,
              right: 6,
              zIndex: 'var(--z-overlay)',
              fontSize: "var(--text-2xs)",
              color: 'var(--faint)',
              textShadow: '0 0 2px var(--surface-base), 0 0 2px var(--surface-base)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              maxWidth: 'calc(100% - 12px)',
              pointerEvents: 'none',
            }}
          >
            OpenFreeMap © OpenMapTiles © OpenStreetMap contributors
          </div>
        </>
      )}
    </div>
  );
};
