import { describe, it, expect } from "vitest";
import type { NoteSummary } from "../../../lib/commands.gen";
import {
  flattenTimelineRows,
  timelineRowHeightOf,
  timelineRowOffset,
  timelineRowIndexAtOffset,
  findTimelineAnchorRowIndex,
  collectTimelineHitRowIndices,
  bucketSearchHitTicks,
  hitTickBucketYearRange,
  SEARCH_HIT_TICK_BUCKETS,
  TIMELINE_HEADER_HEIGHT,
  TIMELINE_HEADER_LEADING_GAP,
  TIMELINE_NOTE_HEIGHT,
  TIMELINE_EMPTY_HEIGHT,
  type TimelineRow,
} from "./timelineRows";

function note(partial: Partial<NoteSummary> & { id: string; year: number }): NoteSummary {
  return {
    folder_id: "f1",
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
    title: partial.title ?? partial.id,
    ...partial,
  };
}

describe("flattenTimelineRows", () => {
  it("alternates header then notes per year; first header has no leading gap", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, title: "A" }),
        note({ id: "b", year: 1592, title: "B" }),
        note({ id: "c", year: 1610, title: "C" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
    });

    expect(rows.map((r) => r.type)).toEqual(["header", "note", "note", "header", "note"]);

    const h0 = rows[0]!;
    const h1 = rows[3]!;
    expect(h0.type).toBe("header");
    expect(h1.type).toBe("header");
    if (h0.type === "header" && h1.type === "header") {
      expect(h0.year).toBe(1592);
      expect(h0.count).toBe(2);
      expect(h0.leadingGap).toBe(false);
      expect(h1.year).toBe(1610);
      expect(h1.count).toBe(1);
      expect(h1.leadingGap).toBe(true);
    }
  });

  it("suppresses the leading gap of a header that directly follows a collapsed header", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, title: "A" }),
        note({ id: "b", year: 1610, title: "B" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
      collapsedKeys: new Set(["y:1592"]),
    });

    expect(rows.map((r) => r.type)).toEqual(["header", "header", "note"]);
    const h0 = rows[0]!;
    const h1 = rows[1]!;
    if (h0.type === "header" && h1.type === "header") {
      expect(h0.collapsed).toBe(true);
      expect(h1.leadingGap).toBe(false);
    }
    // And the collapsed header itself keeps its own leading gap when preceded by content.
    if (h1.type === "header") expect(h1.year).toBe(1610);
  });

  it("returns empty row when nothing matches the year window", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1000 })],
      yearFrom: 1800,
      yearTo: 1900,
    });
    expect(rows).toEqual([{ type: "empty" }]);
  });

  it("month zoom: month-unknown bucket sorts first, then months ascending, nested under the year header", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, month: 7, title: "July" }),
        note({ id: "b", year: 1592, month: null, title: "No month" }),
        note({ id: "c", year: 1592, month: 3, title: "March" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "month",
    });

    const headers = rows.filter((r) => r.type === "header") as Extract<TimelineRow, { type: "header" }>[];
    // year header, then month-unknown, then month 3, then month 7 — in that order.
    expect(headers.map((h) => [h.depth, h.month])).toEqual([
      [0, null],
      [1, null],
      [1, 3],
      [1, 7],
    ]);
    expect(headers[1]!.count).toBe(1);
    // Note order follows the ids in each bucket.
    const noteIds = rows.filter((r) => r.type === "note").map((r) => (r as { note: NoteSummary }).note.id);
    expect(noteIds).toEqual(["b", "c", "a"]);
  });

  it("month zoom: notes inside a month come out in day order, not the server's created_at order (2026-10-18)", () => {
    // 실제 화면 재현: 2026.07 아래 29·30·29·29·30·28·31·20일 순(서버 YearAsc = year → created_at).
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "d29-1400", year: 2026, month: 7, day: 29, start_time: "14:00" }),
        note({ id: "d30-a", year: 2026, month: 7, day: 30 }),
        note({ id: "d29-none", year: 2026, month: 7, day: 29, start_time: null }),
        note({ id: "d29-0930", year: 2026, month: 7, day: 29, start_time: "09:30" }),
        note({ id: "d30-b", year: 2026, month: 7, day: 30 }),
        note({ id: "d28", year: 2026, month: 7, day: 28 }),
        note({ id: "d31", year: 2026, month: 7, day: 31 }),
        note({ id: "d20", year: 2026, month: 7, day: 20 }),
        note({ id: "dnull", year: 2026, month: 7, day: null }),
      ],
      yearFrom: 2000,
      yearTo: 2100,
      zoomLevel: "month",
    });

    const headers = rows.filter((r) => r.type === "header") as Extract<TimelineRow, { type: "header" }>[];
    expect(headers.map((h) => [h.depth, h.month])).toEqual([
      [0, null],
      [1, 7],
    ]);
    const noteIds = rows.filter((r) => r.type === "note").map((r) => (r as { note: NoteSummary }).note.id);
    expect(noteIds).toEqual([
      "dnull", // day unknown first — same unknown-first rule as the month/day buckets
      "d20",
      "d28",
      "d29-none", // same day: no start time first, then by start time
      "d29-0930",
      "d29-1400",
      "d30-a", // identical keys: input (server created_at → id) order is the final tie-break
      "d30-b",
      "d31",
    ]);
  });

  it("year zoom: notes inside a year are ordered by month then day; month-unknown first", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "sep17", year: 2026, month: 9, day: 17 }),
        note({ id: "may3", year: 2026, month: 5, day: 3 }),
        note({ id: "nomonth", year: 2026 }),
        note({ id: "may-noday", year: 2026, month: 5 }),
      ],
      yearFrom: 2000,
      yearTo: 2100,
      zoomLevel: "year",
    });
    const noteIds = rows.filter((r) => r.type === "note").map((r) => (r as { note: NoteSummary }).note.id);
    expect(noteIds).toEqual(["nomonth", "may-noday", "may3", "sep17"]);
  });

  it("does not reorder the caller's array (sorts a copy)", () => {
    const input = [
      note({ id: "b", year: 2026, month: 7, day: 30 }),
      note({ id: "a", year: 2026, month: 7, day: 1 }),
    ];
    flattenTimelineRows({ sortedNotes: input, yearFrom: 2000, yearTo: 2100, zoomLevel: "month" });
    expect(input.map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("day zoom: day-unknown sorts first within a known month; month-unknown bucket is not split by day", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, month: 7, day: 20, title: "Jul 20" }),
        note({ id: "b", year: 1592, month: 7, day: null, title: "Jul ??" }),
        note({ id: "c", year: 1592, month: null, day: null, title: "No date" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "day",
    });

    const headers = rows.filter((r) => r.type === "header") as Extract<TimelineRow, { type: "header" }>[];
    expect(headers.map((h) => [h.depth, h.month, h.day])).toEqual([
      [0, null, null], // year
      [1, null, null], // month unknown — no day sub-header follows
      [1, 7, null], // month 7
      [2, 7, null], // day unknown within month 7
      [2, 7, 20], // day 20 within month 7
    ]);
  });

  it("day zoom: note rows carry the depth of their deepest ACTUAL header (2 under a day header, 1 under a month-unknown header that has no day split)", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, month: 7, day: 20, title: "Jul 20" }),
        note({ id: "b", year: 1592, month: null, day: null, title: "No date" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "day",
    });

    const noteRows = rows.filter((r) => r.type === "note") as Extract<
      TimelineRow,
      { type: "note" }
    >[];
    const depthById = Object.fromEntries(noteRows.map((r) => [r.note.id, r.depth]));
    // "a" sits under year -> month(7) -> day(20): depth 2.
    expect(depthById["a"]).toBe(2);
    // "b" sits under year -> month(unknown), never split by day: depth 1, not 2.
    expect(depthById["b"]).toBe(1);
  });

  it("year zoom: note rows stay at depth 0 (unchanged from before depth threading)", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1592, title: "A" })],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "year",
    });
    const noteRow = rows.find((r) => r.type === "note") as Extract<TimelineRow, { type: "note" }>;
    expect(noteRow.depth).toBe(0);
  });
});

