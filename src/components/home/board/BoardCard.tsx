/**
 * Board card (collapsed/expanded + todo checklist) — extracted from BoardPane (pure move,
 * same behavior).
 *
 * Cover thumbnail (Wave: kanban card polish): lazy-loaded, only once the card actually scrolls
 * into view — SCALABILITY.md §0 (cost ∝ visible items), never fetched eagerly for a whole (up to
 * BOARD_NOTE_CAP) column. lib/noteCoverImage coalesces cards that become visible together into
 * one note_cover_images IPC, and its module-level cache dedupes across remounts (sort/filter/
 * expand re-render cards constantly).
 */
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import type { BoardNote, BoardTodoItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { useAttachmentsBase } from "../../../lib/attachmentsBase";
import { formatEventBadge } from "../../titlebar/eventDate";
import { startNoteDrag } from "../../../lib/noteDrag";
import { displayTitle } from "../../../stores/notes";
import { IconCheckboxEmpty, IconCaret } from "../../icons";
import { NO_STATUS_TARGET, isPinned } from "./status";

import {
  fetchCoverImage,
  getCachedCoverImage,
  resetCoverImageCache as __resetCoverCache,
} from "../../../lib/noteCoverImage";
export { __resetCoverCache };

/** Fetches (and caches) a note's cover image, but only once `active` — the visibility gate. */
function useCardCover(noteId: string, active: boolean): string | null {
  const [rel, setRel] = useState<string | null>(() => getCachedCoverImage(noteId) ?? null);

  useEffect(() => {
    if (!active) return;
    const cached = getCachedCoverImage(noteId);
    if (cached !== undefined) {
      setRel(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await fetchCoverImage(noteId);
      if (!cancelled) setRel(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, active]);

  return rel;
}

/**
 * True once `ref`'s element has intersected the viewport at least once, then stops observing
 * (a cover thumbnail never needs to unload once fetched). One observer per card — fine at the
 * board's note cap; ponytail: a single shared observer keyed by element would cut allocations
 * further if this ever measures hot.
 */
function useOnceInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    // Lazy-load is an optimization only — environments without IntersectionObserver (jsdom
    // tests) just never trigger it, same guard as SettingsNav.tsx.
    if (typeof IntersectionObserver === "undefined") return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, ref]);

  return inView;
}

/**
 * Neutral date-range text (start[–end]) — always shown, no urgency coloring. Dashboard Wave 3
 * (2026-08-01): note dates are plain record info; the only "attention" signal left is the pin
 * dot (see isPinned), which is a separate element from this text.
 */
function DateRangeText({ note }: { note: BoardNote }) {
  return (
    <span
      data-testid="board-date-range"
      style={{
        fontSize: "var(--text-2xs)",
        color: "var(--faint)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatEventBadge(note.year, note.month, note.day, {
        end_year: note.end_year,
        end_month: note.end_month,
        end_day: note.end_day,
      })}
    </span>
  );
}

