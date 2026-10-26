import { createElement, type ComponentType, type ReactNode } from "react";
import type { DashboardTabEntry, DashboardTabId } from "../stores/settings";
import type { IconProps } from "../components/icons";
import {
  IconKanban,
  IconCalendar,
  IconTimeline,
  IconMap,
  IconGraph,
} from "../components/icons";

export interface DashboardTabDef {
  id: DashboardTabId;
  labelKey: string;
}

// 대시보드 탭(대시보드 내부 뷰 전환 5종 — 최상단 노트 탭(TabBar)과는 다른 개념, docs/GLOSSARY.md
// 참고) 아이콘/라벨의 단일 소스. 예전엔 HomeTab.tsx(실 탭바) · DashboardTabsSection.tsx(설정) ·
// DashboardMiniPreview.tsx(설정 미리보기) 3곳이 각자 아이콘 맵을 하드코딩해 갈라졌었다 — 같은
// layout-grid 글리프가 실 화면에선 "공간", 설정에선 "칸반(구 상태)"을 가리켜 사용자가 아이콘으로
// 기능을 식별할 수 없었다. 정답은 실 탭바(HomeTab.tsx) 기준.
// (공간 탭은 2026-08-27 플러그인 창으로 분리돼 여기서 빠졌다 — PLAN-2026-08-27-space-plugin-rebuild)
const ICON: Record<DashboardTabId, ComponentType<IconProps>> = {
  board: IconKanban, // = 칸반 (내부 식별자는 마이그레이션 호환성 때문에 board 유지, docs/GLOSSARY.md)
  calendar: IconCalendar,
  timeline: IconTimeline,
  map: IconMap,
  graph: IconGraph,
};

export const DASHBOARD_TABS: DashboardTabDef[] = [
  { id: "board", labelKey: "home.tab_board" },
  { id: "calendar", labelKey: "home.tab_calendar" },
  { id: "timeline", labelKey: "home.tab_timeline" },
  { id: "map", labelKey: "home.tab_map" },
  { id: "graph", labelKey: "home.tab_graph" },
];

// 실 탭바(HomeTab.tsx :300) 기준 굵기 — 호출처가 size 를 다르게 넘겨도(설정 15/미리보기 13)
// 굵기는 항상 이 값으로 고정해 3곳의 아이콘이 같은 그림으로 보이게 한다.
const STROKE_WIDTH = 2;

/** 대시보드 탭 아이콘 렌더. size 만 호출처가 고르고 굵기는 이 모듈이 정한다. */
export function renderDashboardTabIcon(id: DashboardTabId, size: number): ReactNode {
  return createElement(ICON[id], { size, strokeWidth: STROKE_WIDTH, "aria-hidden": true });
}

const LABEL_KEY = new Map(DASHBOARD_TABS.map((tab) => [tab.id, tab.labelKey]));

/** id → i18n 라벨 키. 알 수 없는 id면 id 문자열 자체로 폴백(안전한 폴백). */
export function dashboardTabLabelKey(id: DashboardTabId): string {
  return LABEL_KEY.get(id) ?? id;
}

/**
 * 저장된 탭 순서·활성(`dashboard_tabs`) → 탭 스트립에 실제로 그릴 탭 목록. 실 탭바(HomeTab)와 설정의
 * 미리보기(DashboardMiniPreview)가 같은 규칙을 쓴다: 저장 순서대로 켜진 것만, 모르는 id 는 버리고,
 * 저장값에 없는 탭(새로 생긴 탭)은 끝에 켜진 채로 붙인다.
 */
export function orderedVisibleTabs(entries: readonly DashboardTabEntry[] | null | undefined): DashboardTabDef[] {
  const remaining = new Map(DASHBOARD_TABS.map((tab) => [tab.id, tab]));
  const result: DashboardTabDef[] = [];
  for (const entry of entries ?? []) {
    const tab = remaining.get(entry.id as DashboardTabId);
    if (!tab) continue;
    remaining.delete(entry.id as DashboardTabId);
    if (entry.enabled !== false) result.push(tab);
  }
  for (const tab of remaining.values()) result.push(tab);
  return result;
}
