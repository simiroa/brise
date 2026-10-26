import React from "react";
import type { RowComponentProps } from "react-window";
import { displayTitle } from "../../../stores/notes";
import type { NoteSummary } from "../../../lib/commands.gen";
import { startNoteDrag } from "../../../lib/noteDrag";
import { NoteIcon } from "../NoteIconControl";
import { splitByQuery, HighlightedText } from "../notetree/highlight";

export const TAGS_RESULT_ROW_HEIGHT = 44;

export interface TagsExpandedNoteRowProps {
  notes: NoteSummary[];
  activeId: string | null;
  query?: string;
  onSelectNote: (id: string) => void;
  onOpenCtx?: (id: string, x: number, y: number) => void;
}

function TagsExpandedNoteRowImpl({
  index,
  style,
  notes,
  activeId,
  query,
  onSelectNote,
  onOpenCtx,
}: RowComponentProps<TagsExpandedNoteRowProps>): React.ReactElement | null {
  const n = notes[index];
  if (!n) return null;

  const isSelected = n.id === activeId;
  const titleText = displayTitle(n.title);
  const titleSegments = splitByQuery(titleText, query ?? "");

  return (
    <div style={{ ...style, display: "flex", alignItems: "stretch" }}>
      <button
        type="button"
        className="treerow menu-row menu-item"
        data-selected={isSelected}
        data-note-id={n.id}
        onPointerDown={(e) => startNoteDrag(e, n.id, titleText)}
        onClick={() => onSelectNote(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (onOpenCtx) onOpenCtx(n.id, e.clientX, e.clientY);
        }}
        style={{
          gap: "var(--space-2)",
          padding: "var(--space-1) var(--sidebar-pad) var(--space-1) var(--space-3)",
          position: "relative",
          boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : undefined,
          background: isSelected ? "var(--sel)" : undefined,
          height: "100%",
          width: "100%",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <NoteIcon icon={n.icon} size={15} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: 400,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--text)",
            }}
          >
            <HighlightedText segments={titleSegments} />
          </div>
          <div style={{ fontSize: "var(--text-label)", color: "var(--muted)" }}>
            {n.year}
            {n.tag_names.length > 0 && ` · #${n.tag_names.join(" #")}`}
          </div>
        </div>
      </button>
    </div>
  );
}

export const TagsExpandedNoteRow = React.memo(
  TagsExpandedNoteRowImpl,
) as unknown as (props: RowComponentProps<TagsExpandedNoteRowProps>) => React.ReactElement | null;
