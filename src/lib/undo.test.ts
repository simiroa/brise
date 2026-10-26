import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// undo.ts registers flushPendingDeletes with invoke.ts's registerFlush AT MODULE LOAD (an eager
// top-level side effect, unlike the other stores' call()/registerFlush() which only fire inside
// action functions invoked from within a test). Because real ESM evaluates the whole import
// graph before this file's own top-level statements run, a plain `const registerFlushMock =
// vi.fn()` placed above vi.mock() would still be in the temporal dead zone when undo.ts's
// module-load side effect calls it — vi.hoisted() is Vitest's mechanism for state that must be
// ready before any imports evaluate.
const registerFlushMock = vi.hoisted(() => vi.fn());

vi.mock("./invoke", () => ({
  registerFlush: (f: () => Promise<unknown>) => {
    registerFlushMock(f);
    return () => {};
  },
}));

import {
  scheduleUndoableDelete,
  flushPendingDeletes,
  onUndoToast,
  onUndoToastDismiss,
  showUndoToast,
  undoLast,
} from "./undo";

describe("undo.ts — Tier 1 undo-on-delete primitive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers flushPendingDeletes with invoke.ts's registerFlush at module load (window-close flush)", () => {
    expect(registerFlushMock).toHaveBeenCalledWith(flushPendingDeletes);
  });

  it("scheduling then advancing 5s runs commit() and dismisses the toast, without restoring", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const onRestore = vi.fn();
    let toastId: number | null = null;
    const dismissed: number[] = [];
    onUndoToast((t) => {
      toastId = t.id;
    });
    onUndoToastDismiss((id) => dismissed.push(id));

    scheduleUndoableDelete({ commit, onRestore, label: 'Deleted "x"' });

    expect(toastId).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    expect(dismissed).toEqual([toastId]);
  });

  it("undo before 5s does NOT run commit, runs onRestore, and a later timer tick is a no-op", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const onRestore = vi.fn();
    let onUndo: (() => void) | null = null;
    onUndoToast((t) => {
      onUndo = t.onUndo;
    });

    scheduleUndoableDelete({ commit, onRestore, label: 'Deleted "y"' });

    expect(onUndo).not.toBeNull();
    onUndo!();

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();

    // The original 5s timer must not fire a commit after it's been cancelled by undo.
    await vi.advanceTimersByTimeAsync(5000);
    expect(commit).not.toHaveBeenCalled();
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("flushPendingDeletes commits every pending entry immediately, independent of their timers", async () => {
    const commitA = vi.fn().mockResolvedValue(undefined);
    const commitB = vi.fn().mockResolvedValue(undefined);
    scheduleUndoableDelete({ commit: commitA, onRestore: vi.fn(), label: 'Deleted "a"' });
    scheduleUndoableDelete({ commit: commitB, onRestore: vi.fn(), label: 'Deleted "b"' });

    // No time advanced at all — flush must still commit right away.
    await flushPendingDeletes();

    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);

    // Advancing past the original delay afterward must not double-commit (entries are gone).
    await vi.advanceTimersByTimeAsync(5000);
    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);
  });

  it("multiple pending deletes run independently — undoing one leaves the other's timer intact", async () => {
    const commitA = vi.fn().mockResolvedValue(undefined);
    const onRestoreA = vi.fn();
    const commitB = vi.fn().mockResolvedValue(undefined);
    const onRestoreB = vi.fn();
    const undos: Array<() => void> = [];
    onUndoToast((t) => undos.push(t.onUndo));

    scheduleUndoableDelete({ commit: commitA, onRestore: onRestoreA, label: 'Deleted "a"' });
    scheduleUndoableDelete({ commit: commitB, onRestore: onRestoreB, label: 'Deleted "b"' });
    expect(undos).toHaveLength(2);

    undos[0](); // undo only the first
    expect(onRestoreA).toHaveBeenCalledTimes(1);
    expect(onRestoreB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).toHaveBeenCalledTimes(1);
  });

  it("a rejected commit() is swallowed (never throws out of the timer) and still dismisses its toast", async () => {
    const commit = vi.fn().mockRejectedValue(new Error("boom"));
    let toastId: number | null = null;
    const dismissed: number[] = [];
    onUndoToast((t) => {
      toastId = t.id;
    });
    onUndoToastDismiss((id) => dismissed.push(id));

    scheduleUndoableDelete({ commit, onRestore: vi.fn(), label: 'Deleted "z"' });

    // Must not reject/throw even though commit() itself rejects.
    await vi.advanceTimersByTimeAsync(5000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(dismissed).toEqual([toastId]);
  });

  it("calling onUndo twice (e.g. duplicate click) is a no-op the second time", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const onRestore = vi.fn();
    let onUndo: (() => void) | null = null;
    onUndoToast((t) => {
      onUndo = t.onUndo;
    });

    scheduleUndoableDelete({ commit, onRestore, label: 'Deleted "dup"' });
    onUndo!();
    onUndo!();

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  describe("showUndoToast — Tier 2 undo for actions that already committed (e.g. Trash's soft-delete)", () => {
    it("emits an undo toast with the given label and an onUndo wired straight to the callback", () => {
      let toast: { id: number; label: string; onUndo: () => void } | null = null;
      onUndoToast((t) => {
        toast = t;
      });
      const onUndo = vi.fn();

      showUndoToast("Moved to trash", onUndo);

      expect(toast).not.toBeNull();
      expect(toast!.label).toBe("Moved to trash");
      expect(onUndo).not.toHaveBeenCalled();

      toast!.onUndo();
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("registers no pending entry — flushPendingDeletes has nothing to commit and no explicit dismiss fires (Toast.tsx's own 5s ttl auto-dismisses it instead)", async () => {
      const dismissed: number[] = [];
      onUndoToastDismiss((id) => dismissed.push(id));

      showUndoToast("Moved to trash", vi.fn());

      // Nothing was scheduled, so flushing (window close / workspace switch) is a no-op for this
      // toast, and advancing time doesn't trigger a commit or an explicit dismiss either — only
      // Toast.tsx's own local per-toast timer (outside this module) removes it.
      await flushPendingDeletes();
      await vi.advanceTimersByTimeAsync(5000);
      expect(dismissed).toEqual([]);
    });

    it("clicking undo re-invokes the callback every time — no pending-map dedupe applies here (that idempotency is the caller's responsibility)", () => {
      let onUndo: (() => void) | null = null;
      onUndoToast((t) => {
        onUndo = t.onUndo;
      });
      const cb = vi.fn();

      showUndoToast("Moved to trash", cb);
      onUndo!();
      onUndo!();

      expect(cb).toHaveBeenCalledTimes(2);
    });

    // WF F2: opts.delayMs — module-level DELAY_MS (5000) stays the default for every existing
    // caller; only a caller that opts in gets a different Ctrl+Z window.
    it("opts.delayMs extends how long undoLast() stays armed, without touching the module default", () => {
      const onUndo = vi.fn();
      showUndoToast("AI metadata applied", onUndo, { delayMs: 15000 });

      vi.advanceTimersByTime(5001); // past the old 5s default
      expect(undoLast()).toBe(true);
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("opts.delayMs still expires — undoLast() returns false once it elapses", () => {
      const onUndo = vi.fn();
      showUndoToast("AI metadata applied", onUndo, { delayMs: 15000 });

      vi.advanceTimersByTime(15001);
      expect(undoLast()).toBe(false);
      expect(onUndo).not.toHaveBeenCalled();
    });

    it("a caller with no opts keeps the unchanged 5s default", () => {
      const onUndo = vi.fn();
      showUndoToast("Moved to trash", onUndo);

      vi.advanceTimersByTime(5001);
      expect(undoLast()).toBe(false);
      expect(onUndo).not.toHaveBeenCalled();
    });
  });

  // 2026-08-20 오너: "실행취소 가능한 경우 Ctrl+Z 로 되도록". 토스트의 되돌리기 버튼과 같은
  // 동작을 키보드로 노출한다 — 슬롯은 하나, 실행/만료되면 즉시 비운다.
  describe("undoLast — Ctrl+Z 진입점", () => {
    it("runs the most recent undo and reports it handled the key", () => {
      const onUndo = vi.fn();
      showUndoToast("Moved to trash", onUndo);

      expect(undoLast()).toBe(true);
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("returns false with nothing to undo, so the caller passes the key through", () => {
      expect(undoLast()).toBe(false);
    });

    it("never runs the same undo twice", () => {
      const onUndo = vi.fn();
      showUndoToast("Moved to trash", onUndo);

      expect(undoLast()).toBe(true);
      expect(undoLast()).toBe(false);
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("keeps only the latest undoable action", () => {
      const first = vi.fn();
      const second = vi.fn();
      showUndoToast("first", first);
      showUndoToast("second", second);

      expect(undoLast()).toBe(true);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    });

    it("expires with the toast — a committed action cannot be undone later", () => {
      const onUndo = vi.fn();
      showUndoToast("Moved to trash", onUndo);

      vi.advanceTimersByTime(5001);

      expect(undoLast()).toBe(false);
      expect(onUndo).not.toHaveBeenCalled();
    });
  });
});
