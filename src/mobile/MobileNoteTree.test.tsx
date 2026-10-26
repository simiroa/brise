import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const call = vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "folder_list_meta") {
    return {
      folders: [
        { id: "f1", name: "Folder One", is_open: true, note_count: 1 },
        { id: "f2", name: "Folder Two", is_open: false, note_count: 0 },
      ],
    };
  }
  if (cmd === "settings_get_all") return { settings: {} };
  if (cmd === "note_query") {
    return { notes: [], total: 0 };
  }
  if (cmd === "note_trash_count") return { count: 0 };
  if (cmd === "note_archived_count") return { count: 0 };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));
// 노트 행을 누르기 시작하면 MobileNote 청크를 미리 받는다(MobileTreeRow) — 진짜 Tiptap 모듈을 끌고 오면 그 import 가
// 길게 누르기 타이머(400ms)와 겨뤄 이 파일이 흔들린다. 받기 자체는 lazyPreload 테스트가 본다.
vi.mock("./MobileNote", () => ({ MobileNote: () => null }));

import { useNotesStore } from "../stores/notes";
import { useSearchStore } from "../stores/search";
import { useWorkspacesStore } from "../stores/workspaces";
import { useSelectionStore } from "../stores/selection";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { t } from "../i18n/t";
import type { NoteSummary } from "../lib/commands.gen";
import { MobileNoteTree } from "./MobileNoteTree";

function note(patch: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "n1",
    folder_id: "f1",
    title: "A note",
    year: 2026,
    is_favorite: true,
    exported_at: "2026-01-01T00:00:00.000Z",
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    month: null,
    day: null,
    ...patch,
  };
}

beforeEach(() => {
  call.mockClear();
  useWorkspacesStore.setState({ workspaces: [], activeId: "ws1", loaded: true } as any);
  useNotesStore.setState({ folders: [], notesByFolder: {}, noteIndex: new Map(), inboxId: null, isBooting: true } as any);
  useSearchStore.setState({
    query: "",
    yearFrom: 1900,
    yearTo: 2100,
    yearBounds: { min: 1900, max: 2100 },
    selectedTags: [],
    tagMode: "or",
    regionFilter: null,
    statusFilter: [],
    dateRange: null,
    searchResults: [],
  } as any);
  useSelectionStore.setState({ notes: { ids: [], anchor: null, anchorIndex: null } } as any);
  useAiStore.setState({ aiReachable: null, ensureAiReachable: vi.fn(async () => {}) } as any);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MobileNoteTree — data path (W2 performance contract)", () => {
  it("boots folders via folder_list_meta, never folder_list or loadTree()", async () => {
    const loadTreeSpy = vi.fn();
    useNotesStore.setState({ loadTree: loadTreeSpy } as any);

    render(<MobileNoteTree onOpenNote={() => {}} />);

    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());

    const calledCommands = call.mock.calls.map((c) => c[0]);
    expect(calledCommands).toContain("folder_list_meta");
    expect(calledCommands).not.toContain("folder_list");
    expect(loadTreeSpy).not.toHaveBeenCalled();
  });

  it("uses note_query (bounded) for the open folder's notes, never an unbounded fetch", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    await waitFor(() => {
      const queryCalls = call.mock.calls.filter((c) => c[0] === "note_query");
      expect(queryCalls.length).toBeGreaterThan(0);
      // f1 is_open:true → its window is fetched; f2 (closed) never gets its own note_query call.
      const foldersQueried = queryCalls.map((c) => (c[1] as any)?.folder_ids?.[0]).filter(Boolean);
      expect(foldersQueried).toContain("f1");
      expect(foldersQueried).not.toContain("f2");
    });
  });
});

describe("MobileNoteTree — row kinds", () => {
  it("renders the favorites header, an open folder's note, and a closed folder", async () => {
    call.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "folder_list_meta") {
        return {
          folders: [
            { id: "f1", name: "Folder One", is_open: true, note_count: 1 },
            { id: "f2", name: "Folder Two", is_open: false, note_count: 0 },
          ],
        };
      }
      if (cmd === "settings_get_all") return { settings: {} };
      if (cmd === "note_query") {
        const folderIds = (args as any)?.folder_ids as string[] | undefined;
        if (folderIds?.includes("f1")) return { notes: [note({ snippet: "today I wrote" })], total: 1 };
        return { notes: [], total: 0 };
      }
      if (cmd === "note_trash_count") return { count: 2 };
      if (cmd === "note_archived_count") return { count: 1 };
      return {};
    });

    render(<MobileNoteTree onOpenNote={() => {}} />);

    await screen.findByText("A note");
    expect(screen.getByText(/today I wrote/)).toBeTruthy();
    expect(screen.getByText("Favorites")).toBeTruthy();
    expect(screen.getByText("Folder One")).toBeTruthy();
    expect(screen.getByText("Folder Two")).toBeTruthy();
    expect(screen.getByText("Trash")).toBeTruthy();
    expect(screen.getByText("Archive")).toBeTruthy();
  });

  it("shows the empty-workspace state when there are no folders at all", async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "folder_list_meta") return { folders: [] };
      if (cmd === "settings_get_all") return { settings: {} };
      return {};
    });
    render(<MobileNoteTree onOpenNote={() => {}} />);
    await screen.findByText(/노트가 없습니다|no notes/i);
  });
});

