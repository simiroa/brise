import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { t } from "../i18n/t";

const useKeyboardOpenMock = vi.fn(() => false);
vi.mock("./useKeyboardOpen", () => ({
  useKeyboardOpen: () => useKeyboardOpenMock(),
}));

import { MobileNoteFab, FAB_CLEARANCE_PX } from "./MobileNoteFab";

function setup(props?: { scrollEl?: HTMLElement | null }) {
  const h = { onOpenVoice: vi.fn(), onPickPhoto: vi.fn(), onOpenAttach: vi.fn(), onOpenAi: vi.fn(), aiReady: true };
  render(<MobileNoteFab {...h} {...props} />);
  return h;
}

function createMockScrollEl(initialTop = 0, scrollHeight = 1000, clientHeight = 500) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: initialTop, writable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, writable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, writable: true });
  return el;
}

function scroll(el: HTMLElement, newTop: number) {
  el.scrollTop = newTop;
  fireEvent.scroll(el);
}

describe("MobileNoteFab — the floating ＋ speed dial on text sections (오너 2026-10-07)", () => {
  it("is ONE ＋ toggle in the floating wrapper (the old mic + attach pair is gone)", () => {
    setup();
    const fab = screen.getByTestId("mobile-note-fab");
    // 항상 보이는 버튼은 ＋ 하나뿐이다 — 나머지 셋은 다이얼 안의 펼침 항목이다.
    const toggle = screen.getByTestId("mobile-fab-toggle");
    expect(fab.contains(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe(t("mobile.fab_group"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("mobile-speed-dial").getAttribute("data-placement")).toBe("float");
    expect(fab.querySelectorAll("button:not(.mobile-speed-dial-item)").length).toBe(1);
  });

  it("＋ → 녹음 opens the recorder; ＋ → 사진 picks from the gallery; ＋ → 파일 첨부 opens the attach sheet — each exactly once", () => {
    const h = setup();
    const open = () => fireEvent.click(screen.getByTestId("mobile-fab-toggle"));

    open();
    fireEvent.click(screen.getByTestId("mobile-fab-mic"));
    expect(h.onOpenVoice).toHaveBeenCalledTimes(1);
    expect(h.onPickPhoto).not.toHaveBeenCalled();
    expect(h.onOpenAttach).not.toHaveBeenCalled();

    open();
    fireEvent.click(screen.getByTestId("mobile-fab-photo"));
    expect(h.onPickPhoto).toHaveBeenCalledTimes(1);

    open();
    fireEvent.click(screen.getByTestId("mobile-fab-attach"));
    expect(h.onOpenAttach).toHaveBeenCalledTimes(1);
    expect(h.onOpenVoice).toHaveBeenCalledTimes(1);
    expect(h.onPickPhoto).toHaveBeenCalledTimes(1);
  });

  it("nothing steals the editor focus (mousedown default prevented → the keyboard stays up)", () => {
    setup();
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    // fireEvent.mouseDown 은 기본 동작이 막혔으면 false.
    for (const id of ["mobile-fab-toggle", "mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach", "mobile-fab-ai"]) {
      expect(fireEvent.mouseDown(screen.getByTestId(id)), id).toBe(false);
    }
  });
});

describe("FAB footprint — one number in two places", () => {
  // 본문 아래 패딩(CSS)과 캐럿의 ProseMirror scrollMargin(TS)이 따로 놀면 한쪽이 FAB 밑으로 샌다.
  const css = readFileSync("src/styles/mobile/note-capture.css", "utf8");

  it("CSS --m-fab-clear equals FAB_CLEARANCE_PX", () => {
    const m = css.match(/\.mobile-note-stage\s*\{[^}]*--m-fab-clear:\s*(\d+)px/);
    expect(m, "--m-fab-clear is declared on .mobile-note-stage").toBeTruthy();
    expect(Number(m![1])).toBe(FAB_CLEARANCE_PX);
  });

  it("covers the single ＋ (56) + bottom inset (12), plus breathing room — shorter than the old 140 two-button stack", () => {
    expect(css).toMatch(/\.mobile-speed-dial \.mobile-speed-dial-trigger\s*\{[^}]*width:\s*56px;[^}]*height:\s*56px/);
    const fab = css.match(/\.mobile-note-fab\s*\{([^}]*)\}/)![1];
    expect(fab).toContain("bottom: var(--space-5)"); // 12px
    expect(FAB_CLEARANCE_PX).toBeGreaterThanOrEqual(56 + 12);
    expect(FAB_CLEARANCE_PX).toBeLessThan(140);
  });

  it("the body reserves it as bottom padding AND scroll-padding", () => {
    expect(css).toMatch(
      /\.mobile-note-stage \.mobile-note-body-wrap\s*\{[^}]*padding-bottom:\s*var\(--m-fab-clear\)[^}]*scroll-padding-bottom:\s*var\(--m-fab-clear\)/
    );
  });

  it("diagram / sheet sections (stage data-fab=dock) have no floating FAB, so they release that bottom padding", () => {
    const m = css.match(/\.mobile-note-stage\[data-fab="dock"\] \.mobile-note-body-wrap\s*\{([^}]*)\}/);
    expect(m, "dock-stage rule").toBeTruthy();
    expect(m![1]).toContain("padding-bottom: var(--space-5)");
    expect(m![1]).toMatch(/scroll-padding-bottom:\s*0/);
  });

  it("the FAB wrapper is click-through; only the ＋ and the opened actions take taps", () => {
    expect(css).toMatch(/\.mobile-note-fab\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.mobile-speed-dial \.mobile-speed-dial-trigger\s*\{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.mobile-speed-dial\[data-open="true"\] \.mobile-speed-dial-item\s*\{[^}]*pointer-events:\s*auto/);
  });

  it("supports prefers-reduced-motion without slide animation", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/\.mobile-note-fab\[data-hidden="true"\]\s*\{[^}]*transform:\s*none/);
  });
});

