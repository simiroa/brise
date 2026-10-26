import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { HomeTab } from "./HomeTab";
import { useUiStore } from "../../stores/ui";
import { useSettingsStore, normalizeDashboardTabs } from "../../stores/settings";
import { useSearchStore } from "../../stores/search";
import { useNotesStore } from "../../stores/notes";

// TimelineTab → useElementSize needs ResizeObserver (jsdom stub).
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockImplementation(async (cmd: string) => {
    if (cmd === "dashboard_timeline") {
      return {
        from_year: 1900,
        to_year: 2000,
        items: [],
        year_buckets: [],
        eras: [],
        total_matched: 0,
        cap: 2000,
        capped: false,
      };
    }
    if (cmd === "dashboard_board") {
      return { columns: [] };
    }
    if (cmd === "dashboard_calendar") {
      return { year: 2026, month: 7, items: [] };
    }
    if (cmd === "dashboard_graph") {
      return { nodes: [], edges: [], total: 0 };
    }
    if (cmd === "suggestions_list") {
      return { suggestions: [] };
    }
    if (cmd === "search_notes") {
      return { results: [], total: 0 };
    }
    // Soft-fail other IPC (weather, etc.)
    throw { code: "IO", message: "test" };
  }),
  callSilent: vi.fn().mockRejectedValue({ code: "IO", message: "test" }),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

