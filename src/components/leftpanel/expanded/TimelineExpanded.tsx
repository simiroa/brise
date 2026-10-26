import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { List, type ListImperativeAPI } from "react-window";
import { useNotesStore } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { call } from "../../../lib/invoke";
import { useUiStore } from "../../../stores/ui";
import { IconPlus } from "../../icons";
import { EXPANDED_BOARD_MAX_NOTES, noteQueryCollect, useNoteQueryVersion } from "../../../lib/noteQuery";
import type { NoteSummary } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import {
  flattenTimelineRows,
  timelineRowHeightOf,
  collectTimelineHitRowIndices,
  bucketSearchHitTicks,
  SEARCH_HIT_TICK_BUCKETS,
  type TimelineRow,
} from "./timelineRows";
import { TimelineExpandedRow, type TimelineExpandedRowProps } from "./TimelineExpandedRow";

import { usePendingDelay } from "../../../lib/usePendingDelay";
import { PendingIndicator } from "../../common/PendingIndicator";
import { ContextMenuShell } from "../../common/ContextMenuShell";

/* ── Timeline expanded view (크게 보기 수직 타임라인) ──
   Wave A-4: notes only from note_query. Flatten still client-side for year headers.
   Histogram is note_year_histogram — never derived by pulling every note.
   Owner QA7: 연/월/일 세그먼트 제거 및 '일' 단위 뷰로 통일 (연/월 헤더 아코디언 접기 지원). */
