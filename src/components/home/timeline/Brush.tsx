/**
 * Timeline minimap brush — extracted from TimelineTab (pure move, same behavior).
 * W8-h: this now lives centred in the header row where the zoom slider used to be, so it is the
 * single zoom/pan affordance next to the range readout (it sizes to its grid cell — no fixed
 * width or bottom margin of its own).
 * Visual language matches TimelineFilter (2px track, 14×22 handles, fill strip).
 * - Drag brush body → pan view (span preserved)
 * - Drag handles → resize view (zoom), min MIN_VIEW_SPAN
 * - Search-hit ticks: click / Enter → bracket view to that bucket's year range (QA8 2C)
 */
import React, { useEffect, useRef, useState } from "react";
import { clamp } from "../../../lib/ui";
import { t } from "../../../i18n/t";
import { MIN_VIEW_SPAN, type YearRange } from "./layout";

export type BrushHitTick = {
  left: number;
  key: string;
  /** Bucket year range — click brackets the brush view here (not open-note). */
  from: number;
  to: number;
};

export function TimelineBrush({
  trackRef,
  full,
  view,
  width = 0,
  marks = [],
  hitTicks,
  onViewChange,
}: {
  trackRef: React.RefObject<HTMLDivElement | null>;
  full: YearRange;
  view: YearRange;
  width?: number;
  marks?: { left: number; width: number; key: string }[];
  hitTicks?: BrushHitTick[];
  onViewChange: (from: number, to: number) => void;
}) {
  const fullSpan = full.to - full.from;
  const [localView, setLocalView] = useState<YearRange | null>(null);
  const activeView = localView ?? view;
  const lf = fullSpan > 0 ? ((activeView.from - full.from) / fullSpan) * 100 : 0;
  const tf = fullSpan > 0 ? ((activeView.to - full.from) / fullSpan) * 100 : 100;

  const dragRef = useRef<
    | { kind: "body"; startX: number; startFrom: number; startTo: number; currentFrom: number; currentTo: number }
    | { kind: "from" | "to"; startX: number; startFrom: number; startTo: number; currentFrom: number; currentTo: number }
    | null
  >(null);

  useEffect(() => {
    const onMove = (e: MouseEvent | PointerEvent) => {
      const d = dragRef.current;
      const track = trackRef.current;
      if (!d || !track) return;
      if (typeof e.buttons === "number" && (e.buttons & 1) === 0) {
        onEnd();
        return;
      }
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0 || !(fullSpan > 0)) return;
      const dxYear = ((e.clientX - d.startX) / rect.width) * fullSpan;
      if (d.kind === "body") {
        const nextFrom = clamp(d.startFrom + dxYear, full.from, full.to - (d.startTo - d.startFrom));
        const nextTo = nextFrom + (d.startTo - d.startFrom);
        d.currentFrom = nextFrom;
        d.currentTo = nextTo;
        setLocalView({ from: nextFrom, to: nextTo });
        return;
      }
      if (d.kind === "from") {
        const nextFrom = clamp(Math.min(d.startFrom + dxYear, d.startTo - MIN_VIEW_SPAN), full.from, full.to - MIN_VIEW_SPAN);
        d.currentFrom = nextFrom;
        setLocalView({ from: nextFrom, to: d.startTo });
        return;
      }
      const nextTo = clamp(Math.max(d.startTo + dxYear, d.startFrom + MIN_VIEW_SPAN), full.from + MIN_VIEW_SPAN, full.to);
      d.currentTo = nextTo;
      setLocalView({ from: d.startFrom, to: nextTo });
    };

    const onEnd = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setLocalView(null);
      document.body.style.cursor = "";
      if (d.currentFrom !== d.startFrom || d.currentTo !== d.startTo) {
        onViewChange(d.currentFrom, d.currentTo);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
    };
  }, [full.from, full.to, fullSpan, onViewChange, trackRef]);

  const startBody = (e: React.MouseEvent | React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind: "body",
      startX: e.clientX,
      startFrom: activeView.from,
      startTo: activeView.to,
      currentFrom: activeView.from,
      currentTo: activeView.to,
    };
    document.body.style.cursor = "grabbing";
  };

  const startHandle = (kind: "from" | "to") => (e: React.MouseEvent | React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind,
      startX: e.clientX,
      startFrom: activeView.from,
      startTo: activeView.to,
      currentFrom: activeView.from,
      currentTo: activeView.to,
    };
    document.body.style.cursor = "ew-resize";
  };

  // Click on track (outside brush) centers the current span there.
  const onTrackDown = (e: React.MouseEvent | React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.("[data-brush-window]")) return;
    const track = trackRef.current;
    if (!track || !(fullSpan > 0)) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const mid = full.from + frac * fullSpan;
    const span = view.to - view.from;
    const nextFrom = clamp(mid - span / 2, full.from, full.to - span);
    const nextTo = nextFrom + span;
    onViewChange(nextFrom, nextTo);
  };

  return (
    <div
      ref={trackRef}
      data-testid="timeline-brush"
      role="slider"
      aria-label={t("home.timeline_brush")}
      aria-valuemin={Math.round(full.from)}
      aria-valuemax={Math.round(full.to)}
      aria-valuenow={Math.round(activeView.from)}
      aria-valuetext={`${Math.round(activeView.from)} – ${Math.round(activeView.to)}`}
      aria-orientation="horizontal"
      onMouseDown={onTrackDown}
      onPointerDown={onTrackDown}
      style={{
        position: "relative",
        height: 46,
        flex: "none",
        minWidth: 0,
        userSelect: "none",
        touchAction: "none",
      }}
    >
      {/* Item position marks (above the track line). */}
      {marks.map((m) => (
        <div
          key={m.key}
          aria-hidden
          style={{
            position: "absolute",
            top: 15,
            left: m.left,
            width: m.width,
            height: 8,
            borderRadius: 1,
            background: "color-mix(in srgb, var(--accent) 45%, transparent)",
            pointerEvents: "none",
          }}
        />
      ))}

      {/* Search-hit ticks (above the density marks). Shared `--search-hit` token with the sidebar
          rail. Click/keyboard brackets the view to the tick's year range — ticks compress ≤128
          buckets, so open-note would be wrong here. */}
      {hitTicks?.map((tick) => (
        <button
          key={tick.key}
          type="button"
          data-testid="timeline-brush-hit-tick"
          data-from={tick.from}
          data-to={tick.to}
          aria-label={`${t("search.timeline_search_hit_goto")} (${Math.round(tick.from)} – ${Math.round(tick.to)})`}
          title={t("search.timeline_search_hit_goto")}
          onMouseDown={(e) => {
            // Don't start brush body/track drag when aiming at a hit tick.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onViewChange(tick.from, tick.to);
          }}
          style={{
            position: "absolute",
            top: 4,
            left: tick.left,
            width: 4,
            height: 12,
            margin: 0,
            padding: 0,
            border: "none",
            borderRadius: 1,
            background: "var(--search-hit)",
            cursor: "pointer",
            zIndex: 2,
          }}
        />
      ))}

      {/* Thin track line — same as TimelineFilter. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 22,
          height: 2,
          background: "var(--line)",
          pointerEvents: "none",
        }}
      />

      {/* Viewport brush window */}
      <div
        data-brush-window
        data-testid="timeline-brush-window"
        onMouseDown={startBody}
        onPointerDown={startBody}
        style={{
          position: "absolute",
          top: 12,
          left: `${lf}%`,
          width: `${Math.max(0, tf - lf)}%`,
          height: 22,
          cursor: "grab",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 7,
            right: 7,
            top: 7,
            height: 8,
            background: "color-mix(in srgb, var(--accent) 28%, transparent)",
            borderTop: "1px solid var(--accent)",
            borderBottom: "1px solid var(--accent)",
            pointerEvents: "none",
          }}
        />
        <div
          data-testid="timeline-brush-from"
          title="from"
          onMouseDown={startHandle("from")}
          onPointerDown={startHandle("from")}
          style={handleStyle(0)}
        >
          <div style={{ width: 2, height: 10, background: "var(--surface-base)" }} />
        </div>
        <div
          data-testid="timeline-brush-to"
          title="to"
          onMouseDown={startHandle("to")}
          onPointerDown={startHandle("to")}
          style={handleStyle(100)}
        >
          <div style={{ width: 2, height: 10, background: "var(--surface-base)" }} />
        </div>
      </div>

      {/* Width used for mark layout (keeps React happy when width is 0 mid-mount). */}
      <span style={{ display: "none" }} aria-hidden>
        {width}
      </span>
    </div>
  );
}

function handleStyle(leftPct: number): React.CSSProperties {
  return {
    position: "absolute",
    top: -2,
    left: `${leftPct}%`,
    transform: leftPct === 100 ? "translateX(-100%)" : undefined,
    width: 16,
    height: 26,
    background: "var(--accent)",
    borderRadius: 3,
    cursor: "ew-resize",
    display: "grid",
    placeItems: "center",
    touchAction: "none",
    zIndex: 3,
  };
}
