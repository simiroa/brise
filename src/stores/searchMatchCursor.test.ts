import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

import { useSearchStore } from "./search";
import type { SearchMatch } from "../lib/searchMatch";

const selectNoteMock = vi.fn(async (_id?: string) => {});

vi.mock("./notes", () => ({
  useNotesStore: Object.assign(
    (sel: (s: { selectNote: typeof selectNoteMock }) => unknown) =>
      sel({ selectNote: selectNoteMock }),
    {
      getState: () => ({ selectNote: selectNoteMock }),
    },
  ),
}));

function fiveMatches(): SearchMatch[] {
  return [0, 1, 2, 3, 4].map((i) => ({ rowIndex: i, noteId: `n${i}` }));
}

describe("search match cursor (find-next)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callMock.mockReset();
    callMock.mockResolvedValue({ results: [], total: 0 });
    selectNoteMock.mockClear();
    useSearchStore.setState({
      query: "silla",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
      searchResults: [],
      matchCursor: null,
      matchIds: [],
      matchRowIndices: [],
    });
    useSearchStore.getState().syncSearchMatches(fiveMatches());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ArrowDown three times moves cursor to index 2 and never opens a note", () => {
    const store = useSearchStore.getState();
    store.stepMatchCursor(1);
    store.stepMatchCursor(1);
    store.stepMatchCursor(1);

    expect(useSearchStore.getState().matchCursor).toBe(2);
    expect(useSearchStore.getState().currentMatchId()).toBe("n2");
    // Central invariant: stepping must not call selectNote.
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("Enter-open path: currentMatchId is the cursor note; caller opens once", async () => {
    const store = useSearchStore.getState();
    store.stepMatchCursor(1);
    store.stepMatchCursor(1); // index 1 → n1

    const id = useSearchStore.getState().currentMatchId();
    expect(id).toBe("n1");
    // Opening is the deliberate caller path (SearchBox Enter) — not stepMatchCursor.
    await selectNoteMock(id as string);
    expect(selectNoteMock).toHaveBeenCalledTimes(1);
    expect(selectNoteMock).toHaveBeenCalledWith("n1");
  });

  it("changing the query resets the cursor to none", () => {
    useSearchStore.getState().stepMatchCursor(1);
    expect(useSearchStore.getState().matchCursor).toBe(0);

    useSearchStore.getState().setQuery("new query");
    expect(useSearchStore.getState().matchCursor).toBe(null);
  });

  it("shrinking results from 10 to 3 while cursor is at 7 clamps into range", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      rowIndex: i,
      noteId: `n${i}`,
    }));
    useSearchStore.getState().syncSearchMatches(ten);
    useSearchStore.setState({ matchCursor: 7 });
    expect(useSearchStore.getState().matchCursor).toBe(7);

    const three = ten.slice(0, 3);
    useSearchStore.getState().syncSearchMatches(three);
    expect(useSearchStore.getState().matchCursor).toBe(2);
    expect(useSearchStore.getState().matchIds).toHaveLength(3);
  });

  it("outside search mode (empty query, tag filter only) ArrowDown is inert and match list empty", () => {
    useSearchStore.setState({
      query: "",
      yearFrom: 900,
      yearTo: 1960,
      yearBounds: { min: 900, max: 1960 },
      selectedTags: ["war"],
      matchCursor: null,
      matchIds: ["stale"],
      matchRowIndices: [0],
    });
    // NoteTree would push [] when !searchActive — simulate that.
    useSearchStore.getState().syncSearchMatches([]);
    useSearchStore.getState().stepMatchCursor(1);

    expect(useSearchStore.getState().matchCursor).toBe(null);
    expect(useSearchStore.getState().matchIds).toEqual([]);
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("scroll target row index skips semantic_hdr (match index → flattened row index)", () => {
    // keyword n0,n1 then header then semantic s0 → row indices 0,1,3
    useSearchStore.getState().syncSearchMatches([
      { rowIndex: 0, noteId: "n0" },
      { rowIndex: 1, noteId: "n1" },
      { rowIndex: 3, noteId: "s0" },
    ]);
    useSearchStore.getState().stepMatchCursor(1);
    useSearchStore.getState().stepMatchCursor(1);
    useSearchStore.getState().stepMatchCursor(1); // match index 2 → row 3
    const s = useSearchStore.getState();
    expect(s.matchCursor).toBe(2);
    expect(s.matchRowIndices[s.matchCursor!]).toBe(3);
  });
});