// The CSS half of this regression (`.mobile-app .treeact { opacity: 1 }`) is pinned in
// src/styles/mobile/mobileCss.contract.test.ts.
describe("MobileNoteTree — Δ3 regression (favorite/export badges visible without hover)", () => {
  it("renders the star (favorite) and share (exported) badges for a note unconditionally — not gated behind a hover-only DOM condition", async () => {
    call.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "folder_list_meta") return { folders: [{ id: "f1", name: "Folder One", is_open: true, note_count: 1 }] };
      if (cmd === "settings_get_all") return { settings: {} };
      if (cmd === "note_query") {
        const folderIds = (args as any)?.folder_ids as string[] | undefined;
        if (folderIds?.includes("f1")) return { notes: [note({ is_favorite: true, exported_at: "2026-01-01T00:00:00.000Z" })], total: 1 };
        return { notes: [], total: 0 };
      }
      return {};
    });

    render(<MobileNoteTree onOpenNote={() => {}} />);
    await screen.findByText("A note");

    // TreeRowBadges wraps export/favorite in .treeact — present in the DOM regardless of :hover
    // (no JS hover-state gate); mobile.css's W2 block is what makes it visible (opacity:1) since
    // touch has no :hover. This assertion guards the wiring; the CSS assertion below guards the
    // actual visibility rule.
    const badgeSlot = screen.getByTestId("tree-badges-slot");
    expect(badgeSlot.querySelector(".treeact")).toBeTruthy();
    expect(badgeSlot.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2); // star + share
  });
});

describe("MobileNoteTree — search mode", () => {
  it("renders a flat highlighted result list instead of the folder tree when search is active", async () => {
    useSearchStore.setState({
      query: "foo",
      searchResults: [note({ id: "sr1", title: "foo bar", folder_id: "f1" })],
    } as any);

    render(<MobileNoteTree onOpenNote={() => {}} />);

    await screen.findByText(/foo/i);
    expect(screen.queryByText("Favorites")).toBeNull();
    expect(screen.queryByText("Folder One")).toBeNull();
  });

  it("renders searching pending status while search is in flight", async () => {
    useSearchStore.setState({
      query: "foo",
      searching: true,
      searchResults: [],
    } as any);

    render(<MobileNoteTree onOpenNote={() => {}} />);

    const el = await screen.findByRole("status");
    expect(el.textContent).toBe(t("search.searching"));
  });
});

describe("MobileNoteTree — long-press opens the action sheet", () => {
  it("a note's long-press opens MobileActionSheet with its 7 verbs; a plain tap opens the note", async () => {
    call.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "folder_list_meta") return { folders: [{ id: "f1", name: "Folder One", is_open: true, note_count: 1 }] };
      if (cmd === "settings_get_all") return { settings: {} };
      if (cmd === "note_query") {
        const folderIds = (args as any)?.folder_ids as string[] | undefined;
        if (folderIds?.includes("f1")) return { notes: [note()], total: 1 };
        return { notes: [], total: 0 };
      }
      return {};
    });
    const onOpenNote = vi.fn();
    render(<MobileNoteTree onOpenNote={onOpenNote} />);

    const row = await screen.findByText("A note");
    const rowEl = row.closest('[role="button"]')!;
    fireEvent.pointerDown(rowEl);
    // lib/longPress.ts's real 400ms window.setTimeout — real (not faked) timers here, since
    // mixing fake timers with @testing-library's findBy*/waitFor polling is a known footgun.
    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.pointerUp(rowEl);

    expect(screen.getByTestId("mobile-action-rename")).toBeTruthy();
    expect(onOpenNote).not.toHaveBeenCalled();
  });
});

