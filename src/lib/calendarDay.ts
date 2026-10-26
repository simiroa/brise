/**
 * Shared day-level rules for every calendar surface (2026-09-08 audit).
 *
 * Six places draw a month grid — dashboard month/year, sidebar CalendarExpanded, MobileCalendarView,
 * the note DateRangeCalendar, the canvas CalendarNotesWidget — and each had grown its own answer to
 * the same three questions: what day is "today" right now, is this day a weekend/holiday, and how
 * dark is a record-density tint. That drift produced real bugs (a "today" highlight stuck on
 * yesterday past midnight in three surfaces) and visible inconsistency (weekend colours and
 * holidays only on the dashboard). These are the single answers; surfaces render them.
 *
 * Not included on purpose: grid construction (leftpanel/expanded/calendarGrid owns the ISO-string
 * grid; DateRangeCalendar keeps its own number-triple grid for BCE years — see its header) and
 * anything about what a day *contains*, which is each surface's own data source.
 */
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { listenDayMarksChanged, useDayMarksStore } from "../stores/dayMarks";
import { todayLocal } from "../components/home/dateFmt";
import { expandDayMarks, type DayMarkMaps } from "./dayMarks";

/**
 * Today's ISO day, live. HomeHeader already runs one minute tick that writes uiStore.todayIso, so
 * this rides it instead of adding a timer per calendar. The mount-time baseline means a store value
 * that is never updated (this calendar rendered without HomeHeader ever mounting, as in unit tests)
 * can't override the fresh mount-time day (dashboard audit P2 #4, generalised out of CalendarTab).
 */
export function useTodayIso(): string {
  const mountToday = useMemo(todayLocal, []);
  const storeTodayIso = useUiStore((s) => s.todayIso);
  const baselineRef = useRef(storeTodayIso);
  return storeTodayIso !== baselineRef.current ? storeTodayIso : mountToday.day;
}

/**
 * 빨간 날과 기념일 이름표, 주어진 해들 전부(docs/PLAN-2026-09-19-calendar-schedule.md §3).
 *
 * 기본 공휴일 표(노트북 설정 holiday_region) ⊕ 현재 노트북의 표시일(stores/dayMarks) ⊖ 숨긴 날. **동기**다 —
 * 표시일은 스토어가 한 번 읽어 들고 있고, 여기선 해마다 전개만 한다. 스토어가 다른 노트북 것을 들고 있으면
 * (전환 직후) 그 목록은 쓰지 않고 새로 읽는다 — 남의 노트북 생일이 한 프레임도 비치지 않게.
 */
export function useDayMarkMaps(years: number[]): DayMarkMaps {
  const region = useSettingsStore((s) => s.holidayRegion);
  const activeWs = useSettingsStore((s) => s.activeWorkspaceId);
  const { workspaceId, marks, sources, hides } = useDayMarksStore(
    useShallow((s) => ({ workspaceId: s.workspaceId, marks: s.marks, sources: s.sources, hides: s.hides })),
  );
  useEffect(() => {
    listenDayMarksChanged();
    if (activeWs && workspaceId !== activeWs) void useDayMarksStore.getState().load(activeWs);
  }, [activeWs, workspaceId]);
  const current = activeWs !== null && workspaceId === activeWs;
  // years is usually a fresh array literal; key on its content so the map identity is stable.
  const key = years.join(",");
  return useMemo(() => {
    const input = {
      region,
      marks: current ? marks : [],
      sources: current ? sources : [],
      hides: current ? hides : [],
    };
    if (years.length === 1) return expandDayMarks(years[0], input);
    const off = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const y of years) {
      const m = expandDayMarks(y, input);
      for (const [d, n] of m.off) off.set(d, n);
      for (const [d, n] of m.labels) labels.set(d, n);
    }
    return { off, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content identity of `years`
  }, [region, key, current, marks, sources, hides]);
}

/** 빨간 날 이름(공휴일 + 빨간 날로 표시한 기념일·불러온 캘린더). 없는 날은 평일/주말 그대로. */
export function useHolidayMap(years: number[]): ReadonlyMap<string, string> {
  return useDayMarkMaps(years).off;
}

export type DayTone = "sun" | "sat" | null;

/**
 * Weekend/holiday tone for one ISO day. A public holiday reads like a Sunday — that is the
 * convention on Korean calendars and the rule the dashboard already used before this was shared.
 * Derived from the date itself (UTC, matching the grid builders), never from a column index, so a
 * Monday-first grid needs no special case.
 */
export function dayTone(iso: string, holidays?: ReadonlyMap<string, string> | null): DayTone {
  if (holidays?.has(iso)) return "sun";
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (Number.isNaN(dow)) return null;
  return dow === 0 ? "sun" : dow === 6 ? "sat" : null;
}

/** Tone for a weekday header column, which has an index rather than a date. */
export function headerTone(index: number, weekStart: "sunday" | "monday"): DayTone {
  const sunday = weekStart === "monday" ? 6 : 0;
  const saturday = weekStart === "monday" ? 5 : 6;
  return index === sunday ? "sun" : index === saturday ? "sat" : null;
}

/** CSS colour for a tone. `null` tone falls back to the caller's own resting colour. */
export function toneColor(tone: DayTone, fallback = "var(--muted)"): string {
  return tone === "sun" ? "var(--danger)" : tone === "sat" ? "var(--info)" : fallback;
}

/**
 * Record-density fill for a day cell, normalised against the busiest day in view.
 *
 * One ladder for every surface: 8% accent at the faintest, 38% at the busiest — the range the
 * sidebar has used since it was built. (The dashboard month grid briefly used 4–14%, which read as
 * almost nothing next to the sidebar's tint of the same data; that is the drift this replaces.)
 * Returns null when there is nothing to paint, so callers can leave `background` undefined and let
 * their own today/selection rules paint through.
 */
export function recordTint(count: number, maxCount: number): string | null {
  if (count <= 0 || maxCount <= 0) return null;
  const density = Math.min(1, count / maxCount);
  return `color-mix(in srgb, var(--accent) ${Math.round(8 + density * 30)}%, transparent)`;
}
