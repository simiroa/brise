import { BUILT_IN_STATUSES, customStatusName } from "../../lib/status";
import { DATE_RANGE_OPTIONS } from "./yearfilter/DateRangeFilter";
import { t } from "../../i18n/t";
import type { useSearchStore } from "../../stores/search";
import type { useTaxonomyStore } from "../../stores/taxonomy";

export interface ActiveFilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

type SearchState = ReturnType<typeof useSearchStore.getState>;

/** The slice of the search store the chip list reads (state + the per-axis clear actions). */
export type ActiveFilterChipInput = Pick<
  SearchState,
  | "statusFilter"
  | "toggleStatusFilter"
  | "selectedTags"
  | "selectTag"
  | "regionFilter"
  | "setRegionFilter"
  | "dateRange"
  | "setDateRangeFilter"
  | "yearFrom"
  | "yearTo"
  | "yearBounds"
  | "setYearRange"
> & {
  customStatuses: ReturnType<typeof useTaxonomyStore.getState>["statuses"];
  /** Only read with `includeQuery`. */
  query?: string;
  setQuery?: (q: string) => void;
};

/**
 * One chip per active filter axis — status → tags → region → date range → year (desktop order).
 * Single source of truth for axis labels and clear actions, shared by the desktop sidebar
 * (ActiveFilterChips) and the phone home (MobileActiveFilterChips).
 * `includeQuery` prepends a query chip: desktop omits it (the search input already shows it), the
 * phone home has no search input and its list IS narrowed by the query.
 */
export function buildActiveFilterChips(s: ActiveFilterChipInput, opts: { includeQuery?: boolean } = {}): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  const q = (s.query ?? "").trim();
  if (opts.includeQuery && q !== "") {
    chips.push({ key: "query", label: `“${q}”`, onRemove: () => s.setQuery?.("") });
  }
  for (const key of s.statusFilter) {
    const builtIn = BUILT_IN_STATUSES.find((d) => d.key === key);
    const label = builtIn ? t(builtIn.labelKey) : customStatusName(key, s.customStatuses) ?? key;
    chips.push({ key: `status:${key}`, label, onRemove: () => s.toggleStatusFilter(key) });
  }
  for (const tag of s.selectedTags) {
    chips.push({ key: `tag:${tag}`, label: `#${tag}`, onRemove: () => s.selectTag(tag, true) });
  }
  if (s.regionFilter) {
    const label =
      s.regionFilter.kind === "none"
        ? t("search.region_no_region")
        : t("search.filter_chip_region", { name: s.regionFilter.name });
    chips.push({ key: "region", label, onRemove: () => s.setRegionFilter(null) });
  }
  if (s.dateRange) {
    const opt = DATE_RANGE_OPTIONS.find((o) => o.key === s.dateRange);
    if (opt) chips.push({ key: "date", label: t(opt.labelKey), onRemove: () => s.setDateRangeFilter(null) });
  }
  if (s.yearFrom > s.yearBounds.min || s.yearTo < s.yearBounds.max) {
    chips.push({
      key: "year",
      label: `${s.yearFrom}–${s.yearTo}`,
      onRemove: () => s.setYearRange(s.yearBounds.min, s.yearBounds.max),
    });
  }
  return chips;
}
