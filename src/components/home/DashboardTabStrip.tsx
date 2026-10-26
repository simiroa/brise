import { useRef, type CSSProperties } from "react";
import { type HomeInnerTab } from "../../stores/ui";
import { DASHBOARD_TABS, renderDashboardTabIcon } from "../../lib/dashboardTabs";
import { t } from "../../i18n/t";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";

export interface DashboardTabStripProps {
  activeId?: HomeInnerTab;
  onSelect?: (id: HomeInnerTab) => void;
  /** 탭을 열 의도(마우스 올림·포커스·누르기 시작) — 그 탭의 지연 화면을 미리 받는다(HomeTab). */
  onTabIntent?: (id: HomeInnerTab) => void;
  interactive?: boolean;
  orderedTabs?: Array<{ id: HomeInnerTab; labelKey: string }>;
  className?: string;
  style?: CSSProperties;
}

/**
 * Dashboard inner tabs strip (칸반 / 캘린더 / 타임라인 / 지도 / 그래프).
 * HomeTab의 실 탭바 및 Settings / Onboarding의 실물 축소 미리보기(DashboardMiniPreview)가
 * 함께 공유하는 단일 렌더 소스.
 */
export function DashboardTabStrip({
  activeId,
  onSelect,
  onTabIntent,
  interactive = true,
  orderedTabs = DASHBOARD_TABS,
  className,
  style,
}: DashboardTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(stripRef, { axis: "x", itemSelector: "[data-home-tab]" });

  return (
    <div
      ref={stripRef}
      data-testid="home-inner-tabs-left"
      className={className ? `tag-strip-pan fh-host ${className}` : "tag-strip-pan fh-host"}
      {...hover.handlers}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
        flexWrap: "nowrap",
        overflowX: "auto",
        ...style,
      }}
    >
      <FluidHoverHighlight hover={hover} />
      {orderedTabs.map(({ id, labelKey }) => {
        const on = activeId === id;
        const intent = interactive && onTabIntent ? () => onTabIntent(id) : undefined;
        return (
          <button
            key={id}
            type="button"
            data-home-tab={id}
            data-fh-item="true"
            data-active={on ? "true" : undefined}
            onClick={interactive && onSelect ? () => onSelect(id) : undefined}
            onPointerEnter={intent}
            onFocus={intent}
            onPointerDown={intent}
            tabIndex={interactive ? 0 : -1}
            title={interactive ? t(labelKey) : undefined}
            aria-label={t(labelKey)}
            className="home-tab-btn"
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: on ? "var(--accent)" : "var(--muted)",
              padding: "var(--space-2) var(--space-6)",
              borderRadius: "var(--radius-sm)",
              background: on ? "var(--sel)" : "transparent",
              border: on ? "1px solid var(--divider)" : "1px solid transparent",
              cursor: interactive ? "pointer" : "default",
              flex: "none",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              pointerEvents: interactive ? "auto" : "none",
            }}
          >
            <span className="home-tab-icon" aria-hidden="true">
              {renderDashboardTabIcon(id, 14)}
            </span>
            <span className="home-tab-label">
              {t(labelKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
