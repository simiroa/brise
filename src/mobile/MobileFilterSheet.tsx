import { useEffect, useMemo, useState } from "react";
import { useSearchStore, type DateRangeKey } from "../stores/search";
import { useTaxonomyStore } from "../stores/taxonomy";
import { useNotesStore } from "../stores/notes";
import { resolveTagCounts, resolveAllTags } from "../lib/tagCounts";
import { BUILT_IN_STATUSES } from "../lib/status";
import { callSilent } from "../lib/invoke";
import { folderColorCss } from "../lib/ui";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { MobileYearChips } from "./MobileYearChips";

interface MobileFilterSheetProps {
  onClose: () => void;
}

const DATE_OPTIONS: { key: DateRangeKey; labelKey: string }[] = [
  { key: "last7", labelKey: "search.date_range_last7" },
  { key: "last30", labelKey: "search.date_range_last30" },
  { key: "thisYear", labelKey: "search.date_range_this_year" },
];

/**
 * Mobile mirror of the desktop advanced-filter axes (leftpanel/FilterModal.tsx: StatusFilter +
 * TagsExpandedCloud + DateRangeFilter, plus event-year chips in MobileYearChips) collapsed into
 * one sheet, per
 * docs/PLAN-2026-08-25-mobile-ui.md §3.5. Every tap writes straight to `useSearchStore` (same
 * live-filter-as-you-tap behaviour desktop's chips already have — there is no local draft/staged
 * state here), so the tree/expanded view behind the sheet updates immediately; "적용" is just a
 * close button, not a commit step.
 *
 * `TagsExpandedCloud` is NOT reused (workorder W3 §2) — its pan gesture is mousedown/mousemove
 * only. This renders the same tag data (`tagCounts`/`tagColors`) as a plain vertical checkbox
 * list instead. `tagMode` stays desktop's fixed "and" (stores/search.ts default) — no UI for it,
 * same as desktop.
 */
