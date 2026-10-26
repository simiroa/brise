import { useMemo, useState, type CSSProperties } from "react";
import { useUiStore } from "../../stores/ui";
import { useSearchStore } from "../../stores/search";
import { useNotesStore } from "../../stores/notes";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { resolveAllTags, resolveTagCounts } from "../../lib/tagCounts";
import { ModalShell } from "../ModalShell";
import { StatusFilter } from "./yearfilter/StatusFilter";
import { DateRangeFilter } from "./yearfilter/DateRangeFilter";
import { TagsExpandedCloud } from "./expanded/TagsExpandedCloud";
import { chipStyle, draftInputStyle } from "./yearfilter/shared";
import { t } from "../../i18n/t";

const sectionStyle: CSSProperties = {
  padding: "var(--space-4) 0",
  borderBottom: "1px solid var(--line)",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "var(--text-label)",
  fontWeight: 600,
  color: "var(--muted)",
  marginBottom: "var(--space-2)",
};

/**
 * Advanced-filter editor — replaces the old FilterStrip (which crammed Status/Tags/Date into a
 * narrow sidebar strip). Edits useSearchStore directly, no draft/apply: closing the modal IS
 * committing. ActiveFilterChips (sidebar, below SearchBox) shows the resulting state.
 */
export function FilterModal() {
  const open = useUiStore((s) => s.filtersOpen);
  const close = useUiStore((s) => s.closeFilters);
  const notesByFolder = useNotesStore((s) => s.notesByFolder);
  const serverTagCounts = useNotesStore((s) => s.tagCounts);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const setRegionFilter = useSearchStore((s) => s.setRegionFilter);
  const regions = useTaxonomyStore((s) => s.regions);
  const resetAllFilters = useSearchStore((s) => s.resetAllFilters);

  const [tagSearch, setTagSearch] = useState("");

  const tagCounts = useMemo(
    () => resolveTagCounts(serverTagCounts, notesByFolder),
    [serverTagCounts, notesByFolder],
  );
  const allTags = useMemo(
    () => resolveAllTags(serverTagCounts, notesByFolder),
    [serverTagCounts, notesByFolder],
  );
  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((tag) => tag.toLowerCase().includes(q));
  }, [allTags, tagSearch]);

  if (!open) return null;

  return (
    <ModalShell
      title={t("search.filter_toggle")}
      onClose={close}
      width={520}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button type="button" className="btn" onClick={resetAllFilters}>
            {t("search.filter_reset")}
          </button>
          <button type="button" className="btn" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      }
    >
      <div style={{ ...sectionStyle, paddingTop: 0 }}>
        <div style={sectionTitleStyle}>{t("search.filter_section_status")}</div>
        <StatusFilter />
      </div>

      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>{t("search.mode_tags")}</div>
        <input
          value={tagSearch}
          onChange={(e) => setTagSearch(e.target.value)}
          placeholder={t("search.filter_tag_search")}
          style={{ ...draftInputStyle, width: "100%", marginBottom: "var(--space-2)" }}
        />
        <TagsExpandedCloud tags={filteredTags} tagCounts={tagCounts} />
      </div>

      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>{t("search.mode_region")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
          <button
            type="button"
            style={chipStyle(regionFilter === null)}
            onClick={() => setRegionFilter(null)}
          >
            {t("search.gallery_kind_all")}
          </button>
          <button
            type="button"
            style={chipStyle(regionFilter?.kind === "none")}
            onClick={() => setRegionFilter(regionFilter?.kind === "none" ? null : { kind: "none" })}
          >
            {t("search.region_no_region")}
          </button>
          {regions.map((r) => {
            const active = regionFilter?.kind === "region" && regionFilter.name === r.name;
            return (
              <button
                type="button"
                key={r.id}
                style={chipStyle(active)}
                onClick={() => setRegionFilter(active ? null : { kind: "region", name: r.name })}
              >
                {r.name}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ ...sectionStyle, borderBottom: "none", paddingBottom: 0 }}>
        <div style={sectionTitleStyle}>{t("search.filter_section_date")}</div>
        <DateRangeFilter />
      </div>
    </ModalShell>
  );
}
