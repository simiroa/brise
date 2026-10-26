import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import "../../styles/fluidHover.css";

/**
 * 유동 hover — 목록/메뉴/탭 위를 지나는 하이라이트 1장.
 *
 * 행마다 `:hover` 배경을 켜고 끄면 행을 벗어나는 순간(패딩·구분선·행 사이 1px) 꺼지므로
 * 목록을 한 번 훑을 때 행 수만큼 점멸하고, 그때마다 눈이 목록으로 되돌아온다. 대신 컨테이너에
 * 하이라이트 하나를 두고 커서에서 **가장 가까운 항목**으로 옮기면 dead zone 이 없어 한 번의
 * 이동으로 끝난다. 규칙은 그 한 줄이 전부다.
 *
 * 비용: 이동 1회당 rect 읽기 1 + transform 쓰기 1. top/left 가 아니라 transform 이라
 * 레이아웃 쓰기는 0이다.
 */
export type FluidAxis = "x" | "y" | "xy";

export interface FluidRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 구분선으로 나뉜 묶음 번호. 묶음을 건너뛰는 이동은 미끄러지지 않는다. */
  group: number;
  /** 항목이 실제로 쓰는 모서리. 메뉴 행은 둥글고 탭은 각지다 — 하이라이트가 항목을 따라간다. */
  radius: string;
}

/**
 * 가장 가까운 항목의 인덱스. axis 는 "무엇을 기준으로 가까운가"만 바꾼다 —
 * 세로 목록은 y 만, 탭 스트립은 x 만, 카드 격자는 두 축 모두.
 */
