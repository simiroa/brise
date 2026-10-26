import type { MouseEvent as ReactMouseEvent } from "react";
import { t } from "../../i18n/t";
import { IconPlus } from "../icons";
import { RelatedEmptyState } from "./RelatedEmptyState";
import { RelatedTileItem } from "./RelatedTileItem";
import type { RelatedTile } from "./useRelatedTiles";
import type { Tile } from "./useAttachmentActions";

interface RelatedTilesStripProps {
  relatedTiles: RelatedTile[];
  attachDragCollapsing: boolean;
  panStrip: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onSchedulePreview: (targetId: string) => void;
  onOpenNote: (targetId: string) => void;
  onOpenInternalDialog: () => void;
  onDeleteManual: (e: ReactMouseEvent, tile: Tile) => void;
  onExcludeAuto: (e: ReactMouseEvent, noteId: string, displayName: string) => void;
  onAcceptSuggestion?: (e: ReactMouseEvent, tile: RelatedTile) => void;
}

export function RelatedTilesStrip({
  relatedTiles,
  attachDragCollapsing,
  panStrip,
  onSchedulePreview,
  onOpenNote,
  onOpenInternalDialog,
  onDeleteManual,
  onExcludeAuto,
  onAcceptSuggestion,
}: RelatedTilesStripProps) {
  return (
    <div
      className="scroll noscroll"
      onMouseDown={panStrip}
      style={{
        display: "flex",
        flexWrap: "nowrap",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: attachDragCollapsing ? 0 : "var(--space-2) var(--space-5) var(--space-5)",
        minHeight: attachDragCollapsing ? 0 : "var(--row-strip)",
        maxHeight: attachDragCollapsing ? 0 : "var(--row-strip)",
        overflowX: "auto",
        overflowY: "hidden",
        boxSizing: "border-box",
      }}
    >
      {relatedTiles.length === 0 && (
        <RelatedEmptyState onAddInternal={onOpenInternalDialog} />
      )}
      {relatedTiles.map((tile) => {
        const isManual = tile.kind === "manual";
        const key = isManual ? `related-manual-${tile.attachment.id}` : `related-auto-${tile.note.id}`;
        return (
          <RelatedTileItem
            key={key}
            tile={tile}
            onPreview={onSchedulePreview}
            onOpen={onOpenNote}
            onDeleteManual={onDeleteManual}
            onExcludeAuto={onExcludeAuto}
            onAcceptSuggestion={onAcceptSuggestion}
          />
        );
      })}
      {relatedTiles.length > 0 && (
        <button
          type="button"
          className="ghost-add"
          data-testid="related-add-internal"
          onClick={onOpenInternalDialog}
          title={t("related.add_hint")}
          aria-label={t("related.add_hint")}
        >
          <IconPlus size={16} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}
