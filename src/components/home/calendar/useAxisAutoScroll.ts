/**
 * W17: 시간축의 **가장자리 자동 스크롤** — 드래그 중 손이 축의 위/아래 가장자리에 닿으면 축이
 * 그 방향으로 계속 흐른다.
 *
 * 축은 24시간을 보이는 창만큼씩 스크롤하므로, 화면에 없는 시간대로는 한 번의 드래그로 갈 수
 * 없었다. 세 드래그(칩 이동/리사이즈 · 빈 곳 생성 · 종일 카드 드롭)가 같은 규칙을 쓰도록
 * **여기 한 곳**에만 둔다 — useAxisDragSession 은 DOM 도 도메인도 모르는 뼈대라 이 로직이
 * 들어갈 자리가 아니다(그 이음매 옆에 나란히 둔 이유이기도 하다).
 *
 * 순수 이동(동작 변경 0): 본문은 DayDetailPanel.tsx 의 TimeAxis 안에 있던 블록 그대로다.
 * 매 렌더 새로 만들어지는 평범한 함수들이라(메모이즈하지 않는다) `dayAxisH` 가 바뀌면 다음
 * 루프부터 새 값을 쓴다 — 옮기기 전과 같다.
 */
import { useEffect, useRef, type RefObject } from "react";

/* W17 자동 스크롤의 세 상수 — 전부 **동작** 값이다(애니메이션 속도·감지 폭). CSS 로 나가는
 * 디자인 값이 아니라 스케일 사다리와 무관하고, 그래서 토큰으로 두지 않는다. */
/** 이만큼 안쪽까지 오면 "가장자리에 있다"고 본다. 칩 한 줄 높이(HOUR_ROW_H=28)보다 조금 크게 —
 *  더 좁으면 손이 통과해 버려 안 걸리고, 더 넓으면 아직 화면 안을 겨누는 손짓까지 축을 흘린다. */
const AUTO_SCROLL_EDGE_PX = 32;
/** 한 틱에 미는 픽셀. 16ms 틱이면 초당 ~440px = 15분 눈금 기준 약 16분/초 — 24시간을 1.5초에
 *  훑는다. 가장자리 깊이에 따라 빠르게 하지 않았다: 한 속도로도 하루를 도는 데 충분하다. */
const AUTO_SCROLL_PX_PER_TICK = 7;
/** ~60fps. requestAnimationFrame 이 아니라 setInterval 인 이유는 trackAutoScroll 주석에. */
const AUTO_SCROLL_TICK_MS = 16;

export type AxisAutoScroll = {
  /** 드래그가 지금 이 높이에 있다 — 가장자리면 밀기 시작/유지, 벗어나면 멈춘다. */
  trackAutoScroll: (clientY: number, resync: () => void) => void;
  stopAutoScroll: () => void;
  /** 자동 스크롤이 축을 민 만큼을 손짓에 더한 값. */
  dragDeltaPx: (dy: number, scrollTop0: number) => number;
};

/**
 * @param axisRef 축의 스크롤 컨테이너(보이는 창). 이 훅이 미는 대상이다.
 * @param dayAxisH 캔버스 전체 높이(= hourRowH * 24). 위/아래 끝을 넘겨 밀지 않기 위한 상한.
 */
