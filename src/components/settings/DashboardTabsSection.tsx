import type { ComponentType } from "react";
import { anchorId } from "./settingsAnchor";
import { useSettingsStore, type DashboardTabEntry, type DashboardTabId } from "../../stores/settings";
import {
  BOARD_DONE_AUTOHIDE,
  TIMELINE_RANGES,
  type BoardDoneAutohide,
  type TimelineDefaultRange,
} from "../../stores/prefs";
import { t } from "../../i18n/t";
import { optionsOf } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { Select } from "../Select";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { DashboardMiniPreview } from "./DashboardMiniPreview";
import { dashboardTabLabelKey, renderDashboardTabIcon } from "../../lib/dashboardTabs";
import { Badge } from "./Badge";
import { IconLayoutGrid } from "../icons";

/**
 * 설정 > 대시보드 — 탭 순서·활성(프레임 없는 칩 줄) + **켜진 탭마다 하위 설정 카드** + 맨 아래 미리보기.
 * 문구팩 카드(PhrasePacksSection)는 2026-10-19 문구와 함께 설정 › 브리핑으로 이사했다(GRILL-2026-10-19 R4).
 *
 * W7 §7.3 / W23-a: 대시보드 탭 순서 + 활성. 칩 클릭=토글, 드래그=순서.
 *
 * 하위 설정은 탭별 컴포넌트(`TimelineTabSettings`·`BoardTabSettings`·`GraphTabSettings`)가 갖고, `TAB_SETTINGS` 맵이 탭 id 로 고른다 —
 * 카드 하나가 모든 탭의 설정값을 한꺼번에 구독하던 구조를 걷어냈다(구독은 그 탭의 컴포넌트만). 맵에 없는 탭(달력·지도)은 카드를 만들지 않는다.
 * PLAN-2026-09-12 D10: `statusAddLocked`(상태 추가 잠금)는 지역이 아니라 **대시보드 칸반의 규칙**이라 칸반(board) 카드에 둔다.
 * 선택지 값 목록은 stores/prefs.ts 의 `as const` 배열 — 라벨 맵이 모든 값을 덮어야 컴파일된다(shared.ts::optionsOf).
 */
