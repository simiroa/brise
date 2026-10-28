/**
 * W17: 시간축의 **가장자리 자동 스크롤** — 드래그 중 손이 축의 위/아래 가장자리에 닿으면 축이
 * 그 방향으로 계속 흐른다.
 *
 * 축은 24시간을 보이는 창만큼씩 스크롤하므로, 화면에 없는 시간대로는 한 번의 드래그로 갈 수
 * 없었다. 세 드래그(칩 이동/리사이즈 · 빈 곳 생성 · 종일 카드 드롭)가 같은 규칙을 쓰도록
 * **여기 한 곳**에만 둔다 — useAxisDragSession 은 DOM 도 도메인도 모르는 뼈대라 이 로직이
 * 들어갈 자리가 아니다(그 이음매 옆에 나란히 둔 이유이기도 하다).
 *
 * 루프는 requestAnimationFrame 이다(예전엔 16ms setInterval + 고정 7px/틱): 가장자리에 ~250ms 머문 뒤에만
 * 흐르고, 속도는 가장자리 깊이에 비례하며, 서브픽셀을 누적해 스냅 칸(7px)과 속도가 얽히지 않는다.
 * 반환 함수들은 매 렌더 새로 만들어지지만 **오래 사는 쪽이 있다** — DayAxis 의 `useImperativeHandle(…, [])` 가 첫 렌더의
 * `trackAutoScroll` 을 부모(종일 스트립 드롭)에게 평생 건넨다. 그래서 렌더마다 바뀌는 값(스크롤 영역 높이)은 클로저가 아니라
 * 이 훅 안의 ref(`contentHRef`)로 읽는다 — 안 그러면 축 확대·익일 구간 변경 뒤에도 첫 렌더의 높이로 상한을 계산했다.
 */
import { useEffect, useRef, type RefObject } from "react";
import { maxAxisScrollTop } from "../calendarLayout";

/* W17 자동 스크롤 상수 — 전부 **동작** 값이다(감지 폭·속도·머무름). CSS 로 나가는 디자인 값이 아니라
 * 스케일 사다리와 무관하고, 그래서 토큰으로 두지 않는다. */
/** 가장자리 영역의 상한. 사이드바 축은 보이는 창이 ~168px 뿐이라 고정 32px 면 위아래 ~38% 가 영역이 돼
 *  손이 영역을 벗어나지 못했다 — 보이는 높이의 12% 로도 죈다(아래 edgePx). */
const AUTO_SCROLL_EDGE_PX = 32;
const AUTO_SCROLL_EDGE_RATIO = 0.12;
/** 가장자리에 이만큼 **머문 뒤에만** 흐르기 시작한다 — 스치기만 한 손에는 축이 움직이지 않는다. */
const AUTO_SCROLL_DWELL_MS = 250;
/** 초당 속도: 영역 가장자리에서 시작해 맨 끝(깊이 1)에서 최대. 24시간을 훑는 데 충분한 값(기존 ~440px/s). */
const AUTO_SCROLL_MIN_PX_PER_S = 80;
const AUTO_SCROLL_MAX_PX_PER_S = 480;
/** 한 프레임에 밀 수 있는 시간 상한 — 탭이 멈췄다 돌아와도 한 번에 날아가지 않게. */
const AUTO_SCROLL_MAX_DT_MS = 50;

/** 보이는 높이에 따른 가장자리 영역 폭. */
export function autoScrollEdgePx(visibleHeight: number): number {
  return Math.min(AUTO_SCROLL_EDGE_PX, visibleHeight * AUTO_SCROLL_EDGE_RATIO);
}

/** 가장자리 깊이(0~1)에 따른 초당 속도. */
export function autoScrollSpeed(depth: number): number {
  const d = Math.max(0, Math.min(1, depth));
  return AUTO_SCROLL_MIN_PX_PER_S + (AUTO_SCROLL_MAX_PX_PER_S - AUTO_SCROLL_MIN_PX_PER_S) * d;
}

export type AxisAutoScroll = {
  /** 드래그가 지금 이 높이에 있다 — 가장자리면 밀기 시작/유지, 벗어나면 멈춘다. */
  trackAutoScroll: (clientY: number, resync: () => void) => void;
  stopAutoScroll: () => void;
  /** 자동 스크롤이 축을 민 만큼을 손짓에 더한 값. */
  dragDeltaPx: (dy: number, scrollTop0: number) => number;
};

/**
 * @param axisRef 축의 스크롤 컨테이너(보이는 창). 이 훅이 미는 대상이다.
 * @param contentH 스크롤 영역 전체 높이(= `axisContentPx` — 눈금 영역 + compact 아래 여백). 위/아래 끝을 넘겨 밀지 않기 위한 상한이고,
 *   확대 보정·기본 스크롤과 같은 `maxAxisScrollTop` 식으로 쓴다.
 */
