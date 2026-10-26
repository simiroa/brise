/**
 * OS 알림용 한 줄 요약 — 카드와 같은 조회(scheduleCache·habit_week)와 같은 순수 계산(buildDayEntries·todayHabitStats)을
 * 본 창에서 재사용한다. 새 조회 없음. 실패하면 null → 호출자가 창으로 폴백한다.
 */
import { t } from "../i18n/t";
import { toIsoDateLocal } from "../components/home/dateFmt";
import { holidaysForYear } from "../lib/holidays";
import { callSilent } from "../lib/invoke";
import type { HabitWeek } from "../lib/commands.gen";
import { useSettingsStore, type HolidayRegion } from "../stores/settings";
import { scheduleMonth, scheduleRoutines } from "./scheduleCache";
import { buildDayEntries, dayAfter, todayHabitStats } from "./hooks/useBriefingData";
import type { BriefingKind } from "./shouldShowBriefing";

async function dayCount(workspaceId: string, day: string, region: HolidayRegion): Promise<number> {
  const [y, m] = day.split("-").map(Number);
  const [routines, items] = await Promise.all([scheduleRoutines(workspaceId), scheduleMonth(workspaceId, y, m)]);
  return buildDayEntries(day, routines, items, holidaysForYear(region, y).has(day)).length;
}

export async function buildBriefingSummary(now: Date, kind: BriefingKind): Promise<{ title: string; body: string } | null> {
  const st = useSettingsStore.getState();
  const ws = st.activeWorkspaceId; // = 노트북
  if (!ws) return null;
  try {
    const today = toIsoDateLocal(now);
    const week = await callSilent<HabitWeek>("habit_week", {
      workspace_id: ws,
      day: today,
      // PLAN-2026-10-19 §5 — 습관 칸(HabitsCard)과 같은 주 기준(설정의 주 시작 요일). 옛 briefing_options.habit_range 는 은퇴.
      week_start: st.weekStart,
    });
    const { done, total } = todayHabitStats(week);
    if (kind === "evening") {
      const n = await dayCount(ws, dayAfter(today, 1), st.holidayRegion);
      return { title: t("briefing.notify_title_evening"), body: t("briefing.notify_body_evening", { done, total, n }) };
    }
    const n = await dayCount(ws, today, st.holidayRegion);
    return { title: t("briefing.notify_title"), body: t("briefing.notify_body", { done, total, n }) };
  } catch {
    // callSilent 가 이미 진단에 남겼다 — 요약을 못 만들면 호출자가 창으로 폴백한다.
    return null;
  }
}
