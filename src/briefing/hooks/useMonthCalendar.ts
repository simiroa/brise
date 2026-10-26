/**
 * 작은 월 달력(오른쪽 열)의 데이터 — 달력(CalendarTab)과 같은 조회(dashboard_calendar·timeline_routine_list)를 scheduleCache 로 읽는다.
 * 하루 단위 전개는 useBriefingData 의 buildDayEntries 를 날짜마다 부른다(두 번째 구현 금지).
 * ponytail: 인접 월 프리페치 없음 — 월 이동 때 캐시 미스면 그때 읽는다. 느려지면 여기서 ±1 월 scheduleMonth 선요청.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportFallback } from "../../lib/diag";
import { holidaysForYear } from "../../lib/holidays";
import { useSettingsStore } from "../../stores/settings";
import { scheduleMonth, scheduleRoutines } from "../scheduleCache";
import { buildDayEntries, useReloadOnScheduleChange, type DayEntry, type LoadStatus } from "./useBriefingData";
import type { CalendarItem, TimelineRoutine } from "../../lib/commands.gen";

/** "YYYY-MM-DD" 들이 걸치는 (연, 월1-12) 목록 — 중복 제거. */
export function monthsOfDays(days: string[]): { y: number; m: number }[] {
  const seen = new Map<string, { y: number; m: number }>();
  for (const d of days) {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    seen.set(`${y}-${m}`, { y, m });
  }
  return [...seen.values()];
}

/** days 에 대한 날짜별 일정. 반복 일정·월 조회 중 한쪽만 실패하면 다른 쪽은 보여 주고 폴백을 남긴다(둘 다 실패 = error). */
export function useMonthCalendar(days: string[]): {
  status: LoadStatus;
  byDay: Record<string, DayEntry[]>;
  holidays: Record<string, string>;
  reload: () => void;
} {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const holidayRegion = useSettingsStore((s) => s.holidayRegion);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ status: LoadStatus; routines: TimelineRoutine[]; items: CalendarItem[] }>({
    status: "loading",
    routines: [],
    items: [],
  });
  const key = days.join(",");
  const lastKey = useRef<string | null>(null);
  const fresh = useRef(false); // reload 뒤 다음 로드 한 번만 캐시를 우회

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    // 월이 바뀐 로드만 loading — 포커스·reload 재조회는 격자를 그대로 두고 갱신한다(깜빡임 방지).
    const keyChanged = lastKey.current !== key;
    lastKey.current = key;
    setState((s) => (keyChanged || s.status !== "ready" ? { ...s, status: "loading" } : s));
    const bypass = fresh.current;
    fresh.current = false;
    const months = monthsOfDays(key.split(",").filter(Boolean));
    void (async () => {
      const [routines, cals] = await Promise.all([
        scheduleRoutines(workspaceId, bypass).then((r) => r, (): TimelineRoutine[] | null => null),
        Promise.all(months.map(({ y, m }) => scheduleMonth(workspaceId, y, m, bypass).then((r) => r, (): CalendarItem[] | null => null))),
      ]);
      if (cancelled) return;
      const calFailed = cals.some((c) => c === null);
      if (routines === null && calFailed) return setState({ status: "error", routines: [], items: [] });
      if (routines === null) reportFallback("briefing", "routine_list_failed", "calendar shown without routines");
      if (calFailed) reportFallback("briefing", "calendar_failed", "calendar shown without note events");
      setState({ status: "ready", routines: routines ?? [], items: cals.flatMap((c) => c ?? []) });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, key, tick]);

  // 설정 창에서 반복 일정을 고치고 돌아오면(포커스) 반복 일정 캐시는 scheduleCache 가 이미 비웠다 — 다시 읽기만 하면 된다.
  useEffect(() => {
    const onFocus = () => setTick((n) => n + 1); // 월 캐시는 TTL 규칙 그대로(fresh 아님)
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    fresh.current = true;
    setTick((n) => n + 1);
  }, []);
  useReloadOnScheduleChange(reload);

  const { byDay, holidays } = useMemo(() => {
    const byDay: Record<string, DayEntry[]> = {};
    const holidays: Record<string, string> = {};
    for (const d of key.split(",").filter(Boolean)) {
      const name = holidaysForYear(holidayRegion, Number(d.slice(0, 4))).get(d);
      if (name) holidays[d] = name;
      byDay[d] = state.status === "ready" ? buildDayEntries(d, state.routines, state.items, name !== undefined) : [];
    }
    return { byDay, holidays };
  }, [key, holidayRegion, state]);

  return { status: state.status, byDay, holidays, reload };
}
