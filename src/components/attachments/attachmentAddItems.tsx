import { t } from "../../i18n/t";
import { IconClipboard, IconFile, IconLink, IconNote } from "../icons";
import type { GhostAddItem } from "./GhostAddButton";

export interface AttachmentAddHandlers {
  onAddFile: () => void;
  onAddNote: () => void;
  onAddLink: () => void;
  onPasteClipboard?: () => void;
}

/** Single source of truth for the file/note/link/clipboard add-actions. */
export function attachmentAddItems(
  { onAddFile, onAddNote, onAddLink, onPasteClipboard }: AttachmentAddHandlers,
  iconSize = 16,
  strokeWidth = 1.8,
): GhostAddItem[] {
  const items: GhostAddItem[] = [
    {
      testid: "attachments-add-file",
      icon: <IconFile size={iconSize} strokeWidth={strokeWidth} />,
      label: t("attachments.choice_file"),
      onClick: onAddFile,
    },
    {
      testid: "attachments-add-note",
      icon: <IconNote size={iconSize} strokeWidth={strokeWidth} />,
      label: t("attachments.choice_note"),
      onClick: onAddNote,
    },
    {
      testid: "attachments-add-link",
      icon: <IconLink size={iconSize} strokeWidth={strokeWidth} />,
      label: t("attachments.choice_link"),
      onClick: onAddLink,
    },
  ];

  if (onPasteClipboard) {
    items.push({
      testid: "attachments-add-clipboard",
      icon: <IconClipboard size={iconSize} strokeWidth={strokeWidth} />,
      label: t("attachments.choice_clipboard"),
      onClick: onPasteClipboard,
    });
  }

  return items;
}
