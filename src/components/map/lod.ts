// Pure LOD (level-of-detail) helpers — viewport culling and rank-based label capping.
// Extracted out of WorldMap's render-path useMemos so they're unit-testable without mounting
// the SVG/ResizeObserver/pan-zoom machinery. WorldMap still owns d3 projection/path generation;
// these only decide *which* features are in view.
import { screenToLngLat } from "./geometry";

export interface LngLatBounds {
  tl: { lat: number; lng: number };
  br: { lat: number; lng: number };
}

/** Viewport's lng/lat window for the current transform (top-left / bottom-right corners). */
export function viewportBounds(
  viewWidth: number,
  viewHeight: number,
  transform: { k: number; x: number; y: number }
): LngLatBounds | null {
  const tl = screenToLngLat(0, 0, viewWidth, viewHeight, transform);
  const br = screenToLngLat(viewWidth, viewHeight, viewWidth, viewHeight, transform);
  if (!tl || !br) return null;
  return { tl, br };
}

/** Bbox-tagged features (e.g. admin-1 provinces) whose baked bbox `b` overlaps the viewport. */
export function cullByBbox<T extends { b: [[number, number], [number, number]] }>(
  features: T[],
  bounds: LngLatBounds
): T[] {
  const { tl, br } = bounds;
  const out: T[] = [];
  for (const f of features) {
    const b = f.b;
    if (b[0][0] > br.lng || b[1][0] < tl.lng) continue;
    if (b[0][1] > tl.lat || b[1][1] < br.lat) continue;
    out.push(f);
  }
  return out;
}

/** Point features (capitals/cities) that sit inside the viewport window. */
export function cullPoints<T extends { lng: number; lat: number }>(
  points: T[],
  bounds: LngLatBounds
): T[] {
  const { tl, br } = bounds;
  return points.filter(
    (p) => p.lng >= tl.lng && p.lng <= br.lng && p.lat <= tl.lat && p.lat >= br.lat
  );
}

/** Keeps the `n` best (lowest `rank`) points — Natural Earth convention: rank 0 = most prominent. */
export function topByRank<T extends { rank: number }>(points: T[], n: number): T[] {
  if (points.length <= n) return points;
  return [...points].sort((a, b) => a.rank - b.rank).slice(0, n);
}

/**
 * Linear zoom-in ramp: 0 below `min`, `cap` at/above `max`, linear in between.
 * Shared by WorldMap's per-layer opacity fades (capitals/admin1/province labels/
 * city dots/city labels) — same formula, only the (min, max, cap) triple differs
 * per layer.
 */
export function zoomRamp(zoom: number, min: number, max: number, cap: number): number {
  if (zoom < min) return 0;
  if (zoom >= max) return cap;
  return ((zoom - min) / (max - min)) * cap;
}

/**
 * Country-geometry tier crossfade — with a fallback ladder (owner QA 2026-08-10).
 *
 * The old inline formulas faded 110m out unconditionally at k≥4 and only showed 50m/10m when
 * their dynamic imports had actually arrived. If the finer tier was still in flight (or its
 * import failed — swallowed by .catch), NOTHING rendered past k=4: a uniform "빈 초록 화면"
 * with only admin-1 lines, which read as "지도가 엉뚱한 곳에 가 있다" even though the camera
 * was exactly on the pin.
 *
 * Invariant here: **the finest loaded tier is always visible** — a coarser tier only fades out
 * once something finer is actually on screen. Crossfade bands (2.5–4 for 110m→50m, 6–8 for
 * 50m→10m) are unchanged when everything loads.
 */
export function tierOpacities(
  zoom: number,
  has50m: boolean,
  has10m: boolean
): { o110m: number; o50m: number; o10m: number } {
  let o10m = 0;
  if (has10m) {
    if (zoom >= 8) o10m = 1;
    else if (zoom >= 6) o10m = (zoom - 6) / (8 - 6);
    // 50m 실패/미도착이면 4–6 구간(원래 50m 담당)을 10m이 대신 맡는다.
    else if (!has50m && zoom >= 4) o10m = 1;
  }
  let o50m = 0;
  if (has50m) {
    if (zoom >= 8) o50m = has10m ? 0 : 1; // 10m 없으면 50m 유지 (기존: 무조건 0 → 백지)
    else if (zoom > 6) o50m = (8 - zoom) / (8 - 6);
    else if (zoom >= 4) o50m = 1;
    else if (zoom >= 2.5) o50m = (zoom - 2.5) / (4 - 2.5);
  }
  let o110m = zoom < 2.5 ? 1 : zoom >= 4 ? 0 : (4 - zoom) / (4 - 2.5);
  // 로드된 게 110m뿐이면 줌과 무관하게 보여준다 — 거칠어도 백지보다 낫다.
  if (o50m === 0 && o10m === 0) o110m = 1;
  return { o110m, o50m, o10m };
}

