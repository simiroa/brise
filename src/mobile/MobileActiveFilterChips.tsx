import { useSearchStore } from "../stores/search";
import { useTaxonomyStore } from "../stores/taxonomy";
import { buildActiveFilterChips } from "../components/leftpanel/buildActiveFilterChips";
import { IconClose } from "../components/icons";
import { t } from "../i18n/t";

interface MobileActiveFilterChipsProps {
  /** Tapping a chip's label (not its ×) — opens the filter sheet. */
  onOpenSheet: () => void;
}

/**
 * Phone twin of the desktop sidebar's ActiveFilterChips: one removable chip per active filter axis,
 * in a single horizontally scrolling row under the sub-bar. Axis set = countActiveFilterAxes (the
 * filter button's badge), so the number on the badge and the chips agree — query included, since
 * the phone home has no search input and MobileNoteTree narrows by it. Renders nothing at zero axes.
 */
export function MobileActiveFilterChips({ onOpenSheet }: MobileActiveFilterChipsProps) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
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

  const chips = buildActiveFilterChips(
    {
      query, setQuery, statusFilter, toggleStatusFilter, selectedTags, selectTag, regionFilter, setRegionFilter,
      dateRange, setDateRangeFilter, yearFrom, yearTo, yearBounds, setYearRange, customStatuses,
    },
    { includeQuery: true },
  );
  if (chips.length === 0) return null;

  return (
    <div className="mobile-active-chips" data-testid="mobile-active-chips">
      {chips.map((c) => (
        <span key={c.key} className="mobile-active-chip" data-testid="mobile-active-chip">
          <button type="button" className="mobile-active-chip-label" onClick={onOpenSheet}>
            {c.label}
          </button>
          <button
            type="button"
            className="mobile-active-chip-x"
            onClick={c.onRemove}
            aria-label={t("search.era_remove_custom", { name: c.label })}
          >
            <IconClose size={12} strokeWidth={2.4} aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}
