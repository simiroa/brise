import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { autoScrollEdgePx, autoScrollSpeed, useAxisAutoScroll } from "./useAxisAutoScroll";

describe("자동 스크롤 순수 계산", () => {
  it("가장자리 폭은 32px 이되 작은 창에선 보이는 높이의 12% 로 죈다", () => {
    expect(autoScrollEdgePx(1000)).toBe(32);
    expect(autoScrollEdgePx(168)).toBeCloseTo(20.16, 5); // 사이드바 축: 38% 가 영역이던 문제
  });

  it("속도는 깊이에 비례하고 0~1 밖은 잘린다", () => {
    expect(autoScrollSpeed(0)).toBe(80);
    expect(autoScrollSpeed(1)).toBe(480);
    expect(autoScrollSpeed(0.5)).toBe(280);
    expect(autoScrollSpeed(-3)).toBe(80);
    expect(autoScrollSpeed(9)).toBe(480);
  });
});

describe("useAxisAutoScroll — 스크롤 상한은 최신 높이를 따른다", () => {
  // rAF 를 손으로 돌린다: 큐에 쌓인 콜백을 `step(ms)` 만큼 시간을 흘린 뒤 한 번 부른다.
  let queue: Array<(t: number) => void> = [];
  let now = 0;
  const step = (ms: number) => {
    now += ms;
    const run = queue;
    queue = [];
    run.forEach((cb) => cb(now));
  };

  beforeEach(() => {
    queue = [];
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => queue.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 보이는 창 100px(top 0 ~ bottom 100). scrollTop 은 그냥 쓰고 읽는 필드다. */
  const fakeAxis = () => {
    const el = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 0, width: 0 }),
    };
    return { ref: { current: el as unknown as HTMLDivElement }, el };
  };

  it("첫 렌더에서 꺼낸 trackAutoScroll 도 그 뒤 커진 높이까지 민다(오래 사는 imperative handle 의 클로저)", () => {
    const { ref, el } = fakeAxis();
    const { result, rerender } = renderHook(({ h }) => useAxisAutoScroll(ref, h), { initialProps: { h: 1000 } });
    // DayAxis 의 useImperativeHandle(…, []) 가 첫 렌더의 함수를 평생 쥐는 것과 같다.
    const firstRenderTrack = result.current.trackAutoScroll;

    rerender({ h: 2000 }); // 축 확대 / 익일 구간 변경 — 스크롤 영역이 커졌다
    el.scrollTop = 890; // 옛 상한(1000 - 100 = 900) 바로 아래
    firstRenderTrack(100, () => {}); // 맨 아래 가장자리(깊이 1 → 480px/s)
    step(0); // 루프 시작
    step(300); // 머무름(250ms) 통과
    for (let i = 0; i < 10; i++) step(50); // 프레임당 ≤24px 씩 밀린다

    // 옛 높이를 쥐고 있었다면 900 에서 멈춘다.
    expect(el.scrollTop).toBeGreaterThan(900);
    expect(el.scrollTop).toBeLessThanOrEqual(1900); // 새 상한(2000 - 100)

    result.current.stopAutoScroll();
  });

  it("상한은 여전히 넘기지 않는다", () => {
    const { ref, el } = fakeAxis();
    const { result } = renderHook(() => useAxisAutoScroll(ref, 1000));
    el.scrollTop = 895;
    result.current.trackAutoScroll(100, () => {});
    step(0);
    step(300);
    for (let i = 0; i < 20; i++) step(50);
    expect(el.scrollTop).toBe(900);
    result.current.stopAutoScroll();
  });
});
