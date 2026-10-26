import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import type React from "react";
import { isOutsideViewport, registerNoteDropHandler, startNoteDrag } from "./noteDrag";
import { DETACH_DWELL_MS } from "./pointerContract";

// jsdom 뷰포트 = 1024×768. 레이아웃이 없어 elementFromPoint 는 테스트가 지정한다.
const W = window.innerWidth;
let under: Element | null = null;

function down(x = 100, y = 100) {
  return { button: 0, clientX: x, clientY: y } as unknown as React.PointerEvent;
}
const move = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y });
const up = (x: number, y: number) => fireEvent.pointerUp(window, { clientX: x, clientY: y, screenX: 2000, screenY: 50 });
const ghost = () => document.querySelector<HTMLElement>(".note-drag-ghost");

describe("isOutsideViewport", () => {
  it("밖·가장자리 4px 이내는 밖, 안쪽은 안", () => {
    expect(isOutsideViewport(-10, 300, 1000, 800)).toBe(true);
    expect(isOutsideViewport(4, 300, 1000, 800)).toBe(true);
    expect(isOutsideViewport(996, 300, 1000, 800)).toBe(true);
    expect(isOutsideViewport(500, 799, 1000, 800)).toBe(true);
    expect(isOutsideViewport(5, 5, 1000, 800)).toBe(false);
    expect(isOutsideViewport(500, 400, 1000, 800)).toBe(false);
  });
});

describe("startNoteDrag — 창 밖 분리(onOutsideDrop)", () => {
  const onOutsideDrop = vi.fn();
  const handler = vi.fn();
  let unregister: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    onOutsideDrop.mockReset();
    handler.mockReset();
    under = null;
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => under;
    unregister = registerNoteDropHandler(handler);
  });
  afterEach(() => {
    unregister();
    vi.useRealTimers();
  });

  const drag = () =>
    startNoteDrag(down(), "n1", "Sec", {
      section: { id: "s1", noteId: "n1" },
      outsideLabel: "Release",
      onOutsideDrop,
    });

  it("가장자리에 600ms 머문 뒤 놓으면 screen 좌표로 onOutsideDrop, 드롭 핸들러는 안 부른다", () => {
    drag();
    move(W - 2, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS - 1);
    expect(ghost()!.textContent).toBe("Sec");
    vi.advanceTimersByTime(1);
    expect(ghost()!.textContent).toBe("Release");
    up(W - 2, 100);
    expect(onOutsideDrop).toHaveBeenCalledWith(2000, 50);
    expect(handler).not.toHaveBeenCalled();
    expect(ghost()).toBeNull();
  });

  it("무장 전에 놓으면 아무 일도 없다", () => {
    drag();
    move(W + 50, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS - 100);
    up(W + 50, 100);
    expect(onOutsideDrop).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("무장 뒤 창 안으로 돌아오면 해제 — 고스트 원복, 재진출 시 타이머 재시작", () => {
    drag();
    move(-20, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS);
    expect(ghost()!.textContent).toBe("Release");
    move(300, 300);
    expect(ghost()!.textContent).toBe("Sec");
    move(-20, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS - 1);
    up(-20, 100);
    expect(onOutsideDrop).not.toHaveBeenCalled();
  });

  it("가장자리라도 커서 아래 드롭 대상이 있으면 밖이 아니다 — 기존 드롭으로 간다", () => {
    const row = document.createElement("div");
    row.setAttribute("data-note-drop-target", "note:n2");
    document.body.appendChild(row);
    under = row;
    drag();
    move(2, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS * 2);
    expect(ghost()!.textContent).toBe("Sec");
    up(2, 100);
    expect(onOutsideDrop).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith("n1", "note:n2", 2, 100, undefined, { id: "s1", noteId: "n1" });
    row.remove();
  });

  it("무장 상태라도 pointercancel 이면 아무 일도 없다", () => {
    drag();
    move(-20, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS);
    fireEvent.pointerCancel(window, { clientX: -20, clientY: 100 });
    expect(onOutsideDrop).not.toHaveBeenCalled();
    expect(ghost()).toBeNull();
  });

  it("창 blur·Escape 는 취소 — 고스트·리스너가 남지 않아 이후 pointerup 이 드롭하지 않는다", () => {
    for (const cancel of [() => fireEvent.blur(window), () => fireEvent.keyDown(window, { key: "Escape" })]) {
      drag();
      move(-20, 100);
      vi.advanceTimersByTime(DETACH_DWELL_MS);
      cancel();
      expect(ghost()).toBeNull();
      up(-20, 100);
      expect(onOutsideDrop).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("onOutsideDrop 이 없는 드래그(노트)는 창 밖에 오래 머물러도 무장되지 않는다", () => {
    startNoteDrag(down(), "n1", "Note");
    move(-20, 100);
    vi.advanceTimersByTime(DETACH_DWELL_MS * 3);
    expect(ghost()!.textContent).toBe("Note");
    up(-20, 100);
    expect(handler).not.toHaveBeenCalled();
  });
});