export function pickNearest(
  rects: readonly FluidRect[],
  px: number,
  py: number,
  axis: FluidAxis,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dist =
      axis === "y"
        ? Math.abs(py - cy)
        : axis === "x"
          ? Math.abs(px - cx)
          : Math.hypot(px - cx, py - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export interface FluidHoverOptions {
  axis?: FluidAxis;
  /** 컨테이너 안에서 "행"으로 칠 것. 기본은 메뉴 계열 공통 클래스. */
  itemSelector?: string;
  /** 끄면 핸들러가 아무것도 하지 않는다(하이라이트도 안 뜬다). */
  enabled?: boolean;
  /**
   * 포인터가 새로 들어올 때 하이라이트가 **먼저 놓일** 항목. 드롭다운은 현재 값 행을 넘겨
   * "지금 값 → 새 값" 이 한 번의 이동으로 이어지게 한다. 없거나 목록에 없으면(비활성·숨김)
   * 목표 행에서 바로 페이드인한다. 우클릭 메뉴처럼 "현재 값" 이 없는 표면은 넘기지 않는다.
   */
  from?: () => Element | null | undefined;
}

export interface FluidHoverApi {
  handlers: {
    onMouseEnter: () => void;
    onMouseMove: (e: { clientX: number; clientY: number }) => void;
    onMouseLeave: () => void;
  };
  activeIndex: number | null;
  rect: FluidRect | null;
  /** 포인터가 새로 들어올 때마다 증가. 하이라이트를 다시 마운트시켜 첫 페인트를 페이드로 만든다. */
  session: number;
  /** 이번 이동이 묶음을 건너뛰었나 — 그렇다면 미끄러지지 않고 자리를 옮긴다. */
  jump: boolean;
  /** 팝오버가 열리거나 목록이 바뀐 뒤 다시 재기. */
  remeasure: () => void;
}

export function useFluidHover(
  containerRef: RefObject<HTMLElement | null>,
  { axis = "y", itemSelector = ".menu-row", enabled = true, from }: FluidHoverOptions = {},
): FluidHoverApi {
  const rectsRef = useRef<FluidRect[]>([]);
  // rects 와 같은 순서의 요소 — `from` 이 돌려준 요소를 인덱스로 바꾸는 데만 쓴다.
  const elsRef = useRef<HTMLElement[]>([]);
  const fromRef = useRef(from);
  fromRef.current = from;
  const lastGroupRef = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [session, setSession] = useState(0);
  const [jump, setJump] = useState(false);

  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) {
      rectsRef.current = [];
      return;
    }
    const cr = c.getBoundingClientRect();
    // 행과 구분선을 한 번에, 문서 순서로 받는다 — 그래야 구분선을 지날 때마다 묶음 번호를 올릴 수 있다.
    const nodes = c.querySelectorAll<HTMLElement>(`${itemSelector}, .menu-sep, [data-fh-break]`);
    const out: FluidRect[] = [];
    const els: HTMLElement[] = [];
    let group = 0;
    nodes.forEach((el) => {
      if (!el.matches(itemSelector)) {
        group++;
        return;
      }
      // 비활성 행은 불이 들어오지 않는다 — 갈 수 없는 곳을 가리키지 않기 위해.
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // 모서리를 상수로 박으면 사각형 탭 위에 둥근 하이라이트가 뜬다 — 항목에서 그대로 읽는다.
      // 재기(mouseenter·DOM 변화)마다 한 번이라 이동 중에는 부르지 않는다.
      const radius = getComputedStyle(el).borderRadius || "0";
      out.push({
        // clientTop/Left = 컨테이너 테두리 두께. absolute 는 패딩 박스 기준이라 이걸 빼야 한다.
        x: r.left - cr.left - c.clientLeft + c.scrollLeft,
        y: r.top - cr.top - c.clientTop + c.scrollTop,
        w: r.width,
        h: r.height,
        group,
        radius,
      });
      els.push(el);
    });
    rectsRef.current = out;
    elsRef.current = els;
  }, [containerRef, itemSelector]);

  // 잰 값이 낡는 두 경우를 여기서 한 번에 막는다 — 호출처마다 "이럴 때 다시 재라"를 심지
  // 않기 위해서다. ⓐ 컨테이너 크기 변화(창 크기, 목록이 길어져 팝오버가 커짐) = ResizeObserver,
  // ⓑ 크기는 그대로인데 항목이 늘거나 줄거나 순서가 바뀜(탭 열기/닫기, 드래그 재정렬) =
  // MutationObserver. ⓑ 는 RO 가 절대 못 잡는다 — 탭 스트립은 항목이 바뀌어도 자기 상자
  // 크기가 그대로다.
  // ponytail: childList 변화마다 전체를 다시 잰다. 메뉴·탭 스트립은 항목이 수십 개라 무해하다.
  // 수백 개짜리 목록에 쓰게 되면 그때 바뀐 항목만 재는 쪽으로 좁혀라.
  useEffect(() => {
    const c = containerRef.current;
    if (!c || !enabled) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    ro?.observe(c);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(() => measure()) : null;
    mo?.observe(c, { childList: true, subtree: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [containerRef, enabled, measure]);

  const onMouseEnter = useCallback(() => {
    if (!enabled) return;
    measure();
    // 세션의 첫 페인트 자리. key=session 으로 새로 마운트되므로 여기엔 transition 이 없고,
    // 뒤따르는 첫 mousemove 가 여기서 목표 행으로 미끄러진다.
    const fromEl = fromRef.current?.();
    const i = fromEl ? elsRef.current.indexOf(fromEl as HTMLElement) : -1;
    lastGroupRef.current = i >= 0 ? rectsRef.current[i].group : null;
    setActive(i >= 0 ? i : null);
    setJump(false);
    setSession((s) => s + 1);
  }, [enabled, measure]);

  const onMouseMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const c = containerRef.current;
      if (!c || !enabled) return;
      if (rectsRef.current.length === 0) measure();
      const cr = c.getBoundingClientRect();
      const px = e.clientX - cr.left - c.clientLeft + c.scrollLeft;
      const py = e.clientY - cr.top - c.clientTop + c.scrollTop;
      const i = pickNearest(rectsRef.current, px, py, axis);
      if (i === null) {
        setActive(null);
        return;
      }
      const g = rectsRef.current[i].group;
      setJump(lastGroupRef.current !== null && lastGroupRef.current !== g);
      lastGroupRef.current = g;
      setActive(i);
    },
    [axis, containerRef, enabled, measure],
  );

  const onMouseLeave = useCallback(() => {
    setActive(null);
    lastGroupRef.current = null;
  }, []);

  return {
    handlers: { onMouseEnter, onMouseMove, onMouseLeave },
    activeIndex: active,
    rect: active === null ? null : (rectsRef.current[active] ?? null),
    session,
    jump,
    remeasure: measure,
  };
}

/**
 * 하이라이트 자체. 컨테이너는 `fh-host` 클래스를 달아야 한다(position 기준 + 행별 hover 배경 해제).
 * `key={session}` 이 핵심 — 포인터가 새로 들어올 때 요소를 갈아 끼워, 이전 위치에서
 * 미끄러져 오는 대신 목표 자리에서 페이드인하게 한다.
 */
export function FluidHoverHighlight({ hover }: { hover: FluidHoverApi }) {
  const r = hover.rect;
  if (!r) return null;
  return (
    <div
      key={hover.session}
      className="fh-highlight"
      data-testid="fluid-hover-highlight"
      data-fh-jump={hover.jump ? "true" : undefined}
      style={{
        transform: `translate3d(${r.x}px, ${r.y}px, 0)`,
        width: r.w,
        height: r.h,
        borderRadius: r.radius,
      }}
    />
  );
}
