/**
 * Timeline canvas content layer: era bands, the single-canvas density histogram, points/bars,
 * and the gantt create ghost.
 *
 * 2026-08-09 (owner decision, see layout.ts file header): the folder-swimlane row chrome (one
 * lane per folder, the left-pinned LaneGutter label chip) is gone. Everything now packs into ONE
 * row's sub-rows, and a folder is told apart by PAINT COLOR instead — `folderColor(item.folderId)`
 * drives the bar fill/border and the point dot; the ghost/resize/move previews and the span chip
 * stay accent-colored (they are gestures, not items).
 *
 * W8-e — everything on this layer that shows a *time span* speaks the same language:
 *   - the create ghost, an in-flight bar resize, and a committed bar all paint between the same
 *     two snapped axis boundaries, and all label themselves with the same date-range chip
 *     (formatTimelineTick at the axis's current granularity), so what you see while dragging is
 *     literally what the note ends up carrying;
 *   - bars carry two edge handles (`data-tl-resize`) whose data-* attributes are the drag
 *     machine's entire input — useTimelineDrag never has to look anything up.
 *
 * W8-h adds two things on the same rails:
 *   - vertical: the row is not uniform (sub-lane packing for overlapping bars), so every
 *     absolutely-positioned child takes its `top` from the `geo` prop (layout.ts::laneGeometry),
 *     never from a hardcoded constant;
 *   - drag-to-move: item BODIES carry the same data-start/data-end/data-precision contract the
 *     edge handles do, and an in-flight `move` previews exactly like a `resize` does.
 */
import React from "react";
import { displayTitle } from "../../../stores/notes";
import type { TimelineEra } from "../../../lib/commands.gen";
import { formatTimelineTick, formatYearRange } from "../dateFmt";
import {
  AXIS_HEIGHT,
  BAR_HEIGHT,
  BAR_MIN_PX,
  LANE_HEIGHT,
  POINT_SIZE,
  SUB_LANE_PITCH,
  TICK_STEP_DAY,
  endDateBeforeBoundary,
  fractionalYearToDate,
  itemIntersectsView,
  pointLabelMaxWidth,
  tripleToFraction,
  yearToX,
  formatBucketLabel,
  type LaneGeometry,
  type PackedItem,
  type YearRange,
} from "./layout";
import type { GhostRange, MoveState, ResizeState } from "./useTimelineDrag";

/** Grab width of a bar's resize handle (px) — wide enough to hit on a BAR_MIN_PX bar. */
const HANDLE_W = 7;

/** One density-histogram mark: count of notes starting in `year` (either the whole capped-mode
 *  payload, or the uncapped dense-canvas fallback — both render identically). */
export type YearBucket = { year: number; count: number; endYear?: number };

/**
 * Inclusive date-range label for a half-open [from, to) axis span, at the axis's granularity.
 * `to` is an exclusive boundary, so the right-hand label is the last day *inside* it, read at
 * `step` — for a gesture (`to` already on a snap boundary) that is the same unit the note will
 * store (see endDateBeforeBoundary).
 *
 * The last day is taken at DAY precision on purpose, not at `step`: a committed bar's `to` is its
 * real end, not an axis boundary, and snapping it to the axis unit first moved the end to the
 * nearest year — a bar ending 2026-03-31 read as ending in 2025 on a year axis (2026-10-19).
 */
export function spanLabel(from: number, to: number, step: number, uiLang: string): string {
  const fmt = (v: number) => formatTimelineTick(v, step, uiLang, fractionalYearToDate(v));
  if (!(to > from)) return fmt(from);
  const end = tripleToFraction(endDateBeforeBoundary(to, TICK_STEP_DAY));
  return formatYearRange(fmt(from), fmt(Math.max(from, end)));
}

