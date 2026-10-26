import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { beginLongPress, cancelLongPress, consumeLongPress, moveLongPress } from "./longPress";

describe("longPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 모듈 전역 상태를 테스트 간에 깨끗하게 — 이전 테스트의 armed/timer 가 새지 않게.
    cancelLongPress();
    consumeLongPress();
    // 앞 테스트가 손을 떼지 않고 끝났으면 선택 차단(suppressNativeLongPress)이 남아 있다 — 떼서 푼다.
    document.dispatchEvent(new Event("pointerup"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("자동 회복: 발동 후에는 pointerup/cancel 없이도 다음 롱프레스가 다시 잡힌다", () => {
    const first = vi.fn();
    beginLongPress(first);
    vi.advanceTimersByTime(400);
    expect(first).toHaveBeenCalledTimes(1);
    expect(consumeLongPress()).toBe(true);

    // pointerup/pointercancel 이 안 왔다고 가정 — armed 가 안 풀렸다면 아래 begin 은 무시된다.
    const second = vi.fn();
    beginLongPress(second);
    vi.advanceTimersByTime(400);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("중첩 규칙: 같은 제스처 안에서는 먼저 부른 쪽(안쪽)이 이기고 바깥쪽은 무시된다", () => {
    const inner = vi.fn();
    const outer = vi.fn();
    // 포인터 이벤트는 안쪽 → 바깥쪽 순으로 동기 버블 — 같은 틱 안에서 둘 다 호출된다.
    beginLongPress(inner);
    beginLongPress(outer); // armed 가 이미 true라 즉시 리턴, outer 타이머는 시작 안 함

    vi.advanceTimersByTime(400);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("cancelLongPress 는 발동 전 타이머를 취소하고 재무장을 허용한다", () => {
    const cb = vi.fn();
    beginLongPress(cb);
    vi.advanceTimersByTime(200);
    cancelLongPress();
    vi.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();

    const cb2 = vi.fn();
    beginLongPress(cb2);
    vi.advanceTimersByTime(400);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("발동 뒤 손을 뗄 때까지 브라우저의 선택 시작·컨텍스트 메뉴를 막고, 떼면 풀린다 (V4)", () => {
    const sel = () => {
      const e = new Event("selectstart", { cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const ctx = () => {
      const e = new Event("contextmenu", { cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(sel()).toBe(false); // 평소엔 건드리지 않는다
    beginLongPress(() => {});
    vi.advanceTimersByTime(400);
    expect(sel()).toBe(true);
    expect(ctx()).toBe(true);
    document.dispatchEvent(new Event("pointerup"));
    expect(sel()).toBe(false);
    expect(ctx()).toBe(false);
  });

  it("pointerup 이 끝내 안 와도 안전 시한 뒤 스스로 풀린다", () => {
    beginLongPress(() => {});
    vi.advanceTimersByTime(400);
    vi.advanceTimersByTime(3000);
    const e = new Event("selectstart", { cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("longPress slop (V12)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelLongPress();
    consumeLongPress();
    document.dispatchEvent(new Event("pointerup"));
  });
  afterEach(() => {
    cancelLongPress();
    vi.useRealTimers();
  });

  it("반경 안의 떨림은 취소하지 않는다", () => {
    const cb = vi.fn();
    beginLongPress(cb, 400, { clientX: 100, clientY: 100 });
    moveLongPress({ clientX: 105, clientY: 104 });
    vi.advanceTimersByTime(400);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("반경을 넘으면 취소한다", () => {
    const cb = vi.fn();
    beginLongPress(cb, 400, { clientX: 100, clientY: 100 });
    moveLongPress({ clientX: 100, clientY: 125 });
    vi.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();
  });

  it("시작 이벤트 없이 begin 했으면 옛 동작 그대로 어떤 움직임이든 취소", () => {
    const cb = vi.fn();
    beginLongPress(cb);
    moveLongPress({ clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();
  });
});
