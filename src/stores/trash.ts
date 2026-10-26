import { create } from "zustand";
import { call } from "../lib/invoke";
import type { NoteSummary, SectionTrashEntry } from "../lib/commands.gen";
import { useNotesStore } from "./notes";
import { useArchiveStore } from "./archive";

/**
 * Trash: notes soft-deleted by note_delete (see lib/noteActions.ts::deleteNote — the backend now
 * moves a note to trash instead of hard-deleting it) land here until restored or purged.
 * trashList/trashCount are workspace-scoped: note_trash_list / note_trash_count with no args use
 * the active workspace (mirrors note_related/folder_list).
 *
 * Badge count uses note_trash_count (cheap COUNT + v19 idx_notes_deleted). Full list is only
 * loaded when the Trash modal needs rows. Mutations refresh both so the badge cannot drift
 * from the modal.
 */
interface TrashState {
  trashList: NoteSummary[];
  trashCount: number;
  /** 섹션 휴지통(section_trash 테이블). **배지 숫자**에는 합치지 않는다 — PLAN-2026-09-10 §6
   *  기본값: 사이드바 배지는 노트 수만 세고 섹션은 모달 안 구역으로만 보인다. */
  sectionTrash: SectionTrashEntry[];
  /** 사이드바 휴지통 **행을 띄울지**만 정하는 수(배지 숫자와 별개 — §6 은 숫자 얘기였다).
   *  이게 없으면 섹션만 버리고 노트가 0인 순간 행이 사라져 모달로 갈 길이 없어진다.
   *  ponytail: 전용 count 커맨드 대신 목록 길이를 쓴다 — 휴지통 섹션은 소수라 목록이 곧 수다.
   *  수천 건이 되면 section_trash_count 를 만들어 여기만 갈아끼운다. */
  sectionTrashCount: number;
  loadSectionTrash: () => Promise<void>;
  restoreSection: (id: string) => Promise<void>;
  purgeSection: (id: string) => Promise<void>;
  /** Full list for Trash modal — not needed for the sidebar badge. */
  loadTrash: () => Promise<void>;
  /** Badge-only path — called after first paint, not inside the boot window. */
  loadTrashCount: () => Promise<void>;
  restoreNote: (id: string) => Promise<void>;
  purgeNote: (id: string) => Promise<void>;
  /** No backend "purge all" command exists — purge every currently-listed id, then refresh once. */
  purgeAll: () => Promise<void>;
}

export const useTrashStore = create<TrashState>((set, get) => ({
  trashList: [],
  trashCount: 0,
  sectionTrashCount: 0,
  sectionTrash: [],

  loadSectionTrash: async () => {
    try {
      const list = await call<SectionTrashEntry[]>("section_trash_list", {});
      set({ sectionTrash: list, sectionTrashCount: list.length });
    } catch {
      // Best-effort refresh — leave whatever was already there (loadTrash 와 같은 규칙).
    }
  },

  restoreSection: async (id) => {
    // 목록이 갱신되기 전에 원 노트를 집어둔다.
    const noteId = get().sectionTrash.find((s) => s.id === id)?.note_id;
    try {
      await call("section_restore", { id });
    } catch {
      return; /* call() 이 AppError 토스트를 이미 표출함 */
    }
    await get().loadSectionTrash();
    // 복구한 섹션이 지금 열린 노트의 것이면 탭 스트립이 즉시 옳아야 한다 — 그 노트만 다시 읽는다.
    const notes = useNotesStore.getState();
    if (noteId && notes.activeNote?.note.id === noteId) await notes.selectNote(noteId);
  },

  purgeSection: async (id) => {
    try {
      await call("section_purge", { id });
    } catch {
      return; /* call() 이 AppError 토스트를 이미 표출함 */
    }
    await get().loadSectionTrash();
  },

  loadTrashCount: async () => {
    try {
      const r = await call<{ count: number }>("note_trash_count", {});
      set({ trashCount: r.count });
    } catch {
      // Best-effort (workspace switch race, etc.) — keep prior badge rather than toast.
    }
    // 섹션 쪽은 행 노출 판정에만 쓰이므로 실패해도 조용히 둔다(같은 best-effort).
    try {
      const rows = await call<SectionTrashEntry[]>("section_trash_list", {});
      set({ sectionTrashCount: rows.length });
    } catch {
      /* keep prior */
    }
  },

  loadTrash: async () => {
    try {
      const list = await call<NoteSummary[]>("note_trash_list", {});
      set({ trashList: list, trashCount: list.length });
    } catch {
      // Best-effort refresh — leave whatever was already there.
    }
  },

  restoreNote: async (id) => {
    await call("note_restore", { id });
    // Restored note reappears in the tree — same "backend mutated, re-derive from source" shape
    // as every other tree-affecting action (toggleFavorite, setTags, ...) in stores/notes.ts.
    await useNotesStore.getState().loadTree();
    await get().loadTrash();
    // Bug fix: a note archived BEFORE it was trashed keeps its archived flag while in trash (see
    // ArchiveModal.tsx — deleting an archived note routes through the ordinary trash path), so
    // restoring it lands it back in the archived set, not the plain tree. Without this the sidebar
    // Archive row/count stays stale and the note becomes unreachable until restart.
    void useArchiveStore.getState().loadArchiveCount();
  },

  purgeNote: async (id) => {
    await call("note_purge", { id });
    await get().loadTrash();
    // Same reasoning as restoreNote: the purged note may have been archived before it was
    // trashed, so purging it can shrink the archived set too — keep the sidebar badge in sync.
    void useArchiveStore.getState().loadArchiveCount();
  },

  purgeAll: async () => {
    const ids = get().trashList.map((n) => n.id);
    await Promise.all(ids.map((id) => call("note_purge", { id })));
    await get().loadTrash();
    void useArchiveStore.getState().loadArchiveCount();
  },
}));
