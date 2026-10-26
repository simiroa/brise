/**
 * 드래그 세션 뼈대의 단위 테스트 — 임계 · 이동 · 종료 · 취소 · click 삼키기.
 * 도메인(시각·행·저장)은 여기 없다. 그건 DayDetailPanel.test.tsx 가 세 사용처로 지킨다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAxisDragSession } from "./useAxisDragSession";
import { DRAG_THRESHOLD_PX } from "../calendarLayout";
import { isOverlayOpen } from "../../../lib/overlayStack";

/** 실제 PointerEvent 대신 핸들러가 읽는 필드만 있는 최소 객체 — 캡처 API 는 없으니 hook 의
 *  try/catch 가 삼킨다(jsdom 에서도 같은 경로다). */
function ev(
  pointerId: number,
  x: number,
  y: number,
  button = 0,
  pointerType = "mouse",
  currentTarget: unknown = {},
) {
  return {
    button,
    pointerId,
    clientX: x,
    clientY: y,
    pointerType,
    currentTarget: currentTarget as Element,
  } as unknown as React.PointerEvent<Element>;
}

/** 롱프레스가 건드리는 것은 요소의 인라인 스타일 두 개뿐 — `style` 만 있는 가짜로 충분하다. */
const touchTarget = () => ({ style: { touchAction: "", outline: "" } });

function setup(opts: { axis?: "y" | "xy" } = {}) {
  const onMove = vi.fn();
  const onDrop = vi.fn();
  const onCancel = vi.fn();
  const { result, unmount } = renderHook(() =>
    useAxisDragSession<string>({ ...opts, onMove, onDrop, onCancel }),
  );
  return { d: () => result.current, onMove, onDrop, onCancel, unmount };
}

