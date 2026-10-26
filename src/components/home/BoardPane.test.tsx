import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, act, within } from "@testing-library/react";
import { BoardPane } from "./BoardPane";
import { __resetCoverCache } from "./board/BoardCard";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { useSearchStore } from "../../stores/search";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { t } from "../../i18n/t";
import type { BoardResult } from "../../lib/commands.gen";
import type { NoteDropHandler } from "../../lib/noteDrag";

const callMock = vi.fn();
const selectNoteMock = vi.fn(async () => {});
const dropHandlers = new Set<NoteDropHandler>();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: () => () => {},
  flushAll: async () => {},
}));


// Cover thumbnail resolves through attachmentsBase — stub it so a resolved rel_path turns
// into a deterministic <img src> the tests can assert on (real hook is exercised elsewhere).
vi.mock("../../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({
    baseDir: "C:/atts",
    convert: (p: string) => `asset://${p}`,
  }),
}));

// jsdom has no IntersectionObserver — BoardCard's lazy-cover hook guards on that and simply
// never fires (see SettingsNav.tsx for the same convention), so laziness itself is untestable
// without a stand-in. This one is inert until a test calls .trigger() on the instance that
// observed a given card, mirroring a real "scrolled into view" callback.
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  elements: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.push(el);
  }
  unobserve() {}
  disconnect() {}
  trigger(el: Element) {
    this.cb(
      [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

vi.mock("../../lib/noteDrag", async () => {
  const actual = await vi.importActual<typeof import("../../lib/noteDrag")>(
    "../../lib/noteDrag",
  );
  return {
    ...actual,
    registerNoteDropHandler: (h: NoteDropHandler) => {
      dropHandlers.add(h);
      return () => {
        dropHandlers.delete(h);
      };
    },
    // No-op drag start in unit tests (threshold / ghost not needed).
    startNoteDrag: vi.fn(),
  };
});

const patchNoteSummaryMock = vi.fn();
const newNoteMock = vi.fn(async () => {});
const setStatusMock = vi.fn(async () => {});
// Mutable so tests can populate folder_id per note (BoardNote itself carries no folder_id — the
// real BoardPane resolves it through this same noteIndex, see BoardPane.tsx). Reset in beforeEach.
let mockNoteIndex = new Map<string, { folder_id: string }>();

vi.mock("../../stores/notes", () => ({
  // BoardCard 가 카드 제목을 이것으로 그린다 — notesActive.displayTitle 과 같은 판정(GalleryExpanded.test 관례).
  displayTitle: (t: string) => (t.trim() && t !== "Untitled Note" ? t : "Untitled Note"),
  useNotesStore: Object.assign(
    (sel: (s: {
      selectNote: typeof selectNoteMock;
      activeNote: null;
      noteIndex: Map<string, { folder_id: string }>;
      patchNoteSummary: typeof patchNoteSummaryMock;
    }) => unknown) =>
      sel({
        selectNote: selectNoteMock,
        activeNote: null,
        noteIndex: mockNoteIndex,
        patchNoteSummary: patchNoteSummaryMock,
      }),
    {
      getState: () => ({
        selectNote: selectNoteMock,
        activeNote: null,
        noteIndex: mockNoteIndex,
        patchNoteSummary: patchNoteSummaryMock,
        newNote: newNoteMock,
        setStatus: setStatusMock,
      }),
    },
  ),
}));

function boardFixture(overrides?: Partial<BoardResult>): BoardResult {
  return {
    columns: [
      {
        status: null,
        status_label: null,
        notes: [
          {
            id: "n-none",
            title: "Loose note",
            year: 2020,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            remind: false,
            updated_at: "2026-07-30T00:00:00Z",
            unchecked_count: 0,
            items: [],
          },
        ],
      },
      {
        status: "in_progress",
        status_label: "in_progress",
        notes: [
          {
            id: "n-ip",
            title: "Urgent walk",
            year: 2026,
            month: 7,
            day: 1,
            // Past + remind=true relative to the fake "now" set in beforeEach (2026-07-31) —
            // pin dot renders (Dashboard Wave 3, 2026-08-01).
            end_year: 2026,
            end_month: 7,
            end_day: 30,
            remind: true,
            updated_at: "2026-07-29T00:00:00Z",
            unchecked_count: 2,
            items: [
              {
                section_id: "s1",
                line_index: 0,
                text: "pack bag",
                checked: false,
              },
              {
                section_id: "s1",
                line_index: 1,
                text: "buy water",
                checked: false,
              },
            ],
          },
        ],
      },
      {
        status: "exported",
        status_label: "exported",
        notes: [],
      },
      {
        status: "done",
        status_label: "done",
        notes: [],
      },
    ],
    total_matched: 2,
    cap: 1000,
    capped: false,
    ...overrides,
  };
}

// Fixture with 3 notes in one column, deliberately ordered so server order (schedule),
// updated_at desc (recent) and title asc all disagree — pins each sort mode unambiguously.
function sortFixture(): BoardResult {
  return {
    columns: [
      { status: null, status_label: null, notes: [] },
      {
        status: "in_progress",
        status_label: "in_progress",
        notes: [
          {
            id: "n-ip",
            title: "Urgent walk",
            year: 2026,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            remind: false,
            updated_at: "2026-07-29T00:00:00Z",
            unchecked_count: 0,
            items: [],
          },
          {
            id: "n-b",
            title: "Banana",
            year: 2026,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            remind: false,
            updated_at: "2026-07-28T00:00:00Z",
            unchecked_count: 0,
            items: [],
          },
          {
            id: "n-a",
            title: "Apple",
            year: 2026,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            remind: false,
            updated_at: "2026-07-31T00:00:00Z",
            unchecked_count: 0,
            items: [],
          },
        ],
      },
      { status: "exported", status_label: "exported", notes: [] },
      { status: "done", status_label: "done", notes: [] },
    ],
    total_matched: 3,
    cap: 1000,
    capped: false,
  };
}

describe("BoardPane (Wave 4)", () => {
  beforeEach(() => {
    // The pin predicate (board/status.ts::isPinned) is relative to "now" — pin only Date (not
    // setTimeout/setInterval, which `waitFor` below relies on) so fixtures with a fixed end
    // date (e.g. 2026-07-30) are deterministically in the past regardless of when the test
    // suite actually runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 31, 12, 0, 0)); // 2026-07-31 local
    callMock.mockReset();
    selectNoteMock.mockReset();
    patchNoteSummaryMock.mockReset();
    newNoteMock.mockReset();
    setStatusMock.mockReset();
    dropHandlers.clear();
    __resetCoverCache(); // module-level cache — stale entries from a prior test would leak in
    MockIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    useSettingsStore.setState({ activeWorkspaceId: "ws1" });
    useUiStore.setState({ ctxOpen: null, dashboardFolderFilter: null });
    // Module-level singleton shared with the dashboard search box — reset so a query left over
    // from another test in this file never leaks into an unrelated one.
    useSearchStore.setState({ query: "", searchResults: [] });
    mockNoteIndex = new Map();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        return Promise.resolve(boardFixture());
      }
      if (cmd === "note_set_status") {
        return Promise.resolve({
          id: "n-ip",
          folder_id: "f1",
          title: "Urgent walk",
          year: null,
          is_favorite: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          status: "done",
          icon: null,
          lat: null,
          lng: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-07-31T12:00:00Z",
          month: null,
          day: null,
        });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads dashboard_board for the active workspace and renders columns × cards", async () => {
    const { getByTestId, getAllByTestId } = render(<BoardPane />);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("dashboard_board", {
        workspace_id: "ws1",
      });
    });

    await waitFor(() => {
      expect(getByTestId("board-columns")).toBeDefined();
    });

    const cols = getAllByTestId("board-column");
    expect(cols.length).toBe(4);
    expect(cols[0].getAttribute("data-status")).toBe("__none__");
    expect(cols[1].getAttribute("data-status")).toBe("in_progress");

    const cards = getAllByTestId("board-card");
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.getAttribute("data-note-id")).sort()).toEqual([
      "n-ip",
      "n-none",
    ]);

    // Unchecked count collapsed on card with todos
    const badge = getAllByTestId("board-unchecked-badge")[0];
    expect(badge.textContent).toContain("2");

    // Neutral date-range text always shows on every card (Dashboard Wave 3, 2026-08-01).
    expect(getAllByTestId("board-date-range").length).toBe(2);
    // Pin dot only on the remind-flagged, past-end card.
    expect(getAllByTestId("board-pin-dot").length).toBe(1);

    // capped/total_matched are server-side fields only — no UI banner.
    expect(() => getByTestId("board-capped-banner")).toThrow();
  });

  it("new-status slot sits at the far right of the column row; + → input → Enter adds the status (2026-09-08)", async () => {
    const addStatusMock = vi.fn().mockResolvedValue(undefined);
    useTaxonomyStore.setState({ addStatus: addStatusMock } as never);
    const { getByTestId, queryByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getByTestId("board-columns")).toBeDefined());

    const columns = getByTestId("board-columns");
    expect(columns.lastElementChild).toBe(getByTestId("board-add-status-slot"));

    fireEvent.click(getByTestId("board-add-status-btn"));
    const input = getByTestId("board-add-status-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  검토  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addStatusMock).toHaveBeenCalledWith("검토");
    // Back to the "+" after commit; Escape on an empty draft adds nothing.
    fireEvent.click(getByTestId("board-add-status-btn"));
    fireEvent.keyDown(getByTestId("board-add-status-input"), { key: "Escape" });
    expect(addStatusMock).toHaveBeenCalledTimes(1);
    expect(queryByTestId("board-add-status-input")).toBeNull();

    // status_add_locked hides the slot entirely.
    act(() => useSettingsStore.setState({ statusAddLocked: true }));
    expect(queryByTestId("board-add-status-slot")).toBeNull();
    act(() => useSettingsStore.setState({ statusAddLocked: false }));
  });

  it("dashboard-wide folder filter (stores/ui.ts) narrows board cards to the matching folder, AND'd with existing state", async () => {
    // BoardNote carries no folder_id — BoardPane resolves it per-card through noteIndex (the
    // same store loadTree() already populates for the whole workspace).
    mockNoteIndex = new Map([
      ["n-none", { folder_id: "f1" }],
      ["n-ip", { folder_id: "f2" }],
    ]);

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    act(() => {
      useUiStore.getState().toggleDashboardFolderFilter("f2");
    });

    await waitFor(() => {
      const cards = getAllByTestId("board-card");
      expect(cards.length).toBe(1);
      expect(cards[0].getAttribute("data-note-id")).toBe("n-ip");
    });

    // Toggling the same id again clears the filter — server order/columns are otherwise unchanged.
    act(() => {
      useUiStore.getState().toggleDashboardFolderFilter("f2");
    });

    await waitFor(() => {
      expect(getAllByTestId("board-card").length).toBe(2);
    });
  });

  it("stale dashboard_board response for a switched-away notebook never overwrites the new one's board (dashboard audit P1 #1)", async () => {
    let resolveWs1: (v: BoardResult) => void = () => {};
    const ws1Promise = new Promise<BoardResult>((resolve) => {
      resolveWs1 = resolve;
    });
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_board") {
        if (args?.workspace_id === "ws1") return ws1Promise;
        return Promise.resolve({
          columns: [
            { status: null, status_label: null, notes: [] },
            {
              status: "in_progress",
              status_label: "in_progress",
              notes: [
                {
                  id: "n-ws2",
                  title: "Other notebook note",
                  year: 2026,
                  month: null,
                  day: null,
                  end_year: null,
                  end_month: null,
                  end_day: null,
                  remind: false,
                  updated_at: "2026-07-30T00:00:00Z",
                  unchecked_count: 0,
                  items: [],
                },
              ],
            },
            { status: "exported", status_label: "exported", notes: [] },
            { status: "done", status_label: "done", notes: [] },
          ],
          total_matched: 1,
          cap: 1000,
          capped: false,
        } satisfies BoardResult);
      }
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);

    // Switch notebooks before ws1's dashboard_board resolves.
    act(() => {
      useSettingsStore.setState({ activeWorkspaceId: "ws2" });
    });
    await waitFor(() =>
      expect(getAllByTestId("board-card").map((c) => c.getAttribute("data-note-id"))).toEqual([
        "n-ws2",
      ]),
    );

    // The stale ws1 response lands late — must not clobber ws2's board.
    await act(async () => {
      resolveWs1(boardFixture());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getAllByTestId("board-card").map((c) => c.getAttribute("data-note-id"))).toEqual([
      "n-ws2",
    ]);
  });

  it("card double-click opens the note tab via selectNote", async () => {
    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    fireEvent.dblClick(getAllByTestId("board-card").find((c) => c.getAttribute("data-note-id") === "n-ip")!);
    expect(selectNoteMock).toHaveBeenCalledWith("n-ip");
  });

  it("a single card click focuses it in place instead of opening it; empty space clears it", async () => {
    const { getAllByTestId, getByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    const card = getAllByTestId("board-card").find((c) => c.getAttribute("data-note-id") === "n-ip")!;
    fireEvent.click(card);
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(card.getAttribute("data-focused")).toBe("true");

    fireEvent.click(getByTestId("board-columns"));
    expect(card.getAttribute("data-focused")).toBeNull();
  });

  it("empty columns show quiet empty copy; all-empty workspace shows banner", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        return Promise.resolve({
          columns: [
            { status: null, status_label: null, notes: [] },
            { status: "in_progress", status_label: "in_progress", notes: [] },
          ],
          total_matched: 0,
          cap: 1000,
          capped: false,
        } satisfies BoardResult);
      }
      return Promise.resolve({});
    });

    const { getByTestId, getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getByTestId("board-workspace-empty")).toBeDefined());
    expect(getAllByTestId("board-column-empty").length).toBe(2);
  });

  it("empty column ghost add button invokes newNote and setStatus with column status", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        return Promise.resolve({
          columns: [
            { status: "in_progress", status_label: "in_progress", notes: [] },
          ],
          total_matched: 0,
          cap: 1000,
          capped: false,
        } satisfies BoardResult);
      }
      return Promise.resolve({});
    });

    const { getByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getByTestId("board-column-empty-add")).toBeDefined());

    fireEvent.click(getByTestId("board-column-empty-add"));
    await waitFor(() => expect(newNoteMock).toHaveBeenCalled());
    expect(setStatusMock).toHaveBeenCalledWith("in_progress");
  });

  it("no workspace id → quiet empty state, no IPC", async () => {
    useSettingsStore.setState({ activeWorkspaceId: null });
    const { getByTestId } = render(<BoardPane />);
    await act(async () => {});
    expect(getByTestId("board-pane").textContent).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith(
      "dashboard_board",
      expect.anything(),
    );
  });

  it("keeps server column/note order (no client re-sort)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        return Promise.resolve({
          columns: [
            {
              status: "done",
              status_label: "done",
              notes: [
                {
                  id: "a",
                  title: "first",
                  year: 2026,
                  month: null,
                  day: null,
                  end_year: null,
                  end_month: null,
                  end_day: null,
                  remind: false,
                  updated_at: "2026-01-01T00:00:00Z",
                  unchecked_count: 0,
                  items: [],
                },
                {
                  id: "b",
                  title: "second",
                  year: 2026,
                  month: null,
                  day: null,
                  end_year: null,
                  end_month: null,
                  end_day: null,
                  remind: false,
                  updated_at: "2026-01-02T00:00:00Z",
                  unchecked_count: 0,
                  items: [],
                },
              ],
            },
          ],
          total_matched: 2,
          cap: 1000,
          capped: false,
        } satisfies BoardResult);
      }
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));
    const ids = getAllByTestId("board-card").map((c) => c.getAttribute("data-note-id"));
    expect(ids).toEqual(["a", "b"]);
  });

  it("unchecked badge expands checklist; toggle calls todo_toggle and patches locally", async () => {
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_board") return Promise.resolve(boardFixture());
      if (cmd === "todo_toggle") {
        return Promise.resolve({
          note_id: args?.note_id,
          section_id: args?.section_id,
          line_index: args?.line_index,
          checked: true,
          updated_at: "2026-07-31T12:00:00Z",
        });
      }
      return Promise.resolve({});
    });

    const { getAllByTestId, queryByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    expect(queryByTestId("board-todo-list")).toBeNull();

    fireEvent.click(getAllByTestId("board-unchecked-badge")[0]);
    await waitFor(() => expect(queryByTestId("board-todo-list")).toBeTruthy());

    const card = getAllByTestId("board-card").find(
      (c) => c.getAttribute("data-note-id") === "n-ip",
    )!;
    expect(card.getAttribute("data-expanded")).toBe("true");

    const items = getAllByTestId("board-todo-item");
    expect(items.length).toBe(2);

    const checkbox = items[0].querySelector("input[type=checkbox]") as HTMLInputElement;
    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "todo_toggle",
        expect.objectContaining({
          note_id: "n-ip",
          section_id: "s1",
          line_index: 0,
          expected_checked: false,
        }),
      );
    });

    await waitFor(() => {
      expect(items[0].getAttribute("data-checked")).toBe("true");
    });
    // Unchecked count dropped from 2 → 1 without full refresh
    expect(getAllByTestId("board-unchecked-badge")[0].textContent).toContain("1");
  });

  it("CONFLICT on todo_toggle reloads the board", async () => {
    let boardLoads = 0;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        boardLoads += 1;
        return Promise.resolve(boardFixture());
      }
      if (cmd === "todo_toggle") {
        return Promise.reject({ code: "CONFLICT", message: "stale" });
      }
      return Promise.resolve({});
    });

    const { getAllByTestId, queryByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));
    expect(boardLoads).toBe(1);

    fireEvent.click(getAllByTestId("board-unchecked-badge")[0]);
    await waitFor(() => expect(queryByTestId("board-todo-list")).toBeTruthy());

    const checkbox = getAllByTestId("board-todo-item")[0].querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => expect(boardLoads).toBe(2));
  });

  it("columns expose board-status drop targets; drop moves card optimistically", async () => {
    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    const doneCol = getAllByTestId("board-column").find(
      (c) => c.getAttribute("data-status") === "done",
    )!;
    expect(doneCol.getAttribute("data-note-drop-target")).toBe("board-status:done");

    // Card starts in in_progress
    expect(
      getAllByTestId("board-card")
        .find((c) => c.getAttribute("data-note-id") === "n-ip")!
        .getAttribute("data-status"),
    ).toBe("in_progress");

    expect(dropHandlers.size).toBeGreaterThan(0);
    await act(async () => {
      for (const h of dropHandlers) h("n-ip", "board-status:done", 0, 0);
    });

    await waitFor(() => {
      const card = getAllByTestId("board-card").find(
        (c) => c.getAttribute("data-note-id") === "n-ip",
      )!;
      expect(card.getAttribute("data-status")).toBe("done");
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_set_status",
        expect.objectContaining({ id: "n-ip", status: "done" }),
      );
    });
  });

  it("failed note_set_status rolls the card back to its previous column", async () => {
    let rejectStatus: (e: unknown) => void = () => {};
    const statusPromise = new Promise((_, reject) => {
      rejectStatus = reject;
    });

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") return Promise.resolve(boardFixture());
      if (cmd === "note_set_status") return statusPromise;
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    await act(async () => {
      for (const h of dropHandlers) h("n-ip", "board-status:done", 0, 0);
    });

    // Optimistic move visible while the write is in flight
    await waitFor(() => {
      expect(
        getAllByTestId("board-card")
          .find((c) => c.getAttribute("data-note-id") === "n-ip")!
          .getAttribute("data-status"),
      ).toBe("done");
    });

    await act(async () => {
      rejectStatus({ code: "DB", message: "boom" });
      // Flush microtasks so the catch path runs
      await Promise.resolve().catch(() => {});
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        getAllByTestId("board-card")
          .find((c) => c.getAttribute("data-note-id") === "n-ip")!
          .getAttribute("data-status"),
      ).toBe("in_progress");
    });
  });

  it("rapid double-drag: final column matches the last drop; stale failure does not undo it", async () => {
    type Deferred = {
      resolve: (v: { id: string; status: string | null }) => void;
      reject: (e: unknown) => void;
    };
    const pending: Deferred[] = [];

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") return Promise.resolve(boardFixture());
      if (cmd === "note_set_status") {
        return new Promise((resolve, reject) => {
          pending.push({ resolve: resolve as Deferred["resolve"], reject });
        });
      }
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    // Drag 1: in_progress → done (left in-flight). Fixture columns: null / in_progress / exported / done.
    await act(async () => {
      for (const h of dropHandlers) h("n-ip", "board-status:done", 0, 0);
    });
    await waitFor(() => {
      expect(
        getAllByTestId("board-card")
          .find((c) => c.getAttribute("data-note-id") === "n-ip")!
          .getAttribute("data-status"),
      ).toBe("done");
    });
    expect(pending.length).toBe(1);

    // Drag 2: done → exported (while 1 still in-flight)
    await act(async () => {
      for (const h of dropHandlers) h("n-ip", "board-status:exported", 0, 0);
    });
    await waitFor(() => {
      expect(
        getAllByTestId("board-card")
          .find((c) => c.getAttribute("data-note-id") === "n-ip")!
          .getAttribute("data-status"),
      ).toBe("exported");
    });
    expect(pending.length).toBe(2);

    // Stale drag-1 fails — must NOT roll the card back to in_progress (would undo drag-2).
    await act(async () => {
      pending[0].reject({ code: "DB", message: "stale boom" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      getAllByTestId("board-card")
        .find((c) => c.getAttribute("data-note-id") === "n-ip")!
        .getAttribute("data-status"),
    ).toBe("exported");

    // Drag-2 succeeds — final state stays exported; summary patch is the last write.
    patchNoteSummaryMock.mockClear();
    await act(async () => {
      pending[1].resolve({ id: "n-ip", status: "exported" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        getAllByTestId("board-card")
          .find((c) => c.getAttribute("data-note-id") === "n-ip")!
          .getAttribute("data-status"),
      ).toBe("exported");
    });
    expect(patchNoteSummaryMock).toHaveBeenCalledWith(
      "n-ip",
      expect.objectContaining({ status: "exported" }),
    );
  });

  it("pointer-down on expanded card collapses it (drag-start auto-collapse)", async () => {
    const { getAllByTestId, queryByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    fireEvent.click(getAllByTestId("board-unchecked-badge")[0]);
    await waitFor(() => expect(queryByTestId("board-todo-list")).toBeTruthy());

    const card = getAllByTestId("board-card").find(
      (c) => c.getAttribute("data-note-id") === "n-ip",
    )!;
    expect(card.getAttribute("data-expanded")).toBe("true");

    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    await waitFor(() => expect(card.getAttribute("data-expanded")).toBe("false"));
    expect(queryByTestId("board-todo-list")).toBeNull();
  });

  it("right-click opens the shared note context menu (status change keyboard alt)", async () => {
    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    const card = getAllByTestId("board-card").find(
      (c) => c.getAttribute("data-note-id") === "n-ip",
    )!;
    fireEvent.contextMenu(card, { clientX: 40, clientY: 50 });

    expect(useUiStore.getState().ctxOpen).toEqual({
      noteId: "n-ip",
      x: 40,
      y: 50,
    });
  });

  it("column find filters cards by title substring, client-side", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") return Promise.resolve(sortFixture());
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(3));

    const ipCol = getAllByTestId("board-column").find(
      (c) => c.getAttribute("data-status") === "in_progress",
    )!;

    fireEvent.click(within(ipCol).getByTestId("board-column-filter-toggle"));
    fireEvent.change(within(ipCol).getByTestId("board-column-filter-input"), {
      // Partial, case-insensitive: matches "Banana" only.
      target: { value: "AN" },
    });

    await waitFor(() => {
      const ids = within(ipCol)
        .getAllByTestId("board-card")
        .map((c) => c.getAttribute("data-note-id"));
      expect(ids).toEqual(["n-b"]);
    });

    // Other columns untouched.
    expect(getAllByTestId("board-card").length).toBe(1);
  });

  it("column sort cycles schedule (server order) → recent → title, independently per column", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") return Promise.resolve(sortFixture());
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(3));

    const ipCol = getAllByTestId("board-column").find(
      (c) => c.getAttribute("data-status") === "in_progress",
    )!;
    const idsIn = (col: HTMLElement) =>
      within(col)
        .getAllByTestId("board-card")
        .map((c) => c.getAttribute("data-note-id"));

    // Default is schedule — server order as sent, no client re-sort.
    expect(idsIn(ipCol)).toEqual(["n-ip", "n-b", "n-a"]);

    const sortToggle = within(ipCol).getByTestId("board-column-sort-toggle");
    // Sort mode is now shown as inline text on the button, not just icon+tooltip.
    expect(sortToggle.textContent).toContain(t("home.board.sort_schedule"));

    fireEvent.click(sortToggle);
    expect(sortToggle.getAttribute("data-sort-mode")).toBe("recent");
    expect(sortToggle.textContent).toContain(t("home.board.sort_recent"));
    await waitFor(() => expect(idsIn(ipCol)).toEqual(["n-a", "n-ip", "n-b"]));

    fireEvent.click(sortToggle);
    expect(sortToggle.getAttribute("data-sort-mode")).toBe("title");
    expect(sortToggle.textContent).toContain(t("home.board.sort_title"));
    await waitFor(() => expect(idsIn(ipCol)).toEqual(["n-a", "n-b", "n-ip"]));

    fireEvent.click(sortToggle);
    expect(sortToggle.getAttribute("data-sort-mode")).toBe("schedule");
    expect(sortToggle.textContent).toContain(t("home.board.sort_schedule"));
    await waitFor(() => expect(idsIn(ipCol)).toEqual(["n-ip", "n-b", "n-a"]));
  });

  it("pin dot renders on a remind-flagged past-end card but not in the done column; date text always shows", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "dashboard_board") {
        return Promise.resolve({
          columns: [
            { status: null, status_label: null, notes: [] },
            {
              status: "in_progress",
              status_label: "in_progress",
              notes: [
                {
                  id: "n-overdue",
                  title: "Overdue in-progress",
                  year: 2026,
                  month: 7,
                  day: 1,
                  // Past + remind=true relative to fake "now" 2026-07-31 — pins.
                  end_year: 2026,
                  end_month: 7,
                  end_day: 30,
                  remind: true,
                  updated_at: "2026-07-29T00:00:00Z",
                  unchecked_count: 0,
                  items: [],
                },
              ],
            },
            { status: "exported", status_label: "exported", notes: [] },
            {
              status: "done",
              status_label: "done",
              notes: [
                {
                  id: "n-overdue-done",
                  title: "Overdue but done",
                  year: 2026,
                  month: 7,
                  day: 1,
                  end_year: 2026,
                  end_month: 7,
                  end_day: 30,
                  // Same shape as n-overdue, but the done column exempts it — never pins.
                  remind: true,
                  updated_at: "2026-07-29T00:00:00Z",
                  unchecked_count: 0,
                  items: [],
                },
              ],
            },
          ],
          total_matched: 2,
          cap: 1000,
          capped: false,
        } satisfies BoardResult);
      }
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    // Both notes show the neutral date text regardless of pin state.
    expect(getAllByTestId("board-date-range").length).toBe(2);

    // Only the non-done column's card gets the red pin dot.
    const dots = getAllByTestId("board-pin-dot");
    expect(dots.length).toBe(1);
    const dotCard = dots[0].closest('[data-testid="board-card"]');
    expect(dotCard?.getAttribute("data-note-id")).toBe("n-overdue");
  });

  it("cover thumbnail loads lazily: fetched only once a card is observed in view, then cached", async () => {
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_board") return Promise.resolve(boardFixture());
      if (cmd === "note_cover_images") {
        const ids = (args?.note_ids as string[]) ?? [];
        return Promise.resolve({
          items: ids.map((id) =>
            id === "n-ip"
              ? { note_id: id, rel_path: "n-ip/cover.jpg", attachment_id: "att1" }
              : { note_id: id, rel_path: null, attachment_id: null },
          ),
        });
      }
      return Promise.resolve({});
    });
    const coverCalls = () => callMock.mock.calls.filter((c) => c[0] === "note_cover_images");

    const { getAllByTestId, queryByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    // Not observed yet — no cover fetch for either card, no thumbnail rendered.
    expect(coverCalls()).toHaveLength(0);
    expect(queryByTestId("board-card-thumb")).toBeNull();

    const card = getAllByTestId("board-card").find(
      (c) => c.getAttribute("data-note-id") === "n-ip",
    )!;
    let observer: MockIntersectionObserver | undefined;
    await waitFor(() => {
      observer = MockIntersectionObserver.instances.find((o) =>
        o.elements.includes(card),
      );
      expect(observer).toBeDefined();
    });

    await act(async () => {
      observer!.trigger(card);
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_cover_images", { note_ids: ["n-ip"] });
    });
    await waitFor(() => {
      const img = within(card).getByTestId("board-card-thumb") as HTMLImageElement;
      expect(img.src).toContain("n-ip/cover.jpg");
    });

    // The untouched card (n-none) was never observed intersecting — never fetched.
    expect(coverCalls().some((c) => (c[1].note_ids as string[]).includes("n-none"))).toBe(false);

    const callsSoFar = coverCalls().length;

    // Re-triggering (e.g. a remount that re-observes) hits the module cache, not the network.
    await act(async () => {
      observer!.trigger(card);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(coverCalls().length).toBe(callsSoFar);
  });

  it("cards that come into view together share ONE note_cover_images call", async () => {
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_board") return Promise.resolve(boardFixture());
      if (cmd === "note_cover_images") {
        const ids = (args?.note_ids as string[]) ?? [];
        return Promise.resolve({
          items: ids.map((id) => ({ note_id: id, rel_path: `${id}/c.jpg`, attachment_id: "a" })),
        });
      }
      return Promise.resolve({});
    });

    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));
    const cards = getAllByTestId("board-card");
    await waitFor(() => {
      for (const c of cards) {
        expect(MockIntersectionObserver.instances.some((o) => o.elements.includes(c))).toBe(true);
      }
    });

    await act(async () => {
      for (const c of cards) {
        MockIntersectionObserver.instances.find((o) => o.elements.includes(c))!.trigger(c);
      }
    });

    await waitFor(() => expect(getAllByTestId("board-card-thumb")).toHaveLength(2));
    const coverCalls = callMock.mock.calls.filter((c) => c[0] === "note_cover_images");
    expect(coverCalls).toHaveLength(1);
    expect([...(coverCalls[0][1].note_ids as string[])].sort()).toEqual(
      cards.map((c) => c.getAttribute("data-note-id")).sort(),
    );
    expect(callMock).not.toHaveBeenCalledWith("note_cover_image", expect.anything());
  });

  it("dashboard search dims non-matching cards in place and shows a per-column match-count badge", async () => {
    const { getAllByTestId, queryAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    // No query yet — nothing dimmed, no badge.
    expect(queryAllByTestId("board-column-match-count").length).toBe(0);
    for (const card of getAllByTestId("board-card")) {
      expect(card.getAttribute("data-search-dim")).toBeNull();
    }

    act(() => {
      useSearchStore.setState({
        query: "urgent",
        searchResults: [
          { id: "n-ip", folder_id: "f1", title: "Urgent walk", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        ],
      });
    });

    await waitFor(() => {
      const card = getAllByTestId("board-card").find((c) => c.getAttribute("data-note-id") === "n-none")!;
      expect(card.getAttribute("data-search-dim")).toBe("true");
    });
    const matchCard = getAllByTestId("board-card").find((c) => c.getAttribute("data-note-id") === "n-ip")!;
    expect(matchCard.getAttribute("data-search-dim")).toBeNull();

    // Column badge counts over the column's full note set (1 of 1 in in_progress).
    const ipCol = getAllByTestId("board-column").find((c) => c.getAttribute("data-status") === "in_progress")!;
    expect(within(ipCol).getByTestId("board-column-match-count").textContent).toContain("1");
    // The unmatched column (__none__) shows a zero-match badge, not no badge — a query is active.
    const noneCol = getAllByTestId("board-column").find((c) => c.getAttribute("data-status") === "__none__")!;
    expect(within(noneCol).getByTestId("board-column-match-count").textContent).toContain("0");
  });

  it("handles dashboardReveal signal by focusing the card and scrolling into view", async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    useUiStore.setState({ homeInnerTab: "board", dashboardReveal: null });
    const { getAllByTestId } = render(<BoardPane />);
    await waitFor(() => expect(getAllByTestId("board-card").length).toBe(2));

    act(() => {
      useUiStore.getState().triggerDashboardReveal("n-ip");
    });

    await waitFor(() => {
      const matchCard = getAllByTestId("board-card").find((c) => c.getAttribute("data-note-id") === "n-ip")!;
      expect(matchCard.getAttribute("data-focused")).toBe("true");
    });
  });

  describe("horizontal scroll overflow edge fade (Wave KANBAN)", () => {
    function setDimensions(
      el: HTMLElement,
      { clientWidth, scrollWidth, scrollLeft }: { clientWidth: number; scrollWidth: number; scrollLeft: number },
    ) {
      Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true, writable: true });
      Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true, writable: true });
      Object.defineProperty(el, "scrollLeft", { value: scrollLeft, configurable: true, writable: true });
    }

    it("does not set fade data attributes when columns fit without overflowing", async () => {
      const { getByTestId } = render(<BoardPane />);
      const columns = await waitFor(() => getByTestId("board-columns"));

      setDimensions(columns, { clientWidth: 1000, scrollWidth: 1000, scrollLeft: 0 });
      fireEvent.scroll(columns);

      await waitFor(() => {
        expect(columns.hasAttribute("data-fade-left")).toBe(false);
        expect(columns.hasAttribute("data-fade-right")).toBe(false);
      });
    });

    it("sets only data-fade-right when overflowing and scrolled at the start", async () => {
      const { getByTestId } = render(<BoardPane />);
      const columns = await waitFor(() => getByTestId("board-columns"));

      setDimensions(columns, { clientWidth: 600, scrollWidth: 1200, scrollLeft: 0 });
      fireEvent.scroll(columns);

      await waitFor(() => {
        expect(columns.hasAttribute("data-fade-left")).toBe(false);
        expect(columns.getAttribute("data-fade-right")).toBe("true");
      });
    });

    it("sets both data-fade-left and data-fade-right when scrolled to the middle", async () => {
      const { getByTestId } = render(<BoardPane />);
      const columns = await waitFor(() => getByTestId("board-columns"));

      setDimensions(columns, { clientWidth: 600, scrollWidth: 1200, scrollLeft: 300 });
      fireEvent.scroll(columns);

      await waitFor(() => {
        expect(columns.getAttribute("data-fade-left")).toBe("true");
        expect(columns.getAttribute("data-fade-right")).toBe("true");
      });
    });

    it("sets only data-fade-left when scrolled to the end", async () => {
      const { getByTestId } = render(<BoardPane />);
      const columns = await waitFor(() => getByTestId("board-columns"));

      setDimensions(columns, { clientWidth: 600, scrollWidth: 1200, scrollLeft: 600 });
      fireEvent.scroll(columns);

      await waitFor(() => {
        expect(columns.getAttribute("data-fade-left")).toBe("true");
        expect(columns.hasAttribute("data-fade-right")).toBe(false);
      });
    });

    it("updates fade attributes when ResizeObserver triggers container size change", async () => {
      let roCallback: ResizeObserverCallback | null = null;
      class TestResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", TestResizeObserver);

      const { getByTestId } = render(<BoardPane />);
      const columns = await waitFor(() => getByTestId("board-columns"));

      // Initially fits
      setDimensions(columns, { clientWidth: 1000, scrollWidth: 1000, scrollLeft: 0 });
      expect(columns.hasAttribute("data-fade-left")).toBe(false);
      expect(columns.hasAttribute("data-fade-right")).toBe(false);

      // Container narrows -> now overflows
      setDimensions(columns, { clientWidth: 600, scrollWidth: 1000, scrollLeft: 0 });
      act(() => {
        roCallback?.([], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(columns.getAttribute("data-fade-right")).toBe("true");
      });

      vi.unstubAllGlobals();
    });
  });
});


