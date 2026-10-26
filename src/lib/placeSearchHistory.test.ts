import { describe, it, expect, beforeEach } from "vitest";
import {
  readPlaceSearchHistory,
  recordPlaceSearchPick,
  clearPlaceSearchHistory,
  derivePlaceSearchSections,
} from "./placeSearchHistory";

const KEY = "brise.placeSearchHistory.v1";

describe("placeSearchHistory", () => {
  beforeEach(() => localStorage.clear());

  it("records a pick and reads it back", () => {
    recordPlaceSearchPick({ label: "Seoul, KR", lat: 37.57, lng: 126.98 });
    const list = readPlaceSearchHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Seoul, KR", lat: 37.57, lng: 126.98, count: 1 });
  });

  it("bumps count instead of duplicating on repeat pick of same spot", () => {
    recordPlaceSearchPick({ label: "Seoul, KR", lat: 37.57, lng: 126.98 });
    recordPlaceSearchPick({ label: "Seoul, KR", lat: 37.57, lng: 126.98 });
    const list = readPlaceSearchHistory();
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(2);
  });

  it("discards corrupt JSON silently", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readPlaceSearchHistory()).toEqual([]);
  });

  it("caps stored entries at 30, dropping the oldest", () => {
    for (let i = 0; i < 35; i++) {
      recordPlaceSearchPick({ label: `Place ${i}`, lat: i, lng: i });
    }
    expect(readPlaceSearchHistory()).toHaveLength(30);
  });

  it("clears history", () => {
    recordPlaceSearchPick({ label: "Seoul, KR", lat: 37.57, lng: 126.98 });
    clearPlaceSearchHistory();
    expect(readPlaceSearchHistory()).toEqual([]);
  });

  it("derives frequent (top 5 by count) excluding overlap from recent (by lastUsedAt)", () => {
    // 7 entries so the top-5-by-count "frequent" list doesn't swallow everything.
    const list = [
      { label: "A", lat: 1, lng: 1, count: 9, lastUsedAt: 100 },
      { label: "B", lat: 2, lng: 2, count: 8, lastUsedAt: 90 },
      { label: "C", lat: 3, lng: 3, count: 7, lastUsedAt: 80 },
      { label: "D", lat: 4, lng: 4, count: 6, lastUsedAt: 70 },
      { label: "E", lat: 5, lng: 5, count: 5, lastUsedAt: 60 },
      { label: "F", lat: 6, lng: 6, count: 1, lastUsedAt: 300 },
      { label: "G", lat: 7, lng: 7, count: 1, lastUsedAt: 200 },
    ];
    const { frequent, recent } = derivePlaceSearchSections(list);
    expect(frequent.map((e) => e.label)).toEqual(["A", "B", "C", "D", "E"]);
    // F/G excluded from frequent, so they surface in recent, ordered by lastUsedAt desc.
    expect(recent.map((e) => e.label)).toEqual(["F", "G"]);
  });
});
