import { create } from "zustand";
import { call } from "../lib/invoke";
import type { NoteSummary } from "../lib/commands.gen";
import { useNotesStore } from "./notes";

/**
 * Archive (W7-f) — "hidden but findable": notes archived via note_archive disappear from the
 * tree/dashboard but stay in FTS, so search_notes still returns them. This is the deliberate
 * distinction from Trash (stores/trash.ts), which removes notes from search too. Modeled directly
 * on trash.ts's shape — badge count via note_archived_count (cheap COUNT + v36 idx_notes_archived),
 * full list only loaded when the Archive modal needs rows.
 *
 * archiveNote/unarchiveNote take a single id but are trivially loop-able over a list — a later
 * wave's multi-select bulk actions call these per-id (same pattern AiBatchOrganizeModal already
 * uses for other single-id commands).
 */
interface ArchiveState {
  archiveList: NoteSummary[];
  archiveCount: number;
  loadArchive: () => Promise<void>;
  loadArchiveCount: () => Promise<void>;
  archiveNote: (id: string) => Promise<void>;
  unarchiveNote: (id: string) => Promise<void>;
}

export const useArchiveStore = create<ArchiveState>((set, get) => ({
  archiveList: [],
  archiveCount: 0,

  loadArchiveCount: async () => {
    try {
      const r = await call<{ count: number }>("note_archived_count", {});
      set({ archiveCount: r.count });
    } catch {
      // Best-effort (workspace switch race, etc.) — keep prior badge rather than toast.
    }
  },

  loadArchive: async () => {
    try {
      const list = await call<NoteSummary[]>("note_archived_list", {});
      set({ archiveList: list, archiveCount: list.length });
    } catch {
      // Best-effort refresh — leave whatever was already there.
    }
  },

  archiveNote: async (id) => {
    await call("note_archive", { id });
    // Archived note disappears from the tree — same "backend mutated, re-derive from source"
    // shape as every other tree-affecting action (toggleFavorite, delete, ...).
    await useNotesStore.getState().loadTree();
    await get().loadArchive();
  },

  unarchiveNote: async (id) => {
    await call("note_unarchive", { id });
    await useNotesStore.getState().loadTree();
    await get().loadArchive();
  },
}));
