import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteDatesList } from "./NoteDatesList";
import { useNotesStore } from "../../stores/notes";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
const bumpMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: vi.fn(() => () => {}),
  // makePrimary's/deleteRow's reloadActive() (stores/notesActive.ts) awaits flushAll() before
  // note_get — unmocked it's undefined, throwing inside reloadActive's own try/catch and silently
  // skipping the note_get call this suite asserts on.
  flushAll: vi.fn(async () => {}),
}));

// PLAN-2026-09-10 D2: 변경 뒤 달력이 따라오게 하는 두 번째 축. 실물은 250ms 코얼레싱 타이머를
// 들고 있어 테스트에서 굳이 돌릴 이유가 없다 — 불렸는지만 본다.
vi.mock("../../lib/noteQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/noteQuery")>()),
  bumpNoteQueryVersion: (...args: unknown[]) => bumpMock(...args),
}));

/** 대표 = position 0 행. 더 이상 props 로 내려오는 `notes.*` 미러가 아니라 목록의 첫 행이다. */
const PRIMARY_ROW = {
  id: "p0",
  note_id: "n1",
  position: 0,
  year: 2026,
  month: 7,
  day: 1,
  end_year: null,
  end_month: null,
  end_day: null,
  remind: false,
  created_at: "",
  start_time: null,
  end_time: null,
  remind_offset_min: null,
  rrule: null,
  label: null,
};

const YEAR_ONLY_PRIMARY_ROW = { ...PRIMARY_ROW, month: null, day: null };

const RELATED_ROW = {
  id: "d1",
  note_id: "n1",
  position: 1,
  year: 2026,
  month: 9,
  day: 10,
  end_year: null,
  end_month: null,
  end_day: null,
  remind: false,
  created_at: "",
  start_time: null,
  end_time: null,
  remind_offset_min: null,
  rrule: null,
  label: null,
};

const RELATED_ROW_2 = {
  ...RELATED_ROW,
  id: "d2",
  position: 2,
  month: 11,
  day: 20,
};

// zustand 스토어는 파일 안에서 살아 있다 — reloadActive 를 스파이로 바꾼 테스트가 다음 테스트의
// note_get 기대를 조용히 없애지 않도록 원본을 붙들어 두고 매번 되돌린다.
const realReloadActive = useNotesStore.getState().reloadActive;

const NOTE_GET_RESULT = {
  note: { id: "n1", year: 2026, month: 9, day: 10, remind: false },
  sections: [],
  sources: [],
  attachments: [],
};

function setActiveNote() {
  useNotesStore.setState({
    activeNote: { note: { id: "n1" } as never, sections: [], sources: [], attachments: [] },
    activeDraft: false,
  } as never);
}

function resetActiveNote() {
  useNotesStore.setState({
    activeNote: null,
    activeDraft: false,
    reloadActive: realReloadActive,
  } as never);
}

