/**
 * `useNextDayPlan` — 시간축 익일 구간의 다음 날 plan. 회귀 대상은 **조회 횟수**다(코드리뷰 2026-10-28): 날짜를 누를 때마다 다음 날이 든 달 전체를
 * `dashboard_calendar` 로 다시 받았다(대부분 달력 탭이 이미 든 그 달).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { CalendarItem } from "../../../lib/commands.gen";

const callSilentMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...a: unknown[]) => callSilentMock(...a),
  callSilent: (...a: unknown[]) => callSilentMock(...a),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

import { useSettingsStore } from "../../../stores/settings";
import { bumpNoteQueryVersion } from "../../../lib/noteQuery";
import { useNextDayPlan } from "./useDayDetailData";

function timedItem(noteId: string, iso: string, start: string): CalendarItem {
  const [y, m, d] = iso.split("-").map(Number);
  return {
    note_id: noteId,
    kind: "event",
    folder_id: "f",
    title: noteId,
    span_start: iso,
    span_end: iso,
    year: y,
    month: m,
    day: d,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: start,
    end_time: null,
    is_occurrence: null,
    remind: false,
    date_id: `d-${noteId}`,
    position: 0,
    remind_offset_min: null,
    rrule: null,
  } as CalendarItem;
}

const calls = () => callSilentMock.mock.calls.filter((c) => c[0] === "dashboard_calendar");

describe("useNextDayPlan — 조회 키는 (연, 월)", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    callSilentMock.mockImplementation(async (cmd: string, args: { year: number; month: number }) => {
      if (cmd !== "dashboard_calendar") return null;
      return { items: [timedItem(`n-${args.year}-${args.month}`, `${args.year}-${String(args.month).padStart(2, "0")}-10`, "01:00")] };
    });
    useSettingsStore.setState({ activeWorkspaceId: "ws1" } as never);
  });

  it("같은 달 안에서 날을 옮겨도 다시 받지 않고, 달이 바뀌면 한 번 더 받는다", async () => {
    const { result, rerender } = renderHook(({ day }) => useNextDayPlan(day, 4), { initialProps: { day: "2026-08-09" } });
    await waitFor(() => expect(result.current?.timed.map((e) => e.item.note_id)).toEqual(["n-2026-8"]));
    expect(calls()).toHaveLength(1);

    // 8/9 → 8/8: 다음 날은 8/9 로 바뀐다(같은 달). 조회 없이 받아 둔 달에서 plan 만 다시 만든다 — 8/10 일정은 8/9 의 plan 에 없다.
    rerender({ day: "2026-08-08" });
    expect(result.current?.timed).toEqual([]);
    rerender({ day: "2026-08-09" });
    await waitFor(() => expect(result.current?.timed.map((e) => e.item.note_id)).toEqual(["n-2026-8"]));
    expect(calls()).toHaveLength(1);

    // 월말: 8/31 의 다음 날은 9/1 — 다음 달이라 새로 받는다.
    rerender({ day: "2026-08-31" });
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1][1]).toMatchObject({ year: 2026, month: 9 });
  });

  it("부모가 그 달 데이터를 넘기면 조회하지 않고 그것을 쓴다 — 다른 달이면 스스로 받는다", async () => {
    const parent = { year: 2026, month: 8, items: [timedItem("p1", "2026-08-10", "02:00")] };
    const { result, rerender } = renderHook(({ day }) => useNextDayPlan(day, 4, parent), { initialProps: { day: "2026-08-09" } });
    expect(result.current?.timed.map((e) => e.item.note_id)).toEqual(["p1"]);
    expect(calls()).toHaveLength(0);

    rerender({ day: "2026-08-31" }); // 다음 날 9/1 — 부모의 달(8월)이 아니다
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1]).toMatchObject({ year: 2026, month: 9 });
  });

  it("달이 같아도 노트가 바뀌면(noteQueryVersion) 스스로 받는 달은 다시 읽는다", async () => {
    const { result } = renderHook(() => useNextDayPlan("2026-08-09", 4));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(calls()).toHaveLength(1);
    await act(async () => {
      bumpNoteQueryVersion();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(calls()).toHaveLength(2));
  });

  it("익일 구간이 꺼져 있으면(tailHours 0) 조회하지 않는다", () => {
    const { result } = renderHook(() => useNextDayPlan("2026-08-09", 0));
    expect(result.current).toBeNull();
    expect(calls()).toHaveLength(0);
  });
});