describe("cursor-anchored zoom helpers", () => {
  it("timelineRowOffset/timelineRowIndexAtOffset round-trip through a mixed header+note list", () => {
    const rows = flattenTimelineRows({
      sortedNotes: [
        note({ id: "a", year: 1592, title: "A" }),
        note({ id: "b", year: 1592, title: "B" }),
        note({ id: "c", year: 1610, title: "C" }),
      ],
      yearFrom: 1500,
      yearTo: 1700,
    });
    // rows: [header 1592, note a, note b, header 1610 (leadingGap), note c]
    const offsetOfNoteB = timelineRowOffset(rows, 2);
    const { index, offsetInRow } = timelineRowIndexAtOffset(rows, offsetOfNoteB + 3);
    expect(index).toBe(2);
    expect(offsetInRow).toBe(3);
  });

  it("findTimelineAnchorRowIndex anchors a note by id regardless of zoom-level regrouping", () => {
    const oldRows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1592, month: 7, title: "A" })],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "year",
    });
    const newRows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1592, month: 7, title: "A" })],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "month",
    });
    const oldIndex = oldRows.findIndex((r) => r.type === "note");
    const newIndex = findTimelineAnchorRowIndex(oldRows, oldIndex, newRows);
    expect(newRows[newIndex]).toMatchObject({ type: "note", note: { id: "a" } });
  });

  it("findTimelineAnchorRowIndex falls back from a day header to its surviving year header when zooming out", () => {
    const oldRows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1592, month: 7, day: 20, title: "A" })],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "day",
    });
    const newRows = flattenTimelineRows({
      sortedNotes: [note({ id: "a", year: 1592, month: 7, day: 20, title: "A" })],
      yearFrom: 1500,
      yearTo: 1700,
      zoomLevel: "year",
    });
    const oldDayHeaderIndex = oldRows.findIndex((r) => r.type === "header" && r.depth === 2);
    const newIndex = findTimelineAnchorRowIndex(oldRows, oldDayHeaderIndex, newRows);
    expect(newRows[newIndex]).toMatchObject({ type: "header", depth: 0, year: 1592 });
  });
});

