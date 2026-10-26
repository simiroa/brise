import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAxisConfirmFlow, mdLabel } from "./useAxisConfirmFlow";
import type { ConfirmState } from "./useAxisConfirmFlow";
import type { TimedDayPlan } from "../calendarLayout";

const callMock = vi.fn();
const showUndoToastMock = vi.fn();
const commitDateRowMock = vi.fn();
const fetchDateRowMock = vi.fn();
const removeDateRowMock = vi.fn();
const syncAfterDateWriteMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => showUndoToastMock(...args),
}));

vi.mock("../../../i18n/t", () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (params?.day) return `${key}:${params.day}`;
    return key;
  },
}));

vi.mock("./dateWrite", () => ({
  commitDateRow: (...args: unknown[]) => commitDateRowMock(...args),
  fetchDateRow: (...args: unknown[]) => fetchDateRowMock(...args),
  removeDateRow: (...args: unknown[]) => removeDateRowMock(...args),
  syncAfterDateWrite: (...args: unknown[]) => syncAfterDateWriteMock(...args),
}));

describe("useAxisConfirmFlow pure unit tests", () => {
  const setDropPreviewMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("mdLabel", () => {
    it("converts YYYY-MM-DD to MM.DD", () => {
      expect(mdLabel("2026-08-01")).toBe("08.01");
      expect(mdLabel("2026-12-31")).toBe("12.31");
    });
  });

  describe("state transitions & cancellation", () => {
    it("starts with confirm null", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );
      expect(result.current.confirm).toBeNull();
    });

    it("requestSpanDrop sets spanDrop confirm state", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.requestSpanDrop({
          key: "k1",
          noteId: "n1",
          dateId: "d1",
          day: "2026-08-09",
          firstDay: "2026-08-01",
          startMin: 600,
          title: "Trip",
        });
      });

      expect(result.current.confirm).toEqual({
        kind: "spanDrop",
        key: "k1",
        noteId: "n1",
        dateId: "d1",
        day: "2026-08-09",
        firstDay: "2026-08-01",
        startMin: 600,
        title: "Trip",
      });
    });

    it("requestRepeatApply sets repeatApply confirm state", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.requestRepeatApply({
          key: "k1",
          noteId: "n1",
          dateId: "d1",
          day: "2026-08-09",
          draft: { freq: "WEEKLY", interval: "1", byday: ["MO"], until: "" },
        });
      });

      expect(result.current.confirm).toEqual({
        kind: "repeatApply",
        key: "k1",
        noteId: "n1",
        dateId: "d1",
        day: "2026-08-09",
        draft: { freq: "WEEKLY", interval: "1", byday: ["MO"], until: "" },
      });
    });

    it("requestDeleteRepeat sets deleteRepeat confirm state", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.requestDeleteRepeat({
          key: "k1",
          noteId: "n1",
          dateId: "d1",
        });
      });

      expect(result.current.confirm).toEqual({
        kind: "deleteRepeat",
        key: "k1",
        noteId: "n1",
        dateId: "d1",
      });
    });

    it("setConfirm / requestConfirm sets arbitrary state or null", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.setConfirm({
          kind: "deleteRepeat",
          key: "k2",
          noteId: "n2",
          dateId: "d2",
        });
      });
      expect(result.current.confirm?.kind).toBe("deleteRepeat");

      act(() => {
        result.current.requestConfirm(null);
      });
      expect(result.current.confirm).toBeNull();
    });

    it("cancelConfirm resets dropPreview if confirm kind was spanDrop", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.requestSpanDrop({
          key: "k1",
          noteId: "n1",
          dateId: "d1",
          day: "2026-08-09",
          firstDay: "2026-08-01",
          startMin: 600,
          title: "Trip",
        });
      });

      act(() => {
        result.current.cancelConfirm();
      });

      expect(result.current.confirm).toBeNull();
      expect(setDropPreviewMock).toHaveBeenCalledWith(null);
    });

    it("cancelConfirm does not reset dropPreview if confirm kind was not spanDrop", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.requestDeleteRepeat({
          key: "k1",
          noteId: "n1",
          dateId: "d1",
        });
      });

      act(() => {
        result.current.cancel();
      });

      expect(result.current.confirm).toBeNull();
      expect(setDropPreviewMock).not.toHaveBeenCalled();
    });
  });

  describe("resolveSpanDrop", () => {
    const spanState: Extract<ConfirmState, { kind: "spanDrop" }> = {
      kind: "spanDrop",
      key: "k1",
      noteId: "n1",
      dateId: "d1",
      day: "2026-08-09",
      firstDay: "2026-08-01",
      startMin: 600,
      title: "Trip",
    };

    it("choice === 'first' commits date row with startMin and time change label", async () => {
      commitDateRowMock.mockResolvedValueOnce(true);

      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      await act(async () => {
        await result.current.resolveSpanDrop(spanState, "first");
      });

      expect(result.current.confirm).toBeNull();
      expect(setDropPreviewMock).toHaveBeenCalledWith({
        key: "k1",
        title: "Trip",
        startMin: 600,
        saving: true,
      });
      expect(commitDateRowMock).toHaveBeenCalledWith(
        "n1",
        "d1",
        expect.any(Function),
        "home.cal_time_changed",
      );

      // Verify the patch function passed to commitDateRow calls planAllDayDrop
      const patchFn = commitDateRowMock.mock.calls[0][2];
      const dummyRow = {
        id: "d1",
        note_id: "n1",
        year: 2026,
        month: 8,
        day: 1,
        end_year: 2026,
        end_month: 8,
        end_day: 20,
        start_time: null,
        end_time: null,
        remind: false,
        remind_offset_min: null,
        rrule: null,
      };
      const patch = patchFn(dummyRow);
      expect(patch).toMatchObject({
        start_time: "10:00",
      });
    });

    it("choice === 'first' clears dropPreview if commitDateRow returns false", async () => {
      commitDateRowMock.mockResolvedValueOnce(false);

      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      await act(async () => {
        await result.current.resolveSpanDrop(spanState, "first");
      });

      expect(setDropPreviewMock).toHaveBeenLastCalledWith(null);
    });

    it("choice === 'here' calls note_date_add IPC and syncAfterDateWrite", async () => {
      callMock.mockResolvedValueOnce({ id: "d-new" });
      syncAfterDateWriteMock.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      await act(async () => {
        await result.current.resolveSpanDrop(spanState, "here");
      });

      expect(result.current.confirm).toBeNull();
      expect(callMock).toHaveBeenCalledWith(
        "note_date_add",
        expect.objectContaining({
          note_id: "n1",
          year: 2026,
          month: 8,
          day: 9,
          start_time: "10:00",
          end_time: "10:30",
          remind: false,
          remind_offset_min: null,
          rrule: null,
        }),
      );
      expect(syncAfterDateWriteMock).toHaveBeenCalledWith("n1");
      expect(setDropPreviewMock).toHaveBeenLastCalledWith(null);
    });

    it("choice === 'here' clears dropPreview even if call throws", async () => {
      callMock.mockRejectedValueOnce(new Error("IPC failed"));

      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      await act(async () => {
        await result.current.resolveSpanDrop(spanState, "here");
      });

      expect(setDropPreviewMock).toHaveBeenLastCalledWith(null);
    });

    it("choice === 'here' clears dropPreview if date parsing fails", async () => {
      const invalidState = { ...spanState, day: "invalid-day" };

      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "invalid-day",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      await act(async () => {
        await result.current.resolveSpanDrop(invalidState, "here");
      });

      expect(callMock).not.toHaveBeenCalled();
      expect(setDropPreviewMock).toHaveBeenLastCalledWith(null);
    });
  });

  describe("resolveDeleteRepeat", () => {
    it("calls removeDateRow with noteId and dateId and clears confirm", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.resolveDeleteRepeat({
          kind: "deleteRepeat",
          key: "k1",
          noteId: "n1",
          dateId: "d1",
        });
      });

      expect(result.current.confirm).toBeNull();
      expect(removeDateRowMock).toHaveBeenCalledWith("n1", "d1");
    });
  });

  // 오너 실기 2026-09-16 — 반복 없는 행의 Delete/Backspace 도 확인을 거친다. resolveDeleteRepeat
  // 과 같은 길(removeDateRow 한 지점)이고, 갈래(kind)만 다르다.
  describe("resolveDeleteEvent", () => {
    it("calls removeDateRow with noteId and dateId and clears confirm", () => {
      const { result } = renderHook(() =>
        useAxisConfirmFlow({
          selectedDay: "2026-08-09",
          plan: null,
          setDropPreview: setDropPreviewMock,
        }),
      );

      act(() => {
        result.current.resolveDeleteEvent({
          kind: "deleteEvent",
          key: "k1",
          noteId: "n1",
          dateId: "d1",
        });
      });

      expect(result.current.confirm).toBeNull();
      expect(removeDateRowMock).toHaveBeenCalledWith("n1", "d1");
    });
  });

  describe("resolveRepeatApply and post-evaluation effect", () => {
    const repeatState: Extract<ConfirmState, { kind: "repeatApply" }> = {
      kind: "repeatApply",
      key: "k1",
      noteId: "n1",
      dateId: "d1",
      day: "2026-08-09",
      draft: { freq: "WEEKLY", interval: "1", byday: ["TH"], until: "" },
    };

    it("fetches previous rrule, commits new rrule, and displays changed toast when note remains in updated plan", async () => {
      fetchDateRowMock.mockResolvedValueOnce({ rrule: "FREQ=DAILY" });
      commitDateRowMock.mockResolvedValueOnce(true);

      let planState: TimedDayPlan = { timed: [], allDay: [] };
      const { result, rerender } = renderHook(
        ({ plan, day }: { plan: TimedDayPlan; day: string }) =>
          useAxisConfirmFlow({
            selectedDay: day,
            plan,
            setDropPreview: setDropPreviewMock,
          }),
        { initialProps: { plan: planState, day: "2026-08-09" } },
      );

      await act(async () => {
        await result.current.resolveRepeatApply(repeatState);
      });

      expect(result.current.confirm).toBeNull();
      expect(fetchDateRowMock).toHaveBeenCalledWith("n1", "d1");
      expect(commitDateRowMock).toHaveBeenCalledWith("n1", "d1", expect.any(Function));
      expect(showUndoToastMock).not.toHaveBeenCalled();

      // Simulate re-fetch updating plan: note k1 is still present in timed
      const updatedPlan: TimedDayPlan = {
        timed: [
          {
            key: "k1",
            item: {} as any,
            startMin: 600,
            endMin: 660,
            top: 100,
            height: 50,
          },
        ],
        allDay: [],
      };

      rerender({ plan: updatedPlan, day: "2026-08-09" });

      expect(showUndoToastMock).toHaveBeenCalledWith(
        "home.cal_repeat_changed",
        expect.any(Function),
      );

      // Verify the undo revert function reverts rrule
      const undoCallback = showUndoToastMock.mock.calls[0][1];
      undoCallback();
      expect(commitDateRowMock).toHaveBeenLastCalledWith("n1", "d1", expect.any(Function));
      const revertPatchFn = commitDateRowMock.mock.calls[1][2];
      expect(revertPatchFn()).toEqual({ rrule: "FREQ=DAILY" });
    });

    it("displays dropped_today toast when note disappears from updated plan", async () => {
      fetchDateRowMock.mockResolvedValueOnce({ rrule: "FREQ=WEEKLY;BYDAY=MO" });
      commitDateRowMock.mockResolvedValueOnce(true);

      const planBefore: TimedDayPlan = {
        timed: [
          {
            key: "k1",
            item: {} as any,
            startMin: 600,
            endMin: 660,
            top: 100,
            height: 50,
          },
        ],
        allDay: [],
      };

      const { result, rerender } = renderHook(
        ({ plan, day }: { plan: TimedDayPlan; day: string }) =>
          useAxisConfirmFlow({
            selectedDay: day,
            plan,
            setDropPreview: setDropPreviewMock,
          }),
        { initialProps: { plan: planBefore, day: "2026-08-09" } },
      );

      await act(async () => {
        await result.current.resolveRepeatApply(repeatState);
      });

      // Updated plan with empty timed list (note excluded today)
      const emptyPlan: TimedDayPlan = { timed: [], allDay: [] };
      rerender({ plan: emptyPlan, day: "2026-08-09" });

      expect(showUndoToastMock).toHaveBeenCalledWith(
        "home.cal_repeat_dropped_today",
        expect.any(Function),
      );
    });

    it("ignores post-evaluation check if selectedDay changed before plan updated", async () => {
      fetchDateRowMock.mockResolvedValueOnce({ rrule: "FREQ=DAILY" });
      commitDateRowMock.mockResolvedValueOnce(true);

      const planBefore: TimedDayPlan = { timed: [], allDay: [] };
      const { result, rerender } = renderHook(
        ({ plan, day }: { plan: TimedDayPlan; day: string }) =>
          useAxisConfirmFlow({
            selectedDay: day,
            plan,
            setDropPreview: setDropPreviewMock,
          }),
        { initialProps: { plan: planBefore, day: "2026-08-09" } },
      );

      await act(async () => {
        await result.current.resolveRepeatApply(repeatState);
      });

      // User switched to another day (2026-08-10) before plan arrived
      const nextPlan: TimedDayPlan = { timed: [], allDay: [] };
      rerender({ plan: nextPlan, day: "2026-08-10" });

      expect(showUndoToastMock).not.toHaveBeenCalled();
    });
  });
});
