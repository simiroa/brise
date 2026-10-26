import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSettingsStore, CANONICAL_ROSTER, type FilterRosterEntry } from "../stores/settings";
import { useSearchStore } from "../stores/search";
import { MobileViewSwitcher } from "./MobileViewSwitcher";

function roster(overrides: Partial<Record<FilterRosterEntry["mode"], boolean>> = {}): FilterRosterEntry[] {
  return CANONICAL_ROSTER.map((mode) => ({ mode, enabled: overrides[mode] ?? true }));
}

beforeEach(() => {
  useSearchStore.setState({ filterMode: "tree" } as any);
  useSettingsStore.setState({ filterRoster: roster() } as any);
});

describe("MobileViewSwitcher", () => {
  it("always renders tree first, using the same data-testid convention as desktop's YearFilter", () => {
    render(<MobileViewSwitcher />);
    const tabs = screen.getAllByRole("button");
    expect(tabs[0].dataset.testid).toBe("view-tab-tree");
    // CANONICAL_ROSTER order minus chat (D7) and region (D6).
    expect(screen.getByTestId("view-tab-timeline")).toBeTruthy();
    expect(screen.getByTestId("view-tab-calendar")).toBeTruthy();
    expect(screen.getByTestId("view-tab-gallery")).toBeTruthy();
  });

  it("shows chat when enabled in the roster and AI is on; hides it while AI is off (desktop parity)", () => {
    useSettingsStore.setState({ filterRoster: roster({ chat: true }), aiEnabled: true } as any);
    const { unmount } = render(<MobileViewSwitcher />);
    expect(screen.getByTestId("view-tab-chat")).toBeTruthy();
    unmount();
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileViewSwitcher />);
    expect(screen.queryByTestId("view-tab-chat")).toBeNull();
  });

  it("shows region (view-only map since 2026-10-06, formerly D6) when enabled in the roster", () => {
    useSettingsStore.setState({ filterRoster: roster({ region: true }) } as any);
    render(<MobileViewSwitcher />);
    expect(screen.getByTestId("view-tab-region")).toBeTruthy();
  });

  it("bounces a persisted chat filterMode back to tree while AI is off", () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    useSearchStore.setState({ filterMode: "chat" } as any);
    render(<MobileViewSwitcher />);
    expect(useSearchStore.getState().filterMode).toBe("tree");
  });

  it("omits tabs the user disabled in settings (same roster desktop's FilterRosterStrip writes)", () => {
    useSettingsStore.setState({ filterRoster: roster({ gallery: false, timeline: false }) } as any);
    render(<MobileViewSwitcher />);
    expect(screen.queryByTestId("view-tab-gallery")).toBeNull();
    expect(screen.queryByTestId("view-tab-timeline")).toBeNull();
    expect(screen.getByTestId("view-tab-calendar")).toBeTruthy();
  });

  it("follows the roster's saved order (not CANONICAL_ROSTER's), same as desktop", () => {
    useSettingsStore.setState({
      filterRoster: [
        { mode: "calendar", enabled: true },
        { mode: "region", enabled: true },
        { mode: "timeline", enabled: true },
        { mode: "gallery", enabled: true },
        { mode: "chat", enabled: true },
      ],
    } as any);
    render(<MobileViewSwitcher />);
    const testids = screen.getAllByRole("button").map((b) => b.dataset.testid);
    expect(testids).toEqual(["view-tab-tree", "view-tab-calendar", "view-tab-region", "view-tab-timeline", "view-tab-gallery"]);
  });

  it("tapping a tab calls setFilterMode and reflects aria-pressed/data-active", () => {
    render(<MobileViewSwitcher />);
    const calendarTab = screen.getByTestId("view-tab-calendar");
    expect(calendarTab.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(calendarTab);

    expect(useSearchStore.getState().filterMode).toBe("calendar");
    expect(calendarTab.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("view-tab-tree").getAttribute("aria-pressed")).toBe("false");
  });

  it("falls back to tree alone when the roster is entirely disabled", () => {
    useSettingsStore.setState({ filterRoster: roster({ region: false, timeline: false, calendar: false, gallery: false, chat: false }) } as any);
    render(<MobileViewSwitcher />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("view-tab-tree")).toBeTruthy();
  });
});