describe("timelineRowHeightOf", () => {
  it("returns base header height for the first header and taller with leading gap later", () => {
    const first: TimelineRow = {
      type: "header",
      depth: 0,
      year: 1592,
      month: null,
      day: null,
      count: 1,
      leadingGap: false,
    };
    const later: TimelineRow = {
      type: "header",
      depth: 0,
      year: 1610,
      month: null,
      day: null,
      count: 1,
      leadingGap: true,
    };
    expect(timelineRowHeightOf(first)).toBe(TIMELINE_HEADER_HEIGHT);
    expect(timelineRowHeightOf(later)).toBe(
      TIMELINE_HEADER_HEIGHT + TIMELINE_HEADER_LEADING_GAP,
    );
    expect(
      timelineRowHeightOf({ type: "note", note: note({ id: "n", year: 1 }), depth: 0 }),
    ).toBe(TIMELINE_NOTE_HEIGHT);
    expect(timelineRowHeightOf({ type: "empty" })).toBe(TIMELINE_EMPTY_HEIGHT);
  });
});

describe("search hit ticks", () => {
  function rowsWithHits(): TimelineRow[] {
    return flattenTimelineRows({
      sortedNotes: [
        note({ id: "0", year: 1000, title: "alpha" }),
        note({ id: "1", year: 1000, title: "beta hit" }),
        note({ id: "2", year: 1100, title: "gamma" }),
        note({ id: "3", year: 1100, title: "HIT me" }),
        note({ id: "4", year: 1200, title: "omega" }),
      ],
      yearFrom: 1000,
      yearTo: 1200,
    });
  }

  it("maps server-FTS hit ids on the same flattened rows to expected buckets", () => {
    const rows = rowsWithHits();
    // Server FTS ids (not title substring) — body-only matches can appear even when title
    // doesn't contain the query string.
    const hits = collectTimelineHitRowIndices(rows, new Set(["1", "3"]));
    // flattened: h0, n0, n1, h1, n2, n3, h2, n4 → hit note rows at indices 2 and 5
    expect(hits).toEqual([2, 5]);

    const ticks = bucketSearchHitTicks(hits, rows.length, SEARCH_HIT_TICK_BUCKETS);
    expect(ticks.length).toBe(2);
    expect(ticks[0]!.rowIndex).toBe(2);
    expect(ticks[0]!.unique).toBe(true);
    expect(ticks[1]!.rowIndex).toBe(5);
    expect(ticks[1]!.unique).toBe(true);

    const denom = Math.max(1, rows.length - 1);
    expect(ticks[0]!.bucket).toBe(
      Math.min(
        SEARCH_HIT_TICK_BUCKETS - 1,
        Math.floor((2 / denom) * SEARCH_HIT_TICK_BUCKETS),
      ),
    );
    expect(ticks[1]!.bucket).toBe(
      Math.min(
        SEARCH_HIT_TICK_BUCKETS - 1,
        Math.floor((5 / denom) * SEARCH_HIT_TICK_BUCKETS),
      ),
    );
  });

  it("ignores title substring matches that are not in the FTS id set", () => {
    const rows = rowsWithHits();
    // "1" title is "beta hit" but not in FTS results → no tick for it.
    expect(collectTimelineHitRowIndices(rows, new Set(["3"]))).toEqual([5]);
    expect(collectTimelineHitRowIndices(rows, new Set())).toEqual([]);
  });

  it("marks a bucket non-unique when multiple hits land in it", () => {
    // Force two indices into the same bucket with a tiny bucket count.
    const ticks = bucketSearchHitTicks([0, 1], 10, 2);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    // With only 2 buckets and adjacent early indices, both land in bucket 0.
    const b0 = ticks.find((t) => t.bucket === 0);
    expect(b0).toBeDefined();
    expect(b0!.unique).toBe(false);
    expect(b0!.rowIndex).toBe(0);
  });

  it("bounds tick count when hits vastly outnumber buckets (anti-vacuity)", () => {
    const rowCount = 10_000;
    const hitIndices = Array.from({ length: rowCount }, (_, i) => i);

    const bounded = bucketSearchHitTicks(hitIndices, rowCount, SEARCH_HIT_TICK_BUCKETS);
    expect(bounded.length).toBeLessThanOrEqual(SEARCH_HIT_TICK_BUCKETS);
    expect(bounded.length).toBe(SEARCH_HIT_TICK_BUCKETS);

    // Without a bucket ceiling, one tick per hit would explode the DOM.
    // Simulate the unbounded map: length === hit count must NOT pass this gate.
    const unbounded = hitIndices.map((rowIndex, i) => ({ bucket: i, rowIndex }));
    expect(unbounded.length).toBeGreaterThan(SEARCH_HIT_TICK_BUCKETS);
    expect(bounded.length).toBeLessThan(unbounded.length);
  });

  it("returns no ticks for empty hit set", () => {
    const rows = rowsWithHits();
    expect(collectTimelineHitRowIndices(rows, new Set())).toEqual([]);
    expect(bucketSearchHitTicks([], rows.length)).toEqual([]);
  });
});