export function ItemsLayer({
  ticks,
  minorTicks,
  eras,
  geo,
  folderColor,
  buckets,
  items,
  searchHits,
  ghost,
  resize,
  move,
  view,
  width,
  step,
  snapStep,
  uiLang,
  hoverTick,
  showLabels,
  focusedNoteId,
  onFocusNote,
  onOpenNote,
}: {
  ticks: number[];
  /** Unlabeled second-tier gridlines (layout.ts file header #5b) — fainter, no axis label. */
  minorTicks: number[];
  eras: TimelineEra[];
  /** The single row's top/height — not uniform (sub-lane packing). */
  geo: LaneGeometry;
  /** Folder id → paint color (2026-08-09 — items are told apart by color, not by lane). Falls
   *  back to var(--accent) for an unresolvable folder — see TimelineTab.tsx. */
  folderColor: (folderId: string) => string;
  buckets: YearBucket[];
  items: PackedItem[];
  /** Dashboard global search hits (HomeTab), or null when no query is active — dims non-matching
   *  items in place (uncapped mode only; capped mode has no individual items, see TimelineTab). */
  searchHits: Set<string> | null;
  ghost: GhostRange | null;
  /** In-flight bar-edge resize — the matching item paints at the preview span instead. */
  resize: ResizeState | null;
  /** In-flight whole-note move — same deal, shifted rather than re-spanned. */
  move: MoveState | null;
  view: YearRange;
  width: number;
  /** Axis LABEL step — the granularity a committed item's own range reads at. */
  step: number;
  /** Gesture SNAP step (minor tier when present) — what the live drag chips format at, so the
   *  chip and the gridline the user is aiming at always agree. */
  snapStep: number;
  uiLang: string;
  /** Tick nearest the cursor (snapped) — its gridline reads as the hover column. */
  hoverTick?: number | null;
  showLabels: boolean;
  /** Single-click focus (map view pattern, see HomeMapPane) — highlights in place,
   *  never opens. null when nothing is focused. */
  focusedNoteId: string | null;
  onFocusNote: (noteId: string) => void;
  /** Double-click — opens the note tab. */
  onOpenNote: (noteId: string) => void;
}) {
  // Single row (2026-08-09) — geo.tops/heights always have exactly one entry.
  const rowTop = geo.tops[0] ?? 0;
  const rowHeight = geo.heights[0] ?? LANE_HEIGHT;
  return (
    <>
      {/* One scoped rule set for the whole layer (MonthGrid/PhraseRow pattern) — bar edge handles
          reveal on hover with no per-item React state. */}
      <style>{`
        .tl-bar-handle{opacity:0;transition:opacity var(--dur-fast) ease}
        .tl-bar:hover .tl-bar-handle,
        .tl-bar-handle:hover,
        .tl-bar[data-resizing="true"] .tl-bar-handle{opacity:1}
      `}</style>

      {/* hoverTick changes on every canvas mouse-move — GridLines is the only thing that reads it,
          kept as its own component (sibling of ItemsList, not a parent) so a hover tick never
          forces the memoized items list to re-render (see ItemsList below and its file header). */}
      <GridLines
        ticks={ticks}
        minorTicks={minorTicks}
        view={view}
        width={width}
        hoverTick={hoverTick}
      />

      <ItemsList
        rowTop={rowTop}
        rowHeight={rowHeight}
        eras={eras}
        buckets={buckets}
        items={items}
        searchHits={searchHits}
        ghost={ghost}
        resize={resize}
        move={move}
        view={view}
        width={width}
        step={step}
        snapStep={snapStep}
        uiLang={uiLang}
        showLabels={showLabels}
        focusedNoteId={focusedNoteId}
        folderColor={folderColor}
        onFocusNote={onFocusNote}
        onOpenNote={onOpenNote}
      />
    </>
  );
}

/**
 * Everything in the row that does NOT depend on `hoverTick` — items, eras, density buckets, the
 * in-flight resize/move chip, and the create ghost. Split out (and memoized) so a hover-tick
 * change, which only ever repaints GridLines, cannot cascade into re-rendering every
 * `TimelineItem` — see ItemsLayer's file header and TimelineItem's own React.memo.
 */
