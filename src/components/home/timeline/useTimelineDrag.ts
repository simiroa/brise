/**
 * Timeline canvas pointer interactions — ONE gesture machine for the whole canvas:
 *
 *   mousedown on a bar's edge handle  → "resize"  (change that note's start/end date)
 *   mousedown on an item BODY, primary → "move"   (shift the whole note, duration preserved)
 *   mousedown RIGHT button, anywhere   → "pan"    (2026-08-07 owner: 좌우 = view window,
 *                                                  상하 = canvas scrollTop; context menu suppressed)
 *   mousedown on empty canvas, Alt/middle → "pan" (legacy chord, kept)
 *   mousedown on empty canvas, primary → "create" (gantt ghost → confirm popover)
 *   wheel horizontal → "pan" (view window only); Ctrl/Cmd+wheel → zoom around the cursor
 *
 * "move" and "open the note" share one mousedown: below DRAG_THRESHOLD_PX it stays a click and
 * the item's own onClick opens the note; past the threshold the trailing click is swallowed by a
 * one-shot capture-phase listener on the canvas (see suppressNextClick) — otherwise every drag
 * would also navigate away, the exact flow break W8-e removed from note creation.
 *
 * W8-e: resize joined the machine rather than getting its own listeners — pan/create/resize all
 * read the same viewRef and the same snap rule, so there is exactly one place that turns a
 * clientX into a date. `stepRef` carries the axis's current tick step, so every gesture snaps to
 * the granularity the user can actually see (year / month start / day start) instead of the old
 * bare Math.round(), which made sub-year drags unjudgeable.
 *
 * The hook stays presentation-agnostic: it never touches the note store. It reports a committed
 * resize through `onCommitResize` and a finished create through `createPop`; TimelineTab owns
 * the IPC and the refetch.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { clamp } from "../../../lib/ui";
import {
  coarserUnit,
  endDateBeforeBoundary,
  shiftFraction,
  snapUnitForStep,
  snapYearToStep,
  tripleToFraction,
  unitsBetween,
  xToYear,
  zoomView,
  type SnapUnit,
  type YearRange,
} from "./layout";

/** Ignore pure clicks / noise when starting a drag (px). */
const DRAG_THRESHOLD_PX = 4;

/** Create-drag preview: a date range on the single canvas row (2026-08-09 — there is only ever
 *  one row to draw the ghost in; see layout.ts file header). */
export type GhostRange = { from: number; to: number };

/** In-flight bar-edge resize. `from`/`to` are the live (snapped) boundaries of the whole bar —
 *  the un-dragged edge is carried along so the preview and the commit both see a complete range. */
export type ResizeState = {
  noteId: string;
  edge: "from" | "to";
  from: number;
  to: number;
};

/** In-flight whole-note move. `from`/`to` are the live shifted boundaries (duration preserved) —
 *  ItemsLayer paints the item there instead of at its stored position. */
export type MoveState = {
  noteId: string;
  from: number;
  to: number;
};

export type CreatePopoverState = {
  from: number;
  to: number;
  x: number;
  y: number;
};

