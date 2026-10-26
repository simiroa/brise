import { describe, it, expect, vi, beforeEach } from "vitest";
import { Suspense } from "react";
import { render, screen, act } from "@testing-library/react";

const reportFallback = vi.fn();
vi.mock("./diag", () => ({ reportFallback: (...a: unknown[]) => reportFallback(...a) }));

import { lazyPreload, preloadIntentProps, startIdlePreload, __resetLazyPreloadForTests } from "./lazyPreload";

function Hello() {
  return <div data-testid="content">hello</div>;
}
const fallbacks: string[] = [];
function Fallback({ tag }: { tag: string }) {
  fallbacks.push(tag);
  return <div data-testid="fallback" />;
}

beforeEach(() => {
  fallbacks.length = 0;
  reportFallback.mockClear();
  __resetLazyPreloadForTests();
});

describe("lazyPreload", () => {
  it("브라우저 모드에서는 유휴 미리 받기를 시작하지 않는다", async () => {
    const A = lazyPreload(async () => ({ default: Hello }), { name: "t.browser", idle: "main" });
    startIdlePreload("main", true);
    await new Promise((r) => setTimeout(r, 300));
    expect(A.loaded).toBe(false);
  });

  it("미리 받아 둔 뒤의 첫 렌더는 대기 화면 없이 바로 그린다(React 19 의 300ms 지연을 피한다)", async () => {
    const C = lazyPreload(async () => ({ default: Hello }), { name: "t.preloaded" });
    await C.preload();
    expect(C.loaded).toBe(true);
    render(
      <Suspense fallback={<Fallback tag="a" />}>
        <C />
      </Suspense>,
    );
    expect(screen.getByTestId("content")).toBeTruthy();
    expect(fallbacks).toEqual([]);
    expect(reportFallback).not.toHaveBeenCalled();
  });

  it("못 받은 채 그려지면 예전처럼 대기 화면을 거치고 그 사실을 진단에 남긴다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const C = lazyPreload(async () => {
      await gate;
      return { default: Hello };
    }, { name: "t.cold" });
    render(
      <Suspense fallback={<Fallback tag="b" />}>
        <C />
      </Suspense>,
    );
    expect(screen.getByTestId("fallback")).toBeTruthy();
    expect(reportFallback).toHaveBeenCalledWith("lazy", "lazy_fallback_shown", "t.cold");
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByTestId("content")).toBeTruthy();
  });

  it("미리 받기는 한 번만 받고, 실패하면 기록하고 다음 호출이 다시 시도한다", async () => {
    let calls = 0;
    const C = lazyPreload(async () => {
      calls++;
      if (calls === 1) throw new Error("net");
      return { default: Hello };
    }, { name: "t.retry" });
    await C.preload();
    expect(C.loaded).toBe(false);
    expect(reportFallback).toHaveBeenCalledWith("lazy", "lazy_preload_failed", expect.stringContaining("t.retry"));
    await Promise.all([C.preload(), C.preload()]);
    expect(calls).toBe(2);
    expect(C.loaded).toBe(true);
  });

  it("의도 props 는 마우스 올림·포커스·누르기 시작에서 미리 받는다", async () => {
    const C = lazyPreload(async () => ({ default: Hello }), { name: "t.intent" });
    const props = preloadIntentProps(C);
    expect(Object.keys(props).sort()).toEqual(["onFocus", "onPointerDown", "onPointerEnter"]);
    props.onPointerEnter();
    await Promise.resolve();
    await Promise.resolve();
    expect(C.loaded).toBe(true);
  });

  it("시작한 창 그룹의 idle 만 유휴 시간에 받는다 — 시작 전에 만든 것도, 시작 뒤에 만든 것도", async () => {
    vi.useFakeTimers();
    const ric = vi.fn((cb: () => void) => setTimeout(cb, 1) as unknown as number);
    (window as unknown as { requestIdleCallback: typeof ric }).requestIdleCallback = ric;
    const A = lazyPreload(async () => ({ default: Hello }), { name: "t.idleA", idle: "main" });
    const B = lazyPreload(async () => ({ default: Hello }), { name: "t.notIdle" });
    const S = lazyPreload(async () => ({ default: Hello }), { name: "t.settingsOnly", idle: "settings" });
    startIdlePreload("main");
    const C = lazyPreload(async () => ({ default: Hello }), { name: "t.idleC", idle: "main" });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5);
    expect(A.loaded).toBe(true);
    expect(C.loaded).toBe(true);
    expect(B.loaded).toBe(false);
    expect(S.loaded).toBe(false);
    vi.useRealTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });
});
