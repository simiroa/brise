import { describe, it, expect } from "vitest";
import type { NoteSummary } from "../../../lib/commands.gen";
import {
  noteHasCoords,
  noteInBbox,
  splitLocated,
  groupByCoordinate,
  sortNearby,
} from "./viewData";

function note(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    year: partial.year ?? 1500,
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
    ...partial,
  };
}

describe("viewData — coords", () => {
  it("noteHasCoords requires both finite lat and lng", () => {
    expect(noteHasCoords(note({ id: "a", lat: 1, lng: 2 }))).toBe(true);
    expect(noteHasCoords(note({ id: "b", lat: 1, lng: null }))).toBe(false);
    expect(noteHasCoords(note({ id: "c" }))).toBe(false);
    expect(noteHasCoords(note({ id: "d", lat: NaN, lng: 1 }))).toBe(false);
  });

  it("noteInBbox excludes notes outside box and without coords", () => {
    const inside = note({ id: "in", lat: 37.5, lng: 127.0 });
    const outside = note({ id: "out", lat: 48.8, lng: 2.3 });
    const bare = note({ id: "bare" });
    expect(noteInBbox(inside, 33, 39, 124, 132)).toBe(true);
    expect(noteInBbox(outside, 33, 39, 124, 132)).toBe(false);
    expect(noteInBbox(bare, 33, 39, 124, 132)).toBe(false);
  });

  it("empty viewport matches nothing", () => {
    const n = note({ id: "x", lat: 37.5, lng: 127.0 });
    expect(noteInBbox(n, 0, 1, 0, 1)).toBe(false);
  });

  it("notes sharing one coordinate group together", () => {
    const a = note({ id: "a", lat: 1, lng: 2, title: "A" });
    const b = note({ id: "b", lat: 1, lng: 2, title: "B" });
    const c = note({ id: "c", lat: 3, lng: 4, title: "C" });
    const g = groupByCoordinate([a, b, c]);
    expect(g.get("1,2")?.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(g.get("3,4")?.map((n) => n.id)).toEqual(["c"]);
  });

  it("sortNearby orders by distance from focus", () => {
    const near = note({ id: "near", lat: 37.57, lng: 126.98 });
    const far = note({ id: "far", lat: 35.18, lng: 129.08 });
    const ordered = sortNearby([far, near], 37.5665, 126.978);
    expect(ordered.map((n) => n.id)).toEqual(["near", "far"]);
  });
});

describe("viewData — splitLocated", () => {
  it("separates located and unlocated", () => {
    const a = note({ id: "a", lat: 1, lng: 2 });
    const b = note({ id: "b" });
    const { located, unlocated } = splitLocated([a, b]);
    expect(located.map((n) => n.id)).toEqual(["a"]);
    expect(unlocated.map((n) => n.id)).toEqual(["b"]);
  });
});
