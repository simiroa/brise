import type { NoteSummary } from "../lib/commands.gen";

export type WindowCacheState = {
  notesByFolder: Record<string, NoteSummary[]>;
  noteIndex: Map<string, NoteSummary>;
  folderQueryTotals: Record<string, number>;
};

export function mergeNoteSummariesInState(
  s: WindowCacheState,
  notes: NoteSummary[]
): Partial<WindowCacheState> | undefined {
  if (notes.length === 0) return undefined;
  const nextFolder: Record<string, NoteSummary[]> = { ...s.notesByFolder };
  const noteIndex = new Map(s.noteIndex);
  for (const n of notes) {
    noteIndex.set(n.id, n);
    const list = nextFolder[n.folder_id] ?? [];
    const idx = list.findIndex((x) => x.id === n.id);
    if (idx >= 0) {
      const copy = list.slice();
      copy[idx] = n;
      nextFolder[n.folder_id] = copy;
    } else {
      nextFolder[n.folder_id] = [...list, n];
    }
  }
  return { notesByFolder: nextFolder, noteIndex };
}

export function setFolderNotesInState(
  s: WindowCacheState,
  folderId: string,
  notes: NoteSummary[]
): Partial<WindowCacheState> {
  const nextFolder = { ...s.notesByFolder, [folderId]: notes };
  const noteIndex = new Map(s.noteIndex);
  for (const old of s.notesByFolder[folderId] ?? []) {
    const cur = noteIndex.get(old.id);
    if (cur && cur.folder_id === folderId) noteIndex.delete(old.id);
  }
  for (const n of notes) noteIndex.set(n.id, n);
  return { notesByFolder: nextFolder, noteIndex };
}

export function appendFolderNotesInState(
  s: WindowCacheState,
  folderId: string,
  notes: NoteSummary[]
): Partial<WindowCacheState> | undefined {
  if (notes.length === 0) return undefined;
  const prev = s.notesByFolder[folderId] ?? [];
  const seen = new Set(prev.map((n) => n.id));
  const merged = [...prev];
  const noteIndex = new Map(s.noteIndex);
  for (const n of notes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    merged.push(n);
    noteIndex.set(n.id, n);
  }
  return {
    notesByFolder: { ...s.notesByFolder, [folderId]: merged },
    noteIndex,
  };
}
