import React, { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from 'react';
import { geoMercator, geoPath, geoBounds, geoContains } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import { registerNoteDropHandler, noteDropTargetProps } from '../../lib/noteDrag';
import { MapControlBar } from './MapControlBar';
import { MapCityLabels } from './MapCityLabels';
import { getCachedPath, featureKey, admin1FeatureKey } from './pathCache';
import {
  viewportBounds,
  cullByBbox,
  cullPoints,
  topByRank,
  placeLabels,
  tierOpacities,
  zoomRamp,
  type MapLabelCandidate,
} from './lod';
import { admin1BandsForViewport } from './admin1Bands';
import {
  screenToLngLat,
  lngLatToScreen,
  viewportBbox,
  clampMapTransform,
  fitPointsToView,
  type MapViewportBbox,
} from './geometry';
import { MarkerLayer, type MapMarker, type MapPathLine } from './MarkerLayer';
import { useMapPanZoom } from './useMapPanZoom';
import {
  CITY_DOT_MIN_ZOOM,
  CITY_LABEL_MIN_ZOOM,
  REGION_FIT_MAX_ZOOM,
  REGION_FIT_PADDING,
  PICK_FLYTO_ZOOM,
} from './mapZoomScale';
import { FACTORY_DEFAULT_MAP_LOCATION } from '../../stores/settings';

// Re-export geometry types and functions
export type { MapMarker, MapPathLine, MapViewportBbox };
export { screenToLngLat, lngLatToScreen, viewportBbox };
// Re-exported so existing `from './WorldMap'` importers of the city LOD thresholds keep working —
// canonical home is mapZoomScale.ts (see that file's table comment).
export { CITY_DOT_MIN_ZOOM, CITY_LABEL_MIN_ZOOM };

// City tier cap (travel-itinerary LOD) — additionally capped per view so a dense region doesn't
// turn to text soup. (Min-zoom thresholds for dots/labels live in mapZoomScale.ts.)
export const CITY_LABEL_CAP = 40;

export interface MapLocation {
  lat: number;
  lng: number;
  zoom: number;
}

/** Pure seed computation shared by the initial `transform` state and the seed effect in
 * WorldMap below — centers `defaultLocation` at its zoom for the given viewport size, clamped
 * to stay in-bounds. Extracted so it never runs on every render (only on mount / real seeds). */
export function computeSeedTransform(
  defaultLocation: MapLocation | undefined,
  w: number,
  h: number
): { k: number; x: number; y: number } {
  if (!defaultLocation) return clampMapTransform(w, h, { k: 50, x: 0, y: 0 });
  const k = defaultLocation.zoom;
  const screenPt = lngLatToScreen(defaultLocation.lat, defaultLocation.lng, w, h, { k, x: 0, y: 0 });
  if (!screenPt) return clampMapTransform(w, h, { k, x: 0, y: 0 });
  const x = w / 2 - screenPt.x;
  const y = h / 2 - screenPt.y;
  return clampMapTransform(w, h, { k, x, y });
}

/**
 * Fit-to-bounds transform over a set of lat/lng points (e.g. a region filter's located notes).
 * Turns the point cloud into a center + zoom and hands off to `computeSeedTransform` for the
 * actual centering/clamp — no second place doing transform math. `null` input, an empty array,
 * or a non-positive viewport all mean "nothing to fit"; caller decides what that means (today:
 * leave the current view alone).
 *
 * Non-wrapping Mercator, same as the rest of this map: a region whose notes straddle the
 * antimeridian (e.g. Fiji) can't render as one contiguous view here regardless of how the bbox
 * is computed — `screenToLngLat`/`lngLatToScreen` never wrap lng — so naive min/max lng is
 * correct for what this map can actually display; a dateline-aware bbox would only be solving a
 * problem the renderer doesn't support.
 */
export function computeFitTransform(
  points: Array<{ lat: number; lng: number }>,
  w: number,
  h: number
): { k: number; x: number; y: number } | null {
  const fit = fitPointsToView(points, w, h, {
    fill: REGION_FIT_PADDING,
    maxZoom: REGION_FIT_MAX_ZOOM,
  });
  if (!fit) return null;
  return computeSeedTransform(fit, w, h);
}

export interface WorldMapLiveGate {
  /**
   * false 면 **maplibre 컨텍스트를 아예 만들지 않는다.** DOM 만 남기고 지도는 생성 자체를
   * 건너뛴다 — pointerEvents 로 가리는 것으로는 WebGL 컨텍스트가 그대로 살아 비용이 남는다.
   * 기본값은 true(기존 호출부 동작 유지).
   */
  live?: boolean;
}

export interface WorldMapProps extends WorldMapLiveGate {
  markers?: MapMarker[];
  /** D4: polylines connecting primary → waypoints in position order for multi-region notes. */
  pathLines?: MapPathLine[];
  /**
   * W7-e Task 2: fly-to-fit for a region filter's notes. A fresh array reference (RegionExpanded
   * hands a new one only when its region-scoped fetch resolves) flies the camera to frame every
   * point; `null`/unset, or the same reference as last render, leaves the current view alone —
   * this never re-fires on a mere viewSize change, so a window resize re-clamps the fitted view
   * the same way it would any user gesture, rather than re-fitting on every resize tick.
   */
  regionFocusPoints?: Array<{ lat: number; lng: number }> | null;
  onMarkerClick?: (id: string) => void;
  onMapClick?: (lat: number, lng: number) => void;
  onMapContextMenu?: (lat: number, lng: number, clientX: number, clientY: number) => void;
  onDropNote?: (noteId: string, lat: number, lng: number) => void;
  onMarkerMove?: (noteId: string, lat: number, lng: number) => void;
  onViewportChange?: (bbox: MapViewportBbox) => void;
  /**
   * Initial / re-seed viewport (e.g. fit-to-notes on the home map tab). Changing the reference
   * flies the map to this location. The home/recenter button does NOT use this — see homeLocation.
   */
  defaultLocation?: MapLocation;
  /**
   * Target for the home/recenter control. When omitted, falls back to defaultLocation (settings
   * maps that only pass one location). HomeMapPane passes notebook settings here so home always
   * returns to the user's default, not the note-fit seed.
   */
  homeLocation?: MapLocation;
  /**
   * Fires on every committed transform (gesture, seed, clamp, home) with the **geographic** view:
   * 화면 중심의 lat/lng + zoom(k). Optional; HomeMapPane only(세션 뷰포트 저장).
   * 픽셀 transform 을 그대로 내보내지 않는 이유(W8 "아를리트" 수정): {k,x,y} 는 그 순간의 뷰포트
   * 크기에 종속된 좌표라, 다른 크기에서 복원하면 카메라가 엉뚱한 대륙으로 간다. 지리 좌표는
   * 어떤 크기에서도 computeSeedTransform 으로 정확히 되살릴 수 있다. 복원 경로도 같은 이유로
   * 별도 prop 이 아니라 defaultLocation(seed 경로)을 그대로 쓴다 — seed 는 실측 크기를 기다렸다
   * (hasRealSize) 계산하므로 플레이스홀더 800×450 클램프에 오염될 수 없다.
   */
  onViewChange?: (v: MapLocation) => void;
  /**
   * "글을 쓴 지역"처럼 **면을 칠하는** 입력. 각 점을 담고 있는 나라 폴리곤이 강조 색으로
   * 채워진다(마커는 별개 — 이 prop 은 점을 그리지 않는다). 지오메트리는 이미 그려지고 있는
   * 그 features 라, 렌더러를 새로 얹지 않고 채움 색만 갈아 끼운다.
   *
   * ponytail: 해상도는 **나라 단위**다 — 서울에서 쓴 노트는 대한민국 전체를 칠한다. 도/주
   * 단위가 필요해지면 이미 뷰포트 밴드로 로드 중인 admin1 features(admin1Bands.ts)에 같은
   * 포함 판정을 돌리면 된다(지금은 그 레이어가 국경선만 그리고 면은 갖지 않는다).
   */
  filledPoints?: Array<{ lat: number; lng: number }> | null;
  /** 실제로 채워진 지역 수. 위에서 칠한 것과 **같은 계산**에서 나온다(따로 세면 어긋난다). */
  onFilledRegionCount?: (count: number) => void;
  width?: number;
  height?: number;
  uiLang?: string;
  frameless?: boolean;
  isLocked?: boolean;
  onToggleLock?: () => void;
  hideControls?: boolean;
}

interface MapPathsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  features: any[];
  // The dataset behind `features` — '110m' | '50m' | '10m' — composed into the key below so a
  // 50m→10m tier load (which doesn't change pathGenerator's identity, and so doesn't clear the
  // cache) can't collide with stale geometry from the previous tier.
  featuresTier: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pathGenerator: any;
  bordersPath110m: string | null;
  bordersPath50m: string | null;
  bordersPath10m: string | null;
  opacity110m: number;
  opacity50m: number;
  opacity10m: number;
  /** featureKey()s that should read as "visited" — see WorldMapProps.filledPoints. */
  filledKeys: ReadonlySet<string>;
}