// PLAN-2026-09-19-date-region-ui.md §P1 (accordion rewrite): the old field-level chip drawer
// (`open: {id, field}`, one glowline chip per field, mounted only when `remind` was on) is gone.
// Clicking a row now selects AND expands it (single-open, list-wide); every field (name/time/
// repeat/notify-offset) shows at once inside the expansion, gated only by precision (time) and
// `remind` (notify-offset) — never by a separate per-field open state.
describe("NoteDatesList — row accordion (§P1)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_update") return { ...RELATED_ROW, remind: true };
      if (cmd === "note_date_remove") return { ok: true };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("clicking a row expands its body; clicking a different row closes the first (single-open)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    expect(await screen.findByTestId("note-date-body-primary")).toBeTruthy();
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();

    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(await screen.findByTestId("note-date-body-d1")).toBeTruthy();
    expect(screen.queryByTestId("note-date-body-primary")).toBeNull();
  });

  it("clicking an open row again collapses it", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(await screen.findByTestId("note-date-body-d1")).toBeTruthy();

    await user.click(screen.getByTestId("note-date-row-d1"));
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();
  });

  it("a row click also selects it (onSelect, unchanged contract)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} onSelect={onSelect} selectedId={null} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  // D2 — time/repeat are the event's own properties, not reminder properties: they show whenever
  // the row is expanded, regardless of the bell. Only the notify-offset field stays gated on remind.
  it("time and repeat fields are visible when the row is expanded even though remind is off", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const bell = await screen.findByTestId("note-date-remind-d1");
    expect(bell.getAttribute("aria-pressed")).toBe("false");

    await user.click(await screen.findByTestId("note-date-row-d1"));

    expect(await screen.findByTestId("reminder-start-time")).toBeTruthy();
    expect(screen.getByTestId("reminder-end-time")).toBeTruthy();
    expect(screen.getByTestId("reminder-repeat-select")).toBeTruthy();
    // 알림 시점은 벨이 꺼져 있으면 없다 — D2.
    expect(screen.queryByTestId("reminder-offset-select")).toBeNull();
  });

  it("the notify-offset field appears once remind is on, inside the same expanded body", async () => {
    const on = { ...RELATED_ROW, remind: true };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return on;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(await screen.findByTestId("reminder-offset-select")).toBeTruthy();
  });

  // Rule 4 (unchanged) — a low-precision row (year only) has no time field, full stop; repeat
  // stays regardless of precision.
  it("a low-precision row (year only) has no time field but keeps the repeat field", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [YEAR_ONLY_PRIMARY_ROW] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    expect(screen.queryByTestId("reminder-start-time")).toBeNull();
    expect(screen.getByTestId("reminder-repeat-select")).toBeTruthy();
  });

  it("bell click commits the flipped remind value plus every other field in one note_date_update call", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-remind-d1"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_update", {
        id: "d1",
        year: 2026,
        month: 9,
        day: 10,
        end_year: null,
        end_month: null,
        end_day: null,
        remind: true,
        start_time: null,
        end_time: null,
        remind_offset_min: null,
        rrule: null,
        label: null,
      }),
    );
  });

  it("clicking the bell does not also toggle the row open (stopPropagation)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-remind-d1"));
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();
  });

  it("a failed bell click rolls the row back to its previous remind state", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_update") throw { code: "VALIDATION", message: "nope" };
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const bell = await screen.findByTestId("note-date-remind-d1");
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    await user.click(bell);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_update", expect.anything()));
    await waitFor(() => expect(bell.getAttribute("aria-pressed")).toBe("false"));
  });

  it("blurring a typed start time commits it via note_date_update", async () => {
    const on = { ...RELATED_ROW, remind: true };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return on;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;

    fireEvent.change(startInput, { target: { value: "0900" } });
    fireEvent.blur(startInput);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", start_time: "09:00" }),
      ),
    );
  });

  it("an invalid typed time is not committed, is flagged (aria-invalid + message) and the text stays editable", async () => {
    const on = { ...RELATED_ROW, remind: true, start_time: "09:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return on;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;
    expect(startInput.value).toBe("09:00");
    expect(startInput.getAttribute("aria-invalid")).toBeNull();

    callMock.mockClear();
    fireEvent.change(startInput, { target: { value: "오후 13시" } });
    // 입력 중엔 방해하지 않는다 — blur 전엔 표시 없음.
    expect(startInput.getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(startInput);

    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
    expect(startInput.value).toBe("오후 13시");
    expect(startInput.getAttribute("aria-invalid")).toBe("true");
    expect(startInput.style.borderColor).toBe("var(--danger)");
    expect(screen.getByTestId("reminder-time-error").textContent).toBeTruthy();
  });

  it("saving the same normalized time as the row skips note_date_update", async () => {
    const on = { ...RELATED_ROW, start_time: "09:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return on;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;
    callMock.mockClear();
    fireEvent.change(startInput, { target: { value: "9" } });
    fireEvent.blur(startInput);
    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
    expect(startInput.value).toBe("09:00");
    // 그냥 포커스만 지나가도(값 그대로) 전송 없음.
    fireEvent.blur(startInput);
    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
  });

  it("Escape reverts the typed text to the row value without saving; Enter commits", async () => {
    const on = { ...RELATED_ROW, start_time: "09:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return { ...on, start_time: "10:15" };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;
    callMock.mockClear();
    fireEvent.change(startInput, { target: { value: "1015" } });
    fireEvent.keyDown(startInput, { key: "Escape" });
    expect(startInput.value).toBe("09:00");
    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());

    fireEvent.change(startInput, { target: { value: "오전 10시15분" } });
    fireEvent.keyDown(startInput, { key: "Enter" });
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", start_time: "10:15" }),
      ),
    );
  });

  it("end before start on the same day is blocked on the client with a message", async () => {
    const on = { ...RELATED_ROW, start_time: "14:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") return on;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const endInput = (await screen.findByTestId("reminder-end-time")) as HTMLInputElement;
    callMock.mockClear();
    fireEvent.change(endInput, { target: { value: "13:00" } });
    fireEvent.blur(endInput);
    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
    expect(endInput.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("reminder-time-error")).toBeTruthy();
  });

  it("a server rejection rolls the row back and the input returns to the saved value", async () => {
    const on = { ...RELATED_ROW, start_time: "09:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, on] };
      if (cmd === "note_date_update") throw { code: "VALIDATION", message: "nope" };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "1030" } });
    fireEvent.blur(startInput);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_update", expect.anything()));
    await waitFor(() => expect(startInput.value).toBe("09:00"));
  });

  it("re-syncs the input when the row value changes underneath (e.g. after a refetch)", async () => {
    let row = { ...RELATED_ROW, start_time: "09:00" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, row] };
      if (cmd === "note_date_update") return row;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const startInput = (await screen.findByTestId("reminder-start-time")) as HTMLInputElement;
    expect(startInput.value).toBe("09:00");

    // 다른 경로(벨 클릭 → 서버 응답으로 행 교체)로 row.start_time 이 바뀌면 입력이 따라온다.
    row = { ...row, start_time: "11:45" };
    await user.click(screen.getByTestId("note-date-remind-d1"));
    await waitFor(() => expect(startInput.value).toBe("11:45"));
  });

  it("keeps an already-saved UNTIL when another repeat field is edited (no input for it any more)", async () => {
    const user = userEvent.setup();
    const withUntil = { ...RELATED_ROW, remind: true, rrule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, withUntil] };
      if (cmd === "note_date_update") return withUntil;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(screen.queryByTestId("reminder-until")).toBeNull();

    await user.click(await screen.findByTestId("reminder-byday-TH"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_update", expect.anything()));
    const updates = callMock.mock.calls.filter((c) => c[0] === "note_date_update");
    const sent = updates[updates.length - 1][1] as { rrule: string | null };
    expect(sent.rrule).toContain("UNTIL=20261231");
    expect(sent.rrule).toContain("TH");
  });

  it("the old chip-drawer's testids are gone for good", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(screen.queryByTestId("reminder-on-toggle")).toBeNull();
    expect(screen.queryByTestId("reminder-save")).toBeNull();
    expect(screen.queryByTestId("reminder-turn-off")).toBeNull();
    expect(screen.queryByTestId("note-date-chip-time-d1")).toBeNull();
    expect(screen.queryByTestId("note-date-edit-label-d1")).toBeNull();
  });
});

