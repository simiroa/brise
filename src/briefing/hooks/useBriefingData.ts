/**
 * 브리핑 창의 데이터 관문 — 카드는 IPC 를 직접 부르지 않고 여기 훅만 쓴다(PLAN-2026-09-30 §2).
 * 창 하나가 자체 zustand 스토어를 가지므로 노트 스토어는 쓰지 않고 전부 커맨드로 읽는다.
 *
 * 규칙: 날짜는 전부 **로컬일** 문자열("YYYY-MM-DD"). 순수 계산(요일 마스크·내일·새 항목 수·체크 갱신)은
 * 훅 밖 함수로 빼서 테스트한다. 실패는 카드가 조용히 비지 않도록 status "error" + reportFallback.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { call, callSilent } from "../../lib/invoke";
import { scheduleMonth, scheduleRoutines, SCHEDULE_TTL_MS } from "../scheduleCache";
import { useScheduleVersion } from "../scheduleVersion";
import { cachedRequest, invalidate } from "../requestCache";
import { reportFallback } from "../../lib/diag";
import { storedTitleOrEmpty } from "../../lib/noteTitle";
import { t } from "../../i18n/t";
import { holidaysForYear } from "../../lib/holidays";
import { collapseOccurrencesForDay, rowIsSameDay, startsOnDay } from "../../components/home/calendarLayout";
import { isoWeekdayBit } from "../../components/home/dateFmt";
import { FACTORY_DEFAULT_MAP_LOCATION, useSettingsStore } from "../../stores/settings";
import {
  fetchDailyForecast,
  fetchHourlyForecast,
  fetchWeather,
  resolveWeatherLocation,
  type DailyForecast,
  type HourlyForecast,
  type LatLng,
  type WeatherSnapshot,
} from "../../lib/weather";
import type {
  CalendarItem,
  BriefingRecentCollectedOutput,
  BriefingRecentNotesOutput,
  CollectedNote,
  CollectSource,
  HabitHistory,
  HabitWeek,
  RecentWorkNote,
  TimelineRoutine,
} from "../../lib/commands.gen";

export type LoadStatus = "loading" | "ready" | "error";

/* ───────────────────────── 순수 계산 ───────────────────────── */