const ItemsList = React.memo(function ItemsList({
  rowTop,
  rowHeight,
  eras,
  buckets,
  items,
  searchHits,
  ghost,
  resize,
  move,
  view,
  width,
  step,
  snapStep,
  uiLang,
  showLabels,
  focusedNoteId,
  folderColor,
  onFocusNote,
  onOpenNote,
}: {
  rowTop: number;
  rowHeight: number;
  eras: TimelineEra[];
  buckets: YearBucket[];
  items: PackedItem[];
  searchHits: Set<string> | null;
  ghost: GhostRange | null;
  resize: ResizeState | null;
  move: MoveState | null;
  view: YearRange;
  width: number;
  step: number;
  snapStep: number;
  uiLang: string;
  showLabels: boolean;
  focusedNoteId: string | null;
  folderColor: (folderId: string) => string;
  onFocusNote: (noteId: string) => void;
  onOpenNote: (noteId: string) => void;
}) {
  const itemTop = (it: { subLane: number }) => rowTop + it.subLane * SUB_LANE_PITCH;
  return (
    <>
      <LaneRowBg top={rowTop} height={rowHeight} />

      {eras.map((era, i) => (
        <EraBand key={era.id} era={era} view={view} width={width} tint={i % 2 === 0} />
      ))}

      {buckets.map((b) => (
        <BucketMark key={b.year} bucket={b} top={rowTop} view={view} width={width} />
      ))}

      {items.map((it) => {
        const previewing = resize?.noteId === it.noteId;
        const movingThis = !previewing && move?.noteId === it.noteId;
        const shown = previewing
          ? { ...it, kind: "bar" as const, startYear: resize.from, endYear: resize.to }
          : movingThis
            ? { ...it, startYear: move.from, endYear: move.to }
            : it;
        // Steady-state neighbor gap (FIX2, dashboard QA) — computed off the original packed
        // position, not the in-flight resize/move preview; a point rarely carries a visible
        // label while being dragged, so this stays simple.
        const labelMaxWidth = it.kind === "point" ? pointLabelMaxWidth(it, items, view, width) : undefined;
        return (
          <TimelineItem
            key={it.noteId}
            item={shown}
            top={itemTop(it)}
            color={folderColor(it.folderId)}
            view={view}
            width={width}
            step={previewing || movingThis ? snapStep : step}
            uiLang={uiLang}
            resizing={previewing}
            moving={movingThis}
            showLabel={showLabels}
            labelMaxWidth={labelMaxWidth}
            dim={searchHits !== null && !searchHits.has(it.noteId)}
            focused={focusedNoteId === it.noteId}
            onFocusNote={onFocusNote}
            onOpenNote={onOpenNote}
          />
        );
      })}

      {/* In-flight edge resize: same chip the ghost uses, so "drawing a period" and "adjusting a
          period" read identically. Rendered here rather than inside the bar because a bar can be
          BAR_MIN_PX wide with overflow:hidden. */}
      {(resize ?? move) && (
        <ItemSpanChip
          span={(resize ?? move)!}
          anchor={items.find((i) => i.noteId === (resize ?? move)!.noteId)}
          itemTop={itemTop}
          view={view}
          width={width}
          step={snapStep}
          uiLang={uiLang}
        />
      )}

      {/* Gantt create ghost */}
      {ghost && (
        <GhostBar ghost={ghost} top={rowTop} view={view} width={width} step={snapStep} uiLang={uiLang} />
      )}
    </>
  );
});

