import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { reportFallback } from "../lib/diag";
import { MobileNudgeBubble, type NudgeBubbleModel } from "./MobileNudgeBubble";

vi.mock("../lib/diag", () => ({ reportFallback: vi.fn() }));

/**
 * 문장 위 말풍선 — 진짜 에디터 문서 + 가짜 좌표(jsdom 에는 레이아웃이 없다).
 * 자리 계산의 경계값 표는 useNudgeBubblePlacement.test.ts. 여기서 보는 것:
 *  - 위 / 아래로 뒤집힘 / 숨김이 화면에 반영되고, 스크롤·리사이즈·트랜잭션마다 다시 잰다
 *  - 반영·무시 배선, 처리 중 중복 탭 방지, 포커스를 뺏지 않는다
 *  - 문서에 아무것도 넣지 않는다(오버레이 — IME 조합을 건드리지 않는다)
 */

const P2 = 8; // "<p>first</p>" 다음 두 번째 문단의 내용 시작
let editor: Editor;
let coords: { first: { left: number; top: number; bottom: number }; last: { left: number; top: number; bottom: number } };
let coordsSpy: ReturnType<typeof vi.spyOn>;

let scrollEl: HTMLElement | null = null;

const RECTS: Record<string, { left: number; top: number; width: number; height: number }> = {
  stage: { left: 0, top: 100, width: 390, height: 500 },
  scroll: { left: 0, top: 100, width: 390, height: 500 },
  bubble: { left: 0, top: 0, width: 200, height: 38 },
};
function rectOf(el: Element) {
  const key = el.getAttribute("data-testid") === "stage" ? "stage" : el.getAttribute("data-testid") === "scroll" ? "scroll" : el.classList.contains("mobile-nudge-bubble") ? "bubble" : null;
  const r = key ? RECTS[key] : { left: 0, top: 0, width: 0, height: 0 };
  return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} } as DOMRect;
}

const nextFrame = () =>
  act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });

function actions(over: Partial<{ apply: () => Promise<void> | void; dismiss: () => void; both: boolean }> = {}): NudgeBubbleModel {
  const apply = over.apply ?? vi.fn();
  const dismiss = over.dismiss ?? vi.fn();
  return {
    anchorPos: P2,
    actions: [
      { key: "date", text: "Add date · 2026.10.08 15:00", onApply: apply, onDismiss: dismiss },
      ...(over.both
        ? [{ key: "region" as const, text: "Gyeongju", ariaLabel: "Region · Gyeongju", onApply: apply, onDismiss: dismiss }]
        : []),
    ],
  };
}

// MobileNote 와 같은 모양: 말풍선은 위치 기준 상자의 **자식**이고, 상자·스크롤 영역은 콜백 ref → 상태로 건넨다.
function Host({ model }: { model: NudgeBubbleModel | null }) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
  scrollEl = scroll;
  return (
    <div ref={setStage} data-testid="stage" style={{ position: "relative" }}>
      <div ref={setScroll} data-testid="scroll" />
      <MobileNudgeBubble editor={editor} model={model} stage={stage} scroll={scroll} />
    </div>
  );
}

const bubble = () => screen.getByTestId("mobile-nudge-bubble");
const placement = () => bubble().getAttribute("data-placement");
const transform = () => (bubble() as HTMLElement).style.transform;

beforeEach(() => {
  editor = new Editor({ extensions: createMobileSchemaExtensions(), content: "<p>first</p><p>second paragraph</p>" });
  coords = { first: { left: 40, top: 300, bottom: 320 }, last: { left: 40, top: 300, bottom: 320 } };
  coordsSpy = vi.spyOn(editor.view, "coordsAtPos").mockImplementation(((_pos: number, side?: number) => {
    const c = side === -1 ? coords.last : coords.first;
    return { ...c, right: c.left + 10 };
  }) as never);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  vi.mocked(reportFallback).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  editor.destroy();
});

