import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, type ListImperativeAPI } from "react-window";
import { useNotesStore } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { useUiStore } from "../../../stores/ui";
import { useTrashStore } from "../../../stores/trash";
import { useArchiveStore } from "../../../stores/archive";
import { useSelectionStore } from "../../../stores/selection";
import { useSettingsStore } from "../../../stores/settings";
import { call } from "../../../lib/invoke";
import { renameNote } from "../../../lib/noteActions";
import type { Folder, NoteSummary } from "../../../lib/commands.gen";
import { collectSearchMatches } from "../../../lib/searchMatch";
import { IconFolderPlus } from "../../icons";
import { t } from "../../../i18n/t";
import { NewFolderDialog } from "../NewFolderDialog";
import { createMatchesTagRegion } from "./filtering";
import { flattenRows, rowNoteIds, rowHeightOf, type TreeRow } from "./rows";
import { NoteSelectionBar } from "./NoteSelectionBar";
import { TreeListRow, type ListRowProps } from "./TreeListRow";
import { registerNoteDropHandler } from "../../../lib/noteDrag";

import { usePendingDelay } from "../../../lib/usePendingDelay";
import { PendingIndicator } from "../../common/PendingIndicator";
import { Pill } from "../../common/Pill";

import { useFolderWindows } from "./useFolderWindows";
import { useFavoritesWindow } from "./useFavoritesWindow";
import { useTreeLoadMore } from "./useTreeLoadMore";
import { TreeHeaderActions } from "./TreeHeaderActions";
import { BackupNudgeBanner } from "./BackupNudgeBanner";