export function useAxisAutoScroll(
  axisRef: RefObject<HTMLDivElement | null>,
  dayAxisH: number,
): AxisAutoScroll {
  /** 돌고 있는 루프와 그 방향(-1 위 / 1 아래). null = 안 돌고 있다. */
  const autoScroll = useRef<{ id: ReturnType<typeof setInterval>; dir: -1 | 1 } | null>(null);
  /** 밀고 난 뒤 미리보기를 다시 계산하는 자리 — 각 드래그의 onMove 본문 그대로다. 포인터가
   *  가만히 있으면 pointermove 가 안 오므로, 이것을 루프가 대신 불러야 미리보기가 축과 같이
   *  움직인다(안 그러면 칩이 커서를 놓치고 위로 흘러간다). */
  const autoScrollResync = useRef<(() => void) | null>(null);
  const stopAutoScroll = () => {
    autoScrollResync.current = null;
    if (!autoScroll.current) return;
    clearInterval(autoScroll.current.id);
    autoScroll.current = null;
  };
  // 언마운트(날짜를 바꾸거나 목록을 펼쳐 축이 사라지는 경우)에도 루프는 끊어져야 한다.
  useEffect(() => stopAutoScroll, []);

  /** 드래그가 지금 이 높이에 있다 — 가장자리면 그 방향으로 **계속** 밀고, 벗어나면 멈춘다.
   *
   *  `setInterval` 이다: requestAnimationFrame 이 더 정직한 틱이지만 이 루프가 하는 일은
   *  "scrollTop 에 상수를 더한다" 뿐이라 프레임에 맞출 이유가 없고, 가짜 타이머로 고정하기가
   *  훨씬 쉽다(시간축의 현재 시각 눈금도 같은 이유로 setInterval 이다).
   *
   *  **위/아래 끝을 넘겨 밀지 않는다** — 최대치는 캔버스 높이(dayAxisH) 빼기 보이는 높이다.
   *  `scrollHeight - clientHeight` 가 정공법이지만 jsdom 에는 레이아웃이 없어 둘 다 0 이고,
   *  캔버스의 높이는 우리가 픽셀로 정한 상수라 rect 로 유도해도 같은 값이다.
   *
   *  포인터가 스크롤러의 위아래 **밖**이면 아무 일도 없다. 종일 카드는 축 바로 위 스트립에서
   *  끌려오므로, 밖까지 가장자리로 치면 카드를 집는 순간부터 축이 위로 흘러 버린다. */
  const trackAutoScroll = (clientY: number, resync: () => void) => {
    const el = axisRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const dir =
      clientY < box.top || clientY > box.bottom
        ? 0
        : clientY <= box.top + AUTO_SCROLL_EDGE_PX
          ? -1
          : clientY >= box.bottom - AUTO_SCROLL_EDGE_PX
            ? 1
            : 0;
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    // 같은 방향으로 이미 돌고 있으면 루프는 그대로 두고 resync 만 갈아 끼운다(아래).
    if (autoScroll.current?.dir !== dir) {
      stopAutoScroll();
      autoScroll.current = { id: startAutoScrollLoop(dir), dir };
    }
    // **stopAutoScroll 뒤에** 얹는다 — 그쪽이 이 자리를 비우기 때문이다(순서를 뒤집으면 방금
    // 넣은 resync 가 지워져 미리보기가 축을 따라오지 않는다. 실제로 그렇게 한 번 틀렸다).
    autoScrollResync.current = resync;
  };

  /** 한 방향으로 계속 미는 루프 하나. 멈추는 판단은 위 trackAutoScroll 이 한다. */
  const startAutoScrollLoop = (dir: -1 | 1) =>
    setInterval(() => {
      const cur = axisRef.current;
      if (!cur) {
        stopAutoScroll();
        return;
      }
      const max = Math.max(0, dayAxisH - cur.getBoundingClientRect().height);
      const before = cur.scrollTop;
      cur.scrollTop = Math.min(max, Math.max(0, before + dir * AUTO_SCROLL_PX_PER_TICK));
      // 끝에 닿아 한 픽셀도 못 움직였으면 다시 그릴 것도 없다 — 가만히 댄 채로 두면 60fps 로
      // 같은 값을 setState 하게 된다(루프는 그대로 둔다, 손이 다시 움직이면 곧 이어진다).
      if (cur.scrollTop === before) return;
      autoScrollResync.current?.();
    }, AUTO_SCROLL_TICK_MS);

  /** 자동 스크롤이 축을 민 만큼은 손짓에 **더해야** 한다 — 칩·새 범위의 자리는 캔버스 기준
   *  픽셀로 계산되는데, 축이 흐르면 같은 clientY 가 다른 분을 뜻하게 된다. 스크롤 한 번 읽어
   *  더하는 것으로 끝난다(캔버스 rect 를 다시 읽는 것과 같은 값 — 스크롤이 곧 그 차이다).
   *  드래그 중 사용자가 휠로 스크롤해도 같은 보정을 받는다. */
  const dragDeltaPx = (dy: number, scrollTop0: number) =>
    dy + ((axisRef.current?.scrollTop ?? 0) - scrollTop0);

  return { trackAutoScroll, stopAutoScroll, dragDeltaPx };
}
