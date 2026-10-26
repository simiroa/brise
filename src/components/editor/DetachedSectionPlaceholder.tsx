import type { NoteDetail, Section } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { IconExternalLink } from "../icons";
import { openSectionWindow, returnSectionWindow } from "../../stores/sectionWindows";

/** 분리된 섹션(stores/sectionWindows.ts)을 본 창에서 골랐을 때 편집기 자리. 배타 소유라 여기서는
 *  편집하지 않는다 — 창으로 가거나, 창을 닫아 여기로 되돌린다. */
export function DetachedSectionPlaceholder({ note, section }: { note: NoteDetail; section: Section }) {
  return (
    <div
      data-testid="detached-section-placeholder"
      role="status"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-5)",
        padding: "var(--space-7)",
        textAlign: "center",
        color: "var(--muted)",
      }}
    >
      <IconExternalLink size={22} strokeWidth={1.6} />
      <div style={{ color: "var(--text)", fontSize: "var(--text-md)", fontWeight: 600 }}>
        {t("sectionWindow.placeholder_title")}
      </div>
      <div style={{ fontSize: "var(--text-sm)", maxWidth: 360 }}>{t("sectionWindow.placeholder_body")}</div>
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="detached-focus-window"
          onClick={() => void openSectionWindow(note.note.id, section, note.note.title)}
        >
          {t("sectionWindow.focus_window")}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="detached-return-here"
          onClick={() => void returnSectionWindow(section.id)}
        >
          {t("sectionWindow.return_here")}
        </button>
      </div>
    </div>
  );
}
