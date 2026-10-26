/**
 * 브리핑 창 일정 조회 — requestCache 위의 얇은 래퍼(오늘·내일·시간축 카드가 같은 월/반복 일정 조회를 한 번으로).
 */
import { callSilent } from "../lib/invoke";
import type { CalendarItem, CalendarResult, TimelineRoutine } from "../lib/commands.gen";
import { cachedRequest, REQUEST_TTL_MS, resetRequestCache } from "./requestCache";

export const SCHEDULE_TTL_MS = REQUEST_TTL_MS;

/** 테스트 간 오염 방지. */
export const resetScheduleCache = resetRequestCache;

const cached = <T>(key: string, fresh: boolean, load: () => Promise<T>) => cachedRequest(key, load, { fresh });

export function scheduleMonth(workspaceId: string, year: number, month: number, fresh = false): Promise<CalendarItem[]> {
  return cached(`cal:${workspaceId}:${year}-${month}`, fresh, () =>
    callSilent<CalendarResult>("dashboard_calendar", { workspace_id: workspaceId, year, month }).then((r) => r.items),
  );
}

export function scheduleRoutines(workspaceId: string, fresh = false): Promise<TimelineRoutine[]> {
  return cached(`rt:${workspaceId}`, fresh, () =>
    callSilent<{ routines: TimelineRoutine[] }>("timeline_routine_list", {}).then((r) => r.routines),
  );
}