export function DashboardTabsSection() {
  const dashboardTabs = useSettingsStore((s) => s.dashboardTabs);
  const setDashboardTabs = useSettingsStore((s) => s.setDashboardTabs);

  // 첫 번째로 **켜진** 탭이 앱을 열면 처음 보이는 화면이다 — 순서를 바꾸면 배지가 따라간다.
  const startId = dashboardTabs.find((e) => e.enabled)?.id;
  const items: ReorderItem[] = dashboardTabs.map((entry) => ({
    id: entry.id,
    label: t(dashboardTabLabelKey(entry.id)) || entry.id,
    icon: renderDashboardTabIcon(entry.id, 15),
    enabled: entry.enabled,
    badge: entry.id === startId ? (
      <span data-testid="dashboard-tabs-start-badge">
        <Badge>{t("settings.dashboard_start_badge")}</Badge>
      </span>
    ) : undefined,
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

      {/* 탭 칩 줄은 프레임(카드) 없이 — 제목 아래 한 줄(2026-10-28). */}
      <div id={anchorId("dashboard_tabs")} data-testid="settings-dashboard-tabs">
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

      </div>

      {/* 켜진 탭의 하위 설정을 탭 순서대로 전부 아래에 펼친다(접힘 없음, 2026-10-27). 꺼진 탭의 설정은 숨긴다.
          설정이 없는 탭(타임라인·지도)은 카드를 만들지 않는다. */}
      {dashboardTabs
        .filter((e) => e.enabled)
        .map((e) => (
          <DashboardTabSettingsCard key={e.id} id={e.id} />
        ))}

      {/* 미리보기(헤더 문구 + 탭 스트립)는 설정을 다 본 뒤 맨 아래 — 오너 2026-10-28(2026-09-15 은 카드 밖 액자 하나였다). */}
      <DashboardMiniPreview />
    </>
  );
}

const TIMELINE_RANGE_LABELS: Record<TimelineDefaultRange, () => string> = {
  fit: () => t("settings.timeline_range_fit"),
  around_now: () => t("settings.timeline_range_around_now"),
  recent_3m: () => t("settings.timeline_range_recent_3m"),
  recent_1y: () => t("settings.timeline_range_recent_1y"),
};

const BOARD_DONE_AUTOHIDE_LABELS: Record<BoardDoneAutohide, () => string> = {
  off: () => t("settings.board_done_autohide_off"),
  "7d": () => t("settings.board_done_autohide_7d"),
  "30d": () => t("settings.board_done_autohide_30d"),
};

function TimelineTabSettings() {
  const timelineRange = useSettingsStore((s) => s.timelineDefaultRange);
  const setTimelineRange = useSettingsStore((s) => s.setTimelineDefaultRange);
  return (
    <SettingsRow
      anchor="timeline_default_range"
      label={t("settings.timeline_default_range")}
      hint={t("settings.timeline_default_range_hint")}
      control={
        <Select
          value={timelineRange}
          onChange={(v) => void setTimelineRange(v as TimelineDefaultRange)}
          ariaLabel={t("settings.timeline_default_range")}
          options={optionsOf(TIMELINE_RANGES, TIMELINE_RANGE_LABELS)}
        />
      }
    />
  );
}

function BoardTabSettings() {
  const statusAddLocked = useSettingsStore((s) => s.statusAddLocked);
  const setStatusAddLocked = useSettingsStore((s) => s.setStatusAddLocked);
  const doneAutohide = useSettingsStore((s) => s.boardDoneAutohide);
  const setDoneAutohide = useSettingsStore((s) => s.setBoardDoneAutohide);
  const cardThumb = useSettingsStore((s) => s.boardCardThumb);
  const setCardThumb = useSettingsStore((s) => s.setBoardCardThumb);
  const cardDate = useSettingsStore((s) => s.boardCardDate);
  const setCardDate = useSettingsStore((s) => s.setBoardCardDate);
  return (
    <>
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
      <SettingsRow
        anchor="board_done_autohide"
        label={t("settings.board_done_autohide")}
        hint={t("settings.board_done_autohide_hint")}
        control={
          <Select
            value={doneAutohide}
            onChange={(v) => void setDoneAutohide(v as BoardDoneAutohide)}
            ariaLabel={t("settings.board_done_autohide")}
            options={optionsOf(BOARD_DONE_AUTOHIDE, BOARD_DONE_AUTOHIDE_LABELS)}
          />
        }
      />
      <SettingsRow
        anchor="board_card_thumb"
        label={t("settings.board_card_thumb")}
        control={
          <Toggle
            checked={cardThumb}
            onChange={(next) => void setCardThumb(next)}
            aria-label={t("settings.board_card_thumb")}
            data-testid="settings-board-card-thumb"
          />
        }
      />
      <SettingsRow
        anchor="board_card_date"
        label={t("settings.board_card_date")}
        control={
          <Toggle
            checked={cardDate}
            onChange={(next) => void setCardDate(next)}
            aria-label={t("settings.board_card_date")}
            data-testid="settings-board-card-date"
          />
        }
      />
    </>
  );
}

function GraphTabSettings() {
  const hideIsolated = useSettingsStore((s) => s.graphHideIsolated);
  const setHideIsolated = useSettingsStore((s) => s.setGraphHideIsolated);
  const nodeCap = useSettingsStore((s) => s.graphNodeCap);
  const setNodeCap = useSettingsStore((s) => s.setGraphNodeCap);
  return (
    <>
      <SettingsRow
        anchor="graph_hide_isolated"
        label={t("settings.graph_hide_isolated")}
        hint={t("settings.graph_hide_isolated_hint")}
        control={
          <Toggle
            checked={hideIsolated}
            onChange={(next) => void setHideIsolated(next)}
            aria-label={t("settings.graph_hide_isolated")}
            data-testid="settings-graph-hide-isolated"
          />
        }
      />
      <SettingsRow
        anchor="graph_node_cap"
        label={t("settings.graph_node_cap")}
        hint={t("settings.graph_node_cap_hint")}
        control={
          <Select
            value={String(nodeCap)}
            onChange={(v) => void setNodeCap(Number(v))}
            ariaLabel={t("settings.graph_node_cap")}
            options={[
              { value: "0", label: t("settings.graph_node_cap_default") },
              ...[100, 200, 300].map((n) => ({ value: String(n), label: t("settings.graph_node_cap_option", { n }) })),
            ]}
          />
        }
      />
    </>
  );
}

/** 탭 id → 그 탭의 하위 설정 행. 달력·지도는 이 페이지에 행이 없다 — 시간축은 달력 및 일정 한 곳에만 둔다(2026-10-28). */
const TAB_SETTINGS: Partial<Record<DashboardTabId, ComponentType>> = {
  timeline: TimelineTabSettings,
  board: BoardTabSettings,
  graph: GraphTabSettings,
};

/** 탭 하나의 하위 설정 카드. 이름은 탭 라벨의 단일 소스(칸반 = 내부 식별자 board, docs/GLOSSARY.md). */
function DashboardTabSettingsCard({ id }: { id: DashboardTabId }) {
  const Rows = TAB_SETTINGS[id];
  if (!Rows) return null;
  return (
    <SettingsCard
      title={t(dashboardTabLabelKey(id))}
      icon={renderDashboardTabIcon(id, 14)}
      testId={`settings-dashboard-${id}-group`}
    >
      <Rows />
    </SettingsCard>
  );
}