describe("MobileNudgeBubble — placement on screen", () => {
  it("floats ABOVE the first line, left-aligned to the text start (stage coordinates)", () => {
    render(<Host model={actions()} />);
    expect(placement()).toBe("above");
    // 첫 줄 top 300 → 300 - 8 - 38 = 254, stage top 100 → 154. left 40.
    expect(transform()).toBe("translate(40px, 154px)");
  });

  it("flips below the paragraph's last line when there is no room above", () => {
    coords.first = { left: 40, top: 110, bottom: 130 };
    coords.last = { left: 40, top: 150, bottom: 170 };
    render(<Host model={actions()} />);
    expect(placement()).toBe("below");
    expect(transform()).toBe("translate(40px, 78px)"); // 170 + 8 - 100
  });

  it("is hidden while the paragraph's first line is scrolled out of view, and returns when it scrolls back", async () => {
    render(<Host model={actions()} />);
    expect(placement()).toBe("above");
    coords.first = { left: 40, top: 20, bottom: 40 }; // 위로 스크롤돼 viewport(top 100) 밖
    act(() => {
      fireEvent.scroll(scrollEl!);
    });
    await nextFrame();
    expect(placement()).toBe("hidden");
    coords.first = { left: 40, top: 300, bottom: 320 };
    act(() => {
      fireEvent.scroll(scrollEl!);
    });
    await nextFrame();
    expect(placement()).toBe("above");
    expect(transform()).toBe("translate(40px, 154px)");
  });

  it("clamps horizontally with 16px gutters (right edge)", () => {
    coords.first = { left: 385, top: 300, bottom: 320 };
    render(<Host model={actions()} />);
    expect(transform()).toBe("translate(174px, 154px)"); // 390 - 16 - 200
  });

  it("clamps horizontally with 16px gutters (left edge)", () => {
    coords.first = { left: 2, top: 300, bottom: 320 };
    render(<Host model={actions()} />);
    expect(transform()).toBe("translate(16px, 154px)");
  });

  it("recomputes on window resize", async () => {
    render(<Host model={actions()} />);
    RECTS.scroll = { left: 0, top: 100, width: 390, height: 150 }; // 키보드가 올라와 영역이 줄었다 — 첫 줄(300)은 이제 밖
    try {
      act(() => {
        fireEvent(window, new Event("resize"));
      });
      await nextFrame();
      expect(placement()).toBe("hidden");
    } finally {
      RECTS.scroll = { left: 0, top: 100, width: 390, height: 500 };
    }
  });

  it("recomputes on every editor transaction (selection moves and typing alike), one frame at a time", async () => {
    render(<Host model={actions()} />);
    coordsSpy.mockClear();
    coords.first = { left: 40, top: 360, bottom: 380 };
    act(() => {
      editor.view.dispatch(editor.state.tr);
      editor.view.dispatch(editor.state.tr);
      editor.view.dispatch(editor.state.tr);
    });
    await nextFrame();
    expect(transform()).toBe("translate(40px, 214px)");
    // rAF 로 합쳐진다 — 트랜잭션 3번이 측정 1번(첫 줄 + 마지막 줄 = coordsAtPos 2회)이다.
    expect(coordsSpy).toHaveBeenCalledTimes(2);
  });

  it("goes hidden when the document shrinks under the anchor", async () => {
    render(<Host model={actions()} />);
    act(() => {
      editor.commands.setContent("<p>x</p>");
    });
    await nextFrame();
    expect(placement()).toBe("hidden");
  });

  // 앵커는 감지 시점의 문서 위치다 — 그 뒤 앞 문단이 바뀌면 트랜잭션 매핑을 따라가야 한다(안 그러면 방금 고치던 앞 문단 위로 뛴다).
  it("follows its paragraph when an EARLIER paragraph grows (anchor is mapped through the transaction)", async () => {
    render(<Host model={actions()} />);
    coordsSpy.mockClear();
    act(() => {
      editor.commands.insertContentAt(1, "abc"); // 첫 문단 맨 앞에 3글자 — 두 번째 문단이 3 밀린다
    });
    await nextFrame();
    expect(coordsSpy).toHaveBeenCalledWith(P2 + 3, 1);
    expect(coordsSpy).not.toHaveBeenCalledWith(P2, 1);
    expect(placement()).toBe("above");
  });

  it("follows its paragraph when an earlier paragraph shrinks", async () => {
    render(<Host model={actions()} />);
    coordsSpy.mockClear();
    act(() => {
      editor.commands.deleteRange({ from: 1, to: 3 }); // "first" 의 앞 2글자 삭제 → 6 → 6-2
    });
    await nextFrame();
    expect(coordsSpy).toHaveBeenCalledWith(P2 - 2, 1);
  });

  it("typing INSIDE the anchor paragraph keeps the anchor at that paragraph's start", async () => {
    render(<Host model={actions()} />);
    coordsSpy.mockClear();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!!!"); // 두 번째 문단 끝
    });
    await nextFrame();
    expect(coordsSpy).toHaveBeenCalledWith(P2, 1);
    expect(placement()).toBe("above");
  });

  it("hides when the anchor paragraph itself is deleted (until the next scan clears the suggestion)", async () => {
    render(<Host model={actions()} />);
    act(() => {
      editor.commands.deleteRange({ from: 7, to: editor.state.doc.content.size });
    });
    await nextFrame();
    expect(placement()).toBe("hidden");
  });

  it("closing one of two actions (content change) does not reset the mapped anchor to the stale number", async () => {
    const { rerender } = render(<Host model={actions({ both: true })} />);
    act(() => {
      editor.commands.insertContentAt(1, "abc");
    });
    await nextFrame();
    coordsSpy.mockClear();
    rerender(<Host model={actions()} />); // 같은 anchorPos(P2) prop, 동작만 하나로
    expect(coordsSpy).toHaveBeenCalledWith(P2 + 3, 1);
    expect(coordsSpy).not.toHaveBeenCalledWith(P2, 1);
  });

  it("a NEW anchor prop (the next scan) replaces the mapped value", async () => {
    const { rerender } = render(<Host model={actions()} />);
    act(() => {
      editor.commands.insertContentAt(1, "abc");
    });
    await nextFrame();
    coordsSpy.mockClear();
    rerender(<Host model={{ ...actions(), anchorPos: P2 + 3 }} />);
    expect(coordsSpy).toHaveBeenCalledWith(P2 + 3, 1);
  });

  it("stops listening after unmount", async () => {
    const { unmount } = render(<Host model={actions()} />);
    unmount();
    coordsSpy.mockClear();
    act(() => {
      editor.view.dispatch(editor.state.tr);
      fireEvent(window, new Event("resize"));
    });
    await nextFrame();
    expect(coordsSpy).not.toHaveBeenCalled();
  });

  it("reports a coordsAtPos failure once, not on every scroll", async () => {
    coordsSpy.mockImplementation(() => {
      throw new RangeError("no layout");
    });
    render(<Host model={actions()} />);
    expect(placement()).toBe("hidden");
    for (let i = 0; i < 3; i++) {
      act(() => {
        fireEvent.scroll(scrollEl!);
      });
      await nextFrame();
    }
    expect(reportFallback).toHaveBeenCalledTimes(1);
    expect(reportFallback).toHaveBeenCalledWith("mobile-nudge-bubble", "coords_failed");
  });

  it("renders nothing without a model", () => {
    render(<Host model={null} />);
    expect(screen.queryByTestId("mobile-nudge-bubble")).toBeNull();
  });
});

