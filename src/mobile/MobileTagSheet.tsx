import { useState } from "react";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";

interface MobileTagSheetProps {
  onSubmit: (tagNames: string[]) => void;
  onClose: () => void;
}

/** Mobile stand-in for the desktop selection bar's tag PromptDialog (mode="input") — comma-
 *  separated names, union-added onto whatever tags the note(s) already have (addNoteTags never
 *  replaces). Single input, not a per-tag picker: desktop's own bulk "태그 추가" action uses the
 *  same one-field shape (selection.add_tags_hint/_placeholder), so this isn't a new UX to learn. */
export function MobileTagSheet({ onSubmit, onClose }: MobileTagSheetProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const names = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    onSubmit(names);
  };

  return (
    <MobileModal
      title={t("selection.add_tags")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="mobile-text-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={commit}>
            {t("common.apply")}
          </button>
        </>
      }
    >
      <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: "0 0 var(--space-3)" }}>
        {t("selection.add_tags_hint")}
      </p>
      <input
        autoFocus
        className="mobile-modal-input"
        value={draft}
        placeholder={t("selection.add_tags_placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </MobileModal>
  );
}
