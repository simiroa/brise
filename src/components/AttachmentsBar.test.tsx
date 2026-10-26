import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment, NoteDetail, NoteSummary, Source } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import {
  AttachmentsBar,
  shouldAcceptRelatedNoteDrop,
} from "./AttachmentsBar";
import type { NoteDropHandler } from "../lib/noteDrag";

// jsdom has no matchMedia — usePrefersReducedMotion reads it on mount.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

const addFile = vi.fn(async () => {});
const addInternal = vi.fn(async () => {});
const addLink = vi.fn(async () => {});
const addNote = vi.fn(async () => {});
// Mirrors the real removeTile's contract (useAttachmentActions.ts): it always stops the
// triggering click's propagation first, before anything else — callers (the tile's outer
// onClick) rely on that to not also fire on a delete click.
const removeTile = vi.fn(async (e: { stopPropagation: () => void }) => {
  e.stopPropagation();
});
const renameSource = vi.fn(async () => {});
const addOneFile = vi.fn(async () => {});
const setBusy = vi.fn();
const callMock = vi.fn();

const dropHandlers = new Set<NoteDropHandler>();

vi.mock("../lib/noteDrag", async () => {
  const actual = await vi.importActual<typeof import("../lib/noteDrag")>("../lib/noteDrag");
  return {
    ...actual,
    registerNoteDropHandler: (h: NoteDropHandler) => {
      dropHandlers.add(h);
      return () => {
        dropHandlers.delete(h);
      };
    },
  };
});

vi.mock("./attachments/useAttachmentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attachments/useAttachmentActions")>();
  return {
    ...actual,
    useAttachmentActions: () => ({
      busy: false,
      setBusy,
      pendingRemovedIds: new Set<string>(),
      addOneFile,
      renameSource,
      addFile,
      addLink,
      addNote,
      addInternal,
      removeTile,
    }),
  };
});

vi.mock("./attachments/useRelatedTiles", () => ({
  useRelatedTiles: () => ({
    relatedTiles: [],
    openRelatedNote: vi.fn(),
    scheduleRelatedPreview: vi.fn(),
  }),
}));

vi.mock("./attachments/useAttachmentThumbs", () => ({
  useAttachmentThumbs: () => new Map(),
}));

vi.mock("./attachments/useAttachmentsDragDrop", () => ({
  useAttachmentsDragDrop: () => ({ dragOver: false }),
}));

// mutable so the promote-tile tests below can flip on a desktop-style baseDir without a
// separate mock file — every other describe block leaves it null (unchanged behavior).
let attachmentsBaseDir: string | null = null;
vi.mock("../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({ baseDir: attachmentsBaseDir, convert: null }),
}));

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

function makeSummary(id: string, title = id): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title,
    year: 1500,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    month: null,
    day: null,
  };
}

function makeDetail(id: string, attachments: Attachment[] = [], sources: Source[] = []): NoteDetail {
  return {
    note: makeSummary(id, "Active"),
    sections: [],
    attachments,
    sources,
  };
}

function fireDrop(noteId: string, targetId: string) {
  for (const h of dropHandlers) h(noteId, targetId, 0, 0);
}

// W24: 첨부 헤더가 --row-tabs 리듬으로 통일됨(--row-attach-header 토큰 삭제).
const HEADER_HEIGHT = "var(--row-tabs)";

