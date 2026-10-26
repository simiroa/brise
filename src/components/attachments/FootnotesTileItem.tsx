import type { KeyboardEvent } from "react";
import { t } from "../../i18n/t";
import { IconQuote } from "../icons";
import type { PreviewItem } from "../../stores/ui";
import { AttachmentTile, TileLabel } from "./AttachmentTile";

interface FootnotesTileItemProps {
  /** Owned by AttachmentsTilesStrip — same object it uses for `active`/onKeyDown, so there's
   * one source of truth for what "this tile" means instead of the tile rebuilding it. */
  item: PreviewItem;
  footnoteCount: number;
  active: boolean;
  onSchedulePreview: (item: PreviewItem) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function FootnotesTileItem({
  item,
  footnoteCount,
  active,
  onSchedulePreview,
  onKeyDown,
}: FootnotesTileItemProps) {
  const display = `${t("attachments.preview_footnote")} ${footnoteCount}`;
  const full = `${t("attachments.preview_footnotes")} · ${footnoteCount}`;

  return (
    <AttachmentTile
      role="button"
      tabIndex={0}
      onClick={() => onSchedulePreview(item)}
      onKeyDown={onKeyDown}
      active={active}
      ariaLabel={full}
      title={full}
      color="var(--accent)"
      content={<TileLabel icon={<IconQuote size={16} strokeWidth={1.8} />} text={display} />}
      hoverContent={<TileLabel icon={<IconQuote size={22} strokeWidth={1.6} />} text={full} hover />}
    />
  );
}