describe("hitTickBucketYearRange", () => {
  it("splits the full span into equal bucket ranges", () => {
    expect(hitTickBucketYearRange(0, 1000, 2000, 4)).toEqual({ from: 1000, to: 1250 });
    expect(hitTickBucketYearRange(3, 1000, 2000, 4)).toEqual({ from: 1750, to: 2000 });
  });
});

describe("timelineNoteDateBadge (shared desktop/mobile event-date badge)", () => {
  it("under a month header (depth 1) shows only the day; nothing when the day is unknown", async () => {
    const { timelineNoteDateBadge } = await import("./timelineRows");
    expect(timelineNoteDateBadge({ month: 9, day: 17 }, 1, "ko")).toBe("17일");
    expect(timelineNoteDateBadge({ month: 9, day: 17 }, 1, "en")).toBe("17");
    expect(timelineNoteDateBadge({ month: 9, day: null }, 1, "ko")).toBeNull();
  });
  it("under a year header (depth 0) shows month+day, or month alone; never invents a month", async () => {
    const { timelineNoteDateBadge } = await import("./timelineRows");
    expect(timelineNoteDateBadge({ month: 9, day: 17 }, 0, "ko")).toBe("9월 17일");
    expect(timelineNoteDateBadge({ month: 9, day: 17 }, 0, "en")).toBe("Sep 17");
    expect(timelineNoteDateBadge({ month: 9, day: null }, 0, "ko")).toBe("9월");
    expect(timelineNoteDateBadge({ month: null, day: null }, 0, "ko")).toBeNull();
    expect(timelineNoteDateBadge({ month: 2, day: 29 }, 0, "en")).toBe("Feb 29");
  });
  it("depth 2 (day header already says it) shows nothing", async () => {
    const { timelineNoteDateBadge } = await import("./timelineRows");
    expect(timelineNoteDateBadge({ month: 9, day: 17 }, 2, "ko")).toBeNull();
  });
});
