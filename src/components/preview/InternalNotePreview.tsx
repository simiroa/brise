import type { Attachment } from "../../lib/commands.gen";
import { IconNote } from "../icons";
import { t } from "../../i18n/t";

export function InternalNotePreview({
  att,
  onSelectNote,
}: {
  att: Attachment;
  onSelectNote: (id: string) => void;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      <div
        onClick={() => att.url && onSelectNote(att.url)}
        style={{ width: 260, padding: 20, background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: "var(--radius-md)", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, boxShadow: "var(--shadow-lg)" }}
      >
        <IconNote size={24} style={{ color: "var(--accent)" }} />
        <div>
          <div style={{ fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--text)" }}>{att.name}</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-1)" }}>{t("attachments.preview_internal_label")}</div>
        </div>
      </div>
    </div>
  );
}
