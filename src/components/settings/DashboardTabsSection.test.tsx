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
    // The chips themselves are buttons, not switches — the only switch on this page is the
    // kanban sub-group's status lock.
    expect(screen.queryAllByRole("switch")).toHaveLength(1);
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
    expect(card.classList.contains("card")).toBe(true);
    expect(card.contains(screen.getByTestId("settings-dashboard-mini-preview"))).toBe(false);

    const total = useSettingsStore.getState().dashboardTabs.length;
    expect(screen.getByTestId("settings-dashboard-tabs-caption").textContent).toBe(`${total}/${total} tabs active`);
    await userEvent.click(screen.getByTestId("dashboard-tabs-item-map"));
    expect(screen.getByTestId("settings-dashboard-tabs-caption").textContent).toBe(`${total - 1}/${total} tabs active`);
  });

  it("separates the kanban sub-group with a --divider hairline only, never --line (D2)", () => {
    render(<DashboardTabsSection />);
    const group = screen.getByTestId("settings-dashboard-board-group");
    expect(group.style.borderTop).toContain("var(--divider)");

    // `border: 0` (HintBadge's screen-reader span) is not a hairline — match drawn ones only.
    // 미리보기 액자 안(HomeHeader 실물)은 설정 부품이 아니다 — 카드 안만 본다.
    const card = screen.getByTestId("settings-dashboard-tabs");
    const bordered = Array.from(card.querySelectorAll<HTMLElement>("*")).filter((el) =>
      /border-(top|bottom):\s*1px/.test(el.getAttribute("style") ?? ""),
    );
    expect(bordered).toEqual([group]);
    for (const el of Array.from(card.querySelectorAll<HTMLElement>("*"))) {
      expect(el.getAttribute("style") ?? "").not.toContain("var(--line)");
    }
  });
});