describe("NoteDatesList — unified list: primary row + promote", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_make_primary") return { ok: true };
      if (cmd === "note_date_update") return PRIMARY_ROW;
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("shows the position 0 row on top, badge-marked", async () => {
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const primaryRow = await screen.findByTestId("note-date-primary");
    expect(primaryRow.textContent).toContain("2026.07.01");
    await screen.findByTestId("note-date-row-d1");
    const rows = screen.getAllByTestId(/^note-date-(primary|row-)/);
    expect(rows[0]).toBe(primaryRow);
  });

  it("expanding a related row shows a [★ 대표로] promote button that calls note_date_make_primary, no confirmation dialog", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    await user.click(await screen.findByTestId("note-date-make-primary-d1"));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_make_primary", { id: "d1" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_get", { id: "n1" }));
    confirmSpy.mockRestore();
  });

  it("expanding the primary row has no [★ 대표로] button (already primary)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    expect(screen.queryByTestId("note-date-make-primary-p0")).toBeNull();
  });
});

// PLAN-2026-09-19-date-region-ui.md §P1 D1 — the unified [삭제] action's handler branches by row
// kind/state. These are the required regression cases the plan doc calls out explicitly.
describe("NoteDatesList — unified delete (§P1 D1)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("related row delete calls note_date_remove (unchanged)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_remove") return { ok: true };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    await user.click(await screen.findByTestId("note-date-remove-d1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_remove", { id: "d1" }));
    expect(callMock).not.toHaveBeenCalledWith("note_date_make_primary", expect.anything());
  });

  // Required regression #1 — primary delete + related rows exist: date_make_primary THEN
  // date_remove, in that order, on the lowest-position related row / the old primary.
  it("primary delete with related rows: calls date_make_primary on the next row then date_remove on the old primary, in that order", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW, RELATED_ROW_2] };
      if (cmd === "note_date_make_primary") return { ok: true };
      if (cmd === "note_date_remove") return { ok: true };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    await user.click(await screen.findByTestId("note-date-clear-primary"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_remove", { id: "p0" }));
    const calls = callMock.mock.calls.filter(
      (c) => c[0] === "note_date_make_primary" || c[0] === "note_date_remove",
    );
    // 승격(다음 관련 행 = 가장 낮은 position, d1) 다음에야 삭제(옛 대표, p0)가 온다.
    const makePrimaryIdx = calls.findIndex((c) => c[0] === "note_date_make_primary");
    const removeIdx = calls.findIndex((c) => c[0] === "note_date_remove");
    expect(makePrimaryIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(makePrimaryIdx);
    expect(calls[makePrimaryIdx][1]).toEqual({ id: "d1" });
    expect(calls[removeIdx][1]).toEqual({ id: "p0" });
  });

  it("primary delete with related rows: after reload, the promoted row shows as primary and the old primary shows as a related row", async () => {
    const promotedList = { dates: [{ ...RELATED_ROW, position: 0 }, { ...PRIMARY_ROW, position: 1 }] };
    let removed = false;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return removed ? promotedList : { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_make_primary") return { ok: true };
      if (cmd === "note_date_remove") {
        removed = true;
        return { ok: true };
      }
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    await user.click(await screen.findByTestId("note-date-clear-primary"));

    const newPrimary = await screen.findByTestId("note-date-primary");
    await waitFor(() => expect(newPrimary.textContent).toContain("2026.09.10"));
    expect(await screen.findByTestId("note-date-row-p0")).toBeTruthy();
  });

  // Required regression #2 — primary delete + no related rows: no date_make_primary call, existing
  // eraser payload (month/day/end_*/start_time/end_time/rrule all null, fixed in c1b9503c) unchanged.
  it("primary delete with no related rows: no date_make_primary call, falls back to the eraser payload", async () => {
    const scheduledPrimary = {
      ...PRIMARY_ROW,
      start_time: "09:00",
      end_time: "10:00",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    };
    const onClearPrimary = vi.fn();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [scheduledPrimary] };
      if (cmd === "note_date_update") return { ...scheduledPrimary, month: null, day: null };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={onClearPrimary} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    await user.click(await screen.findByTestId("note-date-clear-primary"));

    expect(onClearPrimary).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({
          id: "p0",
          month: null,
          day: null,
          end_year: null,
          end_month: null,
          end_day: null,
          start_time: null,
          end_time: null,
          rrule: null,
        }),
      ),
    );
    expect(callMock).not.toHaveBeenCalledWith("note_date_make_primary", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_date_remove", expect.anything());
  });

  // §P4 D13 — 글자 버튼([삭제])이 아니라 헤더의 휴지통 아이콘이다. 보이는 글자가 없으므로 뜻은
  // aria-label/title 이 나른다 — 둘 다 비어 있지 않아야 한다(대표와 관련 행의 문구는 다르다:
  // 대표는 "날짜 지우기", 관련은 "날짜 삭제" — 대표 혼자일 땐 실제로 행이 안 없어지므로).
  it("the delete action is an icon-only button (no visible text) with an aria-label, on both the primary and a related row", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, RELATED_ROW] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    const primaryDelete = await screen.findByTestId("note-date-clear-primary");
    await user.click(await screen.findByTestId("note-date-primary")); // collapse
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const relatedDelete = await screen.findByTestId("note-date-remove-d1");
    expect(primaryDelete.textContent).toBe("");
    expect(relatedDelete.textContent).toBe("");
    expect(primaryDelete.getAttribute("aria-label")).toBeTruthy();
    expect(relatedDelete.getAttribute("aria-label")).toBeTruthy();
  });

  // Failure path — "어중간한 로컬 상태를 만들지 않는다": on failure of either call (including the
  // second-only), reload from the server instead of leaving stale optimistic state.
  it("primary delete with related rows: if date_remove fails after date_make_primary succeeds, the list reloads from the server", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_make_primary") return { ok: true };
      if (cmd === "note_date_remove") throw { code: "VALIDATION", message: "nope" };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    await user.click(await screen.findByTestId("note-date-clear-primary"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_remove", { id: "p0" }));
    // reload() re-fetches note_dates_list at least twice: once on mount, once after the failure.
    const listCalls = callMock.mock.calls.filter((c) => c[0] === "note_dates_list");
    await waitFor(() => expect(listCalls.length).toBeGreaterThanOrEqual(2));
  });

  it("primary delete with related rows: re-selects the promoted row if the old primary was selected", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_make_primary") return { ok: true };
      if (cmd === "note_date_remove") return { ok: true };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <NoteDatesList noteId="n1" onClearPrimary={() => {}} onSelect={onSelect} selectedId="p0" />,
    );
    await user.click(await screen.findByTestId("note-date-primary"));
    onSelect.mockClear(); // clear the select-on-click call from opening the row above
    await user.click(await screen.findByTestId("note-date-clear-primary"));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "d1", isPrimary: true })),
    );
  });

  it("related row delete: re-selects the primary row if the deleted related row was selected", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_remove") return { ok: true };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <NoteDatesList noteId="n1" onClearPrimary={() => {}} onSelect={onSelect} selectedId="d1" />,
    );
    await user.click(await screen.findByTestId("note-date-row-d1"));
    onSelect.mockClear();
    await user.click(await screen.findByTestId("note-date-remove-d1"));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p0", isPrimary: true })),
    );
  });
});

