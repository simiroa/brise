import React, { useRef } from 'react';
import { clampMapTransform } from './geometry';
import { WHEEL_MAX_ZOOM } from './mapZoomScale';

export interface UseMapPanZoomOptions {
  isLocked: boolean;
  transform: { k: number; x: number; y: number };
  setTransform: React.Dispatch<React.SetStateAction<{ k: number; x: number; y: number }>>;
  svgRef: React.RefObject<SVGSVGElement | null>;
  gRef: React.RefObject<SVGGElement | null>;
  /** Current SVG viewport size — pan/zoom is clamped so the world never leaves blank space. */
  viewSize: { width: number; height: number };
}

export function useMapPanZoom({
  isLocked,
  transform,
  setTransform,
  svgRef,
  gRef,
  viewSize,
}: UseMapPanZoomOptions) {
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const rafId = useRef<number | null>(null);
  const viewSizeRef = useRef(viewSize);
  viewSizeRef.current = viewSize;

  const clamp = (t: { k: number; x: number; y: number }) =>
    clampMapTransform(viewSizeRef.current.width, viewSizeRef.current.height, t);

  const applyGTransform = (k: number, x: number, y: number) => {
    if (gRef.current) {
      gRef.current.setAttribute('transform', `translate(${x}, ${y}) scale(${k})`);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isLocked || e.button !== 0) return;
    isDragging.current = true;
    hasMoved.current = false;
    dragStart.current = { x: e.clientX - transformRef.current.x, y: e.clientY - transformRef.current.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isLocked || !isDragging.current) return;
    const nextX = e.clientX - dragStart.current.x;
    const nextY = e.clientY - dragStart.current.y;
    const dx = nextX - transformRef.current.x;
    const dy = nextY - transformRef.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved.current = true;
    }

    transformRef.current = clamp({ k: transformRef.current.k, x: nextX, y: nextY });

    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      applyGTransform(transformRef.current.k, transformRef.current.x, transformRef.current.y);
    });
  };

  const handleMouseUp = () => {
    if (isDragging.current) {
      isDragging.current = false;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      setTransform(transformRef.current);
    }
  };

  // Native WheelEvent, not React.WheelEvent: this is attached via addEventListener in WorldMap
  // (not JSX onWheel) so preventDefault actually takes effect — see WorldMap.tsx for why.
  const handleWheel = (e: WheelEvent) => {
    // Horizontal wheel (tilt wheel / trackpad swipe) pans, like a left-drag along x. It used to
    // fall through to the zoom path below, where deltaY === 0 reads as "not < 0" and so every
    // horizontal notch zoomed OUT (2026-09-08). clamp() pins it at k = 1, where there is no slack.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      if (isLocked || !svgRef.current) return;
      const prev = transformRef.current;
      const next = clamp({ k: prev.k, x: prev.x - e.deltaX, y: prev.y });
      if (next.x === prev.x) return;
      transformRef.current = next;
      applyGTransform(next.k, next.x, next.y);
      setTransform(next);
      return;
    }

    // Zoom is Ctrl/Cmd+wheel only (2026-09-08, unified with the dashboard timeline): a plain
    // wheel belongs to whatever page the map sits in — Settings' map preview is the scroll
    // container this listener was made non-passive for in the first place.
    if (!e.ctrlKey && !e.metaKey) return;
    // Consumed even when locked, or the browser's own Ctrl+wheel page zoom fires on top of it.
    e.preventDefault();
    if (isLocked || !svgRef.current) return;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const prevK = transformRef.current.k;
    const nextK = Math.min(Math.max(prevK * zoomFactor, 1), WHEEL_MAX_ZOOM);
    if (nextK === prevK) return;

    const rect = svgRef.current.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const nextX = cursorX - ((cursorX - transformRef.current.x) / prevK) * nextK;
    const nextY = cursorY - ((cursorY - transformRef.current.y) / prevK) * nextK;

    const nextTransform = clamp({ k: nextK, x: nextX, y: nextY });
    transformRef.current = nextTransform;
    applyGTransform(nextTransform.k, nextTransform.x, nextTransform.y);
    setTransform(nextTransform);
  };

  return {
    isDragging,
    hasMoved,
    transformRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    applyGTransform,
  };
}
