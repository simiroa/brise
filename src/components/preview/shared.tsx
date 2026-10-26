import type { CSSProperties, ReactNode } from "react";
import { IconExternalLink } from "../icons";
import { t } from "../../i18n/t";

export const centeredHintStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--faint)",
  fontSize: "var(--text-md)",
};

/**
 * The verbatim-duplicated `<pre>` body shared by SourcePreview, NotePreview and
 * FootnotePreview (source/memo bodies, related-note first-section bodies and footnote
 * bodies get the exact same plain-text treatment).
 *
 * Typography audit (footnote wave): this was 12px/1.7 while FootnotePreview's list carried
 * a near-identical inline 12px/1.6 copy. One renderer now, at --text-md/1.6 — body prose is
 * the largest tier in a preview pane, above the --text-sm anchor quote and the label-caps
 * headers.
 */
export function PlainTextBody({ text }: { text: string }) {
  return (
    <pre
      className="scroll"
      style={{
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        // Task 1 (typography audit): source/memo bodies are user-authored editable content,
        // not code — same rule as the note title/editor body ("editable content = serif").
        // This was hardcoded to a monospace family instead of referencing a token; the memo
        // paste textarea (PromptDialog.tsx) gets the matching serif treatment via a tokens.css
        // selector (textarea.field), since that file isn't in this pass's edit scope.
        fontFamily: "var(--font-editor)",
        fontSize: "var(--text-md)",
        lineHeight: 1.6,
        color: "var(--text)",
        opacity: 0.9,
      }}
    >
      {text}
    </pre>
  );
}

/**
 * Shared "no format / open externally" fallback card — used whenever a preview
 * can't render inline (attachments base dir unresolved, or an unrenderable
 * doc format).
 */
export function NoFormatFallback({
  icon,
  onOpenExternal,
  hint,
}: {
  icon: ReactNode;
  onOpenExternal: () => void;
  /** 왜 미리보기가 없는지 한 줄. 없으면 기존의 일반 문구만 나온다. */
  hint?: string;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      {icon}
      <div style={{ fontSize: "var(--text-md)", color: "var(--muted)" }}>{hint ?? t("attachments.preview_no_format")}</div>
      <button onClick={onOpenExternal} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", background: "var(--surface)", border: "1px solid var(--divider)", borderRadius: "var(--radius-sm)", color: "var(--text)", cursor: "pointer" }}>
        <IconExternalLink size={14} /> {t("attachments.preview_open_external")}
      </button>
    </div>
  );
}