describe("shouldAcceptRelatedNoteDrop", () => {
  const att = (over: Partial<Attachment> & { id: string }): Attachment => ({
    name: over.name ?? over.id,
    kind: over.kind ?? "internal",
    rel_path: null,
    url: over.url ?? null,
    size_bytes: null,
    position: 0,
    ...over,
  });

  it("ignores drops whose targetId is not \"related\"", () => {
    expect(shouldAcceptRelatedNoteDrop("n2", "folder:f1", "n1", [])).toBe(false);
    expect(shouldAcceptRelatedNoteDrop("n2", "section:x", "n1", [])).toBe(false);
    expect(shouldAcceptRelatedNoteDrop("n2", "related", "n1", [])).toBe(true);
  });

  it("blocks self-link (dropping the active note onto itself)", () => {
    expect(shouldAcceptRelatedNoteDrop("n1", "related", "n1", [])).toBe(false);
  });

  it("blocks duplicate internal links (same note url already attached)", () => {
    const existing = [att({ id: "a1", kind: "internal", url: "n2" })];
    expect(shouldAcceptRelatedNoteDrop("n2", "related", "n1", existing)).toBe(false);
    expect(shouldAcceptRelatedNoteDrop("n3", "related", "n1", existing)).toBe(true);
  });
});