describe("MobileNudgeBubble — actions", () => {
  it("shows date and region as two actions in ONE bubble", () => {
    render(<Host model={actions({ both: true })} />);
    const b = bubble();
    expect(screen.getAllByTestId("mobile-nudge-bubble")).toHaveLength(1);
    expect(b.querySelectorAll(".mobile-nudge-bubble-action")).toHaveLength(2);
    expect(within(b).getByRole("button", { name: /2026\.10\.08 15:00/ })).toBeTruthy();
    // 지역은 글자는 이름뿐이지만 이름(접근성)은 전체 문구
    expect(within(b).getByRole("button", { name: "Region · Gyeongju" })).toBeTruthy();
    expect(within(b).getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  });

  it("tapping an action applies it; × dismisses only that action", () => {
    const apply = vi.fn();
    const dismissDate = vi.fn();
    const dismissRegion = vi.fn();
    const model: NudgeBubbleModel = {
      anchorPos: P2,
      actions: [
        { key: "date", text: "Add date · 2026.10.08 15:00", onApply: apply, onDismiss: dismissDate },
        { key: "region", text: "Gyeongju", onApply: apply, onDismiss: dismissRegion },
      ],
    };
    render(<Host model={model} />);
    fireEvent.click(screen.getByRole("button", { name: /2026\.10\.08/ }));
    expect(apply).toHaveBeenCalledTimes(1);
    const regionAction = bubble().querySelector('[data-kind="region"]') as HTMLElement;
    fireEvent.click(within(regionAction).getByRole("button", { name: "Dismiss" }));
    expect(dismissRegion).toHaveBeenCalledTimes(1);
    expect(dismissDate).not.toHaveBeenCalled();
  });

  it("a double tap while the apply is still running applies once (no duplicate note_date_add)", async () => {
    let finish!: () => void;
    const apply = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<Host model={actions({ apply })} />);
    const main = screen.getByRole("button", { name: /2026\.10\.08/ }) as HTMLButtonElement;
    fireEvent.click(main);
    expect(main.disabled).toBe(true);
    fireEvent.click(main);
    expect(apply).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(main.disabled).toBe(false);
  });

  it("a rejected apply re-enables the action (the hook already toasted)", async () => {
    const apply = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<Host model={actions({ apply })} />);
    const main = screen.getByRole("button", { name: /2026\.10\.08/ }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(main);
    });
    expect(main.disabled).toBe(false);
  });
});

