import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NoteSummary } from "../lib/commands.gen";

const noteQueryCollectMock = vi.fn();
const noteRecordHistogramMock = vi.fn();
vi.mock("../lib/noteQuery", () => ({
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  noteRecordHistogram: (...args: unknown[]) => noteRecordHistogramMock(...args),
  useNoteQueryVersion: () => 0,
  EXPANDED_BOARD_MAX_NOTES: 5000,
}));

const callMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

import { useSearchStore } from "../stores/search";
import { useWorkspacesStore } from "../stores/workspaces";
import { MobileCalendarView } from "./MobileCalendarView";
import { t } from "../i18n/t";

// Local-time constructor (not a UTC ISO string) — matches todayLocal()'s own
// getFullYear/getMonth/getDate reads, so this can't slip a day under any host timezone
// (see leftpanel/expanded/CalendarExpanded.test.tsx's identical fixed-clock rationale).
const FIXED_NOW = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 local, midweek/mid-month
const TODAY = "2026-06-15";

function note(patch: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: patch.title ?? patch.id,
    year: 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: `${TODAY}T00:00:00Z`,
    updated_at: `${TODAY}T00:00:00Z`,
    month: null,
    day: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  noteQueryCollectMock.mockReset().mockResolvedValue({ notes: [], total: 0 });
  noteRecordHistogramMock.mockReset().mockResolvedValue({});
  callMock.mockReset().mockResolvedValue({ items: [], year: 2026, month: 6 });
  useWorkspacesStore.setState({
    workspaces: [{ id: "ws1", name: "Default" }],
    activeId: "ws1",
    loaded: true,
  } as any);
  useSearchStore.setState({
    yearFrom: 1900,
    yearTo: 2100,
    selectedTags: [],
    tagMode: "and",
    regionFilter: null,
    statusFilter: [],
  } as any);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MobileCalendarView", () => {
  it("fetches the visible month's day-count histogram (record axis, union)", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(noteRecordHistogramMock).toHaveBeenCalled());
    const [from, to, axis] = noteRecordHistogramMock.mock.calls[0]!;
    expect(from.slice(0, 7)).toBe(to.slice(0, 7));
    expect(axis).toBe("union");
    expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`)).toBeTruthy();
  });

  it("defaults to a 10-capped 'recently created' list when no day is picked", async () => {
    noteQueryCollectMock.mockResolvedValue({ notes: [note({ id: "n1", title: "Recent note" })], total: 1 });
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalled());
    const [axes, opts] = noteQueryCollectMock.mock.calls[0]!;
    expect(axes.sort).toBe("created_desc");
    expect(opts).toEqual({ maxNotes: 10 });
    expect(await screen.findByText("Recent note")).toBeTruthy();
  });

  it("reflects the shared filter axes (tags/status) into every note_query it issues", async () => {
    useSearchStore.setState({ selectedTags: ["travel"], statusFilter: ["done"] } as any);
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalled());
    const [axes] = noteQueryCollectMock.mock.calls[0]!;
    expect(axes.selectedTags).toEqual(["travel"]);
    expect(axes.statusFilter).toEqual(["done"]);
  });

  it("picking a day queries created/updated groups capped at the shared EXPANDED_BOARD_MAX_NOTES, not a per-view constant", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`)).toBeTruthy());

    noteQueryCollectMock.mockClear();
    fireEvent.click(screen.getByTestId(`mobile-calendar-day-${TODAY}`));

    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalledTimes(2));
    for (const call of noteQueryCollectMock.mock.calls) {
      expect(call[1]).toEqual({ maxNotes: 5000 });
    }
    const [createdAxes] = noteQueryCollectMock.mock.calls[0]!;
    expect(createdAxes.createdFrom).toBe(TODAY);
    expect(createdAxes.createdTo).toBe(TODAY);
  });

  it("re-tapping a selected day clears the pick", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    const cell = await screen.findByTestId(`mobile-calendar-day-${TODAY}`);
    fireEvent.click(cell);
    expect(cell.getAttribute("data-selected")).toBe("true");
    fireEvent.click(cell);
    expect(cell.getAttribute("data-selected")).toBeNull();
  });

  it("tapping a note row opens it", async () => {
    noteQueryCollectMock.mockResolvedValue({ notes: [note({ id: "n1", title: "Tap me" })], total: 1 });
    const onOpenNote = vi.fn();
    render(<MobileCalendarView onOpenNote={onOpenNote} />);
    const row = await screen.findByText("Tap me");
    fireEvent.click(row);
    expect(onOpenNote).toHaveBeenCalledWith("n1");
  });

  it("shows the shared expanded-view empty state when there is nothing to show", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("No notes to show")).toBeTruthy());
  });

  it("tones weekend cells (Sat/Sun) but not a midweek day, week starting Sunday", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`)).toBeTruthy());
    expect(screen.getByTestId("mobile-calendar-day-2026-06-13").getAttribute("data-tone")).toBe("sat");
    expect(screen.getByTestId("mobile-calendar-day-2026-06-14").getAttribute("data-tone")).toBe("sun");
    expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`).getAttribute("data-tone")).toBeNull();
  });

  it("shows a Today button only once navigated off the current month, and it jumps back", async () => {
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`)).toBeTruthy());
    expect(screen.queryByText(t("search.calendar_today"))).toBeNull();

    fireEvent.click(screen.getByLabelText(t("search.calendar_next_month")));
    const todayBtn = await screen.findByText(t("search.calendar_today"));

    fireEvent.click(todayBtn);
    await waitFor(() => expect(screen.getByTestId(`mobile-calendar-day-${TODAY}`)).toBeTruthy());
    expect(screen.queryByText(t("search.calendar_today"))).toBeNull();
  });

  // Wave PHONECAL requirements tests:
  // 1) Distinct loading state
  it("shows distinct loading state while fetching schedule or notes", async () => {
    let resolveSchedule: (v: any) => void = () => {};
    callMock.mockImplementation(() => new Promise((resolve) => { resolveSchedule = resolve; }));
    render(<MobileCalendarView onOpenNote={() => {}} />);
    expect(screen.getByTestId("mobile-calendar-loading")).toBeTruthy();
    expect(screen.getByText(t("mobile.calendar_loading"))).toBeTruthy();
    resolveSchedule({ items: [], year: 2026, month: 6 });
    await waitFor(() => expect(screen.queryByTestId("mobile-calendar-loading")).toBeNull());
  });

  // 2) Distinct error state with retry
  it("shows distinct error state ('불러오지 못했어요 — 다시 시도') on fetch failure and supports retry", async () => {
    callMock.mockRejectedValue(new Error("Network fail"));
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mobile-calendar-error")).toBeTruthy());
    expect(screen.getByText(t("mobile.calendar_load_failed"))).toBeTruthy();

    callMock.mockResolvedValue({ items: [], year: 2026, month: 6 });
    fireEvent.click(screen.getByText(t("mobile.calendar_load_failed")));
    await waitFor(() => expect(screen.queryByTestId("mobile-calendar-error")).toBeNull());
  });

  // 3) Distinct empty state
  it("shows distinct empty state when there are neither schedule items nor notes", async () => {
    callMock.mockResolvedValue({ items: [], year: 2026, month: 6 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });
    render(<MobileCalendarView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mobile-calendar-empty")).toBeTruthy());
    expect(screen.getByText(t("search.expanded_empty"))).toBeTruthy();
  });

  // 4) Schedule axis (timed + all-day) & schedule marker
  it("renders schedule markers on days with schedule, and shows timed and all-day schedule for the selected day", async () => {
    const items = [
      {
        note_id: "timed-1",
        folder_id: "f1",
        title: "회의",
        kind: "event",
        span_start: TODAY,
        span_end: TODAY,
        year: 2026,
        month: 6,
        day: 15,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "14:00",
        end_time: "15:00",
        is_occurrence: false,
        remind: false,
        date_id: "d1",
        position: 0,
        remind_offset_min: null,
        rrule: null,
      },
      {
        note_id: "allday-1",
        folder_id: "f1",
        title: "출장",
        kind: "span",
        span_start: TODAY,
        span_end: TODAY,
        year: 2026,
        month: 6,
        day: 15,
        end_year: 2026,
        end_month: 6,
        end_day: 15,
        start_time: null,
        end_time: null,
        is_occurrence: false,
        remind: false,
        date_id: "d2",
        position: 0,
        remind_offset_min: null,
        rrule: null,
      },
    ];
    callMock.mockResolvedValue({ items, year: 2026, month: 6 });
    const onOpenNote = vi.fn();
    render(<MobileCalendarView onOpenNote={onOpenNote} initialDay={TODAY} />);

    // 마커 확인
    await waitFor(() => expect(screen.getByTestId(`mobile-calendar-schedule-dot-${TODAY}`)).toBeTruthy());

    // 일정 영역 확인
    expect(await screen.findByTestId("mobile-calendar-schedule-group")).toBeTruthy();
    expect(screen.getByText("14:00 – 15:00")).toBeTruthy();
    expect(screen.getByText("회의")).toBeTruthy();
    expect(screen.getByText("출장")).toBeTruthy();

    // 클릭 시 열기 확인
    fireEvent.click(screen.getByText("회의"));
    expect(onOpenNote).toHaveBeenCalledWith("timed-1");
  });

  // 5) one DAILY overlapping row → one entry (CALRULE collapseOccurrencesForDay 검증)
  it("collapses a daily repeat row with multiple occurrences covering that day into exactly one entry", async () => {
    const items = [
      {
        note_id: "rep-note",
        folder_id: "f1",
        title: "매일 회의",
        kind: "event",
        span_start: "2026-06-14",
        span_end: TODAY,
        year: 2026,
        month: 6,
        day: 14,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "09:00",
        end_time: "10:00",
        is_occurrence: true,
        remind: false,
        date_id: "rep-row",
        position: 0,
        remind_offset_min: null,
        rrule: "FREQ=DAILY",
      },
      {
        note_id: "rep-note",
        folder_id: "f1",
        title: "매일 회의",
        kind: "event",
        span_start: TODAY,
        span_end: TODAY,
        year: 2026,
        month: 6,
        day: 15,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "09:00",
        end_time: "10:00",
        is_occurrence: true,
        remind: false,
        date_id: "rep-row",
        position: 0,
        remind_offset_min: null,
        rrule: "FREQ=DAILY",
      },
    ];
    callMock.mockResolvedValue({ items, year: 2026, month: 6 });
    render(<MobileCalendarView onOpenNote={() => {}} initialDay={TODAY} />);

    await waitFor(() => expect(screen.getByTestId("mobile-calendar-schedule-group")).toBeTruthy());
    // 1건으로 압축되어 '매일 회의' 항목이 화면에 정확히 1개만 렌더링되어야 함
    const matches = screen.getAllByText("매일 회의");
    expect(matches).toHaveLength(1);
  });
});
