// Tier 1 "undo-on-delete": lightweight recoverable deletes without a confirmation modal.
//
// DELAYED COMMIT, not delete-then-recreate: the caller has ALREADY optimistically removed the
// item from its own local state before calling scheduleUndoableDelete(). This module only owns
// the "should the backend call actually happen" decision — it delays the real commit for
// DELAY_MS, and either fires it (timer elapses / a flush happens) or cancels it (user hits Undo,
// which restores the caller's local state via onRestore — the backend is never touched).
//
// Modeled on invoke.ts's onAppNotice/emitNotice channel: onUndoToast/emitUndoToast plus a
// sibling dismiss channel so Toast.tsx can drop a specific toast when its entry resolves.
import { registerFlush } from "./invoke";

const DELAY_MS = 5000;

export interface UndoToast {
  id: number;
  label: string;
  onUndo: () => void;
  /** 토스트가 화면에 남는 시간. 없으면 Toast.tsx 기본(5초). showUndoToast 는 delayMs 를 그대로 넘긴다. */
  ttlMs?: number;
  /** 버튼 문구. 없으면 "되돌리기"(undo.action). 후처리 "제안 보기"처럼 되돌리기가 아닌 행동 토스트용. */
  actionLabel?: string;
  /** 두 번째 버튼 — 내보내기 완료 토스트의 [기본 앱으로 열기] · [폴더 열기] 처럼 행동이 둘일 때. 누르면 토스트가 닫힌다. */
  extraAction?: { label: string; onAction: () => void };
}

interface PendingEntry {
  id: number;
  label: string;
  timer: ReturnType<typeof setTimeout>;
  commit: () => Promise<unknown>;
  onRestore: () => void;
}

const pending = new Map<number, PendingEntry>();
let nextId = 1;

/**
 * 가장 최근에 뜬 되돌리기 하나. 토스트의 Undo 버튼과 **같은 동작**을 Ctrl+Z 로도 쓰게 하는 용도다
 * (2026-08-20 오너). 스택이 아니라 하나만 두는 이유: 토스트 UI 자체가 "마지막 것 하나"를 보여주는
 * 모델이고, 되돌리기 가능한 창(5초)도 짧다. 실행되거나 만료되면 즉시 비운다 — 이미 커밋된 것을
 * Ctrl+Z 가 되살리는 것처럼 보이면 안 된다.
 * ponytail: 단일 슬롯. 여러 단계 되돌리기가 필요해지면 배열로 올린다.
 */
let latestUndo: { id: number; run: () => void } | null = null;

/** Ctrl+Z 진입점. 되돌릴 게 있으면 실행하고 true, 없으면 false(호출자가 기본 동작을 넘긴다). */
export function undoLast(): boolean {
  const entry = latestUndo;
  if (!entry) return false;
  latestUndo = null;
  entry.run();
  return true;
}

const clearLatest = (id: number) => {
  if (latestUndo?.id === id) latestUndo = null;
};

let toastHandler: ((t: UndoToast) => void) | null = null;
let dismissHandler: ((id: number) => void) | null = null;

/** onUndoToast: Toast.tsx subscribes to know when to show an undo toast. */
export const onUndoToast = (fn: (t: UndoToast) => void) => {
  toastHandler = fn;
};

/** onUndoToastDismiss: Toast.tsx subscribes to know when a specific toast (by entry id) should
 * be removed — either its commit fired, or it was undone. */
export const onUndoToastDismiss = (fn: (id: number) => void) => {
  dismissHandler = fn;
};

const emitUndoToast = (t: UndoToast) => {
  if (toastHandler) toastHandler(t);
};

const emitDismiss = (id: number) => {
  clearLatest(id);
  if (dismissHandler) dismissHandler(id);
};

/**
 * scheduleUndoableDelete: register a pending delete. The caller must have already removed the
 * item from its own local state before calling this. Starts a DELAY_MS timer; on elapse, runs
 * commit() (own try/catch — local state is already updated, so a failed commit surfaces via the
 * existing error channel — call()'s built-in toast — but must not throw here). Emits an
 * undo-toast carrying an onUndo that cancels the timer, restores state via onRestore(), and never
 * touches the backend.
 */
