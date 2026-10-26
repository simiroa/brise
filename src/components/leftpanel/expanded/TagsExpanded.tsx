import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List } from "react-window";
import { useNotesStore } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import type { NoteSummary } from "../../../lib/commands.gen";
import { IconClose } from "../../icons";
import { t } from "../../../i18n/t";
import {
  EXPANDED_BOARD_MAX_NOTES,
  hydrateTagNames,
  noteQueryCollect,
  useNoteQueryVersion,
} from "../../../lib/noteQuery";
import { resolveAllTags, resolveTagCounts } from "../../../lib/tagCounts";
import { usePendingDelay } from "../../../lib/usePendingDelay";
import { PendingIndicator } from "../../common/PendingIndicator";
import { Pill } from "../../common/Pill";
import { FilterHeaderRow } from "../yearfilter/shared";
import { useUiStore } from "../../../stores/ui";
import { TagsExpandedCloud } from "./TagsExpandedCloud";
import {
  TAGS_RESULT_ROW_HEIGHT,
  TagsExpandedNoteRow,
  type TagsExpandedNoteRowProps,
} from "./TagsExpandedNoteRow";

/**
 * Tags expanded data hook — note_query window + full-corpus tag cloud sources.
 * Exported for render-settle tests (assertHookSettles).
 */
export function useTagsExpandedData() {
  const notesByFolder = useNotesStore((s) => s.notesByFolder);
  const serverTagCounts = useNotesStore((s) => s.tagCounts);

  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const noteQueryVersion = useNoteQueryVersion();

  const [filteredNotes, setFilteredNotes] = useState<NoteSummary[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await noteQueryCollect(
          {
            yearFrom,
            yearTo,
            selectedTags,
            tagMode,
            regionFilter,
            statusFilter,
            dateRange,
            sort: "title_asc",
          },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES },
        );
        const withTags = await hydrateTagNames(r.notes);
        if (!cancelled) {
          setFilteredNotes(withTags);
          setResultTotal(r.total);
        }
      } catch {
        if (!cancelled) {
          setFilteredNotes([]);
          setResultTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, noteQueryVersion]);

  const tagCounts = useMemo(
    () => resolveTagCounts(serverTagCounts, notesByFolder),
    [serverTagCounts, notesByFolder],
  );

  const cloudTags = useMemo(
    () => resolveAllTags(serverTagCounts, notesByFolder),
    [serverTagCounts, notesByFolder],
  );

  return {
    filteredNotes,
    resultTotal,
    loading,
    tagCounts,
    cloudTags,
    selectedTags,
    tagMode,
  };
}

/* ── Tags expanded view ──
   Sensing surface (full tag cloud) on top; flat result list below.
   Each note appears once — no per-tag section grouping.
   Selection is click-to-replace / Ctrl-click-to-add with tag_mode pinned to "and"
   (see stores/search.ts) — there is no OR/AND control to render. */
