/**
 * 포인터 드래그 세션의 **뼈대** 하나 — 시작(포인터 캡처 + 시작 좌표) · 임계 판정 · 이동 · 종료 ·
 * 취소 · 뒤따르는 click 한 번 삼키기. 그 여섯 가지가 전부다.
 *
 * **추측으로 미리 만든 추상화가 아니다.** DayDetailPanel 이 같은 모양을 **세 벌** 손으로 쓰고
 * 있었다 — 종일 카드를 축으로 끌어 놓기(W7) · 칩 이동/리사이즈(W3·W5 ①) · 축의 빈 곳을 끌어
 * 생성(W5 ②). 셋 다 ref 로 세션을 추적하고, `DRAG_THRESHOLD_PX` 로 클릭과 가르고,
 * `setPointerCapture` 를 걸고, 드래그 뒤 click 을 한 번 삼켰다. 세 번째 사용처가 실제로 생긴
 * 뒤에야 뽑았다(CLAUDE.md 코드 방침: "새 추상화는 두 번째 사용처가 실제로 있을 때만").
 *
 * **도메인은 모른다.** 시각도, 행도, 저장도 여기 없다 — 무엇을 미리보기로 그리고 무엇을
 * 저장하는지는 전부 콜백이 정한다. 픽셀↔분 산수는 calendarLayout.ts 가 계속 소유한다.
 *
 * W15 ① — **Escape 로 취소.** 세션이 열려 있는 동안(isActive)의 Escape 는 아직 아무것도 저장하지
 * 않은 상태로 되돌린다 — 전에는 마음이 바뀌면 손을 떼서 커밋한 뒤 되돌리기 토스트를 눌러야 했다.
 * 처리는 `pointercancel` 과 **같은 한 자리**(cancelSession)를 타고, "무엇을 지울지"는 여전히
 * `onCancel` 콜백이 정한다(이 훅은 도메인을 모른다).
 *
 * W9 ③ — **터치는 길게 눌러야 열린다.** 그 전까지는 세션이 "무장 해제"(armed:false) 상태로,
 * 손가락이 움직이면 세션을 접고 스크롤을 브라우저에 그대로 넘긴다. 마우스/펜은 예전처럼 즉시
 * 열린다(`ev.pointerType`). 이 규칙이 훅에 있는 이유는 세 사용처(카드 그립 · 칩 · 축의 빈 곳)가
 * 전부 같아야 하기 때문이고, 그게 W8 에서 이 훅을 뽑은 이유다.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { DRAG_THRESHOLD_PX } from "../calendarLayout";
import { pushOverlay } from "../../../lib/overlayStack";

/** 터치에서 드래그가 열리기까지 손가락이 가만히 있어야 하는 시간. 400~500ms 구간의 가운데를
 *  골랐다 — 400 은 스크롤하려던 손을 자주 붙잡고, 500 은 "안 잡히나?" 싶어진다. */
const LONG_PRESS_MS = 450;

/** 콜백이 보는 한 순간의 드래그 — 시작 좌표, 지금 좌표, 그 차이. 좌표는 전부 클라이언트 기준이고
 *  컨테이너 기준으로 바꾸는 일(rect 빼기)은 호출자 몫이다. */
export type DragSession<T> = {
  /** 세션을 열 때 넘긴 값 — 어떤 카드인가 / 어떤 칩을 어느 모드로 잡았나. */
  data: T;
  x0: number;
  y0: number;
  clientX: number;
  clientY: number;
  dx: number;
  dy: number;
};

/** 세션이 진행 중인 동안 요소에 걸어 두는 나머지 핸들러들. `onPointerDown` 은 세션마다 넘길
 *  `data` 가 달라 호출자가 직접 만든다(`begin(data, ev)`). */
export type DragHandlers = {
  onPointerMove: (ev: ReactPointerEvent<Element>) => void;
  onPointerUp: (ev: ReactPointerEvent<Element>) => void;
  onPointerCancel: () => void;
};

