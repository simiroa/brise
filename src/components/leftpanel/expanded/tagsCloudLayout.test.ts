import { describe, it, expect } from "vitest";
import { packTagsIntoRows } from "./tagsCloudLayout";

const noCounts = new Map<string, number>();

describe("tagsCloudLayout", () => {
  it("returns no rows for no tags", () => {
    expect(packTagsIntoRows([], noCounts, 200)).toEqual([]);
  });

  it("preserves input order and loses nothing", () => {
    const tags = ["zebra", "alpha", "middle", "b", "c", "d", "e"];
    for (const w of [0, 1, 60, 300, 2000]) {
      expect(packTagsIntoRows(tags, noCounts, w).flat()).toEqual(tags);
    }
  });

  // The point of the change: rows fill the width instead of holding three fixed columns.
  it("packs more chips per row as the container widens", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const narrow = packTagsIntoRows(tags, noCounts, 100);
    const wide = packTagsIntoRows(tags, noCounts, 600);
    expect(wide.length).toBeLessThan(narrow.length);
    expect(Math.max(...wide.map((r) => r.length))).toBeGreaterThan(3);
  });

  it("packs fewer long tags than short tags at the same width", () => {
    const short = ["a", "b", "c", "d", "e", "f"];
    const long = short.map((s) => s.repeat(20));
    const shortRows = packTagsIntoRows(short, noCounts, 400);
    const longRows = packTagsIntoRows(long, noCounts, 400);
    expect(shortRows.length).toBeLessThan(longRows.length);
  });

  // A chip wider than the container must still occupy a row on its own — otherwise the
  // greedy loop emits empty rows (or never advances) and the virtual list mounts blanks.
  it("gives an oversized chip its own row rather than an empty one", () => {
    const tags = ["a".repeat(200), "b", "c"];
    const rows = packTagsIntoRows(tags, noCounts, 40);
    expect(rows.every((r) => r.length >= 1)).toBe(true);
    expect(rows[0]).toEqual([tags[0]]);
    expect(rows.flat()).toEqual(tags);
  });

  // Counts are rendered inside the chip, so they widen it.
  it("accounts for the count badge width", () => {
    const tags = ["a", "b", "c", "d", "e", "f"];
    const big = new Map(tags.map((t) => [t, 999999]));
    expect(packTagsIntoRows(tags, big, 300).length).toBeGreaterThan(
      packTagsIntoRows(tags, noCounts, 300).length,
    );
  });
});
