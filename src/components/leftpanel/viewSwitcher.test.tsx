import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { LeftPanel } from "./index";
import { useSearchStore } from "../../stores/search";
import { useUiStore } from "../../stores/ui";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore, normalizeFilterRoster } from "../../stores/settings";
import { useWorkspacesStore } from "../../stores/workspaces";
import { assertRenderSettles } from "../../test/renderLoop";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({
    results: [],
    total: 0,
    notes: [],
    settings: {},
    workspaces: [],
    active_id: null,
    messages: [],
  }),
  callSilent: vi.fn().mockResolvedValue({
    results: [],
    total: 0,
    notes: [],
    settings: {},
    workspaces: [],
    active_id: null,
    messages: [],
  }),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/noteQuery", () => ({
  EXPANDED_BOARD_MAX_NOTES: 1000,
  noteQuery: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
  noteQueryCollect: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
  noteYearHistogram: vi.fn().mockResolvedValue({}),
  noteRecordHistogram: vi.fn().mockResolvedValue({}),
  hydrateTagNames: vi.fn(async (notes: unknown) => notes),
  buildNoteQueryInput: vi.fn(),
  useNoteQueryVersion: () => 0,
}));

vi.mock("../WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => createElement("div", { "data-testid": "workspace-switcher-stub" }),
}));

// Map canvas is heavy; region view only needs to mount without throwing. Mounts are counted so
// the keep-alive tests below can tell "shown again" from "built again".
const mapMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock("../map/WorldMapAuto", async () => {
  const { useEffect } = await import("react");
  return {
    WorldMapAuto: () => {
      useEffect(() => {
        mapMounts.n += 1;
      }, []);
      return createElement("div", { "data-testid": "view-region-map" });
    },
  };
});

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom lacks scrollTo used by SidebarChat list autoscroll.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const MODES = ["tree", "region", "timeline", "calendar", "gallery", "chat"] as const;

