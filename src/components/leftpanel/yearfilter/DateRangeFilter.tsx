import { useSearchStore, type DateRangeKey } from "../../../stores/search";
import { t } from "../../../i18n/t";
import { chipStyle } from "./shared";

export const DATE_RANGE_OPTIONS: { key: DateRangeKey; labelKey: string }[] = [
  { key: "last7", labelKey: "search.date_range_last7" },
  { key: "last30", labelKey: "search.date_range_last30" },
  { key: "thisYear", labelKey: "search.date_range_this_year" },
];

/* ── Advanced search: record-axis (updated_at) date-range chips ──
   §2.8 HANDOFF-calendar-onboarding.md: narrows by note.updated_at (record axis) — a different
   axis than the Timeline's yearFrom/yearTo (event axis, notes.year). Single-select: clicking
   the already-active chip clears it (own-inverse gesture, same rule as selectTag/RegionFilter's
   re-click-to-clear on this panel) — there is no separate "clear" control for this row. */
export function DateRangeFilter() {
  const dateRange = useSearchStore((s) => s.dateRange);
  const setDateRangeFilter = useSearchStore((s) => s.setDateRangeFilter);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }} data-testid="date-range-filter">
      {DATE_RANGE_OPTIONS.map((opt) => {
        const active = dateRange === opt.key;
        return (
          <button
            type="button"
            key={opt.key}
            onClick={() => setDateRangeFilter(active ? null : opt.key)}
            style={chipStyle(active)}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
