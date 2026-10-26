import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { TimelineRoutineSection } from "./TimelineRoutineSection";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
}));

const routine1 = {
  id: "r1",
  workspace_id: "w1",
  title: "출근",
  weekday_mask: 0b0011111, // Mon-Fri
  start_time: "09:00",
  end_time: "18:00",
  color_hue: 200,
  skip_holidays: false,
  position: 0,
  created_at: "2026-09-13T00:00:00Z",
  updated_at: "2026-09-13T00:00:00Z",
};

const routine2 = {
  id: "r2",
  workspace_id: "w1",
  title: "헬스",
  weekday_mask: 0b1000000, // Sun only
  start_time: "19:00",
  end_time: "20:00",
  color_hue: null,
  skip_holidays: false,
  position: 1,
  created_at: "2026-09-13T00:00:00Z",
  updated_at: "2026-09-13T00:00:00Z",
};

function mockList(routines: unknown[]) {
  callMock.mockReset().mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "timeline_routine_list") return Promise.resolve({ routines });
    if (cmd === "timeline_routine_create") {
      return Promise.resolve({ id: "new", workspace_id: "w1", position: routines.length, ...args });
    }
    if (cmd === "timeline_routine_update") return Promise.resolve({ id: args?.id, ...args });
    if (cmd === "timeline_routine_delete") return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
}

