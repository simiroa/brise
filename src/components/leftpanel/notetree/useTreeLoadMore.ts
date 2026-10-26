import { useCallback, useRef } from "react";
import type { NoteSummary } from "../../../lib/commands.gen";
import { useNotesStore } from "../../../stores/notes";
import type { DateRangeKey, RegionFilter } from "../../../stores/search";
import { createOffsetTracker, FAVORITES_OFFSET_KEY, type OffsetTracker } from "./windowLoad";
import type { TreeRow } from "./rows";

export interface TreeLoadMoreInput {
  searchActive: boolean;
  selectedTags: string[];
  tagMode: "or" | "and";
  regionFilter: RegionFilter | null;
  statusFilter: string[];
  dateRange: DateRangeKey | null;
  favoritesOpen: boolean;
  favoriteNotes: NoteSummary[];
  favoritesTotal: number;
  setFavoriteNotes: React.Dispatch<React.SetStateAction<NoteSummary[]>>;
  setFavoritesTotal: React.Dispatch<React.SetStateAction<number>>;
  favoritesOffsets: OffsetTracker;
  inboxId: string | null;
}

export function useTreeLoadMore(input: TreeLoadMoreInput) {
  const {
    searchActive,
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
    favoritesOpen,
    favoriteNotes,
    favoritesTotal,
    setFavoriteNotes,
    setFavoritesTotal,
    favoritesOffsets,
    inboxId,
  } = input;

  const folderOffsets = useRef(createOffsetTracker()).current;

  const axesRef = useRef({
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
    searchActive,
    favoritesOpen,
  });
  axesRef.current = {
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
    searchActive,
    favoritesOpen,
  };

  const favoriteNotesRef = useRef(favoriteNotes);
  favoriteNotesRef.current = favoriteNotes;
  const favoritesTotalRef = useRef(favoritesTotal);
  favoritesTotalRef.current = favoritesTotal;

  const loadMoreFolder = useCallback(
    async (folderId: string) => {
      if (axesRef.current.searchActive) return;
      const state = useNotesStore.getState();
      const loaded = state.notesByFolder[folderId]?.length ?? 0;
      const total = state.folderQueryTotals[folderId] ?? 0;
      if (total > 0 && loaded >= total) return;
      const offset = loaded;
      if (!folderOffsets.claim(folderId, offset)) return;
      const {
        selectedTags: tags,
        tagMode: mode,
        regionFilter: region,
        statusFilter: statuses,
        dateRange: range,
      } = axesRef.current;
      try {
        const { noteQuery, TREE_NOTE_WINDOW } = await import("../../../lib/noteQuery");
        const r = await noteQuery({
          folderIds: [folderId],
          selectedTags: tags,
          tagMode: mode,
          regionFilter: region ?? undefined,
          statusFilter: statuses,
          dateRange: range,
          sort: "year_asc",
          offset,
          limit: TREE_NOTE_WINDOW,
        });
        useNotesStore.getState().setFolderQueryTotal(folderId, r.total);
        useNotesStore.getState().appendFolderNotes(folderId, r.notes);
      } catch {
        folderOffsets.release(folderId, offset);
      }
    },
    [folderOffsets]
  );

  const loadMoreFavorites = useCallback(async () => {
    if (axesRef.current.searchActive || !axesRef.current.favoritesOpen) return;
    const loaded = favoriteNotesRef.current.length;
    const total = favoritesTotalRef.current;
    if (total > 0 && loaded >= total) return;
    const offset = loaded;
    if (!favoritesOffsets.claim(FAVORITES_OFFSET_KEY, offset)) return;
    const {
      selectedTags: tags,
      tagMode: mode,
      regionFilter: region,
      statusFilter: statuses,
      dateRange: range,
    } = axesRef.current;
    try {
      const { noteQuery, TREE_FAVORITES_WINDOW } = await import("../../../lib/noteQuery");
      const r = await noteQuery({
        favoritesOnly: true,
        selectedTags: tags,
        tagMode: mode,
        regionFilter: region ?? undefined,
        statusFilter: statuses,
        dateRange: range,
        sort: "year_asc",
        offset,
        limit: TREE_FAVORITES_WINDOW,
      });
      setFavoritesTotal(r.total);
      setFavoriteNotes((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        const extra = r.notes.filter((n) => !seen.has(n.id));
        return extra.length ? [...prev, ...extra] : prev;
      });
    } catch {
      favoritesOffsets.release(FAVORITES_OFFSET_KEY, offset);
    }
  }, [favoritesOffsets, setFavoriteNotes, setFavoritesTotal]);

  const inboxIdRef = useRef(inboxId);
  inboxIdRef.current = inboxId;

  const createOnRowsRendered = useCallback(
    (rowsRef: React.RefObject<TreeRow[]>) =>
      (visible: { startIndex: number; stopIndex: number }) => {
        if (axesRef.current.searchActive) return;
        const currentRows = rowsRef.current;
        if (!currentRows) return;
        const stop = Math.min(visible.stopIndex + 8, currentRows.length - 1);
        let section: { kind: "fav" } | { kind: "folder"; id: string } | null = null;
        for (let i = stop; i >= 0; i--) {
          const row = currentRows[i];
          if (!row) continue;
          if (row.kind === "folder") {
            section = { kind: "folder", id: row.folder.id };
            break;
          }
          if (row.kind === "favorites_hdr") {
            section = { kind: "fav" };
            break;
          }
          if (row.kind === "inbox_hdr" && inboxIdRef.current) {
            section = { kind: "folder", id: inboxIdRef.current };
            break;
          }
          if (row.kind === "divider" || row.kind === "trash") break;
        }
        if (!section) return;
        if (section.kind === "fav") {
          const favLen = favoriteNotesRef.current.length;
          const favTotal = favoritesTotalRef.current;
          if (favLen > 0 && favLen < favTotal) {
            void loadMoreFavorites();
          }
          return;
        }
        const store = useNotesStore.getState();
        const list = store.notesByFolder[section.id] ?? [];
        const loaded = list.length;
        const total = store.folderQueryTotals[section.id] ?? 0;
        if (loaded === 0 || (total > 0 && loaded >= total)) return;
        const lastId = list[list.length - 1]?.id;
        if (!lastId) return;
        let lastRow = -1;
        for (let i = currentRows.length - 1; i >= 0; i--) {
          const r = currentRows[i];
          if (r?.kind === "note" && r.note.id === lastId) {
            lastRow = i;
            break;
          }
        }
        if (lastRow >= 0 && visible.stopIndex + 8 >= lastRow) {
          void loadMoreFolder(section.id);
        }
      },
    [loadMoreFavorites, loadMoreFolder]
  );

  return { loadMoreFolder, loadMoreFavorites, createOnRowsRendered };
}