// PLAN-2026-09-18-nl-dates.md D1(V85) — related-date names survive the §P1 accordion rewrite.
// D2: 대표(position 0)는 이름 편집 진입점 자체가 없다(static "—"). 표시는 "label ?? 날짜"(rowSummary).
describe("NoteDatesList — related-date names (D1/D2, V85, restructured for §P1)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, RELATED_ROW] };
      if (cmd === "note_date_update") return { ...RELATED_ROW, label: "체크인" };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("the position 0 row's expanded body shows a static dash, not a name input (D2)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-primary"));
    await screen.findByTestId("note-date-body-primary");
    expect(screen.queryByTestId("note-date-label-input-p0")).toBeNull();
  });

  it("expanding a related row shows its name input; blurring a typed value commits it via note_date_update", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const input = (await screen.findByTestId("note-date-label-input-d1")) as HTMLInputElement;
    expect(input.value).toBe("");

    await user.type(input, "체크인");
    fireEvent.blur(input);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", label: "체크인" }),
      ),
    );
  });

  it("Enter also commits the typed name", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const input = await screen.findByTestId("note-date-label-input-d1");

    await user.type(input, "체크아웃{Enter}");

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", label: "체크아웃" }),
      ),
    );
  });

  it("blurring an emptied name input commits label: null", async () => {
    const labeled = { ...RELATED_ROW, label: "체크인" };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, labeled] };
      if (cmd === "note_date_update") return { ...labeled, label: null };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const input = (await screen.findByTestId("note-date-label-input-d1")) as HTMLInputElement;
    expect(input.value).toBe("체크인");

    await user.clear(input);
    fireEvent.blur(input);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", label: null }),
      ),
    );
  });

  it("shows the label instead of the date once the row has one, and the date when it doesn't", async () => {
    const labeled = { ...RELATED_ROW, label: "체크인" };
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, labeled] } : {},
    );
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const row = await screen.findByTestId("note-date-row-d1");
    expect(row.textContent).toContain("체크인");
    expect(row.textContent).not.toContain("2026.09.10");
    expect((await screen.findByTestId("note-date-primary")).textContent).toContain("2026.07.01");
  });
});

