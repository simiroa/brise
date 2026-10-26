/**
 * Resolves a date-range chip identity (§2.8 HANDOFF-calendar-onboarding.md) to concrete
 * updated_from/updated_to bounds — done at query-build time, never stored resolved
 * (stores/search.ts::DateRangeKey: storing resolved dates would freeze the window at click
 * time, so a session left open overnight would keep querying yesterday's "last 7 days").
 *
 * Deliberately dependency-free (no runtime imports — DateRangeKey below is a type-only import,
 * erased at build time). `noteQuery.ts`'s three notetree hooks (useFolderWindows/
 * useFavoritesWindow/useTreeLoadMore) dynamically `import("../../../lib/noteQuery")` to defer
 * pulling in `invoke.ts` until actually needed; `filtering.ts` (the search_notes client
 * post-filter, statically imported by notetree/index.tsx) also needs this resolver, and
 * importing it from `noteQuery.ts` would force that eager `invoke.ts` edge back in through the
 * static import graph. Keeping the pure date math in its own leaf module lets both sides import
 * it without either the duplication or the eager-load regression.
 *
 * UTC/local boundary rule (pinned per §2.8, which flags this as needing an explicit choice):
 * boundaries are UTC calendar days, not the user's local calendar day. `notes.updated_at` is
 * stored ISO8601 UTC and note_query compares directly against that raw column (see
 * note_query.rs), matching note_record_histogram's existing UTC-day bucketing — one
 * day-boundary convention for both, instead of two. These are coarse "about the last week/
 * month/year" navigational chips, not the calendar grid (a later wave that will need true
 * local-day precision) — a chip boundary off by up to a day near local midnight for users far
 * from UTC is an acceptable, documented cost here.
 */
import type { DateRangeKey } from "../stores/search";

export function resolveDateRange(
  key: DateRangeKey | null | undefined
): { from?: string; to?: string } {
  if (!key) return {};
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (key === "thisYear") {
    return { from: `${now.getUTCFullYear()}-01-01`, to };
  }
  const days = key === "last7" ? 7 : 30;
  const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}
