/**
 * Board column (header + card list) — extracted from BoardPane (pure move, same behavior).
 * Header also owns per-column find (client-side title filter) and sort (schedule/recent/title),
 * both local state — session-only, reset on remount, no store persistence needed (spec).
 */
import { useMemo, useState } from "react";
import type { BoardColumn as BoardColumnData, BoardNote, BoardTodoItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { statusColorVar } from "../../../lib/status";
import { noteDropTargetProps } from "../../../lib/noteDrag";
import { IconPlus, IconSearch, IconSort } from "../../icons";
import { useNotesStore } from "../../../stores/notes";
import { StatusDot } from "../../titlebar/StatusControl";
import { NumberTicker } from "../../common/NumberTicker";
import { BoardCard } from "./BoardCard";
import { BOARD_DROP_PREFIX, columnLabel, isPinned, statusTargetId } from "./status";

type SortMode = "schedule" | "recent" | "title";
const SORT_MODES: SortMode[] = ["schedule", "recent", "title"];

/**
 * Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): pinned notes (isPinned — remind flag +
 * past full-precision end, done column exempt) always float to the top regardless of sort mode;
 * only the non-pinned tail actually re-sorts by the picked mode. "schedule" is the server's
 * default order (pin → open-checkbox → end-date asc → updated_at desc) — returning it unchanged
 * for that mode keeps the server and client in agreement instead of re-deriving the same
 * ordering twice. Recent/title modes do not apply checkbox priority: they only keep pins on
 * top, then re-sort the rest by updated_at / title (server checkbox tier is intentionally dropped).
 */
function sortNotes(notes: BoardNote[], mode: SortMode, columnStatus: string | null): BoardNote[] {
  // schedule mode: preserve server order (includes checkbox priority). Recent/title: re-sort.
  if (mode === "schedule") return notes;
  const pinned = notes.filter((n) => isPinned(n, columnStatus));
  const rest = notes.filter((n) => !isPinned(n, columnStatus));
  const sortedRest =
    mode === "recent"
      ? [...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      : [...rest].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  return [...pinned, ...sortedRest];
}

export function BoardColumn({
  col,
  expandedIds,
  searchHits,
  focusedNoteId,
  onToggleExpand,
  onFocus,
  onOpen,
  onToggleTodo,
  onContextMenu,
  onDragStartCollapse,
}: {
  col: BoardColumnData;
  expandedIds: Set<string>;
  /** Global dashboard search hit ids (HomeTab), or null when no query is active. */
  searchHits: Set<string> | null;
  /** Single-click focus (map view pattern) — id of the currently focused card, or null. */
  focusedNoteId: string | null;
  onToggleExpand: (noteId: string) => void;
  onFocus: (noteId: string) => void;
  onOpen: (noteId: string) => void;
  onToggleTodo: (note: BoardNote, item: BoardTodoItem) => void;
  onContextMenu: (noteId: string, x: number, y: number) => void;
  onDragStartCollapse: (noteId: string) => void;
}) {
  const accent = statusColorVar(col.status);
  const dropProps = noteDropTargetProps(
    `${BOARD_DROP_PREFIX}${statusTargetId(col.status)}`,
  );

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("schedule");

  const filtered = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return q ? col.notes.filter((n) => (n.title || "").toLowerCase().includes(q)) : col.notes;
  }, [col.notes, filterQuery]);
  const visibleNotes = useMemo(
    () => sortNotes(filtered, sortMode, col.status),
    [filtered, sortMode, col.status],
  );

  // Match count is over the column's full note set (col.notes), not the local title-filtered
  // `visibleNotes` — these are two independent filters (per-column find vs. the dashboard-wide
  // search box); counting the post-filter set would double them up and read as wrong.
  const matchCount = useMemo(
    () => (searchHits ? col.notes.filter((n) => searchHits.has(n.id)).length : null),
    [searchHits, col.notes],
  );

  const toggleFilter = () => {
    setFilterOpen((open) => {
      if (open) setFilterQuery(""); // closing resets — no filter silently applied while hidden
      return !open;
    });
  };
  const cycleSort = () =>
    setSortMode((m) => SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length]);

  return (
    <section
      data-testid="board-column"
      data-status={statusTargetId(col.status)}
      {...dropProps}
      style={{
        flex: "1 1 200px",
        minWidth: 200,
        maxWidth: 320,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minHeight: 26,
          padding: "0 var(--space-2) var(--space-3)",
          borderBottom: "1px solid var(--divider)",
          flex: "none",
        }}
      >
        {/* 제목 유닛 — 점·이름·갯수는 한 덩어리로 세로 중앙 정렬(헤더 전체 align-items:center).
            예전엔 헤더가 baseline 정렬이라 26px 정렬 버튼이 줄 높이를 키우고, 점/버튼만
            alignSelf:center 라 글자만 위로 떠 보였다. */}
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, flex: "1 1 auto" }}>
          <StatusDot color={accent} size={7} />
          <span
            title={columnLabel(col)}
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "var(--text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text)",
              fontWeight: 600,
              lineHeight: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {columnLabel(col)}
          </span>
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--faint)",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
              flex: "none",
            }}
          >
            <NumberTicker value={col.notes.length} />
          </span>
          {matchCount !== null && (
            <span
              data-testid="board-column-match-count"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--accent)",
                fontWeight: 600,
                lineHeight: 1,
                flex: "none",
              }}
            >
              {t("home.board.match_count", { n: matchCount })}
            </span>
          )}
        </span>
        <span style={{ display: "flex", gap: "var(--space-2xs)", flex: "none" }}>
          <button
            type="button"
            data-testid="board-column-filter-toggle"
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-active={filterOpen || filterQuery ? "true" : undefined}
            title={t("home.board.filter")}
            aria-label={t("home.board.filter")}
            onClick={toggleFilter}
          >
            <IconSearch size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            data-testid="board-column-sort-toggle"
            data-sort-mode={sortMode}
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-active={sortMode !== "schedule" ? "true" : undefined}
            title={`${t("home.board.sort")}: ${t(`home.board.sort_${sortMode}`)}`}
            aria-label={`${t("home.board.sort")}: ${t(`home.board.sort_${sortMode}`)}`}
            onClick={cycleSort}
            style={{
              width: "auto",
              height: "auto",
              minHeight: 26,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "0 var(--space-2)",
            }}
          >
            <IconSort size={13} strokeWidth={2} />
            <span
              style={{
                fontSize: "var(--text-2xs)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 72,
              }}
            >
              {t(`home.board.sort_${sortMode}`)}
            </span>
          </button>
        </span>
      </header>

      {filterOpen && (
        <div style={{ padding: "var(--space-3) var(--space-2) 0", flex: "none" }}>
          <input
            data-testid="board-column-filter-input"
            autoFocus
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") toggleFilter();
            }}
            placeholder={t("home.board.filter_placeholder")}
            style={{
              width: "100%",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-2) var(--space-3)",
              fontSize: "var(--text-sm)",
              color: "var(--text)",
              outline: "none",
            }}
          />
        </div>
      )}

      <div
        className="scroll"
        style={{
          overflowY: "auto",
          padding: "var(--space-4) var(--space-1)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          flex: 1,
          minHeight: 0,
        }}
      >
        {visibleNotes.length === 0 ? (
          <div
            data-testid="board-column-empty"
            style={{
              padding: "var(--space-5) var(--space-3)",
              color: "var(--faint)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <span>{t(col.notes.length === 0 ? "home.board.column_empty" : "home.board.filter_empty")}</span>
            {col.notes.length === 0 && (
              <button
                type="button"
                className="ghost-add"
                data-testid="board-column-empty-add"
                title={t("home.board.column_empty_add")}
                aria-label={t("home.board.column_empty_add")}
                onClick={() => {
                  void (async () => {
                    await useNotesStore.getState().newNote();
                    if (col.status) {
                      await useNotesStore.getState().setStatus(col.status);
                    }
                  })();
                }}
              >
                <IconPlus size={16} strokeWidth={1.8} />
              </button>
            )}
          </div>
        ) : (
          visibleNotes.map((note) => (
            <BoardCard
              key={note.id}
              note={note}
              columnStatus={col.status}
              expanded={expandedIds.has(note.id)}
              dim={searchHits !== null && !searchHits.has(note.id)}
              focused={note.id === focusedNoteId}
              onToggleExpand={onToggleExpand}
              onFocus={onFocus}
              onOpen={onOpen}
              onToggleTodo={onToggleTodo}
              onContextMenu={onContextMenu}
              onDragStartCollapse={onDragStartCollapse}
            />
          ))
        )}
      </div>
    </section>
  );
}
