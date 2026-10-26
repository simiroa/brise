import { useSearchStore } from "../../stores/search";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { useUiStore } from "../../stores/ui";
import { RemovableChip } from "./yearfilter/shared";
import { buildActiveFilterChips } from "./buildActiveFilterChips";
import { t } from "../../i18n/t";

/**
 * Sidebar summary of the active FilterModal state — status → tags → region → date range → year.
 * query is intentionally excluded (already visible in the search input). Renders nothing (0px)
 * with zero active axes. Clicking a chip's label (not its ×) reopens the modal for editing.
 * Chip list comes from buildActiveFilterChips (shared with the phone home).
 */
export function ActiveFilterChips() {
  const filterMode = useSearchStore((s) => s.filterMode);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const toggleStatusFilter = useSearchStore((s) => s.toggleStatusFilter);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const selectTag = useSearchStore((s) => s.selectTag);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const setRegionFilter = useSearchStore((s) => s.setRegionFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const setDateRangeFilter = useSearchStore((s) => s.setDateRangeFilter);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  const openFilters = useUiStore((s) => s.openFilters);

  if (filterMode === "chat") return null;

  const chips = buildActiveFilterChips({
    statusFilter, toggleStatusFilter, selectedTags, selectTag, regionFilter, setRegionFilter,
    dateRange, setDateRangeFilter, yearFrom, yearTo, yearBounds, setYearRange, customStatuses,
  });

  if (chips.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--space-1)",
        marginBottom: "var(--space-2)",
      }}
    >
      {chips.map((c) => (
        <RemovableChip
          key={c.key}
          label={c.label}
          active
          onSelect={openFilters}
          onRemove={c.onRemove}
          removeLabel={t("search.era_remove_custom", { name: c.label })}
        />
      ))}
    </div>
  );
}
