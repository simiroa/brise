import { useSearchStore } from "../stores/search";
import { useTaxonomyStore } from "../stores/taxonomy";
import { t } from "../i18n/t";

export type YearChipId = "last10" | "last50" | `era:${string}`;

/** Same clamp as search.ts::setYearRange — from < to after clamp, else not a real filter. */
export function clampYearChip(
  from: number,
  to: number,
  bounds: { min: number; max: number },
): { from: number; to: number } | null {
  let nf = Math.min(Math.max(from, bounds.min), bounds.max);
  let nt = Math.min(Math.max(to, bounds.min), bounds.max);
  if (!(nf < nt)) return null;
  if (nf === bounds.min && nt === bounds.max) return null;
  return { from: nf, to: nt };
}

function builtinRange(id: "last10" | "last50", nowYear: number): { from: number; to: number } {
  return { from: nowYear - (id === "last10" ? 9 : 49), to: nowYear };
}

/**
 * Event-year axis (notes.year), not record period (last7/last30).
 * Builtins + taxonomy eras; tap writes setYearRange, re-tap restores full bounds.
 */
export function MobileYearChips({ nowYear = new Date().getFullYear() }: { nowYear?: number }) {
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const eras = useTaxonomyStore((s) => s.eras);

  const last10 = clampYearChip(builtinRange("last10", nowYear).from, builtinRange("last10", nowYear).to, yearBounds);
  const last50 = clampYearChip(builtinRange("last50", nowYear).from, builtinRange("last50", nowYear).to, yearBounds);

  const eraChips = eras.flatMap((era) => {
    const range = clampYearChip(era.from_year, era.to_year, yearBounds);
    return range ? [{ id: `era:${era.id}` as const, label: era.name, range }] : [];
  });

  const chips: { id: YearChipId; label: string; range: { from: number; to: number } }[] = [
    ...(last10 ? [{ id: "last10" as const, label: t("mobile.filter_year_last10"), range: last10 }] : []),
    ...(last50 ? [{ id: "last50" as const, label: t("mobile.filter_year_last50"), range: last50 }] : []),
    ...eraChips,
  ];

  if (chips.length === 0) return null;

  const apply = (range: { from: number; to: number }) => {
    if (yearFrom === range.from && yearTo === range.to) {
      setYearRange(yearBounds.min, yearBounds.max);
    } else {
      setYearRange(range.from, range.to);
    }
  };

  return (
    <div className="mobile-filter-section">
      <div className="mobile-filter-section-label label-caps">{t("mobile.filter_year_label")}</div>
      <div className="mobile-filter-chips-row">
        {chips.map((c) => {
          const active = yearFrom === c.range.from && yearTo === c.range.to;
          return (
            <button
              key={c.id}
              type="button"
              className="mobile-filter-pill"
              data-active={active}
              data-testid={`mobile-filter-year-${c.id.replace(":", "-")}`}
              onClick={() => apply(c.range)}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
