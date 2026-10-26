import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useElementSize } from "./useElementSize";

describe("useElementSize", () => {
  let stubBox = { width: 220, height: 480 };

  beforeEach(() => {
    stubBox = { width: 220, height: 480 };

    global.ResizeObserver = class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        // Synchronous notification on observe (matches GalleryExpanded.test.tsx stub shape)
        this.cb(
          [
            {
              target,
              contentRect: {
                ...stubBox,
                top: 0,
                left: 0,
                right: stubBox.width,
                bottom: stubBox.height,
                x: 0,
                y: 0,
              },
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    };
  });

  it("retains observed size when ResizeObserver notifies synchronously (order test)", () => {
    const el = document.createElement("div");
    expect(el.clientWidth).toBe(0);
    expect(el.clientHeight).toBe(0);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(el);
      return useElementSize(ref, { height: 120, width: 160 });
    });

    expect(result.current.width).toBe(220);
    expect(result.current.height).toBe(480);
  });
});