describe("HomeTab shell (integrated dashboard)", () => {
  beforeEach(() => {
    useUiStore.setState({ homeInnerTab: "board" });
    useSettingsStore.setState({
      uiLang: "en",
      activeWorkspaceId: null,
      dashboardTabs: normalizeDashboardTabs([]),
    });
    // Module-level singleton shared with every home pane — reset so a query left over from
    // another test in this file never leaks into an unrelated one.
    useSearchStore.setState({ query: "", searchResults: [] });
  });

  it("renders header (date/time) + six inner tabs + board pane by default", () => {
    const { getByTestId, container } = render(<HomeTab />);

    expect(getByTestId("home-tab")).toBeDefined();
    expect(getByTestId("home-header")).toBeDefined();
    expect(getByTestId("home-date").textContent).toBeTruthy();
    expect(getByTestId("home-time").textContent).toBeTruthy();
    expect(getByTestId("home-inner-tabs")).toBeDefined();
    expect(getByTestId("home-pane").getAttribute("data-pane")).toBe("board");

    const tabs = container.querySelectorAll("[data-home-tab]");
    expect(tabs.length).toBe(5);
    expect(tabs[0].getAttribute("data-home-tab")).toBe("board");
    expect(tabs[1].getAttribute("data-home-tab")).toBe("calendar");
    expect(tabs[2].getAttribute("data-home-tab")).toBe("timeline");
    expect(tabs[3].getAttribute("data-home-tab")).toBe("map");
    expect(tabs[4].getAttribute("data-home-tab")).toBe("graph");
    expect(tabs[0].getAttribute("data-active")).toBe("true");
  });

  it("switching inner tabs updates ui store and the active pane", () => {
    const { getByTestId, container } = render(<HomeTab />);

    const cal = container.querySelector('[data-home-tab="calendar"]') as HTMLButtonElement;
    fireEvent.click(cal);

    expect(useUiStore.getState().homeInnerTab).toBe("calendar");
    expect(getByTestId("home-pane").getAttribute("data-pane")).toBe("calendar");
    expect(cal.getAttribute("data-active")).toBe("true");
  });

  it("keeps a visited pane mounted when switching away with display none/flex", () => {
    const { getByTestId, container } = render(<HomeTab />);
    expect(getByTestId("home-pane-board")).toBeTruthy();
    fireEvent.click(container.querySelector('[data-home-tab="calendar"]') as HTMLButtonElement);
    expect(getByTestId("home-pane-board")).toBeTruthy();
    expect(getByTestId("home-pane-calendar")).toBeTruthy();
    expect((getByTestId("home-pane-board") as HTMLElement).style.display).toBe("none");
    expect((getByTestId("home-pane-calendar") as HTMLElement).style.display).toBe("flex");

    fireEvent.click(container.querySelector('[data-home-tab="graph"]') as HTMLButtonElement);
    expect(getByTestId("home-pane-graph")).toBeTruthy();
    expect((getByTestId("home-pane-graph") as HTMLElement).style.display).toBe("flex");
    expect((getByTestId("home-pane-calendar") as HTMLElement).style.display).toBe("none");
  });

  it("shows the graph pane without outer scrolling", () => {
    const { getByTestId, container } = render(<HomeTab />);
    fireEvent.click(container.querySelector('[data-home-tab="graph"]') as HTMLButtonElement);

    expect(useUiStore.getState().homeInnerTab).toBe("graph");
    expect(getByTestId("home-pane").getAttribute("data-pane")).toBe("graph");
    expect((getByTestId("home-pane") as HTMLElement).style.overflow).toBe("hidden");
  });

  it("keeps the graph pane alive with display:none when switching away", () => {
    const { getByTestId, container } = render(<HomeTab />);
    fireEvent.click(container.querySelector('[data-home-tab="graph"]') as HTMLButtonElement);
    expect(getByTestId("home-pane-graph")).toBeTruthy();
    expect((getByTestId("home-pane-graph") as HTMLElement).style.display).toBe("flex");

    fireEvent.click(container.querySelector('[data-home-tab="calendar"]') as HTMLButtonElement);
    expect(getByTestId("home-pane-graph")).toBeTruthy();
    expect((getByTestId("home-pane-graph") as HTMLElement).style.display).toBe("none");
    expect(getByTestId("home-pane-calendar")).toBeTruthy();
    expect((getByTestId("home-pane-calendar") as HTMLElement).style.display).toBe("flex");

    fireEvent.click(container.querySelector('[data-home-tab="graph"]') as HTMLButtonElement);
    expect(getByTestId("home-pane-graph")).toBeTruthy();
    expect((getByTestId("home-pane-graph") as HTMLElement).style.display).toBe("flex");
  });

  it("remembers last-viewed inner tab across remount (session state)", () => {
    useUiStore.setState({ homeInnerTab: "timeline" });
    const { getByTestId, unmount } = render(<HomeTab />);
    expect(getByTestId("home-pane").getAttribute("data-pane")).toBe("timeline");
    unmount();

    const { getByTestId: get2 } = render(<HomeTab />);
    expect(get2("home-pane").getAttribute("data-pane")).toBe("timeline");
    expect(useUiStore.getState().homeInnerTab).toBe("timeline");
  });

  it("global search input reads/writes the shared search store (owner decision: fully shared, not per-pane)", () => {
    const { getByTestId, queryByTestId } = render(<HomeTab />);
    const input = getByTestId("home-search-input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(queryByTestId("home-search-clear")).toBeNull();

    fireEvent.change(input, { target: { value: "진주" } });
    expect(useSearchStore.getState().query).toBe("진주");
    expect(input.value).toBe("진주");
    expect(getByTestId("home-search-clear")).toBeDefined();

    fireEvent.click(getByTestId("home-search-clear"));
    expect(useSearchStore.getState().query).toBe("");
    expect(queryByTestId("home-search-clear")).toBeNull();
  });

  it("query and inner-tab switching don't reset each other — the store persists across tab switches", () => {
    const { getByTestId, container } = render(<HomeTab />);
    fireEvent.change(getByTestId("home-search-input"), { target: { value: "hello" } });
    expect(useSearchStore.getState().query).toBe("hello");

    const timelineTab = container.querySelector('[data-home-tab="timeline"]') as HTMLButtonElement;
    fireEvent.click(timelineTab);
    expect(useUiStore.getState().homeInnerTab).toBe("timeline");
    // Switching panes must not touch the shared store.
    expect(useSearchStore.getState().query).toBe("hello");
    expect((getByTestId("home-search-input") as HTMLInputElement).value).toBe("hello");
  });

  it("inner-tabs row is a 3-col grid with search in center and right controls (Wave F)", () => {
    const { getByTestId } = render(<HomeTab />);
    const nav = getByTestId("home-inner-tabs") as HTMLElement;
    const left = getByTestId("home-inner-tabs-left") as HTMLElement;
    const searchSlot = getByTestId("home-search-slot") as HTMLElement;
    const right = getByTestId("home-inner-tabs-right") as HTMLElement;

    expect(nav.style.display).toBe("grid");
    expect(nav.style.gridTemplateColumns).toBe(
      "minmax(0, 1fr) minmax(0, 220px) minmax(0, 1fr)",
    );
    // DOM order: left tabs → search → right controls
    expect(nav.children[0]).toBe(left);
    expect(nav.children[1]).toBe(searchSlot);
    expect(nav.children[2]).toBe(right);
    expect(searchSlot.contains(getByTestId("home-search-input"))).toBe(true);
    // W24: 좌우 인셋은 노트 TitleBar와 같은 --content-inset(HomeHeader와 동행).
    expect(nav.style.padding).toContain("var(--content-inset)");
  });

  it("nav row keeps only the folder filter; add-status lives at the board's right edge and leaves with the board tab (2026-09-08)", () => {
    const { getByTestId, queryByTestId, container } = render(<HomeTab />);
    const right = getByTestId("home-inner-tabs-right");
    // Folder filter is the only full-layout control left (its dots render once ≥2 folders exist).
    expect(right.querySelector(".home-filters-full")).toBeTruthy();
    expect(queryByTestId("board-status-filter-btn")).toBeNull();
    // No add-status control in the nav row on any tab (the board slot itself is covered in
    // BoardPane.test — here the pane has no workspace, so it never reaches its column row).
    expect(right.querySelector('[data-testid="board-add-status-btn"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-home-tab="calendar"]') as HTMLButtonElement);
    expect(right.querySelector('[data-testid="board-add-status-btn"]')).toBeNull();
    expect(right.querySelector(".home-filters-full")).toBeTruthy();
  });

  it("cycles search hits with < > buttons in right column and triggers dashboardReveal", () => {
    useSearchStore.setState({
      query: "test",
      searchResults: [
        { id: "note-1", folder_id: "f1", title: "Note 1", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        { id: "note-2", folder_id: "f1", title: "Note 2", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        { id: "note-3", folder_id: "f1", title: "Note 3", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
      ],
    });


    const { getByTestId } = render(<HomeTab />);
    const hitsNav = getByTestId("home-search-hits-nav");
    expect(hitsNav).toBeDefined();
    expect(getByTestId("home-search-slot").contains(hitsNav)).toBe(true);
    expect(getByTestId("home-inner-tabs-right").contains(hitsNav)).toBe(false);
    expect(getByTestId("home-search-hits-count").textContent).toBe("1/3");

    // Click next hit
    fireEvent.click(getByTestId("home-search-next-hit"));
    expect(getByTestId("home-search-hits-count").textContent).toBe("2/3");
    expect(useUiStore.getState().dashboardReveal).toEqual({ noteId: "note-2", seq: 1 });

    // Click next hit again
    fireEvent.click(getByTestId("home-search-next-hit"));
    expect(getByTestId("home-search-hits-count").textContent).toBe("3/3");
    expect(useUiStore.getState().dashboardReveal).toEqual({ noteId: "note-3", seq: 2 });

    // Wrap around to first
    fireEvent.click(getByTestId("home-search-next-hit"));
    expect(getByTestId("home-search-hits-count").textContent).toBe("1/3");
    expect(useUiStore.getState().dashboardReveal).toEqual({ noteId: "note-1", seq: 3 });

    // Click prev hit -> wraps to last
    fireEvent.click(getByTestId("home-search-prev-hit"));
    expect(getByTestId("home-search-hits-count").textContent).toBe("3/3");
    expect(useUiStore.getState().dashboardReveal).toEqual({ noteId: "note-3", seq: 4 });
  });

  it("search slot allows shrink at narrow widths (min-width:0, width 100%)", () => {
    const { getByTestId } = render(<HomeTab />);
    const slot = getByTestId("home-search-slot") as HTMLElement;
    const input = getByTestId("home-search-input") as HTMLElement;
    // React serializes numeric 0 as "0px" on the style object.
    expect(slot.style.minWidth).toMatch(/^0(px)?$/);
    expect(slot.style.width).toBe("100%");
    expect(input.style.minWidth).toMatch(/^0(px)?$/);
    // width:100% now comes from `.field` (surface contract: class owns background/geometry defaults).
    expect(input.classList.contains("field")).toBe(true);
    expect(input.style.width).toBe("");
  });

  it("shows clear chip when a folder filter is active and clicking it clears filter", () => {
    useNotesStore.setState({
      folders: [
        { id: "f1", workspace_id: "ws", name: "Folder 1", position: 1, is_open: true, note_count: 0, icon: null, color_hue: 120, rules: null, search_excluded: false, ai_excluded: false },
        { id: "f2", workspace_id: "ws", name: "Folder 2", position: 2, is_open: true, note_count: 0, icon: null, color_hue: 240, rules: null, search_excluded: false, ai_excluded: false },
      ],
    });
    useUiStore.setState({ dashboardFolderFilter: "f1" });

    const { getByTestId } = render(<HomeTab />);
    const clearChip = getByTestId("folder-filter-clear-chip");
    expect(clearChip).toBeTruthy();
    expect(clearChip.textContent).toContain("Folder 1");

    fireEvent.click(clearChip);
    expect(useUiStore.getState().dashboardFolderFilter).toBeNull();
  });

  it("renders inner tab buttons in customized dashboardTabs order (W7 §7.3)", () => {
    useSettingsStore.setState({
      dashboardTabs: [
        { id: "timeline", enabled: true },
        { id: "map", enabled: true },
        { id: "board", enabled: true },
        { id: "calendar", enabled: true },
        { id: "graph", enabled: true },
      ],
    });

    const { container } = render(<HomeTab />);
    const buttons = container.querySelectorAll("[data-home-tab]");
    const ids = Array.from(buttons).map((b) => b.getAttribute("data-home-tab"));
    expect(ids).toEqual(["timeline", "map", "board", "calendar", "graph"]);
  });

  it("hides disabled dashboard tabs and falls back homeInnerTab to the first enabled (W23-a)", () => {
    useUiStore.setState({ homeInnerTab: "map" });
    useSettingsStore.setState({
      dashboardTabs: [
        { id: "board", enabled: true },
        { id: "calendar", enabled: true },
        { id: "timeline", enabled: true },
        { id: "map", enabled: false },
        { id: "graph", enabled: true },
      ],
    });

    const { container } = render(<HomeTab />);
    const ids = Array.from(container.querySelectorAll("[data-home-tab]")).map((b) =>
      b.getAttribute("data-home-tab"),
    );
    expect(ids).toEqual(["board", "calendar", "timeline", "graph"]);
    expect(ids).not.toContain("map");
    expect(useUiStore.getState().homeInnerTab).toBe("board");
  });
});