export const BoardCard = memo(function BoardCard({
  note,
  columnStatus,
  expanded,
  dim = false,
  focused = false,
  onToggleExpand,
  onFocus,
  onOpen,
  onToggleTodo,
  onContextMenu,
  onDragStartCollapse,
}: {
  note: BoardNote;
  columnStatus: string | null;
  expanded: boolean;
  /** True when a dashboard search is active and this note isn't among the hits — dims the card
   *  in place rather than removing it (owner decision: keep card position, less jarring). */
  dim?: boolean;
  /** Single-click focus (map view pattern) — outlined in place, never opens. */
  focused?: boolean;
  onToggleExpand: (noteId: string) => void;
  onFocus: (noteId: string) => void;
  onOpen: (noteId: string) => void;
  onToggleTodo: (note: BoardNote, item: BoardTodoItem) => void;
  onContextMenu: (noteId: string, x: number, y: number) => void;
  onDragStartCollapse: (noteId: string) => void;
}) {
  const hasTodos = note.items.length > 0;
  const pinned = isPinned(note, columnStatus);
  // 새 노트의 저장 제목은 센티널 "Untitled Note" — 트리·탭과 같은 판정으로 "제목 없음"을 그린다.
  const title = displayTitle(note.title);

  const cardRef = useRef<HTMLDivElement>(null);
  const inView = useOnceInView(cardRef);
  const coverRel = useCardCover(note.id, inView);
  const { baseDir, convert } = useAttachmentsBase();
  const thumbSrc = coverRel && baseDir && convert ? convert(`${baseDir}/${coverRel}`) : null;

  return (
    <div
      ref={cardRef}
      className="board-card"
      data-testid="board-card"
      data-note-id={note.id}
      data-status={columnStatus ?? NO_STATUS_TARGET}
      data-expanded={expanded ? "true" : "false"}
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      role="button"
      tabIndex={0}
      // Single click focuses (map view pattern, see HomeMapPane); double click opens.
      // Both stop propagation so they never bubble to BoardPane's empty-space click, which clears
      // focus.
      onClick={(e) => {
        e.stopPropagation();
        onFocus(note.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen(note.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(note.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        // Spec §3.2: collapse expanded card as soon as drag starts.
        if (e.button === 0) {
          onDragStartCollapse(note.id);
          startNoteDrag(e, note.id, title);
        }
      }}
      style={{
        // Dashboard search dim (owner decision): keep the card's column position, just fade it —
        // matches MonthGrid's existing out-of-month-cell opacity (0.35).
        opacity: dim ? 0.35 : 1,
        // Focus ring (outline, not border — an outline never fights the card's elevation box-shadow).
        outline: focused ? "2px solid var(--accent)" : "none",
        outlineOffset: 2,
      }}
    >
      {pinned && (
        <span
          aria-hidden
          data-testid="board-pin-dot"
          title={t("home.board.pin_tooltip")}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--danger)",
          }}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {thumbSrc && (
          <img
            src={thumbSrc}
            alt=""
            draggable={false}
            data-testid="board-card-thumb"
            style={{
              width: 32,
              height: 32,
              flex: "none",
              borderRadius: "var(--radius-sm)",
              objectFit: "cover",
              outline: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
              outlineOffset: -1,
            }}
          />
        )}
        <div
          style={{
            minWidth: 0,
            fontSize: "var(--text-md)",
            lineHeight: 1.4,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {title}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginTop: "var(--space-2)",
          flexWrap: "wrap",
        }}
      >
        <DateRangeText note={note} />
        {hasTodos && (
          <button
            type="button"
            data-testid="board-unchecked-badge"
            data-expandable="true"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(note.id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title={
              expanded
                ? t("home.board.collapse_todos")
                : t("home.board.expand_todos")
            }
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: "var(--text-2xs)",
              color: expanded ? "var(--accent)" : "var(--faint)",
              cursor: "pointer",
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
            }}
          >
            <IconCheckboxEmpty size={11} strokeWidth={2} />
            {note.unchecked_count}
            <IconCaret dir={expanded ? "up" : "down"} size={11} />
          </button>
        )}
      </div>

      {expanded && hasTodos && (
        <div
          data-testid="board-todo-list"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            marginTop: "var(--space-4)",
            borderTop: "1px solid var(--line)",
            paddingTop: "var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {note.items.map((item) => (
            <label
              key={`${item.section_id}:${item.line_index}`}
              data-testid="board-todo-item"
              data-checked={item.checked ? "true" : "false"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                fontSize: "var(--text-sm)",
                color: item.checked ? "var(--faint)" : "var(--muted)",
                textDecoration: item.checked ? "line-through" : "none",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => onToggleTodo(note, item)}
                style={{
                  width: 14,
                  height: 14,
                  flex: "none",
                  accentColor: "var(--accent)",
                  cursor: "pointer",
                }}
              />
              <span style={{ minWidth: 0, wordBreak: "break-word" }}>{item.text}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});
