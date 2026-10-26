import { useEffect } from "react";

/**
 * When a dashboard pane transitions from display:none to display:flex (active=true),
 * container sizes change from 0x0 to actual layout dimensions.
 * Triggering a window resize event allows React Flow and MapLibre to remeasure their containers
 * without resetting or clobbering stored viewports.
 */
export function useActiveTabResize(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);
}