/** Live span chip for an in-flight resize/move, parked just above the item's own sub-lane row. */
function ItemSpanChip({
  span,
  anchor,
  itemTop,
  view,
  width,
  step,
  uiLang,
}: {
  span: { from: number; to: number };
  anchor: PackedItem | undefined;
  itemTop: (it: { subLane: number }) => number;
  view: YearRange;
  width: number;
  step: number;
  uiLang: string;
}) {
  return (
    <SpanChip
      centerX={
        (yearToX(span.from, view.from, view.to, width) +
          yearToX(span.to, view.from, view.to, width)) /
        2
      }
      top={(anchor ? itemTop(anchor) : 0) - 18}
      text={spanLabel(span.from, span.to, step, uiLang)}
    />
  );
}

/** Faint backdrop behind the single item row — full canvas width. 2026-08-09: no more alternating
 *  tint (that distinguished one folder lane from the next; there is only one row now). */
function LaneRowBg({ top, height }: { top: number; height: number }) {
  return (
    <div
      aria-hidden
      data-testid="timeline-lane-bg"
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height,
        background: "color-mix(in srgb, var(--text) 2.5%, transparent)",
        borderBottom: "1px solid var(--line)",
        pointerEvents: "none",
      }}
    />
  );
}

/** Background gridlines — one hairline per axis tick, full canvas height (behind items). The tick
 *  nearest the cursor brightens, which is the full-column half of the "every tick, down to the
 *  date, reacts" feedback (the label half is CSS :hover in Axis.tsx). */
