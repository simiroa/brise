import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { CalendarItem, CalendarResult } from "../../lib/commands.gen";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useSearchStore } from "../../stores/search";
import { useAiStore } from "../../stores/ai";
import { useUiStore } from "../../stores/ui";
import {
  CalendarTab,
  parseCalendarScheduleProposal,
  addDaysIso,
  buildCalendarSchedulePrompt,
} from "./CalendarTab";

const callMock = vi.fn();
const selectNoteMock = vi.fn().mockResolvedValue(undefined);
const loadTreeMock = vi.fn().mockResolvedValue(undefined);
const ensureInboxIdMock = vi.fn().mockResolvedValue("inbox1");
const emitNoticeMock = vi.fn();
const generateFromPromptMock = vi.fn();
const ensureAiAskGateMock = vi.fn().mockResolvedValue(true);

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

vi.mock("../../stores/ai", async () => {
  const actual = await vi.importActual<typeof import("../../stores/ai")>("../../stores/ai");
  return {
    ...actual,
    ensureAiAskGate: (...args: unknown[]) => ensureAiAskGateMock(...args),
  };
});

function makeItem(partial: Partial<CalendarItem> & Pick<CalendarItem, "note_id" | "kind" | "span_start" | "span_end">): CalendarItem {
  return {
    title: partial.title ?? partial.note_id,
    year: 2026,
    month: 7,
    day: 12,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: null,
    end_time: null,
    is_occurrence: null,
    remind: false,
    date_id: `d-${partial.note_id}`,
    position: 0,
    remind_offset_min: null,
    rrule: null,
    ...partial,
    folder_id: partial.folder_id ?? "f1",
  };
}

/** beforeEach 의 `vi.setSystemTime(new Date(2026, 6, 15, ...))` 이 고정한 "오늘". 달력 탭은
 *  이 날을 기본 선택으로 열므로(2026-09-10 오너 결정) 여러 테스트가 이 칸을 눌러 선택을 푼다. */
const TODAY_ISO = "2026-07-15";

/** Pure click = pointerdown + pointerup on same cell (no move to another day). */
function clickDay(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { button: 0, clientX: 10, clientY: 10 });
}

