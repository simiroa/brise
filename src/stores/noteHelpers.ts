import type { NoteSummary } from "../lib/commands.gen";

/** Scale quick-win: derive the noteIndex/totalNotes accelerators from notesByFolder in one pass. */
export function buildNoteIndex(notesByFolder: Record<string, NoteSummary[]>): {
  totalNotes: number;
  noteIndex: Map<string, NoteSummary>;
} {
  const noteIndex = new Map<string, NoteSummary>();
  let totalNotes = 0;
  for (const notes of Object.values(notesByFolder)) {
    for (const n of notes) {
      noteIndex.set(n.id, n);
      totalNotes++;
    }
  }
  return { totalNotes, noteIndex };
}

/** Patch one note in notesByFolder + noteIndex (Phase 1 partial update — avoid full loadTree). */
export function patchNoteInMaps(
  notesByFolder: Record<string, NoteSummary[]>,
  noteIndex: Map<string, NoteSummary>,
  id: string,
  patch: Partial<NoteSummary>
): { notesByFolder: Record<string, NoteSummary[]>; noteIndex: Map<string, NoteSummary> } | null {
  const existing = noteIndex.get(id);
  if (!existing) return null;
  const updated: NoteSummary = { ...existing, ...patch };
  const newIndex = new Map(noteIndex);
  newIndex.set(id, updated);

  const oldFolder = existing.folder_id;
  const newFolder = updated.folder_id;
  const next: Record<string, NoteSummary[]> = { ...notesByFolder };

  if (oldFolder === newFolder) {
    const list = next[oldFolder] ?? [];
    next[oldFolder] = list.map((n) => (n.id === id ? updated : n));
  } else {
    next[oldFolder] = (next[oldFolder] ?? []).filter((n) => n.id !== id);
    next[newFolder] = [...(next[newFolder] ?? []), updated];
  }
  return { notesByFolder: next, noteIndex: newIndex };
}

/** Remove one note from notesByFolder + noteIndex (Phase 1 partial update — avoid full loadTree). */
export function removeNoteFromMaps(
  notesByFolder: Record<string, NoteSummary[]>,
  noteIndex: Map<string, NoteSummary>,
  id: string
): { notesByFolder: Record<string, NoteSummary[]>; noteIndex: Map<string, NoteSummary>; folderId: string } | null {
  const existing = noteIndex.get(id);
  if (!existing) return null;
  const newIndex = new Map(noteIndex);
  newIndex.delete(id);
  const next: Record<string, NoteSummary[]> = { ...notesByFolder };
  next[existing.folder_id] = (next[existing.folder_id] ?? []).filter((n) => n.id !== id);
  return { notesByFolder: next, noteIndex: newIndex, folderId: existing.folder_id };
}
