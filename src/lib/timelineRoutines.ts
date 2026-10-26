import { useSyncExternalStore } from "react";

/**
 * 타임라인 루틴(설정 > 달력, `TimelineRoutineSection.tsx`) 변경 알림 — `noteQuery.ts`의
 * `bumpNoteQueryVersion`/`useNoteQueryVersion`과 같은 모양(모듈 전역 카운터 +
 * `useSyncExternalStore`)을 그대로 본뜬 것. 루틴은 노트가 아니라 이 파일을 따로 둔다(빌려 쓰면
 * 노트 변경마다도 재조회가 되어 과하다 — 루틴 변경에만 반응해야 한다).
 *
 * 그릴 2026-09-13 후속: Settings에서 루틴을 추가/수정/삭제한 뒤 달력 시간축(`DayDetailPanel.tsx`)이
 * 화면을 벗어났다 돌아오지 않아도 곧바로 반영되도록 한다. 데이터량이 워크스페이스당 많아야
 * 수십 개라 노트처럼 디바운스·캐시가 필요 없다 — 즉시 카운터만 올린다.
 */
let timelineRoutineVersion = 0;
const listeners = new Set<() => void>();

export function bumpTimelineRoutineVersion(): void {
  timelineRoutineVersion++;
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** 이 값이 바뀔 때마다(다른 화면에서 루틴을 저장/삭제할 때마다) 리렌더 — 루틴 목록을 불러오는
 *  effect의 deps에 넣어라. */
export function useTimelineRoutineVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => timelineRoutineVersion,
    () => timelineRoutineVersion,
  );
}