describe("AttachmentsBar", () => {
  beforeEach(() => {
    addFile.mockClear();
    addInternal.mockClear();
    dropHandlers.clear();
    useNotesStore.setState({
      activeNote: makeDetail("n1"),
      ensureNoteSummaries: async (ids: string[]) => {
        const m = new Map<string, NoteSummary>();
        for (const id of ids) m.set(id, makeSummary(id, `Title ${id}`));
        return m;
      },
    } as never);
    useUiStore.setState({
      attachmentsCollapsed: false,
      attachmentsTab: "attachments",
    });
  });

  // W22 ⑥: two entry points now. (a) tiles present → corner ghost "+" opens a portal overlay
  // (GhostAddButton in AttachmentsBar.tsx) with file/note/link menu items — click the trigger,
  // then click a menu item. (b) tiles absent (empty state) → three quick-add ghost buttons
  // render directly in the middle of the strip, no overlay, same testids reused (mutually
  // exclusive with (a) since only one of the two blocks renders at a time).
  it("tiles present: ghost + trigger opens overlay; file item calls addFile, note/link items open dialogs", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: {
        ...makeDetail("n1"),
        sources: [{ id: "s1", name: "note.txt", ext: "txt", body: "hi", position: 0 }],
      },
      ensureNoteSummaries: async () => new Map(),
    } as never);
    render(<AttachmentsBar />);

    await user.click(screen.getByTestId("attachments-ghost-trigger"));
    await user.click(screen.getByTestId("attachments-add-file"));
    expect(addFile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("attachments-ghost-trigger"));
    await user.click(screen.getByTestId("attachments-add-note"));
    expect(screen.getByText("Add a note")).toBeTruthy();
    expect(screen.getByText("Note name")).toBeTruthy();

    // Close via cancel (default PromptDialog cancel label).
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await user.click(screen.getByTestId("attachments-ghost-trigger"));
    await user.click(screen.getByTestId("attachments-add-link"));
    expect(screen.getByText("Add a link")).toBeTruthy();
    expect(screen.getByText("Link URL")).toBeTruthy();
  });

  it("empty state: centered quick-add icons call addFile/open dialogs directly (no overlay)", async () => {
    const user = userEvent.setup();
    // Default beforeEach note has no sources/attachments/sections → tiles.length === 0.
    render(<AttachmentsBar />);

    // No overlay trigger in the empty state — the testid buttons are directly clickable.
    expect(screen.queryByTestId("attachments-ghost-trigger")).toBeNull();

    await user.click(screen.getByTestId("attachments-add-file"));
    expect(addFile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("attachments-add-note"));
    expect(screen.getByText("Add a note")).toBeTruthy();
  });

  it("ghost entry points are absent when collapsed or on the related tab", () => {
    const { rerender } = render(<AttachmentsBar />);
    expect(screen.getByTestId("attachments-add-file")).toBeTruthy();

    useUiStore.setState({ attachmentsCollapsed: true, attachmentsTab: "attachments" });
    rerender(<AttachmentsBar />);
    expect(screen.queryByTestId("attachments-add-file")).toBeNull();

    useUiStore.setState({ attachmentsCollapsed: false, attachmentsTab: "related" });
    rerender(<AttachmentsBar />);
    expect(screen.queryByTestId("attachments-add-file")).toBeNull();
    expect(screen.queryByTestId("attachments-add-note")).toBeNull();
    expect(screen.queryByTestId("attachments-add-link")).toBeNull();
  });

  it("header no longer carries the file/note/link add buttons, nor related-add-internal", () => {
    const { rerender } = render(<AttachmentsBar />);
    const header = () => screen.getByTestId("attachments-header");
    expect(within(header()).queryByTestId("attachments-add-file")).toBeNull();
    expect(within(header()).queryByTestId("attachments-add-note")).toBeNull();
    expect(within(header()).queryByTestId("attachments-add-link")).toBeNull();

    useUiStore.setState({ attachmentsTab: "related" });
    rerender(<AttachmentsBar />);
    expect(within(header()).queryByTestId("related-add-internal")).toBeNull();
  });

  // W22 ⑥: related tab's ghost + is a single-action button (no overlay — one item is overkill
  // for a menu) that absorbed the header's old related-add-internal button (testid reused).
  it("related tab: empty-state ghost + opens the internal-note dialog directly", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ attachmentsTab: "related", attachmentsCollapsed: false });
    render(<AttachmentsBar />);

    const trigger = screen.getByTestId("related-add-internal");
    await user.click(trigger);
    expect(screen.getByTestId("internal-note-search")).toBeTruthy();
  });

  it("header height token is identical on attachments, related, and collapsed", () => {
    const { rerender } = render(<AttachmentsBar />);
    const read = () => screen.getByTestId("attachments-header").style.height;

    expect(read()).toBe(HEADER_HEIGHT);

    useUiStore.setState({ attachmentsTab: "related" });
    rerender(<AttachmentsBar />);
    expect(read()).toBe(HEADER_HEIGHT);

    useUiStore.setState({ attachmentsCollapsed: true, attachmentsTab: "attachments" });
    rerender(<AttachmentsBar />);
    expect(read()).toBe(HEADER_HEIGHT);
  });

  it("outer bar exposes data-note-drop-target=related", () => {
    useUiStore.setState({ attachmentsTab: "related", attachmentsCollapsed: false });
    render(<AttachmentsBar />);
    expect(screen.getByTestId("attachments-drop-target").getAttribute("data-note-drop-target")).toBe(
      "related",
    );
  });

  it("drop target stays on outer bar while attachments tab is active", () => {
    useUiStore.setState({ attachmentsTab: "attachments", attachmentsCollapsed: false });
    render(<AttachmentsBar />);
    expect(screen.getByTestId("attachments-drop-target").getAttribute("data-note-drop-target")).toBe(
      "related",
    );
  });

  it("drop target stays on outer bar while collapsed", () => {
    useUiStore.setState({ attachmentsTab: "attachments", attachmentsCollapsed: true });
    render(<AttachmentsBar />);
    expect(screen.getByTestId("attachments-drop-target").getAttribute("data-note-drop-target")).toBe(
      "related",
    );
  });

  it("drop handler ignores non-related targetId (does not call addInternal)", async () => {
    useUiStore.setState({ attachmentsTab: "related" });
    render(<AttachmentsBar />);
    expect(dropHandlers.size).toBeGreaterThan(0);

    fireDrop("n2", "folder:f1");
    fireDrop("n2", "section:tags");
    await Promise.resolve();
    expect(addInternal).not.toHaveBeenCalled();
  });

  it("valid related drop resolves title, calls addInternal, opens related tab expanded", async () => {
    useUiStore.setState({ attachmentsTab: "attachments", attachmentsCollapsed: true });
    render(<AttachmentsBar />);

    fireDrop("n2", "related");
    await waitFor(() => {
      expect(addInternal).toHaveBeenCalledWith("n2", "Title n2");
    });
    expect(useUiStore.getState().attachmentsTab).toBe("related");
    expect(useUiStore.getState().attachmentsCollapsed).toBe(false);
  });

  it("self-link drop does not call addInternal and leaves tab/collapse unchanged", async () => {
    useUiStore.setState({ attachmentsTab: "attachments", attachmentsCollapsed: true });
    render(<AttachmentsBar />);
    fireDrop("n1", "related");
    await Promise.resolve();
    await Promise.resolve();
    expect(addInternal).not.toHaveBeenCalled();
    expect(useUiStore.getState().attachmentsTab).toBe("attachments");
    expect(useUiStore.getState().attachmentsCollapsed).toBe(true);
  });

  it("duplicate internal link drop does not call addInternal", async () => {
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        {
          id: "a1",
          name: "linked",
          kind: "internal",
          rel_path: null,
          url: "n2",
          size_bytes: null,
          position: 0,
        },
      ]),
      ensureNoteSummaries: async (ids: string[]) => {
        const m = new Map<string, NoteSummary>();
        for (const id of ids) m.set(id, makeSummary(id, `Title ${id}`));
        return m;
      },
    } as never);
    useUiStore.setState({ attachmentsTab: "related" });
    render(<AttachmentsBar />);

    fireDrop("n2", "related");
    await Promise.resolve();
    await Promise.resolve();
    expect(addInternal).not.toHaveBeenCalled();
  });
});