describe("MobileNudgeBubble — does not disturb the editor", () => {
  it("pressing any part of the bubble keeps the editor focus (mousedown default prevented)", () => {
    render(<Host model={actions({ both: true })} />);
    const stays = (el: Element) => fireEvent.mouseDown(el) === false;
    expect(stays(bubble())).toBe(true);
    for (const b of within(bubble()).getAllByRole("button")) expect(stays(b)).toBe(true);
  });

  it("is an overlay outside the ProseMirror document: nothing is inserted into the doc or the editor DOM", async () => {
    const before = JSON.stringify(editor.getJSON());
    render(<Host model={actions({ both: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /2026\.10\.08/ }));
    act(() => {
      fireEvent.scroll(scrollEl!);
    });
    await nextFrame();
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(editor.view.dom.contains(bubble())).toBe(false);
    expect(editor.view.dom.querySelector(".mobile-nudge-bubble")).toBeNull();
  });

  it("measuring never dispatches a transaction (so it cannot loop on its own 'transaction' listener)", async () => {
    render(<Host model={actions()} />);
    const dispatch = vi.spyOn(editor.view, "dispatch");
    act(() => {
      fireEvent.scroll(scrollEl!);
      fireEvent(window, new Event("resize"));
    });
    await nextFrame();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("MobileNudgeBubble — a view that cannot measure", () => {
  it("keeps the buttons in the DOM as 'unmeasured' (CSS hides them) instead of throwing", () => {
    (editor.view as unknown as { coordsAtPos?: unknown }).coordsAtPos = undefined;
    render(<Host model={actions()} />);
    expect(placement()).toBe("unmeasured");
    expect(screen.getByRole("button", { name: /2026\.10\.08/ })).toBeTruthy();
    expect(reportFallback).not.toHaveBeenCalled();
  });

  it("a model without an anchor is 'unmeasured' too", () => {
    render(<Host model={{ ...actions(), anchorPos: null }} />);
    expect(placement()).toBe("unmeasured");
  });
});
