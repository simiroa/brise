import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateBadge } from "./DateBadge";
import { t } from "../../i18n/t";
import { useNotesStore } from "../../stores/notes";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));

// Dashboard §2 popover redesign (docs/DASHBOARD.md, 2026-08-01): airline-booking-style range
// calendar replaces the old start `<input type=date>` + end number-spinner fields + due-date
// quickpicks + double-click-to-edit. The ⏰/red deadline flag is also gone from this badge — that
// urgency treatment still lives on the board/calendar cards (BoardCard.tsx, MonthGrid.tsx),
// untouched (see dueDate.ts, unchanged by this redesign).
describe("DateBadge — airline-booking range calendar popover (§2 / 2026-08-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 12, 0, 0)); // 2026-07-31 local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const noop = () => {};

  it("displays year-only, year.month, and year.month.day formats", () => {
    const { rerender } = render(
      <DateBadge year={1592} month={null} day={null} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("1592");

    rerender(
      <DateBadge year={1592} month={7} day={null} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("1592.07");

    rerender(
      <DateBadge year={1592} month={7} day={13} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("1592.07.13");
  });

  it("shows an explicit day-precision range, not a collapsed month", () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        end_year={2026}
        end_month={7}
        end_day={5}
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01 – 2026.07.05");
  });

  it("a same-day range collapses to a single date on the badge", () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        end_year={2026}
        end_month={7}
        end_day={1}
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01");
  });

  it("never renders a deadline flag — that treatment moved off this badge entirely", () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        end_year={2026}
        end_month={7}
        end_day={30}
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    expect(screen.queryByTestId("date-deadline-flag")).toBeNull();
  });

  // docs/PLAN-schedule-system.md §7.5 (2026-08-09): the "알려줘" (remind) checkbox that used to
  // live here moved to TitleBar's bell button + ReminderModal (§7.1~§7.3) — this badge is a pure
  // date component now. Regression coverage for its absence lives in ReminderModal.test.tsx
  // alongside the new entry point; DateBadge itself no longer accepts a remind/setRemind prop.
  it("never renders a remind toggle — that control moved to the bell/ReminderModal", () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        end_year={2026}
        end_month={7}
        end_day={5}
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-remind-toggle")).toBeNull();
  });

  it("single click opens a popover with the calendar grid, positioned on the start month", () => {
    render(
      <DateBadge year={1592} month={5} day={13} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("date-range-calendar")).toBeTruthy();
    expect(screen.getByTestId("range-cal-month-label").textContent).toBe("1592.05");
    // The start day is highlighted.
    expect(screen.getByTestId("range-day-1592-5-13").getAttribute("data-highlight")).toBe("start");
  });

  it("first grid pick (keyboard) sets the start and leaves the popover open", () => {
    const setYear = vi.fn();
    const setEventPrecision = vi.fn();
    render(
      <DateBadge year={2026} month={null} day={null} setYear={setYear} setEventPrecision={setEventPrecision} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-1"), { key: "Enter" });

    expect(setYear).toHaveBeenCalledWith(2026);
    expect(setEventPrecision).toHaveBeenCalledWith(7, 1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("second click on a later day completes the range and highlights the days between", () => {
    const setEventEnd = vi.fn();
    render(
      <DateBadge year={2026} month={7} day={1} setYear={noop} setEventPrecision={noop} setEventEnd={setEventEnd} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    // First click establishes this session's start (props already had 7/1 — but per the airline
    // picker rule, the very first click of a fresh popover always starts a new selection).
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-1"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-5"), { key: "Enter" });

    expect(setEventEnd).toHaveBeenCalledWith({ end_year: 2026, end_month: 7, end_day: 5 });
    // Draft end (local state) flows back into the grid — a day strictly between start/end reads
    // as in-range, not just the pure cellHighlight() unit under test in dateRangePicker.test.ts.
    expect(screen.getByTestId("range-day-2026-7-3").getAttribute("data-highlight")).toBe("in-range");
    expect(screen.getByTestId("range-day-2026-7-1").getAttribute("data-highlight")).toBe("start");
    expect(screen.getByTestId("range-day-2026-7-5").getAttribute("data-highlight")).toBe("end");
  });

  it("a further click after a complete range starts a brand-new selection", () => {
    const setEventPrecision = vi.fn();
    const setEventEnd = vi.fn();
    render(
      <DateBadge year={2026} month={7} day={1} setYear={noop} setEventPrecision={setEventPrecision} setEventEnd={setEventEnd} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-1"), { key: "Enter" }); // start
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-5"), { key: "Enter" }); // end
    setEventEnd.mockClear();
    setEventPrecision.mockClear();
    fireEvent.keyDown(screen.getByTestId("range-day-2026-7-10"), { key: "Enter" }); // fresh start

    expect(setEventPrecision).toHaveBeenCalledWith(7, 10);
    expect(setEventEnd).toHaveBeenCalledWith({ end_year: null, end_month: null, end_day: null });
  });

  it("drag-select across days shows a live highlight mid-drag, then commits a complete range on release", () => {
    const setEventEnd = vi.fn();
    render(
      <DateBadge year={2026} month={7} day={1} setYear={noop} setEventPrecision={noop} setEventEnd={setEventEnd} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    const startCell = screen.getByTestId("range-day-2026-7-3");
    const midCell = screen.getByTestId("range-day-2026-7-6");
    const endCell = screen.getByTestId("range-day-2026-7-8");
    fireEvent.pointerDown(startCell, { button: 0 });
    fireEvent.pointerEnter(endCell);
    // Still mid-gesture: the live drag span highlights, before any commit fires.
    expect(setEventEnd).not.toHaveBeenCalled();
    expect(startCell.getAttribute("data-highlight")).toBe("start");
    expect(midCell.getAttribute("data-highlight")).toBe("in-range");
    expect(endCell.getAttribute("data-highlight")).toBe("end");

    fireEvent.pointerUp(window);
    expect(setEventEnd).toHaveBeenCalledWith({ end_year: 2026, end_month: 7, end_day: 8 });
  });

  it("month navigation moves the grid without touching the note's date", () => {
    const setYear = vi.fn();
    render(
      <DateBadge year={2026} month={7} day={1} setYear={setYear} setEventPrecision={noop} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    fireEvent.click(screen.getByTestId("range-cal-next"));
    expect(screen.getByTestId("range-cal-month-label").textContent).toBe("2026.08");
    fireEvent.click(screen.getByTestId("range-cal-prev"));
    fireEvent.click(screen.getByTestId("range-cal-prev"));
    expect(screen.getByTestId("range-cal-month-label").textContent).toBe("2026.06");
    expect(setYear).not.toHaveBeenCalled();
  });

  // §E (PLAN-2026-09-08-dates-rebuild.md, 2026-09-08 owner decision): the two-input fallback row
  // is gone; the draft page (no noteId, as here) keeps a single minimal "date-draft-precision"
  // start-only field as its sole partial-precision route (§E — checked: it's the draft's only one).
  it("draft's minimal precision field sets a year-only start on Enter", () => {
    const setYear = vi.fn();
    const setEventPrecision = vi.fn();
    render(
      <DateBadge year={1592} month={5} day={13} setYear={setYear} setEventPrecision={setEventPrecision} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    const input = screen.getByTestId("date-draft-precision") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1598" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(setYear).toHaveBeenCalledWith(1598);
    expect(setEventPrecision).toHaveBeenCalledWith(null, null);
  });

  // The end-side fallback text is gone entirely (§E) — a reversed range can still be rejected via
  // the one remaining (start) field, against whatever end the draft already has.
  it("draft's minimal precision field still rejects a start pushed past the existing end", () => {
    const setYear = vi.fn();
    render(
      <DateBadge
        year={1800}
        month={1}
        day={1}
        end_year={1796}
        end_month={1}
        end_day={1}
        setYear={setYear}
        setEventPrecision={noop}
        setEventEnd={noop}
      />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    const input = screen.getByTestId("date-draft-precision") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1801" } });
    fireEvent.blur(input);

    expect(screen.getByTestId("date-range-error").textContent).toBe(t("editor.year_range_reversed"));
    expect(setYear).not.toHaveBeenCalled();
  });

  it("invalid text in the draft's precision field reverts to the last-committed value instead of committing garbage", () => {
    const setYear = vi.fn();
    render(
      <DateBadge year={1592} month={null} day={null} setYear={setYear} setEventPrecision={noop} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    const input = screen.getByTestId("date-draft-precision") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not a date" } });
    fireEvent.blur(input);

    expect(setYear).not.toHaveBeenCalled();
    expect(input.value).toBe("1592");
  });

  // clear-all's UI trigger moved to NoteDatesList's primary row (오너 피드백 2026-09-07, "초기화의
  // 자리가 의미와 어긋난다") — see "clear-primary passthrough" below for the button/click coverage.
  // The function itself (both axes reset, bare year kept) is unchanged and still owned by DateBadge;
  // covered there via the same setEventPrecision/setEventEnd assertions.

  // §E (2026-09-08 owner decision): the labeled "등록" text button + its shared input row are
  // gone — a new row is now a plain icon button in the list header (date-add-row).
  it("the list header's + button is a real button, and the old input row is gone", () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={15}
        noteId="n1"
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));

    const addBtn = screen.getByTestId("date-add-row");
    expect(addBtn.tagName).toBe("BUTTON");
    expect(addBtn.getAttribute("aria-label")).toBe(t("note.register_date"));
    // The old input row (and everything in it) is gone on a note page.
    expect(screen.queryByTestId("date-fallback-fields")).toBeNull();
    expect(screen.queryByTestId("date-fallback-start")).toBeNull();
    expect(screen.queryByTestId("date-fallback-end")).toBeNull();
    expect(screen.queryByTestId("date-register-related")).toBeNull();
    // Nor does a note page fall back to the draft-only minimal precision field.
    expect(screen.queryByTestId("date-draft-precision")).toBeNull();
  });

  it("Escape closes the popover", () => {
    render(
      <DateBadge year={1592} month={5} day={13} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("arrow keys on the closed badge still step the year without opening the popover", () => {
    const setYear = vi.fn();
    render(
      <DateBadge year={1592} month={null} day={null} setYear={setYear} setEventPrecision={noop} setEventEnd={noop} />
    );
    fireEvent.keyDown(screen.getByTestId("date-badge"), { key: "ArrowUp" });
    expect(setYear).toHaveBeenCalledWith(1593);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders and picks a BCE (negative-year) grid — the reason for the app's own grid math", () => {
    const setYear = vi.fn();
    const setEventPrecision = vi.fn();
    render(
      <DateBadge year={-350} month={3} day={5} setYear={setYear} setEventPrecision={setEventPrecision} setEventEnd={noop} />
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.getByTestId("range-cal-month-label").textContent).toBe("-350.03");
    const cell = screen.getByTestId("range-day--350-3-5");
    expect(cell.getAttribute("data-highlight")).toBe("start");
    fireEvent.keyDown(screen.getByTestId("range-day--350-3-20"), { key: "Enter" });
    expect(setYear).toHaveBeenCalledWith(-350);
    expect(setEventPrecision).toHaveBeenCalledWith(3, 20);
  });
});

// 오너 요청(2026-09-07 "관련 날짜도 지역처럼 하나로 묶자"): RelatedDatesBadge를 이 배지로 흡수 —
// RegionMetaBadge가 경유지 개수를 대표 지역 칩에 얹는 것과 같은 결(closed chip: 요약 + "+N",
// popover: 대표 날짜 고르기 아래에 NoteDatesList).
describe("DateBadge — merged related-dates chip (2026-09-07)", () => {
  const noop = () => {};

  // No fake timers here (unlike the suite above) — these tests use waitFor/userEvent, which need
  // real timers to resolve their own internal polling/delays.
  beforeEach(() => {
    callMock.mockReset();
    // PLAN-2026-09-08-dates-rebuild.md W3: note_dates rows carry a year/month/day triple now, not
    // the old derived "date" ISO string (dropped from note_dates/NoteDate entirely).
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") {
        return {
          dates: [{
            id: "d1", note_id: "n1", position: 1, year: 2026, month: 9, day: 10,
            end_year: null, end_month: null, end_day: null, remind: false, created_at: "",
            start_time: null, end_time: null, remind_offset_min: null, rrule: null,
          }],
        };
      }
      return {};
    });
  });

  it("appends the related-date count to the closed chip once fetched", async () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01 +1"));
  });

  it("shows the plain date summary (no '+0') when there are no related dates", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_dates_list" ? { dates: [] } : {}));
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_dates_list", { note_id: "n1" }));
    expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01");
  });

  it("without a noteId (draft page), never fetches or shows a count — unchanged draft behavior", () => {
    render(
      <DateBadge year={2026} month={7} day={1} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />,
    );
    expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01");
    expect(callMock).not.toHaveBeenCalled();
  });

  // 칩 재작업(2026-09-07 오너: "등록된 날짜 칩 디자인도 다시 해야 해") — 대표 날짜가 주인공,
  // 개수는 보조(작은 글자·muted), 알림이 켜진 관련 날짜가 있으면 작은 벨이 드러난다.
  it("shows a small filled bell on the closed chip when a related date has remind on", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list"
        ? { dates: [{ id: "d1", note_id: "n1", date: "2026-09-10", remind: true, created_at: "" }] }
        : {},
    );
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("date-related-remind-icon")).toBeTruthy());
  });

  it("shows no bell on the closed chip when no related date has remind on", async () => {
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("date-badge").textContent).toBe("2026.07.01 +1"));
    expect(screen.queryByTestId("date-related-remind-icon")).toBeNull();
  });

  it("the one popover reaches both the date picker and the related-dates list", async () => {
    const user = userEvent.setup();
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await user.click(screen.getByTestId("date-badge"));
    // Representative-date picker still there.
    expect(screen.getByTestId("date-range-calendar")).toBeTruthy();
    // Related-dates list (add/remove/promote) now lives in the same popover, below it.
    await waitFor(() => expect(screen.getByTestId("note-dates-list")).toBeTruthy());
    // Dot-formatted (formatNoteDateRow), not the raw hyphenated ISO string — same notation as the
    // representative row/closed chip (오너 피드백 2026-09-07: 표기가 섞이면 안 된다).
    await waitFor(() => expect(screen.getByText("2026.09.10")).toBeTruthy());
    expect(screen.queryByText("2026-09-10")).toBeNull();
  });

  // GRILL-2026-09-07 unify: the list always shows now (primary row is always there), even with
  // zero related dates — the old "collapse to just the add toggle" behavior is gone along with the
  // toggle itself.
  it("always renders the unified list (primary row) even with zero related dates", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_dates_list" ? { dates: [] } : {}));
    const user = userEvent.setup();
    render(
      <DateBadge
        year={2026}
        month={7}
        day={1}
        noteId="n1"
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await user.click(screen.getByTestId("date-badge"));
    await waitFor(() => expect(screen.getByTestId("note-dates-list")).toBeTruthy());
    expect(screen.queryByTestId("date-add-related-toggle")).toBeNull();
  });

  // §E (2026-09-08 owner decision) rule 5 — the list header's "+" replaces the old register
  // button + input row: it reads whatever the calendar/fallback draft currently shows
  // (draftStart/draftEnd) and adds it as a note_dates row, then selects the row it just created
  // (by the id note_date_add returns) — no second calendar, no arming step, no explicit input.
  it("+ button adds a row from the current calendar draft and selects the row it created", async () => {
    const user = userEvent.setup();
    const datesState: any[] = [];
    let nextId = 1;
    callMock.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "note_dates_list") return { dates: datesState.slice() };
      if (cmd === "note_date_add") {
        const id = `new${nextId++}`;
        datesState.push({
          id, note_id: "n1", position: datesState.length + 1,
          year: args.year, month: args.month, day: args.day,
          end_year: args.end_year, end_month: args.end_month, end_day: args.end_day,
          remind: false, created_at: "",
          start_time: null, end_time: null, remind_offset_min: null, rrule: null,
        });
        return { id };
      }
      return {};
    });
    render(
      <DateBadge
        year={2026}
        month={9}
        day={1}
        noteId="n1"
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await user.click(screen.getByTestId("date-badge"));
    await waitFor(() => expect(screen.getByTestId("date-add-row")).toBeTruthy());

    await user.click(screen.getByTestId("date-add-row"));

    // note_date_add takes the year/month/day (+ end_*) triple directly (PLAN-2026-09-08-
    // dates-rebuild.md W3 dropped the old derived "date"/"end_date" ISO-string columns).
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_add", {
        note_id: "n1",
        year: 2026,
        month: 9,
        day: 1,
        end_year: null,
        end_month: null,
        end_day: null,
      }),
    );
    const newRow = await screen.findByTestId("note-date-row-new1");
    expect(newRow.getAttribute("data-selected")).toBe("true");
  });

  it("+ button includes end_date once a range is picked on the grid", async () => {
    const user = userEvent.setup();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "note_date_add") return { id: "new1" };
      return {};
    });
    render(
      <DateBadge
        year={2026}
        month={9}
        day={1}
        noteId="n1"
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    await user.click(screen.getByTestId("date-badge"));
    fireEvent.keyDown(screen.getByTestId("range-day-2026-9-1"), { key: "Enter" }); // start
    fireEvent.keyDown(screen.getByTestId("range-day-2026-9-5"), { key: "Enter" }); // end

    await user.click(screen.getByTestId("date-add-row"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_add", {
        note_id: "n1",
        year: 2026,
        month: 9,
        day: 1,
        end_year: 2026,
        end_month: 9,
        end_day: 5,
      }),
    );
  });

  it("the + button doesn't render without a note (draft page)", () => {
    render(
      <DateBadge year={2026} month={9} day={1} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-add-row")).toBeNull();
  });

  // PLAN-2026-09-10 D1/D2: 노트 페이지의 그리드 클릭은 **선택된 행**(기본값 = position 0 대표 행)을
  // note_date_update 로 고친다 — 스토어 세터도, "primary" 별칭도 지나지 않는다. 등록(note_date_add)은
  // 여전히 "+" 버튼만 한다: 고르는 것이 곧 등록이 되면 안 된다.
  it("calendar clicks edit the selected row through note_date_update, never note_date_add nor the store setters", async () => {
    const setEventPrecision = vi.fn();
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list"
        ? {
            dates: [{
              id: "p0", note_id: "n1", position: 0, year: 2026, month: 9, day: 1,
              end_year: null, end_month: null, end_day: null, remind: false, created_at: "",
              start_time: null, end_time: null, remind_offset_min: null, rrule: null,
            }],
          }
        : {},
    );
    render(
      <DateBadge
        year={2026}
        month={9}
        day={1}
        noteId="n1"
        setYear={noop}
        setEventPrecision={setEventPrecision}
        setEventEnd={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    // 목록이 도착하면 대표 행이 **선택된 행**이 된다(옛 "primary" 별칭 자리) — 그 선택이
    // 실제로 얹힌 뒤에 그리드를 눌러야 이 테스트가 재는 것을 잰다.
    await waitFor(() =>
      expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
    );
    fireEvent.keyDown(screen.getByTestId("range-day-2026-9-20"), { key: "Enter" });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "p0", year: 2026, month: 9, day: 20 }),
      ),
    );
    expect(setEventPrecision).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalledWith("note_date_add", expect.anything());
  });

  it("marks a related-date cell with a distinct dot, separate from the start-day accent selection", async () => {
    render(
      <DateBadge
        year={2026}
        month={9}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    await waitFor(() =>
      expect(screen.getByTestId("range-day-2026-9-10").getAttribute("data-related")).toBe("true"),
    );
    // The representative start day (2026.09.01) has no related-date dot of its own.
    expect(screen.getByTestId("range-day-2026-9-1").getAttribute("data-related")).toBeNull();
    expect(screen.getByTestId("range-day-2026-9-1").getAttribute("data-highlight")).toBe("start");
    expect(screen.getByTestId("range-day-2026-9-10").getAttribute("data-highlight")).toBe("none");
  });

  it("the native OS date input is gone from this popover", async () => {
    const { container } = render(
      <DateBadge
        year={2026}
        month={9}
        day={1}
        noteId="n1"
       
        setYear={noop}
        setEventPrecision={noop}
        setEventEnd={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    await waitFor(() => expect(screen.getByTestId("note-dates-list")).toBeTruthy());
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it("without a noteId, the popover has no related-dates section (draft page)", () => {
    render(
      <DateBadge year={2026} month={7} day={1} setYear={noop} setEventPrecision={noop} setEventEnd={noop} />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-related-dates-section")).toBeNull();
  });
});

// PLAN-2026-09-10 D2: 대표 행의 알림 값/세터를 이 배지가 내려주던 배선은 사라졌다
// (NoteDatesList 가 note_dates_list 로 직접 읽고 note_date_update 로 직접 고친다). 남은 배선은
// 지우개 하나 — 버튼은 목록에, 쓰기도 목록에, 배지는 자기 달력 초안만 되돌린다.
describe("DateBadge — primary row clear wiring", () => {
  const noop = () => {};

  beforeEach(() => {
    callMock.mockReset();
    // W4b 이후 목록은 대표(position 0) 행을 첫 항목으로 돌려준다 — ★ 행은 이제 그 행이다.
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list"
        ? {
            dates: [{
              id: "p0", note_id: "n1", position: 0, year: 2026, month: 7, day: 15,
              end_year: 2026, end_month: 8, end_day: 1, remind: false, created_at: "",
              start_time: null, end_time: null, remind_offset_min: null, rrule: null,
            }],
          }
        : {},
    );
    useNotesStore.setState({
      activeNote: { note: { id: "n1" } as never, sections: [], sources: [], attachments: [] },
      activeDraft: false,
    } as never);
  });

  afterEach(() => {
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
  });

  // PLAN-2026-09-10 D2: 지우개의 쓰기는 목록(NoteDatesList)이 대표 행을 note_date_update 하는
  // 것으로 옵겼다 — 이 배지가 남기게 된 몫은 자기 달력 초안을 같이 되돌리는 것뿐이다.
  // 스토어 세터(setEventPrecision/setEventEnd)로 또 쓰면 같은 행에 두 번 쓴다 — 그 회귀를 고정한다.
  it("clear-primary writes through the row (note_date_update), not the store setters, and never removes a related row", async () => {
    const setEventPrecision = vi.fn();
    const setEventEnd = vi.fn();
    const user = userEvent.setup();
    render(
      <DateBadge
        year={2026}
        month={7}
        day={15}
        end_year={2026}
        end_month={8}
        end_day={1}
        noteId="n1"
        setYear={noop}
        setEventPrecision={setEventPrecision}
        setEventEnd={setEventEnd}
      />,
    );
    await user.click(screen.getByTestId("date-badge"));
    // PLAN-2026-09-19-date-region-ui.md §P1 — the clear/delete action moved inside the row's
    // accordion body; the row must be expanded (clicked) before it's reachable.
    await user.click(await screen.findByTestId("note-date-primary"));
    const clearBtn = await screen.findByTestId("note-date-clear-primary");
    expect(clearBtn.getAttribute("aria-label")).toBe(t("editor.year_clear_date"));

    await user.click(clearBtn);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "p0", month: null, day: null, end_year: null }),
      ),
    );
    expect(setEventPrecision).not.toHaveBeenCalled();
    expect(setEventEnd).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalledWith("note_date_remove", expect.anything());
  });
});

