import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSettingsStore, normalizeDashboardTabs } from "../../stores/settings";
import { DashboardMiniPreview } from "./DashboardMiniPreview";

describe("DashboardMiniPreview (W4 overhaul)", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      dashboardTabs: normalizeDashboardTabs([]),
      uiLang: "en",
    });
  });

  it("renders real tab strip preview with default dashboard tabs and first tab active", () => {
    const { container } = render(<DashboardMiniPreview />);

    expect(screen.getByTestId("settings-dashboard-mini-preview")).toBeTruthy();
    expect(screen.getByTestId("home-inner-tabs-left")).toBeTruthy();

    const buttons = container.querySelectorAll("[data-home-tab]");
    expect(buttons.length).toBe(5);

    const ids = Array.from(buttons).map((b) => b.getAttribute("data-home-tab"));
    expect(ids).toEqual(["board", "calendar", "timeline", "map", "graph"]);

    expect(buttons[0].getAttribute("data-active")).toBe("true");
    expect(buttons[1].getAttribute("data-active")).toBeNull();
  });

  it("reflects custom dashboardTabs order from settings", () => {
    useSettingsStore.setState({
      dashboardTabs: [
        { id: "timeline", enabled: true },
        { id: "map", enabled: true },
        { id: "board", enabled: true },
        { id: "calendar", enabled: true },
        { id: "graph", enabled: true },
      ],
    });

    const { container } = render(<DashboardMiniPreview />);
    const buttons = container.querySelectorAll("[data-home-tab]");
    const ids = Array.from(buttons).map((b) => b.getAttribute("data-home-tab"));
    expect(ids).toEqual(["timeline", "map", "board", "calendar", "graph"]);
    expect(buttons[0].getAttribute("data-active")).toBe("true");
  });

  it("reflects disabled tabs by hiding them and activating the first enabled tab", () => {
    useSettingsStore.setState({
      dashboardTabs: [
        { id: "board", enabled: false },
        { id: "calendar", enabled: true },
        { id: "timeline", enabled: true },
        { id: "map", enabled: false },
        { id: "graph", enabled: true },
      ],
    });

    const { container } = render(<DashboardMiniPreview />);
    const buttons = container.querySelectorAll("[data-home-tab]");
    const ids = Array.from(buttons).map((b) => b.getAttribute("data-home-tab"));

    expect(ids).toEqual(["calendar", "timeline", "graph"]);
    expect(ids).not.toContain("board");
    expect(ids).not.toContain("map");
    expect(buttons[0].getAttribute("data-active")).toBe("true");
  });

  it("renders buttons in non-interactive mode (tabIndex -1, pointerEvents none, cursor default)", () => {
    const { container } = render(<DashboardMiniPreview />);
    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-home-tab]");

    for (const btn of Array.from(buttons)) {
      expect(btn.tabIndex).toBe(-1);
      expect(btn.style.cursor).toBe("default");
      expect(btn.style.pointerEvents).toBe("none");
    }
  });

  it("frames the preview with --divider, the only settings hairline (PLAN-2026-09-12 D2)", () => {
    const frame = render(<DashboardMiniPreview />).container.querySelector<HTMLElement>(
      "[data-testid='settings-dashboard-mini-preview']",
    )!;
    // The frame is the point of this component (it is a scaled mock-up, not a control), so the
    // border stays — it just uses the one settings divider colour instead of a second one.
    expect(frame.style.border).toContain("var(--divider)");
    expect(frame.getAttribute("style") ?? "").not.toContain("var(--line)");
  });

  it("does not render sidebar filter roster (moved to ViewSection in W2)", () => {
    render(<DashboardMiniPreview />);
    expect(screen.queryByText("Sidebar filter")).toBeNull();
    expect(screen.queryByText("사이드바 필터")).toBeNull();
    expect(screen.queryByText("Dashboard tabs")).toBeNull();
  });
});
