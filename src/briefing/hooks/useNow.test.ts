import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNowStores, useNow } from "./useNow";

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  resetNowStores();
  vi.useRealTimers();
});

describe("useNow 공유 타이머", () => {
  it("같은 tickMs 는 타이머 하나, 구독이 0 이면 clearTimeout", () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const a = renderHook(() => useNow(1000));
    const b = renderHook(() => useNow(1000));
    expect(set).toHaveBeenCalledTimes(1);
    const t0 = a.result.current.getTime();
    act(() => void vi.advanceTimersByTime(1010));
    expect(a.result.current.getTime()).toBeGreaterThan(t0);
    expect(b.result.current).toBe(a.result.current); // 같은 Date
    a.unmount();
    expect(clear).not.toHaveBeenCalled();
    b.unmount();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("틱은 벽시계 배수에 맞는다 — 마운트 시점이 아니라 다음 경계", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 20));
    const { result } = renderHook(() => useNow(30_000));
    act(() => void vi.advanceTimersByTime(10_010));
    expect(result.current.getSeconds() % 30).toBeLessThan(2);
  });

  it("hidden 이면 정지, 보이게 되면 즉시 갱신 후 재개", () => {
    const { result } = renderHook(() => useNow(1000));
    hidden = true;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    const t0 = result.current.getTime();
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.getTime()).toBe(t0);
    hidden = false;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.getTime()).toBeGreaterThan(t0);
    const t1 = result.current.getTime();
    act(() => void vi.advanceTimersByTime(1010));
    expect(result.current.getTime()).toBeGreaterThan(t1);
  });
});