export function TimelineExpanded() {
  const selectNote = useNotesStore((s) => s.selectNote);
  const openCtx = useUiStore((s) => s.openCtx);
  const loadTree = useNotesStore((s) => s.loadTree);
  const inboxId = useNotesStore((s) => s.inboxId);

  const activeId = useNotesStore((s) => s.activeNote?.note.id ?? null);

  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);

  const [headerCtxOpen, setHeaderCtxOpen] = useState<{
    year: number;
    month: number | null;
    day: number | null;
    x: number;
    y: number;
  } | null>(null);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const query = useSearchStore((s) => s.query);
  // Server FTS hits (title+body). Same store the dashboard brush reads — no extra IPC.
  // Cap: search_notes returns ≤500 (stores/search.ts); ticks under-mark past that.
  const searchResults = useSearchStore((s) => s.searchResults);
  const noteQueryVersion = useNoteQueryVersion();

  const [serverNotes, setServerNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const showPending = usePendingDelay(loading, 150);

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
            sort: "year_asc",
          },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES }
        );
        if (!cancelled) setServerNotes(r.notes);
      } catch {
        if (!cancelled) setServerNotes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, noteQueryVersion]);

  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const onToggleCollapse = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rows: TimelineRow[] = useMemo(() => {
    if (serverNotes.length === 0) return [{ type: "empty" }];
    return flattenTimelineRows({
      sortedNotes: serverNotes,
      yearFrom,
      yearTo,
      // 월 단위로 헤더 깊이를 제한 — 일 단위 분할은 대부분 노트 1~3개짜리 버킷을 양산해
      // 정보 밀도가 낮았다. 노트의 day 정밀도는 보존되지만 헤더는 연/월 두 단계만 그린다.
      zoomLevel: "month",
      collapsedKeys,
    });
  }, [serverNotes, yearFrom, yearTo, collapsedKeys]);

  const listWrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<ListImperativeAPI | null>(null);
  const [listHeight, setListHeight] = useState(240);

  // Drag-to-pan: vertical drag is how the list scrolls instead. Writes
  // scrollTop directly on react-window's own scroll element (List.element).
  const dragStartRef = useRef<{ clientY: number; scrollTop: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const hasMovedRef = useRef(false);

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      const el = listRef.current?.element;
      if (!start || !el) return;
      const dy = e.clientY - start.clientY;
      // Small-move threshold (matches useMapPanZoom's 3px) — below this, a click's natural hand
      // tremor must not be mistaken for a pan (which would suppress the note row's onClick below).
      if (Math.abs(dy) > 3) hasMovedRef.current = true;
      // Drag down (positive dy) reveals earlier content, i.e. scrollTop decreases — the same
      // direction convention as touch-dragging a phone list.
      el.scrollTop = start.scrollTop - dy;
    };
    const onUp = () => {
      dragStartRef.current = null;
      setIsPanning(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const handlePanMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = listRef.current?.element;
    if (!el) return;
    hasMovedRef.current = false;
    dragStartRef.current = { clientY: e.clientY, scrollTop: el.scrollTop };
    setIsPanning(true);
  }, []);

  useEffect(() => {
    const el = listWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setListHeight(Math.floor(h));
    });
    ro.observe(el);
    setListHeight(Math.floor(el.clientHeight) || 240);
    return () => ro.disconnect();
  }, []);

  const getRowHeight = useCallback(
    (index: number) => timelineRowHeightOf(rows[index]!),
    [rows]
  );

  // Header fade-in (§2.3 follow-up): keying header rows by zoomLevel forces React to remount
  // (not patch) their DOM node whenever the zoom level changes, which is what makes the CSS
  // animation on TimelineExpandedRow's header replay — plain re-renders with an unchanged style
  // string don't restart a running/finished CSS animation. Note rows keep the default index key
  // (no remount, no fade) since only "newly-appearing" headers should announce themselves.
  const rowKey = useCallback(
    (index: number) => {
      const row = rows[index];
      return row && row.type === "header" ? `h-${index}` : index;
    },
    [rows]
  );

  const onSelectNote = useCallback(
    (id: string) => {
      // A drag-to-pan gesture ends with a mouseup on whatever note row happened to be under the
      // cursor, which the browser still follows with a click — reading hasMovedRef.current here
      // (not a snapshotted prop) is what tells a real click apart from a drag's trailing click.
      if (hasMovedRef.current) return;
      void selectNote(id);
    },
    [selectNote]
  );

  const onOpenCtx = useCallback(
    (id: string, x: number, y: number) => {
      openCtx(id, x, y);
    },
    [openCtx]
  );

  const onHeaderContextMenu = useCallback(
    (year: number, month: number | null, day: number | null, x: number, y: number) => {
      setHeaderCtxOpen({ year, month, day, x, y });
    },
    []
  );

  const rowProps: TimelineExpandedRowProps = useMemo(
    () => ({
      rows,
      activeId,
      query,
      onSelectNote,
      onOpenCtx,
      onHeaderContextMenu,
      onToggleCollapse,
      loadTree,
      selectNote,
    }),
    [rows, activeId, query, onSelectNote, onOpenCtx, onHeaderContextMenu, onToggleCollapse, loadTree, selectNote]
  );

  // Search-hit ticks: server FTS ids × flattened `rows`, bucketed so DOM stays bounded.
  // Same result set as the dashboard brush (useSearchStore.searchResults) — not title substring.
  const q = query.trim();
  const hitIdSet = useMemo(() => {
    if (!q) return null as Set<string> | null;
    return new Set(searchResults.map((n) => n.id));
  }, [q, searchResults]);
  const hitTicks = useMemo(() => {
    if (!hitIdSet || hitIdSet.size === 0) return [];
    const hits = collectTimelineHitRowIndices(rows, hitIdSet);
    return bucketSearchHitTicks(hits, rows.length, SEARCH_HIT_TICK_BUCKETS);
  }, [rows, hitIdSet]);

  const scrollToHit = useCallback((rowIndex: number) => {
    listRef.current?.scrollToRow({ index: rowIndex, align: "smart" });
  }, []);

  const activateHitTick = useCallback(
    (rowIndex: number, unique: boolean) => {
      scrollToHit(rowIndex);
      // When the bucket uniquely identifies one note, also select it (2-step flow otherwise:
      // jump first, open from the list row).
      if (!unique) return;
      const row = rows[rowIndex];
      if (row?.type === "note") void selectNote(row.note.id);
    },
    [scrollToHit, rows, selectNote],
  );

  // Roving tabindex inside the hit-rail group: one tab stop for the whole strip, arrows move
  // between ticks so a dense result set doesn't dump ≤128 tab stops into the page order.
  const [hitFocusIdx, setHitFocusIdx] = useState(0);
  useEffect(() => {
    setHitFocusIdx((i) => (hitTicks.length === 0 ? 0 : Math.min(i, hitTicks.length - 1)));
  }, [hitTicks.length]);
  const hitTickBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onHitRailKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (hitTicks.length === 0) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      setHitFocusIdx((prev) => {
        let next = prev;
        if (e.key === "ArrowDown") next = Math.min(hitTicks.length - 1, prev + 1);
        else if (e.key === "ArrowUp") next = Math.max(0, prev - 1);
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = hitTicks.length - 1;
        queueMicrotask(() => hitTickBtnRefs.current[next]?.focus());
        return next;
      });
    },
    [hitTicks.length],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "var(--space-2) 0 var(--space-5) var(--sidebar-pad)",
      }}
    >
      {/* 오너 QA7 후속: "크게보기" 버튼은 TimelineFilter 의 범위 라벨 줄(슬라이더 위)로 옮겼다.
          여기 있던 전용 헤더 행이 통째로 사라지면서 슬라이더와 리스트 사이 빈 띠도 없어진다. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
          gap: hitTicks.length > 0 ? "var(--space-1)" : 0,
        }}
      >
        <div
          ref={listWrapRef}
          data-testid="timeline-list-wrap"
          onMouseDown={handlePanMouseDown}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            position: "relative",
            cursor: isPanning ? "grabbing" : "grab",
          }}
        >
          <PendingIndicator active={showPending} />
          {rows.length > 0 && rows[0].type !== "empty" && (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                // 연/월 dot이 매달리는 타임라인 spine. 타임라인 시작~끝까지 끊김 없이 이어진다.
                // left:15 + width:2 + box-sizing:border-box → 중심 16 (헤더 dot과 정확 정렬).
                left: 15,
                width: 2,
                boxSizing: "border-box",
                background: "var(--line)",
                opacity: 0.6,
                zIndex: 0,
                pointerEvents: "none",
              }}
            />
          )}
          <List
            id="brise-search-results"
            className="scroll scroll--slim"
            listRef={listRef}
            rowComponent={TimelineExpandedRow}
            rowCount={rows.length}
            rowHeight={getRowHeight}
            rowKey={rowKey}
            rowProps={rowProps}
            overscanCount={8}
            style={{ height: listHeight, width: "100%", position: "relative", zIndex: 1 }}
          />
        </div>
        {hitTicks.length > 0 && (
          // One keyboard group for the whole rail (roving tabindex) so ≤128 ticks don't each
          // become a tab stop. Click/Enter: scroll to the first hit in the bucket; if that
          // bucket uniquely identifies one note, also select it.
          <div
            role="group"
            aria-label={t("search.timeline_search_hits")}
            title={t("search.timeline_search_hits")}
            data-testid="timeline-hit-strip"
            onKeyDown={onHitRailKeyDown}
            style={{
              width: 6,
              flexShrink: 0,
              position: "relative",
              alignSelf: "stretch",
              background: "var(--line)",
              opacity: 0.45,
              borderRadius: 2,
            }}
          >
            {hitTicks.map((tick, i) => (
              <button
                key={tick.bucket}
                ref={(el) => {
                  hitTickBtnRefs.current[i] = el;
                }}
                type="button"
                tabIndex={i === hitFocusIdx ? 0 : -1}
                aria-label={t("search.timeline_search_hit_goto")}
                title={t("search.timeline_search_hit_goto")}
                data-testid="timeline-hit-tick"
                data-row-index={tick.rowIndex}
                data-unique={tick.unique ? "true" : undefined}
                onFocus={() => setHitFocusIdx(i)}
                onClick={() => activateHitTick(tick.rowIndex, tick.unique)}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  // Center the 2px mark in its bucket slot.
                  top: `${((tick.bucket + 0.5) / SEARCH_HIT_TICK_BUCKETS) * 100}%`,
                  height: 2,
                  margin: 0,
                  padding: 0,
                  border: "none",
                  borderRadius: 1,
                  background: "var(--search-hit)",
                  transform: "translateY(-50%)",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        )}
      </div>

      {headerCtxOpen && (
        <ContextMenuShell anchor={headerCtxOpen} onClose={() => setHeaderCtxOpen(null)} minWidth={160}>
          <button
              type="button"
              className="menu-row menu-item"
              onClick={async () => {
                const { year, month, day } = headerCtxOpen;
                setHeaderCtxOpen(null);
                // Dashboard convention (TimelineTab.tsx createNoteInRange): no selectNote after
                // create — jumping into the editor breaks the "create several in a row" flow.
                // loadTree() bumps noteQueryVersion (stores/notes.ts), which re-triggers this
                // view's note_query effect above, so the new row just appears in place.
                await call<{ note: NoteSummary }>("note_create", {
                  folder_id: inboxId ?? undefined,
                  year,
                  month,
                  day,
                });
                await loadTree();
              }}
              style={{ color: "inherit", margin: 0, padding: "var(--space-1) var(--space-2)" }}
            >
              <IconPlus size={15} strokeWidth={1.8} style={{ marginRight: 8 }} />
              <span>{t("search.add_note_on_date")}</span>
            </button>
        </ContextMenuShell>
      )}
    </div>
  );
}
