import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CalendarItem, HabitWeek, TimelineRoutine } from "../../lib/commands.gen";

vi.mock("../../lib/invoke", () => ({ call: vi.fn(), callSilent: vi.fn() }));
vi.mock("../../lib/diag", () => ({ reportFallback: vi.fn() }));

import { call, callSilent } from "../../lib/invoke";
import { useSettingsStore } from "../../stores/settings";
import {
  applyHabitCheck,
  habitNudge,
  buildDayEntries,
  dayAfter,
  routinesForDay,
  todayHabitStats,
  useDaySchedule,
  useHabitWeek,
  useNow,
} from "./useBriefingData";
import { shouldStampLastSeen } from "./useBriefingData";
import { resetScheduleCache, scheduleMonth, scheduleRoutines, SCHEDULE_TTL_MS } from "../scheduleCache";
import { toIsoDateLocal } from "../../components/home/dateFmt";

const routine = (over: Partial<TimelineRoutine>): TimelineRoutine => ({
  id: "r1",
  workspace_id: "w",
  title: "출근",
  weekday_mask: 0b0011111, // 월~금
  start_time: "09:00",
  end_time: "10:00",
  color_hue: null,
  skip_holidays: false,
  position: 0,
  created_at: "",
  updated_at: "",
  ...over,
});

// 행 트리플 기본값은 span 에서 유도한다 — 서버 모양 그대로(시작 트리플 = span_start, 여러 날이면
// 종료 트리플 = span_end). 시각 판정(startsOnDay·rowIsSameDay)이 이 트리플을 읽는다. 월 첫날로
// 잘린 항목은 테스트가 트리플을 직접 넘긴다.
const item = (over: Partial<CalendarItem>): CalendarItem => {
  const spanStart = over.span_start ?? "2026-09-30";
  const spanEnd = over.span_end ?? spanStart;
  const [sy, sm, sd] = spanStart.split("-").map(Number);
  const [ey, em, ed] = spanEnd.split("-").map(Number);
  const multi = spanEnd !== spanStart;
  return {
    note_id: "n1",
    folder_id: "f",
    title: "치과",
    kind: "event",
    span_start: spanStart,
    span_end: spanEnd,
    year: sy,
    month: sm,
    day: sd,
    end_year: multi ? ey : null,
    end_month: multi ? em : null,
    end_day: multi ? ed : null,
    start_time: "13:00",
    end_time: "14:00",
    is_occurrence: null,
    remind: false,
    date_id: "d1",
    position: 0,
    remind_offset_min: null,
    rrule: null,
    ...over,
  };
};

