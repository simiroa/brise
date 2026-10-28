/**
 * PLAN-2026-09-11 사이드바 W2 — 미니 달력 아래 "오늘 할 일 / 월간 일정" 탭.
 * 오늘 할 일 = DayDetailBody(브리핑 `cal-day-briefing`), 날 = selectedDay ?? 오늘.
 * 월간 일정 = 옛 "날짜 미선택" 알림 목록, selectedDay 무시.
 * D6: 보는 달 dashboard_calendar 는 항상 1회, `day` 가 보는 달 밖이면 그 달을 하나 더.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../../../lib/commands.gen";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { CalendarExpanded } from "./CalendarExpanded";

const callMock = vi.fn();
const noteQueryCollectMock = vi.fn();
const noteRecordHistogramMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: vi.fn(),
}));

vi.mock("../../../lib/noteQuery", () => ({
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  noteRecordHistogram: (...args: unknown[]) => noteRecordHistogramMock(...args),
  useNoteQueryVersion: () => 0,
  bumpNoteQueryVersion: vi.fn(),
}));

// 20:00 — DayDetailPanel.test.tsx 의 "오늘 일정이 없으면 지금 시각으로 스크롤한다" 회귀와 같은
// 이유로 08:00~14:00 기본 스크롤 창 밖 시각을 쓴다(그 사고가 사이드바에서 실제로 났던 시간대).
const FIXED_NOW = new Date(2026, 7, 15, 20, 0, 0); // 2026-08-15 20:00 local (평일, 월 중순)
const CURRENT_MONTH_15 = "2026-08-15";

function makeNote(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    year: partial.year ?? 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: `${CURRENT_MONTH_15}T00:00:00Z`,
    updated_at: `${CURRENT_MONTH_15}T00:00:00Z`,
    month: null,
    day: null,
    ...partial,
  };
}

const MONTH_RESULT = {
  year: 2026,
  month: 8,
  items: [
    {
      note_id: "remind-1",
      folder_id: "f1",
      title: "Monthly reminder note",
      kind: "event",
      span_start: "2026-08-20",
      span_end: "2026-08-20",
      year: 2026,
      month: 8,
      day: 20,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: "10:00",
      end_time: null,
      is_occurrence: null,
      remind: true,
      date_id: "d-remind-1",
      position: 0,
      remind_offset_min: null,
      rrule: null,
    },
  ],
};

/** dashboard_calendar 외에 DayDetailBody 가 부르는 note_get_many·note_dates_list 에도 응답을 둔다. */
function calendarCalls() {
  return callMock.mock.calls.filter(([cmd]) => cmd === "dashboard_calendar");
}

