import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore, normalizeDashboardTabs } from "../../stores/settings";
import { DashboardTabsSection } from "./DashboardTabsSection";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

describe("DashboardTabsSection (W7 §7.3 / W23-a)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    useSettingsStore.setState({
      dashboardTabs: normalizeDashboardTabs([]),
      statusAddLocked: false,
    });
  });

  it("renders all dashboard tabs as chips without move buttons", () => {
    render(<DashboardTabsSection />);
    expect(screen.getByTestId("settings-dashboard-tabs")).toBeTruthy();
    expect(screen.getByTestId("dashboard-tabs-list")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-tabs-down-board")).toBeNull();
    expect(screen.getByTestId("dashboard-tabs-item-board")).toBeTruthy();
    // The chips themselves are buttons, not switches — the switches here are the tab sub-group rows
    // (kanban: status lock · card thumb · card date, graph: hide isolated).
    expect(screen.queryAllByRole("switch")).toHaveLength(4);
  });

  it("clicking a chip disables that tab and persists", async () => {
    render(<DashboardTabsSection />);
    await userEvent.click(screen.getByTestId("dashboard-tabs-item-map"));

    const tabs = useSettingsStore.getState().dashboardTabs;
    expect(tabs.find((t) => t.id === "map")?.enabled).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { dashboard_tabs: tabs } });
  });

  it("ArrowRight on a chip swaps tab order and persists", () => {
    render(<DashboardTabsSection />);
    fireEvent.keyDown(screen.getByTestId("dashboard-tabs-item-board"), { key: "ArrowRight" });

    const tabs = useSettingsStore.getState().dashboardTabs;
    expect(tabs.map((t) => t.id)).toEqual(["calendar", "board", "timeline", "map", "graph"]);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { dashboard_tabs: tabs } });
  });

  it("owns the status add-lock toggle, moved here from the region page (D10)", async () => {
    render(<DashboardTabsSection />);
    await userEvent.click(screen.getByTestId("settings-status-add-locked"));

    expect(useSettingsStore.getState().statusAddLocked).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { status_add_locked: true } });
  });

  it("renders the N/M caption, and the preview OUTSIDE the tabs card (owner 2026-09-15)", async () => {
    render(<DashboardTabsSection />);
    const card = screen.getByTestId("settings-dashboard-tabs");
    // 2026-10-28: 칩 줄은 프레임(카드) 없이, 미리보기는 맨 아래.
    expect(card.classList.contains("card")).toBe(false);
    const preview = screen.getByTestId("settings-dashboard-mini-preview");
    expect(card.contains(preview)).toBe(false);
    expect(card.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const total = useSettingsStore.getState().dashboardTabs.length;
    expect(screen.getByTestId("settings-dashboard-tabs-caption").textContent).toBe(`${total}/${total} tabs active`);
    await userEvent.click(screen.getByTestId("dashboard-tabs-item-map"));
    expect(screen.getByTestId("settings-dashboard-tabs-caption").textContent).toBe(`${total - 1}/${total} tabs active`);
  });

  // 2026-10-27: 켜진 탭의 하위 설정은 카드 밖에 탭별 카드로 접힘 없이 펼쳐진다. 꺼진 탭의 것은 숨는다.
  it("켜진 탭의 하위 설정 카드만 펼쳐진다 (칸반), 꺼지면 사라진다 — 달력 시간축은 달력 및 일정에만", async () => {
    render(<DashboardTabsSection />);
    expect(screen.getByTestId("settings-dashboard-board-group")).toBeTruthy();
    expect(screen.queryByTestId("settings-dashboard-calendar-group")).toBeNull();
    expect(screen.getByTestId("settings-status-add-locked")).toBeTruthy();

    await userEvent.click(screen.getByTestId("dashboard-tabs-item-board"));
    expect(screen.queryByTestId("settings-dashboard-board-group")).toBeNull();
  });

  it("첫 번째로 켜진 탭에 '시작 화면' 배지가 붙고, 순서를 바꾸면 따라간다", () => {
    render(<DashboardTabsSection />);
    const badge = screen.getByTestId("dashboard-tabs-start-badge");
    expect(screen.getByTestId("dashboard-tabs-item-board").contains(badge)).toBe(true);
    fireEvent.keyDown(screen.getByTestId("dashboard-tabs-item-board"), { key: "ArrowDown" });
    const moved = screen.getByTestId("dashboard-tabs-start-badge");
    expect(screen.getByTestId("dashboard-tabs-item-calendar").contains(moved)).toBe(true);
  });


  // 2026-10-28 W3b: 타임라인·칸반·관계 탭 설정 — 켜진 탭에만 카드가 있고, 저장 키가 allowlist 와 같다.
  it("타임라인·관계 탭 카드가 설정 행을 갖고, 값을 바꾸면 해당 키로 저장된다", async () => {
    render(<DashboardTabsSection />);
    expect(screen.getByTestId("settings-dashboard-timeline-group")).toBeTruthy();
    expect(screen.getByTestId("settings-dashboard-graph-group")).toBeTruthy();

    await userEvent.click(screen.getByTestId("settings-graph-hide-isolated"));
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { graph_hide_isolated: true } });
    await userEvent.click(screen.getByTestId("settings-board-card-thumb"));
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { board_card_thumb: false } });
    expect(useSettingsStore.getState().boardCardDate).toBe(true);
  });

  it("타임라인 탭을 끄면 그 설정 카드도 사라진다", async () => {
    render(<DashboardTabsSection />);
    await userEvent.click(screen.getByTestId("dashboard-tabs-item-timeline"));
    expect(screen.queryByTestId("settings-dashboard-timeline-group")).toBeNull();
  });
});
