import { useMemo } from "react";
import { useSearchStore } from "../../stores/search";
import { createMatchesTagRegion } from "../leftpanel/notetree/filtering";

/**
 * Shared cross-tab search-hit id set for the dashboard's global search box (owner-approved
 * "완전 공유" design — the dashboard search box fully shares useSearchStore with the sidebar,
 * see HomeTab.tsx). Each home pane (board/calendar/timeline/map/graph) reads this to DIM (never
 * filter-out) already-fetched local data — no new IPC per keystroke, the store's own 200ms
 * debounce already gates the search_notes call.
 *
 * null = no filtering (empty query) — every pane should render at full opacity.
 *
 * Caveats worth knowing before wiring a new pane:
 * - search_notes is capped at 500 ids server-side (stores/search.ts::recomputeKeyword) — a query
 *   matching more than 500 notes under-marks hits past the cap. Acceptable for a dim/highlight
 *   affordance, not a hard filter.
 * - searchResults is already year-scoped by yearFrom/yearTo server-side. Additionally, sidebar
 *   filters (selectedTags, tagMode, regionFilter, statusFilter, dateRange) are applied via
 *   createMatchesTagRegion before building the hit Set so a note matching the text query but
 *   filtered out by active sidebar filters is NOT in this set (and reads as "dimmed") — that's
 *   "not a hit under the current global filters", not a bug.
 */
/**
 * Sibling hook to useDashboardSearchHits that preserves searchResults order as an array.
 * Used for dashboard search hit cycling (< > buttons).
 */
export function useDashboardSearchOrderedHits(): string[] | null {
  const query = useSearchStore((s) => s.query);
  const searchResults = useSearchStore((s) => s.searchResults);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);

  const matchesTagRegion = useMemo(
    () => createMatchesTagRegion({ selectedTags, tagMode, regionFilter, statusFilter, dateRange }),
    [selectedTags, tagMode, regionFilter, statusFilter, dateRange],
  );

  return useMemo(() => {
    if (query.trim() === "") return null;
    const filtered = searchResults.filter(matchesTagRegion);
    return filtered.map((n) => n.id);
  }, [query, searchResults, matchesTagRegion]);
}

export function useDashboardSearchHits(): Set<string> | null {
  const ordered = useDashboardSearchOrderedHits();
  return useMemo(() => (ordered === null ? null : new Set(ordered)), [ordered]);
}

