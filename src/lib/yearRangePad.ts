/**
 * Pad a data min/max year range for a stable axis frame.
 * Shared by dashboard timeline `deriveFullRange` and sidebar year-filter bounds.
 */
export function padYearRange(min: number, max: number): { from: number; to: number } {
  const pad = Math.max(1, Math.round((max - min) * 0.02) || 1);
  return { from: Math.floor(min) - pad, to: Math.ceil(max) + pad };
}