describe("TimelineRoutineSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en", activeWorkspaceId: null } as any);
    mockList([]);
  });

  it("loads and lists routines on mount, sorted as the server returns them", async () => {
    mockList([routine1, routine2]);
    render(<TimelineRoutineSection />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));
    expect(await screen.findByTestId("timeline-routine-row-r1")).toBeTruthy();
    expect(screen.getByTestId("timeline-routine-row-r2")).toBeTruthy();
    expect(screen.getByText("출근")).toBeTruthy();
    expect(screen.getByText("헬스")).toBeTruthy();
  });

  it("renders rows in a SettingsTable and badges skip_holidays (PLAN-2026-09-15 §4)", async () => {
    mockList([{ ...routine1, skip_holidays: true }, routine2]);
    render(<TimelineRoutineSection />);

    expect(await screen.findByTestId("timeline-routine-row-r1")).toBeTruthy();
    expect(screen.getByTestId("timeline-routine-skip-badge-r1").textContent).toBe("Skips holidays");
    expect(screen.queryByTestId("timeline-routine-skip-badge-r2")).toBeNull();
    // Table header row is present (title / weekday / actions).
    expect(screen.getByText("Title")).toBeTruthy();
  });

  it("re-fetches for the new notebook when the active notebook changes, ignoring a late reply from the old one", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    callMock.mockReset().mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "timeline_routine_list") return Promise.resolve({});
      if (args?.workspace_id === "w1") return new Promise((r) => (resolveOld = r));
      return Promise.resolve({ routines: [routine2] });
    });
    act(() => useSettingsStore.setState({ activeWorkspaceId: "w1" } as any));
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", { workspace_id: "w1" }));

    act(() => useSettingsStore.setState({ activeWorkspaceId: "w2" } as any));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", { workspace_id: "w2" }));
    expect(await screen.findByTestId("timeline-routine-row-r2")).toBeTruthy();

    // 옛 노트북 응답이 늦게 와도 새 목록을 덮지 않는다.
    await act(async () => resolveOld({ routines: [routine1] }));
    expect(screen.queryByTestId("timeline-routine-row-r1")).toBeNull();
    expect(screen.getByTestId("timeline-routine-row-r2")).toBeTruthy();
  });

  // 오너 QA 2026-09-15 R1: 표는 카드에 넣지 않는다 — 제목 행 + 표가 페이지 위에 그대로 선다.
  it("renders unboxed — a heading row and a table, no .card wrapper (R1)", async () => {
    mockList([routine1]);
    const { container } = render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));
    expect(container.querySelector(".card")).toBeNull();
    expect(screen.getByTestId("settings-timeline-routine-section")).toBeTruthy();
    expect(screen.getByTestId("timeline-routine-add-btn")).toBeTruthy();
  });

  it("shows an empty hint when there are no routines", async () => {
    mockList([]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));
    expect(screen.queryByTestId("timeline-routine-list")).toBeNull();
  });

  it("opens the add form, validates required fields, then creates with the toggled weekday mask", async () => {
    mockList([]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-add-btn"));
    expect(screen.getByTestId("timeline-routine-title-input")).toBeTruthy();

    // Empty title is rejected before any create call fires.
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    expect(await screen.findByTestId("timeline-routine-form-error")).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("timeline_routine_create", expect.anything());

    const user = userEvent.setup();
    await user.type(screen.getByTestId("timeline-routine-title-input"), "출근");

    // Default mask is Mon-Fri (bits 0..4) — deselect all of them, which should trip the
    // "select at least one day" validation instead of silently saving weekday_mask=0.
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByTestId(`timeline-routine-weekday-${i}`));
    }
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    expect(await screen.findByTestId("timeline-routine-form-error")).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("timeline_routine_create", expect.anything());

    // Re-select Monday and Wednesday only (bits 0 and 2 -> mask 0b0000101 = 5).
    fireEvent.click(screen.getByTestId("timeline-routine-weekday-0"));
    fireEvent.click(screen.getByTestId("timeline-routine-weekday-2"));

    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "timeline_routine_create",
        expect.objectContaining({
          title: "출근",
          weekday_mask: 0b0000101,
          start_time: "09:00",
          end_time: "18:00",
          color_hue: null,
        }),
      ),
    );
  });

  it("rejects an overnight range with a message that says why (v1 doesn't cross midnight)", async () => {
    mockList([]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-add-btn"));
    const user = userEvent.setup();
    await user.type(screen.getByTestId("timeline-routine-title-input"), "출근");

    fireEvent.change(screen.getByTestId("timeline-routine-start-input"), { target: { value: "18:00" } });
    fireEvent.change(screen.getByTestId("timeline-routine-end-input"), { target: { value: "09:00" } });

    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    const err = await screen.findByTestId("timeline-routine-form-error");
    expect(err.textContent).toContain("past midnight");
    expect(err.textContent).toContain("18:00–23:59");
    expect(callMock).not.toHaveBeenCalledWith("timeline_routine_create", expect.anything());
  });

  it("a failed save keeps the form open without repeating the toast inline", async () => {
    mockList([]);
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "timeline_routine_create" ? Promise.reject(new Error("VALIDATION: boom")) : base(cmd, args),
    );
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));
    fireEvent.click(screen.getByTestId("timeline-routine-add-btn"));
    fireEvent.change(screen.getByTestId("timeline-routine-title-input"), { target: { value: "출근" } });
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_create", expect.anything()));
    await waitFor(() =>
      expect((screen.getByTestId("timeline-routine-form-save-btn") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId("timeline-routine-title-input")).toBeTruthy();
    expect(screen.queryByTestId("timeline-routine-form-error")).toBeNull();
  });

  it("opens the edit form pre-filled from the row and saves an update with the changed title", async () => {
    mockList([routine1]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-edit-r1"));
    const titleInput = screen.getByTestId("timeline-routine-title-input") as HTMLInputElement;
    expect(titleInput.value).toBe("출근");
    expect((screen.getByTestId("timeline-routine-start-input") as HTMLInputElement).value).toBe("09:00");
    // color_hue=200 on the row -> the color toggle should already read as "in use".
    // 아이콘 버튼이라 상태는 이름(aria-label)으로 읽는다.
    expect(screen.getByTestId("timeline-routine-color-toggle").getAttribute("aria-label")).toBe("Clear color");

    fireEvent.change(titleInput, { target: { value: "재택근무" } });
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "timeline_routine_update",
        expect.objectContaining({ id: "r1", title: "재택근무", color_hue: 200 }),
      ),
    );
  });

  it("clearing the color toggle sends color_hue: null on save", async () => {
    mockList([routine1]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-edit-r1"));
    fireEvent.click(screen.getByTestId("timeline-routine-color-toggle"));
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "timeline_routine_update",
        expect.objectContaining({ id: "r1", color_hue: null }),
      ),
    );
  });

  it("toggling skip-holidays sends skip_holidays: true on create", async () => {
    mockList([]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-add-btn"));
    const user = userEvent.setup();
    await user.type(screen.getByTestId("timeline-routine-title-input"), "출근");
    fireEvent.click(screen.getByTestId("timeline-routine-skip-holidays"));
    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "timeline_routine_create",
        expect.objectContaining({ skip_holidays: true }),
      ),
    );
  });

  it("pre-fills skip-holidays from the row when editing, unchanged if left alone", async () => {
    mockList([{ ...routine1, skip_holidays: true }]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-edit-r1"));
    const toggle = screen.getByTestId("timeline-routine-skip-holidays");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("timeline-routine-form-save-btn"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "timeline_routine_update",
        expect.objectContaining({ id: "r1", skip_holidays: true }),
      ),
    );
  });

  it("deletes a routine only after the confirm dialog is accepted", async () => {
    mockList([routine1]);
    render(<TimelineRoutineSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));

    fireEvent.click(screen.getByTestId("timeline-routine-delete-r1"));
    expect(screen.getByText("Delete recurring schedule")).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("timeline_routine_delete", expect.anything());

    // 행의 휴지통 아이콘과 확인 버튼이 같은 이름("Delete")이라 확인 대화상자 안에서 고른다.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_delete", { id: "r1" }));
  });
});
