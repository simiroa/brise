import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  HOUR_ROW_H,
  MIN_HOUR_ROW_H,
  MAX_HOUR_ROW_H,
  DEFAULT_SCROLL_HOUR,
  maxAxisScrollTop,
  axisContentPx,
} from "../calendarLayout";

/** "하루 전체 보기"(오너 요청 2026-09-16)의 하한 — MIN_HOUR_ROW_H(휠 확대의 하한, 28)보다
 *  훨씬 낮다. 그 값은 탐색적 축소로 읽기 힘들어지는 지점이고, 이 버튼은 "좁은 창에 24시간을
 *  다 넣어라"는 명시적 요청이라 다른 목적이다. 0 은 막는다(컨테이너 높이를 아직 못 잰 경우의
 *  방어) — 그 외엔 tickIntervalMinFor 가 알아서 시간 단위 눈금으로 굵어질 뿐 깨지지 않는다. */
const FIT_DAY_MIN_HOUR_ROW_H = 8;

/**
 * 시간축의 **배율**(hourRowH)과 그에 딸린 스크롤 규칙 — DayAxis 에서 떼어 냈다(순수 이동, 동작 변경 0):
 *  · 로컬 배율 state + Ctrl/Cmd+휠 확대/축소(커서가 가리키던 시각을 같은 화면 자리에 고정하는 보정),
 *  · 기본 스크롤(오늘=지금 시각 · 다른 날=첫 일정 · 둘 다 없으면 08:00),
 *  · "하루 전체 보기" 토글.
 * 셋 다 같은 변수(hourRowH)와 같은 스크롤러(axisRef)를 만지므로 한 훅이다.
 *
 * @param axisRef 축의 스크롤 컨테이너(보이는 창).
 * @param axisEndMin 축의 끝 분(24:00 + 익일 구간).
 * @param tailRows compact 사이드바의 아래 여백 행 수(스크롤 영역에 든다).
 * @param firstMin 당일 첫 일정의 시작 분(없으면 null) — 오늘이 아닌 날의 기본 스크롤 자리.
 * @param nowTick 지금 시각(분)과 오늘 날짜 — 1분 틱은 호출자가 갖는다(현재 시각 눈금도 쓴다).
 */