describe("MobileNoteTree — ＋ (MobileTreeFab: 폴더 추가 · 노트 추가 · AI)", () => {
  it("the header has no separate new-folder button any more — ＋ absorbed it", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    expect(document.querySelector(".mobile-tree-hdr button")).toBeNull();
  });

  it("is a speed dial of three items nearest-first: 폴더 추가 · 노트 추가 · AI", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    const fab = screen.getByTestId("mobile-tree-fab");
    const actions = Array.from(fab.querySelectorAll(".mobile-speed-dial-item")).map((b) => b.getAttribute("data-action"));
    expect(actions).toEqual(["folder", "note", "ai"]);
    expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-label")).toBe(t("mobileFolderAi.fab_label"));
    // the list makes room for the ＋ at its bottom while it is shown
    expect(document.querySelector(".mobile-tree")!.getAttribute("data-fab")).toBe("true");
  });

  it("노트 추가 calls onNewNote (MobileApp's enterCapture) and closes the dial", async () => {
    const onNewNote = vi.fn();
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={onNewNote} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    fireEvent.click(screen.getByTestId("mobile-tree-fab-note"));
    expect(onNewNote).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mobile-speed-dial").getAttribute("data-open")).toBe("false");
  });

  it("AI opens the folder-management sheet; dimmed (still tappable) while AI is not ready", async () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    const ai = screen.getByTestId("mobile-tree-fab-ai");
    expect(ai.getAttribute("data-muted")).toBe("true");
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    fireEvent.click(ai);
    expect(screen.getByText(t("mobileFolderAi.sheet_title"))).toBeTruthy();
    expect(screen.getByText(t("mobile.ai_disabled_hint"))).toBeTruthy();
  });

  it("AI item is not dimmed when AI is enabled and reachable", async () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    useAiStore.setState({ aiReachable: true } as any);
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    expect(screen.getByTestId("mobile-tree-fab-ai").getAttribute("data-muted")).toBe("false");
  });

  it("hides while selection mode (long-press multi-select) is active", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    expect(screen.getByTestId("mobile-tree-fab")).toBeTruthy();
    // Set AFTER mount, and without re-rendering rows: pruneNotes() drops ids that are not tree rows.
    act(() => useSelectionStore.setState({ notes: { ids: ["n1"], anchor: "n1", anchorIndex: 0 } } as any));
    expect(screen.queryByTestId("mobile-tree-fab")).toBeNull();
    expect(document.querySelector(".mobile-tree")!.hasAttribute("data-fab")).toBe(false);
  });

  it("폴더 추가 opens the new-folder dialog; submitting calls folder_create and refreshes via folder_list_meta (not folder_list)", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} onNewNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("Folder One")).toBeTruthy());
    call.mockClear();

    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    fireEvent.click(screen.getByTestId("mobile-tree-fab-folder"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Fresh folder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(call).toHaveBeenCalledWith("folder_create", { name: "Fresh folder" }));
    const calledCommands = call.mock.calls.map((c) => c[0]);
    expect(calledCommands).toContain("folder_list_meta");
    expect(calledCommands).not.toContain("folder_list");
  });
});

describe("MobileNoteTree — folder long-press renames (M1 G3)", () => {
  it("long-pressing a folder opens the rename dialog prefilled; submit calls folder_rename and refreshes via folder_list_meta", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} />);
    const label = await screen.findByText("Folder One");
    const rowEl = label.closest("button")!;
    fireEvent.pointerDown(rowEl);
    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.pointerUp(rowEl);
    fireEvent.click(rowEl); // the click that follows a long-press must not toggle the folder

    const input = screen.getByTestId("mobile-folder-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Folder One");
    expect(call).not.toHaveBeenCalledWith("folder_set_open", expect.anything());
    call.mockClear();

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("mobile-folder-rename-submit"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("folder_rename", { id: "f1", name: "Renamed" }));
    await waitFor(() => expect(screen.queryByTestId("mobile-folder-rename-input")).toBeNull());
    expect(call.mock.calls.map((c) => c[0])).toContain("folder_list_meta");
  });

  it("a plain tap on a folder still toggles it and opens no dialog", async () => {
    render(<MobileNoteTree onOpenNote={() => {}} />);
    const label = await screen.findByText("Folder One");
    const rowEl = label.closest("button")!;
    fireEvent.pointerDown(rowEl);
    fireEvent.pointerUp(rowEl);
    fireEvent.click(rowEl);
    await waitFor(() => expect(call).toHaveBeenCalledWith("folder_set_open", { id: "f1", is_open: false }));
    expect(screen.queryByTestId("mobile-folder-rename-input")).toBeNull();
  });
});