describe("CalendarTab grid (Wave 5)", () => {
  beforeEach(() => {
    // Pin only Date (not setTimeout/setInterval, which the many `waitFor` calls below rely
    // on) to a safely mid-month day — the "past-end" fixture below derives a day-before value
    // from `now`, which must never underflow into the previous month for the test to be
    // deterministic regardless of when the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)); // 2026-07-15 local
    callMock.mockReset();
    selectNoteMock.mockReset().mockResolvedValue(undefined);
    loadTreeMock.mockReset().mockResolvedValue(undefined);
    ensureInboxIdMock.mockReset().mockResolvedValue("inbox1");
    emitNoticeMock.mockReset();
    generateFromPromptMock.mockReset();
    ensureAiAskGateMock.mockReset().mockResolvedValue(true);
    useSettingsStore.setState({ activeWorkspaceId: "ws1", uiLang: "en" });
    // Shared dashboard-wide state (stores/ui.ts) — reset so a filter left over from another
    // test in this file never leaks into an unrelated one.
    useUiStore.setState({ dashboardFolderFilter: null });
    // Module-level singleton shared with the dashboard search box — reset so a query left over
    // from another test in this file never leaks into an unrelated one.
    useSearchStore.setState({ query: "", searchResults: [] });
    useAiStore.setState({
      generateFromPrompt: generateFromPromptMock,
      promptPending: false,
      translateGateOk: true,
    } as never);
    useNotesStore.setState({
      selectNote: selectNoteMock,
      loadTree: loadTreeMock,
      ensureInboxId: ensureInboxIdMock,
      inboxId: "inbox1",
    } as never);
    const now = new Date();
    // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): the calendar renders every item
    // neutrally now — no deadline/urgency treatment. This single-day span's end (= start, full
    // day precision) is a day before "today" purely to prove that a past end date gets no
    // special styling here (the pin/dot for a remind-flagged past-end note is board-only).
    const overdueDay = Math.max(1, now.getDate() - 1);
    // Force view to current month via default state — mock returns empty + sample items.
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        const result: CalendarResult = {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          items: [
            makeItem({
              note_id: "ev1",
              kind: "event",
              title: "Point event",
              remind: true,
              span_start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-05`,
              span_end: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-05`,
              day: 5,
            }),
            makeItem({
              note_id: "sp1",
              kind: "span",
              title: "Jeju trip",
              span_start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-12`,
              span_end: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`,
              day: 12,
              end_year: now.getFullYear(),
              end_month: now.getMonth() + 1,
              end_day: 15,
            }),
            makeItem({
              note_id: "du1",
              kind: "span",
              title: "Overdue task",
              span_start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(overdueDay).padStart(2, "0")}`,
              span_end: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(overdueDay).padStart(2, "0")}`,
              day: overdueDay,
              end_year: now.getFullYear(),
              end_month: now.getMonth() + 1,
              end_day: overdueDay,
            }),
          ],
        };
        return result;
      }
      if (cmd === "note_record_histogram") {
        return { counts: [] };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads dashboard_calendar for the active workspace and renders the grid", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    const calCall = callMock.mock.calls.find((c) => c[0] === "dashboard_calendar");
    expect(calCall).toBeTruthy();
    expect(calCall![1]).toMatchObject({ workspace_id: "ws1" });
    expect(screen.getByTestId("home-calendar")).toBeTruthy();
    expect(screen.getByTestId("cal-grid")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Point event").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Jeju trip").length).toBeGreaterThan(0);
    // Dashboard Wave 3 (2026-08-01): a past end date renders exactly like any other span — no
    // deadline/overdue data attributes, no ⏰, no red coloring left in the DOM at all.
    expect(screen.getAllByText(/Overdue task/).length).toBeGreaterThan(0);
    const dueEl = screen.getAllByText(/Overdue task/)[0].closest("[data-kind='span']");
    expect(dueEl?.getAttribute("data-deadline")).toBeNull();
    expect(dueEl?.getAttribute("data-overdue")).toBeNull();
  });

  it("today highlight follows uiStore.todayIso when HomeHeader's minute tick rolls the day (dashboard audit P2 #4)", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getAllByText("Point event").length).toBeGreaterThan(0));

    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(screen.getByTestId(`home-cal-day-${todayIso}`).getAttribute("data-today")).toBe("true");

    const nextIso = addDaysIso(todayIso, 1)!;
    act(() => {
      useUiStore.setState({ todayIso: nextIso });
    });

    expect(screen.getByTestId(`home-cal-day-${todayIso}`).getAttribute("data-today")).toBeNull();
    expect(screen.getByTestId(`home-cal-day-${nextIso}`).getAttribute("data-today")).toBe("true");
  });

  it("dashboard_calendar failure shows an error banner, not the empty-month copy (dashboard audit P1 #3)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") throw { code: "DB", message: "boom" };
      if (cmd === "note_record_histogram") return { counts: [] };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(screen.getByTestId("cal-error")).toBeTruthy());
    expect(screen.queryByTestId("cal-month-empty")).toBeNull();
  });

  it("month nav buttons shift the requested month", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    const firstMonth = callMock.mock.calls.find((c) => c[0] === "dashboard_calendar")![1].month as number;
    fireEvent.click(screen.getByTestId("cal-next-month"));
    await waitFor(() => {
      const last = [...callMock.mock.calls].reverse().find((c) => c[0] === "dashboard_calendar");
      expect(last).toBeTruthy();
      const m = last![1].month as number;
      const y = last![1].year as number;
      // next month rolls year if needed
      if (firstMonth === 12) {
        expect(m).toBe(1);
        expect(y).toBeGreaterThanOrEqual(new Date().getFullYear());
      } else {
        expect(m).toBe(firstMonth + 1);
      }
    });
  });

  it("skips fetch when no active workspace", async () => {
    useSettingsStore.setState({ activeWorkspaceId: null });
    render(<CalendarTab />);
    await new Promise((r) => setTimeout(r, 30));
    // Only the workspace-gated dashboard_calendar fetch is under test here. The header weather
    // forecast (lib/weather.ts, via callSilent) is gated only on useWeatherLocation's
    // factory-default fallback, not on activeWorkspaceId — it fires either way, same as before
    // the met.no swap (it just used to go through raw fetch(), invisible to this callMock; now
    // it's visible because it shares the callSilent channel). The visibility toggle it used to
    // also depend on is gone (D11, 2026-09-12).
    expect(callMock.mock.calls.some((c) => c[0] === "dashboard_calendar")).toBe(false);
  });

  it("day click opens detail panel; note double-click calls selectNote", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getAllByText("Point event").length).toBeGreaterThan(0));

    const now = new Date();
    const day5 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-05`;
    const cell = screen.getByTestId(`home-cal-day-${day5}`);
    clickDay(cell);

    expect(cell.getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("cal-detail")).toBeTruthy();
    const card = await screen.findByTestId("cal-detail-note-ev1");
    fireEvent.click(card);
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(card.getAttribute("data-focused")).toBe("true");
    fireEvent.dblClick(card);
    expect(selectNoteMock).toHaveBeenCalledWith("ev1");
  });

  it("double-clicking a span bar opens the note directly and doesn't select the day cell (span wins)", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getAllByText("Jeju trip").length).toBeGreaterThan(0));

    const now = new Date();
    const startDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-12`;
    const cell = screen.getByTestId(`home-cal-day-${startDay}`);
    const bar = screen.getByTestId(`home-cal-span-sp1-${startDay}`);

    fireEvent.pointerDown(bar, { button: 0 });
    fireEvent.click(bar);
    // A single click only focuses the span in place — it doesn't open the note.
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(bar.getAttribute("data-focused")).toBe("true");

    fireEvent.dblClick(bar);
    expect(selectNoteMock).toHaveBeenCalledWith("sp1");
    // The underlying day cell must not also register the click as a day-select (span wins over
    // the cell's own pointerdown → detail-panel toggle).
    expect(cell.getAttribute("data-selected")).not.toBe("true");
  });

  it("a span crossing week rows shows its name once per row, not only on its start cell (2026-10-19)", async () => {
    // 07-17 (Fri) → 07-28 (Tue) touches three week rows whether the week starts Sunday or Monday,
    // and stays clear of the default-selected day (07-15), whose detail panel would repeat the title.
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        const result: CalendarResult = {
          year: 2026,
          month: 7,
          items: [
            makeItem({
              note_id: "lg1",
              kind: "span",
              title: "Long stay",
              span_start: "2026-07-17",
              span_end: "2026-07-28",
              day: 17,
              end_year: 2026,
              end_month: 7,
              end_day: 28,
            }),
          ],
        };
        return result;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      return {};
    });
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getByTestId("home-cal-span-lg1-2026-07-17")).toBeTruthy());

    const named: string[] = [];
    for (let d = 17; d <= 28; d++) {
      const day = `2026-07-${d}`;
      if (screen.getByTestId(`home-cal-span-lg1-${day}`).textContent?.includes("Long stay")) named.push(day);
    }
    expect(named).toHaveLength(3);
    expect(named[0]).toBe("2026-07-17");
  });

  it("drag across days shows create popover; confirm creates note with date range", async () => {
    const createdNotes: Record<string, Record<string, unknown>> = {};
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_calendar") {
        const now = new Date();
        return {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          items: [],
        } satisfies CalendarResult;
      }
      if (cmd === "note_create") {
        const note = {
          id: "new1",
          folder_id: "inbox1",
          title: "Untitled Note",
          year: args?.year ?? 2026,
          month: args?.month ?? null,
          day: args?.day ?? null,
          is_favorite: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          status: null,
          icon: null,
          lat: null,
          lng: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        };
        createdNotes[note.id] = note;
        return { note, sections: [], sources: [], attachments: [] };
      }
      // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_end was deleted — the multi-day path
      // now goes through lib/primaryDate.ts::replacePrimaryDate, which fetches the just-created
      // note's current state first.
      if (cmd === "note_get") {
        const note = createdNotes[args?.id as string];
        return { note, sections: [], sources: [], attachments: [] };
      }
      // W4b: 대표 편집은 note_date_update 한 번(옛 add+승격+삭제 컴포지트는 사라졌다).
      if (cmd === "note_dates_list") return { dates: [{ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null }] };
      if (cmd === "note_date_update") return { id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const start = screen.getByTestId(`home-cal-day-${y}-${m}-10`);
    const end = screen.getByTestId(`home-cal-day-${y}-${m}-14`);

    fireEvent.pointerDown(start, { button: 0, clientX: 20, clientY: 20 });
    // Enter another day while pressed → drag (not click).
    fireEvent.pointerEnter(end);
    fireEvent.pointerUp(window, { clientX: 80, clientY: 20 });

    const pop = await screen.findByTestId("cal-create-pop");
    expect(pop).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-create-confirm"));
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({
          folder_id: "inbox1",
          year: y,
          month: now.getMonth() + 1,
          day: 10,
        }),
      );
    });
    // note_set_event_end was deleted — replacePrimaryDate's add+promote composite absorbs it.
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_end", expect.anything());
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({
          id: "primary-row",
          end_year: y,
          end_month: now.getMonth() + 1,
          end_day: 14,
        }),
      );
    });
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(loadTreeMock).toHaveBeenCalled();
  });

  it("Esc cancels an in-progress drag without opening the popover", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const start = screen.getByTestId(`home-cal-day-${y}-${m}-10`);
    const end = screen.getByTestId(`home-cal-day-${y}-${m}-12`);

    fireEvent.pointerDown(start, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerEnter(end);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 20 });

    expect(screen.queryByTestId("cal-create-pop")).toBeNull();
  });

  it("record axis: a day with created/updated notes (but no events) gets a dot and suppresses the empty-month notice", async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const recordDay = `${y}-${m}-07`;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        return { year: y, month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") {
        return { counts: [{ day: recordDay, count: 2 }] };
      }
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_record_histogram",
        expect.objectContaining({ workspace_id: "ws1" }),
      );
    });

    await waitFor(() => expect(screen.getByTestId(`home-cal-record-${recordDay}`)).toBeTruthy());
    expect(screen.queryByTestId("cal-month-empty")).toBeNull();
    // Density tint on a chip-less record day: it's the month's busiest day, so recordTint's ceiling
    // (8 + 30% = 38%) — the same shared lib/calendarDay ladder the sidebar uses.
    expect(screen.getByTestId(`home-cal-day-${recordDay}`).getAttribute("data-record-density")).toBe(
      "color-mix(in srgb, var(--accent) 38%, transparent)",
    );
    expect(screen.getByTestId(`home-cal-day-${y}-${m}-08`).getAttribute("data-record-density")).toBeNull();
  });

  it("hovering a day cell's quick-create + creates a note for that date with no confirm popover", async () => {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_calendar") {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      if (cmd === "note_create") {
        return {
          note: {
            id: "quick1",
            folder_id: "inbox1",
            title: "Untitled Note",
            year: args?.year ?? 2026,
            month: args?.month ?? null,
            day: args?.day ?? null,
            is_favorite: false,
            exported_at: null,
            has_image: false,
            tag_names: [],
            region: null,
            status: null,
            icon: null,
            lat: null,
            lng: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          sections: [],
          sources: [],
          attachments: [],
        };
      }
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const day = 9;
    const iso = `${y}-${m}-${String(day).padStart(2, "0")}`;
    const addBtn = screen.getByTestId(`home-cal-add-${iso}`);

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({ folder_id: "inbox1", year: y, month: now.getMonth() + 1, day }),
      );
    });
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cal-create-pop")).toBeNull();
  });

  // PLAN-2026-09-10 달력 W5 ② — 시간축의 빈 곳 드래그. 노트는 **그 순간** 생기고, 생성 경로는
  // 그리드의 드래그/"+"/AI 가 쓰는 createNoteForRange 하나뿐이다(두 번째 경로를 만들지 않는다).
  it("시간축 빈 곳 드래그 → note_create 뒤 시각만 얹는다 (탭은 열지 않는다)", async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const iso = `${y}-${String(m).padStart(2, "0")}-20`;
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_calendar") {
        return { year: y, month: m, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      if (cmd === "note_create") {
        return {
          note: { id: "timed1", folder_id: "inbox1", title: "", year: y, month: m, day: 20 },
          sections: [],
          sources: [],
          attachments: [],
        };
      }
      if (cmd === "note_dates_list") {
        return {
          dates: [
            {
              id: "p0",
              note_id: "timed1",
              position: 0,
              year: y,
              month: m,
              day: 20,
              end_year: null,
              end_month: null,
              end_day: null,
              remind: false,
              created_at: "2026-01-01T00:00:00Z",
              start_time: null,
              end_time: null,
              remind_offset_min: null,
              rrule: null,
            },
          ],
        };
      }
      if (cmd === "note_date_update") return { ...(args ?? {}) };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    // 날짜를 골라야 우측 패널에 시간축이 뜬다.
    clickDay(screen.getByTestId(`home-cal-day-${iso}`));
    const canvas = await waitFor(() => screen.getByTestId("cal-time-axis-canvas"));

    // 09:00 → 10:00 (축은 28px/시간, jsdom 의 rect 는 0 이라 clientY 가 곧 축 좌표다)
    await act(async () => {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientY: 9 * 28 });
      fireEvent.pointerMove(canvas, { pointerId: 3, clientY: 10 * 28 });
      fireEvent.pointerUp(canvas, { pointerId: 3, clientY: 10 * 28 });
    });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({ folder_id: "inbox1", year: y, month: m, day: 20 }),
      ),
    );
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "p0", start_time: "09:00", end_time: "10:00" }),
      ),
    );
    // 만든 노트는 포커스만 한다 — 탭은 열지 않는다(그리드의 "+"와 같은 결).
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("dashboard search dims non-matching span bars and event chips in place", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getAllByText("Point event").length).toBeGreaterThan(0));

    const now = new Date();
    const startDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-12`;

    // No query yet — nothing dimmed.
    expect(screen.getByTestId("home-cal-event-ev1").getAttribute("data-search-dim")).toBeNull();
    expect(
      screen.getByTestId(`home-cal-span-sp1-${startDay}`).getAttribute("data-search-dim"),
    ).toBeNull();

    act(() => {
      useSearchStore.setState({
        query: "jeju",
        searchResults: [
          { id: "sp1", folder_id: "f1", title: "Jeju trip", year: now.getFullYear(), is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("home-cal-event-ev1").getAttribute("data-search-dim")).toBe("true");
    });
    // The matching span (sp1) stays fully visible.
    expect(
      screen.getByTestId(`home-cal-span-sp1-${startDay}`).getAttribute("data-search-dim"),
    ).toBeNull();
  });

  it("dims notes outside the shared dashboard folder filter (stores/ui.ts), and clears on reset", async () => {
    // The folder legend bubbles moved out of CalendarTab into the nav row's dot control
    // (FolderDotFilter, not mounted here) — toggling now happens through the shared store
    // directly, same as a FolderDotFilter click would.
    const now = new Date();
    const startDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-12`;

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        return {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          items: [
            makeItem({
              note_id: "ev1",
              folder_id: "f1",
              kind: "event",
              title: "Work event",
              span_start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-05`,
              span_end: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-05`,
              day: 5,
            }),
            makeItem({
              note_id: "sp1",
              folder_id: "f2",
              kind: "span",
              title: "Personal trip",
              span_start: startDay,
              span_end: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`,
              day: 12,
              end_year: now.getFullYear(),
              end_month: now.getMonth() + 1,
              end_day: 15,
            }),
          ],
        } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(screen.getByTestId("home-cal-event-ev1")).toBeTruthy());

    // Initial state: nothing dimmed
    expect(screen.getByTestId("home-cal-event-ev1").getAttribute("data-search-dim")).toBeNull();
    expect(screen.getByTestId(`home-cal-span-sp1-${startDay}`).getAttribute("data-search-dim")).toBeNull();

    // Set the shared filter to "f1" (Work) — same effect a FolderDotFilter click has.
    act(() => {
      useUiStore.getState().toggleDashboardFolderFilter("f1");
    });

    // Work event (f1) stays visible, Personal span (f2) is dimmed — not removed.
    expect(screen.getByTestId("home-cal-event-ev1").getAttribute("data-search-dim")).toBeNull();
    expect(screen.getByTestId(`home-cal-span-sp1-${startDay}`).getAttribute("data-search-dim")).toBe("true");

    // Toggling the same id again clears it.
    act(() => {
      useUiStore.getState().toggleDashboardFolderFilter("f1");
    });
    expect(useUiStore.getState().dashboardFolderFilter).toBeNull();
    expect(screen.getByTestId("home-cal-event-ev1").getAttribute("data-search-dim")).toBeNull();
    expect(screen.getByTestId(`home-cal-span-sp1-${startDay}`).getAttribute("data-search-dim")).toBeNull();
  });

  // 2026-09-10 오너 결정으로 기본 선택이 **오늘**이 됐다(열자마자 오늘의 타임라인). 월 목록은
  // 사라진 게 아니라 선택을 풀면 나온다 — 오늘 칸을 한 번 더 누르면 토글된다.
  it("renders month notes in detail panel when the day selection is toggled off", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getByTestId(`home-cal-day-${TODAY_ISO}`)).toBeTruthy());
    clickDay(screen.getByTestId(`home-cal-day-${TODAY_ISO}`));
    await waitFor(() => expect(screen.getByTestId("cal-detail-note-ev1")).toBeTruthy());
    expect(screen.getByTestId("cal-detail")).toBeTruthy();
    expect(screen.getByTestId("cal-detail-note-sp1")).toBeTruthy();
  });

  it("opens on today's timeline — the briefing header, not the month list", async () => {
    render(<CalendarTab />);
    // 브리핑(일 숫자 + 요일 + 날씨)은 날짜 모드에만 있다. 기본이 월 목록이던 시절엔 만들어 놓고도
    // 기본 화면에서 못 봤다 — 그래서 기본을 오늘로 옮겼다.
    await waitFor(() => expect(screen.getByTestId("cal-day-briefing")).toBeTruthy());
    expect(screen.getByTestId(`home-cal-day-${TODAY_ISO}`)).toBeTruthy();
  });

  it("header row arranges < YYYY MM > and today button on the far right", async () => {
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    const prevBtn = screen.getByTestId("cal-prev-month");
    const nextBtn = screen.getByTestId("cal-next-month");
    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();
  });

  it("respects week_start setting monday", async () => {
    useSettingsStore.setState({ weekStart: "monday" });
    render(<CalendarTab />);
    await waitFor(() => expect(screen.getByTestId("home-calendar")).toBeTruthy());
    expect(useSettingsStore.getState().weekStart).toBe("monday");
  });

  it("remind-flagged items show a bell after the title in the month chip and the collapsed detail card (2026-09-10)", async () => {
    render(<CalendarTab />);
    // 상세 패널이 ev1 을 그리게 월 목록으로 돌린다 — 기본 선택(오늘)엔 이 픽스처가 없다.
    await waitFor(() => expect(screen.getByTestId(`home-cal-day-${TODAY_ISO}`)).toBeTruthy());
    clickDay(screen.getByTestId(`home-cal-day-${TODAY_ISO}`));
    // ev1 is the only fixture with remind: true (see beforeEach). It appears twice: once on the
    // grid chip, once on the detail-panel card — both are title surfaces.
    // 2026-09-10 아침엔 상세 카드가 알림을 항상 펼쳐 배지를 내려놨었다(표면 1개). 같은 날 오너가
    // 번복 — 접힘이 다시 기본이라 배지도 돌아왔다. 배지는 **접힘**에만 있고, 카드를 펼치면 행의
    // 벨 버튼이 그 자리를 대신한다(벨이 둘이면 조작 가능한 쪽이 흐려진다).
    await waitFor(() => expect(screen.getAllByTestId("cal-remind-badge-ev1").length).toBe(2));
    const chip = screen.getByTestId("home-cal-event-ev1");
    expect(chip.querySelector('[data-testid="cal-remind-badge-ev1"]')).toBeTruthy();
    // The bell rides the title, so it never appears on a note without the flag.
    expect(screen.queryByTestId("cal-remind-badge-sp1")).toBeNull();
    // Same badge in the month list of the detail panel.
    const card = screen.getByTestId("cal-detail-note-ev1");
    expect(card.querySelector('[data-testid="cal-remind-badge-ev1"]')).toBeTruthy();
    expect(
      screen.getByTestId("cal-detail-note-sp1").querySelector('[data-testid="cal-remind-badge-sp1"]'),
    ).toBeNull();
  });

  it("year view: toggle fetches the 3-year window, dedupes the detail list, and a day click drills back into month view with that day selected", async () => {
    // Three years of grid (~1500 nodes) render slowly under full-suite load — 5s headroom on every wait.
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    callMock.mockClear();

    fireEvent.click(screen.getByTestId("cal-view-year"));
    // Continuous scroll keeps viewYear ± 1 alive: 3 years × 12 months, one query each.
    await waitFor(
      () => expect(callMock.mock.calls.filter((c) => c[0] === "dashboard_calendar")).toHaveLength(36),
      { timeout: 5000 },
    );
    const calls = callMock.mock.calls
      .filter((c) => c[0] === "dashboard_calendar")
      .map((c) => c[1] as { year: number; month: number });
    expect(new Set(calls.map((c) => c.year))).toEqual(new Set([2025, 2026, 2027]));
    expect(calls.filter((c) => c.year === 2026).map((c) => c.month).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    // Record axis asks for the whole window in one call.
    const hist = callMock.mock.calls.find((c) => c[0] === "note_record_histogram");
    expect(hist![1]).toMatchObject({ from: "2025-01-01", to: "2027-12-31" });
    // All three year blocks are in the DOM, previous year first.
    const blocks = screen.getAllByTestId(/^home-cal-year-\d{4}$/).map((el) => el.getAttribute("data-year-block"));
    expect(blocks).toEqual(["2025", "2026", "2027"]);

    expect(screen.getByTestId("cal-month-label").textContent).toBe("2026");
    expect(screen.getByTestId("cal-year-grid")).toBeTruthy();
    expect(screen.queryByTestId("cal-grid")).toBeNull();
    // The mock hands the same three items back for every month → the detail list still shows each note once.
    await waitFor(() => expect(screen.getByTestId("cal-detail-note-sp1")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getAllByTestId("cal-detail-note-sp1")).toHaveLength(1);
    // Heat levels: one event on 7/5 → 2; 7/14 has the Jeju span + the single-day task → 3; 7/20 nothing → 0.
    expect(screen.getByTestId("home-cal-yday-2026-07-05").getAttribute("data-level")).toBe("2");
    expect(screen.getByTestId("home-cal-yday-2026-07-14").getAttribute("data-level")).toBe("3");
    expect(screen.getByTestId("home-cal-yday-2026-07-20").getAttribute("data-level")).toBe("0");
    // Reminder dot (folder-coloured) only on the day whose item has remind=true.
    expect(screen.getByTestId("home-cal-yremind-2026-07-05").getAttribute("data-folder")).toBe("f1");
    expect(screen.queryByTestId("home-cal-yremind-2026-07-14")).toBeNull();

    // < > step a whole year in this mode and slide the window with them.
    fireEvent.click(screen.getByTestId("cal-next-month"));
    await waitFor(() => expect(screen.getByTestId("cal-month-label").textContent).toBe("2027"), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId("home-cal-year-2028")).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId("home-cal-year-2025")).toBeNull();
    fireEvent.click(screen.getByTestId("cal-prev-month"));
    await waitFor(() => expect(screen.getByTestId("cal-month-label").textContent).toBe("2026"), { timeout: 5000 });

    fireEvent.click(screen.getByTestId("home-cal-yday-2026-03-10"));
    await waitFor(() => expect(screen.getByTestId("cal-grid")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByTestId("cal-month-label").textContent).toBe("March 2026");
    expect(screen.getByTestId("home-cal-day-2026-03-10").getAttribute("data-selected")).toBe("true");
  }, 20000);

  it("holiday_region=kr paints public holidays in both grids; none hides them", async () => {
    useSettingsStore.setState({ holidayRegion: "kr" });
    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    // July 2026 has none — step to August: 광복절 (Sat) + its Monday 대체공휴일.
    fireEvent.click(screen.getByTestId("cal-next-month"));
    await waitFor(() => expect(screen.getByTestId("home-cal-day-2026-08-15")).toBeTruthy());
    expect(screen.getByTestId("home-cal-holiday-2026-08-15").textContent).toBe("광복절");
    expect(screen.getByTestId("home-cal-day-2026-08-17").getAttribute("data-holiday")).toBe("true");
    expect(screen.queryByTestId("home-cal-holiday-2026-08-14")).toBeNull();

    fireEvent.click(screen.getByTestId("cal-view-year"));
    await waitFor(() => expect(screen.getByTestId("cal-year-grid")).toBeTruthy());
    expect(screen.getByTestId("home-cal-yday-2026-03-01").getAttribute("title")).toBe("삼일절");
    expect(screen.getByTestId("home-cal-yday-2026-03-02").getAttribute("data-holiday")).toBe("true");

    act(() => useSettingsStore.setState({ holidayRegion: "none" }));
    await waitFor(() =>
      expect(screen.getByTestId("home-cal-yday-2026-03-01").getAttribute("data-holiday")).toBeNull(),
    );
  });

  it("right-click day → AI prompt → propose → confirm creates note with range (never before confirm)", async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const anchor = `${y}-${m}-10`;
    const endIso = `${y}-${m}-16`;

    generateFromPromptMock.mockResolvedValue(
      JSON.stringify({ title: "Trip", start: anchor, end: endIso }),
    );
    const createdNotes: Record<string, Record<string, unknown>> = {};
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_calendar") {
        return { year: y, month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      if (cmd === "note_create") {
        const note = {
          id: "ai1",
          folder_id: "inbox1",
          title: (args?.title as string) ?? "Untitled",
          year: args?.year ?? y,
          month: args?.month ?? null,
          day: args?.day ?? null,
          is_favorite: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          status: null,
          icon: null,
          lat: null,
          lng: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        };
        createdNotes[note.id] = note;
        return { note, sections: [], sources: [], attachments: [] };
      }
      // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_end was deleted — the AI-confirm path
      // now goes through lib/primaryDate.ts::replacePrimaryDate.
      if (cmd === "note_get") {
        const note = createdNotes[args?.id as string];
        return { note, sections: [], sources: [], attachments: [] };
      }
      // W4b: 대표 편집은 note_date_update 한 번(옛 add+승격+삭제 컴포지트는 사라졌다).
      if (cmd === "note_dates_list") return { dates: [{ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null }] };
      if (cmd === "note_date_update") return { id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const cell = screen.getByTestId(`home-cal-day-${anchor}`);
    await act(async () => {
      fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    });

    await waitFor(() => expect(screen.getByTestId("cal-ai-prompt")).toBeTruthy());
    expect(ensureAiAskGateMock).toHaveBeenCalled();
    // No note_create yet — proposal first.
    expect(callMock.mock.calls.some((c) => c[0] === "note_create")).toBe(false);

    fireEvent.change(screen.getByTestId("cal-ai-prompt-input"), {
      target: { value: "이날부터 일주일동안 여행" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-ai-prompt-submit"));
    });

    await waitFor(() => expect(generateFromPromptMock).toHaveBeenCalled());
    const sentPrompt = generateFromPromptMock.mock.calls[0][0] as string;
    expect(sentPrompt).toContain(anchor);
    expect(sentPrompt).toContain("일주일");

    await waitFor(() => expect(screen.getByTestId("cal-ai-proposal")).toBeTruthy());
    expect(screen.queryByTestId("cal-ai-prompt")).toBeNull();
    expect(callMock.mock.calls.some((c) => c[0] === "note_create")).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-ai-proposal-confirm"));
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({
          folder_id: "inbox1",
          title: "Trip",
          year: y,
          month: now.getMonth() + 1,
          day: 10,
        }),
      );
    });
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_end", expect.anything());
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({
          id: "primary-row",
          end_year: y,
          end_month: now.getMonth() + 1,
          end_day: 16,
        }),
      );
    });
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("unparseable AI response does not create a note and surfaces a failure notice", async () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const anchor = `${y}-${m}-10`;

    generateFromPromptMock.mockResolvedValue("sorry I cannot help with that");
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        return { year: y, month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId(`home-cal-day-${anchor}`), {
        clientX: 10,
        clientY: 10,
      });
    });
    await waitFor(() => expect(screen.getByTestId("cal-ai-prompt")).toBeTruthy());

    fireEvent.change(screen.getByTestId("cal-ai-prompt-input"), {
      target: { value: "something" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-ai-prompt-submit"));
    });

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("cal-ai-proposal")).toBeNull();
    expect(callMock.mock.calls.some((c) => c[0] === "note_create")).toBe(false);
  });

  // PLAN-2026-09-10 D3 — create-first: 드래그를 **놓는 순간** 노트가 생기고(제목 없음,
  // 받은편지함), 팝오버는 그 노트를 고치는 자리다. "만들기"는 제목/폴더만 얹는다.
  it("drag-create makes the note on drop, then 만들기 applies title + folder (no note tab opens)", async () => {
    useNotesStore.setState({
      folders: [
        { id: "inbox1", name: "Inbox", position: 0 },
        { id: "f2", name: "Trips", position: 1 },
      ],
    } as never);
    const createdNote = {
      id: "nonav1",
      folder_id: "inbox1",
      title: "",
      year: 2026,
      month: 7,
      day: 10,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: null,
      end_time: null,
      remind: false,
      remind_offset_min: null,
      rrule: null,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const primaryRow = {
      id: "row-nonav1", note_id: "nonav1", position: 0, year: 2026, month: 7, day: 10,
      end_year: null, end_month: null, end_day: null, remind: false, created_at: "",
      start_time: null, end_time: null, remind_offset_min: null, rrule: null,
    };
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      const now = new Date();
      if (cmd === "dashboard_calendar") {
        return { year: now.getFullYear(), month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      // 기간 드래그는 replacePrimaryDate 로 종료 트리플을 얹는다 — 대표(position 0) 행이 있어야 한다.
      if (cmd === "note_dates_list") return { dates: [primaryRow] };
      if (cmd === "note_date_update") return primaryRow;
      if (cmd === "note_get") return { note: createdNote, sections: [], sources: [], attachments: [] };
      if (cmd === "note_create") {
        return {
          note: {
            id: "nonav1",
            folder_id: "inbox1",
            title: (args?.title as string) ?? "Untitled Note",
            year: args?.year ?? 2026,
            month: args?.month ?? null,
            day: args?.day ?? null,
            is_favorite: false,
            exported_at: null,
            has_image: false,
            tag_names: [],
            region: null,
            status: null,
            icon: null,
            lat: null,
            lng: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          sections: [],
          sources: [],
          attachments: [],
        };
      }
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const start = screen.getByTestId(`home-cal-day-${y}-${m}-10`);
    const end = screen.getByTestId(`home-cal-day-${y}-${m}-12`);

    fireEvent.pointerDown(start, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerEnter(end);
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 60, clientY: 20 });
    });

    // 놓자마자 노트가 생긴다 — 제목 없이, 받은편지함에.
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({ folder_id: "inbox1", year: y, month: now.getMonth() + 1, day: 10 }),
      );
    });
    expect(callMock).not.toHaveBeenCalledWith("note_create", expect.objectContaining({ title: "My Test Title" }));

    expect(await screen.findByTestId("cal-create-pop")).toBeTruthy();
    // NoteDatesList(벨·시각·반복)가 그 노트 id 로 팝오버 안에 인라인으로 들어와 있다 — 날짜는
    // 이미 드래그로 골랐으므로 DatesPanel 의 달력 그리드는 여기 없다(2026-09-12, CreateRangePopover).
    await waitFor(() => expect(screen.getByTestId("cal-create-dates")).toBeTruthy());
    expect(screen.queryByTestId("date-range-calendar")).toBeNull();

    fireEvent.change(screen.getByTestId("cal-create-title"), { target: { value: "My Test Title" } });
    // 폴더 옮기기(Select) — 타임라인 "폴더로 이동"과 같은 목록 소스.
    fireEvent.click(screen.getByTestId("cal-create-folder"));
    await act(async () => {
      fireEvent.click(await screen.findByText("Trips"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-create-confirm"));
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_update", { id: "nonav1", title: "My Test Title" });
    });
    // 폴더 변경은 lib/noteActions.ts::moveNote → note_update{folder_id}.
    expect(callMock).toHaveBeenCalledWith("note_update", { id: "nonav1", folder_id: "f2" });
    expect(screen.queryByTestId("cal-create-pop")).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("note_purge", expect.anything());
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  // 취소는 하드 삭제다 — 사용자에게 한 번도 존재한 적 없는 노트라 휴지통에 남기지 않는다(D3-4).
  it("cancelling the drag-create popover purges the note it made", async () => {
    const createdNote = {
      id: "doomed1",
      folder_id: "inbox1",
      title: "",
      year: 2026,
      month: 7,
      day: 10,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: null,
      end_time: null,
      remind: false,
      remind_offset_min: null,
      rrule: null,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const primaryRow = {
      id: "row-doomed1", note_id: "doomed1", position: 0, year: 2026, month: 7, day: 10,
      end_year: null, end_month: null, end_day: null, remind: false, created_at: "",
      start_time: null, end_time: null, remind_offset_min: null, rrule: null,
    };
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      const now = new Date();
      if (cmd === "dashboard_calendar") {
        return { year: now.getFullYear(), month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      // 기간 드래그는 replacePrimaryDate 로 종료 트리플을 얹는다 — 대표(position 0) 행이 있어야 한다.
      if (cmd === "note_dates_list") return { dates: [primaryRow] };
      if (cmd === "note_date_update") return primaryRow;
      if (cmd === "note_get") return { note: createdNote, sections: [], sources: [], attachments: [] };
      if (cmd === "note_create") {
        return {
          note: {
            id: "doomed1",
            folder_id: "inbox1",
            title: "",
            year: args?.year ?? 2026,
            month: args?.month ?? null,
            day: args?.day ?? null,
            is_favorite: false,
            exported_at: null,
            has_image: false,
            tag_names: [],
            region: null,
            status: null,
            icon: null,
            lat: null,
            lng: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          sections: [],
          sources: [],
          attachments: [],
        };
      }
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    fireEvent.pointerDown(screen.getByTestId(`home-cal-day-${y}-${m}-10`), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerEnter(screen.getByTestId(`home-cal-day-${y}-${m}-11`));
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 60, clientY: 20 });
    });
    await screen.findByTestId("cal-create-pop");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_create", expect.anything()));

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-create-cancel"));
    });

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_purge", { id: "doomed1" }));
    expect(screen.queryByTestId("cal-create-pop")).toBeNull();
  });

  // purge 가 실패해도 방향은 "노트가 남는다" 다 — 토스트만 뜨고 데이터는 잃지 않는다(D3-4).
  it("a failed purge leaves the note alone and still closes the popover", async () => {
    const createdNote = {
      id: "survivor1",
      folder_id: "inbox1",
      title: "",
      year: 2026,
      month: 7,
      day: 10,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: null,
      end_time: null,
      remind: false,
      remind_offset_min: null,
      rrule: null,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const primaryRow = {
      id: "row-survivor1", note_id: "survivor1", position: 0, year: 2026, month: 7, day: 10,
      end_year: null, end_month: null, end_day: null, remind: false, created_at: "",
      start_time: null, end_time: null, remind_offset_min: null, rrule: null,
    };
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      const now = new Date();
      if (cmd === "dashboard_calendar") {
        return { year: now.getFullYear(), month: now.getMonth() + 1, items: [] } satisfies CalendarResult;
      }
      if (cmd === "note_record_histogram") return { counts: [] };
      // 기간 드래그는 replacePrimaryDate 로 종료 트리플을 얹는다 — 대표(position 0) 행이 있어야 한다.
      if (cmd === "note_dates_list") return { dates: [primaryRow] };
      if (cmd === "note_date_update") return primaryRow;
      if (cmd === "note_get") return { note: createdNote, sections: [], sources: [], attachments: [] };
      if (cmd === "note_purge") throw { code: "INTERNAL" };
      if (cmd === "note_create") {
        return {
          note: {
            id: "survivor1",
            folder_id: "inbox1",
            title: "",
            year: args?.year ?? 2026,
            month: args?.month ?? null,
            day: args?.day ?? null,
            is_favorite: false,
            exported_at: null,
            has_image: false,
            tag_names: [],
            region: null,
            status: null,
            icon: null,
            lat: null,
            lng: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          sections: [],
          sources: [],
          attachments: [],
        };
      }
      return {};
    });

    render(<CalendarTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    fireEvent.pointerDown(screen.getByTestId(`home-cal-day-${y}-${m}-10`), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerEnter(screen.getByTestId(`home-cal-day-${y}-${m}-11`));
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 60, clientY: 20 });
    });
    await screen.findByTestId("cal-create-pop");

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-create-cancel"));
    });

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_purge", { id: "survivor1" }));
    // 실패가 삼켜지고(토스트는 call() 이) 화면은 닫힌다 — 노트는 그대로 남는다.
    expect(screen.queryByTestId("cal-create-pop")).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("note_delete", expect.anything());
  });

  it("renders export and import .ics buttons and triggers exportCalendarIcs", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") {
        return { items: [], record_days: [] };
      }
      if (cmd === "note_query") {
        return { notes: [] };
      }
      return {};
    });

    render(<CalendarTab />);
    const exportBtn = await screen.findByTestId("cal-export-ics");
    const importBtn = await screen.findByTestId("cal-import-ics");
    expect(exportBtn).toBeTruthy();
    expect(importBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_query", expect.anything());
    });
  });
});

describe("parseCalendarScheduleProposal (pure)", () => {
  it("parses clean JSON and duration_days (inclusive week)", () => {
    expect(
      parseCalendarScheduleProposal(
        '{"title":"여행","start":"2026-07-10","duration_days":7}',
        "2026-07-10",
      ),
    ).toEqual({ title: "여행", start: "2026-07-10", end: "2026-07-16" });
  });

  it("strips fences and prose; defaults start to anchor", () => {
    const raw = 'Sure!\n```json\n{"title":"Meet","end":"2026-07-12"}\n```\n';
    expect(parseCalendarScheduleProposal(raw, "2026-07-10")).toEqual({
      title: "Meet",
      start: "2026-07-10",
      end: "2026-07-12",
    });
  });

  it("returns null for garbage / missing title (never invent a note)", () => {
    expect(parseCalendarScheduleProposal("not json", "2026-07-10")).toBeNull();
    expect(parseCalendarScheduleProposal('{"start":"2026-07-10"}', "2026-07-10")).toBeNull();
    expect(parseCalendarScheduleProposal("", "2026-07-10")).toBeNull();
  });

  it("addDaysIso and prompt builder stay deterministic", () => {
    expect(addDaysIso("2026-07-10", 6)).toBe("2026-07-16");
    expect(addDaysIso("2026-07-30", 5)).toBe("2026-08-04");
    const p = buildCalendarSchedulePrompt("2026-07-10", "여행");
    expect(p).toContain("2026-07-10");
    expect(p).toContain("여행");
    expect(p).toContain('"title"');
  });
});


