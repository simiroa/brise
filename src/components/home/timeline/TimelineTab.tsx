/**
 * Home → Timeline tab (docs/DASHBOARD.md §3.4).
 *
 * Pure SVG/DOM — no D3/chart libs. Data: dashboard_timeline (W3).
 * - Static: points, bars, era bands, axis ticks (TimelineTimeRuler / ItemsLayer.tsx).
 *   Single canvas row; folders are distinguished by paint color (`folderColor`).
 * - Zoom/pan: header minimap brush (Brush.tsx) + right-drag 2D pan (h=view, v=scroll) +
 *   Alt/middle body pan + wheel zoom + scale presets in TimelineHeaderBar.
 * - Empty-area drag → gantt ghost → note_create (inbox); bar-edge drag → resize;
 *   item-body drag → move; right-click → move-to-folder menu (useTimelineDrag.ts).
 * - Item click: single-click focuses; double-click opens note tab.
 * - Virtualization: items outside the view year-window are not mounted.
 * - Capped mode: items empty + year_buckets density marks + banner.
 *
 * Decomposed into:
 * - TimelineHeaderBar.tsx (range control, scale presets, today jump, minimap brush, fit button, eras)
 * - TimelineTimeRuler.tsx (top timeline tick marks, date labels, hover guide)
 * - ItemsLayer.tsx (canvas items, gridlines, eras, histogram buckets, drag ghost)
 * - Brush.tsx (overview minimap track & brush window)
 * - useTimelineDrag.ts (gesture machine)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { call } from "../../../lib/invoke";
import type { Folder, NoteDetail, TimelineResult } from "../../../lib/commands.gen";
import { replacePrimaryDate } from "../../../lib/primaryDate";
import { useSettingsStore } from "../../../stores/settings";
import { useSearchStore } from "../../../stores/search";
import { useNotesStore } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import { useElementSize } from "../../../lib/useElementSize";
import { clamp, folderColorCss } from "../../../lib/ui";
import { t } from "../../../i18n/t";
import { moveNote } from "../../../lib/noteActions";
import { PromptDialog } from "../../PromptDialog";
import { CreatePopover } from "../CreatePopover";
import {
  bucketSearchHitTicks,
  hitTickBucketYearRange,
  SEARCH_HIT_TICK_BUCKETS,
} from "../../leftpanel/expanded/timelineRows";
import { useDashboardSearchHits } from "../useDashboardSearchHits";
import { useDashboardReveal } from "../useDashboardReveal";
import type { BrushHitTick } from "./Brush";
import { TimelineTimeRuler, HoverGuide } from "./TimelineTimeRuler";
import { TimelineHeaderBar } from "./TimelineHeaderBar";
import { ItemsLayer, type YearBucket } from "./ItemsLayer";
import { useTimelineDrag } from "./useTimelineDrag";
import {
  assignItemLanes,
  bucketByStep,
  isTimelineDense,
  clampView,
  defaultTimelineView,
  deriveFullRange,
  endDateBeforeBoundary,
  fitViewToItems,
  fractionalYearToDate,
  isYearFilterNarrowed,
  itemIntersectsView,
  itemTimeRange,
  laneGeometry,
  minorTickStepForView,
  nearestTick,
  resolveTimelineView,
  shiftTriple,
  shouldShowLabels,
  startDateAtBoundary,
  tickStepForView,
  tripleToFraction,
  xToYear,
  yearTicks,
  yearToX,
  type DateTriple,
  type PackedItem,
  type SnapUnit,
  type YearRange,
} from "./layout";
import { formatTimelineTick } from "../dateFmt";

const EMPTY_FALLBACK: YearRange = (() => {
  const y = new Date().getFullYear();
  return { from: y - 100, to: y };
})();

/** What "fit" frames: real item spans when uncapped, the year histogram when capped. */
function fitRanges(
  r: TimelineResult | null,
  folderFilter: string | null,
): { startYear: number; endYear: number }[] {
  if (!r) return [];
  if (r.capped) {
    return r.year_buckets
      .filter((b) => !folderFilter || b.folder_id === folderFilter)
      .map((b) => ({ startYear: b.year, endYear: b.year + 1 }));
  }
  return r.items
    .filter((it) => !folderFilter || it.folder_id === folderFilter)
    .map((it) => {
      const range = itemTimeRange(it);
      return { startYear: range.start, endYear: range.end };
    });
}