const MapPaths = React.memo<MapPathsProps>(
  ({
    features,
    featuresTier,
    pathGenerator,
    bordersPath110m,
    bordersPath50m,
    bordersPath10m,
    opacity110m,
    opacity50m,
    opacity10m,
    filledKeys,
  }) => {
    return (
      <>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {features.map((feat: any, i: number) => {
          // feat.id alone isn't unique — see pathCache.ts's featureKey header (world-atlas's
          // 10m/50m countries topology has a real duplicate id, plus several features with none).
          const key = featureKey(featuresTier, feat, i);
          const d = getCachedPath(key, pathGenerator, feat);
          if (!d) return null;
          const filled = filledKeys.has(key);
          return (
            <path
              key={key}
              d={d}
              // 채워진 지역은 강조 색을 옅게 섞는다 — 토큰만 쓴다(hex 하드코딩 금지).
              fill={filled ? 'color-mix(in srgb, var(--accent) 45%, var(--hover))' : 'var(--hover)'}
              stroke="none"
              data-filled={filled ? 'true' : undefined}
            />
          );
        })}

        {bordersPath110m && opacity110m > 0 && (
          <path
            d={bordersPath110m}
            fill="none"
            stroke="var(--divider)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
            opacity={opacity110m}
          />
        )}

        {bordersPath50m && opacity50m > 0 && (
          <path
            d={bordersPath50m}
            fill="none"
            stroke="var(--divider)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
            opacity={opacity50m}
          />
        )}

        {bordersPath10m && opacity10m > 0 && (
          <path
            d={bordersPath10m}
            fill="none"
            stroke="var(--divider)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
            opacity={opacity10m}
          />
        )}
      </>
    );
  }
);

MapPaths.displayName = 'MapPaths';