describe("CalendarExpanded", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    callMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") return MONTH_RESULT;
      if (cmd === "note_get") return { note: { id: "remind-1", title: "Monthly reminder note" }, sections: [] };
      // DayDetailBody 의 본문 조회(발췌·할 일)는 노트 N 개를 한 번에 — note_get_many.
      if (cmd === "note_get_many") {
        return { notes: [{ note: { id: "remind-1", title: "Monthly reminder note" }, sections: [] }] };
      }
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "note_create") return { note: { id: "range-note-1" } };
      // createNoteForRange 가 끝에 loadTree() 를 부른다 — 그 안의 folder_list 가 형태 없는
      // {} 를 받으면 buildNoteIndex 가 undefined 를 순회하다 던지고, createNoteForRange 의
      // try/catch 가 그걸 삼켜 조용히 null 을 돌려준다(팝오버는 뜨지만 createdNoteId 가 안 채워짐).
      if (cmd === "folder_list") return { folders: [], notes_by_folder: {} };
      if (cmd === "settings_get_all") return { settings: {} };
      return {};
    });
    noteQueryCollectMock.mockReset().mockResolvedValue({ notes: [], total: 0 });
    noteRecordHistogramMock.mockReset().mockResolvedValue({ [CURRENT_MONTH_15]: 3 });
    useSettingsStore.setState({ activeWorkspaceId: "ws1", calendarAxisTailHours: 0 });
    useNotesStore.setState({
      activeNote: null,
      inboxId: "inbox1",
      folders: [],
      noteIndex: new Map([
        [
          "remind-1",
          makeNote({
            id: "remind-1",
            title: "Monthly reminder note",
            remind: true,
            day: 20,
            start_time: "10:00",
          }),
        ],
      ]),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the today tab: briefing shows today, month fetched once, no old header row", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(noteRecordHistogramMock).toHaveBeenCalled());
    const [from, to] = noteRecordHistogramMock.mock.calls[0];
    expect(from.slice(0, 7)).toBe(to.slice(0, 7));

    expect(screen.getByTestId("calendar-tab-today").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("cal-day-briefing")).toBeTruthy();
    expect(screen.getByTestId("cal-briefing-day").textContent).toBe("15");

    // D6 같은 달: 보는 달 1회.
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("dashboard_calendar", { workspace_id: "ws1", year: 2026, month: 8 })
    );
    expect(calendarCalls()).toHaveLength(1);

    // 옛 "날짜 헤더 줄"은 없다.
    expect(screen.queryByText("Pick a day")).toBeNull();
    expect(screen.queryByLabelText("선택 해제")).toBeNull();
  });

  // 2026-09-12 QA: DayDetailBody 이식 자체는 됐지만 "지금 이 시각" 눈금이 사이드바의 좁은 축
  // 창(≈6시간)에서 안 보인다는 신고가 있었다 — 실은 렌더는 됐고 08:00 고정 초기 스크롤에 가려진
  // 것이었다(DayDetailPanel.test.tsx 의 회귀 테스트가 스크롤 쪽을 잡는다). 이 테스트는 F-D07
  // 카탈로그에 빠져 있던 "눈금 자체가 뜨는가"를 사이드바에서 못 박는다.
  it("오늘 할 일 탭에 현재 시각 눈금이 뜬다", async () => {
    render(<CalendarExpanded />);
    expect(await screen.findByTestId("cal-time-now")).toBeTruthy();
    expect(screen.getByTestId("cal-time-now-label").textContent).toBe("20:00");
  });

  // PLAN-2026-10-10 W-E (D5) — 사이드바는 compact 변형: 날짜·날씨·현재 시각 한 줄, 구분선 없음.
  it("오늘 할 일 탭은 한 줄 헤더(compact)에 현재 시각을 띄운다", async () => {
    render(<CalendarExpanded />);
    const header = await screen.findByTestId("cal-day-briefing");
    expect(header.getAttribute("data-variant")).toBe("compact");
    expect(screen.getByTestId("cal-briefing-now").textContent).toBe("20:00");
    expect(screen.queryByTestId("cal-briefing-divider")).toBeNull();
  });

  it("picking a day moves the briefing to that day; picking it again returns to today", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(calendarCalls()).toHaveLength(1));

    const dayCell = await screen.findByTestId("calendar-day-2026-08-20");
    await act(async () => {
      await userEvent.click(dayCell);
    });
    expect(screen.getByTestId("cal-briefing-day").textContent).toBe("20");
    // 같은 달 안의 날짜 선택은 보는 달을 다시 부르지 않는다.
    expect(calendarCalls()).toHaveLength(1);

    await act(async () => {
      await userEvent.click(dayCell);
    });
    expect(screen.getByTestId("cal-briefing-day").textContent).toBe("15");
  });

  it("month tab lists the month's reminders and ignores the picked day", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(calendarCalls()).toHaveLength(1));
    await act(async () => {
      await userEvent.click(screen.getByTestId("calendar-tab-month"));
    });
    expect(await screen.findByText("Reminders this month")).toBeTruthy();
    expect(screen.getByText("Monthly reminder note")).toBeTruthy();
    expect(screen.getByText("20일 10:00")).toBeTruthy();
    expect(screen.getByTestId("cal-remind-badge-remind-1")).toBeTruthy();
    expect(screen.queryByTestId("cal-day-briefing")).toBeNull();

    await act(async () => {
      await userEvent.click(screen.getByTestId("calendar-day-2026-08-20"));
    });
    expect(screen.getByText("Reminders this month")).toBeTruthy();
    expect(screen.getByText("Monthly reminder note")).toBeTruthy();
    expect(screen.queryByTestId("cal-day-briefing")).toBeNull();
  });

  it("shows empty state message when no reminders exist for the month", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "dashboard_calendar" ? { year: 2026, month: 8, items: [] } : {}
    );
    render(<CalendarExpanded />);
    await act(async () => {
      await userEvent.click(screen.getByTestId("calendar-tab-month"));
    });
    expect(await screen.findByText("No reminders scheduled this month")).toBeTruthy();
  });

  it("D6: navigating to another month with no pick fetches the viewed month plus today's month", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(calendarCalls()).toHaveLength(1));
    callMock.mockClear();

    await act(async () => {
      await userEvent.click(screen.getByLabelText("Next month"));
    });
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
    const months = calendarCalls().map(([, args]) => args);
    expect(months).toContainEqual({ workspace_id: "ws1", year: 2026, month: 9 });
    expect(months).toContainEqual({ workspace_id: "ws1", year: 2026, month: 8 });
    // 오늘 할 일은 여전히 오늘.
    expect(screen.getByTestId("cal-briefing-day").textContent).toBe("15");
  });

  it("switching tabs does not refetch", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(calendarCalls()).toHaveLength(1));
    callMock.mockClear();
    noteRecordHistogramMock.mockClear();

    await act(async () => {
      await userEvent.click(screen.getByTestId("calendar-tab-month"));
    });
    await act(async () => {
      await userEvent.click(screen.getByTestId("calendar-tab-today"));
    });
    expect(calendarCalls()).toHaveLength(0);
    expect(noteRecordHistogramMock).not.toHaveBeenCalled();
  });

  // 2026-09-12 오너 요청 — 미니 달력도 대시보드 월 그리드와 같은 드래그-생성 팝오버
  // (CreateRangePopover)를 쓴다. useCalendarDrag 는 순수 훅이라 여기서 새로 만들지 않고 그대로
  // 재사용했다 — 이 두 테스트는 그 배선이 실제로 됐는지만 확인한다(드래그 판정 자체의 단위
  // 테스트는 useCalendarDrag 를 쓰는 CalendarTab.test.tsx 가 이미 갖고 있다).
  describe("미니 달력 드래그 생성 (같은 팝오버, 2026-09-12)", () => {
    // 하루짜리 범위(lo===hi)로 끝나는 드래그 — start→다른 날→start 순으로 훑어 useCalendarDrag
    // 의 "moved" 플래그는 세우되(순수 클릭과 구분) 최종 endDay 는 시작일로 되돌린다. 그러면
    // createNoteForRange 가 단일일 경로만 타서(lo===hi) replacePrimaryDate 를 안 부른다 — 이
    // 테스트가 확인하려는 건 배선(같은 훅·같은 팝오버)이지 다일 범위 생성 자체가 아니다(그건
    // CalendarTab.test.tsx 가 이미 있다).
    function dragWithinDay15() {
      const start = screen.getByTestId(`calendar-day-${CURRENT_MONTH_15}`);
      const other = screen.getByTestId("calendar-day-2026-08-16");
      fireEvent.pointerDown(start, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerEnter(other);
      fireEvent.pointerEnter(start);
      fireEvent.pointerUp(window, { clientX: 40, clientY: 10 });
    }

    it("드래그하면 CreateRangePopover 가 뜨고 노트를 즉시 만든다", async () => {
      render(<CalendarExpanded />);
      await waitFor(() => expect(calendarCalls()).toHaveLength(1));

      dragWithinDay15();

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({
        folder_id: "inbox1",
        year: 2026,
        month: 8,
        day: 15,
      })));
      expect(await screen.findByTestId("cal-create-pop")).toBeTruthy();
      // 날짜는 이미 드래그로 골랐다 — 팝오버 안에 또 달력 그리드가 없다(오너 피드백의 핵심).
      expect(screen.queryByTestId("date-range-calendar")).toBeNull();
    });

    it("취소하면 만든 노트를 purge 한다", async () => {
      render(<CalendarExpanded />);
      await waitFor(() => expect(calendarCalls()).toHaveLength(1));

      dragWithinDay15();
      await screen.findByTestId("cal-create-pop");
      // pendingNoteIdRef 가 채워질 때까지 — 이 testid 는 createdNoteId 가 있을 때만 그려진다,
      // note_create 가 "불렸다"만으로는 그 뒤 ref 대입까지 끝났다는 보장이 없다.
      await waitFor(() => expect(screen.getByTestId("cal-create-dates")).toBeTruthy());

      await act(async () => {
        fireEvent.click(screen.getByTestId("cal-create-cancel"));
      });

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_purge", { id: "range-note-1" }));
      expect(screen.queryByTestId("cal-create-pop")).toBeNull();
    });
  });
});
