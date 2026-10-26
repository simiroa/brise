import type { Folder } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { IconFolder } from "../components/icons";

interface MobileFolderPickerProps {
  /** Caller filters (e.g. excludes inbox — same rule as desktop's NoteSelectionBar
   *  pickableFolders: "미분류로 옮기는 경로는 노출하지 않는다"). */
  folders: Folder[];
  onPick: (folderId: string) => void;
  onClose: () => void;
}

/** Mobile stand-in for desktop's drag-to-folder move (§3.4 — drag conflicts with touch scroll).
 *  MobileModal gives it the same centered/keyboard-safe shell every other mobile sheet uses. */
export function MobileFolderPicker({ folders, onPick, onClose }: MobileFolderPickerProps) {
  return (
    <MobileModal
      title={t("ctx.move_to_folder")}
      onClose={onClose}
      placement="bottom"
      footer={
        <button type="button" className="mobile-text-btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
      }
    >
      <div className="mobile-ai-actions mobile-modal-options">
        {folders.length === 0 && <div className="mobile-empty">{t("ctx.move_no_folders")}</div>}
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            className="menu-row mobile-ai-action"
            onClick={() => onPick(f.id)}
            style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}
          >
            <IconFolder size={15} strokeWidth={1.8} aria-hidden style={{ flex: "none" }} />
            {f.name}
          </button>
        ))}
      </div>
    </MobileModal>
  );
}
