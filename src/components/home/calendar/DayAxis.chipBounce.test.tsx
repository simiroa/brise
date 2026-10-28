/**
 * 칩 튐 회귀(코드리뷰 2026-10-28) — 키보드로 칩을 옮긴 직후, 아직 **옛 자리**를 담은 데이터(먼저 도착한 당일 plan 또는 익일 plan)가 오면
 * 칩이 옛 자리로 튀었다가 나머지가 도착해야 제자리로 돌아왔다. 이제 옛 자리 그대로인 데이터는 낡은 것으로 보고 낙관적 자리를 지킨다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import type { CalendarItem, NoteDate } from "../../../lib/commands.gen";
import { DayDetailPanel } from "./DayDetailPanel";
import { useSettingsStore } from "../../../stores/settings";
import { HOUR_ROW_H } from "../calendarLayout";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => callMock(...a),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));
vi.mock("../../../lib/noteQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/noteQuery")>()),
  bumpNoteQueryVersion: () => {},
}));
vi.mock("../../../lib/undo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/undo")>()),
  showUndoToast: () => {},
}));

const DAY = "2026-08-09";
const PX_PER_MIN = HOUR_ROW_H / 60;
const topOf = (min: number) => `${min * PX_PER_MIN}px`;

function item(noteId: string, start: string, day = DAY): CalendarItem {
  const [y, m, d] = day.split("-").map(Number);
  return {
    note_id: noteId,
    kind: "event",
    folder_id: "f",
    title: noteId,
    span_start: day,
    span_end: day,
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

function dbRow(noteId: string, start: string, day = 9): NoteDate {
  return {
    id: `d-${noteId}`,
    note_id: noteId,
    position: 0,
    year: 2026,
    month: 8,
    day,
    end_year: null,
    end_month: null,
    end_day: null,
    remind: false,
    created_at: "2026-08-01T00:00:00Z",
    start_time: start,
    end_time: null,
    remind_offset_min: null,
    rrule: null,
    label: null,
  } as NoteDate;
}

/** 다음 날(8/10) 조회는 우리가 쥔 resolver 로 늦게 풀어 준다 — 당일 plan 과 익일 plan 이 따로 도착하는 상황. */
let resolveTail: ((items: CalendarItem[]) => void) | null = null;

beforeEach(() => {
  callMock.mockReset();
  resolveTail = null;
  useSettingsStore.setState({ calendarAxisTailHours: 3, activeWorkspaceId: "ws1" } as never);
});

function mockBackend(rows: NoteDate[]) {
  callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "note_dates_list") return { dates: rows };
    if (cmd === "note_date_update") return { ...rows[0], ...args };
    if (cmd === "dashboard_calendar") {
      return new Promise((resolve) => {
        resolveTail = (items) => resolve({ items });
      });
    }
    throw { code: "IO", message: "test" };
  });
}

const panel = (detailNotes: CalendarItem[]) => (
  <DayDetailPanel selectedDay={DAY} monthLabel="2026년 8월" detailNotes={detailNotes} onOpen={() => {}} />
);

describe("칩 튐 — 옛 자리를 담은 데이터가 먼저 와도 낙관적 자리를 지킨다", () => {
  it("당일 plan 이 옛 자리로 다시 오면 칩은 옮긴 자리에 그대로 있고, 반영된 데이터가 오면 그 자리를 데이터가 잡는다", async () => {
    mockBackend([dbRow("m", "09:00")]);
    const { getByTestId, rerender } = render(panel([item("m", "09:00")]));
    const chip = () => getByTestId("cal-time-event-m");
    expect(chip().style.top).toBe(topOf(540));

    fireEvent.keyDown(chip(), { key: "ArrowDown" }); // +15분
    await waitFor(() => expect(chip().style.top).toBe(topOf(555)));
    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "note_date_update")).toBe(true));

    // 낡은 데이터(저장 반영 전의 옛 자리)가 먼저 도착 — 예전엔 여기서 칩이 09:00 으로 튀었다.
    rerender(panel([item("m", "09:00")]));
    expect(chip().style.top).toBe(topOf(555));

    // 반영된 데이터 — 이제 데이터가 진실이다(미리보기를 버려도 같은 자리).
    rerender(panel([item("m", "09:15")]));
    expect(chip().style.top).toBe(topOf(555));

    // 서버가 다른 값으로 다듬었다면 그 값을 따른다(미리보기가 남아 있지 않다).
    rerender(panel([item("m", "09:30")]));
    expect(chip().style.top).toBe(topOf(570));
  });

  it("익일 plan 이 따로 늦게 도착해도(옛 자리) 칩은 튀지 않는다", async () => {
    mockBackend([dbRow("m", "09:00")]);
    const { getByTestId, rerender } = render(panel([item("m", "09:00")]));
    const chip = () => getByTestId("cal-time-event-m");

    fireEvent.keyDown(chip(), { key: "ArrowDown" });
    await waitFor(() => expect(chip().style.top).toBe(topOf(555)));

    // 익일 조회가 이제서야 풀린다 — 당일 칩은 옛 자리 그대로인 데이터 속에 있다.
    await waitFor(() => expect(resolveTail).not.toBeNull());
    await act(async () => {
      resolveTail?.([item("t", "01:00", "2026-08-10")]);
    });
    rerender(panel([item("m", "09:00")]));
    expect(chip().style.top).toBe(topOf(555));
  });
});