describe("dayAfter", () => {
  it("월·연 경계를 넘는다", () => {
    expect(dayAfter("2026-09-30", 1)).toBe("2026-10-01");
    expect(dayAfter("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayAfter("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("형식이 깨졌으면 그대로 돌려준다", () => {
    expect(dayAfter("nope", 1)).toBe("nope");
  });
});

describe("routinesForDay (요일 마스크)", () => {
  // 2026-09-30 수요일, 2026-10-03 토요일
  it("평일 마스크는 수요일에 걸리고 토요일에는 안 걸린다", () => {
    expect(routinesForDay([routine({})], "2026-09-30", false)).toHaveLength(1);
    expect(routinesForDay([routine({})], "2026-10-03", false)).toHaveLength(0);
  });
  it("공휴일이면 skip_holidays 반복 일정만 뺀다", () => {
    const list = [routine({ id: "a", skip_holidays: true }), routine({ id: "b" })];
    expect(routinesForDay(list, "2026-09-30", true).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("buildDayEntries", () => {
  it("반복 일정과 노트 일정을 시각순으로 합치고 종일은 뒤로 보낸다", () => {
    const e = buildDayEntries(
      "2026-09-30",
      [routine({})],
      [item({}), item({ date_id: "d2", title: "종일", start_time: null, end_time: null })],
      false,
    );
    expect(e.map((x) => x.title)).toEqual(["출근", "치과", "종일"]);
  });
  it("그 날을 덮지 않는 항목·중복 date_id 는 제외한다", () => {
    const e = buildDayEntries(
      "2026-09-30",
      [],
      [item({ span_start: "2026-10-01", span_end: "2026-10-01" }), item({}), item({})],
      false,
    );
    expect(e).toHaveLength(1);
  });
  it("새 노트의 센티널 제목은 '제목 없음' 문구로 바꿔 싣는다(브리핑 창은 notes 스토어가 없다)", () => {
    const e = buildDayEntries("2026-09-30", [], [item({ title: "Untitled Note" }), item({ date_id: "d3", title: "" })], false);
    expect(e.map((x) => x.title)).not.toContain("Untitled Note");
    expect(e.every((x) => x.title.length > 0)).toBe(true);
  });
  it("여러 날 기간의 시작일이 아닌 날은 종일로 본다", () => {
    const e = buildDayEntries("2026-10-01", [], [item({ span_start: "2026-09-30", span_end: "2026-10-02" })], false);
    expect(e[0].start).toBeNull();
  });
  it("내일 계산은 dayAfter 로 월 경계를 넘어도 그 날 항목을 고른다", () => {
    const tomorrow = dayAfter("2026-09-30", 1);
    const e = buildDayEntries(tomorrow, [routine({})], [item({ span_start: tomorrow, span_end: tomorrow })], false);
    expect(e.map((x) => x.title)).toEqual(["출근", "치과"]); // 10/1 은 목요일
    expect(e[1].start).toBe("13:00");
  });

  // 2026-10-18 회귀 — 매일 반복 + 회차 하나가 27일짜리(23:22) 행. 10월 조회의 회차는 span_start
  // 오름차순이라, 9월에 시작해 이어지는 회차(span_start 가 10/01 로 잘림)가 그 날 시작하는 회차보다
  // 먼저 온다. 첫 것을 남기면 23:22 일정이 종일 칩으로 보였다.
  const dailyOcc = (rawDay: string, spanEnd: string) => {
    const [y, m, d] = rawDay.split("-").map(Number);
    const [ey, em, ed] = spanEnd.split("-").map(Number);
    return item({
      date_id: "row-daily",
      title: "매일",
      kind: "span",
      span_start: rawDay < "2026-10-01" ? "2026-10-01" : rawDay,
      span_end: spanEnd,
      year: y,
      month: m,
      day: d,
      end_year: ey,
      end_month: em,
      end_day: ed,
      start_time: "23:22",
      end_time: null,
      is_occurrence: true,
      rrule: "FREQ=DAILY",
    });
  };

  it("ⓐ 같은 행의 회차가 겹치면 그 날 시작하는 회차를 남긴다 — 23:22 시각 항목 하나", () => {
    const e = buildDayEntries(
      "2026-10-18",
      [],
      [dailyOcc("2026-09-21", "2026-10-18"), dailyOcc("2026-10-01", "2026-10-28"), dailyOcc("2026-10-18", "2026-11-14")],
      false,
    );
    expect(e).toHaveLength(1);
    expect(e[0].start).toBe("23:22");
  });

  it("ⓐ 1일에도 잘린 이어지는 회차가 아니라 1일에 시작한 회차가 시각을 갖는다", () => {
    const e = buildDayEntries("2026-10-01", [], [dailyOcc("2026-09-21", "2026-10-18"), dailyOcc("2026-10-01", "2026-10-28")], false);
    expect(e.map((x) => x.start)).toEqual(["23:22"]);
  });

  it("ⓑ 1일로 잘린 다일 시각 스팬(원래 9/30 09:00 시작)은 10/01 에 종일이다", () => {
    const e = buildDayEntries(
      "2026-10-01",
      [],
      [item({ kind: "span", span_start: "2026-10-01", span_end: "2026-10-03", year: 2026, month: 9, day: 30, start_time: "09:00", end_time: "18:00" })],
      false,
    );
    expect(e[0].start).toBeNull();
    expect(e[0].end).toBeNull();
  });

  it("여러 날 기간의 첫날은 시작 시각만 — 끝 시각은 마지막 날 것이라 쓰지 않는다", () => {
    const e = buildDayEntries(
      "2026-09-30",
      [],
      [item({ kind: "span", span_start: "2026-09-30", span_end: "2026-10-02", start_time: "09:00", end_time: "18:00" })],
      false,
    );
    expect([e[0].start, e[0].end]).toEqual(["09:00", null]);
  });
});

const habitRow = (id: string, title: string, days: HabitWeek["rows"][number]["days"], done: number, sched: number) => ({
  habit: { id, workspace_id: "w", title, icon: null, hue: null, weekday_mask: 127, position: 0, archived_at: null, created_at: "", time_of_day: "any" },
  days,
  streak: 0,
  done_count: done,
  scheduled_count: sched,
  rate: sched ? done / sched : null,
});

describe("습관 계산", () => {
  const week: HabitWeek = {
    from: "2026-09-24",
    to: "2026-09-30",
    today: "2026-09-30",
    done_count: 1,
    scheduled_count: 3,
    rate: 1 / 3,
    rows: [
      habitRow("h1", "독서", [
        { day: "2026-09-29", scheduled: true, done: false },
        { day: "2026-09-30", scheduled: true, done: true },
      ], 1, 2),
      habitRow("h2", "운동", [
        { day: "2026-09-29", scheduled: true, done: false },
        { day: "2026-09-30", scheduled: false, done: false },
      ], 0, 1),
    ],
  };

  it("todayHabitStats 는 기준일에 해당 요일인 습관만 센다", () => {
    expect(todayHabitStats(week)).toEqual({ done: 1, total: 1 });
  });
  it("habitNudge: 예정 0개 null / 남은 1개(하나 이상 완료) one_more / 전부 all_done / 그 외 null", () => {
    const row = (id: string, done: boolean) =>
      habitRow(id, id, [{ day: "2026-09-30", scheduled: true, done }], done ? 1 : 0, 1);
    const w = (...rows: ReturnType<typeof row>[]): HabitWeek => ({ ...week, rows });
    expect(habitNudge(w())).toBeNull();
    expect(habitNudge(w(row("a", true), row("b", false)))).toEqual({ kind: "one_more" });
    expect(habitNudge(w(row("a", true), row("b", true)))).toEqual({ kind: "all_done" });
    expect(habitNudge(w(row("a", false), row("b", false)))).toBeNull();
    expect(habitNudge(w(row("a", false)))).toBeNull(); // 하나뿐이면 재촉하지 않는다
    expect(habitNudge(week)).toEqual({ kind: "all_done" }); // 쉬는 요일 습관(h2)은 세지 않는다
  });
  it("applyHabitCheck: 기준일 체크만 스트릭 ±1, 다른 날·쉬는 날은 그대로", () => {
    const w: HabitWeek = {
      ...week,
      rows: [{ ...week.rows[0], streak: 3 }, { ...week.rows[1], streak: 2 }],
    };
    expect(applyHabitCheck(w, "h1", "2026-09-30", false).rows[0].streak).toBe(2);
    expect(applyHabitCheck(w, "h1", "2026-09-30", true).rows[0].streak).toBe(3); // 이미 done — 변화 없음
    expect(applyHabitCheck(w, "h1", "2026-09-29", true).rows[0].streak).toBe(3);
    expect(applyHabitCheck(w, "h2", "2026-09-30", true).rows[1].streak).toBe(2); // 오늘이 쉬는 요일
    const zero: HabitWeek = { ...week, rows: [{ ...week.rows[0], streak: 0 }] };
    expect(applyHabitCheck({ ...zero, rows: [{ ...zero.rows[0], days: [{ day: "2026-09-30", scheduled: true, done: false }] }] }, "h1", "2026-09-30", true).rows[0].streak).toBe(1);
  });
  it("applyHabitCheck 는 그 칸만 바꾸고 집계를 다시 계산한다", () => {
    const next = applyHabitCheck(week, "h1", "2026-09-29", true);
    expect(next.rows[0].done_count).toBe(2);
    expect(next.rows[0].rate).toBe(1);
    expect(next.done_count).toBe(2);
    expect(next.rows[1]).toBe(week.rows[1]);
    expect(week.rows[0].done_count).toBe(1); // 원본 불변
  });
});

describe("useHabitWeek 낙관적 체크 + 롤백", () => {
  const week: HabitWeek = {
    from: "2026-09-24",
    to: "2026-09-30",
    today: "2026-09-30",
    done_count: 0,
    scheduled_count: 1,
    rate: 0,
    rows: [habitRow("h1", "독서", [{ day: "2026-09-30", scheduled: true, done: false }], 0, 1)],
  };

  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(callSilent).mockReset();
    vi.mocked(callSilent).mockResolvedValue(week);
    useSettingsStore.setState({ activeWorkspaceId: "w" });
  });

  it("성공하면 체크 상태가 유지된다", async () => {
    vi.mocked(call).mockResolvedValue({ habit_id: "h1", day: "2026-09-30", done: true });
    const { result } = renderHook(() => useHabitWeek("2026-09-30"));
    await waitFor(() => expect(result.current.week).not.toBeNull());
    await act(async () => {
      await result.current.toggle("h1", "2026-09-30", true);
    });
    expect(result.current.week!.rows[0].days[0].done).toBe(true);
    expect(call).toHaveBeenCalledWith("habit_check", { habit_id: "h1", day: "2026-09-30", done: true });
  });

  it("저장이 실패하면 그 칸을 되돌린다", async () => {
    vi.mocked(call).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHabitWeek("2026-09-30"));
    await waitFor(() => expect(result.current.week).not.toBeNull());
    await act(async () => {
      await result.current.toggle("h1", "2026-09-30", true);
    });
    expect(result.current.week!.rows[0].days[0].done).toBe(false);
    expect(result.current.week!.rows[0].done_count).toBe(0);
  });
});

describe("useHabitWeek week_start", () => {
  it("전달한 주 시작 요일을 그대로 서버에 보낸다(null=롤링)", async () => {
    vi.mocked(callSilent).mockReset();
    vi.mocked(callSilent).mockResolvedValue({ from: "", to: "", today: "", rows: [], done_count: 0, scheduled_count: 0, rate: null });
    useSettingsStore.setState({ activeWorkspaceId: "w" });
    renderHook(() => useHabitWeek("2026-09-30", "monday"));
    renderHook(() => useHabitWeek("2026-09-30"));
    await waitFor(() => expect(callSilent).toHaveBeenCalledTimes(2));
    expect(callSilent).toHaveBeenCalledWith("habit_week", { workspace_id: "w", day: "2026-09-30", week_start: "monday" });
    expect(callSilent).toHaveBeenCalledWith("habit_week", { workspace_id: "w", day: "2026-09-30", week_start: null });
  });
});

describe("scheduleCache", () => {
  beforeEach(() => {
    resetScheduleCache();
    vi.mocked(callSilent).mockReset();
    vi.mocked(callSilent).mockImplementation(async (cmd: string) =>
      (cmd === "dashboard_calendar" ? { items: [] } : { routines: [] }) as never,
    );
  });
  const calls = (cmd: string) => vi.mocked(callSilent).mock.calls.filter((c) => c[0] === cmd).length;

  it.each([
    ["같은 월·동시 호출 = 1회(진행 중 공유)", [[2026, 9], [2026, 9]], 1],
    ["월말 경계(다음 달) = 추가 1회", [[2026, 9], [2026, 9], [2026, 10]], 2],
    ["다른 해 같은 달은 별도 키", [[2026, 9], [2027, 9]], 2],
  ] as const)("%s", async (_n, months, expected) => {
    await Promise.all(months.map(([y, m]) => scheduleMonth("w", y, m)));
    expect(calls("dashboard_calendar")).toBe(expected);
  });

  it("다른 노트북은 별도 키", async () => {
    await scheduleMonth("a", 2026, 9);
    await scheduleMonth("b", 2026, 9);
    expect(calls("dashboard_calendar")).toBe(2);
  });

  it("TTL 안에는 재사용, 지나면 재조회, fresh 는 항상 우회", async () => {
    vi.useFakeTimers();
    try {
      await scheduleRoutines("w");
      vi.advanceTimersByTime(SCHEDULE_TTL_MS - 1);
      await scheduleRoutines("w");
      expect(calls("timeline_routine_list")).toBe(1);
      await scheduleRoutines("w", true);
      expect(calls("timeline_routine_list")).toBe(2);
      vi.advanceTimersByTime(SCHEDULE_TTL_MS + 1);
      await scheduleRoutines("w");
      expect(calls("timeline_routine_list")).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("실패는 캐시하지 않는다", async () => {
    vi.mocked(callSilent).mockRejectedValueOnce(new Error("x"));
    await expect(scheduleMonth("w", 2026, 9)).rejects.toThrow();
    await Promise.resolve();
    await scheduleMonth("w", 2026, 9);
    expect(calls("dashboard_calendar")).toBe(2);
  });

  it("오늘·내일 카드는 같은 달이면 월 조회를 공유하고, reload 는 우회한다", async () => {
    useSettingsStore.setState({ activeWorkspaceId: "w", holidayRegion: "none" } as never);
    const a = renderHook(() => useDaySchedule("2026-09-15"));
    const b = renderHook(() => useDaySchedule("2026-09-16"));
    await waitFor(() => expect(a.result.current.status).toBe("ready"));
    await waitFor(() => expect(b.result.current.status).toBe("ready"));
    expect(calls("dashboard_calendar")).toBe(1);
    await act(async () => a.result.current.reload());
    await waitFor(() => expect(calls("dashboard_calendar")).toBe(2));
  });

  it("포커스 복귀: TTL 안이면 그대로, 지나면 다시 읽는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      useSettingsStore.setState({ activeWorkspaceId: "w", holidayRegion: "none" } as never);
      const a = renderHook(() => useDaySchedule("2026-09-15"));
      await waitFor(() => expect(a.result.current.status).toBe("ready"));
      act(() => void window.dispatchEvent(new Event("focus")));
      expect(calls("dashboard_calendar")).toBe(1);
      vi.setSystemTime(Date.now() + SCHEDULE_TTL_MS + 1000);
      act(() => void window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(calls("dashboard_calendar")).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("자정 넘김", () => {
  it("useNow tick 으로 로컬 날짜가 바뀌면 오늘 day 가 갱신된다", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 40)); // 로컬 시각
      const { result } = renderHook(() => toIsoDateLocal(useNow(10_000)));
      expect(result.current).toBe("2026-09-30");
      act(() => void vi.advanceTimersByTime(30_000));
      expect(result.current).toBe("2026-10-01");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shouldStampLastSeen", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  it.each([
    ["", true],
    ["garbage", true],
    ["2026-09-30T11:57:00Z", false], // 3분 전 — 쓰지 않는다
    ["2026-09-30T11:54:00Z", true], // 6분 전
    ["2026-09-30T12:30:00Z", true], // 미래 값은 바로잡는다
  ])("%s → %s", (prev, expected) => {
    expect(shouldStampLastSeen(prev, now)).toBe(expected);
  });
});
