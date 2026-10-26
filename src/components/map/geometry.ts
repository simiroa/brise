import { geoMercator } from "d3-geo";

export interface MapViewportBbox {
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
}

export function clampLat(lat: number): number {
  return Math.min(85, Math.max(-85, lat));
}

export function screenToLngLat(
  screenX: number,
  screenY: number,
  viewWidth: number,
  viewHeight: number,
  transform: { k: number; x: number; y: number }
): { lat: number; lng: number } | null {
  if (viewWidth <= 0 || viewHeight <= 0) return null;

  const unscaledX = (screenX - transform.x) / transform.k;
  const unscaledY = (screenY - transform.y) / transform.k;

  const baseProjection = geoMercator()
    .scale(viewWidth / (2 * Math.PI))
    .translate([viewWidth / 2, viewHeight / 2]);

  const coords = baseProjection.invert?.([unscaledX, unscaledY]);
  if (!coords) return null;
  const [lng, lat] = coords;
  if (isNaN(lat) || isNaN(lng)) return null;

  return {
    lat: Number(clampLat(lat).toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
}

export function lngLatToScreen(
  lat: number,
  lng: number,
  viewWidth: number,
  viewHeight: number,
  transform: { k: number; x: number; y: number }
): { x: number; y: number } | null {
  if (viewWidth <= 0 || viewHeight <= 0) return null;

  const baseProjection = geoMercator()
    .scale(viewWidth / (2 * Math.PI))
    .translate([viewWidth / 2, viewHeight / 2]);

  const p = baseProjection([lng, clampLat(lat)]);
  if (!p) return null;

  return {
    x: p[0] * transform.k + transform.x,
    y: p[1] * transform.k + transform.y,
  };
}

/**
 * Minimum zoom (k) that keeps the projected world covering the viewport.
 * d3's geoMercator defaults to a clipExtent of ±π·scale around its translate;
 * with scale = viewWidth / 2π that clip is exactly [0, viewWidth] horizontally
 * and [center - viewWidth/2, center + viewWidth/2] vertically — i.e. the
 * projected world is a square of side `viewWidth` in unscaled space,
 * regardless of `viewHeight`. So a container taller than it is wide needs k
 * stretched by `viewHeight / viewWidth` to close the vertical letterboxing gap.
 */
export function minCoverZoom(viewWidth: number, viewHeight: number): number {
  if (viewWidth <= 0) return 1;
  return Math.max(1, viewHeight / viewWidth);
}

/**
 * Clamp a pan/zoom transform so the map never reveals blank space past the
 * world's edges — independent of zoom level or viewport aspect ratio.
 */
export function clampMapTransform(
  viewWidth: number,
  viewHeight: number,
  transform: { k: number; x: number; y: number }
): { k: number; x: number; y: number } {
  if (viewWidth <= 0 || viewHeight <= 0) return transform;
  const k = Math.max(transform.k, minCoverZoom(viewWidth, viewHeight));
  const halfWorldSide = viewWidth / 2; // projected world is a square of side viewWidth (unscaled)
  const minX = viewWidth * (1 - k);
  const minY = viewHeight - (viewHeight / 2 + halfWorldSide) * k;
  const maxY = (halfWorldSide - viewHeight / 2) * k;
  return {
    k,
    x: Math.min(0, Math.max(minX, transform.x)),
    y: Math.min(maxY, Math.max(minY, transform.y)),
  };
}

export interface FitPointsOptions {
  /** Fraction of the viewport dimension the fit's span may fill, applied directly as
   * k = fill * viewDim / span (0..1]. Region fit passes a fill fraction (e.g.
   * REGION_FIT_PADDING); a caller expressing padding as margin-per-side instead passes
   * `1 - 2*pad`. */
  fill: number;
  maxZoom: number;
  /** @default 1 */
  minZoom?: number;
  /** Explicit zoom for a single point / zero-extent bbox. Omit to let the near-zero span's
   * naturally huge k clamp to maxZoom instead (region fit's behavior — see mapZoomScale.ts). */
  singleZoom?: number;
}

/**
 * Shared "points + viewport size → center + zoom" core behind mapFit.fitNotesLocation and
 * WorldMap.computeFitTransform — both projected the bbox's diagonal corners at k=1 and solved
 * for the k that fits the span into the viewport, differing only in their padding/zoom-range
 * knobs (now `opts`). Transform conversion (center lat/lng+zoom → {k,x,y}) stays in WorldMap via
 * computeSeedTransform — this only goes as far as center+zoom, which mapFit's MapLocation
 * consumers need directly.
 *
 * Non-wrapping Mercator, same as the rest of this map: points straddling the antimeridian can't
 * render as one contiguous view here regardless of bbox — screenToLngLat/lngLatToScreen never
 * wrap lng — so plain min/max lng is correct for what this map can actually display.
 */
export function fitPointsToView(
  points: Array<{ lat: number; lng: number }>,
  viewWidth: number,
  viewHeight: number,
  opts: FitPointsOptions
): { lat: number; lng: number; zoom: number } | null {
  if (points.length === 0 || viewWidth <= 0 || viewHeight <= 0) return null;

  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;

  if (opts.singleZoom != null && (points.length === 1 || (maxLat === minLat && maxLng === minLng))) {
    return { lat, lng, zoom: opts.singleZoom };
  }

  const identity = { k: 1, x: 0, y: 0 };
  const topLeft = lngLatToScreen(maxLat, minLng, viewWidth, viewHeight, identity);
  const bottomRight = lngLatToScreen(minLat, maxLng, viewWidth, viewHeight, identity);
  if (!topLeft || !bottomRight) {
    // Unreachable given the viewWidth/viewHeight>0 guard above (lngLatToScreen only returns
    // null for a non-positive viewport) — kept as a typed fallback, not exercised by tests.
    return { lat, lng, zoom: opts.singleZoom ?? opts.maxZoom };
  }

  const spanX = Math.max(1e-6, bottomRight.x - topLeft.x);
  const spanY = Math.max(1e-6, bottomRight.y - topLeft.y);
  const kX = (viewWidth / spanX) * opts.fill;
  const kY = (viewHeight / spanY) * opts.fill;
  const minZoom = opts.minZoom ?? 1;
  const zoom = Math.min(opts.maxZoom, Math.max(minZoom, Math.min(kX, kY)));
  return { lat, lng, zoom };
}

export function viewportBbox(
  viewWidth: number,
  viewHeight: number,
  transform: { k: number; x: number; y: number }
): MapViewportBbox | null {
  if (viewWidth <= 0 || viewHeight <= 0) return null;
  const tl = screenToLngLat(0, 0, viewWidth, viewHeight, transform);
  const br = screenToLngLat(viewWidth, viewHeight, viewWidth, viewHeight, transform);
  if (!tl || !br) return null;

  const min_lat = Math.min(tl.lat, br.lat);
  const max_lat = Math.max(tl.lat, br.lat);
  const min_lng = Math.min(tl.lng, br.lng);
  const max_lng = Math.max(tl.lng, br.lng);

  const latPad = (max_lat - min_lat) * 0.05 || 0.1;
  const lngPad = (max_lng - min_lng) * 0.05 || 0.1;
  return {
    min_lat: Math.max(-85, min_lat - latPad),
    max_lat: Math.min(85, max_lat + latPad),
    min_lng: Math.max(-180, min_lng - lngPad),
    max_lng: Math.min(180, max_lng + lngPad),
  };
}
