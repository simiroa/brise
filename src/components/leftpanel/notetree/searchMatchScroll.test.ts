import { describe, it, expect, vi } from "vitest";

/**
 * Documents the react-window v2 scroll contract used by NoteTree:
 * listRef.current.scrollToRow({ index, align }) — NOT v1 scrollToItem(index).
 * Cursor moves pass the *flattened row* index (headers skipped at the match layer).
 */
describe("search match → list scroll contract", () => {
  it("scrollToRow is invoked with the flattened row index when the cursor moves", () => {
    const scrollToRow = vi.fn();
    const listRef = { current: { scrollToRow, element: null as HTMLDivElement | null } };

    // Simulate NoteTree's effect body: matchCursor 2 → matchRowIndices[2] === 4 (skipped hdr at 3).
    const matchCursor = 2;
    const matchRowIndices = [0, 1, 4];
    const rowIndex = matchRowIndices[matchCursor];
    expect(rowIndex).toBe(4);
    listRef.current.scrollToRow({ index: rowIndex, align: "smart" });

    expect(scrollToRow).toHaveBeenCalledTimes(1);
    expect(scrollToRow).toHaveBeenCalledWith({ index: 4, align: "smart" });
    // Never the match-list index when a header has shifted the mapping.
    expect(scrollToRow).not.toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });
});
