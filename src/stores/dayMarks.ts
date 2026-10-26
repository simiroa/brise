/**
 * 달력 표시일 스토어 — 현재 노트북의 표시일·불러온 캘린더·숨긴 날(docs/PLAN-2026-09-19-calendar-schedule.md §3).
 *
 * 여섯 달력 표면이 공휴일 맵을 **동기로** 읽는다(lib/calendarDay.ts::useHolidayMap) — 그래서 한 번 읽어
 * 들고 있고, 전개는 lib/dayMarks.ts 가 동기로 한다. 다시 읽는 때:
 *   - 활성 노트북이 바뀔 때(노트북마다 따로 — 오너 결정 2026-09-19),
 *   - 어느 창에서든 표시일을 쓴 뒤(Rust 가 "calendar-marks-changed" 를 모든 데스크톱 창에 낸다).
 *
 * 같은 노트북 조회가 날아가는 중이면 그 약속을 같이 쓴다 — 단 **쓰기 뒤의 재조회는 `force`** 로 새로
 * 보낸다(쓰기 전에 출발한 조회는 옛 목록을 들고 온다). 응답은 마지막으로 보낸 조회 것만 반영한다.
 * 못 읽으면 같은 노트북의 기존 목록을 그대로 두고(다른 노트북 것이면 비운다) 진단에 남긴다 —
 * 기본 공휴일 표만으로 달력은 계속 그려진다(선택적 데이터라 토스트 없음).
 */
import { create } from "zustand";
import { callSilent } from "../lib/invoke";
import { isBrowser } from "../lib/env";
import { reportFallback } from "../lib/diag";
import type { CalendarMark, CalendarMarkHide, CalendarMarksListOutput, CalendarSource } from "../lib/commands.gen";

interface DayMarksState {
  /** 지금 들고 있는 목록이 어느 노트북 것인가(null = 아직 안 읽음). */
  workspaceId: string | null;
  marks: CalendarMark[];
  sources: CalendarSource[];
  hides: CalendarMarkHide[];
  /** `force` — 날아가는 같은 노트북 조회를 재사용하지 않고 새로 읽는다(쓰기 직후). */
  load: (workspaceId: string, opts?: { force?: boolean }) => Promise<void>;
}

let inflight: { ws: string; p: Promise<void> } | null = null;
/** 마지막으로 보낸 조회 번호 — 늦게 온 옛 응답(다른 노트북이든 쓰기 전 조회든)이 새 목록을 덮지 않게. */
let latestSeq = 0;

export const useDayMarksStore = create<DayMarksState>((set, get) => ({
  workspaceId: null,
  marks: [],
  sources: [],
  hides: [],
  load: (workspaceId, opts) => {
    if (!opts?.force && inflight && inflight.ws === workspaceId) return inflight.p;
    const seq = ++latestSeq;
    const p = callSilent<CalendarMarksListOutput>("calendar_marks_list", { workspace_id: workspaceId })
      .then((r) => {
        if (seq !== latestSeq) return;
        set({
          workspaceId,
          marks: r?.marks ?? [],
          sources: r?.sources ?? [],
          hides: r?.hides ?? [],
        });
      })
      .catch((e: unknown) => {
        if (seq !== latestSeq) return;
        const same = get().workspaceId === workspaceId;
        reportFallback(
          "day_marks",
          same ? "list_failed_kept_previous" : "list_failed_cleared",
          String((e as { message?: string })?.message ?? e).slice(0, 120),
        );
        // 다른 노트북의 목록을 이 노트북 것처럼 보여주지 않는다.
        if (!same) set({ workspaceId, marks: [], sources: [], hides: [] });
      })
      .finally(() => {
        if (inflight?.p === p) inflight = null;
      });
    inflight = { ws: workspaceId, p };
    return p;
  },
}));

let listening = false;

/** "calendar-marks-changed" 를 한 번만 구독한다(창마다). 브라우저(동기화 탭)엔 이벤트 버스가 없다. */
export function listenDayMarksChanged(): void {
  if (listening || isBrowser()) return;
  listening = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("calendar-marks-changed", () => {
        const ws = useDayMarksStore.getState().workspaceId;
        // 쓰기 뒤에 오는 신호 — 쓰기 전에 출발한 조회를 재사용하면 옛 목록이 남는다.
        if (ws) void useDayMarksStore.getState().load(ws, { force: true });
      }),
    )
    .catch((e: unknown) => {
      listening = false;
      reportFallback("day_marks", "listen_failed", String((e as { message?: string })?.message ?? e).slice(0, 120));
    });
}