describe("useAxisDragSession", () => {
  // GRILL-2026-10-19 W4 검증: 브리핑 창(AuxWindowChrome)은 Escape 체인이 비었을 때만 창을 닫는다 —
  // 끄는 중의 Escape 가 드래그 취소가 아니라 창 닫기가 되던 것.
  it("끌고 있는 동안만 Escape 체인에 올라가고, 놓기·취소·Escape·언마운트로 내려온다", () => {
    const { d, onCancel, unmount } = setup();
    d().begin("chip", ev(1, 0, 100));
    expect(isOverlayOpen()).toBe(false); // 아직 클릭일 수 있다
    d().handlers.onPointerMove(ev(1, 0, 140));
    expect(isOverlayOpen()).toBe(true);
    d().handlers.onPointerUp(ev(1, 0, 140));
    expect(isOverlayOpen()).toBe(false);

    d().begin("chip", ev(2, 0, 100));
    d().handlers.onPointerMove(ev(2, 0, 140));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isOverlayOpen()).toBe(false);

    d().begin("chip", ev(3, 0, 100));
    d().handlers.onPointerMove(ev(3, 0, 140));
    expect(isOverlayOpen()).toBe(true);
    unmount();
    expect(isOverlayOpen()).toBe(false);
  });

  it("임계 미만이면 드래그가 아니다 — onMove 도 onDrop 도 없고 click 도 안 삼킨다", () => {
    const { d, onMove, onDrop, onCancel } = setup();
    d().begin("card", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 100 + DRAG_THRESHOLD_PX - 1));
    d().handlers.onPointerUp(ev(1, 0, 100 + DRAG_THRESHOLD_PX - 1));
    expect(onMove).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    // 임계 미만 종료는 취소가 아니다 — 앞선 드래그의 낙관적 표시를 지워서는 안 된다.
    expect(onCancel).not.toHaveBeenCalled();
    expect(d().swallowClick()).toBe(false);
  });

  it("임계를 넘기면 이동마다 onMove — 시작 좌표와 델타를 함께 준다", () => {
    const { d, onMove } = setup();
    d().begin("card", ev(1, 10, 100));
    d().handlers.onPointerMove(ev(1, 10, 120));
    d().handlers.onPointerMove(ev(1, 30, 130));
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove.mock.calls[1][0]).toMatchObject({
      data: "card",
      x0: 10,
      y0: 100,
      clientX: 30,
      clientY: 130,
      dx: 20,
      dy: 30,
    });
  });

  it("한 번 임계를 넘기면 다시 안으로 돌아와도 드래그다", () => {
    const { d, onMove, onDrop } = setup();
    d().begin("card", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 120));
    d().handlers.onPointerMove(ev(1, 0, 100)); // 제자리
    d().handlers.onPointerUp(ev(1, 0, 100));
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toMatchObject({ dy: 0 });
  });

  it("axis 'y' 는 가로 이동을 세지 않는다 — 가로로만 흔들면 클릭으로 남는다", () => {
    const { d, onMove, onDrop } = setup({ axis: "y" });
    d().begin("chip", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 100, 100));
    expect(onMove).not.toHaveBeenCalled();
    d().handlers.onPointerMove(ev(1, 100, 110));
    expect(onMove).toHaveBeenCalledTimes(1);
    d().handlers.onPointerUp(ev(1, 100, 110));
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("pointercancel 은 onCancel 만 부르고 세션을 닫는다 — onDrop 은 없다", () => {
    const { d, onDrop, onCancel } = setup();
    d().begin("card", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 140));
    d().handlers.onPointerCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(d().isActive()).toBe(false);
    // 닫힌 뒤의 이동은 무시된다.
    d().handlers.onPointerMove(ev(1, 0, 200));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("진짜 드래그 뒤의 click 은 딱 한 번 삼킨다", () => {
    const { d } = setup();
    d().begin("card", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 140));
    d().handlers.onPointerUp(ev(1, 0, 140));
    expect(d().swallowClick()).toBe(true);
    expect(d().swallowClick()).toBe(false); // 두 번째 click 은 그대로 산다
  });

  it("click 이 안 따라오면 다음 클릭까지 물고 있지 않는다 (setTimeout 0 으로 풀린다)", async () => {
    vi.useFakeTimers();
    try {
      const { d } = setup();
      d().begin("card", ev(1, 0, 100));
      d().handlers.onPointerMove(ev(1, 0, 140));
      d().handlers.onPointerUp(ev(1, 0, 140));
      vi.advanceTimersByTime(0);
      expect(d().swallowClick()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("다른 포인터(멀티터치의 둘째 손가락)의 이벤트는 무시한다", () => {
    const { d, onMove, onDrop } = setup();
    d().begin("card", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(2, 0, 200));
    d().handlers.onPointerUp(ev(2, 0, 200));
    expect(onMove).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(d().isActive()).toBe(true); // 원래 세션은 살아 있다
  });

  it("주 버튼이 아니면 세션이 열리지 않는다", () => {
    const { d, onMove } = setup();
    d().begin("card", ev(1, 0, 100, 2)); // 우클릭
    expect(d().isActive()).toBe(false);
    d().handlers.onPointerMove(ev(1, 0, 200));
    expect(onMove).not.toHaveBeenCalled();
  });
});

/**
 * W15 ① — 드래그 도중 Escape = 취소. pointercancel 과 **같은 처리**를 타고(onCancel 한 자리),
 * 세션이 열려 있지 않은 Escape 는 남의 것이라 건드리지 않는다(플로팅 메뉴 둘 · useDismissOnOutside).
 */
describe("useAxisDragSession — Escape 로 취소 (W15 ①)", () => {
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  it("드래그 중 Escape → 세션이 닫히고 onCancel 만 불린다 (onDrop 없음)", () => {
    const { d, onCancel, onDrop } = setup();
    d().begin("chip", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 140));
    escape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(d().isActive()).toBe(false);
    // 취소된 뒤의 이동·종료는 아무 일도 아니다 — 손을 떼도 저장되지 않는다.
    d().handlers.onPointerMove(ev(1, 0, 200));
    d().handlers.onPointerUp(ev(1, 0, 200));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("드래그가 열려 있지 않은 Escape 는 흘려보낸다 — 남의 Escape 를 삼키지 않는다", () => {
    const { d, onCancel } = setup();
    escape(); // 세션 없음(메뉴만 열려 있는 상태)
    expect(onCancel).not.toHaveBeenCalled();
    // 터치의 롱프레스 대기(아직 무장 전)도 드래그가 아니다.
    vi.useFakeTimers();
    try {
      d().begin("chip", ev(1, 0, 100, 0, "touch", { style: { touchAction: "", outline: "" } }));
      escape();
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape 는 롱프레스의 신호(outline · touch-action)도 되돌린다", () => {
    vi.useFakeTimers();
    try {
      const target = touchTarget();
      const { d, onCancel } = setup();
      d().begin("chip", ev(1, 0, 100, 0, "touch", target));
      vi.advanceTimersByTime(450);
      expect(d().isActive()).toBe(true);
      escape();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(target.style.outline).toBe("");
      expect(target.style.touchAction).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("언마운트되면 Escape 리스너가 정리된다", () => {
    const { d, onCancel, unmount } = setup();
    d().begin("chip", ev(1, 0, 100));
    d().handlers.onPointerMove(ev(1, 0, 140));
    unmount();
    escape();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

/**
 * W9 ③ — 터치는 **길게 눌러야** 드래그가 열린다. 그 전의 손가락 이동은 스크롤로 남는다.
 * 시간에 기대지 않도록 전부 가짜 타이머로 고정한다.
 */
describe("useAxisDragSession — 터치 롱프레스 (W9 ③)", () => {
  const LONG_PRESS_MS = 450;
  const touch = (pointerId: number, x: number, y: number, target?: unknown) =>
    ev(pointerId, x, y, 0, "touch", target ?? {});

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("롱프레스 전에 손가락이 움직이면 드래그가 아니다 — 세션을 접고 스크롤에 넘긴다", () => {
    const { d, onMove, onDrop } = setup();
    d().begin("card", touch(1, 0, 100));
    d().handlers.onPointerMove(touch(1, 0, 140));
    // 아직 무장 전이라 이동이 아니라 "스크롤하려는 손"이다.
    expect(onMove).not.toHaveBeenCalled();
    expect(d().isActive()).toBe(false);
    // 뒤늦게 타이머가 돌아도 되살아나지 않는다(정리됐다).
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    d().handlers.onPointerMove(touch(1, 0, 200));
    d().handlers.onPointerUp(touch(1, 0, 200));
    expect(onMove).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("손 떨림(임계 미만)은 롱프레스를 깨지 않는다", () => {
    const { d, onMove } = setup();
    d().begin("card", touch(1, 0, 100));
    d().handlers.onPointerMove(touch(1, 0, 102)); // 2px
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(d().isActive()).toBe(true);
    d().handlers.onPointerMove(touch(1, 0, 140));
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("가만히 LONG_PRESS_MS 를 넘기면 드래그가 열린다 — 그 순간 신호와 touch-action", () => {
    const target = touchTarget();
    const { d, onMove, onDrop } = setup();
    d().begin("card", touch(1, 0, 100, target));
    // 아직은 아니다.
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(d().isActive()).toBe(false);
    expect(target.style.touchAction).toBe("");

    vi.advanceTimersByTime(1);
    expect(d().isActive()).toBe(true);
    // 잡혔다는 시각 신호 + 그 다음 이동이 스크롤로 새지 않게 막는다.
    expect(target.style.outline).toBe("2px solid var(--accent)");
    expect(target.style.touchAction).toBe("none");

    d().handlers.onPointerMove(touch(1, 0, 140, target));
    d().handlers.onPointerUp(touch(1, 0, 140, target));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    // 끝나면 둘 다 원래대로.
    expect(target.style.outline).toBe("");
    expect(target.style.touchAction).toBe("");
  });

  it("pointercancel 도 신호를 되돌리고 타이머를 정리한다", () => {
    const target = touchTarget();
    const { d, onCancel } = setup();
    d().begin("card", touch(1, 0, 100, target));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    d().handlers.onPointerCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(target.style.touchAction).toBe("");
    expect(target.style.outline).toBe("");
    expect(d().isActive()).toBe(false);
  });

  it("롱프레스 전에 손을 떼면 탭이다 — 타이머가 뒤늦게 세션을 무장시키지 않는다", () => {
    const target = touchTarget();
    const { d, onDrop } = setup();
    d().begin("card", touch(1, 0, 100, target));
    d().handlers.onPointerUp(touch(1, 0, 100, target));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(d().isActive()).toBe(false);
    expect(target.style.touchAction).toBe("");
    expect(onDrop).not.toHaveBeenCalled();
    expect(d().swallowClick()).toBe(false); // 클릭(포커스)이 그대로 산다
  });

  it("언마운트되면 대기 중인 타이머가 정리된다", () => {
    const target = touchTarget();
    const { d, unmount } = setup();
    d().begin("card", touch(1, 0, 100, target));
    unmount();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(target.style.touchAction).toBe(""); // 언마운트 뒤에 무장하지 않는다
  });

  it("마우스는 예전처럼 즉시 열린다 — 롱프레스도 스타일 손대기도 없다", () => {
    const target = touchTarget();
    const { d, onMove } = setup();
    d().begin("card", ev(1, 0, 100, 0, "mouse", target));
    expect(d().isActive()).toBe(true);
    d().handlers.onPointerMove(ev(1, 0, 140, 0, "mouse", target));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(target.style.touchAction).toBe("");
    expect(target.style.outline).toBe("");
  });
});
