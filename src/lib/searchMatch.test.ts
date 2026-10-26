import { describe, it, expect } from "vitest";
import type { NoteSummary } from "./commands.gen";
import { flattenRows } from "../components/leftpanel/notetree/rows";
import {
  collectSearchMatches,
  stepMatchCursor,
  clampMatchCursor,
} from "./searchMatch";

function note(id: string): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title: `Note ${id}`,
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

describe("collectSearchMatches", () => {
  it("walks keyword results in order, never landing on a non-note row", () => {
    const rows = flattenRows({
      searchActive: true,
      filteredSearchResults: [note("k1"), note("k2"), note("k3")],
      favoritesOpen: false,
      favoriteNotes: [],
      sectionTrashCount: 0,
    trashCount: 0,
      archiveCount: 0,
      folders: [],
      filteredByFolder: {},
      tagRegionFilterActive: false,
      visibleTreeCount: 0,
      inboxId: null,
      inboxOpen: true,
      inboxNotes: [],
      draftFolderId: null,
    });

    expect(rows.map((r) => r.kind)).toEqual(["note", "note", "note"]);

    const matches = collectSearchMatches(rows);
    expect(matches.map((m) => m.noteId)).toEqual(["k1", "k2", "k3"]);
    expect(matches.map((m) => m.rowIndex)).toEqual([0, 1, 2]);
    expect(matches.every((m) => rows[m.rowIndex]?.kind === "note")).toBe(true);
  });
});

describe("stepMatchCursor", () => {
  it("ArrowDown three times from none lands on index 2 (0-based)", () => {
    let c: number | null = null;
    c = stepMatchCursor(c, 1, 5);
    c = stepMatchCursor(c, 1, 5);
    c = stepMatchCursor(c, 1, 5);
    expect(c).toBe(2);
  });

  it("clamps at ends without wrapping", () => {
    expect(stepMatchCursor(0, -1, 5)).toBe(0);
    expect(stepMatchCursor(4, 1, 5)).toBe(4);
  });

  it("is inert when there are no matches", () => {
    expect(stepMatchCursor(null, 1, 0)).toBe(null);
    expect(stepMatchCursor(2, 1, 0)).toBe(null);
  });
});

describe("clampMatchCursor", () => {
  it("clamps a dangling index when results shrink (10→3, cursor 7 → 2)", () => {
    expect(clampMatchCursor(7, 3)).toBe(2);
  });

  it("resets to none when the list is empty", () => {
    expect(clampMatchCursor(2, 0)).toBe(null);
  });

  it("leaves a valid cursor alone", () => {
    expect(clampMatchCursor(1, 5)).toBe(1);
  });
});
