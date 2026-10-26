import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { ReminderBell } from "./ReminderBell";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";

const callSilentMock = vi.fn().mockRejectedValue({ code: "IO", message: "test" });
const callMock = vi.fn().mockRejectedValue({ code: "IO", message: "test" });
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

describe("ReminderBell", () => {
  const selectNote = vi.fn().mockResolvedValue(undefined);
  const patchNoteSummary = vi.fn();

  beforeEach(() => {
    callSilentMock.mockReset();
    callSilentMock.mockRejectedValue({ code: "IO", message: "test" });
    callMock.mockReset();
    callMock.mockRejectedValue({ code: "IO", message: "test" });
    selectNote.mockReset();
    patchNoteSummary.mockReset();
    useSettingsStore.setState({
      uiLang: "en",
      activeWorkspaceId: "ws1",
      notificationsEnabled: true,
    });
    useNotesStore.setState({
      totalNotes: 0,
      noteIndex: new Map(),
      folders: [],
      selectNote,
      patchNoteSummary,
      activeNote: null,
    });
  });

  /** 노트의 대표(position 0) 행 — W4b 이후 프런트가 진짜 id 로 지목할 수 있다. */
  const primaryRow = (noteId: string) => ({
    id: `${noteId}-p0`, note_id: noteId, position: 0, year: 2026, month: 9, day: 7,
    end_year: null, end_month: null, end_day: null, remind: true, created_at: "",
    start_time: null, end_time: null, remind_offset_min: null, rrule: null,
  });

  const reminders = (...rows: Array<[string, string, string]>) =>
    callSilentMock.mockResolvedValue({
      items: rows.map(([note_id, title, fire_at]) => ({
        note_id,
        title,
        kind: "due",
        fire_at,
      })),
    });

  it("lists today's reminders in the popover and opens the note on click", async () => {
    reminders(
      ["n1", "아침 회의", "2026-08-09T09:00"],
      ["n2", "저녁 약속", "2026-08-09T18:30"],
    );
    const { getByTestId, queryByTestId } = render(<ReminderBell />);

    const bell = await waitFor(() => {
      const b = getByTestId("home-reminder-bell") as HTMLElement;
      expect(b.dataset.count).toBe("2");
      return b;
    });
    expect(callSilentMock).toHaveBeenCalledWith("schedule_today", { workspace_id: "ws1" });
    expect(queryByTestId("home-reminder-pop")).toBeNull();

    fireEvent.click(bell);
    const pop = getByTestId("home-reminder-pop") as HTMLElement;
    expect(pop.textContent).toContain("09:00");
    expect(pop.textContent).toContain("아침 회의");
    expect(pop.textContent?.indexOf("09:00")).toBeLessThan(pop.textContent?.indexOf("18:30") ?? -1);
    expect(getByTestId("home-reminder-app-toggle").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(getByTestId("home-reminder-item-n2"));
    expect(selectNote).toHaveBeenCalledWith("n2");
    expect(queryByTestId("home-reminder-pop")).toBeNull();
  });

  it("still lists reminders when the app master switch is off, with a notice line", async () => {
    useSettingsStore.setState({ notificationsEnabled: false });
    reminders(["n1", "아침 회의", "2026-08-09T09:00"]);
    const { getByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalled());

    fireEvent.click(getByTestId("home-reminder-bell"));
    expect(getByTestId("home-reminder-app-toggle").getAttribute("aria-checked")).toBe("false");
    expect(getByTestId("home-reminder-item-n1")).toBeDefined();
  });

  it("stale schedule_today response for a switched-away notebook never overwrites the new one's badge (dashboard audit P1 #2)", async () => {
    let resolveWs1: (v: { items: unknown[] }) => void = () => {};
    const ws1Promise = new Promise<{ items: unknown[] }>((resolve) => {
      resolveWs1 = resolve;
    });
    callSilentMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "schedule_today") {
        if (args?.workspace_id === "ws1") return ws1Promise;
        return Promise.resolve({
          items: [{ note_id: "n-ws2", title: "Other notebook reminder", kind: "due", fire_at: "2026-08-09T09:00" }],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const { getByTestId } = render(<ReminderBell />);

    act(() => {
      useSettingsStore.setState({ activeWorkspaceId: "ws2" });
    });
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("1"));

    await act(async () => {
      resolveWs1({ items: [{ note_id: "n-ws1-a" }, { note_id: "n-ws1-b" }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByTestId("home-reminder-bell").dataset.count).toBe("1");
  });

  it("shows the empty state and an unfilled bell when nothing is due", async () => {
    callSilentMock.mockResolvedValue({ items: [] });
    const { getByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalled());

    const bell = getByTestId("home-reminder-bell") as HTMLElement;
    expect(bell.dataset.count).toBe("0");
    expect(bell.querySelector("svg")?.getAttribute("style")).toContain("none");

    fireEvent.click(bell);
    const pop = getByTestId("home-reminder-pop") as HTMLElement;
    expect(pop.textContent).toContain("No reminders scheduled today");
  });

  it("renders an overdue section above today's, counted in the badge (GRILL-2026-09-07 D5)", async () => {
    callSilentMock.mockResolvedValue({
      items: [
        { note_id: "o1", title: "지난 할일", kind: "overdue", fire_at: null },
        { note_id: "n1", title: "아침 회의", kind: "due", fire_at: "2026-09-07T09:00" },
      ],
    });
    const { getByTestId } = render(<ReminderBell />);
    const bell = await waitFor(() => {
      const b = getByTestId("home-reminder-bell") as HTMLElement;
      expect(b.dataset.count).toBe("2");
      return b;
    });

    fireEvent.click(bell);
    expect(getByTestId("home-reminder-overdue-section").textContent).toContain("1");
    expect(getByTestId("home-reminder-item-o1").textContent).toContain("지난 할일");
    expect(getByTestId("home-reminder-item-n1").textContent).toContain("아침 회의");
    // 오늘 행도 알림 끄기를 갖는다(오너 2026-09-09) — 오늘 이미 울린 알림이 자정까지 치울 수
    // 없던 것이 이 버튼이 overdue 에만 있던 탓이다.
    expect(getByTestId("home-reminder-complete-n1")).toBeDefined();
  });

  it("turns a today reminder off from the bell without waiting for it to go overdue", async () => {
    reminders(["n1", "아침 회의", "2026-09-07T09:00"]);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [primaryRow("n1")] };
      return { ok: true };
    });
    const { getByTestId, queryByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("1"));
    fireEvent.click(getByTestId("home-reminder-bell"));

    // 벨을 여는 것이 reloadToken 을 올려 schedule_today 를 한 번 더 부른다 — 그 응답이
    // 낙관적 제거를 덮지 않도록 먼저 가라앉힌다(관련 날짜 테스트가 이미 쓰는 관용구).
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(2));

    fireEvent.click(getByTestId("home-reminder-complete-n1"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "n1-p0", remind: false }),
      ),
    );
    await waitFor(() => expect(queryByTestId("home-reminder-item-n1")).toBeNull());
  });

  it("hides the overdue section when there is nothing overdue", async () => {
    reminders(["n1", "아침 회의", "2026-09-07T09:00"]);
    const { getByTestId, queryByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalled());
    fireEvent.click(getByTestId("home-reminder-bell"));
    expect(queryByTestId("home-reminder-overdue-section")).toBeNull();
  });

  it("completes an overdue reminder (primary, no related_date_id) by turning the position 0 row's remind off — never note_update/note_set_status", async () => {
    callSilentMock.mockResolvedValue({
      items: [{ note_id: "o1", title: "지난 할일", kind: "overdue", fire_at: null }],
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [primaryRow("o1")] };
      return { ok: true };
    });
    const { getByTestId, queryByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("1"));
    fireEvent.click(getByTestId("home-reminder-bell"));

    // 벨을 여는 것이 reloadToken 을 올려 schedule_today 를 한 번 더 부른다 — 그 응답이
    // 낙관적 제거를 덮지 않도록 먼저 가라앉힌다(관련 날짜 테스트가 이미 쓰는 관용구).
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(2));

    fireEvent.click(getByTestId("home-reminder-complete-o1"));
    // PLAN-2026-09-08-dates-rebuild.md §1.5 + PLAN-2026-09-10 D6: completion means the same thing
    // everywhere now — turning that row's own remind off. 대표도 진짜 note_dates.id 를 갖고 있어
    // (W4b) related_date_id 가 null 이면 patchDateRow 가 position 0 행을 찾는다. 옛 대표 분기
    // (note_update{remind})도, note_set_status 도 없다.
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "o1-p0", remind: false }),
      ),
    );
    expect(callMock).not.toHaveBeenCalledWith("note_update", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_set_status", expect.anything());

    await waitFor(() => expect(queryByTestId("home-reminder-item-o1")).toBeNull());
    await waitFor(() =>
      expect(patchNoteSummary).toHaveBeenCalledWith("o1", { remind: false }),
    );
  });

  it("rolls the overdue item back into the list when completing it fails", async () => {
    callSilentMock.mockResolvedValue({
      items: [{ note_id: "o1", title: "지난 할일", kind: "overdue", fire_at: null }],
    });
    callMock.mockRejectedValue({ code: "IO", message: "fail" });
    const { getByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("1"));
    fireEvent.click(getByTestId("home-reminder-bell"));

    fireEvent.click(getByTestId("home-reminder-complete-o1"));
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId("home-reminder-item-o1")).toBeDefined());
  });

  // PLAN-2026-09-07-reminder-2tier.md §0.3 / §6 — a note can carry several related-date
  // reminders (same note_id, distinct related_date_id) alongside its own primary reminder.
  it("renders two related-date reminders on the same note as distinct, uniquely reachable rows", async () => {
    callSilentMock.mockResolvedValue({
      items: [
        { note_id: "n1", title: "회의 A", kind: "overdue", fire_at: null, related_date_id: "d1" },
        { note_id: "n1", title: "회의 B", kind: "overdue", fire_at: null, related_date_id: "d2" },
      ],
    });
    const { getByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("2"));
    fireEvent.click(getByTestId("home-reminder-bell"));

    expect(getByTestId("home-reminder-item-n1-d1").textContent).toContain("회의 A");
    expect(getByTestId("home-reminder-item-n1-d2").textContent).toContain("회의 B");
  });

  it("completing a related-date reminder turns its own remind off via note_date_update, never the note's status", async () => {
    callSilentMock.mockResolvedValue({
      items: [{ note_id: "n1", title: "회의 A", kind: "overdue", fire_at: null, related_date_id: "d1" }],
    });
    const row = {
      id: "d1", note_id: "n1", position: 1, year: 2026, month: 9, day: 10,
      end_year: null, end_month: null, end_day: null, remind: true, created_at: "",
      start_time: null, end_time: null, remind_offset_min: null, rrule: null,
    };
    // A related row's id is real (unlike the primary's) — note_date_update is a full-row
    // replace (notes.yaml), so completeReminder fetches the row's current state first.
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [row] };
      return { ok: true };
    });
    const { getByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("1"));
    fireEvent.click(getByTestId("home-reminder-bell"));
    // Bell-open bumps reloadToken (staleness refetch, unrelated to this wave) — wait for that
    // fetch to settle before completing, or its still-not-completed echo can stomp the optimistic
    // removal below (both effects share the same `items` state).
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(2));

    fireEvent.click(getByTestId("home-reminder-complete-n1-d1"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_update", expect.objectContaining({ id: "d1", remind: false })),
    );
    expect(callMock).not.toHaveBeenCalledWith("note_set_status", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_update", expect.anything());
  });

  it("completing one related-date reminder leaves its sibling row for the same note in place", async () => {
    callSilentMock.mockResolvedValue({
      items: [
        { note_id: "n1", title: "회의 A", kind: "overdue", fire_at: null, related_date_id: "d1" },
        { note_id: "n1", title: "회의 B", kind: "overdue", fire_at: null, related_date_id: "d2" },
      ],
    });
    const rowFor = (id: string) => ({
      id, note_id: "n1", position: 1, year: 2026, month: 9, day: 10,
      end_year: null, end_month: null, end_day: null, remind: true, created_at: "",
      start_time: null, end_time: null, remind_offset_min: null, rrule: null,
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [rowFor("d1"), rowFor("d2")] };
      return { ok: true };
    });
    const { getByTestId, queryByTestId } = render(<ReminderBell />);
    await waitFor(() => expect(getByTestId("home-reminder-bell").dataset.count).toBe("2"));
    fireEvent.click(getByTestId("home-reminder-bell"));
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(2));

    fireEvent.click(getByTestId("home-reminder-complete-n1-d1"));
    await waitFor(() => expect(queryByTestId("home-reminder-item-n1-d1")).toBeNull());
    expect(getByTestId("home-reminder-item-n1-d2")).toBeDefined();
  });
});
