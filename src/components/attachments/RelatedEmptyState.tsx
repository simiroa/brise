import { t } from "../../i18n/t";
import { IconPlus } from "../icons";

interface RelatedEmptyStateProps {
  onAddInternal: () => void;
}

export function RelatedEmptyState({ onAddInternal }: RelatedEmptyStateProps) {
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
      <button
        type="button"
        className="ghost-add"
        data-testid="related-add-internal"
        onClick={onAddInternal}
        title={t("related.add_hint")}
        aria-label={t("related.add_hint")}
      >
        <IconPlus size={16} strokeWidth={1.8} />
      </button>
      <span style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>
        {t("related.empty_hint")}
      </span>
    </div>
  );
}