// PLAN-2026-09-19-date-region-ui.md §P1 — DatesPanel's "+" flow tells this list which row to start
// expanded via `justAddedId` (a new prop).
describe("NoteDatesList — justAddedId auto-expands the newly created row", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, RELATED_ROW] } : {},
    );
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("setting justAddedId to a row's id opens that row's body without a click", async () => {
    const { rerender } = render(
      <NoteDatesList noteId="n1" onClearPrimary={() => {}} justAddedId={null} />,
    );
    await screen.findByTestId("note-date-row-d1");
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();

    rerender(<NoteDatesList noteId="n1" onClearPrimary={() => {}} justAddedId="d1" />);
    expect(await screen.findByTestId("note-date-body-d1")).toBeTruthy();
  });

  it("a repeated (unchanged) justAddedId value does not re-open a row the user closed", async () => {
    const { rerender } = render(
      <NoteDatesList noteId="n1" onClearPrimary={() => {}} justAddedId="d1" />,
    );
    const user = userEvent.setup();
    expect(await screen.findByTestId("note-date-body-d1")).toBeTruthy();
    await user.click(screen.getByTestId("note-date-row-d1")); // user collapses it
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();

    rerender(<NoteDatesList noteId="n1" onClearPrimary={() => {}} justAddedId="d1" />);
    expect(screen.queryByTestId("note-date-body-d1")).toBeNull();
  });
});

