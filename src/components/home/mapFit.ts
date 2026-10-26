/**
 * Pure helpers for the home Map tab: fit-to-notes viewport + distance ranking.
 * No map libraries — uses the same mercator projection as WorldMap geometry.
 */
import { fitPointsToView, type MapViewportBbox } from "../map/geometry";
import type { MapLocation } from "../map/WorldMap";
import type { NoteSummary } from "../../lib/commands.gen";
import {
  FIT_MAX_ZOOM,
  HOME_FIT_MIN_ZOOM,
  HOME_FIT_MARGIN_PAD,
  SINGLE_NOTE_FOCUS_ZOOM,
} from "../map/mapZoomScale";

export type LatLng = { lat: number; lng: number };

// FIT_MAX_ZOOM re-exported so existing `from "./mapFit"` importers (HomeMapPane) keep working —
// canonical home + doc comment is mapZoomScale.ts.
export { FIT_MAX_ZOOM };

/** Axis-aligned bounding box of notes that have finite lat/lng. */
export function notesBoundingBox(notes: LatLng[]): MapViewportBbox | null {
  if (notes.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const n of notes) {
    if (!Number.isFinite(n.lat) || !Number.isFinite(n.lng)) continue;
    minLat = Math.min(minLat, n.lat);
    maxLat = Math.max(maxLat, n.lat);
    minLng = Math.min(minLng, n.lng);
    maxLng = Math.max(maxLng, n.lng);
  }
  if (!Number.isFinite(minLat)) return null;
  return { min_lat: minLat, max_lat: maxLat, min_lng: minLng, max_lng: maxLng };
}

/**
 * Compute a MapLocation (center + zoom k) that fits all points into the view.
 * Falls back to a single-point zoom when there is only one note or zero extent.
 * `pad` is the fraction of width/height reserved as margin (0.12 ≈ 12%).
 */
export function fitNotesLocation(
  notes: LatLng[],
  viewWidth: number,
  viewHeight: number,
  opts?: { pad?: number; singleZoom?: number; minZoom?: number; maxZoom?: number }
): MapLocation | null {
  const pad = opts?.pad ?? HOME_FIT_MARGIN_PAD;
  const singleZoom = opts?.singleZoom ?? SINGLE_NOTE_FOCUS_ZOOM;
  const minZoom = opts?.minZoom ?? HOME_FIT_MIN_ZOOM;
  const maxZoom = opts?.maxZoom ?? FIT_MAX_ZOOM;

  const pts = notes.filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lng));
  if (pts.length === 0) return null;

  const w = Math.max(viewWidth, 1);
  const h = Math.max(viewHeight, 1);
  // pad is margin-per-side; fitPointsToView's `fill` is a direct fraction of the viewport
  // dimension, hence 1 - 2*pad (reserve pad on each of the two sides).
  return fitPointsToView(pts, w, h, { fill: 1 - 2 * pad, minZoom, maxZoom, singleZoom });
}

/** Earth-mean radius (km). Haversine distance — no external geo library. */
const EARTH_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The `count` located notes among `candidates` nearest to `origin`, closest first.
 * `excludeId` drops one note (the origin note itself when ranking around a selection).
 */
export function nearestTo(
  origin: LatLng,
  candidates: NoteSummary[],
  count: number,
  excludeId?: string
): { note: NoteSummary; km: number }[] {
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return [];
  return candidates
    .filter(
      (n) =>
        n.id !== excludeId &&
        n.lat != null &&
        n.lng != null &&
        Number.isFinite(n.lat) &&
        Number.isFinite(n.lng)
    )
    .map((n) => ({
      note: n,
      km: haversineKm(origin.lat, origin.lng, n.lat!, n.lng!),
    }))
    .sort((a, b) => a.km - b.km)
    .slice(0, Math.max(0, count));
}

/**
 * Selected note first, then the nearest `neighborCount` other located notes
 * among `candidates` (typically all currently loaded markers).
 */
export function nearestAround(
  selected: NoteSummary,
  candidates: NoteSummary[],
  neighborCount: number
): { note: NoteSummary; km: number }[] {
  if (
    selected.lat == null ||
    selected.lng == null ||
    !Number.isFinite(selected.lat) ||
    !Number.isFinite(selected.lng)
  ) {
    return [{ note: selected, km: 0 }];
  }
  const origin = { lat: selected.lat, lng: selected.lng };
  return [{ note: selected, km: 0 }, ...nearestTo(origin, candidates, neighborCount, selected.id)];
}

/** Format distance for the filmstrip meta line. */
export function formatKm(km: number): string {
  if (km < 0.05) return "";
  if (km < 10) return `${km.toFixed(1)}km`;
  if (km < 100) return `${Math.round(km)}km`;
  if (km < 1000) return `${Math.round(km)}km`;
  return `${(km / 1000).toFixed(1)}Mm`;
}
