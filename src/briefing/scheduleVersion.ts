/**
 * 브리핑 창의 "일정이 바뀌었다" 신호 — PLAN-2026-10-19 §2.4 ④.
 *
 * 이 창은 이제 **쓴다**(축에서 만들기·옮기기·늘리기·빼기). 그 쓰기와 본 창·폰의 쓰기가 모두 같은
 * 한 신호로 모인다: ① 이 창의 달력 쓰기 경로(commitDateRow·removeDateRow·종일 드롭)는 끝에
 * bumpNoteQueryVersion 을 부르고, ② 백엔드는 모든 노트 쓰기에 `remote-note-write` 를 낸다
 * (출처 무관 — 이 창은 본 창처럼 origin "local" 을 거르지 않는다: 본 창의 쓰기도 "local" 이다).
 * BriefingWindowApp 이 둘을 구독해 여기 bumpScheduleVersion 한 곳을 부른다.
 *
 * 하는 일은 둘뿐: 창 단위 요청 캐시의 일정·알림 항목을 버리고(cal:·od:), 구독자에게 알린다.
 * 구독자(일정·알림 훅)는 **같은 대상의 재조회**(reload)로 받는다 — 화면이 로딩으로 깜빡이지 않고,
 * 새 배열이 와서 축의 plan 이 바뀌어야 TimeAxis 가 낙관적 미리보기를 버린다(DayAxis.tsx 의 [plan] effect).
 *
 * 연속 쓰기(맞닿은 이웃이 같이 움직이는 연동 이동은 행 여럿을 쓴다)는 COALESCE_MS 창 안에서 한 번으로 합친다.
 */
import { useSyncExternalStore } from "react";
import { invalidate } from "./requestCache";

export const SCHEDULE_COALESCE_MS = 200;

let version = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** 캐시는 즉시 버리고, 알림은 짧은 창으로 합친다. */
export function bumpScheduleVersion(): void {
  invalidate("cal:");
  invalidate("od:");
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    version++;
    for (const l of listeners) l();
  }, SCHEDULE_COALESCE_MS);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 바뀔 때마다 새 숫자 — 훅이 effect deps 에 넣고 "첫 값이 아니면 reload" 로 쓴다. */
export function useScheduleVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** 테스트 간 오염 방지. */
export function resetScheduleVersion(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  version = 0;
  listeners.clear();
}