/* "open externally" affordance — the bar's tile is a preview list (single click opens the
 * preview panel), and the OS-handler launch lives on a second interaction. Before the fix
 * users reported "clicking it doesn't run anything" because the preview panel for
 * unknown-extension doc files renders NoFormatFallback, where the open button is easy to
 * miss. The fix routes double-click on the attachment tile to attachment_open — the
 * established pattern for the related-note tile (single click = preview, double click =
 * open in tab). Gallery tiles still open on single click; that difference is intentional. */
describe("AttachmentsBar attachment tile open affordance", () => {
  const att = (over: Partial<Attachment> & { id: string; name: string; kind: Attachment["kind"] }): Attachment => ({
    id: over.id,
    name: over.name,
    kind: over.kind,
    rel_path: over.rel_path ?? `n1/${over.name}`,
    url: over.url ?? null,
    size_bytes: over.size_bytes ?? 100,
    position: over.position ?? 0,
  });

  beforeEach(() => {
    callMock.mockReset();
    useUiStore.setState({
      attachmentsCollapsed: false,
      attachmentsTab: "attachments",
      previewItem: null,
    });
  });

  it("double-clicking an attachment tile (doc, unknown extension) calls attachment_open", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        att({ id: "a1", name: "design.afdesign", kind: "doc" }),
      ]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/design\.afdesign/);
    await user.dblClick(tile);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("attachment_open", { id: "a1" });
    });
  });

  it("double-clicking an attachment tile (image, .png) calls attachment_open", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        att({ id: "a2", name: "scan.png", kind: "image" }),
      ]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/scan\.png/);
    await user.dblClick(tile);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("attachment_open", { id: "a2" });
    });
  });

  it("single click on an attachment tile does NOT call attachment_open", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        att({ id: "a3", name: "bundle.zip", kind: "doc" }),
      ]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/bundle\.zip/);
    await user.click(tile);

    // Debounced ~250ms so a double-click does not flash the preview open-then-closed.
    await waitFor(() => {
      expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a3" });
    });
    expect(callMock).not.toHaveBeenCalledWith("attachment_open", expect.anything());
  });

  it("source tile double-click still opens rename, not attachment_open", async () => {
    // Source tiles already use onDoubleClick for rename; that contract must not regress.
    const user = userEvent.setup();
    const source: Source = {
      id: "s1",
      name: "note.txt",
      ext: "txt",
      body: "hello",
      position: 0,
    };
    useNotesStore.setState({
      activeNote: { ...makeDetail("n1"), sources: [source] },
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/note\.txt/);
    await user.dblClick(tile);

    expect(callMock).not.toHaveBeenCalledWith("attachment_open", expect.anything());
  });
});

