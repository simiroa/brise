import { describe, it, expect, vi, afterEach } from "vitest";
import { createMatchesTagRegion } from "./filtering";
import type { NoteSummary } from "../../../lib/commands.gen";

describe("createMatchesTagRegion", () => {
  const dummyNote = (
    tags: string[],
    updatedAt = "2024-01-01T00:00:00Z",
    regionNames: string[] = []
  ): NoteSummary => ({
    id: "n1",
    title: "Test Note",
    year: 1900,
    folder_id: "f1",
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: tags,
    region: null,
    region_names: regionNames,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: updatedAt,
    month: null,
    day: null,
  });

  it("a note with only 'alpha' passes in 'or' mode and FAILS in 'and' mode when both 'alpha' and 'beta' are selected", () => {
    const noteAlphaOnly = dummyNote(["alpha"]);
    const filterOr = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
    });
    const filterAnd = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "and",
      regionFilter: null,
      statusFilter: [],
    });

    expect(filterOr(noteAlphaOnly)).toBe(true);
    expect(filterAnd(noteAlphaOnly)).toBe(false);
  });

  it("a note with both passes in either mode", () => {
    const noteBoth = dummyNote(["alpha", "beta"]);
    const filterOr = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
    });
    const filterAnd = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "and",
      regionFilter: null,
      statusFilter: [],
    });

    expect(filterOr(noteBoth)).toBe(true);
    expect(filterAnd(noteBoth)).toBe(true);
  });

  it("omitting the mode behaves as 'or'", () => {
    const noteAlphaOnly = dummyNote(["alpha"]);
    const filterDefault = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      regionFilter: null,
      statusFilter: [],
    });

    expect(filterDefault(noteAlphaOnly)).toBe(true);
  });

  // N2-2: chip region filter must treat waypoints equal to the primary region (owner decision:
  // no "waypoint" label, plain union match) — mirrors note_query's server-side
  // RegionFilterSpec::Eq (n.region OR EXISTS note_regions).
  describe("region axis (primary ∪ waypoints)", () => {
    it("matches a note whose waypoint (not primary) equals the filter name", () => {
      const noteWaypointOnly = dummyNote([], undefined, ["경주"]);
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: { kind: "region", name: "경주" },
        statusFilter: [],
      });
      expect(filter(noteWaypointOnly)).toBe(true);
    });

    it("still matches on the primary region when waypoints are empty", () => {
      const noteWithPrimary: NoteSummary = { ...dummyNote([]), region: "서울" };
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: { kind: "region", name: "서울" },
        statusFilter: [],
      });
      expect(filter(noteWithPrimary)).toBe(true);
    });

    it("'none' filter excludes a note that only has a waypoint", () => {
      const noteWaypointOnly = dummyNote([], undefined, ["경주"]);
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: { kind: "none" },
        statusFilter: [],
      });
      expect(filter(noteWaypointOnly)).toBe(false);
    });

    it("does not match an unrelated waypoint name", () => {
      const noteWaypointOnly = dummyNote([], undefined, ["경주"]);
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: { kind: "region", name: "부산" },
        statusFilter: [],
      });
      expect(filter(noteWaypointOnly)).toBe(false);
    });
  });

  // §2.8: date-range chip must also narrow search_notes results — otherwise the filter is
  // silently ignored the instant a keyword query is also active (see filtering.ts doc comment).
  describe("dateRange axis (record axis, updated_at)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("null/omitted dateRange does not filter", () => {
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: null,
        statusFilter: [],
        dateRange: null,
      });
      expect(filter(dummyNote([], "2020-01-01T00:00:00Z"))).toBe(true);
    });

    it("excludes a note updated outside the resolved window", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: null,
        statusFilter: [],
        dateRange: "last7",
      });
      // 2026-07-10 is well before the last-7-days window (2026-07-22..2026-07-28).
      expect(filter(dummyNote([], "2026-07-10T00:00:00.000Z"))).toBe(false);
    });

    it("includes a note updated inside the resolved window, inclusive at both ends", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      const filter = createMatchesTagRegion({
        selectedTags: [],
        regionFilter: null,
        statusFilter: [],
        dateRange: "last7",
      });
      expect(filter(dummyNote([], "2026-07-22T00:00:00.000Z"))).toBe(true); // window start
      expect(filter(dummyNote([], "2026-07-28T23:59:59.000Z"))).toBe(true); // window end (today)
    });

    it("ANDs with the tag axis", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      const filter = createMatchesTagRegion({
        selectedTags: ["alpha"],
        regionFilter: null,
        statusFilter: [],
        dateRange: "last7",
      });
      // In range but wrong tag.
      expect(filter(dummyNote(["beta"], "2026-07-25T00:00:00.000Z"))).toBe(false);
      // Right tag but out of range.
      expect(filter(dummyNote(["alpha"], "2026-01-01T00:00:00.000Z"))).toBe(false);
      // Both.
      expect(filter(dummyNote(["alpha"], "2026-07-25T00:00:00.000Z"))).toBe(true);
    });
  });
});