export function useAxisZoom({
  axisRef,
  day,
  axisEndMin,
  tailRows,
  compact,
  firstMin,
  nowTick,
}: {
  axisRef: RefObject<HTMLDivElement | null>;
  day: string | null;
  axisEndMin: number;
  tailRows: number;
  compact: boolean;
  firstMin: number | null;
  nowTick: { minutes: number; todayIso: string };
}) {
  // ── 축 확대 (PLAN-2026-09-13 달력 확대) ────────────────────────────────────────────────────
  // **로컬 state, 전역 싱글턴 아니다** — 이 축 인스턴스(대시보드 하나, 사이드바 하나)만의 배율.
  // 같은 세션에서 날짜를 옮겨도 이 컴포넌트가 안 사라지는 한(D4 껍데기 분리 참고 — 대시보드는
  // TimeAxis 를 다시 마운트하지 않는다) 유지되고, 언마운트/새로고침이면 기본값(HOUR_ROW_H)으로
  // 돌아간다 — 설정 키도 localStorage 도 만들지 않는다(요구사항 ③).
  const [hourRowH, setHourRowH] = useState(HOUR_ROW_H);
  /** wheel 핸들러는 아래에서 `useEffect(…, [])`로 한 번만 등록한다 — 그 클로저가 매 렌더 새로
   *  만들어지지 않으므로 최신 배율은 ref 로 읽는다(이 파일의 다른 "얼린 손잡이"와 같은 처방,
   *  useImperativeHandle 의 startMinAt 주석 참고). */
  const hourRowHRef = useRef(hourRowH);
  hourRowHRef.current = hourRowH;
  const pxPerMin = hourRowH / 60;
  /** 휠 확대 직후, 커서가 가리키던 **그 시각**을 같은 화면 자리에 다시 놓기 위한 값 — 캔버스
   *  높이(dayAxisH)가 새 배율로 실제로 커진 "뒤"에 scrollTop 을 세팅해야 한다(먼저 세팅하면
   *  아직 옛 scrollHeight 라 브라우저가 그 자리에서 clamp 해 버린다). 그래서 wheel 핸들러는
   *  이 ref 에 "고정할 시각(분) · 그때의 커서 Y"만 적어 두고, 실제 scrollTop 은 hourRowH 가
   *  반영된 다음 렌더의 useLayoutEffect 가 계산한다 — 지도의 `nextX = cursorX - ((cursorX-x)/prevK)*nextK`
   *  재조정과 같은 사상이고, 여기는 x/pan 대신 scrollTop 하나뿐이다. */
  const pendingZoomFix = useRef<{ pinnedMin: number; cursorY: number } | null>(null);
  useLayoutEffect(() => {
    const fix = pendingZoomFix.current;
    const el = axisRef.current;
    if (!fix || !el) return;
    pendingZoomFix.current = null;
    const viewH = el.getBoundingClientRect().height;
    const raw = fix.pinnedMin * pxPerMin - fix.cursorY;
    el.scrollTop = Math.max(0, Math.min(maxAxisScrollTop(axisContentPx(hourRowH, axisEndMin, tailRows), viewH), raw));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pxPerMin/dayAxisH 는 hourRowH 의
    // 파생값이라 hourRowH 하나만으로 이 값들이 바뀐 렌더를 잡는다(둘 다 deps 에 넣으면 같은
    // 렌더에 두 번 잡히는 게 아니라 그냥 중복 표기다 — 굳이 늘리지 않는다).
  }, [hourRowH]);

  // 축의 스크롤 컨테이너에 **네이티브** addEventListener 로 건다(useMapPanZoom·useTimelineDrag 와
  // 같은 이유 — React 의 합성 onWheel 은 델리게이션 루트에 passive 로 등록돼 preventDefault 가
  // 안 먹는다). 평소 휠은 이 리스너가 손대지 않는다(막지 않으면 컨테이너의 기존 세로 스크롤이
  // 그대로 산다) — Ctrl/Cmd+wheel 만 확대/축소로 가로챈다(지도·연도 타임라인과 통일된 관용구,
  // 2026-09-08). deps 는 []: 클로저는 ref(hourRowHRef · axisRef)만 만지므로 재등록이 필요 없다.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 평소 휠 = 그대로 세로 스크롤(막지 않는다).
      e.preventDefault();
      const cur = hourRowHRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 0.85;
      const next = Math.min(MAX_HOUR_ROW_H, Math.max(MIN_HOUR_ROW_H, cur * factor));
      if (next === cur) return; // 이미 하한/상한 — 아무것도 안 바뀐다.
      const rect = el.getBoundingClientRect();
      const cursorY = e.clientY - rect.top;
      // 확대 중심 = 커서가 가리키는 "그 시각"(지금 스케일 기준으로 역산). 위 useLayoutEffect 가
      // 새 스케일 반영 뒤 이 시각을 같은 커서 자리로 되돌린다.
      const pinnedMin = (el.scrollTop + cursorY) / (cur / 60);
      pendingZoomFix.current = { pinnedMin, cursorY };
      setHourRowH(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 오늘은 **항상** 지금 시각(뷰포트 가운데)에 맞춘다(오너 실기 2026-09-16) — 일정이 있어도
  // 없어도. 옛 규칙은 첫 일정이 있으면 무조건 그리로 맞췄는데, 새벽(수면 등) 일정이 있는 날은
  // 지금이 오후여도 축이 00시부터 열려 "맨날 하루의 처음"으로 보이는 사고였다. 다른 날은 그대로
  // 첫 일정, 없으면 08:00(§6.2). **부모가 아니라 여기** — 자기 스크롤러를 아는 것은 축뿐이고
  // (W8 ②), 목록 펼침으로 축이 다시 마운트될 때도 맞는다(부모의 effect 는 deps 가 그대로여서
  // 재마운트된 축을 0 으로 남겨 뒀다).
  //
  // **한 번만 맞춘다** — `pinnedTodayRef` 가 이 날짜로 이미 맞췄는지를 기억한다. 없으면 이
  // effect 는 `firstMin`(재조회로 첫 일정이 바뀔 때마다) 에도 다시 돈다 — 시간축 빈 곳에
  // 새 일정을 만들면(바로 위 onCreateTimedNote 리프레시로 재조회가 오고 firstMin 이 바뀐다)
  // 방금 만든 그 일정 쪽으로 축이 다시 튀어, 사용자가 방금 본 자리에서 자기가 만든 일정이
  // 화면 밖으로 사라지는 사고가 났다. 오늘이 아닌 날은 그대로 매 firstMin 변화에 다시 맞춘다
  // (detailNotes 가 비동기로 나중에 도착해 null → 값으로 바뀌는 정상 경로 — 그 갈래는 손대지
  // 않았다). 날짜를 바꾸면 ref 를 지워 다음에 그 날로(또는 다시 오늘로) 돌아오면 재적용된다.
  // `nowTick.minutes` 는 deps 에 안 둔다 — 매 분 재렌더된다고 스크롤을 다시 뺏으면 사용자가
  // 손으로 옮긴 위치가 흐른다.
  const pinnedTodayRef = useRef<string | null>(null);
  /** 위 세 갈래(오늘=지금 시각·다른 날=첫 일정·둘 다 없으면 08:00)를 **한 곳에** 둔다 — 아래
   *  effect 와, "하루 전체 보기"를 끌 때(되돌리기)가 같은 규칙을 쓴다(오너 요청 2026-09-16).
   *  `forHourRowH` 를 받는 이유: 되돌리기는 `setHourRowH` 로 배율을 바꾼 **바로 그 틱**에 새
   *  배율 기준으로 다시 맞춰야 하는데, state 는 다음 렌더에야 반영되니 방금 정한 값을 직접
   *  넘긴다(effect 쪽은 그냥 지금 hourRowH 를 넘긴다). */
  const applyDefaultScroll = (el: HTMLDivElement, forHourRowH: number) => {
    const perMin = forHourRowH / 60;
    if (day === nowTick.todayIso) {
      const nowPx = nowTick.minutes * perMin;
      // compact: 지금을 창 위쪽 40% 에(아래 여백 덕에 밤에도 가능), 아니면 가운데.
      const anchor = el.clientHeight * (compact ? 0.4 : 0.5);
      const maxTop = maxAxisScrollTop(axisContentPx(forHourRowH, axisEndMin, tailRows), el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(maxTop, nowPx - anchor));
      return;
    }
    if (firstMin !== null) {
      el.scrollTop = firstMin * perMin;
      return;
    }
    el.scrollTop = DEFAULT_SCROLL_HOUR * 60 * perMin;
  };
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    if (day === nowTick.todayIso) {
      if (pinnedTodayRef.current === day) return;
      pinnedTodayRef.current = day;
      applyDefaultScroll(el, hourRowH);
      return;
    }
    pinnedTodayRef.current = null;
    applyDefaultScroll(el, hourRowH);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hourRowH 는 일부러 뺐다: 축소/확대
    // 만으로 이 "첫 일정에 맞추기"를 다시 돌리면 안 된다 — 그건 아래 wheel 핸들러의
    // useLayoutEffect 가 이미 자기 몫(커서 중심 재조정)으로 처리한다. 이 effect 는 날짜가
    // 바뀌거나 축이 다시 마운트될 때만 돈다. "하루 전체 보기" 버튼이 배율을 바꾸는 경우도
    // 마찬가지로 이 effect 가 아니라 그 버튼의 핸들러가 직접 applyDefaultScroll 을 부른다.
  }, [firstMin, day, nowTick.todayIso]);

  // ── 하루 전체 보기 (오너 요청 2026-09-16) ──────────────────────────────────────────────────
  // 사이드바 축은 보이는 창이 ~168px(≈6시간)뿐이라 하루를 보려면 계속 스크롤해야 한다는 피드백
  // — 한 번에 24시간을 다 넣는 배율로 맞추는 토글. 휠 확대(Ctrl+wheel)와 **같은 변수**
  // (hourRowH) 를 쓰므로 두 조작이 서로 다투지 않는다 — 이 버튼도 그 배율을 한 번 바꿀 뿐이고,
  // 다시 눌러 원래 배율로 돌아가면 지금 시각(또는 첫 일정)으로 다시 맞춘다.
  const [wholeDayView, setWholeDayView] = useState(false);
  const toggleWholeDayView = () => {
    const el = axisRef.current;
    if (!el) return;
    if (wholeDayView) {
      setWholeDayView(false);
      setHourRowH(HOUR_ROW_H);
      applyDefaultScroll(el, HOUR_ROW_H);
      return;
    }
    const viewH = el.getBoundingClientRect().height;
    // MIN_HOUR_ROW_H(28, 24h=672px) 가 아니라 훨씬 낮은 바닥을 쓴다 — 그건 "탐색적 축소로는
    // 이 밑으로 못 읽는다"는 휠 확대의 하한이고, 이 버튼은 "좁은 창에 24시간을 다 욱여넣어라"는
    // 명시적 요청이라 다른 목적이다. 사이드바 실측 높이(~168px)로 그 바닥을 지키면 버튼이
    // 사실상 아무 것도 안 하는 것과 같다(672px 이상 있어야 28 을 지킬 수 있다). 더 내려가도
    // tickIntervalMinFor 가 알아서 시간 단위 눈금으로 굵어질 뿐 깨지지 않는다.
    const fit = Math.min(
      MAX_HOUR_ROW_H,
      Math.max(FIT_DAY_MIN_HOUR_ROW_H, viewH / (axisEndMin / 60)),
    );
    setWholeDayView(true);
    setHourRowH(fit);
    el.scrollTop = 0;
  };

  return { hourRowH, hourRowHRef, wholeDayView, toggleWholeDayView };
}