function fmtBoundary(frac: number, step: number, uiLang: string): string {
  return formatTimelineTick(frac, step, uiLang, fractionalYearToDate(frac));
}

const tripleFraction = tripleToFraction;

export function TimelineTab() {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const selectNote = useNotesStore((s) => s.selectNote);
  const loadTree = useNotesStore((s) => s.loadTree);
  const ensureInboxId = useNotesStore((s) => s.ensureInboxId);
  const inboxId = useNotesStore((s) => s.inboxId);
  const folders = useNotesStore((s) => s.folders);
  const dashboardFolderFilter = useUiStore((s) => s.dashboardFolderFilter);

  const [result, setResult] = useState<TimelineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullRange, setFullRange] = useState<YearRange>(EMPTY_FALLBACK);
  const [view, setView] = useState<YearRange>(() => {
    const period = useSearchStore.getState();
    if (isYearFilterNarrowed(period.yearFrom, period.yearTo, period.yearBounds)) {
      return { from: period.yearFrom, to: period.yearTo };
    }
    return defaultTimelineView();
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fullRef = useRef(fullRange);
  fullRef.current = fullRange;

  const canvasRef = useRef<HTMLDivElement>(null);
  const brushTrackRef = useRef<HTMLDivElement>(null);

  const { width: canvasW } = useElementSize(canvasRef, {
    width: 800,
    height: 400,
  });
  const { width: brushW } = useElementSize(brushTrackRef, { width: 800, height: 46 });

  const [creating, setCreating] = useState(false);
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const fetchFrom = yearBounds.min - 50;
  const fetchTo = yearBounds.max + 50;

  const openNote = useCallback(
    (noteId: string) => {
      void selectNote(noteId);
    },
    [selectNote],
  );

  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);

  const applyView = useCallback((from: number, to: number) => {
    const next = clampView(from, to, fullRef.current.from, fullRef.current.to);
    setView(next);
  }, []);

  useDashboardReveal("timeline", (noteId: string) => {
    const summary = useNotesStore.getState().noteIndex.get(noteId);
    let startFraction: number | null = null;

    if (summary) {
      startFraction = tripleToFraction({
        year: summary.year,
        month: summary.month ?? null,
        day: summary.day ?? null,
      });
    } else {
      const it = result?.items.find((i) => i.note_id === noteId);
      if (it) {
        startFraction = tripleToFraction({
          year: it.year,
          month: it.month ?? null,
          day: it.day ?? null,
        });
      }
    }

    if (startFraction != null) {
      const span = Math.max(1, viewRef.current.to - viewRef.current.from);
      const half = span / 2;
      applyView(startFraction - half, startFraction + half);
    }
    setFocusedNoteId(noteId);
  });

  // Filtered raw items memoized so lane packing re-runs only when span/width/filter change
  const filteredItems = useMemo(() => {
    if (!result || result.capped) return [];
    if (!dashboardFolderFilter) return result.items;
    return result.items.filter((it) => it.folder_id === dashboardFolderFilter);
  }, [result, dashboardFolderFilter]);

  const viewSpan = view.to - view.from;
  const packed: PackedItem[] = useMemo(
    () =>
      result && !result.capped
        ? assignItemLanes(filteredItems, { from: 0, to: viewSpan }, canvasW)
        : [],
    [result, filteredItems, viewSpan, canvasW],
  );

  const geo = useMemo(() => laneGeometry(packed), [packed]);

  const folderColor = useCallback(
    (folderId: string): string => {
      const folder = folders.find((f) => f.id === folderId);
      return folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--accent)";
    },
    [folders],
  );

  const stepRef = useRef(1);

  // PLAN-2026-09-08-dates-rebuild.md W4: note_update/note_set_event_precision/note_set_event_end
  // were the three commands timelineOps.ts::planTimelineDateOps sequenced carefully to avoid a
  // transient start>end validation failure (the backend checked each single-field write against
  // whatever was already stored). note_set_event_precision/note_set_event_end no longer exist,
  // and replacePrimaryDate (lib/primaryDate.ts) writes the whole row's final target values in one
  // shot — there's no intermediate state to order around any more, so the ordering module is gone
  // (deleted alongside its test, see report).
  const commitResize = useCallback(
    async (noteId: string, edge: "from" | "to", from: number, to: number) => {
      const it = result?.items.find((i) => i.note_id === noteId);
      if (!it) return;
      const step = stepRef.current;

      if (edge === "from") {
        const next = startDateAtBoundary(from, step);
        await replacePrimaryDate(noteId, { year: next.year, month: next.month, day: next.day });
      } else {
        const nextEnd = to > from ? endDateBeforeBoundary(to, step) : null;
        await replacePrimaryDate(noteId, {
          end_year: nextEnd?.year ?? null,
          end_month: nextEnd?.month ?? null,
          end_day: nextEnd?.day ?? null,
        });
      }
      await loadTree();
      reload();
    },
    [result, loadTree, reload],
  );

  const commitMove = useCallback(
    async (noteId: string, unit: SnapUnit, deltaUnits: number) => {
      const it = result?.items.find((i) => i.note_id === noteId);
      if (!it || deltaUnits === 0) return;
      const currentStart: DateTriple = { year: it.year, month: it.month, day: it.day };
      const currentEnd: DateTriple | null =
        it.end_year != null
          ? { year: it.end_year, month: it.end_month, day: it.end_day }
          : null;

      const nextStart = shiftTriple(currentStart, unit, deltaUnits);
      const nextEnd = currentEnd ? shiftTriple(currentEnd, unit, deltaUnits) : null;

      await replacePrimaryDate(noteId, {
        year: nextStart.year,
        month: nextStart.month,
        day: nextStart.day,
        ...(currentEnd
          ? { end_year: nextEnd!.year, end_month: nextEnd!.month, end_day: nextEnd!.day }
          : {}),
      });
      await loadTree();
      reload();
    },
    [result, loadTree, reload],
  );

  const [moveMenuNoteId, setMoveMenuNoteId] = useState<string | null>(null);
  const moveMenuCurrentFolderId = useMemo(
    () => result?.items.find((it) => it.note_id === moveMenuNoteId)?.folder_id ?? null,
    [result, moveMenuNoteId],
  );

  const moveMenuChoices = useMemo(
    () =>
      folders
        .filter((f: Folder) => f.id !== inboxId && f.id !== moveMenuCurrentFolderId)
        .map((f: Folder) => ({
          value: f.id,
          label: f.name,
          icon: (
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: folderColor(f.id),
                flex: "none",
              }}
            />
          ),
        })),
    [folders, inboxId, moveMenuCurrentFolderId, folderColor],
  );

  const runMoveToFolder = useCallback(
    (folderId: string) => {
      const noteId = moveMenuNoteId;
      setMoveMenuNoteId(null);
      if (!noteId) return;
      void (async () => {
        await moveNote(noteId, folderId);
        reload();
      })();
    },
    [moveMenuNoteId, reload],
  );

  const { ghost, setGhost, resize, move, createPop, setCreatePop } = useTimelineDrag({
    canvasRef,
    viewRef,
    fullRef,
    stepRef,
    capped: result?.capped,
    applyView,
    setView,
    onCommitResize: (noteId, edge, from, to) => void commitResize(noteId, edge, from, to),
    onCommitMove: (noteId, unit, deltaUnits) => void commitMove(noteId, unit, deltaUnits),
    onItemContextMenu: (noteId) => setMoveMenuNoteId(noteId),
  });

  const [createTitle, setCreateTitle] = useState("");
  const createTitleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!createPop) return;
    setCreateTitle("");
    const id = requestAnimationFrame(() => createTitleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [createPop]);

  const createPopFolderLabel = t("tree.inbox");

  const createNoteInRange = useCallback(
    async (from: number, to: number) => {
      setCreating(true);
      try {
        const step = stepRef.current;
        const start = startDateAtBoundary(from, step);
        const end = to > from ? endDateBeforeBoundary(to, step) : null;
        const folderId = inboxId ?? (await ensureInboxId());
        const title = createTitle.trim() || undefined;
        const detail = await call<NoteDetail>("note_create", {
          folder_id: folderId,
          title,
          year: start.year,
          month: start.month,
          day: start.day,
        });
        if (end) {
          // note_set_event_end was deleted — replacePrimaryDate is the id-free replacement (note
          // was just created above, so this is safe/cheap).
          await replacePrimaryDate(detail.note.id, {
            end_year: end.year,
            end_month: end.month,
            end_day: end.day,
          });
        }
        await loadTree();
        setCreatePop(null);
        setGhost(null);
        reload();
      } finally {
        setCreating(false);
      }
    },
    [createTitle, ensureInboxId, inboxId, loadTree, reload, setCreatePop, setGhost],
  );

  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r = await call<TimelineResult>("dashboard_timeline", {
          workspace_id: workspaceId,
          from_year: fetchFrom,
          to_year: fetchTo,
        });
        if (cancelled) return;
        setResult(r);
        const full = deriveFullRange(
          r.items,
          r.year_buckets,
          r.eras,
          { from: yearBounds.min, to: yearBounds.max },
          r.from_year,
          r.to_year,
        );
        setFullRange(full);
        if (seededForRef.current !== workspaceId) {
          seededForRef.current = workspaceId;
          const fit = fitViewToItems(fitRanges(r, useUiStore.getState().dashboardFolderFilter), full);
          setView(resolveTimelineView(useSearchStore.getState(), full, undefined, fit));
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, fetchFrom, fetchTo, yearBounds.min, yearBounds.max, reloadKey]);

  const periodFrom = useSearchStore((s) => s.yearFrom);
  const periodTo = useSearchStore((s) => s.yearTo);
  const prevPeriodRef = useRef({ from: periodFrom, to: periodTo });
  useEffect(() => {
    const prev = prevPeriodRef.current;
    prevPeriodRef.current = { from: periodFrom, to: periodTo };
    if (prev.from === periodFrom && prev.to === periodTo) return;
    const bounds = useSearchStore.getState().yearBounds;
    if (!isYearFilterNarrowed(periodFrom, periodTo, bounds)) return;
    applyView(periodFrom, periodTo);
  }, [periodFrom, periodTo, applyView]);

  const minContentH = geo.totalHeight;
  const showLabels = shouldShowLabels(view.from, view.to, canvasW);
  const isZoomed = view.from > fullRange.from || view.to < fullRange.to;

  const tickStep = useMemo(() => {
    const raw = tickStepForView(view.from, view.to, canvasW);
    return result?.capped ? Math.max(1, raw) : raw;
  }, [view.from, view.to, canvasW, result?.capped]);

  const minorStep = useMemo(() => {
    const m = minorTickStepForView(view.from, view.to, canvasW);
    return m == null || (result?.capped && m < 1) ? null : m;
  }, [view.from, view.to, canvasW, result?.capped]);

  const snapStep = minorStep ?? tickStep;
  stepRef.current = snapStep;

  const allVisibleItems = useMemo(() => {
    return packed.filter((it) =>
      itemIntersectsView(it.startYear, it.endYear, view.from, view.to),
    );
  }, [packed, view.from, view.to]);

  const subCount = useMemo(() => {
    let maxSub = 0;
    for (const it of allVisibleItems) {
      if (it.subLane > maxSub) maxSub = it.subLane;
    }
    return allVisibleItems.length > 0 ? maxSub + 1 : 0;
  }, [allVisibleItems]);

  const isDense = useMemo(() => {
    if (result?.capped) return true;
    return isTimelineDense(allVisibleItems, canvasW, subCount);
  }, [result?.capped, allVisibleItems, canvasW, subCount]);

  const { visibleItems, denseBuckets } = useMemo(() => {
    if (!isDense || result?.capped) {
      return {
        visibleItems: result?.capped ? ([] as PackedItem[]) : allVisibleItems,
        denseBuckets: [] as YearBucket[],
      };
    }
    // 묶음 단위는 보이는 가장 잘게 그린 눈금(보조 눈금이 있으면 그것 — 3년 화면이면 월)을 따른다(Q12 '눈금 단위(월·주) 막대').
    // 주 눈금(연)으로 묶으면 2026 년 노트 50개가 막대 하나로 뭉쳐 정보가 없다(2026-10-19 보드 재촬영).
    const buckets = bucketByStep(
      allVisibleItems.map((it) => ({ startYear: it.startYear })),
      snapStep,
    );
    return {
      visibleItems: [] as PackedItem[],
      denseBuckets: buckets,
    };
  }, [isDense, result?.capped, allVisibleItems, snapStep]);

  const cappedYearBuckets = useMemo(() => {
    if (!result?.capped) return [] as YearBucket[];
    const merged = new Map<number, number>();
    for (const b of result.year_buckets) {
      if (dashboardFolderFilter && b.folder_id !== dashboardFolderFilter) continue;
      merged.set(b.year, (merged.get(b.year) ?? 0) + b.count);
    }
    return [...merged.entries()].map(([year, count]) => ({
      year,
      endYear: year + 1,
      count,
    }));
  }, [result, dashboardFolderFilter]);

  const buckets = result?.capped ? cappedYearBuckets : denseBuckets;

  const visibleEras = useMemo(() => {
    const eras = result?.eras ?? [];
    return eras.filter((e) => e.to_year >= view.from && e.from_year <= view.to);
  }, [result?.eras, view.from, view.to]);

  const uiLang = useSettingsStore((s) => s.uiLang) || "en";

  const ticks = useMemo(
    () => yearTicks(view.from, view.to, tickStep),
    [view.from, view.to, tickStep],
  );

  const minorTicks = useMemo(() => {
    if (minorStep == null) return [] as number[];
    const labeled = new Set(ticks.map((t) => t.toFixed(9)));
    return yearTicks(view.from, view.to, minorStep).filter((t) => !labeled.has(t.toFixed(9)));
  }, [view.from, view.to, minorStep, ticks]);

  const allTicks = useMemo(
    () => (minorTicks.length ? [...ticks, ...minorTicks].sort((a, b) => a - b) : ticks),
    [ticks, minorTicks],
  );

  const onCanvasMouseMove = useCallback(
    (e: { clientX: number }) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !(canvasW > 0)) return;
      const year = xToYear(e.clientX - rect.left, view.from, view.to, canvasW);
      const target = nearestTick(allTicks, year);
      setHoverTick((prev) => (prev === target ? prev : target));
    },
    [view.from, view.to, canvasW, allTicks],
  );
  const onCanvasMouseLeave = useCallback(() => setHoverTick(null), []);

  const fitRange = useMemo(
    () => fitViewToItems(fitRanges(result, dashboardFolderFilter), fullRange),
    [result, fullRange, dashboardFolderFilter],
  );
  const fitView = useCallback(() => {
    if (fitRange) setView(fitRange);
  }, [fitRange]);

  const minimapMarks = useMemo(() => {
    if (!result) return [] as { left: number; width: number; key: string }[];
    const fullSpan = fullRange.to - fullRange.from;
    if (!(fullSpan > 0) || !(brushW > 0)) return [];
    if (result.capped) {
      const byYear = new Map<number, number>();
      for (const b of result.year_buckets) {
        if (dashboardFolderFilter && b.folder_id !== dashboardFolderFilter) continue;
        byYear.set(b.year, (byYear.get(b.year) ?? 0) + b.count);
      }
      return [...byYear.keys()].map((year) => ({
        key: `b-${year}`,
        left: yearToX(year, fullRange.from, fullRange.to, brushW),
        width: 2,
      }));
    }
    return packed.map((it) => {
      const left = yearToX(it.startYear, fullRange.from, fullRange.to, brushW);
      const right =
        it.kind === "bar"
          ? yearToX(it.endYear, fullRange.from, fullRange.to, brushW)
          : left + 2;
      return {
        key: it.noteId,
        left,
        width: Math.max(2, right - left),
      };
    });
  }, [result, packed, fullRange, brushW, dashboardFolderFilter]);

  const searchHits = useDashboardSearchHits();
  const searchResultsForTicks = useSearchStore((s) => s.searchResults);

  const searchTicks = useMemo(() => {
    if (!searchHits || searchResultsForTicks.length === 0) return [] as BrushHitTick[];
    const fullSpan = fullRange.to - fullRange.from;
    if (!(fullSpan > 0) || !(brushW > 0)) return [];
    const offsets = searchResultsForTicks.map((n) =>
      clamp(Math.round(n.year - fullRange.from), 0, fullSpan),
    );
    return bucketSearchHitTicks(offsets, fullSpan + 1, SEARCH_HIT_TICK_BUCKETS).map((tick) => {
      const range = hitTickBucketYearRange(
        tick.bucket,
        fullRange.from,
        fullRange.to,
        SEARCH_HIT_TICK_BUCKETS,
      );
      return {
        key: `hit-${tick.bucket}`,
        left: yearToX(fullRange.from + tick.rowIndex, fullRange.from, fullRange.to, brushW),
        from: range.from,
        to: range.to,
      };
    });
  }, [searchHits, searchResultsForTicks, fullRange, brushW]);

  const searchHitsCount = searchHits ? searchResultsForTicks.length : null;

  return (
    <div
      data-testid="timeline-tab"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        padding: "0 var(--space-4) var(--space-4)",
      }}
    >
      <TimelineHeaderBar
        view={view}
        fullRange={fullRange}
        tickStep={tickStep}
        isZoomed={isZoomed}
        fitRange={fitRange}
        fitView={fitView}
        applyView={applyView}
        result={result}
        loading={loading}
        error={error}
        brushTrackRef={brushTrackRef}
        brushW={brushW}
        minimapMarks={minimapMarks}
        searchTicks={searchTicks}
        searchHitsCount={searchHitsCount}
        yearFrom={yearFrom}
        yearTo={yearTo}
        yearBounds={yearBounds}
        setYearRange={setYearRange}
      />

      {/* Canvas */}
      <div
        ref={canvasRef}
        data-testid="timeline-canvas"
        onMouseMove={onCanvasMouseMove}
        onMouseLeave={onCanvasMouseLeave}
        onClick={() => setFocusedNoteId(null)}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "auto",
          scrollbarGutter: "stable",
          borderTop: "1px solid var(--line)",
          cursor: "crosshair",
          userSelect: "none",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            minHeight: minContentH,
          }}
        >
          <ItemsLayer
            ticks={ticks}
            minorTicks={minorTicks}
            eras={visibleEras}
            geo={geo}
            folderColor={folderColor}
            buckets={buckets}
            items={visibleItems}
            searchHits={searchHits}
            ghost={ghost}
            resize={resize}
            move={move}
            view={view}
            width={canvasW}
            step={tickStep}
            snapStep={snapStep}
            uiLang={uiLang}
            hoverTick={hoverTick}
            showLabels={showLabels}
            focusedNoteId={focusedNoteId}
            onFocusNote={setFocusedNoteId}
            onOpenNote={openNote}
          />

          {hoverTick != null && !ghost && !resize && !move && (
            <HoverGuide
              tick={hoverTick}
              view={view}
              width={canvasW}
              step={snapStep}
              uiLang={uiLang}
            />
          )}

          <TimelineTimeRuler
            ticks={ticks}
            minorTicks={minorTicks}
            view={view}
            width={canvasW}
            step={tickStep}
            uiLang={uiLang}
            hoverTick={hoverTick}
          />

          {!loading && result && !result.capped && result.items.length === 0 && (
            <div
              data-testid="timeline-empty"
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                color: "var(--faint)",
                fontSize: "var(--text-md)",
                pointerEvents: "none",
              }}
            >
              {t("home.timeline_empty")}
            </div>
          )}
        </div>
      </div>

      {/* Create popover */}
      {createPop && (
        <CreatePopover
          testId="timeline-create-pop"
          anchor={{ x: createPop.x, y: createPop.y }}
          containerProps={{ "data-tl-popover": "true" }}
          title={
            <>
              {createPop.to > createPop.from
                ? t("home.timeline_create_range", {
                    from: fmtBoundary(createPop.from, snapStep, uiLang),
                    to: fmtBoundary(
                      tripleFraction(endDateBeforeBoundary(createPop.to, snapStep)),
                      snapStep,
                      uiLang,
                    ),
                  })
                : t("home.timeline_create_year", {
                    year: fmtBoundary(createPop.from, snapStep, uiLang),
                  })}{" "}
              <span style={{ color: "var(--faint)", fontSize: "var(--text-xs)" }}>
                ({t("home.timeline_period_prefill")})
              </span>
            </>
          }
          subtitle={t("home.timeline_create_in_folder", { folder: createPopFolderLabel })}
          confirmLabel={t("home.timeline_create")}
          cancelLabel={t("home.timeline_cancel")}
          confirmTestId="timeline-create-confirm"
          cancelTestId="timeline-create-cancel"
          creating={creating}
          onConfirm={() => void createNoteInRange(createPop.from, createPop.to)}
          onCancel={() => setCreatePop(null)}
        >
          <input
            ref={createTitleRef}
            type="text"
            data-testid="timeline-create-title"
            value={createTitle}
            placeholder={t("note.untitled_note")}
            onChange={(e) => setCreateTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void createNoteInRange(createPop.from, createPop.to);
              }
            }}
            className="field"
            style={{
              height: 30,
              padding: "0 var(--space-3)",
              fontSize: "var(--text-sm)",
            }}
          />
        </CreatePopover>
      )}

      {/* Move to folder */}
      {moveMenuNoteId && (
        <PromptDialog
          title={t("ctx.move_to_folder")}
          mode="choice"
          choices={moveMenuChoices}
          onCancel={() => setMoveMenuNoteId(null)}
          onSubmit={(value) => runMoveToFolder(value as string)}
        />
      )}
    </div>
  );
}
