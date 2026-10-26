import { anchorId } from "./settingsAnchor";
import {
  useSettingsStore,
  type DashboardTabEntry,
  type DashboardTabId,
} from "../../stores/settings";
import { t } from "../../i18n/t";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { SubGroup } from "./SubGroup";
import { Toggle } from "./Toggle";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { DashboardMiniPreview } from "./DashboardMiniPreview";
import { dashboardTabLabelKey, renderDashboardTabIcon } from "../../lib/dashboardTabs";
import { IconLayoutGrid } from "../icons";

/**
 * 설정 > 대시보드 — 히어로 + 미리보기(페이지 레벨) + 카드 1(탭 순서·활성 / 칸반 SubGroup).
 * 문구팩 카드(PhrasePacksSection)는 2026-10-19 문구와 함께 설정 › 브리핑으로 이사했다(GRILL-2026-10-19 R4).
 *
 * W7 §7.3 / W23-a: 대시보드 탭 순서 + 활성. 칩 클릭=토글, 드래그=순서.
 *
 * PLAN-2026-09-12 D10: `statusAddLocked`(상태 추가 잠금)가 "지역" 페이지에서 여기로 넘어왔다 —
 * 그건 지역이 아니라 **대시보드 칸반의 규칙**이다. 탭 구성과는 관심사가 갈리므로 카드 안
 * 하위 그룹으로 두고, 둘 사이에만 `--divider` 헤어라인 하나를 긋는다(DESIGN.md §설정 레이아웃 ②ⓑ).
 * PLAN-2026-09-15 §4: 헤더 없던 미리보기 카드는 이 카드의 SubGroup 으로, 칸반 하위블록은
 * `SubGroup divider` 로 — 손수 그린 제목 div 두 벌을 부품 하나로.
 */
export function DashboardTabsSection() {
  const dashboardTabs = useSettingsStore((s) => s.dashboardTabs);
  const setDashboardTabs = useSettingsStore((s) => s.setDashboardTabs);
  const statusAddLocked = useSettingsStore((s) => s.statusAddLocked);
  const setStatusAddLocked = useSettingsStore((s) => s.setStatusAddLocked);

  const items: ReorderItem[] = dashboardTabs.map((entry) => ({
    id: entry.id,
    label: t(dashboardTabLabelKey(entry.id)) || entry.id,
    icon: renderDashboardTabIcon(entry.id, 15),
    enabled: entry.enabled,
  }));
  const activeCount = dashboardTabs.filter((e) => e.enabled).length;

  const handleReorder = (newItems: ReorderItem[]) => {
    const next: DashboardTabEntry[] = newItems.map((item) => ({
      id: item.id as DashboardTabId,
      enabled: item.enabled !== false,
    }));
    void setDashboardTabs(next);
  };

  const handleToggle = (id: string, enabled: boolean) => {
    const next: DashboardTabEntry[] = dashboardTabs.map((entry) =>
      entry.id === id ? { ...entry, enabled } : entry,
    );
    void setDashboardTabs(next);
  };

  return (
    <>

      {/* 오너 2026-09-15: 미리보기(헤더 문구 + 탭 스트립)는 카드 밖 페이지 레벨 액자 하나. */}
      <DashboardMiniPreview />

      <div className="card" style={groupCardStyle} id={anchorId("dashboard_tabs")} data-testid="settings-dashboard-tabs">
        <SectionHeader
          title={t("settings.dashboard_top_tabs")}
          hint={t("settings.dashboard_top_tabs_hint")}
          icon={<IconLayoutGrid size={14} strokeWidth={2} />}
        />
        <div
          data-testid="settings-dashboard-tabs-caption"
          style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-3)" }}
        >
          {t("settings.dashboard_tabs_active_caption", { n: activeCount, m: dashboardTabs.length })}
        </div>
        <ReorderList
          items={items}
          onReorder={handleReorder}
          onToggle={handleToggle}
          testIdPrefix="dashboard-tabs"
        />

        {/* 이름은 탭 라벨의 단일 소스를 그대로 쓴다: 칸반(내부 식별자 board, docs/GLOSSARY.md). */}
        <SubGroup title={t("home.tab_board")} divider data-testid="settings-dashboard-board-group">
          <SettingsRow
            anchor="status_add_locked"
            label={t("settings.status_add_locked")}
            hint={t("settings.status_add_locked_hint")}
            control={
              <Toggle
                checked={statusAddLocked}
                onChange={(next) => void setStatusAddLocked(next)}
                aria-label={t("settings.status_add_locked")}
                data-testid="settings-status-add-locked"
              />
            }
          />
        </SubGroup>
      </div>
    </>
  );
}