describe("left panel six-way view switcher", () => {
  beforeEach(() => {
    useSearchStore.setState({
      filterMode: "tree",
      query: "",
      yearBounds: { min: 1000, max: 2000 },
      yearFrom: 1000,
      yearTo: 2000,
      yearCounts: {},
      selectedTags: [],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
      dateRange: null,
      searchResults: [],
    });
    useNotesStore.setState({
      folders: [],
      totalNotes: 1, // unlock YearFilter pointer-events
      notesByFolder: {},
      folderQueryTotals: {},
      tagCounts: {},
      tagColors: {},
      activeNote: null,
      inboxId: null,
      noteIndex: new Map(),
    });
    useSettingsStore.setState({
      leftWidth: 280,
      uiLock: false,
      uiLang: "en",
      aiEnabled: true,
      filterRoster: normalizeFilterRoster([]),
    });
    useWorkspacesStore.setState({
      workspaces: [],
      activeId: null,
      loaded: true,
    });
  });

  it("renders view tabs in default order tree · region · timeline · calendar · gallery · chat", () => {
    assertRenderSettles(() => <LeftPanel />);
    const tabs = screen.getAllByTestId(/^view-tab-/);
    expect(tabs.map((el) => el.getAttribute("data-testid"))).toEqual([
      "view-tab-tree",
      "view-tab-region",
      "view-tab-timeline",
      "view-tab-calendar",
      "view-tab-gallery",
      "view-tab-chat",
    ]);
    expect(screen.queryByText(t("tree.n_notes", { n: 1 }))).toBeNull();
    expect(screen.queryByText(t("tree.n_folders", { n: 0 }))).toBeNull();
  });

  it("selecting each of the six tabs renders that view without throw or storm", async () => {
    const { renders: mountRenders } = assertRenderSettles(() => <LeftPanel />);
    expect(mountRenders).toBeLessThanOrEqual(40);

    for (const mode of MODES) {
      const tab = screen.getByTestId(`view-tab-${mode}`);
      fireEvent.click(tab);
      expect(useSearchStore.getState().filterMode).toBe(mode);

      if (mode === "tree") {
        expect(screen.getByTestId("view-tab-tree").getAttribute("aria-pressed")).toBe("true");
      } else if (mode === "chat") {
        expect(screen.getByTestId("view-chat")).toBeTruthy();
      } else if (mode === "gallery") {
        expect(screen.getByTestId("view-gallery")).toBeTruthy();
      } else if (mode === "region") {
        // 지도는 첫 페인트 뒤(두 프레임)에 들어온다 — RegionExpanded deferMap.
        expect(await screen.findByTestId("view-region-map")).toBeTruthy();
      } else if (mode === "timeline") {
        expect(screen.getByTestId("view-tab-timeline").getAttribute("aria-pressed")).toBe("true");
      } else if (mode === "calendar") {
        expect(screen.getByTestId("view-calendar")).toBeTruthy();
      }
    }
  });

  it("hides chat tab when AI is off and falls back from chat to tree", () => {
    useSettingsStore.setState({ aiEnabled: false });
    useSearchStore.setState({ filterMode: "chat" });
    assertRenderSettles(() => <LeftPanel />);
    expect(screen.queryByTestId("view-tab-chat")).toBeNull();
    expect(useSearchStore.getState().filterMode).toBe("tree");
  });

  it("hides filter toggle in chat mode; shows it in tree", () => {
    assertRenderSettles(() => <LeftPanel />);
    expect(screen.getByTestId("filter-strip-toggle")).toBeTruthy();

    fireEvent.click(screen.getByTestId("view-tab-chat"));
    expect(screen.queryByTestId("filter-strip-toggle")).toBeNull();
  });

  it("opens the filter modal (via ui store) when the toggle is pressed (non-chat)", () => {
    useUiStore.setState({ filtersOpen: false });
    assertRenderSettles(() => <LeftPanel />);
    expect(useUiStore.getState().filtersOpen).toBe(false);
    fireEvent.click(screen.getByTestId("filter-strip-toggle"));
    expect(useUiStore.getState().filtersOpen).toBe(true);
  });

  it("each mode body settles under assertRenderSettles", () => {
    for (const mode of MODES) {
      useSearchStore.setState({ filterMode: mode });
      const { renders } = assertRenderSettles(() => <LeftPanel />);
      expect(renders).toBeLessThanOrEqual(40);
    }
  });

  // 2026-09-03 owner repro: deleting a note while on a non-tree tab can drop totalNotes to 0,
  // which used to disable the *entire* view switcher (pointer-events:none on the wrapping div) —
  // including tree, trapping the user on an empty filtered tab with no way back.
  it("keeps the tree tab clickable when the workspace has zero notes, unlike the other tabs", () => {
    useNotesStore.setState({ totalNotes: 0 });
    useSearchStore.setState({ filterMode: "timeline" });
    assertRenderSettles(() => <LeftPanel />);

    fireEvent.click(screen.getByTestId("view-tab-calendar"));
    expect(useSearchStore.getState().filterMode).toBe("timeline");

    fireEvent.click(screen.getByTestId("view-tab-tree"));
    expect(useSearchStore.getState().filterMode).toBe("tree");
  });

  // 2026-10-22: 지도 보기는 탭을 오갈 때마다 MapLibre 를 새로 만들어 클릭마다 0.3~0.6 s 멈췄다.
  // 한 번 연 뒤에는 숨긴 채 살려 두고, 숨긴 동안 노트북이 바뀌면 내려놓는다.
  describe("region view keep-alive", () => {
    beforeEach(() => {
      mapMounts.n = 0;
    });

    it("switching away and back reuses the same map (one mount); hidden pane is inert", async () => {
      assertRenderSettles(() => <LeftPanel />);
      expect(screen.queryByTestId("region-view-pane")).toBeNull();

      fireEvent.click(screen.getByTestId("view-tab-region"));
      await screen.findByTestId("view-region-map");
      expect(mapMounts.n).toBe(1);

      fireEvent.click(screen.getByTestId("view-tab-tree"));
      const pane = screen.getByTestId("region-view-pane");
      expect(pane.hasAttribute("inert")).toBe(true);
      expect(pane.getAttribute("aria-hidden")).toBe("true");
      expect(pane.style.visibility).toBe("hidden");

      fireEvent.click(screen.getByTestId("view-tab-region"));
      expect(screen.getByTestId("region-view-pane").hasAttribute("inert")).toBe(false);
      expect(screen.getByTestId("view-region-map")).toBeTruthy();
      expect(mapMounts.n).toBe(1);
    });

    it("a notebook switch while the map is hidden drops it; the next open builds fresh", async () => {
      useWorkspacesStore.setState({ activeId: "ws-a" });
      assertRenderSettles(() => <LeftPanel />);
      fireEvent.click(screen.getByTestId("view-tab-region"));
      await screen.findByTestId("view-region-map");
      fireEvent.click(screen.getByTestId("view-tab-timeline"));
      expect(screen.getByTestId("region-view-pane")).toBeTruthy();

      act(() => useWorkspacesStore.setState({ activeId: "ws-b" }));
      expect(screen.queryByTestId("region-view-pane")).toBeNull();

      fireEvent.click(screen.getByTestId("view-tab-region"));
      await screen.findByTestId("view-region-map");
      expect(mapMounts.n).toBe(2);
    });

    it("a notebook switch while the map is visible keeps it (no rebuild during the switch)", async () => {
      useWorkspacesStore.setState({ activeId: "ws-a" });
      assertRenderSettles(() => <LeftPanel />);
      fireEvent.click(screen.getByTestId("view-tab-region"));
      await screen.findByTestId("view-region-map");

      act(() => useWorkspacesStore.setState({ activeId: "ws-b" }));
      expect(screen.getByTestId("view-region-map")).toBeTruthy();
      expect(mapMounts.n).toBe(1);
    });
  });
});
