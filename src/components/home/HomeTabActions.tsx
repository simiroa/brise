import { useState } from "react";
import { createPortal } from "react-dom";
import type { HomeInnerTab } from "../../stores/ui";
import { useUiStore } from "../../stores/ui";
import { useFloatingPopover, popoverRoot } from "../../lib/ui";
import { t } from "../../i18n/t";
import { IconFilter } from "../icons";
import { FolderDotFilter } from "./FolderDotFilter";

/**
 * Top dashboard actions — the folder filter only (2026-09-08 owner: the "add status" button and
 * the status-filter popover that used to sit here were kanban leftovers; status add now lives at
 * the far right of the board's own column row (BoardPane), and status filtering stays in the
 * sidebar FilterModal). The compact layout keeps its single trigger for narrow widths, opening
 * the same folder dots in a popover.
 *
 * [Design Rule 2026-09-11]: 라인글로우(icon-btn--glow)는 편집·기능 조작 아이콘 레벨에 적용하며,
 * 대시보드 탭이나 화면 전환 수준의 네비게이션 트리거에는 적용하지 않고 기존 구조를 유지한다.
 */
export function HomeTabActions({
  homeInnerTab: _homeInnerTab,
}: {
  homeInnerTab?: HomeInnerTab;
}) {
  const folderFilter = useUiStore((s) => s.dashboardFolderFilter);
  const [compactOpen, setCompactOpen] = useState(false);
  const {
    anchorRef: compactAnchorRef,
    popRef: compactPopRef,
    x: compactX,
    y: compactY,
  } = useFloatingPopover(compactOpen, () => setCompactOpen(false));

  return (
    <div
      data-testid="home-inner-tabs-right"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "var(--space-2)",
        minWidth: 0,
      }}
    >
      {/* Full layout (wide) */}
      <div className="home-filters-full">
        <FolderDotFilter />
      </div>

      {/* L4 Compact layout: the dots collapse into one trigger at the same position */}
      <div className="home-filters-compact" ref={compactAnchorRef}>
        <button
          type="button"
          data-testid="home-compact-filter-btn"
          data-active={folderFilter ? "true" : undefined}
          onClick={() => setCompactOpen((v) => !v)}
          className="chip-btn"
          title={t("ai.field_folder")}
          aria-label={t("ai.field_folder")}
        >
          <IconFilter size={13} strokeWidth={1.8} />
        </button>

        {compactOpen &&
          createPortal(
            <div
              ref={compactPopRef}
              className="overlay"
              data-testid="home-compact-filter-popover"
              style={{
                position: "fixed",
                left: Math.max(8, compactX - 160),
                top: compactY,
                zIndex: "var(--z-dropdown)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-3)",
                width: 260,
                maxHeight: 340,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
                overflow: "auto",
              }}
            >
              <FolderDotFilter />
            </div>,
            popoverRoot(compactAnchorRef.current),
          )}
      </div>
    </div>
  );
}