/** (연, 0기준 월, 일) → "YYYY-MM-DD". */
export const ymd = (y: number, m0: number, d: number) => `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** "YYYY-MM-DD" 에 n 일을 더한다 — UTC 산술이라 DST·타임존에 흔들리지 않는다. */
export function dayAfter(day: string, n: number): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface DayEntry {
  key: string;
  title: string;
  /** "HH:MM" — null 이면 종일. */
  start: string | null;
  end: string | null;
  kind: "routine" | "event";
  noteId: string | null;
  hue: number | null;
}

/** 그 날의 요일 비트에 걸리는 반복 일정(공휴일이면 skip_holidays 인 것 제외). */
export function routinesForDay(routines: TimelineRoutine[], day: string, isHoliday: boolean): TimelineRoutine[] {
  const bit = isoWeekdayBit(day);
  if (bit === 0) return [];
  return routines.filter((r) => (r.weekday_mask & bit) !== 0 && !(isHoliday && r.skip_holidays));
}

/** 반복 일정 + 노트 일정을 시각순으로 합친다(종일은 뒤). 같은 노트의 반복 회차가 겹쳐도 한 번만. */
export function buildDayEntries(
  day: string,
  routines: TimelineRoutine[],
  items: CalendarItem[],
  isHoliday: boolean,
): DayEntry[] {
  const out: DayEntry[] = routinesForDay(routines, day, isHoliday).map((r) => ({
    key: `r:${r.id}`,
    title: r.title,
    start: r.start_time,
    end: r.end_time,
    kind: "routine",
    noteId: null,
    hue: r.color_hue,
  }));
  // 같은 날짜 행(date_id)의 회차가 그 날 여럿 겹치면 하나만 남긴다 — 남기는 것은 **그 날 시작하는
  // 회차**다. 서버 정렬(span_start 오름차순)대로 첫 것을 남기면, 지난달에 시작해 이어지는 회차
  // (span_start 가 1일로 잘린 것)가 먼저 와서 그 날 23:22 에 시작하는 회차를 밀어내고 종일로
  // 보였다(2026-10-18).
  const dayItems = collapseOccurrencesForDay(items, day);
  for (const it of dayItems) {
    // 시각은 그 날 시작하는 항목만 갖는다(잘린 span_start 가 아니라 행의 시작 — startsOnDay).
    // 끝 시각은 행의 마지막 날 것이라(§1.3 I3) 하루짜리 행에서만 이 날의 끝이다.
    const timed = it.start_time != null && startsOnDay(it, day);
    out.push({
      key: `e:${it.date_id}`,
      // 센티널 제목("Untitled Note")이 브리핑 카드에 그대로 새지 않게 — 이 창은 notes 스토어를 싣지 않는다.
      title: storedTitleOrEmpty(it.title) || t("briefing.recent_untitled"),
      start: timed ? it.start_time : null,
      end: timed && rowIsSameDay(it) ? it.end_time : null,
      kind: "event",
      noteId: it.note_id,
      hue: null,
    });
  }
  return out.sort((a, b) => {
    if (a.start === null && b.start === null) return 0;
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return a.start.localeCompare(b.start);
  });
}

/** 습관 체크 한 칸을 바꾼 새 HabitWeek — 낙관적 갱신과 롤백(반대값으로 다시 적용)이 같은 함수를 쓴다. */
export function applyHabitCheck(week: HabitWeek, habitId: string, day: string, done: boolean): HabitWeek {
  const rows = week.rows.map((row) => {
    if (row.habit.id !== habitId) return row;
    const days = row.days.map((d) => (d.day === day ? { ...d, done } : d));
    const done_count = days.filter((d) => d.scheduled && d.done).length;
    // 스트릭은 기준일(오늘) 체크만 정확히 ±1 이다(미체크 오늘은 어제부터 세므로). 다른 날 체크는 이음/끊김이
    // 서버 집계에 달려 있어 여기서 추측하지 않고, useHabitWeek.toggle 이 성공 뒤 재조회한다.
    const todayCell = day === week.today ? row.days.find((d) => d.day === day) : undefined;
    const streak =
      todayCell?.scheduled && todayCell.done !== done ? Math.max(0, row.streak + (done ? 1 : -1)) : row.streak;
    return {
      ...row,
      days,
      streak,
      done_count,
      rate: row.scheduled_count > 0 ? done_count / row.scheduled_count : null,
    };
  });
  const done_count = rows.reduce((s, r) => s + r.done_count, 0);
  return {
    ...week,
    rows,
    done_count,
    rate: week.scheduled_count > 0 ? done_count / week.scheduled_count : null,
  };
}

/**
 * 오늘 넛지 한 줄 — 기준일에 해당 요일인 습관 기준. 0개면 null, 전부 끝났으면 all_done,
 * 이미 하나 이상 끝냈고 남은 게 정확히 1개면 one_more(습관이 하나뿐일 때 "하나만 더"는 재촉이라 제외).
 */
export type HabitNudge = { kind: "one_more" | "all_done" };
export function habitNudge(week: HabitWeek): HabitNudge | null {
  const { done, total } = todayHabitStats(week);
  if (total === 0) return null;
  if (done === total) return { kind: "all_done" };
  if (total >= 2 && total - done === 1) return { kind: "one_more" };
  return null;
}

/** 헤더 "n/m 완료" — 기준일(week.today)에 해당 요일인 습관만 센다. */
export function todayHabitStats(week: HabitWeek): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const row of week.rows) {
    const d = row.days.find((x) => x.day === week.today);
    if (!d?.scheduled) continue;
    total += 1;
    if (d.done) done += 1;
  }
  return { done, total };
}

/** "HH:MM" → 분. 형식이 깨졌으면 null. */
export function timeToMinutes(hhmm: string | null | undefined): number | null {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h * 60 + min;
}

/* ───────────────────────── 훅 ───────────────────────── */

/** 비동기 조회 한 개의 loading/ready/error + 다시 불러오기. 언마운트·deps 변경 뒤 도착한 응답은 버린다. */
function useLoad<T>(
  load: ((fresh: boolean) => Promise<T>) | null,
  deps: unknown[],
  opts?: { focusAlways?: boolean },
): {
  status: LoadStatus;
  data: T | null;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
} {
  const [state, setState] = useState<{ status: LoadStatus; data: T | null }>({ status: "loading", data: null });
  const [tick, setTick] = useState(0);
  const fresh = useRef(false); // reload()/포커스 복귀 뒤의 다음 로드는 캐시를 우회한다
  const loadedAt = useRef(0);
  const lastDeps = useRef<string | null>(null);
  useEffect(() => {
    if (!load) {
      setState({ status: "loading", data: null });
      return;
    }
    let cancelled = false;
    // 조회 대상(deps)이 바뀐 로드, 또는 아직 ready 가 아닌 상태의 재시도만 loading 으로 — 같은 대상의 재조회(포커스·reload)는
    // 기존 값을 그대로 보여 주며 갱신한다(카드가 깜빡이지 않게).
    const depsKey = JSON.stringify(deps);
    const depsChanged = lastDeps.current !== depsKey;
    lastDeps.current = depsKey;
    setState((s) => (depsChanged || s.status !== "ready" ? { status: "loading", data: s.data } : s));
    const bypass = fresh.current;
    fresh.current = false;
    load(bypass)
      .then((data) => {
        loadedAt.current = Date.now();
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch(() => {
        // callSilent 가 이미 logError 로 남겼다 — 여기서는 카드가 오류 상태를 그리도록만 한다.
        if (!cancelled) setState((s) => ({ status: "error", data: s.data }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => {
    fresh.current = true;
    setTick((n) => n + 1);
  }, []);
  // 본 창에서 바뀐 일정·습관·노트 반영: 창이 포커스로 돌아왔고 마지막 로드가 TTL 보다 오래됐으면 새로 읽는다.
  const enabled = load !== null;
  const focusAlways = opts?.focusAlways === true;
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      // focusAlways(일정 카드) — 설정 창에서 반복 일정을 고치고 돌아오면 TTL 안이어도 다시 읽는다. scheduleCache 가 반복
      // 일정 항목을 이미 포커스에서 만료시켰으므로 캐시 우회(fresh)는 필요 없다(월 조회는 TTL 규칙 그대로).
      if (focusAlways) setTick((n) => n + 1);
      else if (Date.now() - loadedAt.current > SCHEDULE_TTL_MS) reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, reload, focusAlways]);
  const setData = useCallback(
    (fn: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: fn(s.data) })),
    [],
  );
  return { status: state.status, data: state.data, reload, setData };
}

/** 일정이 바뀌었다는 신호(scheduleVersion)가 오면 같은 대상을 다시 읽는다 — 첫 값은 건너뛴다(마운트 로드와 겹치지 않게). */
export function useReloadOnScheduleChange(reload: () => void): void {
  const v = useScheduleVersion();
  const first = useRef(v);
  useEffect(() => {
    if (v !== first.current) reload();
  }, [v, reload]);
}

/** 하루치 일정(반복 일정 + 노트 일정). 반복 일정 조회만 실패하면 노트 일정은 보여 주고 폴백을 남긴다. */
export function useDaySchedule(day: string): { status: LoadStatus; entries: DayEntry[]; reload: () => void } {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const holidayRegion = useSettingsStore((s) => s.holidayRegion);
  const { status, data, reload } = useLoad<DayEntry[]>(
    workspaceId
      ? async (fresh) => {
          const [y, m] = day.split("-").map(Number);
          // 창 단위 캐시(scheduleCache) — 오늘·내일·시간축 카드가 같은 월 조회를 공유한다.
          const [routines, cal] = await Promise.all([
            scheduleRoutines(workspaceId, fresh).then((r) => r, (): TimelineRoutine[] | null => null),
            scheduleMonth(workspaceId, y, m, fresh).then((r) => r, (): CalendarItem[] | null => null),
          ]);
          if (routines === null && cal === null) throw new Error("schedule_unavailable");
          if (routines === null) reportFallback("briefing", "routine_list_failed", "schedule shown without routines");
          if (cal === null) reportFallback("briefing", "calendar_failed", "schedule shown without note events");
          const isHoliday = holidaysForYear(holidayRegion, y).has(day);
          return buildDayEntries(day, routines ?? [], cal ?? [], isHoliday);
        }
      : null,
    [workspaceId, day, holidayRegion],
    { focusAlways: true },
  );
  useReloadOnScheduleChange(reload);
  // 다른 날로 넘어가는 동안 이전 날의 일정이 새 날짜 밑에 남아 보이지 않게 ready 일 때만 내준다.
  return { status, entries: status === "ready" ? (data ?? []) : [], reload };
}

export interface DayItems {
  /** 이 값이 어느 날 것인가 — 날짜를 넘기는 동안 이전 날의 항목을 새 날짜 밑에 그리지 않게 대조한다. */
  day: string;
  /** 그 날을 품은 달의 dashboard_calendar 항목 그대로 — 축은 planTimedDay 로 그 날 것만 고른다. */
  items: CalendarItem[];
  /** 그 날 요일에 걸리는 반복 루틴(공휴일 제외 규칙까지 적용) — 축의 배경 띠. */
  routines: TimelineRoutine[];
  /** 그 날의 공휴일 이름(없으면 null). */
  holidayName: string | null;
}

/**
 * 쓰는 시간축(PLAN-2026-10-19 §4.3)의 데이터 — DayEntry 로 평탄화하기 **전**의 CalendarItem 이 필요하다
 * (축 칩은 date_id·rrule·is_occurrence 로 쓰기 경로를 탄다). 조회는 useDaySchedule 과 같은 캐시 키를 공유한다.
 * 반복 루틴 조회만 실패하면 노트 일정은 그대로 그리고 폴백을 남긴다(useDaySchedule 과 같은 규칙).
 */
export function useDayItems(day: string): { status: LoadStatus; data: DayItems | null; reload: () => void } {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const holidayRegion = useSettingsStore((s) => s.holidayRegion);
  const { status, data, reload } = useLoad<DayItems>(
    workspaceId
      ? async (fresh) => {
          const [y, m] = day.split("-").map(Number);
          const [routines, cal] = await Promise.all([
            scheduleRoutines(workspaceId, fresh).then((r) => r, (): TimelineRoutine[] | null => null),
            scheduleMonth(workspaceId, y, m, fresh).then((r) => r, (): CalendarItem[] | null => null),
          ]);
          if (cal === null) throw new Error("calendar_unavailable");
          if (routines === null) reportFallback("briefing", "routine_list_failed", "axis shown without routine bands");
          const holidayName = holidaysForYear(holidayRegion, y).get(day) ?? null;
          return { day, items: cal, routines: routinesForDay(routines ?? [], day, holidayName !== null), holidayName };
        }
      : null,
    [workspaceId, day, holidayRegion],
    { focusAlways: true },
  );
  useReloadOnScheduleChange(reload);
  // 같은 날의 재조회가 한 번 실패해도(useLoad 는 이전 값을 지킨다) 축을 비우지 않는다 — 날짜만 맞으면 그대로 그린다.
  return { status, data: data && data.day === day ? data : null, reload };
}

/** 습관 주간 + 낙관적 체크. 저장 실패 시 그 칸만 되돌린다(call() 이 토스트를 띄운 뒤 다시 throw). */
export function useHabitWeek(day: string, weekStart: "monday" | "sunday" | null = null): {
  status: LoadStatus;
  week: HabitWeek | null;
  reload: () => void;
  toggle: (habitId: string, checkDay: string, done: boolean) => Promise<void>;
  create: (title: string) => Promise<boolean>;
} {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const { status, data, reload, setData } = useLoad<HabitWeek>(
    workspaceId
      ? (fresh) =>
          cachedRequest(`habit:${workspaceId}:${day}:${weekStart}`, () => callSilent<HabitWeek>("habit_week", { workspace_id: workspaceId, day, week_start: weekStart }), { fresh })
      : null,
    [workspaceId, day, weekStart],
  );
  const toggle = useCallback(
    async (habitId: string, checkDay: string, done: boolean) => {
      setData((w) => (w ? applyHabitCheck(w, habitId, checkDay, done) : w));
      try {
        await call("habit_check", { habit_id: habitId, day: checkDay, done });
        invalidate("habit:"); // 다른 카드(같은 키)가 TTL 안의 옛 주간을 다시 쓰지 않게
        // 기준일이 아닌 날 체크는 스트릭이 바뀔 수 있다 — 서버 값으로 맞춘다(reload 는 기존 data 를 유지해 깜빡이지 않는다).
        if (checkDay !== day) reload();
      } catch {
        setData((w) => (w ? applyHabitCheck(w, habitId, checkDay, !done) : w));
      }
    },
    [setData, reload, day],
  );
  // 인라인 추가(카드 안 한 줄 입력) — 성공이면 true. 실패는 call() 이 토스트를 띄웠으니 false 만 돌려 입력을 지키게 한다.
  const create = useCallback(
    async (title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!trimmed || !workspaceId) return false;
      try {
        await call("habit_create", { workspace_id: workspaceId, title: trimmed });
      } catch {
        return false;
      }
      invalidate("habit:"); // 주간·히스토리 캐시가 둘 다 이 접두사 아래 있다
      reload();
      return true;
    },
    [workspaceId, reload],
  );
  return { status, week: data, reload, toggle, create };
}

/** 히트맵 열 수(주) — 이번 주 포함 12주. */
export const HEATMAP_WEEKS = 12;

/** "YYYY-MM-DD" 의 요일(0=일). UTC 로 읽어 타임존에 흔들리지 않는다. */
function utcDow(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * 히트맵 범위 — 설정의 주 시작 요일로 이번 주 첫날을 잡고 그 11주 전 첫날부터 오늘까지.
 * 오늘 이후는 부르지 않는다(habit_history 는 미래 날도 scheduled>0·done=0 으로 돌려준다).
 */
export function heatmapRange(today: string, weekStart: "monday" | "sunday" | null): { from: string; to: string } {
  const startDow = weekStart === "monday" ? 1 : 0;
  const weekFirst = dayAfter(today, -((utcDow(today) - startDow + 7) % 7));
  return { from: dayAfter(weekFirst, -7 * (HEATMAP_WEEKS - 1)), to: today };
}

/**
 * 습관 12주 히스토리(오늘의 습관 카드 히트맵). 캐시 키를 `habit:` 아래 두어 체크·추가 뒤의 invalidate("habit:") 가
 * 같이 비운다. 체크 뒤 갱신은 부르는 쪽(BriefingWindowApp)이 reload 로 맞춘다.
 */
export function useHabitHistory(today: string, weekStart: "monday" | "sunday" | null = null): {
  status: LoadStatus;
  history: HabitHistory | null;
  reload: () => void;
} {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const { from, to } = heatmapRange(today, weekStart);
  const { status, data, reload } = useLoad<HabitHistory>(
    workspaceId
      ? (fresh) =>
          cachedRequest(`habit:hist:${workspaceId}:${from}:${to}`, () => callSilent<HabitHistory>("habit_history", { workspace_id: workspaceId, from, to }), { fresh })
      : null,
    [workspaceId, from, to],
  );
  // 범위가 바뀌는 동안 이전 범위 값을 새 격자에 그리지 않는다.
  return { status, history: data && data.from === from ? data : null, reload };
}

/** 5분 이내에 이미 찍었으면 다시 쓰지 않는다 — 열 때마다 DB 쓰기 + 다른 창 브로드캐스트를 피한다. */
export const LAST_SEEN_REFRESH_MS = 5 * 60_000;
export function shouldStampLastSeen(prev: string, nowMs: number): boolean {
  const t = Date.parse(prev);
  if (!prev || Number.isNaN(t)) return true;
  const age = nowMs - t;
  return age < 0 || age >= LAST_SEEN_REFRESH_MS;
}

export interface RecentCollect {
  items: CollectedNote[];
  /** 창 세션 시작 시점의 briefing_last_seen 이후(없으면 24h) 수집된 수 — 세션 안에서 안 변한다. */
  newCount: number;
  /** 수집 소스가 하나라도 있는가 — 빈 목록이 "소스 없음"인지 "새 항목 없음"인지 가른다. */
  hasSources: boolean;
  /** 소스는 있는데 전부 "브리핑에 표시"가 꺼져 있다(E3) — 빈 목록의 세 번째 이유. */
  allHidden: boolean;
}

const RECENT_LIMIT = 5; // 카드 스타일·level 별 최대 표시 개수(5)

/**
 * 최근 수집 노트(PLAN-2026-09-30 W7) — notes.origin_source_id/collected_at 을 읽는 briefing_recent_collected.
 * since 는 창 세션 첫 로드 때 briefing_last_seen 을 **고정**해서 쓰고(재시도·재조회에도 그대로), 첫 성공 뒤에
 * 그 값을 "지금"으로 갱신한다 → 다음 열림부터 적용, 같은 세션의 "새 항목" 배지는 안 사라진다.
 * ponytail: 창 닫힘 훅(pagehide/onCloseRequested)은 WebView2 에서 신뢰가 안 돼 "첫 표시 직후"에 찍는다.
 * 창을 연 채 새로 들어온 항목은 다음 열림에서 새 항목으로 다시 잡힌다(놓치는 쪽이 아니라 중복 쪽 오차).
 */
export function useRecentCollect(): { status: LoadStatus; data: RecentCollect | null; reload: () => void } {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const loaded = useSettingsStore((s) => s.loaded);
  const frozenSince = useRef<string | null>(null);
  const stamped = useRef(false);
  const { status, data, reload } = useLoad<RecentCollect>(
    workspaceId && loaded
      ? async (fresh) => {
          if (frozenSince.current === null) frozenSince.current = useSettingsStore.getState().briefingLastSeen || "";
          const since = frozenSince.current;
          const startedAt = new Date().toISOString();
          const res = await cachedRequest(
            `recent:${workspaceId}:${since}:${RECENT_LIMIT}`,
            () =>
              callSilent<BriefingRecentCollectedOutput>("briefing_recent_collected", {
                workspace_id: workspaceId,
                ...(since ? { since } : {}),
                limit: RECENT_LIMIT,
              }),
            { fresh },
          );
          let hasSources = res.items.length > 0;
          let allHidden = false;
          if (!hasSources) {
            try {
              const src = await cachedRequest(
                `src:${workspaceId}`,
                () => callSilent<{ sources: CollectSource[] }>("collect_source_list", { workspace_id: workspaceId }),
                { fresh },
              );
              hasSources = src.sources.length > 0;
              allHidden = hasSources && src.sources.every((s) => s.show_in_briefing === false);
            } catch {
              // 조회 실패면 "소스 없음"이라고 단정하지 않는다 — 새 항목 없음 쪽 문구가 덜 거짓이다.
              reportFallback("briefing", "collect_sources_failed", "empty state assumes sources exist");
              hasSources = true;
            }
          }
          if (!stamped.current) {
            stamped.current = true;
            // ponytail: 5분 안에 다시 열면 그 사이 수집분이 "새 항목"으로 한 번 더 셀 수 있다 — 허용(쓰기·브로드캐스트 절감).
            try {
              if (shouldStampLastSeen(frozenSince.current ?? "", Date.now())) await useSettingsStore.getState().setBriefingLastSeen(startedAt);
            } catch {
              reportFallback("briefing", "last_seen_save_failed", "new-item badge may repeat next open");
            }
          }
          return { items: res.items, newCount: res.new_count, hasSources, allHidden };
        }
      : null,
    [workspaceId, loaded],
  );
  return { status, data, reload };
}

/**
 * 최근 작업 노트 — briefing_recent_notes(활동 기록 보관 7일 안의 생성·편집, last_at 내림차순).
 * 노트 쓰기 신호(scheduleVersion — remote-note-write 가 이미 울린다)에 맞춰 같은 대상을 다시 읽는다.
 */
export function useRecentNotes(): { status: LoadStatus; items: RecentWorkNote[]; reload: () => void } {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const { status, data, reload } = useLoad<RecentWorkNote[]>(
    workspaceId
      ? (fresh) =>
          cachedRequest(
            `rnotes:${workspaceId}:${RECENT_LIMIT}`,
            () => callSilent<BriefingRecentNotesOutput>("briefing_recent_notes", { workspace_id: workspaceId, limit: RECENT_LIMIT }),
            { fresh },
          ).then((r) => r.items)
      : null,
    [workspaceId],
  );
  useReloadOnScheduleChange(reload);
  return { status, items: data ?? [], reload };
}

export interface BriefingWeather {
  now: WeatherSnapshot | null;
  daily: DailyForecast | null;
  hourly: HourlyForecast | null;
}

/** 브리핑 창은 노트 스토어가 없어 노트 좌표 군집을 못 쓴다 → 저장된 기본 위치, 없으면 공장 기본. */
export function resolveBriefingLocation(): LatLng {
  const s = useSettingsStore.getState();
  const saved = s.defaultMapLocationCustomized ? s.defaultMapLocation : null;
  const r = resolveWeatherLocation(saved, []);
  return r ?? { lat: FACTORY_DEFAULT_MAP_LOCATION.lat, lng: FACTORY_DEFAULT_MAP_LOCATION.lng };
}

/** 현재·일 최고/최저·시간별. 현재값이 없으면 error; 시간별/일별만 없으면 그 부분만 숨기고 폴백을 남긴다. */
export function useBriefingWeather(): { status: LoadStatus; data: BriefingWeather | null; reload: () => void } {
  const regionEnabled = useSettingsStore((s) => s.regionEnabled);
  const lat = useSettingsStore((s) => s.defaultMapLocation.lat);
  const lng = useSettingsStore((s) => s.defaultMapLocation.lng);
  const customized = useSettingsStore((s) => s.defaultMapLocationCustomized);
  const { status, data, reload } = useLoad<BriefingWeather>(
    regionEnabled
      ? async () => {
          const loc = resolveBriefingLocation();
          const [now, daily, hourly] = await Promise.all([
            fetchWeather(loc),
            fetchDailyForecast(loc),
            fetchHourlyForecast(loc),
          ]);
          if (!now) throw new Error("weather_unavailable");
          if (!hourly || hourly.time.length < 2) reportFallback("briefing", "weather_hourly_missing", "curve hidden");
          return { now, daily, hourly };
        }
      : null,
    [regionEnabled, lat, lng, customized],
  );
  return { status, data, reload };
}

export { useNow } from "./useNow"; // 카드별 interval 대신 tickMs 별 공유 타이머
