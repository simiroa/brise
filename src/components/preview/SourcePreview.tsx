import type { Source } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { MarkdownBody } from "./MarkdownBody";

export function SourcePreview({ src }: { src: Source }) {
  return (
    <div className="scroll" style={{ flex: 1, padding: 20, overflow: "auto" }}>
      <div
        className="label-caps"
        style={{
          color: "var(--accent)",
          marginBottom: "var(--space-1)",
        }}
      >
        {src.name}
      </div>
      <div style={{ height: 2, background: "var(--divider)", marginBottom: 12 }} />
      {src.truncated && (
        <div
          data-testid="source-truncated"
          style={{
            marginBottom: "var(--space-2)",
            fontSize: "var(--text-xs)",
            color: "var(--muted)",
          }}
        >
          {t("sources.body_truncated")}
        </div>
      )}
      <MarkdownBody text={src.body} />
    </div>
  );
}
