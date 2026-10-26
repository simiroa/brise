import type { KeyboardEvent, MouseEvent } from "react";
import { t } from "../../i18n/t";
import { IconNote } from "../icons";
import type { Source } from "../../lib/commands.gen";
import { AttachmentTile, TileLabel } from "./AttachmentTile";
import type { Tile } from "./useAttachmentActions";

interface SourceTileItemProps {
  source: Source;
  selected: boolean;
  active: boolean;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onDelete: (e: MouseEvent, tile: Tile) => void;
  /** "섹션으로 가져오기" — 사료 타일은 항상 승격 가능(Source.body 가 이미 프런트에 있다). */
  onContextMenu: (e: MouseEvent) => void;
}

export function SourceTileItem({
  source: s,
  selected,
  active,
  onClick,
  onDoubleClick,
  onKeyDown,
  onDelete,
  onContextMenu,
}: SourceTileItemProps) {
  const tile: Tile = { kind: "source", source: s };

  return (
    <AttachmentTile
      role="button"
      tabIndex={0}
      selected={selected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      active={active}
      ariaLabel={s.name}
      title={`${s.name}\n${s.ext.toUpperCase()}\n${t("attachments.rename_hint")}`}
      color="var(--accent)"
      onDelete={(e) => onDelete(e, tile)}
      deleteLabel={t("attachments.remove")}
      deleteStopsKeyDownPropagation
      content={<TileLabel icon={<IconNote size={16} strokeWidth={1.8} />} text={s.ext.substring(0, 4)} uppercase />}
      hoverContent={<TileLabel icon={<IconNote size={22} strokeWidth={1.6} />} text={s.name} hover />}
    />
  );
}
