// R2-a 분리: stores/notes.ts 의 스냅샷 타이머 사이드카를 그대로 이주 — 스토어 데이터와 결합
// 0(마크/타이머만), stores/notes.ts 는 부수효과 등록을 위해 wireSnapshotScheduler()만 호출한다.
//
// Editor autosave snapshots (owner spec, 2026-08-01): while a materialized note is open, every
// 60s — flush pending edits, then note_snapshot_capture, skipped when nothing changed since the
// last capture. Module-scope (not store state): purely a scheduling side effect, nothing here is
// ever read by a component. snapshotDirty is a simple "has a structural/content mutation run since
// the last capture" flag — cheaper than a content hash and correct for the dominant trigger
// (typing via updateSectionBody). Section rename/add/delete/reorder also call markSnapshotDirty
// from EditorPanel / SectionTabBar after a successful call().
import { callSilent, flushAll } from "./invoke";
import type { useNotesStore } from "../stores/notes";

const SNAPSHOT_INTERVAL_MS = 60_000;
let snapshotDirty = false;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

export function markSnapshotDirty(): void {
  snapshotDirty = true;
}

async function fireSnapshotCapture(noteId: string): Promise<void> {
  try {
    await callSilent("note_snapshot_capture", { note_id: noteId });
  } catch {
    // best-effort local cache — a failed snapshot never blocks editing or shows a toast.
  }
}

function stopSnapshotTimer(): void {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
}

function startSnapshotTimer(noteId: string, getState: typeof useNotesStore.getState): void {
  stopSnapshotTimer();
  snapshotTimer = setInterval(() => {
    // "창이 트레이로 숨겨진 동안은 아님" — 트레이로 숨김/최소화된 네이티브 창은 웹뷰의 Page
    // Visibility API도 hidden으로 본다(네이티브 플랫폼 신호, 별도 Rust 이벤트 불필요).
    if (typeof document !== "undefined" && document.hidden) return;
    void (async () => {
      try {
        // flushAll() 먼저 — EditorPanel의 700ms 본문 디바운스(registerFlush)가 여기 걸려 있어,
        // 캡처 전에 최신 본문이 DB에 실제로 반영되게 한다. 그 다음에야 dirty를 확인/소비한다 —
        // 순서를 바꾸면(캡처 전에 dirty부터 지우면) flushAll()이 되돌린 markSnapshotDirty()
        // 호출을 이번 캡처가 못 먹고 다음 tick으로 영원히 미루게 된다.
        await flushAll();
        if (!snapshotDirty) return;
        const n = getState();
        if (n.activeDraft || n.activeNote?.note.id !== noteId) return;
        snapshotDirty = false;
        await fireSnapshotCapture(noteId);
      } catch {
        // best-effort background tick — a flushAll()/capture failure here must not surface a
        // toast or otherwise interrupt editing.
      }
    })();
  }, SNAPSHOT_INTERVAL_MS);
}

// Snapshot scheduler lifecycle: starts/stops the 60s timer as activeNote opens/closes/switches,
// and fires one capture for whichever note was just left (if dirty) — covers "note가 열린동안만
// 기록" + "close/switch시 한 번 더" from a single chokepoint instead of instrumenting every
// selectNote/newNote/discardDraft call site. flushAll() isn't re-run here: selectNote/newNote
// already `await flushAll()` before this state transition lands, so whatever note is being left
// is already flushed by the time this subscriber observes the switch.
export function wireSnapshotScheduler(store: typeof useNotesStore): void {
  store.subscribe((state, prev) => {
    const curId = state.activeNote && !state.activeDraft ? state.activeNote.note.id : null;
    const prevId = prev.activeNote && !prev.activeDraft ? prev.activeNote.note.id : null;
    if (curId === prevId) return;
    if (prevId && snapshotDirty) void fireSnapshotCapture(prevId);
    snapshotDirty = false;
    stopSnapshotTimer();
    if (curId) startSnapshotTimer(curId, store.getState);
  });
}
