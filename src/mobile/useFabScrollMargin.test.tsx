import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { FAB_CLEARANCE_PX } from "./MobileNoteFab";
import { clampClearance, MIN_VISIBLE_ABOVE_PX, useFabScrollMargin } from "./useFabScrollMargin";

/**
 * 캐럿이 FAB 밑 띠에 서면 타이핑 중 스크롤이 **시작**되는가. ProseMirror 의 scrollRectIntoView 는
 * `scrollThreshold`(시작선)·`scrollMargin`(멈춤선)을 따로 본다 — margin 만 걸면 띠 안의 캐럿은 아직 가장자리를 안
 * 넘었으므로 스크롤이 안 시작돼 FAB 밑에 가려진다(prosemirror-view 1.42 실측: caret.bottom 470~598 모두 scrollTop 0).
 *
 * jsdom 엔 레이아웃이 없다 — 스크롤 영역·편집기 DOM 의 사각형과 캐럿 좌표(coordsAtPos)는 여기서 정한다.
 * 실제 prosemirror-view 와 이 레포의 진짜 훅(useFabScrollMargin)이 같이 돈다.
 */
const SCROLLER_TOP = 100;
const WIDTH = 390;

let restore: Array<() => void> = [];
afterEach(() => {
  for (const r of restore.reverse()) r();
  restore = [];
  document.body.innerHTML = "";
});