// PLAN-2026-09-19-date-region-ui.md §P4 D13 (오너 QA 1차) — 행 액션은 헤더의 아이콘, 본문은 필드만,
// 이름·시각 옆에는 초기화(×).
describe("NoteDatesList — header action icons + field clear buttons (§P4 D13)", () => {
  const LABELLED_TIMED_ROW = { ...RELATED_ROW, label: "체크인", start_time: "14:00", end_time: "16:00" };

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: [PRIMARY_ROW, LABELLED_TIMED_ROW] };
      if (cmd === "note_date_update") return { ...LABELLED_TIMED_ROW, ...args };
      if (cmd === "note_get") return NOTE_GET_RESULT;
      return {};
    });
    setActiveNote();
  });

  afterEach(resetActiveNote);

  it("closed rows show no promote/delete icons — only the open row's header gets them", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await screen.findByTestId("note-date-row-d1");
    expect(screen.queryByTestId("note-date-make-primary-d1")).toBeNull();
    expect(screen.queryByTestId("note-date-remove-d1")).toBeNull();
    expect(screen.queryByTestId("note-date-clear-primary")).toBeNull();

    await user.click(screen.getByTestId("note-date-row-d1"));
    const header = screen.getByTestId("note-date-row-d1");
    const body = screen.getByTestId("note-date-body-d1");
    const promote = screen.getByTestId("note-date-make-primary-d1");
    const remove = screen.getByTestId("note-date-remove-d1");
    // 헤더 안에 있고 본문 안에는 없다.
    expect(header.contains(promote)).toBe(true);
    expect(header.contains(remove)).toBe(true);
    expect(body.contains(promote)).toBe(false);
    expect(body.contains(remove)).toBe(false);
    // 벨 **왼쪽**(= DOM 순서상 앞)에 선다.
    const bell = screen.getByTestId("note-date-remind-d1");
    expect(promote.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remove.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 다른(접힌) 행에는 여전히 없다.
    expect(screen.queryByTestId("note-date-clear-primary")).toBeNull();
  });

  it("clicking a header action icon does not collapse the row (stopPropagation)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    await user.click(screen.getByTestId("note-date-make-primary-d1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_make_primary", { id: "d1" }));
    expect(screen.getByTestId("note-date-row-d1").getAttribute("data-expanded")).toBe("true");
  });

  it("name ×: clears the label with exactly one note_date_update (label: null)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    const input = screen.getByTestId("note-date-label-input-d1") as HTMLInputElement;
    expect(input.value).toBe("체크인");
    // 입력에 포커스가 있는 채로 × 를 누르는 것이 실제 사용 순서다 — blur 커밋이 먼저 새면
    // note_date_update 가 두 번 나간다(ClearButton 의 onMouseDown preventDefault 가 막는 것).
    await user.click(input);
    callMock.mockClear();
    await user.click(screen.getByTestId("note-date-label-clear-d1"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_update", expect.objectContaining({ id: "d1", label: null })),
    );
    expect(callMock.mock.calls.filter((c) => c[0] === "note_date_update")).toHaveLength(1);
    expect(input.value).toBe("");
  });

  it("time ×: clears start and end together in ONE note_date_update (I2 — never end without start)", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect((screen.getByTestId("reminder-start-time") as HTMLInputElement).value).toBe("14:00");
    callMock.mockClear();
    await user.click(screen.getByTestId("reminder-time-clear"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", start_time: null, end_time: null, label: "체크인" }),
      ),
    );
    expect(callMock.mock.calls.filter((c) => c[0] === "note_date_update")).toHaveLength(1);
    expect((screen.getByTestId("reminder-start-time") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("reminder-end-time") as HTMLInputElement).value).toBe("");
  });

  it("× buttons keep their slot but hide when there is nothing to clear", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, RELATED_ROW] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    expect(screen.getByTestId("note-date-label-clear-d1").style.visibility).toBe("hidden");
    expect(screen.getByTestId("reminder-time-clear").style.visibility).toBe("hidden");
  });

  it("the time inputs are wide enough for HH:MM inside a border-box field, and the repeat select is content-width", async () => {
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await user.click(await screen.findByTestId("note-date-row-d1"));
    // 회귀 고정: 맨 "5ch" 는 패딩을 포함한 폭이라 "00:0" 으로 잘렸다.
    const w = screen.getByTestId("reminder-start-time").style.width;
    expect(w).not.toBe("5ch");
    expect(w).toContain("ch");
    expect(w).toContain("calc(");
    // Select 트리거의 기본 폭(설정 화면용 220px)을 이긴다.
    const repeat = screen.getByTestId("reminder-repeat-select");
    expect(repeat.style.width).toBe("auto");
    expect(repeat.style.minWidth).toBe("0px");
  });
});

