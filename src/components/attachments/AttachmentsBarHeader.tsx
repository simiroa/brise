import { t } from "../../i18n/t";
import { IconCaret } from "../icons";

interface AttachmentsBarHeaderProps {
  attachmentsCollapsed: boolean;
  attachmentsTab: "attachments" | "related";
  busy: boolean;
  itemCount: number;
  hiddenCount: number;
  onToggleCollapse: () => void;
  onExpand: () => void;
  onSelectTab: (tab: "attachments" | "related") => void;
  onRestoreHidden: () => void;
}

export function AttachmentsBarHeader({
  attachmentsCollapsed,
  attachmentsTab,
  busy,
  itemCount,
  hiddenCount,
  onToggleCollapse,
  onExpand,
  onSelectTab,
  onRestoreHidden,
}: AttachmentsBarHeaderProps) {
  return (
    <div
      data-testid="attachments-header"
      onClick={attachmentsCollapsed ? onExpand : undefined}
      style={{
        cursor: attachmentsCollapsed ? "pointer" : undefined,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--row-tabs)",
        boxSizing: "border-box",
        padding: "0 var(--space-4)",
      }}
    >
      <button
        type="button"
        className="icon-btn icon-btn--glow"
        onClick={onToggleCollapse}
        aria-expanded={!attachmentsCollapsed}
        aria-label={attachmentsCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        style={{ width: 18, height: 18, minHeight: 18, padding: 0 }}
      >
        {/* 첨부 바는 에디터 **아래**에서 위아래로 접힌다 — 트리 행의 오른쪽/아래 디스클로저와
            달리 수직 축이어야 한다. 접힘=위(눌러서 위로 펼침), 펼침=아래(눌러서 아래로 접힘).
            예전엔 접힘이 오른쪽(>)이라 실제 움직이는 방향과 어긋났다. */}
        <IconCaret
          dir={attachmentsCollapsed ? "up" : "down"}
          size={10}
          style={{ transition: "transform var(--dur-med)" }}
        />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
        <span
          onClick={() => onSelectTab("attachments")}
          style={{
            cursor: "pointer",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "var(--text-sm)",
            color: attachmentsTab === "attachments" ? "var(--text)" : "var(--faint)",
          }}
        >
          {t("attachments.title")}
        </span>
        <span
          onClick={() => onSelectTab("related")}
          style={{
            cursor: "pointer",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "var(--text-sm)",
            color: attachmentsTab === "related" ? "var(--text)" : "var(--faint)",
          }}
        >
          {t("related.title")}
        </span>
      </div>
      <span style={{ marginLeft: "var(--space-2)", fontSize: "var(--text-2xs)", color: "var(--muted)" }}>
        {t("attachments.n_items", { n: itemCount })}
      </span>
      {busy && (
        <span style={{ marginLeft: "var(--space-4)", fontSize: "var(--text-xs)", color: "var(--accent)" }}>…</span>
      )}
      {attachmentsTab === "related" && hiddenCount > 0 && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--muted)",
          }}
        >
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={onRestoreHidden}
            title={t("related.restore_hidden", { count: hiddenCount })}
            aria-label={t("related.restore_hidden", { count: hiddenCount })}
            style={{ color: "var(--muted)", fontSize: "var(--text-2xs)", padding: "0 8px", marginRight: "4px" }}
          >
            {t("related.restore_hidden", { count: hiddenCount })}
          </button>
        </div>
      )}
    </div>
  );
}
