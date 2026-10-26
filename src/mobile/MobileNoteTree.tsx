import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotesStore } from "../stores/notes";
import { useSearchStore, isSearchModeActive } from "../stores/search";
import { useWorkspacesStore } from "../stores/workspaces";
import { useSelectionStore } from "../stores/selection";
import { useTrashStore } from "../stores/trash";
import { useArchiveStore } from "../stores/archive";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability } from "../stores/ai";
import { call, callSilent } from "../lib/invoke";
import type { Folder, NoteSummary } from "../lib/commands.gen";
import { flattenRows, rowNoteIds, type TreeRow } from "../components/leftpanel/notetree/rows";
import { createMatchesTagRegion } from "../components/leftpanel/notetree/filtering";
import { useFavoritesWindow } from "../components/leftpanel/notetree/useFavoritesWindow";
import { useFolderWindows } from "../components/leftpanel/notetree/useFolderWindows";
import { useTreeLoadMore } from "../components/leftpanel/notetree/useTreeLoadMore";
import { useNoteQueryVersion } from "../lib/noteQuery";
import { t } from "../i18n/t";
import { useBackClosable } from "./useBackClosable";
import { MobileTreeRow } from "./MobileTreeRow";
import { MobileActionSheet } from "./MobileActionSheet";
import { MobileBulkSelection } from "./MobileBulkSelection";
import { MobileFolderNameModal } from "./MobileFolderNameModal";
import { MobileTrashArchiveOverlay } from "./MobileTrashArchiveOverlay";
import { MobileTreeFab } from "./MobileTreeFab";
import { MobileFolderAiSheet } from "./MobileFolderAiSheet";

interface MobileNoteTreeProps {
  onOpenNote: (id: string) => void;
  /** 노트 탭 ＋ → 노트 추가: 입력 화면을 새 초안으로 연다(MobileApp::enterCapture). 없으면 ＋ 를 그리지 않는다. */
  onNewNote?: () => void;
}

/**
 * Filter tab's "tree" mode — the mobile mirror of leftpanel/notetree/index.tsx. Reuses that
 * file's own data hooks verbatim (useFavoritesWindow/useFolderWindows/useTreeLoadMore, all
 * headless) and its flattenRows() pure module, so the row set, window sizes (TREE_NOTE_WINDOW=80)
 * and pagination lookahead (8 rows) are identical to desktop — only the presentation (MobileTreeRow
 * instead of react-window + TreeListRow) differs. Mutations go through the same gateways desktop
 * uses (lib/noteActions.ts, stores/archive.ts, stores/trash.ts) — their loadTree() tail now judges
 * isBrowser()&&isMobileViewport() itself and skips the folder_list roundtrip on mobile
 * (stores/notesTree.ts), so there is no mobile-only copy of those mutation helpers.
 *
 * ponytail: no virtualization. A resident window is TREE_NOTE_WINDOW=80 rows; at ~52px/row that's
 * ~4200px of DOM, inside budget for a single open section. Ceiling: several sections open at once
 * with each near its window cap could push past a comfortable scroll budget on very large
 * notebooks. Upgrade path: `react-window` (already a dependency, desktop's notetree/index.tsx
 * already uses it) — swap the plain .map() below for a `List` the same way that file does.
 *
 * ponytail: no "draft" row. Desktop's flattenRows can render one for the folder currently receiving
 * a fresh, not-yet-saved note (draftFolderId) — mobile's "새 노트" entry point is the bottom tab bar
 * (`입력`), which opens MobileNote full-screen, not inline next to this tree. There's no tree
 * position for an in-progress draft to occupy, so this component always passes draftFolderId: null.
 */