// PLAN-2026-09-19 owner decision (오너: "대부분 날짜를 10개 미만으로 운영하니, 그 이상일 때만 …
// 넉넉하게 여유를 주자") — SCROLL_AFTER_ROWS=10, LIST_SCROLL_MAX_H=420. Up to 10 rows show fully
// with no height cap/scroll; past that, only the list container scrolls (its own scrollTop, never
// scrollIntoView — see the effect's comment in NoteDatesList.tsx).
describe("NoteDatesList — list scroll threshold", () => {
  // Distinct related rows for volume tests — only `id`/`position` vary; the date fields themselves
  // are irrelevant to what these tests check (data-scrolls/style/data-row-id/scrollTop).
  const relatedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...RELATED_ROW, id: `r${i}`, position: i + 1 }));

  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  let bcrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    bumpMock.mockReset();
    setActiveNote();
    // jsdom has no layout: the real getBoundingClientRect always returns an all-zero rect. Spy so
    // individual tests can stub per-element (by identity) without touching production code.
    bcrSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    // jsdom does not implement Element.scrollIntoView at all — define it so "not called" assertions
    // have something real to check.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    resetActiveNote();
    bcrSpy.mockRestore();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("10 rows (1 primary + 9 related) do not scroll: no data-scrolls, no scroll class, no maxHeight/overflow", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...relatedRows(9)] } : {},
    );
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const list = await screen.findByTestId("note-dates-list");
    await screen.findByTestId("note-date-row-r8");

    expect(list.getAttribute("data-scrolls")).toBe("false");
    expect(list.classList.contains("scroll")).toBe(false);
    expect(list.style.maxHeight).toBe("");
    expect(list.style.overflowY).toBe("");
  });

  it("11 rows (1 primary + 10 related) scroll: data-scrolls=true, scroll class, 420px maxHeight, auto overflow", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...relatedRows(10)] } : {},
    );
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const list = await screen.findByTestId("note-dates-list");
    await screen.findByTestId("note-date-row-r9");

    expect(list.getAttribute("data-scrolls")).toBe("true");
    expect(list.classList.contains("scroll")).toBe(true);
    expect(list.style.maxHeight).toBe("420px");
    expect(list.style.overflowY).toBe("auto");
  });

  it("every rendered row wrapper carries a data-row-id equal to its row id", async () => {
    const rows = relatedRows(10);
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...rows] } : {},
    );
    const { container } = render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    await screen.findByTestId("note-date-row-r9");

    expect(container.querySelector('[data-row-id="p0"]')).toBeTruthy();
    for (const r of rows) {
      expect(container.querySelector(`[data-row-id="${r.id}"]`)).toBeTruthy();
    }
  });

  it("opening a row below the visible area nudges the container's scrollTop by the overflow amount, without scrollIntoView", async () => {
    const rows = relatedRows(10);
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...rows] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const list = await screen.findByTestId("note-dates-list");
    const targetRow = await screen.findByTestId("note-date-row-r9");

    bcrSpy.mockImplementation(function (this: HTMLElement): DOMRect {
      if (this === list) return rect(0, 420);
      if (this.dataset.rowId === "r9") return rect(400, 540);
      return rect(0, 0);
    });

    await user.click(targetRow);

    await waitFor(() => expect(list.scrollTop).toBe(120));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("opening a row above the visible area (already-scrolled container) nudges scrollTop down (decreases)", async () => {
    const rows = relatedRows(10);
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...rows] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const list = await screen.findByTestId("note-dates-list");
    const targetRow = await screen.findByTestId("note-date-row-r0");
    list.scrollTop = 200;

    bcrSpy.mockImplementation(function (this: HTMLElement): DOMRect {
      if (this === list) return rect(0, 420);
      if (this.dataset.rowId === "r0") return rect(-50, 90);
      return rect(0, 0);
    });

    await user.click(targetRow);

    await waitFor(() => expect(list.scrollTop).toBe(150));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("with <= 10 rows, opening a row leaves scrollTop at 0 (no overflow under jsdom's zero-rect layout)", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [PRIMARY_ROW, ...relatedRows(9)] } : {},
    );
    const user = userEvent.setup();
    render(<NoteDatesList noteId="n1" onClearPrimary={() => {}} />);
    const list = await screen.findByTestId("note-dates-list");
    const targetRow = await screen.findByTestId("note-date-row-r8");

    await user.click(targetRow);

    expect(list.scrollTop).toBe(0);
  });
});