export function useAxisDragSession<T>({
  axis = "xy",
  onMove,
  onDrop,
  onCancel,
  onLongPress,
}: {
  /** 임계를 어느 축으로 재나. 칩 드래그는 세로 이동만 뜻이 있어 "y" 다 — 가로로만 흔든 손짓은
   *  클릭으로 남는다(W3 때부터의 동작). 기본은 둘 다 보는 "xy". */
  axis?: "y" | "xy";
  /** 임계를 넘긴 뒤의 매 이동. 넘기기 전에는 한 번도 불리지 않는다. */
  onMove: (s: DragSession<T>) => void;
  /** 임계를 넘긴 드래그가 끝났다. 임계 미만이면 불리지 않는다(= 그냥 클릭). */
  onDrop: (s: DragSession<T>) => void;
  /** pointercancel · Escape(W15 ①) — 그리던 미리보기를 지우는 자리. 임계 미만 종료에는 불리지
   *  않는다(그때는 onMove 가 한 번도 안 돌아 지울 것이 없고, 앞선 드래그의 낙관적 표시를 지우면
   *  안 된다). */
  onCancel?: () => void;
  /** 움직이지 않고 LONG_PRESS_MS 이상 누르고 있다 뗐다(마우스·터치 공통) — 드래그도 클릭도 아니다. 호출 뒤 따라오는 click 은
   *  삼켜진다. 안 주면 그런 손짓은 예전처럼 클릭이다. (칩: 일정 수정 모달) */
  onLongPress?: (data: T) => void;
}) {
  const session = useRef<{
    data: T;
    pointerId: number;
    x0: number;
    y0: number;
    moved: boolean;
    /** 누른 시각(ms) — 뗄 때 롱프레스인지 가른다. */
    t0: number;
    /** 드래그가 실제로 열렸나. 터치의 롱프레스 대기 중에만 false 다. */
    armed: boolean;
    /** 세션을 연 요소 — React 는 핸들러가 끝나면 `currentTarget` 을 비우므로 붙잡아 둔다. */
    el: Element;
    /** 롱프레스가 건드린 인라인 스타일의 원래 값. 끝나면 되돌린다. */
    saved: { touchAction: string; outline: string } | null;
    /** Escape 체인(lib/overlayStack) 등록 해제 — 드래그가 실제로 보이는 동안만 올라가 있다. */
    releaseOverlay: (() => void) | null;
  } | null>(null);
  /** 드래그로 끝난 포인터가 뒤이어 던지는 click 을 한 번만 삼킨다. */
  const swallow = useRef(false);
  /** 롱프레스 타이머. 손을 떼거나 움직이거나 취소되거나 언마운트되면 반드시 정리된다. */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPressTimer = () => {
    if (pressTimer.current === null) return;
    clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  /** 끌고 있는 동안은 Escape 체인에 한 단계로 올라간다 — 그래야 보조 창 크롬(AuxWindowChrome)의
   *  "아무도 안 받은 Escape = 창 닫기"가 드래그 취소 Escape 에 창을 닫지 않는다(브리핑 창이 같은 축을
   *  쓰면서 드러났다, GRILL-2026-10-19 W4 검증). 대시보드 메인 창은 Escape 로 닫히지 않아 몰랐다. */
  const armOverlay = (s: { releaseOverlay: (() => void) | null }) => {
    if (!s.releaseOverlay) s.releaseOverlay = pushOverlay(() => cancelRef.current());
  };
  const releaseOverlay = (s: { releaseOverlay: (() => void) | null } | null) => {
    if (!s?.releaseOverlay) return;
    s.releaseOverlay();
    s.releaseOverlay = null;
  };
  useEffect(
    () => () => {
      clearPressTimer();
      releaseOverlay(session.current);
    },
    [],
  );

  const view = (
    s: { data: T; x0: number; y0: number },
    ev: { clientX: number; clientY: number },
  ): DragSession<T> => ({
    data: s.data,
    x0: s.x0,
    y0: s.y0,
    clientX: ev.clientX,
    clientY: ev.clientY,
    dx: ev.clientX - s.x0,
    dy: ev.clientY - s.y0,
  });

  const passedThreshold = (dx: number, dy: number) =>
    (axis === "y" ? Math.abs(dy) : Math.hypot(dx, dy)) >= DRAG_THRESHOLD_PX;

  type Session = NonNullable<typeof session.current>;

  const capture = (s: Session) => {
    try {
      s.el.setPointerCapture(s.pointerId);
    } catch {
      /* jsdom */
    }
  };

  /** 롱프레스가 열리는 순간의 신호 — 잡힌 요소를 accent 링으로 두른다(새 토큰 없이 기존 것으로).
   *  같이 `touch-action: none` 을 걸어 그 다음 손가락 이동이 스크롤로 새지 않게 한다.
   *  ponytail: 브라우저가 이미 이 제스처의 팬 여부를 정해 뒀으면 여기서 걸어도 늦어 스크롤이
   *  이겨 pointercancel 로 끝난다(실기 터치 미검증). 그때 올릴 길은 pointerdown 에서 막고
   *  롱프레스가 불발되면 풀어 주는 것 — 대신 그 사이 스크롤이 한 박자 죽는다. */
  const grabSignal = (s: Session) => {
    const el = s.el as HTMLElement;
    if (!el.style) return;
    s.saved = { touchAction: el.style.touchAction, outline: el.style.outline };
    el.style.touchAction = "none";
    el.style.outline = "2px solid var(--accent)";
  };

  const restoreSignal = (s: Session) => {
    if (!s.saved) return;
    const el = s.el as HTMLElement;
    el.style.touchAction = s.saved.touchAction;
    el.style.outline = s.saved.outline;
    s.saved = null;
  };

  /** 주 버튼이면 세션을 연다. 호출자가 더 볼 조건(칩 위인가 등)은 부르기 전에 본다.
   *  터치는 곧바로 열지 않는다(③) — LONG_PRESS_MS 동안 가만히 있어야 무장된다. */
  const begin = (data: T, ev: ReactPointerEvent<Element>) => {
    if (ev.button !== 0) return;
    const touch = ev.pointerType === "touch";
    const s: Session = {
      data,
      pointerId: ev.pointerId,
      x0: ev.clientX,
      y0: ev.clientY,
      moved: false,
      t0: Date.now(),
      armed: !touch,
      el: ev.currentTarget,
      saved: null,
      releaseOverlay: null,
    };
    releaseOverlay(session.current);
    session.current = s;
    clearPressTimer();
    if (!touch) {
      capture(s);
      return;
    }
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      if (session.current !== s) return; // 그 사이에 끝났거나 다른 세션이 열렸다.
      s.armed = true;
      capture(s);
      grabSignal(s);
      armOverlay(s);
    }, LONG_PRESS_MS);
  };

  /** 아직 아무것도 저장하지 않은 상태로 되돌린다 — pointercancel(브라우저가 제스처를 가져갔다)과
   *  Escape(W15 ①, 사용자가 마음을 바꿨다)가 **같은 처리**를 탄다. 캡처 해제는 pointercancel 에서는
   *  브라우저가 이미 했으므로 no-op 이고, Escape 에서는 여기가 유일한 자리다. */
  const cancelSession = () => {
    const s = session.current;
    clearPressTimer();
    if (s) {
      releaseOverlay(s);
      restoreSignal(s);
      try {
        s.el.releasePointerCapture(s.pointerId);
      } catch {
        /* jsdom · 이미 해제됨 */
      }
    }
    session.current = null;
    onCancel?.();
  };

  /** window 리스너는 한 번만 걸고 "지금 드래그 중인가"는 ref 로 본다 — 세션은 state 가 아니라
   *  ref 라(재렌더를 부르지 않는다) `active` 를 deps 로 쓰는 형태가 성립하지 않는다.
   *  드래그가 열려 있지 않은 Escape 는 그대로 흘려보낸다: 이 파일 밖의 다른 소비자(열린 모달 ·
   *  useDismissOnOutside 를 쓰는 메뉴)가 자기 것을 받아야 한다. 드래그 중에는 그것들이 열려 있을 수
   *  없어(모달이 열린 칩은 끌리지 않는다) 실제로 겹치지 않는다 — 그래서 preventDefault 도
   *  하지 않는다(같은 window 의 다른 리스너는 어차피 막을 수 없다). */
  const cancelRef = useRef(cancelSession);
  cancelRef.current = cancelSession;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (session.current?.armed !== true) return;
      cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handlers: DragHandlers = {
    onPointerMove: (ev) => {
      const s = session.current;
      if (!s || s.pointerId !== ev.pointerId) return;
      const now = view(s, ev);
      if (!s.armed) {
        // 롱프레스 전에 손가락이 움직였다 = 스크롤이다. 세션을 접고 브라우저에 넘긴다.
        // 여기서는 axis 를 보지 않는다 — 어느 방향이든 "가만히 있지 않았다"는 뜻이다.
        if (Math.hypot(now.dx, now.dy) < DRAG_THRESHOLD_PX) return; // 손 떨림은 무시
        clearPressTimer();
        session.current = null;
        return;
      }
      if (!s.moved && !passedThreshold(now.dx, now.dy)) return;
      s.moved = true;
      armOverlay(s);
      onMove(now);
    },
    onPointerUp: (ev) => {
      const s = session.current;
      if (!s || s.pointerId !== ev.pointerId) return;
      clearPressTimer();
      releaseOverlay(s);
      restoreSignal(s);
      session.current = null;
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* jsdom */
      }
      // 임계 미만 = 클릭(또는 롱프레스 전에 뗀 탭). 포커스/더블클릭이 그대로 산다.
      if (!s.moved) {
        if (onLongPress && s.armed && Date.now() - s.t0 >= LONG_PRESS_MS) {
          swallow.current = true;
          setTimeout(() => {
            swallow.current = false;
          }, 0);
          onLongPress(s.data);
        }
        return;
      }
      swallow.current = true;
      // click 이 안 따라오면(캡처 없이 다른 곳에서 떼어진 경우) 다음 클릭까지 물고 있지 않게
      // 푼다 — useTimelineDrag 의 suppressNextClick 이 같은 이유로 setTimeout(0) 을 쓴다.
      setTimeout(() => {
        swallow.current = false;
      }, 0);
      onDrop(view(s, ev));
    },
    onPointerCancel: cancelSession,
  };

  return {
    begin,
    handlers,
    /** 드래그 직후의 click 이면 true 를 돌려주고 표식을 소비한다 — 호출자는 그때 onClick 을
     *  통째로 건너뛴다(옮기는 손짓이 포커스까지 바꾸면 아래 상세 블록이 같이 튄다). */
    swallowClick: () => {
      if (!swallow.current) return false;
      swallow.current = false;
      return true;
    },
    /** 드래그가 열려 있나 — 드래그 중에는 hover 커서 계산 같은 걸 멈추는 데 쓴다.
     *  터치의 롱프레스 대기는 아직 드래그가 아니라 false 다. */
    isActive: () => session.current?.armed === true,
  };
}