export function MobileFilterSheet({ onClose }: MobileFilterSheetProps) {
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const toggleStatusFilter = useSearchStore((s) => s.toggleStatusFilter);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const selectTag = useSearchStore((s) => s.selectTag);
  const dateRange = useSearchStore((s) => s.dateRange);
  const setDateRangeFilter = useSearchStore((s) => s.setDateRangeFilter);
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  const regions = useTaxonomyStore((s) => s.regions);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const setRegionFilter = useSearchStore((s) => s.setRegionFilter);
  const [tagSearch, setTagSearch] = useState("");

  const notesByFolder = useNotesStore((s) => s.notesByFolder);
  const serverTagCounts = useNotesStore((s) => s.tagCounts);
  const tagColors = useNotesStore((s) => s.tagColors);

  // Mobile never calls loadTree() (folder_list is forbidden on this path — W2's
  // stores/notesTree.ts branch), so hydrateTagMaps' tag_colors fetch (the only place that
  // populates tagColors) never runs here either. tag_counts/tag_colors are their own cheap,
  // non-folder_list commands (specs/commands: http:true, no LIMIT-less corpus scan) — fetch them
  // directly instead of routing through the tree-load path this component never takes.
  // refreshTagCounts() already exists as an exported store action for the counts half;
  // tagColors has no equivalent public setter, so it's written the same way MobileNoteTree.tsx's
  // loadFolders() already writes folders/inboxId — direct setState, not a new store action for a
  // single one-shot fetch this is the only caller of.
  useEffect(() => {
    void useNotesStore.getState().refreshTagCounts();
    void callSilent<{ colors: Record<string, number> }>("tag_colors")
      .then((r) => useNotesStore.setState({ tagColors: r.colors ?? {} }))
      .catch(() => {});
  }, []);

  const tagCounts = useMemo(() => resolveTagCounts(serverTagCounts, notesByFolder), [serverTagCounts, notesByFolder]);
  const tagNames = useMemo(() => resolveAllTags(serverTagCounts, notesByFolder), [serverTagCounts, notesByFolder]);
  // Same as desktop FilterModal's `filteredTags` (case-insensitive substring; selected tags are
  // not pinned — they show only while they match).
  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return tagNames;
    return tagNames.filter((tag) => tag.toLowerCase().includes(q));
  }, [tagNames, tagSearch]);

  // Same 6-axis composition MobileHome's own reset chip used to run inline (W2) — moved here
  // wholesale (not duplicated: MobileHome no longer has a copy) now that the chip's job is
  // "open the sheet", not "reset directly". No single store action does all six, per
  // stores/search.ts's own comment on this — SearchBox's desktop reset button composes the same
  // atomic setters.
  const clearAll = () => {
    const s = useSearchStore.getState();
    s.setQuery("");
    s.setYearRange(s.yearBounds.min, s.yearBounds.max);
    s.clearTagFilter();
    s.setRegionFilter(null);
    s.clearStatusFilter();
    s.setDateRangeFilter(null);
  };

  return (
    <MobileModal
      title={t("mobile.filter_open")}
      onClose={onClose}
      placement="bottom"
      footer={
        <>
          <button type="button" className="mobile-text-btn" onClick={clearAll} data-testid="mobile-filter-sheet-clear">
            {t("mobile.filter_reset_all")}
          </button>
          <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={onClose}>
            {t("common.apply")}
          </button>
        </>
      }
    >
      <div className="mobile-filter-section">
        <div className="mobile-filter-section-label label-caps">{t("mobile.filter_status_label")}</div>
        <div className="mobile-filter-chips-row">
          {BUILT_IN_STATUSES.map((def) => {
            const active = statusFilter.includes(def.key);
            return (
              <button
                key={def.key}
                type="button"
                className="mobile-filter-pill"
                data-active={active}
                data-testid={`mobile-filter-status-${def.key}`}
                onClick={() => toggleStatusFilter(def.key)}
              >
                <span className="mobile-filter-pill-dot" style={{ background: def.colorVar }} />
                {t(def.labelKey)}
              </button>
            );
          })}
          {customStatuses.map((s) => {
            const active = statusFilter.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className="mobile-filter-pill"
                data-active={active}
                onClick={() => toggleStatusFilter(s.id)}
              >
                <span className="mobile-filter-pill-dot" style={{ background: "var(--accent)" }} />
                {s.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mobile-filter-section">
        <div className="mobile-filter-section-label label-caps">{t("mobile.filter_tags_label")}</div>
        {tagNames.length === 0 ? (
          <div className="mobile-empty mobile-empty--hint">{t("mobile.filter_tags_empty")}</div>
        ) : (
          <>
          <input
            type="search"
            className="mobile-modal-input"
            value={tagSearch}
            onChange={(e) => setTagSearch(e.target.value)}
            placeholder={t("search.filter_tag_search")}
            data-testid="mobile-filter-tag-search"
          />
          <div className="mobile-filter-tag-list">
            {filteredTags.map((name) => {
              const hue = tagColors?.[name];
              const dotColor = hue !== undefined && hue !== null ? folderColorCss(hue) : "var(--muted)";
              const active = selectedTags.includes(name);
              return (
                <label key={name} className="mobile-filter-tag-row">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => selectTag(name, true)}
                    data-testid={`mobile-filter-tag-${name}`}
                  />
                  <span className="mobile-filter-pill-dot" style={{ background: dotColor }} />
                  <span className="mobile-filter-tag-name">{name}</span>
                  <span className="mobile-filter-tag-count">{tagCounts.get(name) ?? 0}</span>
                </label>
              );
            })}
          </div>
          </>
        )}
      </div>

      <div className="mobile-filter-section">
        <div className="mobile-filter-section-label label-caps">{t("search.mode_region")}</div>
        <div className="mobile-filter-chips-row">
          <button
            type="button"
            className="mobile-filter-pill"
            data-active={regionFilter === null}
            data-testid="mobile-filter-region-all"
            onClick={() => setRegionFilter(null)}
          >
            {t("search.gallery_kind_all")}
          </button>
          <button
            type="button"
            className="mobile-filter-pill"
            data-active={regionFilter?.kind === "none"}
            data-testid="mobile-filter-region-none"
            onClick={() => setRegionFilter(regionFilter?.kind === "none" ? null : { kind: "none" })}
          >
            {t("search.region_no_region")}
          </button>
          {regions.map((r) => {
            const active = regionFilter?.kind === "region" && regionFilter.name === r.name;
            return (
              <button
                key={r.id}
                type="button"
                className="mobile-filter-pill"
                data-active={active}
                data-testid={`mobile-filter-region-${r.name}`}
                onClick={() => setRegionFilter(active ? null : { kind: "region", name: r.name })}
              >
                {r.name}
              </button>
            );
          })}
        </div>
      </div>

      <MobileYearChips />

      <div className="mobile-filter-section">
        <div className="mobile-filter-section-label label-caps">{t("mobile.filter_period_label")}</div>
        <div className="mobile-filter-chips-row">
          {DATE_OPTIONS.map((opt) => {
            const active = dateRange === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                className="mobile-filter-pill"
                data-active={active}
                data-testid={`mobile-filter-date-${opt.key}`}
                onClick={() => setDateRangeFilter(active ? null : opt.key)}
              >
                {t(opt.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </MobileModal>
  );
}
