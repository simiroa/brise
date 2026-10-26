import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

let activeNote: { note: { tag_names: string[] } } | null = { note: { tag_names: [] } };
const setTagsMock = vi.fn();
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote,
      setTags: (...args: unknown[]) => setTagsMock(...args),
    }),
  },
}));

vi.mock("../../i18n/t", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import { filterHashTagCandidates, insertHashTagSelection, type HashTagItem } from "./hashTag";
import type { Editor, Range } from "@tiptap/core";

beforeEach(() => {
  callMock.mockReset();
  setTagsMock.mockReset();
  activeNote = { note: { tag_names: [] } };
});

describe("filterHashTagCandidates", () => {
  const counts = { travel: 5, work: 5, apple: 2, banana: 1 };

  it("sorts by frequency desc, ties broken alphabetically", () => {
    expect(filterHashTagCandidates(counts, "").map((i) => i.name)).toEqual([
      "travel",
      "work",
      "apple",
      "banana",
    ]);
  });

  it("filters by a case-insensitive substring query", () => {
    // "AP" matches "apple" as a substring, but isn't an exact (case-sensitive) match for any
    // stored tag, so a trailing "create new: 'AP'" row is also offered (see the exact-match test
    // below for the case where it isn't).
    expect(filterHashTagCandidates(counts, "AP").map((i) => i.name)).toEqual(["apple", "AP"]);
    expect(filterHashTagCandidates(counts, "AP").map((i) => i.isNew)).toEqual([false, true]);
  });

  it("does not append a 'create new' entry when the query exactly matches an existing tag", () => {
    const items = filterHashTagCandidates(counts, "travel");
    expect(items).toEqual([{ name: "travel", isNew: false }]);
  });

  it("appends a 'create new' entry as the last item when nothing matches exactly", () => {
    const items = filterHashTagCandidates(counts, "trav");
    expect(items[items.length - 1]).toEqual({ name: "trav", isNew: true });
    expect(items.every((it, i) => (i === items.length - 1 ? it.isNew : !it.isNew))).toBe(true);
  });

  it("exact match is case-sensitive — 'Travel' does not match stored 'travel'", () => {
    const items = filterHashTagCandidates(counts, "Travel");
    expect(items.some((i) => i.isNew)).toBe(true);
  });

  it("offers no 'create new' entry for an empty (whitespace-only) query", () => {
    expect(filterHashTagCandidates(counts, "   ").some((i) => i.isNew)).toBe(false);
  });

  it("offers no 'create new' entry when there are no tags yet and the query is empty", () => {
    expect(filterHashTagCandidates({}, "")).toEqual([]);
  });

  it("still offers 'create new' with an empty tag_counts map, given a query", () => {
    expect(filterHashTagCandidates({}, "brandnew")).toEqual([{ name: "brandnew", isNew: true }]);
  });

  it("respects the limit parameter (not counting the trailing 'create new' row)", () => {
    const many = { a: 3, b: 2, c: 1 };
    expect(filterHashTagCandidates(many, "", 2).map((i) => i.name)).toEqual(["a", "b"]);
  });
});

function fakeEditor() {
  const chainObj = {
    focus: vi.fn(() => chainObj),
    deleteRange: vi.fn(() => chainObj),
    insertContent: vi.fn(() => chainObj),
    run: vi.fn(() => undefined),
  };
  const editor = { chain: vi.fn(() => chainObj) } as unknown as Editor;
  return { editor, chainObj };
}

const RANGE: Range = { from: 3, to: 9 };

describe("insertHashTagSelection", () => {
  it("replaces the trigger range with '#name ' (trailing space, so the popup doesn't reopen)", () => {
    const { editor, chainObj } = fakeEditor();
    insertHashTagSelection(editor, RANGE, { name: "travel", isNew: false });

    expect(chainObj.deleteRange).toHaveBeenCalledWith(RANGE);
    expect(chainObj.insertContent).toHaveBeenCalledWith("#travel ");
    expect(chainObj.run).toHaveBeenCalledTimes(1);
  });

  it("appends the tag via setTags when the active note doesn't have it yet (read-then-append, full-replace contract)", () => {
    activeNote = { note: { tag_names: ["existing"] } };
    const { editor } = fakeEditor();
    insertHashTagSelection(editor, RANGE, { name: "travel", isNew: true });

    expect(setTagsMock).toHaveBeenCalledWith(["existing", "travel"]);
  });

  it("does not call setTags when the active note already has the tag", () => {
    activeNote = { note: { tag_names: ["travel", "other"] } };
    const { editor } = fakeEditor();
    insertHashTagSelection(editor, RANGE, { name: "travel", isNew: false });

    expect(setTagsMock).not.toHaveBeenCalled();
  });

  it("still replaces the trigger text but skips tag registration when there is no active note", () => {
    activeNote = null;
    const { editor, chainObj } = fakeEditor();
    insertHashTagSelection(editor, RANGE, { name: "travel", isNew: true });

    expect(chainObj.insertContent).toHaveBeenCalledWith("#travel ");
    expect(setTagsMock).not.toHaveBeenCalled();
  });

  it("no-ops (no editor commands, no setTags) for a blank/whitespace-only name", () => {
    const { editor, chainObj } = fakeEditor();
    const blank: HashTagItem = { name: "   ", isNew: true };
    insertHashTagSelection(editor, RANGE, blank);

    expect(chainObj.deleteRange).not.toHaveBeenCalled();
    expect(setTagsMock).not.toHaveBeenCalled();
  });
});

describe("fetchHashTagCandidates (via the extension's items(), exercised indirectly)", () => {
  // fetchHashTagCandidates itself isn't exported (mirrors wikiLink.tsx's fetchWikiLinkCandidates,
  // which is also module-private) — covered instead through HashTag.options.suggestion.items,
  // which wraps it in the same try/catch fallback wikiLink.tsx uses.
  it("HashTag extension exposes a '#' suggestion with items()/command() wired", async () => {
    const { HashTag } = await import("./hashTag");
    const { suggestion } = HashTag.options;
    expect(suggestion.char).toBe("#");
    expect(typeof suggestion.items).toBe("function");
    expect(typeof suggestion.command).toBe("function");

    callMock.mockResolvedValueOnce({ counts: { travel: 2 } });
    const items = await suggestion.items({ query: "travel" });
    expect(items).toEqual([{ name: "travel", isNew: false }]);
  });

  it("falls back to a 'create new' row when tag_counts rejects", async () => {
    const { HashTag } = await import("./hashTag");
    const { suggestion } = HashTag.options;

    callMock.mockRejectedValueOnce(new Error("boom"));
    const items = await suggestion.items({ query: "offline" });
    expect(items).toEqual([{ name: "offline", isNew: true }]);
  });
});
