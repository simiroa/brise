import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";

interface MobileFolderNameModalProps {
  /** Modal title (새 폴더 / 이름 변경). */
  title: string;
  /** Label of the accent submit button. */
  submitLabel: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  /** Optional test hooks — only the rename dialog has them. */
  inputTestId?: string;
  submitTestId?: string;
}

/**
 * One-field "name this folder" dialog shared by the 노트 tree's new-folder and long-press-rename
 * flows (the two differ only in title, button label and what the parent does on submit). Enter
 * submits unless an IME composition is in flight; the text is pre-selected on focus so typing
 * replaces the default/old name.
 */
export function MobileFolderNameModal({
  title,
  submitLabel,
  value,
  onChange,
  onSubmit,
  onClose,
  inputTestId,
  submitTestId,
}: MobileFolderNameModalProps) {
  return (
    <MobileModal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="mobile-text-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="mobile-text-btn mobile-text-btn--accent"
            onClick={onSubmit}
            data-testid={submitTestId}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <input
        autoFocus
        className="mobile-modal-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        data-testid={inputTestId}
      />
    </MobileModal>
  );
}
