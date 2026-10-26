import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useWorkspacesStore } from "../stores/workspaces";
import { useSearchStore } from "../stores/search";
import { useSettingsStore } from "../stores/settings";

// MobileNoteTree makes its own network calls (folder_list_meta / note_query) and has its own
// dedicated test file — irrelevant here to "does the subbar dispatch to the right body per mode".
vi.mock("./MobileNoteTree", () => ({
  MobileNoteTree: ({ onOpenNote, onNewNote }: { onOpenNote: (id: string) => void; onNewNote?: () => void }) => (
    <div data-testid="mobile-tree-stub">
      <button onClick={() => onOpenNote("tree-note")}>open-from-tree</button>
      <button onClick={() => onNewNote?.()}>new-from-tree</button>
    </div>
  ),
}));

// W3: the non-tree body is now MobileExpandedView (its own dispatcher, its own test file —
// see MobileExpandedView.test.tsx for per-mode content). Stubbed here so this file stays scoped
// to "does MobileHome wire filterMode/onOpenNote/the filter chip correctly", same split MobileHome
// already used for the tree stub above.
vi.mock("./MobileExpandedView", () => ({
  MobileExpandedView: ({ onOpenNote }: { onOpenNote: (id: string) => void }) => (
    <div data-testid="mobile-expanded-stub">
      <button onClick={() => onOpenNote("expanded-note")}>open-from-expanded</button>
    </div>
  ),
}));

// MobileFilterSheet has its own dedicated test file (3-axis wiring, clear-all) — stubbed here so
// this file only checks "does the chip open it and pass onClose through".
vi.mock("./MobileFilterSheet", () => ({
  MobileFilterSheet: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="mobile-filter-sheet-stub">
      <button onClick={onClose}>close-sheet</button>
    </div>
  ),
}));

import { MobileHome } from "./MobileHome";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/invoke")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.cmd === "workspace_list") return jsonResponse({ workspaces: [], active_id: null });
      return jsonResponse({});
    }
    return jsonResponse({}, false);
  });
}

const DEFAULT_ROSTER = useSettingsStore.getState().filterRoster;

beforeEach(() => {
  sessionStorage.setItem("brise_sync_token", "tok-abc");
  useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
  useSearchStore.setState({
    filterMode: "tree",
    query: "",
    selectedTags: [],
    regionFilter: null,
    statusFilter: [],
    dateRange: null,
  } as any);
  useSettingsStore.setState({ filterRoster: DEFAULT_ROSTER } as any);
  vi.stubGlobal("fetch", mockFetch());
});
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("MobileHome", () => {
  it("defaults to tree mode and renders MobileNoteTree", () => {
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.getByTestId("mobile-tree-stub")).toBeTruthy();
  });

  it("tapping the search icon calls onOpenSearch", () => {
    const onOpenSearch = vi.fn();
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={onOpenSearch} />);
    fireEvent.click(screen.getByLabelText("Search notes, tags, sources…"));
    expect(onOpenSearch).toHaveBeenCalled();
  });

  it("opening a note from the tree calls onOpenNote", () => {
    const onOpenNote = vi.fn();
    render(<MobileHome onOpenNote={onOpenNote} onOpenSearch={() => {}} />);
    fireEvent.click(screen.getByText("open-from-tree"));
    expect(onOpenNote).toHaveBeenCalledWith("tree-note");
  });

  it("passes onNewNote through to the tree (its ＋ → 노트 추가)", () => {
    const onNewNote = vi.fn();
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} onNewNote={onNewNote} />);
    fireEvent.click(screen.getByText("new-from-tree"));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it("view switcher tabs match the desktop testid convention and switch filterMode", () => {
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.getByTestId("view-tab-tree")).toBeTruthy();
    expect(screen.getByTestId("view-tab-calendar")).toBeTruthy();
    // chat is permanently excluded (D7) even though it's in the default roster.
    expect(screen.queryByTestId("view-tab-chat")).toBeNull();

    fireEvent.click(screen.getByTestId("view-tab-calendar"));
    expect(useSearchStore.getState().filterMode).toBe("calendar");
    // W3: the non-tree body dispatches through MobileExpandedView, not an inline placeholder.
    expect(screen.queryByTestId("mobile-tree-stub")).toBeNull();
    expect(screen.getByTestId("mobile-expanded-stub")).toBeTruthy();
  });

  it("opening a note from the expanded view calls onOpenNote (non-tree modes)", () => {
    const onOpenNote = vi.fn();
    useSearchStore.setState({ filterMode: "calendar" } as any);
    render(<MobileHome onOpenNote={onOpenNote} onOpenSearch={() => {}} />);
    fireEvent.click(screen.getByText("open-from-expanded"));
    expect(onOpenNote).toHaveBeenCalledWith("expanded-note");
  });

  it("region is in the switcher when the roster has it on (view-only map, formerly D6)", () => {
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.getByTestId("view-tab-region")).toBeTruthy();
  });

  it("hides the filter roster tabs the user turned off in settings", () => {
    useSettingsStore.setState({
      filterRoster: DEFAULT_ROSTER.map((r) => (r.mode === "gallery" ? { ...r, enabled: false } : r)),
    } as any);
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.queryByTestId("view-tab-gallery")).toBeNull();
    expect(screen.getByTestId("view-tab-timeline")).toBeTruthy();
  });

  it("the filter chip is always present, with no count badge when no axis is active", () => {
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.getByTestId("mobile-filter-chip")).toBeTruthy();
    expect(screen.queryByTestId("mobile-filter-badge")).toBeNull();
  });

  it("shows a count badge on the chip when a filter axis is active", () => {
    useSearchStore.setState({ selectedTags: ["travel"], statusFilter: ["done"] } as any);
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.getByTestId("mobile-filter-badge").textContent).toBe("2");
  });

  it("tapping the filter chip opens MobileFilterSheet, and its onClose closes it", () => {
    render(<MobileHome onOpenNote={() => {}} onOpenSearch={() => {}} />);
    expect(screen.queryByTestId("mobile-filter-sheet-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-filter-chip"));
    expect(screen.getByTestId("mobile-filter-sheet-stub")).toBeTruthy();

    fireEvent.click(screen.getByText("close-sheet"));
    expect(screen.queryByTestId("mobile-filter-sheet-stub")).toBeNull();
  });
});
