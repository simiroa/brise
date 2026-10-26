import { t } from "../../i18n/t";
import { attachmentAddItems, type AttachmentAddHandlers } from "./attachmentAddItems";

type AttachmentsEmptyStateProps = AttachmentAddHandlers;

export function AttachmentsEmptyState({ onAddFile, onAddNote, onAddLink, onPasteClipboard }: AttachmentsEmptyStateProps) {
  const items = attachmentAddItems({ onAddFile, onAddNote, onAddLink, onPasteClipboard });
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "var(--space-3)",
      }}
    >
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        {items.map((item) => (
          <button
            key={item.testid}
            type="button"
            className="ghost-add"
            data-testid={item.testid}
            onClick={item.onClick}
            title={item.label}
            aria-label={item.label}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <span style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>
        {t("attachments.empty_hint")}
      </span>
    </div>
  );
}
