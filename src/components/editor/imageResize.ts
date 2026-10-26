/**
 * D5 image width policy — pure helpers shared by desktop drag handle and mobile 3-step buttons.
 *
 * Why centralize: both surfaces write the same `width` attr (`"40%"`) on BriseImage. Keeping the
 * clamp/format math in one place stops desktop free-drag and mobile presets from drifting
 * (e.g. allowing >100% on drag, or a mobile step that the desktop handle then "corrects").
 */

/** D5: default insert width as percent of the editor content column. */
export const IMAGE_WIDTH_DEFAULT = 40;

/** D5 hard ceiling — never wider than the content column. */
export const IMAGE_WIDTH_MAX = 100;

/**
 * Free-drag floor (desktop). Below ~10% the image becomes an untouchable sliver and the
 * handle is hard to re-grab; not a product preset, just a usability guard.
 */
export const IMAGE_WIDTH_MIN = 10;

/**
 * Mobile 3-step presets (D5 owner decision). Desktop free-drags any integer in [MIN, MAX];
 * mobile only offers these three so thumbs hit large targets.
 */
export const MOBILE_IMAGE_WIDTH_STEPS = [25, 40, 100] as const;

export type MobileImageWidthStep = (typeof MOBILE_IMAGE_WIDTH_STEPS)[number];

/** Clamp a numeric percent into the legal drag range and round to an integer. */
export function clampImageWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return IMAGE_WIDTH_DEFAULT;
  return Math.min(IMAGE_WIDTH_MAX, Math.max(IMAGE_WIDTH_MIN, Math.round(pct)));
}

/** Format a percent number as the attr string TipTap stores (`"70%"`). */
export function formatImageWidth(pct: number): string {
  return `${clampImageWidthPct(pct)}%`;
}

/**
 * Parse a stored width attr back to a percent number.
 * Why tolerate bare numbers / whitespace: older bodies and paste paths may not always
 * include the trailing `%`, and a bad value must never NaN the drag math.
 */
export function parseImageWidth(width: string | null | undefined): number {
  if (width == null || width === "") return IMAGE_WIDTH_DEFAULT;
  const n = parseFloat(String(width).trim());
  return Number.isFinite(n) ? clampImageWidthPct(n) : IMAGE_WIDTH_DEFAULT;
}

/**
 * Given pointer delta vs the content column width, compute the next width attr.
 * `startWidthPct` is the width when the drag began (not the live value) so each move
 * is absolute-from-start and doesn't accumulate rounding error.
 */
export function widthFromDrag(args: {
  startWidthPct: number;
  startClientX: number;
  clientX: number;
  parentWidthPx: number;
}): string {
  const { startWidthPct, startClientX, clientX, parentWidthPx } = args;
  if (!(parentWidthPx > 0)) return formatImageWidth(startWidthPct);
  const deltaPct = ((clientX - startClientX) / parentWidthPx) * 100;
  return formatImageWidth(startWidthPct + deltaPct);
}

/** True when the stored width matches a mobile step (for `data-active` on the 3 buttons). */
export function isMobileWidthStepActive(
  width: string | null | undefined,
  step: MobileImageWidthStep,
): boolean {
  const pct = parseImageWidth(width);
  // Default attr is 40% — treat missing/empty the same as the middle step so the UI
  // lights up "보통 40%" on freshly inserted images.
  if ((width == null || width === "") && step === IMAGE_WIDTH_DEFAULT) return true;
  return pct === step;
}