// Part C (2026-09-07 owner: "날씨도 다른 달력들처럼 표시"): reuses useWeatherLocation +
// fetchDailyForecast (lib/weather.ts) — same fetch path as the home calendar, not a new one.
describe("DateBadge — popover weather (2026-09-07)", () => {
  const noop = () => {};

  beforeEach(() => {
    callMock.mockReset();
  });

  it("shows a weather icon on a day the forecast covers", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "weather_forecast") {
        return {
          entries: [
            { time: "2026-09-05T12:00:00Z", temp_c: 21, symbol_1h: "clearsky_day", symbol_6h: null, temp_max_6h: 23, temp_min_6h: 18 },
          ],
        };
      }
      return {};
    });
    render(
      <DateBadge year={2026} month={9} day={1} noteId="n1" setYear={noop} setEventPrecision={noop} setEventEnd={noop} />,
    );
    fireEvent.click(screen.getByTestId("date-badge"));
    await waitFor(() =>
      expect(screen.getByTestId("range-day-weather-2026-9-5")).toBeTruthy(),
    );
    // A day the forecast doesn't cover draws nothing — never a blank placeholder/"?".
    expect(screen.queryByTestId("range-day-weather-2026-9-6")).toBeNull();
  });

  // "설정이 꺼져 있으면 안 그린다" 테스트는 D11(2026-09-12)로 사라졌다 — 표시 토글 자체가
  // 없어졌고, 남은 유일한 게이트는 위치(useWeatherLocation)다.
});

