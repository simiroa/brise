import type { KeyboardEvent } from "react";
import { t } from "../../i18n/t";
import { IconPin } from "../icons";
import type { PreviewItem } from "../../stores/ui";
import { AttachmentTile, TileLabel } from "./AttachmentTile";
import type { PrimaryRegion, WaypointRegion } from "./regionDisplay";

interface RegionTileItemProps {
  /** Owned by AttachmentsTilesStrip — same object it uses for `active`/onKeyDown, so there's
   * one source of truth for what "this tile" means instead of the tile rebuilding it. */
  item: PreviewItem;
  regionPrimary: PrimaryRegion;
  regionWaypointsVisible: WaypointRegion[];
  active: boolean;
  onTogglePreview: (item: PreviewItem) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function RegionTileItem({
  item,
  regionPrimary,
  regionWaypointsVisible,
  active,
  onTogglePreview,
  onKeyDown,
}: RegionTileItemProps) {
  const label = regionPrimary.region || t("note.add_region");
  const display =
    regionWaypointsVisible.length > 0 ? `${label} +${regionWaypointsVisible.length}` : label;

  return (
    <AttachmentTile
      role="button"
      tabIndex={0}
      onClick={() => onTogglePreview(item)}
      onKeyDown={onKeyDown}
      active={active}
      ariaLabel={display}
      title={display}
      color="var(--accent)"
      content={<TileLabel icon={<IconPin size={16} strokeWidth={1.8} />} text={display} />}
      hoverContent={<TileLabel icon={<IconPin size={22} strokeWidth={1.6} />} text={display} hover />}
    />
  );
}
