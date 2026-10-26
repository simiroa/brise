/**
 * Local calendar-day helpers. Dashboard Wave 2 (2026-08-01) folded the old due_at axis into the
 * event end triple; Dashboard Wave 3 (2026-08-01) then retired the whole deadline/urgency display
 * model app-wide (no more [today-30d, +∞) gate, no ⏰/red badges) in favor of an explicit
 * per-note "알려줘" (remind) opt-in flag — see board/status.ts::isPinned for the one place a past
 * end date now has any display effect. This file's remaining export is just the local-calendar-day
 * formatter that survives both retirements (still needed by dateFmt.ts / board/status.ts).
 */

/** Local calendar day as YYYY-MM-DD. */
export function toIsoDateLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
