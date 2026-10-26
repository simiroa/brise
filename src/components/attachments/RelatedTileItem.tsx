import type { MouseEvent } from "react";
import { t } from "../../i18n/t";
import { displayTitle } from "../../stores/notes";
import { NoteIcon } from "../leftpanel/NoteIconControl";
import { AttachmentTile } from "./AttachmentTile";
import type { RelatedTile } from "./useRelatedTiles";
import type { Tile } from "./useAttachmentActions";

interface RelatedTileItemProps {
  tile: RelatedTile;
  onPreview: (targetId: string) => void;
  onOpen: (targetId: string) => void;
  onDeleteManual: (e: MouseEvent, tile: Tile) => void;
  onExcludeAuto: (e: MouseEvent, noteId: string, displayName: string) => void;
  onAcceptSuggestion?: (e: MouseEvent, tile: RelatedTile) => void;
}

export function RelatedTileItem({
  tile,
  onPreview,
  onOpen,
  onDeleteManual,
  onExcludeAuto,
  onAcceptSuggestion,
}: RelatedTileItemProps) {
  const isManual = tile.kind === "manual";
  const hasSuggestion = tile.kind === "auto" && Boolean(tile.suggestion);
  const note = tile.note;
  const displayName = note ? displayTitle(note.title) : isManual ? tile.attachment.name : "";
  const year = note?.year;
  const icon = note?.icon ?? null;
  const marker = t(
    isManual
      ? "related.manual_label"
      : hasSuggestion
      ? "related.smart_link_suggest"
      : "related.auto_label",
  );
  const targetId = isManual ? tile.attachment.url : tile.note.id;

  return (
    <AttachmentTile
      role="button"
      tabIndex={0}
      onClick={() => {
        if (targetId) onPreview(targetId);
      }}
      onDoubleClick={() => {
        if (targetId) onOpen(targetId);
      }}
      onKeyDown={(e) => {
        if (!targetId) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(targetId);
        }
      }}
      ariaLabel={`${displayName}${year != null ? ` (${year})` : ""} · ${marker}`}
      title={`${displayName}${year != null ? `\n${year}` : ""} · ${marker}`}
      color={isManual ? "var(--accent)" : hasSuggestion ? "var(--accent)" : "var(--muted)"}
      opacity={isManual ? 1 : 0.85}
      marker={isManual}
      smartBadge={
        hasSuggestion ? (
          <button
            type="button"
            className="attach-smart-badge"
            data-testid="related-smart-link-badge"
            onClick={(e) => {
              e.stopPropagation();
              onAcceptSuggestion?.(e, tile);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onAcceptSuggestion?.(e as never, tile);
              }
            }}
            aria-label={t("related.smart_link_suggest")}
            title={t("related.smart_link_tooltip")}
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              border: "1px solid var(--accent)",
              background: "var(--surface-raised)",
              color: "var(--accent)",
              display: "grid",
              placeItems: "center",
              fontSize: "10px",
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
              boxShadow: "var(--shadow-sm)",
            }}
          >
            💡
          </button>
        ) : undefined
      }
      onDelete={
        isManual
          ? (e) => onDeleteManual(e, { kind: "attachment", attachment: tile.attachment })
          : (e) => onExcludeAuto(e, tile.note.id, displayName)
      }
      deleteLabel={t("attachments.remove")}
      deleteStopsKeyDownPropagation
      content={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "0 var(--space-2)", maxWidth: "100%" }}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
            <NoteIcon icon={icon} size={16} />
            {hasSuggestion && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -6,
                  fontSize: "8px",
                  lineHeight: 1,
                }}
                title={t("related.smart_link_suggest")}
              >
                💡
              </span>
            )}
          </div>
          <span
            style={{
              fontSize: "var(--text-2xs)",
              fontWeight: 600,
              color: hasSuggestion ? "var(--accent)" : "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "100%",
            }}
          >
            {displayName}
          </span>
        </div>
      }
      hoverContent={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-3)", maxWidth: "100%", overflow: "hidden" }}>
          <NoteIcon icon={icon} size={20} />
          <span
            style={{
              fontSize: "var(--text-2xs)",
              fontWeight: 600,
              color: "var(--text)",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "100%",
            }}
          >
            {displayName}
          </span>
          {hasSuggestion && (
            <span
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--accent)",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2xs)",
              }}
            >
              💡 {t("related.smart_link_badge")}
            </span>
          )}
        </div>
      }
    />
  );
}