export const WorldMap: React.FC<WorldMapProps> = ({
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
  filledPoints,
  onFilledRegionCount,
  width: initialWidth = 800,
  height: initialHeight = 450,
  uiLang,
  frameless = false,
  live: _live = true,
  isLocked: propLocked,
  onToggleLock,
  hideControls = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);

  const [viewSize, setViewSize] = useState({ width: initialWidth, height: initialHeight });
  // Mirrors `viewSize` so the resize-observer effect (mounted once, `[]` deps) can compare
  // against the latest committed size without a stale closure — same pattern as `transformRef`
  // in useMapPanZoom. Lets it skip the `setViewSize` call entirely on a no-op size report,
  // instead of relying on React's same-reference setState bailout (which still re-renders the
  // owning fiber once to confirm nothing changed).
  const viewSizeRef = useRef(viewSize);
  viewSizeRef.current = viewSize;
  const [internalLocked, setInternalLocked] = useState(false);
  const isLocked = propLocked !== undefined ? propLocked : internalLocked;
  const setIsLocked = onToggleLock ? onToggleLock : setInternalLocked;

  // Dynamic datasets
  // 110m used to be a module-level top-level parse (topojson feature/mesh over the full
  // countries-110m.json) executed at import time — i.e. on the main bundle's boot path, before
  // any map ever mounted. Loaded like 50m/10m below instead, so parsing only happens once a
  // WorldMap actually mounts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [topoData110m, setTopoData110m] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [topoData50m, setTopoData50m] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [topoData10m, setTopoData10m] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [capitalsData, setCapitalsData] = useState<any>(null);
  // Admin-1 loaded per longitude band (not the full world) — keys are band ids (b0…b5).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [admin1Pieces, setAdmin1Pieces] = useState<Record<string, any>>({});
  const admin1Inflight = useRef(new Set<string>());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [citiesData, setCitiesData] = useState<any>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Skip the setState call entirely when the floored size didn't actually change, so layout
    // churn that doesn't change pixel dimensions produces zero re-renders instead of cascading
    // into a transform reset (root cause of the create-pin / filmstrip-resize zoom jump).
    const applySize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const fw = Math.floor(w);
      const fh = Math.floor(h);
      const cur = viewSizeRef.current;
      if (cur.width === fw && cur.height === fh) return;
      setViewSize({ width: fw, height: fh });
    };
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) applySize(cr.width, cr.height);
    });
    ro.observe(el);
    applySize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 세션 복원(HomeMapPane)도 이 seed 경로를 그대로 탄다 — 저장된 지리 뷰가 defaultLocation 으로
  // 들어온다. 예전의 픽셀 transform 복원 prop(initialTransform)은 제거됐다: 그 값은 저장 당시
  // 뷰포트 크기에 종속돼, 여기 초기 상태의 플레이스홀더(800×450) 클램프가 x 를 한계값에 핀해
  // 버리고 실측 크기가 와도 재계산이 없어 카메라가 엉뚱한 대륙(사하라 "아를리트")에 내렸다.
  const [transform, setTransform] = useState(() =>
    computeSeedTransform(defaultLocation, viewSize.width, viewSize.height)
  );

  const {
    isDragging,
    hasMoved,
    transformRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    applyGTransform,
  } = useMapPanZoom({
    isLocked,
    transform,
    setTransform,
    svgRef,
    gRef,
    viewSize,
  });

  // Seed vs. resize: a `defaultLocation` reference change is a real fly-to intent and must
  // re-seed the transform at its zoom. A `viewSize`-only change (window resize, sidebar toggle,
  // HomeMapPane switching branches and nudging the canvas a few px) must NOT reset the user's
  // live pan/zoom — it only needs re-clamping so the view can't reveal blank space past the
  // world's edges.
  //
  // The discriminator is NOT "have we ever seeded" (viewSize starts nonzero — the `initialWidth`/
  // `initialHeight` defaults — so that boolean would already read true before the container's
  // real size ever arrives, mis-filing the mount-time placeholder→real correction as a "resize"
  // and leaving the map positioned for an 800×450 viewport that never existed). It's whether the
  // *live* transform is still referentially the exact object we last seeded: every user gesture
  // (handleWheel, handleMouseUp, handleGoHome) writes a fresh object via `clampMapTransform`, so
  // reference equality alone tells us "untouched since last seed" vs. "user has since panned/
  // zoomed" — no separate gesture-tracking flag needed. Until the user touches the map, every
  // size change (including the async mount correction, or a container that mounts hidden 0×0
  // and gets sized later) keeps re-seeding at the correct size; once touched, size changes only
  // re-clamp.
  const seedStateRef = useRef<{ loc: MapLocation | undefined; out: { k: number; x: number; y: number } }>({
    loc: defaultLocation,
    out: transform,
  });

  useEffect(() => {
    const { width: w, height: h } = viewSize;
    const prev = seedStateRef.current;
    const locationChanged = defaultLocation !== prev.loc;
    const stillAtSeed = transformRef.current === prev.out;
    const hasRealSize = w > 0 && h > 0;

    if (hasRealSize && (locationChanged || stillAtSeed)) {
      const seeded = computeSeedTransform(defaultLocation, w, h);
      seedStateRef.current = { loc: defaultLocation, out: seeded };
      setTransform(seeded);
    } else if (hasRealSize) {
      setTransform((t) => clampMapTransform(w, h, t));
    }
  }, [defaultLocation, viewSize, transformRef]);

  // W7-e Task 2: region-filter fly-to-fit. Keyed only on the `regionFocusPoints` reference (not
  // viewSize) — the caller only ever produces a new array when its async, filter-scoped fetch
  // resolves, which cannot land in the same commit as the mount-time seed effect above (that one
  // resolves synchronously from props). So this can never fight the seed: it always runs after,
  // on a later render, once a region is actually picked. An empty array (filter matched no
  // located notes) is a deliberate no-op — keep the current view rather than flying to nothing.
  useEffect(() => {
    if (!regionFocusPoints || regionFocusPoints.length === 0) return;
    const fitted = computeFitTransform(
      regionFocusPoints,
      viewSizeRef.current.width,
      viewSizeRef.current.height
    );
    if (!fitted) return;
    setTransform(fitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionFocusPoints]);

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    if (!onViewChangeRef.current) return;
    // transform 과 그 시점의 뷰포트 크기는 항상 짝으로 유효하다(seed/클램프가 그 크기 기준) —
    // 그 짝으로 화면 중심을 지리 좌표로 되돌리면 크기 독립적인 뷰가 된다. viewSize 는 deps 에
    // 넣지 않는다: 크기만 바뀐 리클램프는 지리적으로 같은 뷰라 다시 보고할 것이 없다.
    const { width: w, height: h } = viewSizeRef.current;
    const center = screenToLngLat(w / 2, h / 2, w, h, transform);
    if (center) onViewChangeRef.current({ lat: center.lat, lng: center.lng, zoom: transform.k });
  }, [transform]);

  // Registered natively, not via onWheel: React attaches wheel at the root as a PASSIVE listener,
  // so a synthetic handler cannot preventDefault and the scroll container (e.g. Settings' map
  // preview, embedded via RegionPickerFields) scrolls underneath the zoom instead of zooming.
  // Mounted once — handleWheel is read through a ref so this never re-subscribes and never
  // captures a stale closure (same pattern as DiagramCanvas's wheel-zoom listener).
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => handleWheelRef.current(ev);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const currentZoom = transform.k;

  useEffect(() => {
    if (!onViewportChange) return;
    const box = viewportBbox(viewSize.width, viewSize.height, transform);
    if (box) onViewportChange(box);
  }, [transform, viewSize, onViewportChange]);

  // 110m: unlike the 50m/10m tiers below, not zoom-gated — it's the base tier every zoom level
  // falls back to (lod.ts::tierOpacities), so it loads unconditionally on first mount instead of
  // waiting for a threshold. Same dynamic-import + console.warn-on-failure pattern as 50m/10m.
  useEffect(() => {
    if (!topoData110m) {
      import('world-atlas/countries-110m.json')
        .then((mod) => setTopoData110m(mod.default || mod))
        .catch((e) => console.warn("[map] 110m tier load failed", e));
    }
  }, [topoData110m]);

  // Zoom LOD imports
  useEffect(() => {
    if (currentZoom >= 2.5 && !topoData50m) {
      import('world-atlas/countries-50m.json')
        .then((mod) => setTopoData50m(mod.default || mod))
        // 실패해도 tierOpacities 폴백이 110m을 유지하니 치명적이진 않지만, 조용히 삼키면
        // "지형이 거칠다" 제보를 디버깅할 단서가 없다 — 경고는 남긴다.
        .catch((e) => console.warn("[map] 50m tier load failed", e));
    }
  }, [currentZoom, topoData50m]);

  useEffect(() => {
    if (currentZoom >= 6 && !topoData10m) {
      import('world-atlas/countries-10m.json')
        .then((mod) => setTopoData10m(mod.default || mod))
        .catch((e) => console.warn("[map] 10m tier load failed", e));
    }
  }, [currentZoom, topoData10m]);

  useEffect(() => {
    if (currentZoom >= 8 && !capitalsData) {
      import('../../assets/capitals-10m.json')
        .then((mod) => setCapitalsData((mod as { default: unknown }).default ?? mod))
        .catch(() => {});
    }
  }, [currentZoom, capitalsData]);

  // Admin-1: lazy-import only longitude bands that intersect the current viewport (same
  // dynamic-import pattern as the 50m/10m country tiers above). Pieces stay cached once loaded.
  useEffect(() => {
    if (currentZoom < 12) return;
    const bounds = viewportBounds(viewSize.width, viewSize.height, transform);
    if (!bounds) return;
    for (const band of admin1BandsForViewport(bounds)) {
      if (admin1Pieces[band.id] || admin1Inflight.current.has(band.id)) continue;
      admin1Inflight.current.add(band.id);
      band
        .load()
        .then((mod) => {
          const data = (mod as { default?: unknown }).default ?? mod;
          setAdmin1Pieces((prev) => (prev[band.id] ? prev : { ...prev, [band.id]: data }));
        })
        .catch(() => {})
        .finally(() => {
          admin1Inflight.current.delete(band.id);
        });
    }
    // admin1Pieces omitted from deps on purpose — already-loaded check uses the render snapshot
    // + inflight set; re-running on every piece arrival would only re-walk the same bands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentZoom, transform, viewSize.width, viewSize.height]);

  useEffect(() => {
    if (currentZoom >= CITY_DOT_MIN_ZOOM && !citiesData) {
      import('../../assets/cities-10m.json')
        .then((mod) => setCitiesData((mod as { default: unknown }).default ?? mod))
        .catch(() => {});
    }
  }, [currentZoom, citiesData]);

  // Opacities — fallback ladder in lod.ts::tierOpacities: the finest LOADED tier is always
  // visible, so an in-flight/failed 50m/10m import can never blank the landmass (owner QA
  // 2026-08-10 "빈 초록 화면").
  const {
    o110m: opacity110m,
    o50m: opacity50m,
    o10m: opacity10m,
  } = useMemo(
    () => tierOpacities(currentZoom, !!topoData50m, !!topoData10m),
    [currentZoom, topoData50m, topoData10m]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onMapContextMenu || !svgRef.current || hasMoved.current) return;
      e.preventDefault();
      const rect = svgRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const pt = screenToLngLat(clickX, clickY, viewSize.width, viewSize.height, transformRef.current);
      if (pt) {
        onMapContextMenu(pt.lat, pt.lng, e.clientX, e.clientY);
      }
    },
    [onMapContextMenu, viewSize, hasMoved, transformRef]
  );

  const capitalOpacity = useMemo(() => zoomRamp(currentZoom, 8, 12, 1), [currentZoom]);

  const admin1Opacity = useMemo(() => zoomRamp(currentZoom, 12, 18, 0.7), [currentZoom]);

  const provinceLabelOpacity = useMemo(() => zoomRamp(currentZoom, 70, 90, 0.7), [currentZoom]);

  const cityDotOpacity = useMemo(
    () => zoomRamp(currentZoom, CITY_DOT_MIN_ZOOM, CITY_DOT_MIN_ZOOM + 4, 1),
    [currentZoom]
  );

  const cityLabelOpacity = useMemo(
    () => zoomRamp(currentZoom, CITY_LABEL_MIN_ZOOM, CITY_LABEL_MIN_ZOOM + 8, 0.85),
    [currentZoom]
  );

  const projection = useMemo(() => {
    const { width: w, height: h } = viewSize;
    return geoMercator()
      .scale(w / (2 * Math.PI))
      .translate([w / 2, h / 2]);
  }, [viewSize]);

  const pathGenerator = useMemo(() => {
    return geoPath().projection(projection);
  }, [projection]);

  // Bundled in one memo (not two with matching deps) so tier and features can't desync.
  const { features, featuresTier } = useMemo(() => {
    if (topoData10m?.objects?.countries) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feats = ((feature as any)(topoData10m, topoData10m.objects.countries) as any).features || [];
      return { features: feats, featuresTier: '10m' };
    }
    if (topoData50m?.objects?.countries) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feats = ((feature as any)(topoData50m, topoData50m.objects.countries) as any).features || [];
      return { features: feats, featuresTier: '50m' };
    }
    if (topoData110m?.objects?.countries) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feats = ((feature as any)(topoData110m, topoData110m.objects.countries) as any).features || [];
      return { features: feats, featuresTier: '110m' };
    }
    // Not yet loaded (brief window right after mount, before the 110m import above resolves) —
    // nothing to draw. tierOpacities' fallback ladder only guarantees "the finest *loaded* tier
    // is visible"; with none loaded yet there is genuinely nothing to show but the background.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { features: [] as any[], featuresTier: '110m' };
  }, [topoData10m, topoData50m, topoData110m]);

  /**
   * filledPoints → 그 점을 담고 있는 feature 들의 featureKey 집합. MapPaths 가 memo 라
   * Set 은 여기서 한 번만 만든다(매 렌더 새 Set 이면 그 memo 가 통째로 무의미해진다).
   *
   * geoBounds 로 먼저 거른다: 나라 × 점 전수 대조는 10m 티어에서 폴리곤 하나가 수천 좌표라
   * 팬 도중 티어가 바뀔 때마다 눈에 띄게 멈춘다. bbox 는 features 당 한 번만 계산한다.
   *
   * ponytail: 그래도 10m 티어(k≥6)로 넘어가는 순간 이 두 memo 가 합쳐 ~350ms 든다(110m 은
   * ~15ms). 티어당 한 번이고 `filledPoints` 는 좌표가 바뀔 때만 새 배열이라 반복되지는 않는다.
   * 더 줄이려면 좌표 min/max 스캔으로 bbox 를 직접 뜨는 방법이 있는데(6배 빠름) 구면 기준인
   * geoContains 와 결과가 어긋나 실제 포함을 놓쳤다 — 정확도를 깎지 말고, 정 급하면 티어별
   * bbox 를 빌드 타임에 구워라.
   */
  const featureBounds = useMemo(() => {
    if (!filledPoints || filledPoints.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return features.map((feat: any) => geoBounds(feat));
  }, [features, filledPoints]);

  const filled = useMemo(() => {
    const keys = new Set<string>();
    const countries = new Set<string>();
    if (!featureBounds || !filledPoints) return { keys, count: 0 };
    for (let i = 0; i < features.length; i++) {
      const [[minLng, minLat], [maxLng, maxLat]] = featureBounds[i];
      for (const p of filledPoints) {
        if (p.lng < minLng || p.lng > maxLng || p.lat < minLat || p.lat > maxLat) continue;
        if (!geoContains(features[i], [p.lng, p.lat])) continue;
        const key = featureKey(featuresTier, features[i], i);
        keys.add(key);
        // 세는 단위는 feature 가 아니라 **나라**다: 50m/10m 토폴로지에는 같은 ISO 코드를 나눠
        // 가진 feature 가 있어서(pathCache.featureKey 주석) 그대로 세면 한 나라가 둘로 잡힌다.
        // id 없는 feature 는 자기 키로 센다(그 경우 서로 합칠 근거가 없다).
        countries.add(String(features[i].id ?? key));
        break;
      }
    }
    return { keys, count: countries.size };
  }, [features, featuresTier, featureBounds, filledPoints]);

  const onFilledRegionCountRef = useRef(onFilledRegionCount);
  onFilledRegionCountRef.current = onFilledRegionCount;
  useEffect(() => {
    onFilledRegionCountRef.current?.(filled.count);
  }, [filled.count]);

  const bordersPath110m = useMemo(() => {
    if (!topoData110m?.objects?.countries) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bMesh = mesh(topoData110m, topoData110m.objects.countries, (a: any, b: any) => a !== b);
    return getCachedPath('borders-110m', pathGenerator, bMesh as never);
  }, [topoData110m, pathGenerator]);

  const bordersPath50m = useMemo(() => {
    if (!topoData50m?.objects?.countries) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bMesh = mesh(topoData50m, topoData50m.objects.countries, (a: any, b: any) => a !== b);
    return getCachedPath('borders-50m', pathGenerator, bMesh as never);
  }, [topoData50m, pathGenerator]);

  const bordersPath10m = useMemo(() => {
    if (!topoData10m?.objects?.countries) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bMesh = mesh(topoData10m, topoData10m.objects.countries, (a: any, b: any) => a !== b);
    return getCachedPath('borders-10m', pathGenerator, bMesh as never);
  }, [topoData10m, pathGenerator]);

  const admin1Features = useMemo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array<{ f: any; b: [[number, number], [number, number]]; key: string }>
  >(() => {
    const pieceList = Object.values(admin1Pieces);
    if (pieceList.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Array<{ f: any; b: [[number, number], [number, number]]; key: string }> = [];
    const seen = new Set<string>();
    for (const topo of pieceList) {
      if (!topo?.objects?.admin1) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geo = feature(topo, topo.objects.admin1) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of geo.features ?? []) {
        const key = admin1FeatureKey(f);
        if (seen.has(key)) continue; // spanning features may land in adjacent bands
        seen.add(key);
        out.push({ f, b: f.properties?.b ?? geoBounds(f), key });
      }
    }
    return out;
  }, [admin1Pieces]);

  const { admin1Paths, provinceLabels } = useMemo(() => {
    if (admin1Features.length === 0 || transform.k < 12) {
      return { admin1Paths: [] as Array<{ key: string; d: string }>, provinceLabels: [] };
    }
    const bounds = viewportBounds(viewSize.width, viewSize.height, transform);
    if (!bounds) return { admin1Paths: [] as Array<{ key: string; d: string }>, provinceLabels: [] };
    const visible = cullByBbox(admin1Features, bounds);

    const paths: Array<{ key: string; d: string }> = [];
    const labels: Array<{ id: string; name: string; x: number; y: number }> = [];
    const showLabels = transform.k >= 70;

    for (const { f, b, key } of visible) {
      const d = getCachedPath(key, pathGenerator, f);
      if (d) {
        paths.push({ key, d });
        if (showLabels && f.properties) {
          const props = f.properties;
          const lang = uiLang || 'ko';
          const name = (props[lang] as string | undefined) || props.name;
          if (name) {
            const centerLng = (b[0][0] + b[1][0]) / 2;
            const centerLat = (b[0][1] + b[1][1]) / 2;
            const pt = projection([centerLng, centerLat]);
            if (pt) {
              labels.push({ id: key, name, x: pt[0], y: pt[1] });
            }
          }
        }
      }
    }
    return { admin1Paths: paths, provinceLabels: labels };
  }, [admin1Features, pathGenerator, projection, transform, viewSize, uiLang]);

  const capitalNodes = useMemo(() => {
    if (!capitalsData?.features || transform.k < 8) return [];
    const { width: w, height: h } = viewSize;
    const tl = screenToLngLat(0, 0, w, h, transform);
    const br = screenToLngLat(w, h, w, h, transform);
    if (!tl || !br) return [];

    const nodes: Array<{ id: number; name: string; x: number; y: number }> = [];
    const lang = uiLang || 'ko';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capitalsData.features.forEach((f: any, i: number) => {
      const coords = f.geometry?.coordinates;
      if (!coords) return;
      const [lng, lat] = coords;
      if (lng < tl.lng || lng > br.lng || lat > tl.lat || lat < br.lat) return;

      const pt = projection([lng, lat]);
      if (!pt) return;

      const props = f.properties ?? {};
      const name = (props[lang] as string | undefined) || props.name;
      if (name) {
        nodes.push({ id: i, name, x: pt[0], y: pt[1] });
      }
    });

    return nodes;
  }, [capitalsData, projection, transform, viewSize, uiLang]);

  // Restructured once per dataset/language load (not per transform) — same split as
  // admin1Features vs. admin1Paths, so panning/zooming never re-walks the full ~2200-city list.
  const cityPoints = useMemo(() => {
    if (!citiesData?.features) return [];
    const lang = uiLang || 'ko';
    const points: Array<{ id: number; lng: number; lat: number; name: string; rank: number }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    citiesData.features.forEach((f: any, i: number) => {
      const coords = f.geometry?.coordinates;
      if (!coords) return;
      const props = f.properties ?? {};
      const name = (props[lang] as string | undefined) || props.name;
      if (!name) return;
      points.push({ id: i, lng: coords[0], lat: coords[1], name, rank: props.rank ?? 99 });
    });
    return points;
  }, [citiesData, uiLang]);

  const cityNodes = useMemo(() => {
    if (cityPoints.length === 0 || transform.k < CITY_DOT_MIN_ZOOM) return [];
    const bounds = viewportBounds(viewSize.width, viewSize.height, transform);
    if (!bounds) return [];

    return cullPoints(cityPoints, bounds)
      .map((p) => {
        const pt = projection([p.lng, p.lat]);
        if (!pt) return null;
        return { id: p.id, name: p.name, rank: p.rank, x: pt[0], y: pt[1] };
      })
      .filter((n): n is { id: number; name: string; rank: number; x: number; y: number } => n !== null);
  }, [cityPoints, projection, transform, viewSize]);

  // Shared greedy placement across capital / province / city so e.g. "서울" + "서울특별시"
  // don't stack. Runs only on already-culled sets (+ city rank cap); dots stay even when
  // a label is suppressed. Zoom thresholds / opacity ramps are unchanged.
  const placedLabelIds = useMemo(() => {
    const k = transform.k;
    const candidates: MapLabelCandidate[] = [];

    if (capitalOpacity > 0) {
      for (const cap of capitalNodes) {
        candidates.push({
          id: `cap:${cap.id}`,
          text: cap.name,
          x: cap.x,
          y: cap.y + 6 / k,
          fontSize: 9 / k,
          layer: 'capital',
          baseline: 'hanging',
        });
      }
    }

    if (provinceLabelOpacity > 0) {
      for (const lbl of provinceLabels) {
        candidates.push({
          id: `prov:${lbl.id}`,
          text: lbl.name,
          x: lbl.x,
          y: lbl.y,
          fontSize: 10 / k,
          layer: 'province',
          baseline: 'central',
        });
      }
    }

    // Rank cap limits COUNT before collision; placement then drops position conflicts.
    if (cityLabelOpacity > 0) {
      for (const city of topByRank(cityNodes, CITY_LABEL_CAP)) {
        candidates.push({
          id: `city:${city.id}`,
          text: city.name,
          x: city.x,
          y: city.y + 5 / k,
          fontSize: 7.5 / k,
          layer: 'city',
          rank: city.rank,
          baseline: 'hanging',
        });
      }
    }

    // Padding / same-place radius in projection units ≈ constant screen pixels / k.
    return placeLabels(candidates, {
      padding: 2 / k,
      samePlaceRadius: 12 / k,
    });
  }, [
    capitalNodes,
    capitalOpacity,
    provinceLabels,
    provinceLabelOpacity,
    cityNodes,
    cityLabelOpacity,
    transform.k,
  ]);

  const handleGoHome = useCallback(() => {
    // Prefer explicit home target (notebook settings); seed/fit defaultLocation is not "home".
    const loc = homeLocation ?? defaultLocation ?? FACTORY_DEFAULT_MAP_LOCATION;
    const { width: w, height: h } = viewSize;
    const k = loc.zoom;
    const screenPt = lngLatToScreen(loc.lat, loc.lng, w, h, { k, x: 0, y: 0 });
    if (!screenPt) return;
    const x = w / 2 - screenPt.x;
    const y = h / 2 - screenPt.y;
    const nextTransform = clampMapTransform(w, h, { k, x, y });
    transformRef.current = nextTransform;
    applyGTransform(nextTransform.k, nextTransform.x, nextTransform.y);
    setTransform(nextTransform);
  }, [homeLocation, defaultLocation, viewSize, applyGTransform, transformRef]);

  // 마커 더블클릭 = 그 장소로 카메라 이동 (GL 렌더러의 dblclick fly-to 와 같은 규칙: 검색 픽의
  // PICK_FLYTO_ZOOM, 이미 더 깊으면 현재 줌 유지). 단일 클릭 2회(선택)는 멱등이라 그대로 둔다.
  const handleMarkerDoubleClick = useCallback(
    (lat: number, lng: number) => {
      if (isLocked) return;
      const { width: w, height: h } = viewSize;
      const seeded = computeSeedTransform(
        { lat, lng, zoom: Math.max(transformRef.current.k, PICK_FLYTO_ZOOM) },
        w,
        h
      );
      transformRef.current = seeded;
      applyGTransform(seeded.k, seeded.x, seeded.y);
      setTransform(seeded);
    },
    [isLocked, viewSize, applyGTransform, transformRef]
  );

  const [movingMarkerId, setMovingMarkerId] = useState<string | null>(null);
  const [ghostPt, setGhostPt] = useState<{ x: number; y: number } | null>(null);
  const markerMovedRef = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMarkerPointerDown = useCallback(
    (e: React.PointerEvent, noteId: string) => {
      if (isLocked || !onMarkerMove || e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      markerMovedRef.current = false;

      const finish = (ev: PointerEvent) => {
        if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        window.removeEventListener('pointermove', track);
        window.removeEventListener('pointerup', finish);
        setGhostPt(null);
        setMovingMarkerId((cur) => {
          if (cur !== noteId || !svgRef.current) return null;
          const rect = svgRef.current.getBoundingClientRect();
          const pt = screenToLngLat(
            ev.clientX - rect.left,
            ev.clientY - rect.top,
            viewSize.width,
            viewSize.height,
            transformRef.current
          );
          if (pt) {
            markerMovedRef.current = true;
            onMarkerMove(noteId, pt.lat, pt.lng);
          }
          return null;
        });
      };
      const track = (ev: PointerEvent) => {
        if (longPressTimer.current !== null && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
          return;
        }
        if (longPressTimer.current === null && svgRef.current) {
          const rect = svgRef.current.getBoundingClientRect();
          setGhostPt({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
        }
      };

      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        isDragging.current = false;
        setMovingMarkerId(noteId);
      }, 400);

      window.addEventListener('pointermove', track);
      window.addEventListener('pointerup', finish);
    },
    [isLocked, onMarkerMove, viewSize, isDragging, transformRef]
  );

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (isLocked || hasMoved.current) return;
      if (!onMapClick || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const pt = screenToLngLat(clickX, clickY, viewSize.width, viewSize.height, transformRef.current);
      if (pt) {
        onMapClick(pt.lat, pt.lng);
      }
    },
    [isLocked, onMapClick, viewSize, hasMoved, transformRef]
  );

  const dropHandlers = onDropNote && !isLocked ? noteDropTargetProps('map') : {};

  useEffect(() => {
    if (!onDropNote || isLocked) return;
    return registerNoteDropHandler((noteId, targetId, clientX, clientY) => {
      if (targetId !== 'map' || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const pt = screenToLngLat(clientX - rect.left, clientY - rect.top, viewSize.width, viewSize.height, transformRef.current);
      if (pt) onDropNote(noteId, pt.lat, pt.lng);
    });
  }, [isLocked, onDropNote, viewSize, transformRef]);

  return (
    <div
      ref={containerRef}
      className="map-drop-zone"
      data-perf="world-map"
      data-perf-zoom={String(transform.k)}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        userSelect: 'none',
        cursor: isLocked ? 'default' : isDragging.current ? 'grabbing' : 'grab',
        borderRadius: frameless ? 0 : 'var(--radius-md)',
        border: frameless ? 'none' : '1px solid var(--divider)',
        // The svg is a plain rectangle — without this it paints straight over the
        // rounded corners and the map reads as a square inside a round box.
        overflow: 'hidden',
        transition: 'border-color var(--dur-med) ease, box-shadow var(--dur-med) ease',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      {...dropHandlers}
    >
      {!hideControls && (
        <MapControlBar
          isLocked={isLocked}
          onToggleLock={() => setIsLocked((v) => !v)}
          onGoHome={handleGoHome}
        />
      )}

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${viewSize.width} ${viewSize.height}`}
        style={{ display: 'block', overflow: 'hidden' }}
        onClick={handleSvgClick}
      >
        <g
          ref={gRef}
          transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}
        >
          <rect x={0} y={0} width={viewSize.width} height={viewSize.height} fill="none" />

          <MapPaths
            features={features}
            featuresTier={featuresTier}
            pathGenerator={pathGenerator}
            bordersPath110m={bordersPath110m}
            bordersPath50m={bordersPath50m}
            bordersPath10m={bordersPath10m}
            opacity110m={opacity110m}
            opacity50m={opacity50m}
            opacity10m={opacity10m}
            filledKeys={filled.keys}
          />

          {admin1Opacity > 0 &&
            admin1Paths.map(({ key, d }) => (
              <path
                key={key}
                data-tier="admin1"
                d={d}
                fill="none"
                stroke="var(--line)"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
                opacity={admin1Opacity}
              />
            ))}

          <MapCityLabels
            cityDotOpacity={cityDotOpacity}
            cityLabelOpacity={cityLabelOpacity}
            capitalOpacity={capitalOpacity}
            provinceLabelOpacity={provinceLabelOpacity}
            cityNodes={cityNodes}
            capitalNodes={capitalNodes}
            provinceLabels={provinceLabels}
            placedLabelIds={placedLabelIds}
            transform={transform}
          />

          {/* D4 path polylines — under markers so pins sit on top of the route. */}
          {pathLines.map((line) => {
            if (line.points.length < 2) return null;
            const parts: string[] = [];
            for (const p of line.points) {
              const pt = lngLatToScreen(p.lat, p.lng, viewSize.width, viewSize.height, { k: 1, x: 0, y: 0 });
              if (!pt) continue;
              parts.push(`${parts.length === 0 ? "M" : "L"}${pt.x},${pt.y}`);
            }
            if (parts.length < 2) return null;
            return (
              <path
                key={`path-${line.id}`}
                d={parts.join(" ")}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1.75}
                strokeOpacity={0.55}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            );
          })}

          <MarkerLayer
            markers={markers}
            viewSize={viewSize}
            transform={transform}
            movingMarkerId={movingMarkerId}
            hasMovedRef={hasMoved}
            markerMovedRef={markerMovedRef}
            onMarkerClick={onMarkerClick}
            onMarkerDoubleClick={handleMarkerDoubleClick}
            onMarkerPointerDown={onMarkerPointerDown}
          />
        </g>

        {markers.map((m) => {
          if (!m.active || !m.region || movingMarkerId === m.id) return null;
          const pt = lngLatToScreen(m.lat, m.lng, viewSize.width, viewSize.height, transform);
          if (!pt) return null;

          return (
            <g key={`screen-lbl-${m.id}`} transform={`translate(${pt.x}, ${pt.y - 12})`} pointerEvents="none">
              <rect
                x={-40}
                y={-14}
                width={80}
                height={16}
                rx={3}
                fill="var(--surface-base)"
                stroke="var(--divider)"
                strokeWidth={1}
                opacity={0.9}
              />
              <text
                x={0}
                y={-5}
                fill="var(--text)"
                fontSize={10}
                fontWeight={500}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ userSelect: 'none' }}
              >
                {m.region.length > 10 ? `${m.region.slice(0, 9)}…` : m.region}
              </text>
            </g>
          );
        })}

        {ghostPt && (
          <g pointerEvents="none">
            <circle cx={ghostPt.x} cy={ghostPt.y} r={7} fill="var(--accent)" opacity={0.35} />
            <circle
              cx={ghostPt.x}
              cy={ghostPt.y}
              r={4}
              fill="var(--accent)"
              stroke="var(--surface-base)"
              strokeWidth={1.5}
            />
            {movingMarkerId && (() => {
              const movingMarker = markers.find((m) => m.id === movingMarkerId);
              if (!movingMarker?.region) return null;
              const reg = movingMarker.region;
              return (
                <g transform={`translate(${ghostPt.x}, ${ghostPt.y - 14})`}>
                  <rect
                    x={-40}
                    y={-14}
                    width={80}
                    height={16}
                    rx={3}
                    fill="var(--surface-base)"
                    stroke="var(--divider)"
                    strokeWidth={1}
                    opacity={0.9}
                  />
                  <text
                    x={0}
                    y={-5}
                    fill="var(--text)"
                    fontSize={10}
                    fontWeight={500}
                    textAnchor="middle"
                    dominantBaseline="central"
                    style={{ userSelect: 'none' }}
                  >
                    {reg.length > 10 ? `${reg.slice(0, 9)}…` : reg}
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
};
