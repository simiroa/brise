import type { RefObject } from "react";
import { t } from "../../i18n/t";
import { IconImage } from "../icons";

interface AttachmentsBarEmptyProps {
  barRef: RefObject<HTMLDivElement | null>;
  dragOver: boolean;
}

/**
 * Teaching empty state: always rendered, non-interactive, explains the dropzone even
 * before a note exists.
 */
export function AttachmentsBarEmpty({ barRef, dragOver }: AttachmentsBarEmptyProps) {
  return (
    <div
      ref={barRef}
      style={{
        flex: "none",
        borderTop: "1px solid var(--divider)",
        padding: "var(--space-2) var(--space-6) var(--space-5)",
        minHeight: "var(--row-strip)",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          flex: 1,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-4)",
          border: dragOver ? "1px dashed var(--accent)" : "1px dashed var(--divider)",
          borderRadius: "var(--radius-sm)",
          color: "var(--faint)",
          fontSize: "var(--text-sm)",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        <IconImage size={16} strokeWidth={1.6} style={{ opacity: 0.6 }} />
        <span>{t("attachments.no_note_hint")}</span>
      </div>
    </div>
  );
}