// 회귀 고정(검수 2026-09-07): 초기화를 대표 행으로 옮기면서 초안 페이지(noteId 없음)에서
// 지우개가 통째로 사라졌다 — 목록 자체가 noteId 로 가려지기 때문이다. 그런데 초안에서도
// 정밀도 편집은 지원되므로(stores/notes.smoke.test.ts "setEventPrecision() on a draft…")
// 설정한 월/일을 되돌릴 길이 없어졌었다. 초안일 때만 입력 줄에 지우개를 둔다.
describe("DateBadge — 초안 페이지의 초기화", () => {
  it("noteId 가 없으면 입력 줄에 지우개가 있고, 누르면 정밀도가 해제된다", async () => {
    const setEventPrecision = vi.fn();
    const setEventEnd = vi.fn();
    render(
      <DateBadge
        year={2026}
        month={9}
        day={7}
        end_year={null}
        end_month={null}
        end_day={null}
        noteId={null}
        setYear={() => {}}
        setEventPrecision={setEventPrecision}
        setEventEnd={setEventEnd}
      />
    );
    await userEvent.click(screen.getByTestId("date-badge"));
    const eraser = await screen.findByTestId("date-clear-all-draft");
    await userEvent.click(eraser);
    expect(setEventPrecision).toHaveBeenCalledWith(null, null);
  });

  it("noteId 가 있으면 그 지우개는 없다 — 대표 행이 역할을 가져간다", async () => {
    render(
      <DateBadge
        year={2026}
        month={9}
        day={7}
        end_year={null}
        end_month={null}
        end_day={null}
        noteId="n1"
        setYear={() => {}}
        setEventPrecision={() => {}}
        setEventEnd={() => {}}
      />
    );
    await userEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-clear-all-draft")).toBeNull();
  });
});