describe("Wave FAB — hide while scrolling down (Q16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useKeyboardOpenMock.mockReturnValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides after ≥ 8 px of downward scroll", () => {
    const scrollEl = createMockScrollEl(0);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");
    expect(fab.getAttribute("data-hidden")).toBeNull();

    // 5px 스크롤: 8px 미만이므로 아직 숨겨지지 않음
    act(() => scroll(scrollEl, 5));
    expect(fab.getAttribute("data-hidden")).toBeNull();

    // 추가 3px (총 8px): 숨겨짐!
    act(() => scroll(scrollEl, 8));
    expect(fab.getAttribute("data-hidden")).toBe("true");
  });

  it("shows immediately on upward scroll", () => {
    const scrollEl = createMockScrollEl(0);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");

    // 아래로 50px 스크롤 -> 숨겨짐
    act(() => scroll(scrollEl, 50));
    expect(fab.getAttribute("data-hidden")).toBe("true");

    // 위로 1px 스크롤 -> 즉시 나타남
    act(() => scroll(scrollEl, 49));
    expect(fab.getAttribute("data-hidden")).toBeNull();
  });

  it("shows after ~600 ms of scroll idle", () => {
    const scrollEl = createMockScrollEl(0);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");

    // 아래로 스크롤하여 숨김
    act(() => scroll(scrollEl, 50));
    expect(fab.getAttribute("data-hidden")).toBe("true");

    // 500ms 경과: 아직 숨겨짐
    act(() => vi.advanceTimersByTime(500));
    expect(fab.getAttribute("data-hidden")).toBe("true");

    // 600ms 경과: 나타남!
    act(() => vi.advanceTimersByTime(100));
    expect(fab.getAttribute("data-hidden")).toBeNull();
  });

  it("shows when reaching the bottom of the scroll container", () => {
    const scrollEl = createMockScrollEl(0, 1000, 500);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");

    // 중간 스크롤 -> 숨겨짐
    act(() => scroll(scrollEl, 200));
    expect(fab.getAttribute("data-hidden")).toBe("true");

    // 바닥(scrollTop = 500, clientHeight = 500, scrollHeight = 1000) 도달 -> 나타남!
    act(() => scroll(scrollEl, 500));
    expect(fab.getAttribute("data-hidden")).toBeNull();
  });

  it("never hides while the speed dial is open", () => {
    const scrollEl = createMockScrollEl(0);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");

    // 다이얼 열기
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-expanded")).toBe("true");

    // 아래로 스크롤해도 숨겨지지 않음
    act(() => scroll(scrollEl, 50));
    expect(fab.getAttribute("data-hidden")).toBeNull();
  });

  it("never hides while the keyboard is up", () => {
    useKeyboardOpenMock.mockReturnValue(true);
    const scrollEl = createMockScrollEl(0);
    setup({ scrollEl });
    const fab = screen.getByTestId("mobile-note-fab");

    // 아래로 스크롤해도 키보드가 열려 있으면 숨겨지지 않음
    act(() => scroll(scrollEl, 50));
    expect(fab.getAttribute("data-hidden")).toBeNull();
  });
});
