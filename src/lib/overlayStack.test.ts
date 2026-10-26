import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { pushOverlay, isOverlayOpen, dismissTopOverlay, useEscapeConsumer } from "./overlayStack";

function dispatchEscape(opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(event);
  return event;
}

describe("overlayStack — 저수준 스택 (pushOverlay/isOverlayOpen/dismissTopOverlay)", () => {
  it("is LIFO: dismissTopOverlay only calls the most recently pushed dismiss", () => {
    const a = vi.fn();
    const b = vi.fn();
    pushOverlay(a);
    const removeB = pushOverlay(b);
    expect(isOverlayOpen()).toBe(true);

    expect(dismissTopOverlay()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();

    expect(dismissTopOverlay()).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);

    expect(isOverlayOpen()).toBe(false);
    expect(dismissTopOverlay()).toBe(false);
    removeB(); // already popped — no-op, must not throw or double-remove something else
  });

  it("the remover returned by pushOverlay removes only that entry, wherever it sits in the stack", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    pushOverlay(a);
    const removeB = pushOverlay(b);
    pushOverlay(c);

    removeB();
    expect(dismissTopOverlay()).toBe(true);
    expect(c).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(dismissTopOverlay()).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("useEscapeConsumer — 체인 자기등록 훅", () => {
  it("registers only while active, and consumes exactly one Escape from the top", () => {
    const onEscape = vi.fn();
    const { rerender, unmount } = renderHook(({ active }) => useEscapeConsumer(active, onEscape), {
      initialProps: { active: false },
    });

    expect(isOverlayOpen()).toBe(false);
    dispatchEscape();
    expect(onEscape).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(isOverlayOpen()).toBe(true);

    const ev = dispatchEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    unmount();
  });

  it("does not consume Escape during IME composition (isComposing)", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeConsumer(true, onEscape));

    const ev = dispatchEscape({ isComposing: true } as KeyboardEventInit);
    expect(onEscape).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    unmount();
  });

  it("does not double-consume an Escape already handled by someone else (defaultPrevented)", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeConsumer(true, onEscape));

    const guard = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", guard, { capture: true });
    try {
      dispatchEscape();
      expect(onEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", guard, { capture: true });
      unmount();
    }
  });

  it("unregisters on unmount — no leak that would keep blocking Escape forever", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeConsumer(true, onEscape));
    expect(isOverlayOpen()).toBe(true);

    unmount();
    expect(isOverlayOpen()).toBe(false);

    // Escape now reaches whatever is next in line (nothing here) instead of this dead consumer.
    dispatchEscape();
    expect(onEscape).toHaveBeenCalledTimes(0);
  });

  it("unregisters when `active` flips back to false, without waiting for unmount", () => {
    const onEscape = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeConsumer(active, onEscape), {
      initialProps: { active: true },
    });
    expect(isOverlayOpen()).toBe(true);

    rerender({ active: false });
    expect(isOverlayOpen()).toBe(false);
  });

  it("reads the latest onEscape via ref — does not need to resubscribe when only the callback identity changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useEscapeConsumer(true, cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    dispatchEscape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("nests LIFO across two consumers activated at different times — last activated exits first", () => {
    const outer = vi.fn(); // e.g. "선택"
    const inner = vi.fn(); // e.g. "텍스트 편집"

    const outerHook = renderHook(() => useEscapeConsumer(true, outer));
    const innerHook = renderHook(() => useEscapeConsumer(true, inner));

    dispatchEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    dispatchEscape();
    expect(outer).toHaveBeenCalledTimes(1);

    outerHook.unmount();
    innerHook.unmount();
  });
});
