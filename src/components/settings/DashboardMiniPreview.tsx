import { useMemo } from "react";
import { useSettingsStore } from "../../stores/settings";
import { orderedVisibleTabs } from "../../lib/dashboardTabs";
import { DashboardTabStrip } from "../home/DashboardTabStrip";
import { HomeHeader } from "../home/HomeHeader";

/**
 * Settings / Onboarding: 대시보드 상단(헤더 밴드 + 탭 스트립) 실물 축소 미리보기(scale 0.6).
 * 2026-10-19 R14 로 헤더에서 문구가 빠져 밴드가 낮아졌다(HomeHeader.tsx 상단 주석) — 문구 미리보기는 이제 없다.
 * 오너 2026-09-15: 실제 대시보드처럼 헤더와 탭이 붙어 있으니 미리보기도 하나로 — 문구팩 카드의
 * 별도 헤더 미리보기는 여기로 합쳤다. 카드 밖 페이지 레벨 액자(R1).
 */
export function DashboardMiniPreview() {
  const dashboardTabs = useSettingsStore((s) => s.dashboardTabs);

  const visibleTabs = useMemo(() => orderedVisibleTabs(dashboardTabs), [dashboardTabs]);

  const firstActiveTabId = visibleTabs[0]?.id ?? "board";

  return (
    <div
      data-testid="settings-dashboard-mini-preview"
      aria-hidden="true"
      style={{
        border: "1px solid var(--divider)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        background: "var(--app-canvas, transparent)",
        pointerEvents: "none",
        userSelect: "none",
        position: "relative",
        height: 128,
      }}
    >
      <div
        style={{
          width: "166.66%",
          transform: "scale(0.6)",
          transformOrigin: "top left",
        }}
      >
        <HomeHeader />
        <div style={{ padding: "var(--space-5) var(--content-inset) var(--space-4)" }}>
          <DashboardTabStrip activeId={firstActiveTabId} interactive={false} orderedTabs={visibleTabs} />
        </div>
      </div>
    </div>
  );
}

