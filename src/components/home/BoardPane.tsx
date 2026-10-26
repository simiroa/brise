/**
 * Home → 작업 (board) tab — kanban of notes by status with a "알려줘" (remind) pin + checkbox items.
 * Spec: docs/DASHBOARD.md §3.2. Data: dashboard_board / todo_toggle / note_set_status.
 * Layout reference only: docs/mockups/dashboard-home-tab.html — tokens only, no mockup CSS.
 *
 * DnD: reuses pointer-based noteDrag (HTML5 DnD is blocked by Tauri dragDropEnabled for OS
 * file drops — see lib/noteDrag.ts). Drop target prefix `board-status:` so tree handlers ignore us.
 *
 * This file is assembly only — card/column rendering lives in board/BoardCard.tsx and
 * board/BoardColumn.tsx, status/target helpers in board/status.ts.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call } from "../../lib/invoke";
import type {
  BoardColumn as BoardColumnData,
  BoardNote,
  BoardResult,
  BoardTodoItem,
  NoteSummary,
  TodoToggleResult,
} from "../../lib/commands.gen";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { t } from "../../i18n/t";
import { usePendingDelay } from "../../lib/usePendingDelay";
import { PendingIndicator } from "../common/PendingIndicator";
import { registerNoteDropHandler } from "../../lib/noteDrag";
import { BoardColumn } from "./board/BoardColumn";
import { BOARD_DROP_PREFIX, parseStatusTarget, statusTargetId } from "./board/status";
import { useDashboardSearchHits } from "./useDashboardSearchHits";
import { useDashboardReveal } from "./useDashboardReveal";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { IconPlus } from "../icons";

// Per-note in-flight counter for note_set_status drops — same pattern as notes.ts selectNoteSeq.
// A rapid second drag must not let the first request's failure roll back the second's optimistic
// move, nor let a late success patchNoteSummary overwrite the newer status.
const boardStatusWriteSeqByNote = new Map<string, number>();

export function BoardPane() {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const selectNote = useNotesStore((s) => s.selectNote);
  const openCtx = useUiStore((s) => s.openCtx);
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  // New-status entry point (2026-09-08 owner): a narrow slot at the far right of the column row,
  // not a nav-row button — it's a board concern. Hidden by the status_add_locked setting.
  const addStatus = useTaxonomyStore((s) => s.addStatus);
  const statusAddLocked = useSettingsStore((s) => s.statusAddLocked);
  const [addingStatus, setAddingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const cancelAddStatus = useCallback(() => {
    setAddingStatus(false);
    setStatusDraft("");
  }, []);
  const commitAddStatus = useCallback(() => {
    const name = statusDraft.trim();
    cancelAddStatus();
    if (name) void addStatus(name);
  }, [statusDraft, addStatus, cancelAddStatus]);
  // Global dashboard search (HomeTab) — dim non-matching cards, never filter them out.
  const searchHits = useDashboardSearchHits();
  // Dashboard-wide folder filter (nav row dot control, stores/ui.ts) — unlike search, this
  // actually narrows the card list (see `displayColumns` below). BoardNote itself carries no
  // folder_id (dashboard_board doesn't return one — see commands.gen.ts), so folder is resolved
  // per-card through the note index loadTree() already populated for the whole workspace.
  const dashboardFolderFilter = useUiStore((s) => s.dashboardFolderFilter);
  const noteIndex = useNotesStore((s) => s.noteIndex);

  const [columns, setColumns] = useState<BoardColumnData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  // Single-click focus (map view pattern, see HomeMapPane) — view-local, no store.
  // Double-click still opens (onOpen below). Cleared by a click on empty board space (below).
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const showPending = usePendingDelay(loading, 150);
  // Bumped to re-fetch without a second load path (e.g. todo_toggle's CONFLICT recovery below) —
  // same reloadToken convention as CalendarTab.
  const [reloadToken, setReloadToken] = useState(0);

  // Wave E reveal handler: scroll focused note card into center view. Consumption/tab-guard
  // ordering lives in useDashboardReveal (see that file — fixes stale replay on tab switch).
  // Scoped to this pane, never `document`: the sidebar's own note rows (TagsExpandedNoteRow) and
  // the timeline canvas carry the same data-note-id, and the sidebar renders BEFORE the dashboard
  // in App.tsx — a document-wide lookup scrolls whichever one happens to come first in the DOM.
  const paneRef = useRef<HTMLDivElement>(null);
  useDashboardReveal("board", useCallback((noteId: string) => {
    setFocusedNoteId(noteId);
    requestAnimationFrame(() => {
      const el = paneRef.current?.querySelector(`[data-note-id="${noteId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
    });
  }, []));

  // Stale-response guard (dashboard audit P1 #1): a rapid notebook switch can let an in-flight
  // dashboard_board for the OLD notebook resolve after the new notebook's request and overwrite
  // its board. Same `let cancelled = false` pattern as CalendarTab/TimelineTab/HomeMapPane.
  useEffect(() => {
    if (!workspaceId) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const res = await call<BoardResult>("dashboard_board", {
          workspace_id: workspaceId,
        });
        if (cancelled) return;
        // Server sort order (pinned → schedule asc → updated_at desc) is kept as-is.
        // res.total_matched/cap/capped are no longer surfaced in the UI (QA: the
        // "showing top N of M" banner was noise) — BoardResult still carries them.
        setColumns(res.columns);
      } catch {
        if (cancelled) return;
        setError(true);
        setColumns([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadToken, customStatuses]);


  // Drop → note_set_status. Optimistic column move + rollback.
  // Own call path (not setNoteStatus) so we can roll the board back — setNoteStatus swallows errors.
  useEffect(
    () =>
      registerNoteDropHandler((noteId, targetId) => {
        if (!targetId.startsWith(BOARD_DROP_PREFIX)) return;
        const raw = targetId.slice(BOARD_DROP_PREFIX.length);
        const nextStatus = parseStatusTarget(raw);

        setColumns((prev) => {
          if (!prev) return prev;
          let fromColIx = -1;
          let note: BoardNote | null = null;
          for (let i = 0; i < prev.length; i++) {
            const found = prev[i].notes.find((n) => n.id === noteId);
            if (found) {
              fromColIx = i;
              note = found;
              break;
            }
          }
          if (!note || fromColIx < 0) return prev;
          const fromStatus = prev[fromColIx].status;
          if (fromStatus === nextStatus) return prev;

          const toColIx = prev.findIndex((c) => (c.status ?? null) === nextStatus);
          if (toColIx < 0) return prev;

          // Optimistic move: append to target (server re-sorts on next full load).
          const next = prev.map((c) => ({ ...c, notes: [...c.notes] }));
          next[fromColIx].notes = next[fromColIx].notes.filter((n) => n.id !== noteId);
          next[toColIx].notes = [...next[toColIx].notes, note];

          const snapshot = prev;
          const prevSummaryStatus =
            useNotesStore.getState().noteIndex.get(noteId)?.status ?? null;
          useNotesStore.getState().patchNoteSummary(noteId, { status: nextStatus });

          const seq = (boardStatusWriteSeqByNote.get(noteId) ?? 0) + 1;
          boardStatusWriteSeqByNote.set(noteId, seq);

          void (async () => {
            try {
              const updated = await call<NoteSummary>("note_set_status", {
                id: noteId,
                status: nextStatus,
              });
              // Stale response — a newer drag for this note already owns the UI/summary.
              if (boardStatusWriteSeqByNote.get(noteId) !== seq) return;
              useNotesStore.getState().patchNoteSummary(noteId, updated);
              if (useNotesStore.getState().activeNote?.note.id === noteId) {
                void useNotesStore.getState().selectNote(noteId);
              }
            } catch {
              // Stale failure must not undo a later drag's optimistic (or confirmed) move.
              if (boardStatusWriteSeqByNote.get(noteId) !== seq) return;
              setColumns(snapshot);
              useNotesStore
                .getState()
                .patchNoteSummary(noteId, { status: prevSummaryStatus });
            }
          })();

          return next;
        });
      }),
    [],
  );

  // Deliberately unfiltered — this is "does the workspace have any notes at all" (drives the
  // board-workspace-empty banner below), which must stay true even when a folder filter narrows
  // every column to zero cards (that's a filter result, not an empty workspace).
  const totalNotes = useMemo(
    () => (columns ?? []).reduce((n, c) => n + c.notes.length, 0),
    [columns],
  );

  // Folder filter narrows the rendered card list (AND'd with the existing search dim above —
  // search never removes cards, so nothing to conflict with; a card must simply belong to the
  // active folder to render at all).
  const displayColumns = useMemo(() => {
    if (!columns || !dashboardFolderFilter) return columns;
    return columns.map((col) => ({
      ...col,
      notes: col.notes.filter((n) => noteIndex.get(n.id)?.folder_id === dashboardFolderFilter),
    }));
  }, [columns, dashboardFolderFilter, noteIndex]);

  // Horizontal scroll overflow tracking & edge fade (Wave KANBAN, docs/HANDOFF-2026-10-18-board-easy.md)
  const columnsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = columnsRef.current;
    if (!el) return;

    let rafId = 0;
    const updateFade = () => {
      rafId = 0;
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const hasOverflow = scrollWidth > clientWidth;
      const canScrollLeft = hasOverflow && scrollLeft > 1;
      const canScrollRight = hasOverflow && scrollLeft < scrollWidth - clientWidth - 1;

      if (canScrollLeft) {
        el.setAttribute("data-fade-left", "true");
      } else {
        el.removeAttribute("data-fade-left");
      }

      if (canScrollRight) {
        el.setAttribute("data-fade-right", "true");
      } else {
        el.removeAttribute("data-fade-right");
      }
    };

    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(updateFade);
    };

    updateFade();

    el.addEventListener("scroll", scheduleUpdate, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleUpdate);
      ro.observe(el);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", scheduleUpdate);
      ro?.disconnect();
    };
  }, [displayColumns, addingStatus]);

  const onToggleExpand = useCallback((noteId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const onDragStartCollapse = useCallback((noteId: string) => {
    setExpandedIds((prev) => {
      if (!prev.has(noteId)) return prev;
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
  }, []);

  const onOpen = useCallback(
    (noteId: string) => {
      void selectNote(noteId);
    },
    [selectNote],
  );

  const onFocus = useCallback((noteId: string) => setFocusedNoteId(noteId), []);

  const onContextMenu = useCallback(
    (noteId: string, x: number, y: number) => {
      // Existing ContextMenu includes "change status" — keyboard/right-click alternative to drag.
      openCtx(noteId, x, y);
    },
    [openCtx],
  );

  const onToggleTodo = useCallback(
    async (note: BoardNote, item: BoardTodoItem) => {
      try {
        const result = await call<TodoToggleResult>("todo_toggle", {
          note_id: note.id,
          section_id: item.section_id,
          line_index: item.line_index,
          expected_checked: item.checked,
        });
        // Local patch only — no full board refresh on success.
        setColumns((prev) => {
          if (!prev) return prev;
          return prev.map((col) => ({
            ...col,
            notes: col.notes.map((n) => {
              if (n.id !== note.id) return n;
              const items = n.items.map((it) =>
                it.section_id === item.section_id && it.line_index === item.line_index
                  ? { ...it, checked: result.checked }
                  : it,
              );
              return {
                ...n,
                items,
                unchecked_count: items.filter((it) => !it.checked).length,
                updated_at: result.updated_at,
              };
            }),
          }));
        });
        // Desktop remoteNoteWrite drops this window's own echo; reselect so open editor reloads body.
        if (useNotesStore.getState().activeNote?.note.id === note.id) {
          void useNotesStore.getState().selectNote(note.id);
        }
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        // CONFLICT / NOT_FOUND / VALIDATION: refresh board (call() already toasted AppError).
        if (code === "CONFLICT" || code === "NOT_FOUND" || code === "VALIDATION") {
          setReloadToken((n) => n + 1);
        }
      }
    },
    [],
  );

  if (!workspaceId) {
    return (
      <div
        data-testid="board-pane"
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          color: "var(--faint)",
          fontSize: "var(--text-md)",
          padding: "var(--space-7)",
        }}
      >
        {t("home.board.no_workspace")}
      </div>
    );
  }

  return (
    <div
      ref={paneRef}
      data-testid="board-pane"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PendingIndicator active={showPending} />

      {error && (
        <div
          data-testid="board-error"
          style={{
            flex: "none",
            padding: "var(--space-3) var(--space-4)",
            color: "var(--danger)",
            fontSize: "var(--text-sm)",
          }}
        >
          {t("home.board.load_failed")}
        </div>
      )}

      {columns && totalNotes === 0 && !loading && !error && (
        <div
          data-testid="board-workspace-empty"
          style={{
            flex: "none",
            padding: "var(--space-4) var(--space-4) 0",
            color: "var(--faint)",
            fontSize: "var(--text-sm)",
          }}
        >
          {t("home.board.workspace_empty")}
        </div>
      )}

      <div
        ref={columnsRef}
        data-testid="board-columns"
        className="board-columns"
        // Empty-space click clears focus — cards themselves stopPropagation on click (BoardCard),
        // so this only fires when the click never landed on a card.
        onClick={() => setFocusedNoteId(null)}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          gap: "var(--space-6)",
          overflowX: "auto",
          alignItems: "stretch",
          // W24: 좌우 10px→8px — 칼럼 내부 좌 패딩(BoardColumn, --space-2=6px)과 합쳐 첫 칼럼
          // 텍스트가 헤더 제목과 같은 14px 라인에서 시작한다(에디터 컬럼 좌측 시작점 통일과
          // 같은 원칙).
          padding: "var(--space-4) var(--space-3)",
        }}
      >
        {(displayColumns ?? []).map((col, i) => (
          <Fragment key={statusTargetId(col.status)}>
            {i > 0 && (
              <div
                aria-hidden
                style={{ flex: "none", width: 1, alignSelf: "stretch", background: "var(--line)" }}
              />
            )}
            <BoardColumn
              col={col}
              expandedIds={expandedIds}
              searchHits={searchHits}
              focusedNoteId={focusedNoteId}
              onToggleExpand={onToggleExpand}
              onFocus={onFocus}
              onOpen={onOpen}
              onToggleTodo={onToggleTodo}
              onContextMenu={onContextMenu}
              onDragStartCollapse={onDragStartCollapse}
            />
          </Fragment>
        ))}
        {!statusAddLocked && (
          <div
            data-testid="board-add-status-slot"
            // Clicks here must not clear the card focus the way empty board space does.
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: "none",
              width: addingStatus ? 140 : "var(--ctrl-h-sm)",
              display: "flex",
              alignItems: "flex-start",
              // Same top offset as a column header so the "+" lines up with the status names.
              paddingTop: "var(--space-1)",
            }}
          >
            {addingStatus ? (
              <input
                data-testid="board-add-status-input"
                autoFocus
                value={statusDraft}
                onChange={(e) => setStatusDraft(e.target.value)}
                onBlur={commitAddStatus}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitAddStatus();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelAddStatus();
                  }
                }}
                placeholder={t("search.status_add_placeholder")}
                className="field"
                style={{
                  height: "var(--ctrl-h-sm)",
                  width: "100%",
                  fontSize: "var(--text-xs)",
                  padding: "0 var(--space-2)",
                }}
              />
            ) : (
              <button
                type="button"
                data-testid="board-add-status-btn"
                className="icon-btn icon-btn--sm"
                title={t("search.status_add")}
                aria-label={t("search.status_add")}
                onClick={() => setAddingStatus(true)}
                style={{ color: "var(--faint)" }}
              >
                <IconPlus size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