/* ── Note tree ── */
export function NoteTree() {
  const isBooting = useNotesStore((s) => s.isBooting);
  const folders = useNotesStore((s) => s.folders);
  const notesByFolder = useNotesStore((s) => s.notesByFolder);
  const inboxId = useNotesStore((s) => s.inboxId);
  const newNote = useNotesStore((s) => s.newNote);
  const searchResults = useSearchStore((s) => s.searchResults);
  const query = useSearchStore((s) => s.query);
  const searching = useSearchStore((s) => s.searching);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);

  const activeId = useNotesStore((s) => s.activeNote?.note.id ?? null);
  const draftFolderId = useNotesStore((s) =>
    s.activeDraft ? s.activeNote?.note.folder_id ?? null : null
  );
  const selectNote = useNotesStore((s) => s.selectNote);
  const loadTree = useNotesStore((s) => s.loadTree);
  const openCtx = useUiStore((s) => s.openCtx);
  const openTrash = useUiStore((s) => s.openTrash);
  const trashCount = useTrashStore((s) => s.trashCount);
  // 배지 숫자가 아니라 휴지통 **행 노출**에만 쓰인다 — 섹션만 버린 상태에서 행이 사라지면
  // 모달로 갈 길이 없어진다(stores/trash.ts 주석).
  const sectionTrashCount = useTrashStore((s) => s.sectionTrashCount);
  const openArchive = useUiStore((s) => s.openArchive);
  const archiveCount = useArchiveStore((s) => s.archiveCount);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  // Inline rename (double-click / F2 on a tree row) — replaces the old context-menu "Rename"
  // item, reusing the exact same commit paths (renameNote / folder_rename+loadTree) ContextMenu
  // used. Lifted here rather than into TreeListRow because react-window recycles that row
  // component across indices as the list scrolls, so per-row local state isn't safe to use for
  // "which row is being edited" (see comment on ListRowProps.editingId).
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  // Escape sets this so the blur the ensuing unmount triggers doesn't also fire a commit —
  // mirrors EditorPanel's skipNextBlurRef for the identical F2/dblclick-rename-input situation.
  const skipNextBlurRef = useRef(false);
  // Guards against a double rename call when Enter's commit is immediately followed by the
  // blur the input's unmount produces — mirrors EditorPanel's renameInFlightRef.
  const commitInFlightRef = useRef(false);

  const onStartEdit = useCallback((id: string, _isFolder: boolean, initialValue: string) => {
    setEditing({ id, draft: initialValue });
  }, []);

  const onEditingDraftChange = useCallback((value: string) => {
    setEditing((e) => (e ? { ...e, draft: value } : e));
  }, []);

  const onCancelEdit = useCallback(() => {
    skipNextBlurRef.current = true;
    setEditing(null);
  }, []);

  const onCommitEdit = useCallback(
    (id: string, isFolder: boolean, draft: string) => {
      if (commitInFlightRef.current) return;
      commitInFlightRef.current = true;
      setEditing(null);
      const name = draft.trim();
      if (isFolder) {
        if (!name) {
          commitInFlightRef.current = false;
          return;
        }
        void (async () => {
          try {
            await call("folder_rename", { id, name });
            loadTree();
          } catch {
            // 실패해도 loadTree() 를 안 불러 트리는 옛 이름 그대로다 — UI 가 거짓말하지 않으므로
            // 롤백할 게 없다. 다만 이름 변경은 사용자의 직접 조작(F2/더블클릭 후 Enter)이라
            // 실패를 알려야 하므로 call() 을 유지해 토스트는 그대로 띄운다. try/catch 로 감싸
            // rejection 이 새지 않게 한다(call 뒤 catch 체이닝 안티패턴 금지) — finally 는 그대로 두어
            // commitInFlightRef 해제를 항상 보장한다(finally 는 rejection 을 붙잡지 않는다는
            // 동작을 그대로 유지).
          } finally {
            commitInFlightRef.current = false;
          }
        })();
      } else {
        void (async () => {
          try {
            await renameNote(id, name);
          } catch {
            // renameNote 내부 note_update 가 call() 이라 실패 시 이미 토스트를 띄운다 — 위
            // folder_rename 분기와 같은 처리로 try/catch 로만 rejection 이 새지 않게 막는다.
          } finally {
            commitInFlightRef.current = false;
          }
        })();
      }
    },
    [loadTree]
  );

  const onEditBlur = useCallback(
    (id: string, isFolder: boolean, draft: string) => {
      if (skipNextBlurRef.current) {
        skipNextBlurRef.current = false;
        return;
      }
      onCommitEdit(id, isFolder, draft);
    },
    [onCommitEdit]
  );

  const yearBounds = useSearchStore((s) => s.yearBounds);
  const searchActive =
    query.trim() !== "" || yearFrom > yearBounds.min || yearTo < yearBounds.max;

  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const matchesTagRegion = useMemo(
    () => createMatchesTagRegion({ selectedTags, tagMode, regionFilter, statusFilter, dateRange }),
    [selectedTags, tagMode, regionFilter, statusFilter, dateRange]
  );

  const filteredSearchResults = useMemo(
    () => searchResults.filter(matchesTagRegion),
    [searchResults, matchesTagRegion]
  );

  const tagRegionFilterActive =
    selectedTags.length > 0 || regionFilter !== null || statusFilter.length > 0 || dateRange !== null;

  const folderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  const patchFolder = useNotesStore((s) => s.patchFolder);
  const toggleFolder = useCallback(
    async (f: Folder) => {
      const next = !f.is_open;
      await call("folder_set_open", { id: f.id, is_open: next });
      patchFolder(f.id, { is_open: next });
    },
    [patchFolder]
  );

  const openFolderKey = useMemo(
    () =>
      folders
        .filter((f) => f.is_open || f.id === inboxId)
        .map((f) => f.id)
        .sort()
        .join(","),
    [folders, inboxId]
  );

  const filterAxesKey = useMemo(
    () =>
      JSON.stringify({
        tags: selectedTags,
        tagMode,
        region: regionFilter,
        statuses: statusFilter,
        dateRange,
      }),
    [selectedTags, tagMode, regionFilter, statusFilter, dateRange]
  );

  const { treePending } = useFolderWindows({
    searchActive,
    openFolderKey,
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
  } = useFavoritesWindow({
    searchActive,
    filterAxesKey,
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
  });

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

  const treeFolders = useMemo(
    () => (inboxId ? folders.filter((f) => f.id !== inboxId) : folders),
    [folders, inboxId]
  );

  const inboxNotes = useMemo(
    () => (inboxId ? (filteredByFolder[inboxId] ?? []) : []),
    [inboxId, filteredByFolder]
  );

  const visibleTreeCount = useMemo(() => {
    const inFolders = treeFolders.reduce(
      (acc, f) => acc + (filteredByFolder[f.id]?.length ?? 0),
      0
    );
    return inFolders + favoriteNotes.length + inboxNotes.length;
  }, [treeFolders, filteredByFolder, favoriteNotes, inboxNotes]);

  const [inboxOpen, setInboxOpen] = useState(true);
  const toggleInbox = useCallback(() => {
    setInboxOpen((prev) => !prev);
  }, []);

  const addFolder = async (
    name: string,
    icon: string | null,
    colorHue: number | null,
    rules: string | null
  ) => {
    if (!name.trim()) return;
    await call("folder_create", {
      name: name.trim(),
      icon,
      color_hue: colorHue,
      rules: rules ?? undefined,
    });
    await loadTree();
  };

  const onNewNoteInFolder = useCallback(
    (folderId: string) => {
      const f = useNotesStore.getState().folders.find((x) => x.id === folderId);
      if (f && !f.is_open) void toggleFolder(f).catch(console.error);
      void newNote(folderId).catch(console.error);
    },
    [newNote, toggleFolder]
  );

  const patchNoteSummary = useNotesStore((s) => s.patchNoteSummary);
  const onMoveNote = useCallback(
    (noteId: string, targetFolderId: string) => {
      const state = useNotesStore.getState();
      if (!targetFolderId) return;
      const src = state.noteIndex.get(noteId);
      if (src && src.folder_id === targetFolderId) return;
      const prevFolderId = src?.folder_id;
      if (src) {
        patchNoteSummary(noteId, { folder_id: targetFolderId });
      }
      void (async () => {
        try {
          await call("note_update", { id: noteId, folder_id: targetFolderId });
          await loadTree();
          if (state.activeNote?.note.id === noteId) {
            await selectNote(noteId);
          }
        } catch {
          if (prevFolderId !== undefined) {
            patchNoteSummary(noteId, { folder_id: prevFolderId });
          }
        }
      })();
    },
    [loadTree, patchNoteSummary, selectNote]
  );

  useEffect(
    () =>
      registerNoteDropHandler((noteId, targetId) => {
        if (!targetId.startsWith("folder:")) return;
        const folderId = targetId.slice("folder:".length);
        if (folderId) onMoveNote(noteId, folderId);
      }),
    [onMoveNote]
  );

  const showPending = usePendingDelay(treePending || (searchActive && searching), 150);

  const rows: TreeRow[] = useMemo(
    () =>
      flattenRows({
        searchActive,
        filteredSearchResults,
        favoritesOpen,
        favoriteNotes,
        trashCount,
        sectionTrashCount,
        archiveCount,
        folders: treeFolders,
        filteredByFolder,
        tagRegionFilterActive,
        visibleTreeCount,
        inboxId,
        inboxOpen,
        inboxNotes,
        draftFolderId,
        isBooting,
        searching,
        keywordActive: query.trim() !== "",
      }),
    [
      searchActive,
      filteredSearchResults,
      favoritesOpen,
      favoriteNotes,
      trashCount,
      sectionTrashCount,
      archiveCount,
      treeFolders,
      filteredByFolder,
      tagRegionFilterActive,
      visibleTreeCount,
      inboxId,
      inboxOpen,
      inboxNotes,
      draftFolderId,
      isBooting,
      searching,
      query,
    ]
  );

  const listWrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<ListImperativeAPI | null>(null);
  const [listHeight, setListHeight] = useState(240);
  useEffect(() => {
    const el = listWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setListHeight(Math.floor(h));
    });
    ro.observe(el);
    setListHeight(Math.floor(el.clientHeight) || 240);
    return () => ro.disconnect();
  }, []);

  const getRowHeight = useCallback(
    (index: number) => rowHeightOf(rows[index]!, searchActive),
    [rows, searchActive]
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  /* ── W7-g 다중선택 ──
   * 선택은 id 목록으로 stores/selection.ts 에 산다 — 뷰 상태가 아니라 데이터다. react-window 가
   * 화면 밖 행을 언마운트해도(그리고 TreeListRow 인스턴스를 다른 인덱스에 재사용해도) 선택은
   * 그대로 남는다. 반대로 **근거 행이 사라지면** 떨군다: 아래 effect 가 평탄화된 `rows` 전체
   * (마운트된 창이 아니라)에서 노트 id 를 뽑아 prune 한다. 폴더 접기·필터 변경·노트북 전환·
   * 다른 경로에서의 삭제/아카이브가 모두 `rows` 를 바꾸므로 진입점이 하나로 모인다. 스크롤은
   * `rows` 를 바꾸지 않으므로 가상화로 인한 유실은 원천적으로 없다. */
  const selectedNoteIds = useSelectionStore((s) => s.notes.ids);
  const clickNote = useSelectionStore((s) => s.clickNote);
  const pruneNotes = useSelectionStore((s) => s.pruneNotes);
  const clearNotes = useSelectionStore((s) => s.clearNotes);

  const orderedNoteIds = useMemo(() => rowNoteIds(rows), [rows]);
  useEffect(() => {
    // pruneSelection 은 변화가 없으면 같은 객체를 돌려주므로 여기서 상태 갱신 루프가 생기지 않는다.
    pruneNotes(orderedNoteIds);
  }, [orderedNoteIds, pruneNotes]);

  // W8-c: selectSingle 은 이제 클릭한 행 자신을 ids=[id] 로 정직하게 담는다(stores/selection.ts
  // 헤더 주석 참고) — 그래야 이어지는 Ctrl+클릭이 그 자리에 더할 수 있다. 하지만 노트 트리에서
  // 단순 클릭은 그 노트를 열기도 하므로, 1개짜리 선택은 activeId 와 항상 같은 행을 가리키게
  // 되고, 배경 틴트(TreeListRow 의 multiSelected)까지 켜면 이미 있는 active 왼쪽 바 표시와
  // 겹쳐 이중 신호가 된다. SelectionActionBar 를 2개부터 띄우는 것과 같은 판단("1개는 이미
  // 다른 채널이 있다")을 배경 틴트에도 적용 — 2개 미만이면 빈 Set 을 내려 TreeListRow 는 아무
  // 행도 다중선택으로 그리지 않는다.
  const selectedIdSet = useMemo(
    () => (selectedNoteIds.length >= 2 ? new Set(selectedNoteIds) : new Set<string>()),
    [selectedNoteIds]
  );

  // Esc = 해제. 선택이 있을 때만 구독한다(없을 때 전역 keydown 을 잡고 있을 이유가 없다).
  useEffect(() => {
    if (selectedNoteIds.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearNotes();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNoteIds.length, clearNotes]);

  // Sync find-next match list from the *displayed* rows (filtered). Outside search mode → [].
  // Clamp (not reset) when the list shrinks so a live cursor does not dangle.
  const syncSearchMatches = useSearchStore((s) => s.syncSearchMatches);
  useEffect(() => {
    if (!searchActive) {
      syncSearchMatches([]);
      return;
    }
    syncSearchMatches(collectSearchMatches(rows));
  }, [searchActive, rows, syncSearchMatches]);

  // Scroll the virtualised list to the cursor row. DOM scrollIntoView cannot work — off-window
  // rows are unmounted. react-window v2: listRef.scrollToRow({ index }).
  const matchCursor = useSearchStore((s) => s.matchCursor);
  const matchIds = useSearchStore((s) => s.matchIds);
  const matchRowIndices = useSearchStore((s) => s.matchRowIndices);
  useEffect(() => {
    if (matchCursor === null) return;
    const rowIndex = matchRowIndices[matchCursor];
    if (rowIndex === undefined) return;
    listRef.current?.scrollToRow({ index: rowIndex, align: "smart" });
  }, [matchCursor, matchRowIndices]);

  const matchCursorNoteId =
    matchCursor !== null ? (matchIds[matchCursor] ?? null) : null;

  // Wave F: Dashboard -> Tree reveal (single-direction)
  const dashboardReveal = useUiStore((s) => s.dashboardReveal);
  const prevRevealSeqRef = useRef<number | null>(null);
  const [revealedNoteId, setRevealedNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (!dashboardReveal) return;
    if (prevRevealSeqRef.current === dashboardReveal.seq) return;
    prevRevealSeqRef.current = dashboardReveal.seq;

    const noteId = dashboardReveal.noteId;
    if (!noteId) return;

    // 1. If folder is closed, open it so the note becomes part of flattened tree rows
    const note = useNotesStore.getState().noteIndex.get(noteId);
    if (note?.folder_id) {
      const folder = useNotesStore.getState().folders.find((f) => f.id === note.folder_id);
      if (folder && !folder.is_open) {
        void toggleFolder(folder);
      }
    }

    // 2. Set temporary highlight
    setRevealedNoteId(noteId);
    const timer = setTimeout(() => {
      setRevealedNoteId((prev) => (prev === noteId ? null : prev));
    }, 1800);

    return () => clearTimeout(timer);
  }, [dashboardReveal, toggleFolder]);

  // When rows update or revealedNoteId changes, scroll the row into view
  useEffect(() => {
    if (!revealedNoteId) return;
    const rowIndex = rows.findIndex(
      (r) => r.kind === "note" && r.note.id === revealedNoteId
    );
    if (rowIndex !== -1) {
      listRef.current?.scrollToRow({ index: rowIndex, align: "smart" });
    }
  }, [revealedNoteId, rows]);

  const onRowsRendered = useMemo(
    () => createOnRowsRendered(rowsRef),
    [createOnRowsRendered]
  );

  const onSelectNote = useCallback(
    (id: string, mods: { toggle: boolean; range: boolean }, index: number) => {
      // 범위는 "화면에 보이는 노트 행 순서" 위에서 정의된다 — rowsRef 로 최신 행을 읽어
      // 콜백 identity 가 rows 마다 흔들리지 않게 한다. `index` 는 TreeListRow 가 react-window 로
      // 부터 받는 실제 클릭 행 위치 — 즐겨찾기 노트처럼 같은 id 가 즐겨찾기 섹션과 소속 폴더 두
      // 곳에 동시에 그려질 때, 이 위치가 있어야 rangeSelection 이 "어느 쪽 행을 클릭했는지"를
      // id 만으로는 못 하는 방식으로 구분한다(stores/selection.ts 의 anchorIndex 설계 참고).
      clickNote(id, mods, rowNoteIds(rowsRef.current), index);
      // 수식키 없는 클릭만 기존 동작(선택 비우고 노트 열기)을 그대로 이어간다.
      if (!mods.toggle && !mods.range) void selectNote(id);
    },
    [clickNote, selectNote]
  );

  const onOpenCtx = useCallback(
    (id: string, x: number, y: number) => {
      openCtx(id, x, y);
    },
    [openCtx]
  );

  const onToggleFolder = useCallback(
    (f: Folder) => {
      void toggleFolder(f);
    },
    [toggleFolder]
  );

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;

      const noteRowIndices: number[] = [];
      rows.forEach((r, i) => {
        // TreeRow 의 판별자는 `kind` 이고 노트 행 종류는 "note" 하나다(rows.ts). `type` 과
        // search_note/favorite_note/inbox_note 는 옛 행 모델의 잔재라 이 조건은 **항상 거짓**
        // 이었고, 그래서 noteRowIndices 가 늘 비어 트리의 ↑/↓ 이동이 통째로 죽어 있었다.
        if (r.kind === "note") {
          noteRowIndices.push(i);
        }
      });
      if (noteRowIndices.length === 0) return;

      e.preventDefault();
      const currentActiveIdx = activeId
        ? rows.findIndex((r) => "note" in r && r.note?.id === activeId)
        : -1;
      const currentPosInNotes = noteRowIndices.indexOf(currentActiveIdx);

      let targetPos = 0;
      if (e.key === "ArrowDown") {
        targetPos =
          currentPosInNotes >= 0 && currentPosInNotes < noteRowIndices.length - 1
            ? currentPosInNotes + 1
            : 0;
      } else {
        targetPos =
          currentPosInNotes > 0
            ? currentPosInNotes - 1
            : noteRowIndices.length - 1;
      }

      const targetRowIdx = noteRowIndices[targetPos];
      const targetRow = rows[targetRowIdx];
      if (targetRow && "note" in targetRow && targetRow.note) {
        listRef.current?.scrollToRow({ index: targetRowIdx, align: "smart" });
        void selectNote(targetRow.note.id);
      }
    },
    [editing, rows, activeId, selectNote]
  );

  const rowProps: ListRowProps = useMemo(
    () => ({
      rows,
      searchActive,
      favoritesOpen,
      favoriteCount: favoriteNotes.length,
      trashCount,
      sectionTrashCount,
      archiveCount,
      activeId,
      selectedIds: selectedIdSet,
      matchCursorNoteId,
      folderNameById,
      revealedNoteId,
      editingId: editing?.id ?? null,
      editingDraft: editing?.draft ?? "",
      onEditingDraftChange,
      onStartEdit,
      onCommitEdit,
      onEditBlur,
      onCancelEdit,
      inboxOpen,
      inboxCount: inboxNotes.length,
      inboxId,
      searchQuery: query,
      onToggleFavorites: toggleFavorites,
      onToggleInbox: toggleInbox,
      onToggleFolder,
      onOpenTrash: openTrash,
      onOpenArchive: openArchive,
      onOpenCtx,
      onSelectNote,
      onNewNoteInFolder,
      onMoveNote,
      loadTree,
      selectNote,
    }),
    [
      rows,
      searchActive,
      favoritesOpen,
      favoriteNotes.length,
      trashCount,
      sectionTrashCount,
      archiveCount,
      activeId,
      selectedIdSet,
      matchCursorNoteId,
      folderNameById,
      revealedNoteId,
      editing,
      onEditingDraftChange,
      onStartEdit,
      onCommitEdit,
      onEditBlur,
      onCancelEdit,
      inboxOpen,
      inboxNotes.length,
      inboxId,
      query,
      toggleFavorites,
      toggleInbox,
      onToggleFolder,
      openTrash,
      openArchive,
      onOpenCtx,
      onSelectNote,
      onNewNoteInFolder,
      onMoveNote,
      loadTree,
      selectNote,
    ]
  );

  return (
    <>
      <div
        // W8-c: 다중선택 액션 바(NoteSelectionBar, placement="panel")가 이 안에서 절대 위치로
        // 바닥에 붙는다 — 화면 중앙 고정이던 것을 트리 영역 하단(선택 중인 그 목록 바로 아래)으로
        // 옮긴 것(오너 피드백: 너무 멀어 조작이 어렵다). 조상 노드가 relative 여야 바가 이 영역
        // 안에서만 움직이고, 아래 "새 노트" 푸터(leftpanel/index.tsx)는 형제 flex 아이템이라
        // 절대 덮이지 않는다.
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: "var(--space-4) 0 var(--space-5) var(--sidebar-pad)",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 var(--sidebar-pad) var(--space-2) 0",
            flex: "none",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: "var(--text-xs)",
              color: "var(--faint)",
              textTransform: "uppercase",
            }}
          >
            {searchActive ? t("tree.search_results") : t("tree.note_tree")}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            {searchActive && (
              // 폰트 크기만 11px 고정 — 다른 3곳은 var(--text-2xs)(9px) 를 쓰지만 이 자리는
              // 순수 시각적 무변경을 위해 기존 값을 그대로 유지한다(Pill 로 옮기며 새로 벌린 차이 아님).
              <Pill tone="accent" style={{ fontSize: "11px" }}>
                {filteredSearchResults.length >= 500
                  ? t("search.n_found_capped")
                  : t("search.n_found", { n: filteredSearchResults.length })}
              </Pill>
            )}
            {!searchActive && (
              <>
                <TreeHeaderActions />
                <button
                  type="button"
                  onClick={() => setNewFolderOpen(true)}
                  title={t("tree.add_folder")}
                  aria-label={t("tree.add_folder")}
                  className="icon-btn icon-btn--sm icon-btn--glow"
                >
                  <IconFolderPlus size={14} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        </div>

        <BackupNudgeBanner />

        <div
          ref={listWrapRef}
          tabIndex={0}
          onKeyDown={onTreeKeyDown}
          style={{ flex: 1, minHeight: 0, position: "relative", outline: "none" }}
        >
          <PendingIndicator active={showPending} />
          <List
            id="brise-search-results"
            className="scroll scroll--slim"
            listRef={listRef}
            rowComponent={TreeListRow}
            rowCount={rows.length}
            rowHeight={getRowHeight}
            rowProps={rowProps}
            overscanCount={8}
            onRowsRendered={onRowsRendered}
            style={{ height: listHeight, width: "100%", opacity: searchActive && searching ? 0.55 : 1 }}
          />
        </div>
        <NoteSelectionBar />
      </div>
      {newFolderOpen && (
        <NewFolderDialog
          aiEnabled={Boolean(useSettingsStore.getState().aiEnabled)}
          onCancel={() => setNewFolderOpen(false)}
          onSubmit={({ name, icon, colorHue, rules }) => {
            setNewFolderOpen(false);
            void addFolder(name, icon, colorHue, rules);
          }}
        />
      )}
    </>
  );
}