/* Owner spec (6차 QA): the tile whose item is the active preview gets a border highlight
 * (data-active, tokens.css) + aria-pressed, and re-clicking (or Enter/Space on) that same
 * tile toggles the preview off — own-inverse toggle, the calendar-day-pick / tag-select
 * convention. A click on a *different* tile switches the highlight instead of stacking it. */
describe("AttachmentsBar active-preview toggle", () => {
  const att = (over: Partial<Attachment> & { id: string; name: string; kind: Attachment["kind"] }): Attachment => ({
    id: over.id,
    name: over.name,
    kind: over.kind,
    rel_path: over.rel_path ?? `n1/${over.name}`,
    url: over.url ?? null,
    size_bytes: over.size_bytes ?? 100,
    position: over.position ?? 0,
  });

  beforeEach(() => {
    callMock.mockReset();
    removeTile.mockClear();
    useUiStore.setState({
      attachmentsCollapsed: false,
      attachmentsTab: "attachments",
      previewItem: null,
    });
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        att({ id: "a1", name: "bundle.zip", kind: "doc" }),
        att({ id: "a2", name: "scan.png", kind: "image" }),
      ]),
      ensureNoteSummaries: async () => new Map(),
    } as never);
  });

  it("click sets the preview and marks the tile active; click again clears both", async () => {
    const user = userEvent.setup();
    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/bundle\.zip/);

    expect(tile.getAttribute("data-active")).toBeNull();
    expect(tile.getAttribute("aria-pressed")).toBe("false");

    await user.click(tile);
    await waitFor(() => {
      expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a1" });
    });
    expect(tile.getAttribute("data-active")).toBe("true");
    expect(tile.getAttribute("aria-pressed")).toBe("true");

    await user.click(tile);
    await waitFor(() => {
      expect(useUiStore.getState().previewItem).toBeNull();
    });
    expect(tile.getAttribute("data-active")).toBeNull();
    expect(tile.getAttribute("aria-pressed")).toBe("false");
  });

  it("Enter and Space on a focused tile toggle the same way as a click", async () => {
    const user = userEvent.setup();
    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/bundle\.zip/);
    tile.focus();

    // Keyboard toggles immediately (no double-click race to debounce).
    await user.keyboard("{Enter}");
    expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a1" });
    expect(tile.getAttribute("data-active")).toBe("true");

    await user.keyboard(" ");
    expect(useUiStore.getState().previewItem).toBeNull();
    expect(tile.getAttribute("data-active")).toBeNull();
  });

  it("clicking a different tile switches the highlight instead of stacking it", async () => {
    const user = userEvent.setup();
    render(<AttachmentsBar />);
    const tileA = screen.getByTitle(/bundle\.zip/);
    const tileB = screen.getByTitle(/scan\.png/);

    await user.click(tileA);
    await waitFor(() => {
      expect(tileA.getAttribute("data-active")).toBe("true");
    });
    expect(tileB.getAttribute("data-active")).toBeNull();

    await user.click(tileB);
    await waitFor(() => {
      expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a2" });
    });
    expect(tileA.getAttribute("data-active")).toBeNull();
    expect(tileB.getAttribute("data-active")).toBe("true");
  });

  it("Enter on the tile's own delete (X) button deletes — it does not bubble into the tile's toggle", async () => {
    // AttachmentTile's `deleteStopsKeyDownPropagation` guard exists precisely so a
    // keyboard-operable tile's own Enter/Space handling doesn't hijack the X button's Enter.
    // Making these tiles keyboard-toggleable (role="button"/tabIndex/onKeyDown, this suite)
    // must not silently turn "delete" into "toggle preview" for keyboard users.
    const user = userEvent.setup();
    render(<AttachmentsBar />);
    const tile = screen.getByTitle(/bundle\.zip/);
    const deleteBtn = within(tile).getByRole("button", { name: /remove/i });

    deleteBtn.focus();
    await user.keyboard("{Enter}");

    expect(removeTile).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().previewItem).toBeNull();
  });
});