export function useTimelineDrag({
  canvasRef,
  viewRef,
  fullRef,
  stepRef,
  capped,
  applyView,
  setView,
  onCommitResize,
  onCommitMove,
  onItemContextMenu,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  viewRef: RefObject<YearRange>;
  fullRef: RefObject<YearRange>;
  /** Current axis tick step (years) — the snap granularity for every gesture. */
  stepRef: RefObject<number>;
  capped: boolean | undefined;
  applyView: (from: number, to: number) => void;
  setView: (v: YearRange) => void;
  /** Committed bar-edge resize (mouseup after real movement). Boundaries are snapped axis
   *  coordinates; the caller converts them to note dates. */
  onCommitResize?: (noteId: string, edge: "from" | "to", from: number, to: number) => void;
  /** Committed whole-note move (mouseup after real movement). `unit`/`deltaUnits` are already
   *  clamped to the note's own precision, so the caller can apply them verbatim to both ends. */
  onCommitMove?: (noteId: string, unit: SnapUnit, deltaUnits: number) => void;
  /** Right-click on a bar/point body (2026-08-09, move-to-folder context menu) — fires with the
   *  note id and the client coordinates the browser's contextmenu event carried. Never fires for
   *  a right-click on empty canvas (that's the pan chord) or inside a popover. */
  onItemContextMenu?: (noteId: string, clientX: number, clientY: number) => void;
}) {
  const [ghost, setGhost] = useState<GhostRange | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const [createPop, setCreatePop] = useState<CreatePopoverState | null>(null);

  // Callbacks are read through a ref so the (single) listener effect never re-binds mid-gesture
  // when the parent re-renders — re-binding used to be harmless for pan/create but would drop a
  // resize's mouseup on the floor.
  const commitRef = useRef(onCommitResize);
  commitRef.current = onCommitResize;
  const commitMoveRef = useRef(onCommitMove);
  commitMoveRef.current = onCommitMove;
  const contextMenuRef = useRef(onItemContextMenu);
  contextMenuRef.current = onItemContextMenu;

  // ── Canvas gesture machine: resize / pan / create ────────────────────────────────────────
  // Item bodies are data-tl-item and open the note (see TimelineItem); their edge handles are
  // data-tl-resize; popovers are data-tl-popover; the axis strip is data-tl-axis (hover target,
  // never a drag origin). Everything else is empty canvas.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    type Mode = "pan" | "create" | "resize" | "move" | null;
    let mode: Mode = null;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startScrollTop = 0;
    let startView: YearRange = viewRef.current;
    let startYear = 0;
    let resizing: ResizeState | null = null;
    /** Stored span of the note being moved, plus the shift resolved so far. */
    let moving: { noteId: string; from: number; to: number; unit: SnapUnit } | null = null;
    let moveDelta = 0;

    /** Swallow the click/dblclick the browser fires after a real drag, so a moved bar doesn't
     *  also focus (click) or open (dblclick) its note. Capture phase on the canvas beats React's
     *  root-level bubble listener. Both event types trap since a single mouseup can be followed
     *  by either, depending on whether the user's next tap lands as the second half of a dblclick. */
    const suppressNextClick = () => {
      const kill = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      el.addEventListener("click", kill, { capture: true, once: true });
      el.addEventListener("dblclick", kill, { capture: true, once: true });
      // If no click follows (drag ended off-canvas), drop the trap rather than eating the next one.
      setTimeout(() => {
        el.removeEventListener("click", kill, true);
        el.removeEventListener("dblclick", kill, true);
      }, 0);
    };

    const yearAtClientX = (clientX: number): number | null => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const v = viewRef.current;
      const raw = xToYear(clientX - rect.left, v.from, v.to, rect.width);
      return snapYearToStep(clamp(raw, v.from, v.to), stepRef.current ?? 1);
    };

    const onMove = (e: MouseEvent) => {
      if (!mode) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Pan is 2D, so a vertical-only drag must clear the threshold too; the other gestures are
      // horizontal and keep the dx-only test.
      const travel = mode === "pan" ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
      if (!moved && travel < DRAG_THRESHOLD_PX) return;
      moved = true;

      if (mode === "pan") {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return;
        const span = startView.to - startView.from;
        const dYears = -(dx / rect.width) * span;
        applyView(startView.from + dYears, startView.to + dYears);
        // Vertical: the lane stack lives in this scroll container — drag down = content follows
        // the cursor (scrollTop decreases), same feel as the horizontal axis.
        el.scrollTop = startScrollTop - dy;
        return;
      }

      const cur = yearAtClientX(e.clientX);
      if (cur == null) return;

      if (mode === "resize") {
        if (!resizing) return;
        // The dragged edge never crosses the other one:
        //  - "from" stops at the start of the LAST unit inside the bar, because the note's stored
        //    end is that unit and note_set_event_precision rejects start > end;
        //  - "to" may collapse onto the start, which the caller commits as "clear the period".
        const next: ResizeState =
          resizing.edge === "from"
            ? {
                ...resizing,
                from: Math.min(
                  cur,
                  tripleToFraction(
                    endDateBeforeBoundary(resizing.to, stepRef.current ?? 1),
                  ),
                ),
              }
            : { ...resizing, to: Math.max(cur, resizing.from) };
        resizing = next;
        setResize(next);
        return;
      }

      if (mode === "move") {
        if (!moving) return;
        // Whole units only — that is what keeps the duration exactly intact in calendar terms.
        moveDelta = unitsBetween(startYear, cur, moving.unit);
        setMove({
          noteId: moving.noteId,
          from: shiftFraction(moving.from, moving.unit, moveDelta),
          to: shiftFraction(moving.to, moving.unit, moveDelta),
        });
        return;
      }

      // create
      setGhost({
        from: Math.min(startYear, cur),
        to: Math.max(startYear, cur),
      });
    };

    const onUp = (e: MouseEvent) => {
      if (!mode) return;
      const finished = mode;
      const didMove = moved;
      const fromY = startYear;
      const r = resizing;
      const m = moving;
      const delta = moveDelta;
      mode = null;
      moved = false;
      resizing = null;
      moving = null;
      moveDelta = 0;
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (finished === "resize") {
        setResize(null);
        if (didMove && r) commitRef.current?.(r.noteId, r.edge, r.from, r.to);
        return;
      }
      if (finished === "move") {
        setMove(null);
        if (!didMove) return; // a plain click — let the item's onClick open the note
        suppressNextClick();
        if (m && delta !== 0) commitMoveRef.current?.(m.noteId, m.unit, delta);
        return;
      }
      if (finished === "create" && didMove) {
        const cur = yearAtClientX(e.clientX) ?? fromY;
        const from = Math.min(fromY, cur);
        const to = Math.max(fromY, cur);
        setGhost(null);
        setCreatePop({ from, to, x: e.clientX, y: e.clientY });
        return;
      }
      setGhost(null);
    };

    const beginDrag = (e: MouseEvent, next: Exclude<Mode, null>) => {
      e.preventDefault();
      mode = next;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollTop = el.scrollTop;
      startView = viewRef.current;
      document.body.style.cursor =
        next === "pan" || next === "move" ? "grabbing" : "ew-resize";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;

      // 0) Right-drag pans from ANYWHERE on the canvas — items included (2026-08-07 owner:
      // "마우스우클릭으로 좌우상하 패닝"). Popovers keep their normal behavior. The canvas-level
      // contextmenu listener below suppresses the menu, so a plain right-click is inert.
      if (e.button === 2) {
        if (target?.closest?.("[data-tl-popover]")) return;
        setCreatePop(null);
        beginDrag(e, "pan");
        return;
      }

      // 1) Bar-edge resize wins over everything else on an item.
      const handle = target?.closest?.("[data-tl-resize]") as HTMLElement | null;
      if (handle && e.button === 0 && !capped) {
        const noteId = handle.getAttribute("data-note-id");
        const edge = handle.getAttribute("data-edge") === "from" ? "from" : "to";
        const from = Number(handle.getAttribute("data-start"));
        const to = Number(handle.getAttribute("data-end"));
        if (!noteId || !Number.isFinite(from) || !Number.isFinite(to)) return;
        resizing = { noteId, edge, from, to };
        setResize(resizing);
        setCreatePop(null);
        beginDrag(e, "resize");
        return;
      }

      // 2) Item BODY → potential move. Same data-* contract as EdgeHandle, so no lookups here.
      const body = target?.closest?.("[data-tl-item]") as HTMLElement | null;
      if (body) {
        if (e.button !== 0 || e.altKey || capped) return;
        const noteId = body.getAttribute("data-note-id");
        const from = Number(body.getAttribute("data-start"));
        const to = Number(body.getAttribute("data-end"));
        const precision = body.getAttribute("data-precision");
        if (!noteId || !Number.isFinite(from) || !Number.isFinite(to)) return;
        // The shift unit is the axis granularity, never finer than what the note actually stores
        // — so the preview and the committed dates can't disagree.
        const unit = coarserUnit(
          snapUnitForStep(stepRef.current ?? 1),
          precision === "day" ? "day" : precision === "month" ? "month" : "year",
        );
        moving = { noteId, from, to, unit };
        moveDelta = 0;
        startYear = yearAtClientX(e.clientX) ?? from;
        setCreatePop(null);
        beginDrag(e, "move");
        return;
      }

      // 3) Never start a canvas drag from popovers / the axis strip.
      if (target?.closest?.("[data-tl-popover]")) return;
      if (target?.closest?.("[data-tl-axis]")) return;

      const wantPan = e.button === 1 || (e.button === 0 && e.altKey);
      const wantCreate = e.button === 0 && !e.altKey;
      if (!wantPan && !wantCreate) return;

      // Capped mode: no per-item create (aggregated view).
      if (wantCreate && capped) return;

      // 2026-08-09: no lane to read a folder from anymore — every create-drag resolves to the
      // inbox (see TimelineTab.tsx's createNoteInRange). startYear is still all this gesture needs.
      startYear = yearAtClientX(e.clientX) ?? viewRef.current.from;
      setCreatePop(null);
      beginDrag(e, wantPan ? "pan" : "create");
    };

    // Right button is the pan chord on this canvas, so the browser context menu never belongs
    // here (Windows fires it on mouseup, i.e. right after every right-drag ends) — EXCEPT a plain
    // right-click (no drag) on a bar/point body, which opens the move-to-folder menu instead
    // (2026-08-09). A real right-drag-pan that happens to end over an item can still fire this
    // (browser-dependent whether contextmenu suppresses after real pointer movement) — rare enough
    // to accept rather than guard (ponytail).
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-tl-popover]")) return;
      e.preventDefault();
      const item = target?.closest?.("[data-tl-item]") as HTMLElement | null;
      const noteId = item?.getAttribute("data-note-id");
      if (noteId) contextMenuRef.current?.(noteId, e.clientX, e.clientY);
    };

    el.addEventListener("mousedown", onDown);
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [applyView, capped]);

  // ── Wheel: horizontal pans the view window, Ctrl/Cmd+wheel zooms ─────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const v = viewRef.current;

      // A horizontal wheel (tilt wheel / trackpad swipe) moves the view window in time — the same
      // axis mapping as the right-drag pan above. It used to fall through to the zoom path, where
      // deltaY === 0 reads as "not < 0" and so every horizontal notch zoomed OUT (2026-09-08).
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const dYears = (e.deltaX / rect.width) * (v.to - v.from);
        applyView(v.from + dYears, v.to + dYears);
        return;
      }

      // Plain vertical wheel scrolls the lane stack: this container owns the overflow:auto and its
      // content (geo.totalHeight) can be taller than it, so the old unconditional preventDefault
      // left the lower lanes reachable only by dragging the scrollbar. Zoom is Ctrl/Cmd+wheel,
      // which also suppresses the browser's native pinch-zoom.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const focus = xToYear(e.clientX - rect.left, v.from, v.to, rect.width);
      const factor = e.deltaY < 0 ? 0.8 : 1.25;
      setView(zoomView(v, factor, fullRef.current.from, fullRef.current.to, focus));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyView, setView]);

  return { ghost, setGhost, resize, move, createPop, setCreatePop };
}
