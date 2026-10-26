import { describe, it, expect, vi, beforeEach } from "vitest";

const openDateEntryMock = vi.fn();
vi.mock("../../lib/dateEntryBridge", () => ({
  openDateEntry: (...args: unknown[]) => openDateEntryMock(...args),
}));

const openRegionEntryMock = vi.fn();
vi.mock("../../lib/regionEntryBridge", () => ({
  openRegionEntry: (...args: unknown[]) => openRegionEntryMock(...args),
}));

let activeNoteId: string | null = "note-1";
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ activeNote: activeNoteId ? { note: { id: activeNoteId } } : null }),
  },
}));

import { buildSlashItems, filterSlashItems, type SlashItem } from "./slashCommand";

const items: SlashItem[] = [
  { key: "h1", label: "Heading 1", icon: () => null, run: () => {} },
  { key: "h2", label: "Heading 2", icon: () => null, run: () => {} },
  { key: "blockquote", label: "Blockquote", icon: () => null, run: () => {} },
  { key: "table", label: "Insert table", icon: () => null, run: () => {} },
];

describe("filterSlashItems", () => {
  it("offers bullet and ordered list commands", () => {
    expect(buildSlashItems().map((item) => item.key)).toEqual(
      expect.arrayContaining(["bulletList", "orderedList"]),
    );
  });

  it("returns every item for an empty query", () => {
    expect(filterSlashItems(items, "")).toHaveLength(4);
  });

  it("matches on label, case-insensitive substring", () => {
    expect(filterSlashItems(items, "head").map((i) => i.key)).toEqual(["h1", "h2"]);
    expect(filterSlashItems(items, "TABLE").map((i) => i.key)).toEqual(["table"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterSlashItems(items, "zzz")).toEqual([]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterSlashItems(items, "  quote  ").map((i) => i.key)).toEqual(["blockquote"]);
  });

  it("also matches on the locale-invariant key, not just the (possibly localized) label", () => {
    // e.g. under ko, "Heading 1"'s label is "제목 1" — the ASCII key "h1" must still work so the
    // command isn't only reachable by typing Korean.
    expect(filterSlashItems(items, "h1").map((i) => i.key)).toEqual(["h1"]);
  });

  // PLAN-2026-09-18-nl-dates.md §W2 (D5/D6) — "/날짜" opens DateEntryPopover via the bridge instead
  // of running an editor command directly (every other item above does the latter).
  describe("the 'date' item", () => {
    beforeEach(() => {
      openDateEntryMock.mockReset();
      activeNoteId = "note-1";
    });

    it("is offered by buildSlashItems", () => {
      expect(buildSlashItems().map((i) => i.key)).toEqual(expect.arrayContaining(["date"]));
    });

    function fakeEditor(coords: { left: number; bottom: number } = { left: 12, bottom: 34 }) {
      return {
        view: { coordsAtPos: vi.fn(() => coords) },
        chain: vi.fn(),
      } as unknown as Parameters<SlashItem["run"]>[0];
    }

    it("opens the date-entry bridge with the trigger range, anchored under it, replaceRangeOnSave:true, no prefill", () => {
      const dateItem = buildSlashItems().find((i) => i.key === "date")!;
      dateItem.run(fakeEditor({ left: 12, bottom: 34 }), { from: 5, to: 9 });

      expect(openDateEntryMock).toHaveBeenCalledWith({
        noteId: "note-1",
        anchorX: 12,
        anchorY: 40,
        range: { from: 5, to: 9 },
        replaceRangeOnSave: true,
      });
    });

    it("never deletes the '/날짜' trigger text itself — replacement happens on save, not on select", () => {
      const editor = fakeEditor();
      const dateItem = buildSlashItems().find((i) => i.key === "date")!;
      dateItem.run(editor, { from: 5, to: 9 });
      // Every other item calls editor.chain()...deleteRange(range)...run() synchronously; this one
      // must not touch the document at all until the popover reports a successful add.
      expect(editor.chain).not.toHaveBeenCalled();
    });

    it("no active note — does not open the bridge", () => {
      activeNoteId = null;
      const dateItem = buildSlashItems().find((i) => i.key === "date")!;
      dateItem.run(fakeEditor(), { from: 0, to: 1 });
      expect(openDateEntryMock).not.toHaveBeenCalled();
    });
  });

  // PLAN-2026-09-18-nl-dates.md §W6 — "/지역" mirrors §W2's "date" item exactly: opens a popover
  // via a bridge instead of running an editor command immediately, and never touches the document
  // itself (RegionEntryPopover's own replaceTriggerText does that, only on a successful pick).
  describe("the 'region' item", () => {
    beforeEach(() => {
      openRegionEntryMock.mockReset();
      activeNoteId = "note-1";
    });

    function fakeEditor(coords: { left: number; bottom: number } = { left: 12, bottom: 34 }) {
      return {
        view: { coordsAtPos: vi.fn(() => coords) },
        chain: vi.fn(),
      } as unknown as Parameters<SlashItem["run"]>[0];
    }

    it("is offered by buildSlashItems", () => {
      expect(buildSlashItems().map((i) => i.key)).toEqual(expect.arrayContaining(["region"]));
    });

    it("opens the region-entry bridge with the trigger range, anchored under it, no query", () => {
      const regionItem = buildSlashItems().find((i) => i.key === "region")!;
      regionItem.run(fakeEditor({ left: 12, bottom: 34 }), { from: 5, to: 9 });

      expect(openRegionEntryMock).toHaveBeenCalledWith({
        noteId: "note-1",
        anchorX: 12,
        anchorY: 40,
        range: { from: 5, to: 9 },
      });
    });

    it("never touches the document itself — no deleteRange/insert on select", () => {
      const editor = fakeEditor();
      const regionItem = buildSlashItems().find((i) => i.key === "region")!;
      regionItem.run(editor, { from: 5, to: 9 });
      expect(editor.chain).not.toHaveBeenCalled();
    });

    it("no active note — does not open the bridge", () => {
      activeNoteId = null;
      const regionItem = buildSlashItems().find((i) => i.key === "region")!;
      regionItem.run(fakeEditor(), { from: 0, to: 1 });
      expect(openRegionEntryMock).not.toHaveBeenCalled();
    });
  });
});