/* Owner decision (각주 뷰 재설계): footnote attachments collapse into ONE synthetic tile
 * ("각주 N") that opens the note-scoped footnotes list — no per-footnote tiles, so they also
 * drop out of the multi-select id space (intended: batch ops on individual footnotes from the
 * strip are gone). */
describe("AttachmentsBar footnote tile", () => {
  const fn = (id: string, url: string | null = null): Attachment => ({
    id,
    name: `${id}.md`,
    kind: "footnote" as Attachment["kind"],
    rel_path: `n1/${id}.md`,
    url,
    size_bytes: 20,
    position: 0,
  });

  beforeEach(() => {
    callMock.mockReset();
    useUiStore.setState({
      attachmentsCollapsed: false,
      attachmentsTab: "attachments",
      previewItem: null,
    });
  });

  it("renders one tile for N footnotes and counts as one item", () => {
    useNotesStore.setState({
      activeNote: makeDetail("n1", [fn("f1", "anchor one"), fn("f2", "anchor two"), fn("f3")]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    // "Footnotes · 3" (title/aria) — one tile, not three.
    const tiles = screen.getAllByRole("button", { name: /Footnotes · 3/ });
    expect(tiles).toHaveLength(1);
    expect(screen.queryByTitle(/f1\.md/)).toBeNull();
    expect(screen.queryByTitle(/f2\.md/)).toBeNull();
    expect(screen.getByTestId("attachments-header").textContent).toContain("1 item");
  });

  it("clicking it opens the note-scoped footnotes list (no id, no focus)", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: makeDetail("n1", [fn("f1"), fn("f2")]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const tile = screen.getByRole("button", { name: /Footnotes · 2/ });
    await user.click(tile);

    await waitFor(() => {
      expect(useUiStore.getState().previewItem).toEqual({ kind: "footnotes" });
    });
    expect(tile.getAttribute("data-active")).toBe("true");
  });

  it("stays active while a body marker moves the focus inside the list", () => {
    useNotesStore.setState({
      activeNote: makeDetail("n1", [fn("f1"), fn("f2")]),
      ensureNoteSummaries: async () => new Map(),
    } as never);
    useUiStore.setState({ previewItem: { kind: "footnotes", focusId: "f2" } });

    render(<AttachmentsBar />);
    expect(screen.getByRole("button", { name: /Footnotes · 2/ }).getAttribute("data-active")).toBe("true");
  });

  it("no tile at all when the note has no footnotes", () => {
    useNotesStore.setState({
      activeNote: makeDetail("n1", []),
      ensureNoteSummaries: async () => new Map(),
    } as never);
    render(<AttachmentsBar />);
    expect(screen.queryByRole("button", { name: /Footnotes/ })).toBeNull();
  });

  it("clicking tab title while collapsed switches tab and expands bar", async () => {
    const user = userEvent.setup();
    useNotesStore.setState({
      activeNote: makeDetail("n1", []),
      ensureNoteSummaries: async () => new Map(),
    } as never);
    useUiStore.setState({ attachmentsCollapsed: true, attachmentsTab: "attachments" });

    render(<AttachmentsBar />);
    const relatedTab = screen.getByText("Related notes");
    await user.click(relatedTab);

    expect(useUiStore.getState().attachmentsCollapsed).toBe(false);
    expect(useUiStore.getState().attachmentsTab).toBe("related");
  });
});

describe("AttachmentsBar — promote tile to section (섹션으로 가져오기)", () => {
  const source: Source = { id: "s1", name: "notes.txt", ext: "txt", body: "hello world", position: 0 };

  beforeEach(() => {
    callMock.mockReset();
    attachmentsBaseDir = null;
    useUiStore.setState({ attachmentsCollapsed: false, attachmentsTab: "attachments", previewItem: null });
  });

  it("source tile: context menu row always appears; clicking it hits section_create_with_body, never section_import_file", async () => {
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "section_create_with_body") {
        return { id: "sec1", name: args.name, body_md: args.body_md, position: 0, kind: args.kind ?? "text" };
      }
      return undefined;
    });
    useNotesStore.setState({
      activeNote: makeDetail("n1", [], [source]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    fireEvent.contextMenu(screen.getByTitle(/notes\.txt/));
    fireEvent.click(await screen.findByTestId("promote-tile-to-section"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "section_create_with_body",
        expect.objectContaining({ note_id: "n1", name: "notes.txt", body_md: "hello world" }),
      );
    });
    expect(callMock).not.toHaveBeenCalledWith("section_import_file", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("section_import_scan", expect.anything());
  });

  it("promotable attachment (.md, desktop baseDir set): context menu row appears; clicking it resolves baseDir+rel_path and hits section_import_file, never section_create_with_body", async () => {
    attachmentsBaseDir = "C:/attach-base";
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "section_import_scan") return { files: args.paths, skipped: 0 };
      if (cmd === "section_import_file") {
        return { sections: [{ id: "sec2", name: "notes", body_md: "", position: 0, kind: "text" }], truncated: false };
      }
      return undefined;
    });
    const att: Attachment = {
      id: "a1",
      name: "notes.md",
      kind: "doc",
      rel_path: "n1/notes.md",
      url: null,
      size_bytes: 10,
      position: 0,
    };
    useNotesStore.setState({
      activeNote: makeDetail("n1", [att]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    fireEvent.contextMenu(screen.getByTitle(/notes\.md/));
    fireEvent.click(await screen.findByTestId("promote-tile-to-section"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("section_import_scan", { paths: ["C:/attach-base/n1/notes.md"] });
    });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "section_import_file",
        expect.objectContaining({ note_id: "n1", file_path: "C:/attach-base/n1/notes.md" }),
      );
    });
    expect(callMock).not.toHaveBeenCalledWith("section_create_with_body", expect.anything());
  });

  it("promotable .hwpx attachment: same importFilesAsSections batch → doc_import_html → section_create_with_body (서식형), never section_import_file", async () => {
    attachmentsBaseDir = "C:/attach-base";
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "section_import_scan") return { files: args.paths, skipped: 0 };
      if (cmd === "doc_import_html") return { name: "보고서", html: "<p>본문</p>", image_count: 0, dropped: [] };
      if (cmd === "section_create_with_body") {
        return { id: "sec3", name: args.name, body_md: args.body_md, position: 0, kind: "text" };
      }
      return undefined;
    });
    const att: Attachment = {
      id: "a3",
      name: "보고서.hwpx",
      kind: "doc",
      rel_path: "n1/보고서.hwpx",
      url: null,
      size_bytes: 10,
      position: 0,
    };
    useNotesStore.setState({
      activeNote: makeDetail("n1", [att]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    fireEvent.contextMenu(screen.getByTitle(/보고서\.hwpx/));
    fireEvent.click(await screen.findByTestId("promote-tile-to-section"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("doc_import_html", {
        note_id: "n1",
        file_path: "C:/attach-base/n1/보고서.hwpx",
      });
    });
    // 서식형은 mdSerialize(TipTap 스키마)를 동적 import 한다 — 부하가 큰 전체 실행에서는 첫 변환이 느려
    // 기본 waitFor(1s)·테스트(5s) 시간을 넘길 수 있다(앱에서는 에디터가 이미 올려 둔 모듈이라 해당 없음).
    await waitFor(
      () => {
        expect(callMock).toHaveBeenCalledWith(
          "section_create_with_body",
          expect.objectContaining({ note_id: "n1", name: "보고서", body_md: "본문" }),
        );
      },
      { timeout: 20000 },
    );
    expect(callMock).not.toHaveBeenCalledWith("section_import_file", expect.anything());
  }, 30000);

  it("non-promotable attachment (image extension) shows no promote row on right-click", () => {
    const img: Attachment = {
      id: "a2",
      name: "scan.png",
      kind: "image",
      rel_path: "n1/scan.png",
      url: null,
      size_bytes: 10,
      position: 0,
    };
    useNotesStore.setState({
      activeNote: makeDetail("n1", [img]),
      ensureNoteSummaries: async () => new Map(),
    } as never);
    render(<AttachmentsBar />);
    fireEvent.contextMenu(screen.getByTitle(/scan\.png/));
    expect(screen.queryByTestId("promote-tile-to-section")).toBeNull();
  });

  it("link attachment (no rel_path — nothing on disk) shows no promote row on right-click", () => {
    const link: Attachment = {
      id: "a3",
      name: "https://example.com",
      kind: "link",
      rel_path: null,
      url: "https://example.com",
      size_bytes: null,
      position: 0,
    };
    useNotesStore.setState({
      activeNote: makeDetail("n1", [link]),
      ensureNoteSummaries: async () => new Map(),
    } as never);
    render(<AttachmentsBar />);
    fireEvent.contextMenu(screen.getByTitle(/example\.com/));
    expect(screen.queryByTestId("promote-tile-to-section")).toBeNull();
  });
});