export function TagsExpanded() {
  const {
    filteredNotes,
    resultTotal,
    loading,
    tagCounts,
    cloudTags,
    selectedTags,
  } = useTagsExpandedData();

  const clearTagFilter = useSearchStore((s) => s.clearTagFilter);
  const query = useSearchStore((s) => s.query);
  const selectNote = useNotesStore((s) => s.selectNote);
  const openCtx = useUiStore((s) => s.openCtx);
  const activeId = useNotesStore((s) => s.activeNote?.note.id ?? null);

  const showPending = usePendingDelay(loading, 150);

  const listWrapRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(160);

  useEffect(() => {
    const el = listWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setListHeight(Math.floor(h));
    });
    ro.observe(el);
    setListHeight(Math.floor(el.clientHeight) || 160);
    return () => ro.disconnect();
  }, []);

  const onSelectNote = useCallback(
    (id: string) => {
      void selectNote(id);
    },
    [selectNote],
  );

  const onOpenCtx = useCallback(
    (id: string, x: number, y: number) => {
      openCtx(id, x, y);
    },
    [openCtx],
  );

  const rowProps: TagsExpandedNoteRowProps = useMemo(
    () => ({
      notes: filteredNotes,
      activeId,
      query,
      onSelectNote,
      onOpenCtx,
    }),
    [filteredNotes, activeId, query, onSelectNote, onOpenCtx],
  );

  const nSelected = selectedTags.length;
  // With the OR/AND control gone, this line is the only place the policy is stated —
  // at two tags it says what the intersection means, and at one tag it teaches the
  // modifier that would otherwise be undiscoverable.
  const modeHint =
    nSelected >= 2
      ? t("search.tag_mode_and_hint", { n: nSelected })
      : nSelected === 1
        ? t("search.tag_add_hint")
        : null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      <PendingIndicator active={showPending} />

      {/* ── Top: cloud (capped so results keep room) ──
          max-height 42% of panel: cloud is the sensing surface but must not
          starve the list at 180px width / 135% font scale. min-height keeps
          a few chip rows readable when the panel is short. */}
      <div
        style={{
          flex: "0 1 auto",
          maxHeight: "42%",
          minHeight: 96,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          borderBottom: "1px solid var(--divider)",
          padding: "var(--space-2) var(--sidebar-pad) var(--space-2)",
          gap: "var(--space-2)",
        }}
      >

        <FilterHeaderRow>
          <span
            style={{
              fontSize: "var(--text-label)",
              color: nSelected > 0 ? "var(--accent)" : "var(--muted)",
              fontWeight: 600,
              minWidth: 0,
            }}
            data-testid="tag-mode-status"
          >
            {nSelected > 0 ? `${nSelected}` : t("search.mode_tags")}
            {modeHint ? ` — ${modeHint}` : ""}
          </span>
          {nSelected > 0 && (
            <button
              type="button"
              onClick={clearTagFilter}
              className="icon-btn icon-btn--sm"
              title={t("search.tags_clear")}
              aria-label={t("search.tags_clear")}
            >
              <IconClose size={12} strokeWidth={2.2} />
            </button>
          )}
        </FilterHeaderRow>

        <TagsExpandedCloud tags={cloudTags} tagCounts={tagCounts} />
      </div>

      {/* ── Bottom: flat results (one row per note) ── */}
      <div
        style={{
          flex: "1 1 0",
          minHeight: 120,
          display: "flex",
          flexDirection: "column",
          padding: "var(--space-2) 0 var(--space-5) var(--sidebar-pad)",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--space-1)",
            paddingRight: "var(--sidebar-pad)",
          }}
          data-testid="tags-result-count"
        >
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              textTransform: "uppercase",
            }}
          >
            {t("search.mode_tags")}
          </span>
          <Pill tone="muted">{loading ? "…" : resultTotal}</Pill>
        </div>
        <div ref={listWrapRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {filteredNotes.length === 0 && !loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--faint)",
                fontSize: "var(--text-sm)",
                textAlign: "center",
                padding: "var(--space-6) 0",
                paddingRight: "var(--sidebar-pad)",
              }}
            >
              {/* filteredNotes has no "has tags" constraint — with 0 tags selected this is
                  just "no notes match the other filters", so only claim a tag-specific
                  reason when a tag filter is actually driving the query. */}
              {nSelected > 0 ? t("search.tags_empty") : t("search.expanded_empty")}
            </div>
          ) : (
            <List
              className="scroll scroll--slim"
              rowComponent={TagsExpandedNoteRow}
              rowCount={filteredNotes.length}
              rowHeight={TAGS_RESULT_ROW_HEIGHT}
              rowProps={rowProps}
              overscanCount={8}
              style={{ height: listHeight, width: "100%" }}
              data-testid="tags-result-list"
            />
          )}
        </div>
      </div>
    </div>
  );
}
