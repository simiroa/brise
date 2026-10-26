import { useEffect, useState, type RefObject } from "react";

export interface ElementSizeFallback {
  width: number;
  height: number;
}

export function useElementSize<T extends HTMLElement = HTMLDivElement>(
  ref: RefObject<T | null>,
  fallback: ElementSizeFallback,
): { width: number; height: number } {
  const [width, setWidth] = useState(fallback.width);
  const [height, setHeight] = useState(fallback.height);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Initial read from clientHeight/clientWidth before observe.
    // Order is critical: if ro.observe(el) runs first and notifies synchronously
    // (as in jsdom/test stubs), post-observe clientHeight/clientWidth reads (0 in jsdom)
    // would overwrite the observer's measured size with the fallback values.
    setHeight(Math.floor(el.clientHeight) || fallback.height);
    setWidth(Math.floor(el.clientWidth) || fallback.width);

    // ResizeObserver 가 없는 환경(jsdom·구형 웹뷰)은 초기 측정값/폴백으로 남는다 — 던지지 않는다.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      if (box.height > 0) setHeight(Math.floor(box.height));
      if (box.width > 0) setWidth(Math.floor(box.width));
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback.height, fallback.width]);

  return { width, height };
}