function patch(target: object, key: string, desc: PropertyDescriptor): void {
  const prev = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...desc });
  restore.push(() => {
    if (prev) Object.defineProperty(target, key, prev);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** 스크롤 영역(y = 100..100+height)에 진짜 Tiptap 을 올리고 진짜 훅을 건다. 캐럿은 `caretBottom` 에 선다. */
function setup(scrollerHeight: number) {
  const scroller = document.createElement("div");
  const host = document.createElement("div");
  scroller.appendChild(host);
  document.body.appendChild(scroller);

  let scrollTop = 0;
  patch(scroller, "scrollTop", { get: () => scrollTop, set: (v: number) => (scrollTop = v) });
  patch(scroller, "clientHeight", { get: () => scrollerHeight });

  // 스크롤 영역·편집기 말고는 전부 "크고 가려지지 않는" 상자 — 조상이 제 몫의 스크롤을 일으키지 않게 한다.
  const BIG = { left: -1e5, top: -1e5, right: 1e5, bottom: 1e5, width: 2e5, height: 2e5 };
  let editorRef: Editor | null = null;
  const proto = Element.prototype;
  const origRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    if (this === scroller)
      return { left: 0, top: SCROLLER_TOP, right: WIDTH, bottom: SCROLLER_TOP + scrollerHeight, width: WIDTH, height: scrollerHeight } as DOMRect;
    if (editorRef && this === editorRef.view.dom)
      return { left: 0, top: SCROLLER_TOP - scrollTop, right: WIDTH, bottom: SCROLLER_TOP - scrollTop + 4000, width: WIDTH, height: 4000 } as DOMRect;
    return BIG as DOMRect;
  };
  restore.push(() => {
    proto.getBoundingClientRect = origRect;
  });
  const sized = (key: "clientHeight" | "clientWidth" | "offsetHeight" | "offsetWidth", target: object) =>
    patch(target, key, {
      get(this: Element) {
        const tall = key.endsWith("Height");
        if (this === scroller) return tall ? scrollerHeight : WIDTH;
        if (editorRef && this === editorRef.view.dom) return tall ? 4000 : WIDTH;
        return 2e5;
      },
    });
  sized("clientHeight", proto);
  sized("clientWidth", proto);
  sized("offsetHeight", HTMLElement.prototype);
  sized("offsetWidth", HTMLElement.prototype);
  // 이 두 개는 위 proto 패치가 스크롤 영역 인스턴스 패치를 덮지 않는다(인스턴스 쪽이 먼저 읽힌다).
  patch(document.documentElement, "clientHeight", { value: 5000 });
  patch(document.documentElement, "clientWidth", { value: 5000 });

  const editor = new Editor({ element: host, extensions: createMobileSchemaExtensions(), content: "<p>hello world</p>" });
  editorRef = editor;
  restore.push(() => editor.destroy());

  const hook = renderHook(({ el }: { el: HTMLElement | null }) => useFabScrollMargin(editor, el), {
    initialProps: { el: scroller as HTMLElement | null },
  });

  /** 타이핑 한 번 — 캐럿 바닥이 `caretBottom` 인 채로 선택으로 스크롤한다(ProseMirror 가 키 입력 뒤 하는 일). */
  const typeCaretAt = (caretBottom: number) => {
    (editor.view as { coordsAtPos: unknown }).coordsAtPos = () => ({ left: 340, right: 341, top: caretBottom - 24, bottom: caretBottom });
    const text = editor.view.dom.querySelector("p")!.firstChild!;
    window.getSelection()!.collapse(text, 3);
    scrollTop = 0;
    // 키 입력 뒤 ProseMirror 가 부르는 바로 그 함수 — 타입 선언엔 @internal 이라 빠져 있다.
    (editor.view as unknown as { scrollToSelection(): void }).scrollToSelection();
    return scrollTop;
  };
  return { editor, scroller, typeCaretAt, hook, setScrollerHeight: (h: number) => (scrollerHeight = h) };
}

describe("clampClearance", () => {
  it("a tall scroller keeps the full FAB band", () => {
    expect(clampClearance(500)).toBe(FAB_CLEARANCE_PX);
    expect(clampClearance(FAB_CLEARANCE_PX + MIN_VISIBLE_ABOVE_PX)).toBe(FAB_CLEARANCE_PX);
  });

  it("a short scroller (landscape + keyboard) shrinks the band so MIN_VISIBLE_ABOVE_PX of text stays above it", () => {
    expect(clampClearance(120)).toBe(120 - MIN_VISIBLE_ABOVE_PX);
    expect(clampClearance(MIN_VISIBLE_ABOVE_PX + 1)).toBe(1);
  });

  it("a scroller no taller than that folds the band away entirely (ProseMirror's own defaults)", () => {
    expect(clampClearance(MIN_VISIBLE_ABOVE_PX)).toBe(0);
    expect(clampClearance(10)).toBe(0);
  });

  it("unknown height (not measured / jsdom) uses the whole band", () => {
    expect(clampClearance(0)).toBe(FAB_CLEARANCE_PX);
    expect(clampClearance(Number.NaN)).toBe(FAB_CLEARANCE_PX);
  });
});

describe("useFabScrollMargin — a caret inside the FAB band scrolls clear of it (real prosemirror-view)", () => {
  // 스크롤 영역 y = 100..600. FAB 띠 = 맨 아래 FAB_CLEARANCE_PX(80, ＋ 하나 — 예전 마이크+＋ 스택은 140) → y = 520..600.
  // 좌표는 FAB_CLEARANCE_PX 에서 파생한다 — 값이 또 바뀌어도 "띠 안/밖" 의 뜻이 그대로다.
  const BAND_TOP = 600 - FAB_CLEARANCE_PX;
  it("sets scrollThreshold.bottom together with scrollMargin.bottom (one value, so the stop line is the next start line)", () => {
    const { editor } = setup(500);
    expect(editor.view.someProp("scrollThreshold")).toEqual({ top: 0, right: 0, bottom: FAB_CLEARANCE_PX, left: 0 });
    expect(editor.view.someProp("scrollMargin")).toEqual({ top: 5, right: 5, bottom: FAB_CLEARANCE_PX, left: 5 });
  });

  it.each([590, BAND_TOP + 40, BAND_TOP + 10])("caret.bottom=%i (inside the band, above the edge) → the body scrolls", (bottom) => {
    const { typeCaretAt } = setup(500);
    const moved = typeCaretAt(bottom);
    expect(moved).toBeGreaterThan(0);
    // 스크롤이 멈춘 자리 = 가장자리(600) 에서 띠 만큼 위 — FAB 꼭대기보다 위.
    expect(bottom - moved).toBeLessThanOrEqual(600 - FAB_CLEARANCE_PX);
  });

  it("caret.bottom above the band (one px short of it) → no scroll", () => {
    const { typeCaretAt } = setup(500);
    expect(typeCaretAt(BAND_TOP - 10)).toBe(0);
  });

  it("the stop line is the next start line: after a scroll, typing on the same line does not scroll again", () => {
    const { typeCaretAt } = setup(500);
    const moved = typeCaretAt(590);
    expect(typeCaretAt(590 - moved)).toBe(0);
  });

  it("a short scroller (120px): the band is clamped, so the caret ends INSIDE the visible area, not scrolled out the top", () => {
    const { editor, typeCaretAt } = setup(120); // y = 100..220
    const clamp = clampClearance(120);
    expect(clamp).toBe(120 - MIN_VISIBLE_ABOVE_PX);
    expect(editor.view.someProp("scrollThreshold")).toEqual({ top: 0, right: 0, bottom: clamp, left: 0 });
    const moved = typeCaretAt(225); // 막 가장자리(220)를 넘었다
    expect(moved).toBeGreaterThan(0);
    const endsAt = 225 - moved;
    expect(endsAt).toBeGreaterThanOrEqual(SCROLLER_TOP); // 위로 밀려 나가지 않는다
    expect(endsAt).toBeLessThanOrEqual(220 - clamp);
  });

  it("follows the scroller when it resizes (keyboard up/down) and ignores a resize that changes nothing", () => {
    let observed: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      }
    );
    try {
      const { editor, setScrollerHeight, hook } = setup(500);
      const bottom = () => (editor.view.someProp("scrollThreshold") as { bottom: number }).bottom;
      expect(bottom()).toBe(FAB_CLEARANCE_PX);

      const spy = vi.spyOn(editor.view, "setProps");
      setScrollerHeight(120); // 키보드가 올라와 영역이 낮아졌다
      act(() => observed!());
      expect(bottom()).toBe(120 - MIN_VISIBLE_ABOVE_PX);
      expect(spy).toHaveBeenCalledTimes(1);

      act(() => observed!()); // 같은 높이로 또 알림 — 건드리지 않는다
      expect(spy).toHaveBeenCalledTimes(1);

      setScrollerHeight(500);
      act(() => observed!());
      expect(bottom()).toBe(FAB_CLEARANCE_PX);

      hook.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("without a scroller element (not mounted yet) it still arms the full band", () => {
    const { editor, hook } = setup(500);
    hook.rerender({ el: null });
    expect(editor.view.someProp("scrollThreshold")).toEqual({ top: 0, right: 0, bottom: FAB_CLEARANCE_PX, left: 0 });
  });
});

