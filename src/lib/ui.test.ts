import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { formatFileSize, useMediaQuery, useMenuPos } from "./ui";

describe("formatFileSize", () => {
  it("returns the default empty label for null", () => {
    expect(formatFileSize(null)).toBe("—");
  });

  it("returns the custom empty label for null", () => {
    expect(formatFileSize(null, "")).toBe("");
  });

  it("labels sub-KB sizes in bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
  });

  it("labels kilobytes to one decimal", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("labels megabytes to one decimal", () => {
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("useMenuPos", () => {
  it("recomputes position dynamically on window resize", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);

    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 100,
      top: 0,
      left: 0,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    function TestMenu({ anchor }: { anchor: { x: number; y: number } | null }) {
      const { ref, x, y } = useMenuPos(anchor);
      return createElement("div", {
        ref,
        "data-testid": "menu",
        style: { position: "fixed", left: x, top: y },
      });
    }

    render(createElement(TestMenu, { anchor: { x: 900, y: 750 } }));
    const menu = screen.getByTestId("menu");

    // Initial render with innerWidth 1000, innerHeight 800:
    // 900 + 200 > 992 -> 700
    // 750 + 100 > 792 -> 650
    expect(menu.style.left).toBe("700px");
    expect(menu.style.top).toBe("650px");

    // Expand window so menu fits without flipping
    act(() => {
      vi.stubGlobal("innerWidth", 2000);
      vi.stubGlobal("innerHeight", 2000);
      window.dispatchEvent(new Event("resize"));
    });

    expect(menu.style.left).toBe("900px");
    expect(menu.style.top).toBe("750px");

    spy.mockRestore();
  });
});

describe("useMediaQuery", () => {
  function stubMatchMedia(initial: boolean) {
    const listeners: Array<() => void> = [];
    const mq = {
      matches: initial,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
    return { mq, fire: () => listeners.forEach((fn) => fn()) };
  }

  function Probe() {
    return createElement("div", { "data-testid": "m" }, String(useMediaQuery("(max-width: 1100px)")));
  }

  it("reports the initial match and re-renders when the query flips", () => {
    const { mq, fire } = stubMatchMedia(false);
    render(createElement(Probe));
    expect(screen.getByTestId("m").textContent).toBe("false");

    // 창을 좁히면(= 미디어 쿼리가 매치로 뒤집히면) 훅이 그 자리에서 true 로 바뀌어야 한다 —
    // App.tsx 의 사이드바 자동 접힘이 이 전환 하나에 걸려 있다.
    act(() => {
      mq.matches = true;
      fire();
    });
    expect(screen.getByTestId("m").textContent).toBe("true");
  });
});
