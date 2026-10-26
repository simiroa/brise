import { useEffect, useRef, useState } from "react";
import { openAttachmentExternal } from "../../lib/attachmentOpen";
import type { Attachment } from "../../lib/commands.gen";
import { IconImage, IconZoomIn, IconZoomOut } from "../icons";
import { NoFormatFallback } from "./shared";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function ImagePreview({
  att,
  baseDir,
  convert,
}: {
  att: Attachment;
  baseDir: string | null;
  convert: ((path: string) => string) | null;
}) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // Button/Fit zoom animates; wheel and drag don't (a live-tracking transition feels like rubber).
  const [animate, setAnimate] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });

  // Live view state for the handlers. Wheel is a *continuous* React event, so several
  // notches can fire before a re-render commits — reading zoom/pan from the closure would
  // make each of them compute off the same stale base and silently drop steps. Same
  // reason and same shape as transformRef in useMapPanZoom.
  const view = useRef({ zoom, pan, fit });
  view.current = { zoom, pan, fit };

  // Reset zoom/fit/pan whenever the previewed attachment changes, matching the
  // reset that used to happen in PreviewAttachment's shared effect.
  useEffect(() => {
    setZoom(1);
    setFit(true);
    setPan({ x: 0, y: 0 });
    setAnimate(false);
  }, [att.id]);

  const openExternal = () => openAttachmentExternal(att.id);

  // Shared by wheel and the +/- buttons: given a target zoom and the screen
  // point to anchor on, resolve the clamp and, if we're leaving "fit", the pan
  // that keeps that point stationary. Anchoring only makes sense once the img
  // is at natural size — while `fit` the element is letterboxed by
  // objectFit:contain, so its box doesn't match the rendered picture yet.
  const zoomAt = (target: number, clientX: number, clientY: number) => {
    const { zoom: curZoom, pan: curPan, fit: curFit } = view.current;
    const next = Math.min(Math.max(target, MIN_ZOOM), MAX_ZOOM);
    if (next === curZoom) return;
    if (curFit || !imgRef.current || !containerRef.current) {
      view.current = { zoom: next, pan: curPan, fit: false };
      setFit(false);
      setZoom(next);
      return;
    }
    // Anchor against the image's *layout* origin, never its transformed rect. offsetLeft
    // is layout-only so a transform never moves it, and the container is the offsetParent
    // (position: relative). Measuring the transformed box instead would read the DOM as of
    // the last commit while `view` already holds the pending transform — the two disagree
    // the moment two wheel notches land in one frame. This mirrors the map, which measures
    // the svg container and transforms the inner <g>.
    const cRect = containerRef.current.getBoundingClientRect();
    const cursorX = clientX - (cRect.left + imgRef.current.offsetLeft);
    const cursorY = clientY - (cRect.top + imgRef.current.offsetTop);
    const nextPan = {
      x: cursorX - ((cursorX - curPan.x) / curZoom) * next,
      y: cursorY - ((cursorY - curPan.y) / curZoom) * next,
    };
    view.current = { zoom: next, pan: nextPan, fit: false };
    setZoom(next);
    setPan(nextPan);
  };

  // Native WheelEvent, not React.WheelEvent: registered via addEventListener below (not JSX
  // onWheel) so preventDefault actually takes effect — React attaches the synthetic onWheel
  // listener as passive at its event-delegation root, silently dropping preventDefault, so a
  // scrollable ancestor (e.g. this preview inside the note editor) would scroll instead of
  // zooming. Same root cause and fix as WorldMap.tsx / DiagramCanvas.tsx.
  const handleWheel = (e: WheelEvent) => {
    // Horizontal wheel pans instead of zooming — it used to fall through to the zoom path below,
    // where deltaY === 0 reads as "not < 0" and so every horizontal notch zoomed OUT (2026-09-08).
    // While `fit` the image is letterboxed: nothing to pan, so leave the event to the page.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (view.current.fit) return;
      e.preventDefault();
      setAnimate(false);
      const next = { x: view.current.pan.x - e.deltaX, y: view.current.pan.y };
      view.current = { ...view.current, pan: next };
      setPan(next);
      return;
    }

    // Zoom is Ctrl/Cmd+wheel only (2026-09-08, unified with the dashboard timeline and the map):
    // a plain wheel scrolls the note editor this preview sits in. preventDefault still runs on the
    // modifier path so the browser's own Ctrl+wheel page zoom doesn't fire on top.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setAnimate(false);

    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    zoomAt(view.current.zoom * factor, e.clientX, e.clientY);
  };

  // Mounted once — handleWheel is read through a ref so this never re-subscribes.
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => handleWheelRef.current(ev);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomButton = (delta: number) => {
    setAnimate(true);
    const rect = containerRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    zoomAt(view.current.zoom + delta, cx, cy);
  };

  const toggleFit = () => {
    setAnimate(true);
    setFit((f) => !f);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (fit || e.button !== 0) return; // panning past fit-scale would drag the image off into empty space
    setDragging(true);
    setAnimate(false);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };

  const endDrag = () => setDragging(false);

  if (!baseDir || !convert || !att.rel_path) {
    return (
      <NoFormatFallback
        icon={<IconImage size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />}
        onOpenExternal={openExternal}
      />
    );
  }
  const src = convert(`${baseDir}/${att.rel_path}`);
  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: fit ? "default" : dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <img
        ref={imgRef}
        src={src}
        alt={att.name}
        draggable={false}
        onDoubleClick={toggleFit}
        style={{
          transform: fit ? undefined : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          transition: animate ? "transform var(--dur-slow)" : "none",
          ...(fit ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : {})
        }}
      />
      <div className="overlay" style={{ position: "absolute", bottom: 16, display: "flex", gap: "var(--space-3)", padding: "var(--space-2)", boxShadow: "var(--shadow-lg)" }}>
        <button onClick={toggleFit} style={{ fontSize: "var(--text-xs)", background: fit ? "var(--accent)" : "transparent", color: fit ? "var(--on-accent)" : "var(--text)", border: "none", borderRadius: "var(--radius-sm)", padding: "var(--space-1) var(--space-3)", cursor: "pointer" }}>Fit</button>
        <button onClick={() => zoomButton(-0.25)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text)", display: "grid", placeItems: "center" }}><IconZoomOut size={14}/></button>
        <span style={{ fontSize: "var(--text-xs)", width: 36, textAlign: "center", lineHeight: "20px" }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => zoomButton(0.25)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text)", display: "grid", placeItems: "center" }}><IconZoomIn size={14}/></button>
      </div>
    </div>
  );
}