export function useAxisAutoScroll(
  axisRef: RefObject<HTMLDivElement | null>,
  contentH: number,
): AxisAutoScroll {
  /** 항상 최신 스크롤 영역 높이 — 오래 사는 첫 렌더의 클로저도 같은 ref 를 보므로 낡지 않는다. */
  const contentHRef = useRef(contentH);
  contentHRef.current = contentH;
  /** 돌고 있는 루프(rAF)와 그 방향(-1 위 / 1 아래), 가장자리에 들어선 시각(머무름 판정), 마지막 손 높이
   *  (깊이 비례 속도), 서브픽셀 누적. null = 안 돌고 있다. */
  const autoScroll = useRef<{
    id: number;
    dir: -1 | 1;
    since: number;
    clientY: number;
    last: number;
    acc: number;
  } | null>(null);
  /** 밀고 난 뒤 미리보기를 다시 계산하는 자리 — 각 드래그의 onMove 본문 그대로다. 포인터가
   *  가만히 있으면 pointermove 가 안 오므로, 이것을 루프가 대신 불러야 미리보기가 축과 같이
   *  움직인다(안 그러면 칩이 커서를 놓치고 위로 흘러간다). */
  const autoScrollResync = useRef<(() => void) | null>(null);
  const stopAutoScroll = () => {
    autoScrollResync.current = null;
    if (!autoScroll.current) return;
    cancelAnimationFrame(autoScroll.current.id);
    autoScroll.current = null;
  };
  // 언마운트(날짜를 바꾸거나 목록을 펼쳐 축이 사라지는 경우)에도 루프는 끊어져야 한다.
  useEffect(() => stopAutoScroll, []);

  /** 드래그가 지금 이 높이에 있다 — 가장자리면 그 방향으로 **계속** 밀고, 벗어나면 멈춘다.
   *
   *  루프는 requestAnimationFrame 이다(아래 `frame`) — 머무름·속도가 시간(`t`)으로 정해지고 프레임 수에 묶이지 않는다.
   *
   *  **위/아래 끝을 넘겨 밀지 않는다** — 최대치는 스크롤 영역 높이(contentH) 빼기 보이는 높이다(`maxAxisScrollTop`).
   *  `scrollHeight - clientHeight` 가 정공법이지만 jsdom 에는 레이아웃이 없어 둘 다 0 이고,
   *  캔버스의 높이는 우리가 픽셀로 정한 상수라 rect 로 유도해도 같은 값이다.
   *
   *  포인터가 스크롤러의 위아래 **밖**이면 아무 일도 없다. 종일 카드는 축 바로 위 스트립에서
   *  끌려오므로, 밖까지 가장자리로 치면 카드를 집는 순간부터 축이 위로 흘러 버린다. */
  const trackAutoScroll = (clientY: number, resync: () => void) => {
    const el = axisRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const edge = autoScrollEdgePx(box.height);
    const dir =
      clientY < box.top || clientY > box.bottom
        ? 0
        : clientY <= box.top + edge
          ? -1
          : clientY >= box.bottom - edge
            ? 1
            : 0;
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    // 같은 방향으로 이미 돌고 있으면 루프는 그대로 두고 손 높이와 resync 만 갈아 끼운다(아래).
    if (autoScroll.current?.dir !== dir) {
      stopAutoScroll();
      const now = performance.now();
      autoScroll.current = { id: 0, dir, since: now, clientY, last: now, acc: 0 };
      autoScroll.current.id = requestAnimationFrame(frame);
    }
    autoScroll.current!.clientY = clientY;
    // **stopAutoScroll 뒤에** 얹는다 — 그쪽이 이 자리를 비우기 때문이다(순서를 뒤집으면 방금
    // 넣은 resync 가 지워져 미리보기가 축을 따라오지 않는다. 실제로 그렇게 한 번 틀렸다).
    autoScrollResync.current = resync;
  };

  /** 프레임 하나 — 머무름(DWELL)이 지난 뒤에만 깊이에 비례해 밀고, 서브픽셀은 누적했다가 정수만 민다. */
  const frame = (t: number) => {
    const st = autoScroll.current;
    const cur = axisRef.current;
    if (!st || !cur) {
      stopAutoScroll();
      return;
    }
    st.id = requestAnimationFrame(frame);
    const dt = Math.min(AUTO_SCROLL_MAX_DT_MS, Math.max(0, t - st.last));
    st.last = t;
    if (t - st.since < AUTO_SCROLL_DWELL_MS) return;
    const box = cur.getBoundingClientRect();
    const edge = autoScrollEdgePx(box.height);
    const depth =
      st.dir === -1 ? (box.top + edge - st.clientY) / edge : (st.clientY - (box.bottom - edge)) / edge;
    st.acc += (st.dir * autoScrollSpeed(depth) * dt) / 1000;
    const whole = Math.trunc(st.acc);
    if (whole === 0) return;
    st.acc -= whole;
    // **위/아래 끝을 넘겨 밀지 않는다** — 최대치는 스크롤 영역 높이 빼기 보이는 높이다. ref 로 읽으므로 확대·익일 구간이 바뀐 뒤에도 최신이다.
    const max = maxAxisScrollTop(contentHRef.current, box.height);
    const before = cur.scrollTop;
    cur.scrollTop = Math.min(max, Math.max(0, before + whole));
    // 끝에 닿아 한 픽셀도 못 움직였으면 다시 그릴 것도 없다.
    if (cur.scrollTop === before) return;
    autoScrollResync.current?.();
  };

  /** 자동 스크롤이 축을 민 만큼은 손짓에 **더해야** 한다 — 칩·새 범위의 자리는 캔버스 기준
   *  픽셀로 계산되는데, 축이 흐르면 같은 clientY 가 다른 분을 뜻하게 된다. 스크롤 한 번 읽어
   *  더하는 것으로 끝난다(캔버스 rect 를 다시 읽는 것과 같은 값 — 스크롤이 곧 그 차이다).
   *  드래그 중 사용자가 휠로 스크롤해도 같은 보정을 받는다. */
  const dragDeltaPx = (dy: number, scrollTop0: number) =>
    dy + ((axisRef.current?.scrollTop ?? 0) - scrollTop0);

  return { trackAutoScroll, stopAutoScroll, dragDeltaPx };
}