export function MobileNoteTree({ onOpenNote, onNewNote }: MobileNoteTreeProps) {
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const notesByFolder = useNotesStore((s) => s.notesByFolder);

  // ---- folders + inboxId bootstrap ----
  // Deliberately `folder_list_meta` (folders + counts only), never `folder_list`/loadTree() — the
  // mobile performance contract (specs/features/mobile.yaml F-MO02, MobileNoteTree.test.tsx pins it).
  // Lands in the shared useNotesStore slice so flattenRows/the reused hooks below need no adaptation
  // (mobile and desktop never mount in the same document, so sharing the slice is safe).
  const loadFolders = useCallback(async () => {
    try {
      const [meta, settingsRes] = await Promise.all([
        callSilent<{ folders: Folder[] }>("folder_list_meta"),
        workspaceId
          ? callSilent<{ settings: Record<string, unknown> }>("settings_get_all").catch(() => null)
          : Promise.resolve(null),
      ]);
      const metaFolders = meta.folders ?? [];
      let nextInboxId: string | null = null;
      if (workspaceId && settingsRes) {
        const persisted = settingsRes.settings[`inbox_${workspaceId}`] as string | undefined;
        if (persisted && metaFolders.some((f) => f.id === persisted)) nextInboxId = persisted;
      }
      useNotesStore.setState({ folders: metaFolders, inboxId: nextInboxId, isBooting: false });
    } catch {
      useNotesStore.setState({ isBooting: false });
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    void useTrashStore.getState().loadTrashCount();
    void useArchiveStore.getState().loadArchiveCount();
  }, [workspaceId]);

  // ---- search mode (mirrors leftpanel/notetree/index.tsx exactly) ----
  const query = useSearchStore((s) => s.query);
  const searching = useSearchStore((s) => s.searching);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const searchResults = useSearchStore((s) => s.searchResults);
  const searchActive = isSearchModeActive({ query, yearFrom, yearTo, yearBounds });
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);

  const matchesTagRegion = useMemo(
    () => createMatchesTagRegion({ selectedTags, tagMode, regionFilter, statusFilter, dateRange }),
    [selectedTags, tagMode, regionFilter, statusFilter, dateRange],
  );
  const filteredSearchResults = useMemo(
    () => searchResults.filter(matchesTagRegion),
    [searchResults, matchesTagRegion],
  );
  const tagRegionFilterActive =
    selectedTags.length > 0 || regionFilter !== null || statusFilter.length > 0 || dateRange !== null;

  // ---- windowed data (reused verbatim) ----
  // filterAxesKey folds in useNoteQueryVersion() (CLAUDE.md 함정 4 — the one axis every mutation
  // must bump) so a rename/move/favorite/archive/delete anywhere re-triggers these hooks' bounded
  // refetch of the currently-open folders/favorites, exactly like a screen remount would — without
  // ever calling loadTree()/folder_list. The mutation gateways (lib/noteActions.ts, the archive/trash
  // stores) reach the SAME bumpNoteQueryVersion() axis, so this is one invalidation mechanism.
  const queryVersion = useNoteQueryVersion();
  const filterAxesKey = useMemo(
    () => JSON.stringify({ tags: selectedTags, tagMode, region: regionFilter, statuses: statusFilter, dateRange, v: queryVersion }),
    [selectedTags, tagMode, regionFilter, statusFilter, dateRange, queryVersion],
  );

  // Pending indicator intentionally unused here (v1 scope) — return value ignored.
  useFolderWindows({
    searchActive,
    openFolderKey: useMemo(
      () => folders.filter((f) => f.is_open || f.id === inboxId).map((f) => f.id).sort().join(","),
      [folders, inboxId],
    ),
    filterAxesKey,
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
  });

  const {
    favoriteNotes,
    favoritesTotal,
    favoritesOpen,
    setFavoriteNotes,
    setFavoritesTotal,
    toggleFavorites,
    favoritesOffsets,
  } = useFavoritesWindow({ searchActive, filterAxesKey, selectedTags, tagMode, regionFilter, statusFilter, dateRange });

  const trashCount = useTrashStore((s) => s.trashCount);
  const archiveCount = useArchiveStore((s) => s.archiveCount);

  const { createOnRowsRendered } = useTreeLoadMore({
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
  });

  const filteredByFolder = useMemo(() => {
    const m: Record<string, NoteSummary[]> = {};
    for (const f of folders) m[f.id] = notesByFolder[f.id] ?? [];
    return m;
  }, [folders, notesByFolder]);
  const treeFolders = useMemo(() => (inboxId ? folders.filter((f) => f.id !== inboxId) : folders), [folders, inboxId]);
  const inboxNotes = useMemo(() => (inboxId ? (filteredByFolder[inboxId] ?? []) : []), [inboxId, filteredByFolder]);
  const visibleTreeCount = useMemo(() => {
    const inFolders = treeFolders.reduce((acc, f) => acc + (filteredByFolder[f.id]?.length ?? 0), 0);
    return inFolders + favoriteNotes.length + inboxNotes.length;
  }, [treeFolders, filteredByFolder, favoriteNotes, inboxNotes]);

  const [inboxOpen, setInboxOpen] = useState(true);
  const isBooting = useNotesStore((s) => s.isBooting);

  const rows: TreeRow[] = useMemo(
    () =>
      flattenRows({
        searchActive,
        filteredSearchResults,
        favoritesOpen,
        favoriteNotes,
        trashCount,
        // 0 고정: 모바일 휴지통 오버레이는 노트만 보여준다(MobileTrashArchiveOverlay). 섹션 때문에
        // 행을 띄우면 눌렀을 때 빈 목록이라 화면이 거짓말한다. 모바일은 이 계획의 범위 밖(§5).
        sectionTrashCount: 0,
        archiveCount,
        folders: treeFolders,
        filteredByFolder,
        tagRegionFilterActive,
        visibleTreeCount,
        inboxId,
        inboxOpen,
        inboxNotes,
        draftFolderId: null,
        isBooting,
        searching,
        keywordActive: query.trim() !== "",
      }),
    [
      searchActive, filteredSearchResults, favoritesOpen, favoriteNotes, trashCount, archiveCount,
      treeFolders, filteredByFolder, tagRegionFilterActive, visibleTreeCount, inboxId, inboxOpen,
      inboxNotes, isBooting, searching, query,
    ],
  );

  const folderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  // ---- pagination on scroll (no react-window here — see header ponytail) ----
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onRowsRendered = useMemo(() => createOnRowsRendered(rowsRef), [createOnRowsRendered]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      onRowsRendered({ startIndex: 0, stopIndex: rowsRef.current.length - 1 });
    }
  }, [onRowsRendered]);

  // ---- folder open/close (same command as desktop's toggleFolder) ----
  const onToggleFolder = useCallback(async (f: Folder) => {
    const next = !f.is_open;
    await call("folder_set_open", { id: f.id, is_open: next });
    useNotesStore.getState().patchFolder(f.id, { is_open: next });
  }, []);

  // ---- multi-select ----
  const selectedNoteIds = useSelectionStore((s) => s.notes.ids);
  const toggleNote = useSelectionStore((s) => s.toggleNote);
  const pruneNotes = useSelectionStore((s) => s.pruneNotes);
  const clearNotes = useSelectionStore((s) => s.clearNotes);
  const keepNotes = useSelectionStore((s) => s.keepNotes);
  const orderedNoteIds = useMemo(() => rowNoteIds(rows), [rows]);
  useEffect(() => {
    pruneNotes(orderedNoteIds);
  }, [orderedNoteIds, pruneNotes]);
  const selectedIdSet = useMemo(() => new Set(selectedNoteIds), [selectedNoteIds]);
  const selectionActive = selectedNoteIds.length > 0;
  // Android back leaves selection mode first (pushed before any dialog/overlay opened over it, so
  // those still close top-first).
  useBackClosable(selectionActive, clearNotes);
  // ＋ (MobileTreeFab) hides in selection mode — the bottom edge belongs to the selection bar then.
  const showFab = !!onNewNote && !selectionActive;
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const folderAiAvailability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const folderAiReady = folderAiAvailability === "ready";

  // ---- action sheet ----
  const [actionSheetNote, setActionSheetNote] = useState<NoteSummary | null>(null);

  // ---- trash / archive overlay ----
  const [overlay, setOverlay] = useState<"trash" | "archive" | null>(null);

  // ---- new folder (＋ → 폴더 추가, and the tree's own add-folder row) ----
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderDraft, setNewFolderDraft] = useState(t("tree.new_folder_default"));
  const openNewFolder = () => {
    setNewFolderDraft(t("tree.new_folder_default"));
    setNewFolderOpen(true);
  };

  // ---- ＋ → AI (folder management sheet) ----
  const [folderAiOpen, setFolderAiOpen] = useState(false);
  const submitNewFolder = async () => {
    const name = newFolderDraft.trim();
    if (!name) return;
    try {
      await call("folder_create", { name });
      setNewFolderOpen(false);
      await loadFolders();
    } catch {
      // call() already toasted; leave the dialog open to retry.
    }
  };

  // ---- folder rename (long-press a folder row) — same commit path as desktop's inline rename
  // (leftpanel/notetree/index.tsx: folder_rename + reload). On failure call() has toasted and the
  // tree still shows the old name, so there is nothing to roll back; the dialog stays open to retry.
  const [renameFolder, setRenameFolder] = useState<{ id: string; draft: string } | null>(null);
  const submitRenameFolder = async () => {
    if (!renameFolder) return;
    const name = renameFolder.draft.trim();
    if (!name) return;
    try {
      await call("folder_rename", { id: renameFolder.id, name });
      setRenameFolder(null);
      await loadFolders();
    } catch {
      // call() already toasted; leave the dialog open to retry.
    }
  };

  return (
    <>
      {/* 새 폴더 버튼은 오른쪽 아래 ＋(MobileTreeFab → 폴더 추가)로 옮겼다(오너 2026-10-10). */}
      <div className="mobile-tree-hdr">
        <span className="mobile-tree-hdr-title label-caps">{t("tree.note_tree")}</span>
      </div>

      <div
        className="mobile-list mobile-tree scroll"
        ref={scrollRef}
        onScroll={onScroll}
        data-fab={showFab ? "true" : undefined}
      >
        {rows.map((row, i) => (
          <MobileTreeRow
            key={rowKey(row, i)}
            row={row}
            searchQuery={query}
            favoriteCount={favoriteNotes.length}
            favoritesOpen={favoritesOpen}
            inboxCount={inboxNotes.length}
            inboxOpen={inboxOpen}
            selectionActive={selectionActive}
            selected={row.kind === "note" ? selectedIdSet.has(row.note.id) : false}
            folderNameById={folderNameById}
            onToggleFavorites={toggleFavorites}
            onToggleInbox={() => setInboxOpen((v) => !v)}
            onToggleFolder={(f) => void onToggleFolder(f)}
            onOpenTrash={() => setOverlay("trash")}
            onOpenArchive={() => setOverlay("archive")}
            onOpenNote={onOpenNote}
            onToggleSelect={toggleNote}
            onLongPressNote={setActionSheetNote}
            onLongPressFolder={(f) => setRenameFolder({ id: f.id, draft: f.name })}
            onAddFolder={openNewFolder}
          />
        ))}
      </div>

      {showFab && onNewNote && (
        <MobileTreeFab
          aiReady={folderAiReady}
          onAddFolder={openNewFolder}
          onNewNote={onNewNote}
          onOpenAi={() => setFolderAiOpen(true)}
        />
      )}

      {folderAiOpen && (
        <MobileFolderAiSheet
          inboxId={inboxId}
          folders={folders}
          aiReady={folderAiReady}
          onClose={() => {
            setFolderAiOpen(false);
            // the batch may have moved notes out of the Inbox / a folder — refresh the counts (folder_list_meta, F-MO02)
            void loadFolders();
          }}
        />
      )}

      <MobileBulkSelection
        selectedNoteIds={selectedNoteIds}
        moveTargets={treeFolders}
        onClear={clearNotes}
        onKeepSelected={keepNotes}
      />

      {actionSheetNote && (
        <MobileActionSheet
          note={actionSheetNote}
          pickableFolders={treeFolders}
          onClose={() => setActionSheetNote(null)}
          onMutated={() => setActionSheetNote(null)}
        />
      )}

      {newFolderOpen && (
        <MobileFolderNameModal
          title={t("tree.new_folder_title")}
          submitLabel={t("tree.new_folder_submit")}
          value={newFolderDraft}
          onChange={setNewFolderDraft}
          onSubmit={() => void submitNewFolder()}
          onClose={() => setNewFolderOpen(false)}
        />
      )}

      {renameFolder && (
        <MobileFolderNameModal
          title={t("ctx.rename")}
          submitLabel={t("common.apply")}
          value={renameFolder.draft}
          onChange={(draft) => setRenameFolder({ ...renameFolder, draft })}
          onSubmit={() => void submitRenameFolder()}
          onClose={() => setRenameFolder(null)}
          inputTestId="mobile-folder-rename-input"
          submitTestId="mobile-folder-rename-submit"
        />
      )}

      {overlay && <MobileTrashArchiveOverlay kind={overlay} onClose={() => setOverlay(null)} />}
    </>
  );
}

function rowKey(row: TreeRow, index: number): string {
  if (row.kind === "note") return `note-${row.note.id}-${row.indented ? "t" : "s"}`;
  if (row.kind === "folder") return `folder-${row.folder.id}`;
  if (row.kind === "skeleton") return `skeleton-${row.index}`;
  return `${row.kind}-${index}`;
}