// Rule 6 (2026-09-08 owner spec, PLAN-2026-09-08-dates-rebuild.md §E/§F) — regression fix: the old
// fallback input pair and register button must never come back, on either page.
describe("DateBadge — old fallback/register testids are gone for good", () => {
  it("gone on the draft page (noteId == null)", async () => {
    render(
      <DateBadge year={2026} month={9} day={7} noteId={null} setYear={() => {}} setEventPrecision={() => {}} setEventEnd={() => {}} />
    );
    await userEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-fallback-start")).toBeNull();
    expect(screen.queryByTestId("date-fallback-end")).toBeNull();
    expect(screen.queryByTestId("date-fallback-fields")).toBeNull();
    expect(screen.queryByTestId("date-register-related")).toBeNull();
  });

  it("gone on a note page (noteId set)", async () => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_dates_list" ? { dates: [] } : {}));
    render(
      <DateBadge year={2026} month={9} day={7} noteId="n1" setYear={() => {}} setEventPrecision={() => {}} setEventEnd={() => {}} />
    );
    await userEvent.click(screen.getByTestId("date-badge"));
    expect(screen.queryByTestId("date-fallback-start")).toBeNull();
    expect(screen.queryByTestId("date-fallback-end")).toBeNull();
    expect(screen.queryByTestId("date-fallback-fields")).toBeNull();
    expect(screen.queryByTestId("date-register-related")).toBeNull();
    expect(screen.queryByTestId("date-draft-precision")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("reminder-save")).toBeNull());
    expect(screen.queryByTestId("reminder-turn-off")).toBeNull();
  });
});
