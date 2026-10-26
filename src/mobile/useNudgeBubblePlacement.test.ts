import { describe, it, expect, vi, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import {
  computeBubblePlacement,
  measureBubble,
  BUBBLE_GAP_PX,
  BUBBLE_GUTTER_PX,
  type PlacementInput,
} from "./useNudgeBubblePlacement";

/**
 * 말풍선 자리 계산 — 순수 함수는 표로, 사각형을 읽는 쪽(measureBubble)은 진짜 에디터 문서 + 가짜 좌표로 본다.
 * jsdom 에는 레이아웃이 없다(Range.getClientRects 도 없다) — 그래서 좌표는 우리가 정한다.
 * 훅의 이벤트 배선(스크롤·리사이즈·트랜잭션)과 화면 연결은 MobileNudgeBubble.test.tsx.
 */

const VIEW = { left: 0, right: 390, top: 100, bottom: 600 };
const BUBBLE = { width: 200, height: 38 };
const line = (top: number, left = 40, height = 20) => ({ left, top, bottom: top + height });
const input = (over: Partial<PlacementInput> = {}): PlacementInput => {
  const first = over.first ?? line(300);
  return { first, lastBottom: first.bottom, view: VIEW, bubble: BUBBLE, ...over };
};

describe("computeBubblePlacement", () => {
  it("above: sits over the first line, left-aligned to the text start", () => {
    const r = computeBubblePlacement(input({ first: line(300, 40) }));
    expect(r).toEqual({ placement: "above", x: 40, y: 300 - BUBBLE_GAP_PX - BUBBLE.height });
  });

  it("a multi-line paragraph still anchors on the FIRST line (the typing line below is never covered)", () => {
    const r = computeBubblePlacement(input({ first: line(300), lastBottom: 460 }));
    expect(r.placement).toBe("above");
    expect(r.y).toBe(300 - BUBBLE_GAP_PX - BUBBLE.height);
  });

  it("flips below the paragraph's LAST line when there is no room above (top of the scroll viewport)", () => {
    // 첫 줄 top 110: 위로 8 + 38 = 46 이 필요한데 viewport top(100)까지 10 뿐이다.
    const r = computeBubblePlacement(input({ first: line(110), lastBottom: 200 }));
    expect(r).toEqual({ placement: "below", x: 40, y: 200 + BUBBLE_GAP_PX });
  });

  it("a one-line paragraph flips right under that line", () => {
    const r = computeBubblePlacement(input({ first: line(110) }));
    expect(r).toEqual({ placement: "below", x: 40, y: 130 + BUBBLE_GAP_PX });
  });

  it("exactly enough room above keeps 'above' (boundary)", () => {
    const top = VIEW.top + BUBBLE_GAP_PX + BUBBLE.height;
    expect(computeBubblePlacement(input({ first: line(top) })).placement).toBe("above");
    expect(computeBubblePlacement(input({ first: line(top - 1) })).placement).toBe("below");
  });

  it("hides when the first line has scrolled out above the viewport", () => {
    expect(computeBubblePlacement(input({ first: line(60) })).placement).toBe("hidden"); // bottom 80 <= 100
    expect(computeBubblePlacement(input({ first: line(80) })).placement).toBe("hidden"); // bottom 100 <= 100 (edge)
  });

  it("hides when the first line is below the viewport", () => {
    expect(computeBubblePlacement(input({ first: line(600) })).placement).toBe("hidden");
    expect(computeBubblePlacement(input({ first: line(700) })).placement).toBe("hidden");
  });

  it("a first line that is only partly visible at the top flips below instead of hiding", () => {
    const r = computeBubblePlacement(input({ first: line(90), lastBottom: 110 })); // 90..110, 10px visible
    expect(r.placement).toBe("below");
    expect(r.y).toBe(110 + BUBBLE_GAP_PX);
  });

  it("hides when the flipped spot would land past the bottom of the viewport", () => {
    // 위로는 안 되고(top 110), 마지막 줄이 영역 맨 아래라 아래로도 못 간다.
    const r = computeBubblePlacement(input({ first: line(110), lastBottom: 590 }));
    expect(r.placement).toBe("hidden");
  });

  it("clamps to the right gutter so the bubble stays on screen", () => {
    const r = computeBubblePlacement(input({ first: line(300, 380) }));
    expect(r.x).toBe(VIEW.right - BUBBLE_GUTTER_PX - BUBBLE.width); // 174
  });

  it("clamps to the left gutter", () => {
    expect(computeBubblePlacement(input({ first: line(300, 0) })).x).toBe(VIEW.left + BUBBLE_GUTTER_PX);
    expect(computeBubblePlacement(input({ first: line(300, 5) })).x).toBe(16);
  });

  it("a bubble wider than the viewport hugs the left gutter (CSS max-width shrinks it)", () => {
    const r = computeBubblePlacement(input({ first: line(300, 200), bubble: { width: 500, height: 38 } }));
    expect(r.x).toBe(VIEW.left + BUBBLE_GUTTER_PX);
  });

  it("the gutter is measured from the viewport's own edges, not from 0", () => {
    const r = computeBubblePlacement(input({ view: { left: 50, right: 440, top: 100, bottom: 600 }, first: line(300, 0) }));
    expect(r.x).toBe(50 + BUBBLE_GUTTER_PX);
  });
});

// ── measureBubble: 에디터 문서 + 가짜 좌표 ──
describe("measureBubble", () => {
  let editor: Editor;
  afterEach(() => {
    editor?.destroy();
  });

  const el = (rect: { left: number; top: number; width: number; height: number }) =>
    ({
      getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }),
    }) as unknown as HTMLElement;
  const stage = el({ left: 0, top: 100, width: 390, height: 500 });
  const scroll = el({ left: 0, top: 100, width: 390, height: 500 });
  const bubble = el({ left: 0, top: 0, width: 200, height: 38 });

  function make(html = "<p>first</p><p>second paragraph</p>") {
    editor = new Editor({ extensions: createMobileSchemaExtensions(), content: html });
    const spy = vi.spyOn(editor.view, "coordsAtPos").mockImplementation((_pos: number, side?: number) =>
      side === -1
        ? { left: 200, right: 210, top: 320, bottom: 340 }
        : { left: 40, right: 50, top: 300, bottom: 320 },
    );
    return spy;
  }
  const FIRST_P2 = 8; // "<p>first</p>" = 7 → 두 번째 문단 내용은 8 에서 시작한다
  const run = (anchorPos: number, scrollEl = scroll, onFail = vi.fn()) =>
    measureBubble({ editor, anchorPos, stage, scroll: scrollEl, bubble, onFail });

  it("reads the paragraph's first and last line from coordsAtPos(start, +1) / coordsAtPos(end, -1)", () => {
    const spy = make();
    const r = run(FIRST_P2);
    expect(spy).toHaveBeenCalledWith(FIRST_P2, 1);
    expect(spy).toHaveBeenCalledWith(FIRST_P2 + "second paragraph".length, -1);
    // 첫 줄 top 300 → 버블 y = 300 - 8 - 38 = 254, stage top 100 을 빼 stage 좌표로.
    expect(r).toEqual({ placement: "above", x: 40, y: 154 });
  });

  it("is read-only: the document is untouched", () => {
    make();
    const before = JSON.stringify(editor.getJSON());
    run(FIRST_P2);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it("hides (and does not throw) when the anchor is past the end of a shrunken document", () => {
    make("<p>x</p>");
    expect(run(50).placement).toBe("hidden");
  });

  it("hides when the anchor no longer resolves to a text block", () => {
    make("<p>first</p><p>second</p>");
    expect(run(0).placement).toBe("hidden"); // 문서 맨 앞 = 블록 사이
  });

  it("hides on a destroyed editor", () => {
    make();
    editor.destroy();
    expect(run(FIRST_P2).placement).toBe("hidden");
  });

  it("hides and reports the failure when coordsAtPos throws", () => {
    const spy = make();
    spy.mockImplementation(() => {
      throw new RangeError("no layout");
    });
    const onFail = vi.fn();
    expect(run(FIRST_P2, scroll, onFail).placement).toBe("hidden");
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("is 'unmeasured' (not hidden, not an error) when the view has no coordsAtPos — the fake editors in MobileNote tests", () => {
    make();
    (editor.view as unknown as { coordsAtPos?: unknown }).coordsAtPos = undefined;
    const onFail = vi.fn();
    expect(run(FIRST_P2, scroll, onFail).placement).toBe("unmeasured");
    expect(onFail).not.toHaveBeenCalled();
  });

  it("is 'unmeasured' while the scroll area has no layout (0×0)", () => {
    make();
    const collapsed = el({ left: 0, top: 0, width: 0, height: 0 });
    expect(run(FIRST_P2, collapsed).placement).toBe("unmeasured");
  });

  it("the keyboard (visualViewport) can cut the bottom of the visible area", () => {
    const spy = make();
    spy.mockImplementation(() => ({ left: 40, right: 50, top: 330, bottom: 350 }));
    expect(run(FIRST_P2).placement).toBe("above");
    // 키보드가 올라와 보이는 높이가 300(= client y 300 까지)이면 첫 줄(330)은 키보드 밑이다.
    Object.defineProperty(window, "visualViewport", { value: { offsetTop: 0, height: 300 }, configurable: true });
    try {
      expect(run(FIRST_P2).placement).toBe("hidden");
    } finally {
      delete (window as unknown as { visualViewport?: unknown }).visualViewport;
    }
  });
});
