import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NoteDate } from "../../../lib/commands.gen";
import {
  syncAfterDateWrite,
  fetchDateRow,
  commitDateRow,
  shiftRowTimes,
  resizeRowBoundary,
  removeDateRow,
} from "./dateWrite";

const callMock = vi.fn();
const bumpMock = vi.fn();
const undoToastMock = vi.fn();
const reloadActiveMock = vi.fn();
const getStateMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../../lib/noteQuery", () => ({
  bumpNoteQueryVersion: (...args: unknown[]) => bumpMock(...args),
}));

vi.mock("../../../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => undoToastMock(...args),
}));

vi.mock("../../../stores/notes", () => ({
  useNotesStore: {
    getState: () => getStateMock(),
  },
}));

vi.mock("../../../i18n/t", () => ({
  t: (key: string) => `i18n:${key}`,
}));

function makeDateRow(overrides: Partial<NoteDate> = {}): NoteDate {
  return {
    id: "date-123",
    note_id: "note-abc",
    year: 2026,
    month: 9,
    day: 13,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: "09:00",
    end_time: "10:30",
    remind: false,
    remind_offset_min: null,
    rrule: null,
    position: 1,
    created_at: "2026-09-13T00:00:00Z",
    label: null,
    ...overrides,
  };
}

describe("calendar/dateWrite pure unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockReturnValue({
      activeNote: null,
      reloadActive: reloadActiveMock,
    });
  });

  describe("shiftRowTimes", () => {
    it("returns null if row spans multiple days", () => {
      const multiDay = makeDateRow({
        year: 2026,
        month: 9,
        day: 13,
        end_year: 2026,
        end_month: 9,
        end_day: 15,
      });
      expect(shiftRowTimes(multiDay, 30)).toBeNull();
    });

    it("returns null if start_time is missing or invalid", () => {
      const noStart = makeDateRow({ start_time: null });
      expect(shiftRowTimes(noStart, 30)).toBeNull();

      const invalidStart = makeDateRow({ start_time: "invalid" });
      expect(shiftRowTimes(invalidStart, 30)).toBeNull();
    });

    it("returns null if shifted time moves before 00:00", () => {
      const row = makeDateRow({ start_time: "00:15", end_time: "00:45" });
      expect(shiftRowTimes(row, -30)).toBeNull();
    });

    it("returns null if shifted start time is 24:00 or later", () => {
      const row = makeDateRow({ start_time: "23:45", end_time: null });
      expect(shiftRowTimes(row, 30)).toBeNull();
    });

    it("returns null if shifted end time exceeds 24:00 (1440 min)", () => {
      const row = makeDateRow({ start_time: "23:00", end_time: "23:45" });
      // 45 min duration + start 23:30 = 24:15 (> 24:00)
      expect(shiftRowTimes(row, 30)).toBeNull();
    });

    it("shifts forward a timed event with duration", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: "10:30" });
      const result = shiftRowTimes(row, 60);
      expect(result).toEqual({
        start_time: "10:00",
        end_time: "11:30",
      });
    });

    it("shifts backward a timed event with duration", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: "10:30" });
      const result = shiftRowTimes(row, -30);
      expect(result).toEqual({
        start_time: "08:30",
        end_time: "10:00",
      });
    });

    it("preserves end_time unchanged if durationMin is 0", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: null });
      const result = shiftRowTimes(row, 30);
      expect(result).toEqual({
        start_time: "09:30",
        end_time: null,
      });
    });

    it("shifts event touching midnight boundary cleanly", () => {
      const row = makeDateRow({ start_time: "22:30", end_time: "23:30" });
      const result = shiftRowTimes(row, 30);
      // next = 23:00, next + duration = 24:00 clamped to 23:59
      expect(result?.start_time).toBe("23:00");
      expect(result?.end_time).toBe("23:59");
    });
  });

  // 오너 요청(2026-09-16) — 맞닿은 이음새 리사이즈로 딸려 온 이웃의 한쪽 경계만 옮긴다
  // (shiftRowTimes 처럼 길이를 유지한 채 통째로 밀지 않는다).
  describe("resizeRowBoundary", () => {
    it("side start always writes start_time only", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: "10:00" });
      expect(resizeRowBoundary(row, "start", 615)).toEqual({ start_time: "10:15" });
    });

    it("side end writes end_time only, clamped to 23:59 at midnight", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: "10:00" });
      expect(resizeRowBoundary(row, "end", 615)).toEqual({ end_time: "10:15" });
      expect(resizeRowBoundary(row, "end", 24 * 60)).toEqual({ end_time: "23:59" });
    });

    it("side end returns null if the row never had an end_time — never invents one", () => {
      const row = makeDateRow({ start_time: "09:00", end_time: null });
      expect(resizeRowBoundary(row, "end", 615)).toBeNull();
    });

    it("side end returns null for a multi-day span row — its end_time belongs to the last day", () => {
      const row = makeDateRow({
        year: 2026,
        month: 9,
        day: 13,
        end_year: 2026,
        end_month: 9,
        end_day: 15,
        end_time: "10:00",
      });
      expect(resizeRowBoundary(row, "end", 615)).toBeNull();
    });
  });

  describe("syncAfterDateWrite", () => {
    it("reloads active note when noteId matches activeNote.note.id and bumps query version", async () => {
      getStateMock.mockReturnValue({
        activeNote: { note: { id: "note-abc" } },
        reloadActive: reloadActiveMock,
      });

      await syncAfterDateWrite("note-abc");

      expect(reloadActiveMock).toHaveBeenCalledTimes(1);
      expect(bumpMock).toHaveBeenCalledTimes(1);
    });

    it("does not reload active note when noteId differs, but still bumps query version", async () => {
      getStateMock.mockReturnValue({
        activeNote: { note: { id: "other-note" } },
        reloadActive: reloadActiveMock,
      });

      await syncAfterDateWrite("note-abc");

      expect(reloadActiveMock).not.toHaveBeenCalled();
      expect(bumpMock).toHaveBeenCalledTimes(1);
    });

    it("does not reload active note when activeNote is null, but still bumps query version", async () => {
      getStateMock.mockReturnValue({
        activeNote: null,
        reloadActive: reloadActiveMock,
      });

      await syncAfterDateWrite("note-abc");

      expect(reloadActiveMock).not.toHaveBeenCalled();
      expect(bumpMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchDateRow", () => {
    it("returns matching NoteDate when found in note_dates_list", async () => {
      const row1 = makeDateRow({ id: "date-1" });
      const row2 = makeDateRow({ id: "date-2" });
      callMock.mockResolvedValueOnce({ dates: [row1, row2] });

      const result = await fetchDateRow("note-abc", "date-2");

      expect(callMock).toHaveBeenCalledWith("note_dates_list", { note_id: "note-abc" });
      expect(result).toEqual(row2);
    });

    it("returns null when dateId is not in note_dates_list", async () => {
      callMock.mockResolvedValueOnce({ dates: [makeDateRow({ id: "date-1" })] });

      const result = await fetchDateRow("note-abc", "non-existent");
      expect(result).toBeNull();
    });

    it("returns null when IPC call throws", async () => {
      callMock.mockRejectedValueOnce(new Error("IPC failure"));

      const result = await fetchDateRow("note-abc", "date-1");
      expect(result).toBeNull();
    });

    it("returns null when dates list is null/empty", async () => {
      callMock.mockResolvedValueOnce({ dates: [] });

      const result = await fetchDateRow("note-abc", "date-1");
      expect(result).toBeNull();
    });
  });

  describe("commitDateRow", () => {
    it("returns false if fetchDateRow fails to find row", async () => {
      callMock.mockResolvedValueOnce({ dates: [] });

      const success = await commitDateRow("note-abc", "date-missing", () => ({
        start_time: "10:00",
      }));

      expect(success).toBe(false);
      expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
    });

    it("returns false if patch callback returns null", async () => {
      const row = makeDateRow({ id: "date-1" });
      callMock.mockResolvedValueOnce({ dates: [row] });

      const success = await commitDateRow("note-abc", "date-1", () => null);

      expect(success).toBe(false);
      expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
    });

    it("updates row with patched fields and calls syncAfterDateWrite", async () => {
      const row = makeDateRow({ id: "date-1", start_time: "09:00", end_time: "10:00" });
      callMock.mockResolvedValueOnce({ dates: [row] }); // fetchDateRow
      callMock.mockResolvedValueOnce({ ...row, start_time: "11:00", end_time: "12:00" }); // update

      const success = await commitDateRow("note-abc", "date-1", () => ({
        start_time: "11:00",
        end_time: "12:00",
      }));

      expect(success).toBe(true);
      expect(callMock).toHaveBeenCalledWith("note_date_update", {
        id: "date-1",
        year: 2026,
        month: 9,
        day: 13,
        end_year: null,
        end_month: null,
        end_day: null,
        remind: false,
        start_time: "11:00",
        end_time: "12:00",
        remind_offset_min: null,
        rrule: null,
        label: null,
      });
      expect(bumpMock).toHaveBeenCalled();
    });

    it("carries the row's label through the full-replace payload (regression: calendar drag was silently clearing it)", async () => {
      const row = makeDateRow({ id: "date-1", label: "체크인" });
      callMock.mockResolvedValueOnce({ dates: [row] }); // fetchDateRow
      callMock.mockResolvedValueOnce({ ...row, start_time: "11:00" }); // update

      await commitDateRow("note-abc", "date-1", () => ({ start_time: "11:00" }));

      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ label: "체크인" }),
      );
    });

    it("shows undo toast with revert action when undoLabel is provided", async () => {
      const row = makeDateRow({ id: "date-1", start_time: "09:00" });
      callMock.mockResolvedValueOnce({ dates: [row] }); // fetchDateRow
      callMock.mockResolvedValueOnce({ ...row, start_time: "10:00" }); // update

      const success = await commitDateRow(
        "note-abc",
        "date-1",
        () => ({ start_time: "10:00" }),
        "Undo Change",
      );

      expect(success).toBe(true);
      expect(undoToastMock).toHaveBeenCalledTimes(1);
      expect(undoToastMock).toHaveBeenCalledWith("Undo Change", expect.any(Function));

      // Trigger the revert callback
      const revertFn = undoToastMock.mock.calls[0][1];
      callMock.mockResolvedValueOnce({ dates: [{ ...row, start_time: "10:00" }] }); // fetchDateRow for revert
      callMock.mockResolvedValueOnce({ ...row, start_time: "09:00" }); // update for revert

      revertFn();

      // Wait a tick for revert async call
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ start_time: "09:00" }),
      );
    });

    it("calls collectUndo instead of showUndoToast when collectUndo is provided", async () => {
      const row = makeDateRow({ id: "date-1" });
      callMock.mockResolvedValueOnce({ dates: [row] });
      callMock.mockResolvedValueOnce(row);

      const collectUndoMock = vi.fn();
      const success = await commitDateRow(
        "note-abc",
        "date-1",
        () => ({ start_time: "10:00" }),
        "Undo",
        collectUndoMock,
      );

      expect(success).toBe(true);
      expect(collectUndoMock).toHaveBeenCalledTimes(1);
      expect(collectUndoMock).toHaveBeenCalledWith(expect.any(Function));
      expect(undoToastMock).not.toHaveBeenCalled();
    });

    it("returns false if note_date_update IPC throws", async () => {
      const row = makeDateRow({ id: "date-1" });
      callMock.mockResolvedValueOnce({ dates: [row] });
      callMock.mockRejectedValueOnce(new Error("Update failed"));

      const success = await commitDateRow("note-abc", "date-1", () => ({ start_time: "10:00" }));

      expect(success).toBe(false);
    });
  });

  describe("removeDateRow", () => {
    it("returns false if row is not found", async () => {
      callMock.mockResolvedValueOnce({ dates: [] });

      const success = await removeDateRow("note-abc", "date-1");
      expect(success).toBe(false);
    });

    it("clears precision via commitDateRow when row is primary (position === 0)", async () => {
      const primaryRow = makeDateRow({ id: "date-0", position: 0 });
      // 1. removeDateRow -> fetchDateRow
      callMock.mockResolvedValueOnce({ dates: [primaryRow] });
      // 2. commitDateRow -> fetchDateRow
      callMock.mockResolvedValueOnce({ dates: [primaryRow] });
      // 3. commitDateRow -> note_date_update
      callMock.mockResolvedValueOnce(primaryRow);

      const success = await removeDateRow("note-abc", "date-0");

      expect(success).toBe(true);
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({
          id: "date-0",
          month: null,
          day: null,
          end_year: null,
          end_month: null,
          end_day: null,
        }),
      );
      expect(undoToastMock).toHaveBeenCalledWith("i18n:home.cal_date_removed", expect.any(Function));
    });

    it("removes row via note_date_remove and registers undoable note_date_add when position !== 0", async () => {
      const relatedRow = makeDateRow({ id: "date-rel", position: 1, start_time: "14:00" });
      // 1. fetchDateRow
      callMock.mockResolvedValueOnce({ dates: [relatedRow] });
      // 2. note_date_remove
      callMock.mockResolvedValueOnce(true);

      const success = await removeDateRow("note-abc", "date-rel");

      expect(success).toBe(true);
      expect(callMock).toHaveBeenCalledWith("note_date_remove", { id: "date-rel" });
      expect(bumpMock).toHaveBeenCalled();
      expect(undoToastMock).toHaveBeenCalledWith("i18n:home.cal_date_removed", expect.any(Function));

      // Test undo callback
      const undoCb = undoToastMock.mock.calls[0][1];
      callMock.mockResolvedValueOnce({ id: "date-new" }); // note_date_add

      undoCb();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callMock).toHaveBeenCalledWith("note_date_add", {
        note_id: "note-abc",
        year: 2026,
        month: 9,
        day: 13,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "14:00",
        end_time: "10:30",
        remind: false,
        remind_offset_min: null,
        rrule: null,
        label: null,
      });
    });

    it("restores the row's label when undoing a delete (regression: recreate was silently dropping it)", async () => {
      const relatedRow = makeDateRow({ id: "date-rel", position: 1, label: "체크아웃" });
      callMock.mockResolvedValueOnce({ dates: [relatedRow] }); // fetchDateRow
      callMock.mockResolvedValueOnce(true); // note_date_remove

      await removeDateRow("note-abc", "date-rel");
      const undoCb = undoToastMock.mock.calls[0][1];
      callMock.mockResolvedValueOnce({ id: "date-new" }); // note_date_add

      undoCb();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callMock).toHaveBeenCalledWith(
        "note_date_add",
        expect.objectContaining({ label: "체크아웃" }),
      );
    });

    it("returns false if note_date_remove IPC fails", async () => {
      const relatedRow = makeDateRow({ id: "date-rel", position: 1 });
      callMock.mockResolvedValueOnce({ dates: [relatedRow] });
      callMock.mockRejectedValueOnce(new Error("remove failed"));

      const success = await removeDateRow("note-abc", "date-rel");
      expect(success).toBe(false);
    });
  });
});