/* 첨부 스트립 타일도 갤러리와 같은 형식 자리표시를 쓴다. 문구가 아니라 DOM 으로 단언한다. */
describe("AttachmentsBar 형식 자리표시", () => {
  const att = (over: Partial<Attachment> & { id: string; name: string; kind: Attachment["kind"] }): Attachment => ({
    id: over.id,
    name: over.name,
    kind: over.kind,
    rel_path: over.rel_path ?? `n1/${over.name}`,
    url: over.url ?? null,
    size_bytes: over.size_bytes ?? 100,
    position: over.position ?? 0,
  });

  beforeEach(() => {
    callMock.mockReset();
    useUiStore.setState({ attachmentsCollapsed: false, attachmentsTab: "attachments", previewItem: null });
  });

  it("갈래마다 다른 상자 + 확장자 글자, 파일이 아닌 링크는 상자 없음", () => {
    useNotesStore.setState({
      activeNote: makeDetail("n1", [
        att({ id: "a1", name: "treaty.pdf", kind: "doc" }),
        att({ id: "a2", name: "rows.csv", kind: "doc" }),
        att({ id: "a3", name: "clip.mp4", kind: "doc" }),
        // rel_path 가 없는 참조 첨부 — 썸네일 키가 rel_path 규약이라 영영 썸네일이 없다.
        att({ id: "a4", name: "trip.jpg", kind: "image", rel_path: null }),
        att({ id: "a5", name: "https://example.com", kind: "link", rel_path: null, url: "https://example.com" }),
      ]),
      ensureNoteSummaries: async () => new Map(),
    } as never);

    render(<AttachmentsBar />);
    const shape = (title: RegExp) =>
      within(screen.getByTitle(title)).queryByText((_c, el) => el?.hasAttribute("data-file-group") ?? false);

    expect(shape(/treaty\.pdf/)?.dataset.fileGroup).toBe("doc");
    expect(shape(/treaty\.pdf/)?.dataset.fileExt).toBe("PDF");
    expect(shape(/rows\.csv/)?.dataset.fileGroup).toBe("sheet");
    expect(shape(/clip\.mp4/)?.dataset.fileGroup).toBe("video");
    expect(shape(/trip\.jpg/)?.dataset.fileGroup).toBe("photo");
    expect(shape(/trip\.jpg/)?.dataset.fileExt).toBe("JPG");
    expect(shape(/example\.com/)).toBeNull();
  });
});