export function scheduleUndoableDelete(opts: {
  commit: () => Promise<unknown>;
  onRestore: () => void;
  label: string;
}): void {
  const id = nextId++;

  const finalizeCommit = async () => {
    const entry = pending.get(id);
    if (!entry) return; // already undone or already flushed
    pending.delete(id);
    try {
      await entry.commit();
    } catch {
      // Local state is already updated optimistically — call() already emitted its own error
      // toast via the existing error channel. Swallow here so a rejected commit can't crash an
      // unrelated timer callback.
    }
    emitDismiss(id);
  };

  const timer = setTimeout(() => {
    void finalizeCommit();
  }, DELAY_MS);

  const onUndo = () => {
    const entry = pending.get(id);
    if (!entry) return; // already committed (race with the timer) — nothing to undo
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.onRestore();
    emitDismiss(id);
  };

  pending.set(id, { id, label: opts.label, timer, commit: opts.commit, onRestore: opts.onRestore });
  latestUndo = { id, run: onUndo };
  emitUndoToast({ id, label: opts.label, onUndo });
}

/**
 * showUndoToast: Tier 2 undo — for actions that have ALREADY landed on the backend (e.g. Trash's
 * soft-delete: note_delete now moves a note to trash immediately instead of the Tier 1 "hide
 * locally, delay the real call" dance above). There is no delayed commit to cancel here — this
 * just emits the same undo-toast UI (onUndoToast/onUndoToastDismiss channel, Toast.tsx's existing
 * 5s auto-dismiss fallback) with onUndo wired straight to the caller's own restore callback (e.g.
 * note_restore + a tree/active-note refresh). No pending-map entry is created, so
 * flushPendingDeletes()/workspace-switch flushing has nothing to do with this toast — once it's
 * gone (dismissed or timed out), the only way back is the caller's own Trash UI.
 */
export function showUndoToast(label: string, onUndo: () => void, opts?: { delayMs?: number }): void {
  const id = nextId++;
  const delayMs = opts?.delayMs ?? DELAY_MS;
  // Tier 2 는 pending 항목이 없어 자동 만료 통보가 없다 — 토스트의 수명과 맞춰 슬롯을 비운다.
  latestUndo = { id, run: () => { clearLatest(id); onUndo(); } };
  setTimeout(() => clearLatest(id), delayMs);
  emitUndoToast({ id, label, onUndo, ttlMs: delayMs });
}

/**
 * showToastOnly: 토스트 알림 UI만 띄우고 latestUndo(전역 Ctrl+Z 단일 슬롯)는 점유하지 않는 변형.
 * 자체 다단 실행취소 스택이 독립적으로 Ctrl+Z 를 소유하는 곳(예: 과거 캔버스 플러그인)에서,
 * 토스트의 "되돌리기" 버튼은 동작하게 하되 전역 Ctrl+Z 와의 이중 실행(P0 충돌)을 구조적으로
 * 방지한다 (2026-08-24 지시서 §A 안 ①).
 */
export function showToastOnly(
  label: string,
  onUndo: () => void,
  opts?: { ttlMs?: number; actionLabel?: string; extraAction?: { label: string; onAction: () => void } },
): void {
  const id = nextId++;
  emitUndoToast({ id, label, onUndo, ttlMs: opts?.ttlMs, actionLabel: opts?.actionLabel, extraAction: opts?.extraAction });
}

/**
 * flushPendingDeletes: commit every pending delete immediately (clearing its timer first).
 * Registered with invoke.ts's registerFlush so window-close (onCloseRequested → flushAll) commits
 * everything pending — a user who closes within the undo window "keeps" the item, but must not be
 * left with a silently un-deleted item on the next launch. Also exported directly so the
 * workspace-switch path can call it (pending deletes belong to the workspace being left).
 */
export async function flushPendingDeletes(): Promise<void> {
  const entries = [...pending.values()];
  pending.clear();
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.timer);
      try {
        await entry.commit();
      } catch {
        // see finalizeCommit — surfaced via call()'s own error toast already.
      }
      emitDismiss(entry.id);
    }),
  );
}

registerFlush(flushPendingDeletes);