function GridLines({
  ticks,
  minorTicks,
  view,
  width,
  hoverTick,
}: {
  ticks: number[];
  minorTicks: number[];
  view: YearRange;
  width: number;
  hoverTick?: number | null;
}) {
  return (
    <>
      {minorTicks.map((y) => {
        const hot = hoverTick != null && Math.abs(hoverTick - y) < 1e-6;
        return (
          <div
            key={`minor-${y}`}
            aria-hidden
            data-testid="timeline-gridline-minor"
            data-hover={hot ? "true" : undefined}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: yearToX(y, view.from, view.to, width),
              width: 1,
              // Deliberately fainter than a labeled tick: dense enough to read as a month/day
              // grid, weak enough that the labeled tier still frames it.
              background: hot
                ? "color-mix(in srgb, var(--accent) 55%, transparent)"
                : "color-mix(in srgb, var(--line) 40%, transparent)",
              pointerEvents: "none",
            }}
          />
        );
      })}
      {ticks.map((y) => {
        const hot = hoverTick != null && Math.abs(hoverTick - y) < 1e-6;
        return (
          <div
            key={`grid-${y}`}
            aria-hidden
            data-testid="timeline-gridline"
            data-hover={hot ? "true" : undefined}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: yearToX(y, view.from, view.to, width),
              width: 1,
              background: hot
                ? "color-mix(in srgb, var(--accent) 55%, transparent)"
                : "var(--line)",
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
}

/**
 * Live date-range chip shared by the create ghost and an in-flight resize — the "before you
 * commit, here is how long this is" readout the owner asked for. Canvas-absolute (not a child of
 * the bar) so a 8px-wide bar's overflow:hidden can't clip it.
 */
function SpanChip({ centerX, top, text }: { centerX: number; top: number; text: string }) {
  return (
    <span
      data-testid="timeline-span-chip"
      // 배경은 .overlay 가 소유한다(SINGLE-SHEET 계약, scripts/check-surface-contract.mjs) —
      // 캔버스 위에 떠 있는 읽기용 칩이라 팝오버/메뉴와 같은 표면이다. 테두리/반경만 이 칩의
      // 용도(accent 강조, 한 단계 작은 radius)로 덮어쓴다.
      className="overlay"
      style={{
        position: "absolute",
        left: centerX,
        top,
        transform: "translateX(-50%)",
        padding: "0 var(--space-2)",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--accent)",
        color: "var(--accent)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      {text}
    </span>
  );
}

/** Dashed preview of a create-drag, in the lane the drag started in, with its live date range. */
function GhostBar({
  ghost,
  top,
  view,
  width,
  step,
  uiLang,
}: {
  ghost: GhostRange;
  top: number;
  view: YearRange;
  width: number;
  step: number;
  uiLang: string;
}) {
  const left = yearToX(ghost.from, view.from, view.to, width);
  const right = yearToX(ghost.to, view.from, view.to, width);
  const w = Math.max(2, right - left);
  const label = spanLabel(ghost.from, ghost.to, step, uiLang);
  return (
    <>
      <div
        data-testid="timeline-ghost"
        data-ghost-label={label}
        style={{
          position: "absolute",
          // Same row the note will land in, not a fixed strip under the axis — the ghost is a
          // preview of the real bar, so it has to be where the real bar goes.
          top,
          left,
          width: w,
          height: BAR_HEIGHT,
          borderRadius: "var(--radius-sm)",
          pointerEvents: "none",
          background: "color-mix(in srgb, var(--accent) 22%, transparent)",
          border: "1px dashed var(--accent)",
        }}
      />
      <SpanChip centerX={left + w / 2} top={top - 18} text={label} />
    </>
  );
}

function EraBand({
  era,
  view,
  width,
  tint,
}: {
  era: TimelineEra;
  view: YearRange;
  width: number;
  tint: boolean;
}) {
  const leftY = Math.max(era.from_year, view.from);
  const rightY = Math.min(era.to_year, view.to);
  const left = yearToX(leftY, view.from, view.to, width);
  const right = yearToX(rightY, view.from, view.to, width);
  const w = Math.max(0, right - left);
  if (w <= 0) return null;
  return (
    <div
      data-testid="timeline-era"
      data-era-id={era.id}
      style={{
        position: "absolute",
        // Starts below the (now top-anchored) axis strip, runs to the true bottom — mirrors the
        // old bottom-axis layout (which reserved `bottom: AXIS_HEIGHT` instead), see Axis.tsx.
        top: AXIS_HEIGHT,
        bottom: 0,
        left,
        width: w,
        borderLeft: "1px dashed var(--line)",
        background: tint
          ? "color-mix(in srgb, var(--accent) 3%, transparent)"
          : "transparent",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "var(--space-3)",
          left: "var(--space-3)",
          fontSize: "var(--text-2xs)",
          color: "var(--faint)",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
        }}
      >
        {era.name}
      </span>
    </div>
  );
}

/** Max/min painted height for the density bar — must fit inside a single LANE_HEIGHT row (used to
 *  grow up to 92px against the whole canvas). */
const BUCKET_MIN_H = 6;
const BUCKET_MAX_H = LANE_HEIGHT - 12;

function BucketMark({
  bucket,
  top,
  view,
  width,
}: {
  bucket: YearBucket;
  /** The row's top (see layout.ts VERTICAL ANCHOR RULE) — growing DOWNWARD instead of up from the
   *  bottom axis. */
  top: number;
  view: YearRange;
  width: number;
}) {
  const bucketEnd = bucket.endYear ?? bucket.year + 1;
  if (!itemIntersectsView(bucket.year, bucketEnd, view.from, view.to)) return null;

  const left = yearToX(bucket.year, view.from, view.to, width);
  const right = yearToX(bucketEnd, view.from, view.to, width);
  const barWidth = Math.max(3, Math.round(right - left) - 1);

  const hFrac = Math.min(1, Math.log10(bucket.count + 1) / 2);
  const h = BUCKET_MIN_H + hFrac * (BUCKET_MAX_H - BUCKET_MIN_H);

  const title =
    Number.isInteger(bucket.year) && (bucket.endYear == null || bucket.endYear === bucket.year + 1)
      ? `${bucket.year}: ${bucket.count}`
      : `${formatBucketLabel(bucket.year, bucketEnd)}: ${bucket.count}`;

  return (
    <div
      data-testid="timeline-bucket"
      title={title}
      style={{
        position: "absolute",
        left: Math.round(left),
        top,
        width: barWidth,
        height: h,
        background: "color-mix(in srgb, var(--accent) 45%, transparent)",
        borderRadius: "0 0 1px 1px",
        pointerEvents: "none",
      }}
    />
  );
}

/** One draggable bar edge. Everything useTimelineDrag needs is on the element itself, so the
 *  hook stays free of React state and lookups. */
function EdgeHandle({
  item,
  edge,
  title,
}: {
  item: PackedItem;
  edge: "from" | "to";
  title: string;
}) {
  return (
    <span
      className="tl-bar-handle"
      data-testid="timeline-bar-handle"
      data-tl-resize="true"
      data-note-id={item.noteId}
      data-edge={edge}
      data-start={item.startYear}
      data-end={item.endYear}
      title={title}
      // The handle lives inside the bar, whose onClick/onDoubleClick focus/open the note — a
      // click (or dblclick) that was really the tail of a resize (or a mis-aimed grab) must not
      // navigate or steal focus.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [edge === "from" ? "left" : "right"]: 0,
        width: HANDLE_W,
        cursor: "ew-resize",
        background: "var(--accent)",
        borderRadius: edge === "from" ? "6px 0 0 6px" : "0 6px 6px 0",
      }}
    />
  );
}

const TimelineItem = React.memo(function TimelineItem({
  item,
  top,
  color,
  view,
  width,
  step,
  uiLang,
  showLabel,
  labelMaxWidth,
  resizing = false,
  moving = false,
  dim = false,
  focused = false,
  onFocusNote,
  onOpenNote,
}: {
  item: PackedItem;
  /** Canvas-absolute row top: row top + sub-lane offset (see ItemsLayer's itemTop). */
  top: number;
  /** Folder paint color (2026-08-09 — see ItemsLayer's `folderColor` prop). */
  color: string;
  view: YearRange;
  width: number;
  step: number;
  uiLang: string;
  showLabel: boolean;
  /** Point label clamp (FIX2, layout.ts::pointLabelMaxWidth) — px maxWidth, null to hide the
   *  label outright (gap too tight), undefined for no neighbor (keep unclamped behavior). Only
   *  meaningful for kind="point"; bars ignore it. */
  labelMaxWidth?: number | null;
  /** This bar is the one being edge-dragged — pin its handles visible and show the span chip. */
  resizing?: boolean;
  /** This item is the one being dragged bodily — cursor reads as a grab, not a click. */
  moving?: boolean;
  /** Dashboard search dim (owner decision): fade in place, never remove. */
  dim?: boolean;
  /** Single-click focus (map view pattern) — outlined in place, not opened. */
  focused?: boolean;
  /** Stable callbacks (identity never changes across a hover-tick-only re-render, see ItemsList) —
   *  called with this item's own noteId rather than pre-bound per-item, so TimelineItem's props
   *  stay referentially stable and React.memo can actually skip re-rendering on hover. */
  onFocusNote: (noteId: string) => void;
  onOpenNote: (noteId: string) => void;
}) {
  const left = yearToX(item.startYear, view.from, view.to, width);
  // Tooltip band — same inclusive date range the resize chip shows, at the axis's granularity.
  const rangeText = spanLabel(item.startYear, item.endYear, step, uiLang);
  const title = `${displayTitle(item.title)} (${rangeText})`;
  // Everything useTimelineDrag's "move" mode needs, on the element itself — same contract the
  // edge handles use, so the hook never has to look an item up.
  const moveAttrs = {
    "data-note-id": item.noteId,
    "data-start": item.startYear,
    "data-end": item.endYear,
    "data-precision": item.precision,
  } as const;

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    top,
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    maxWidth: `calc(100% - ${left}px)`,
    cursor: "pointer",
    // Dashboard search dim (owner decision) — point items only (bar items set their own style).
    opacity: dim ? 0.35 : 1,
  };

  // Single click focuses (map view pattern); double click opens — see ItemsLayer's onFocusNote/
  // onOpenNote header comments. Both stop propagation so a click/dblclick on an item never
  // bubbles to the canvas's empty-space click (which clears focus, see TimelineTab).
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFocusNote(item.noteId);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenNote(item.noteId);
  };
  // Focus ring — accent outline, same token the map view's selected card border uses (see
  // HomeMapPane). Outline (not border) so it never perturbs the bar's own folder-color border
  // or the point's layout.
  const focusRing: React.CSSProperties = focused
    ? { outline: "2px solid var(--accent)", outlineOffset: 2 }
    : {};

  if (item.kind === "bar") {
    // Gantt bar: the primary mark. Title lives INSIDE the pill (not a sibling label) so it
    // never competes with neighbors for space — width truncates it with ellipsis, and the
    // native `title` attribute (full "title (range)") covers it as a hover tooltip.
    const right = yearToX(item.endYear, view.from, view.to, width);
    const barW = Math.max(BAR_MIN_PX, right - left);
    return (
      <div
        role="button"
        tabIndex={0}
        className="tl-bar"
        data-testid="timeline-item"
        data-tl-item
        data-kind="bar"
        {...moveAttrs}
        data-resizing={resizing ? "true" : undefined}
        data-moving={moving ? "true" : undefined}
        data-search-dim={dim ? "true" : undefined}
        data-focused={focused ? "true" : undefined}
        title={title}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenNote(item.noteId);
          }
        }}
        style={{
          position: "absolute",
          top,
          left,
          width: barW,
          height: BAR_HEIGHT,
          display: "flex",
          alignItems: "center",
          borderRadius: "var(--radius-sm)",
          padding: "0 6px",
          boxSizing: "border-box",
          overflow: "hidden",
          // Folder color (2026-08-09) — falls back to var(--accent) upstream when a folder's
          // color can't be resolved (see TimelineTab's `folderColor`).
          background: `color-mix(in srgb, ${color} 55%, transparent)`,
          border: `1px solid ${color}`,
          cursor: moving ? "grabbing" : "pointer",
          // Dashboard search dim (owner decision): same 0.35 fade the board/calendar/map panes
          // use for "not a hit" — fade in place, never remove.
          opacity: dim ? 0.35 : 1,
          ...focusRing,
        }}
      >
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            color: "var(--text)",
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayTitle(item.title)}
        </span>
        <EdgeHandle item={item} edge="from" title={rangeText} />
        <EdgeHandle item={item} edge="to" title={rangeText} />
      </div>
    );
  }

  // ponytail: points (day-precision notes with no end) have no edges to grab, so they can't be
  // *stretched* into a period here (they CAN be dragged bodily — see the move mode) — set an end
  // date in the note's date badge, or redraw it with a create-drag. Upgrade path if that bites:
  // give the point marker a single right-edge handle that starts a "to" resize from startYear.
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="timeline-item"
      data-tl-item
      data-kind="point"
      {...moveAttrs}
      data-moving={moving ? "true" : undefined}
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenNote(item.noteId);
        }
      }}
      style={{
        ...baseStyle,
        left: left - POINT_SIZE / 2,
        cursor: moving ? "grabbing" : "pointer",
        ...focusRing,
      }}
    >
      <span
        style={{
          width: POINT_SIZE,
          height: POINT_SIZE,
          borderRadius: "50%",
          // Folder color (2026-08-09) — see the bar's background above for the fallback rule.
          background: color,
          flex: "none",
          boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
        }}
      />
      {/* labelMaxWidth === null → gap to the next item in this row is under LABEL_MIN_GAP_PX;
          hide the label outright (the `title` tooltip above still carries the text). */}
      {showLabel && labelMaxWidth !== null && (
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            ...(labelMaxWidth != null ? { maxWidth: labelMaxWidth } : {}),
          }}
        >
          {displayTitle(item.title)}{" "}
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--faint)" }}>
            {rangeText}
          </span>
        </span>
      )}
    </div>
  );
});
