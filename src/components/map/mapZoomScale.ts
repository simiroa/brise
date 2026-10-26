/**
 * Single source of truth for every named map zoom-scale (Mercator `k`) constant, plus the two
 * fit-algorithm tuning knobs that lived right next to them. Moved here from WorldMap.tsx /
 * mapFit.ts / RegionPickerDialog.tsx / RegionPreview.tsx / useMapPanZoom.ts (owner-approved
 * cleanup, 2026-08-10) — values are unchanged, only the location + name. The original modules
 * re-export (or re-import) their own constant from here so existing import paths — e.g.
 * mapFit.ts's `FIT_MAX_ZOOM`, imported by HomeMapPane — don't have to change.
 *
 * geometry.ts's geoMercator uses scale = viewWidth / (2π), so the visible longitude span in
 * degrees ≈ 360 / k regardless of viewport size — the "≈ lon span" column is that formula
 * applied to each constant below, to make the relative scale of these numbers legible at a
 * glance instead of memorized.
 *
 *   k    | ≈ lon span | reads as                                | used by
 *   -----|------------|------------------------------------------|--------------------------------
 *   1    | 360°       | whole world (absolute min, see geometry.ts minCoverZoom)
 *   2    | 180°       | HOME_FIT_MIN_ZOOM — fit-to-notes floor    | mapFit.ts
 *   20   | 18°        | CITY_DOT_MIN_ZOOM — city dots appear      | WorldMap city LOD
 *   30   | 12°        | REGION_FIT_MAX_ZOOM — region-filter cap   | WorldMap.computeFitTransform
 *   32   | 11.25°     | CITY_LABEL_MIN_ZOOM — city labels appear  | WorldMap city LOD
 *   50   | 7.2°       | SINGLE_NOTE_FOCUS_ZOOM — one-pin close-up | RegionPreview, mapFit.ts
 *   150  | 2.4°       | FACTORY_DEFAULT_MAP_ZOOM (city-scale)     | stores/settings.ts (owns it)
 *   200  | 1.8°       | FIT_MAX_ZOOM — fit-to-notes ceiling       | mapFit.ts
 *   320  | 1.125°     | PICK_FLYTO_ZOOM — search-pick fly-to      | RegionPickerDialog
 *   400  | 0.9°       | WHEEL_MAX_ZOOM — free wheel-zoom ceiling  | useMapPanZoom
 *
 * FACTORY_DEFAULT_MAP_ZOOM/FACTORY_DEFAULT_MAP_LOCATION stay defined in stores/settings.ts (not
 * re-exported from here) — they're the settings store's own factory default, not a derived map
 * constant, and settings.ts is maintained separately from the map feature.
 */

// --- City LOD thresholds (WorldMap city dot/label reveal) ---
export const CITY_DOT_MIN_ZOOM = 20;
export const CITY_LABEL_MIN_ZOOM = 32;

/**
 * Region-filter fly-to-fit ceiling (WorldMap.computeFitTransform) — also what a single-marker
 * (or all-coincident-marker) bbox collapses to, since a near-zero span drives kFit toward
 * Infinity before this caps it.
 *
 * Deliberately NOT the same constant as SINGLE_NOTE_FOCUS_ZOOM below even though both are "one or
 * two notes, focused" scales: this one caps a region filter's fit over however many notes matched
 * (which can be a whole city's worth spread across a few blocks), while SINGLE_NOTE_FOCUS_ZOOM is
 * a single deliberate close-up on one pin (RegionPreview / mapFit's single-point case). Merging
 * them into one value would change the on-screen zoom of whichever call site didn't already use
 * it — kept apart on purpose, not by oversight.
 */
export const REGION_FIT_MAX_ZOOM = 30;
/** Fraction of the viewport REGION_FIT_MAX_ZOOM's fit may fill — the rest is breathing room so
 * edge markers aren't flush against the frame. */
export const REGION_FIT_PADDING = 0.85;

// --- Home dashboard fit-to-notes (mapFit.fitNotesLocation) ---
/** Highest zoom fit-to-notes will ever produce on its own. Doubles as the "still trustworthy as a
 * home view" ceiling for the dashboard map's restored session viewport (HomeMapPane) — anything
 * past what auto-fit itself would ever pick came from free manual wheel-zoom (up to
 * WHEEL_MAX_ZOOM) and can land the camera deep inside a single landmass with no border in view
 * (looks like a blank green pane on restore). */
export const FIT_MAX_ZOOM = 200;
/** Zoom floor for fit-to-notes — never zooms out past "180° of longitude visible". */
export const HOME_FIT_MIN_ZOOM = 2;
/** Fraction of width/height fit-to-notes reserves as margin on each side. */
export const HOME_FIT_MARGIN_PAD = 0.14;

/**
 * Single-note focus zoom — shared by RegionPreview (no waypoints: center on the one pin) and
 * mapFit's single/all-coincident-point fit default. Same "one pin, comfortably close" intent at
 * both call sites.
 */
export const SINGLE_NOTE_FOCUS_ZOOM = 50;

/** Zoom used when a search pick flies the camera to a place — city-filling, well under
 * WHEEL_MAX_ZOOM. Picking "명동" shouldn't leave Incheon's coastline in view. */
export const PICK_FLYTO_ZOOM = 320;

/** Absolute ceiling for free wheel-zoom (useMapPanZoom) — the deepest a user can manually zoom. */
export const WHEEL_MAX_ZOOM = 400;

// --- SVG k ↔ MapLibre GL z ---
//
// 두 좌표계가 재는 것은 같다: "세계 한 바퀴가 화면에서 몇 px 인가".
//   SVG(geometry.ts geoMercator): 세계 폭 = viewWidth × k
//   MapLibre:                     세계 폭 = GL_TILE_SIZE × 2^z
// 그래서 viewWidth × k = 512 × 2^z 로 두면 아래 두 식이 나온다. 저장값·설정값·onViewChange 는
// 전부 k 단위를 유지하고(기존 노트북 설정/세션 뷰포트 호환), 변환은 이 두 함수에서만 한다.
export const GL_TILE_SIZE = 512;

/** SVG 배율 k → MapLibre zoom. viewWidth 는 지도 컨테이너의 CSS 픽셀 폭. */
export function kToGlZoom(k: number, viewWidth: number): number {
  if (!(k > 0) || !(viewWidth > 0)) return 0;
  return Math.log2((viewWidth * k) / GL_TILE_SIZE);
}

/** MapLibre zoom → SVG 배율 k. */
export function glZoomToK(z: number, viewWidth: number): number {
  if (!(viewWidth > 0)) return 1;
  return (GL_TILE_SIZE * Math.pow(2, z)) / viewWidth;
}