// ─── Cross-layer label collision placement ───────────────────────────────────
// Capitals / provinces / cities are independent data sources; without a shared
// pass, "서울" (city) stacks on "서울" (capital) and "서울특별시" (admin-1).
// Placement is pure geometry over the *already culled/capped* candidate set
// (tens of labels, never the full ~2200-city corpus).

/** Map label source layer. Priority: capital > province > city. */
export type MapLabelLayer = "capital" | "province" | "city";

export interface MapLabelCandidate {
  /** Stable unique id across layers (`cap:3`, `city:12`, `prov:…`). */
  id: string;
  text: string;
  /** Text anchor x (same space as WorldMap projection coords). */
  x: number;
  /** Text anchor y (already includes any hanging offset). */
  y: number;
  /** Font size in the same coordinate space as x/y (WorldMap: screenPx / k). */
  fontSize: number;
  layer: MapLabelLayer;
  /** Natural Earth rank for cities (0 = most prominent). Ignored for other layers. */
  rank?: number;
  /**
   * How the text sits on (x, y). Matches SVG dominantBaseline:
   * - hanging — below the anchor (city/capital labels)
   * - central — centered on the anchor (province centroids)
   */
  baseline?: "hanging" | "central";
}

export interface PlaceLabelsOptions {
  /** Extra padding around each estimated bbox (same units as x/y). Default 0. */
  padding?: number;
  /**
   * Centers closer than this are treated as the same place: only the higher-
   * priority (or more specific) label survives. Default = 1.25 × max fontSize.
   */
  samePlaceRadius?: number;
}

const LAYER_PRIORITY: Record<MapLabelLayer, number> = {
  capital: 0,
  province: 1,
  city: 2,
};

/** CJK / fullwidth / Hangul / kana / etc. — roughly 1em advance. */
const CJK_RE = /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * Approx label width without measureText/getBBox.
 * CJK-ish code points ≈ 1em; Latin/other ≈ 0.55em.
 */
export function estimateLabelWidth(text: string, fontSize: number): number {
  if (!text || fontSize <= 0) return 0;
  let units = 0;
  for (const ch of text) {
    units += CJK_RE.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

interface LabelBBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
}

function labelBBox(c: MapLabelCandidate, padding: number): LabelBBox {
  const w = estimateLabelWidth(c.text, c.fontSize);
  const h = c.fontSize;
  const left = c.x - w / 2 - padding;
  const right = c.x + w / 2 + padding;
  const baseline = c.baseline ?? "hanging";
  let top: number;
  let bottom: number;
  if (baseline === "central") {
    top = c.y - h / 2 - padding;
    bottom = c.y + h / 2 + padding;
  } else {
    // hanging: glyph body sits below the anchor
    top = c.y - padding;
    bottom = c.y + h + padding;
  }
  return {
    left,
    right,
    top,
    bottom,
    cx: c.x,
    cy: baseline === "central" ? c.y : c.y + h / 2,
  };
}

function bboxesOverlap(a: LabelBBox, b: LabelBBox): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Compare placement priority. Lower sort key = placed first (kept on conflict).
 * capital > province > city; within city, lower rank wins; then longer text
 * ("more specific", e.g. 서울특별시 over 서울); then id for determinism.
 */
export function compareLabelPriority(a: MapLabelCandidate, b: MapLabelCandidate): number {
  const lp = LAYER_PRIORITY[a.layer] - LAYER_PRIORITY[b.layer];
  if (lp !== 0) return lp;
  const ra = a.rank ?? 0;
  const rb = b.rank ?? 0;
  if (ra !== rb) return ra - rb;
  // Prefer more specific name when same layer/rank (longer wins).
  if (a.text.length !== b.text.length) return b.text.length - a.text.length;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Greedy cross-layer label placement. Sorts by priority, places if approx bbox
 * does not intersect any already-placed label and is not same-place as one.
 * Returns the set of candidate ids that should render.
 *
 * O(n log n + n·p) where n = candidates, p = placed (p ≤ n). Call only on the
 * already culled/capped set.
 */
export function placeLabels(
  candidates: MapLabelCandidate[],
  options: PlaceLabelsOptions = {}
): Set<string> {
  if (candidates.length === 0) return new Set();

  const padding = options.padding ?? 0;
  let samePlaceRadius = options.samePlaceRadius;
  if (samePlaceRadius === undefined) {
    let maxFs = 0;
    for (const c of candidates) {
      if (c.fontSize > maxFs) maxFs = c.fontSize;
    }
    samePlaceRadius = maxFs * 1.25;
  }
  const samePlaceR2 = samePlaceRadius * samePlaceRadius;

  const sorted = [...candidates].sort(compareLabelPriority);
  const placed: LabelBBox[] = [];
  const kept = new Set<string>();

  for (const c of sorted) {
    const box = labelBBox(c, padding);
    let conflict = false;
    for (const p of placed) {
      if (dist2(box.cx, box.cy, p.cx, p.cy) <= samePlaceR2 || bboxesOverlap(box, p)) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      placed.push(box);
      kept.add(c.id);
    }
  }

  return kept;
}
