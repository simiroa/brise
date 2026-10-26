import { describe, it, expect } from "vitest";
import {
  notesBoundingBox,
  fitNotesLocation,
  haversineKm,
  nearestAround,
  nearestTo,
  formatKm,
} from "./mapFit";
import type { NoteSummary } from "../../lib/commands.gen";

function note(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f",
    title: partial.title ?? partial.id,
    year: partial.year ?? 2020,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    month: null,
    day: null,
    ...partial,
  };
}

describe("notesBoundingBox / fitNotesLocation", () => {
  it("returns null for empty input", () => {
    expect(notesBoundingBox([])).toBeNull();
    expect(fitNotesLocation([], 800, 450)).toBeNull();
  });

  it("fits a single point at singleZoom", () => {
    const loc = fitNotesLocation([{ lat: 37.5, lng: 127.0 }], 800, 450, { singleZoom: 42 });
    expect(loc).toEqual({ lat: 37.5, lng: 127.0, zoom: 42 });
  });

  it("centers multi-point bbox and clamps zoom into range", () => {
    // Seoul + Busan-ish — span should force a moderate zoom, not max/min extremes
    const loc = fitNotesLocation(
      [
        { lat: 37.57, lng: 126.98 },
        { lat: 35.18, lng: 129.08 },
      ],
      800,
      450,
      { minZoom: 2, maxZoom: 200 }
    );
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBeCloseTo((37.57 + 35.18) / 2, 5);
    expect(loc!.lng).toBeCloseTo((126.98 + 129.08) / 2, 5);
    expect(loc!.zoom).toBeGreaterThanOrEqual(2);
    expect(loc!.zoom).toBeLessThanOrEqual(200);
    // Wider span than a single city → not the single-point zoom of 50
    expect(loc!.zoom).toBeLessThan(50);
  });

  it("notesBoundingBox ignores non-finite coords", () => {
    const box = notesBoundingBox([
      { lat: 1, lng: 2 },
      { lat: NaN, lng: 3 },
      { lat: 5, lng: 6 },
    ]);
    expect(box).toEqual({ min_lat: 1, max_lat: 5, min_lng: 2, max_lng: 6 });
  });
});

describe("haversineKm / nearestAround", () => {
  it("haversine is ~0 for same point", () => {
    expect(haversineKm(37.5, 127, 37.5, 127)).toBeLessThan(0.001);
  });

  it("Seoul–Busan is roughly 300–350 km", () => {
    const km = haversineKm(37.57, 126.98, 35.18, 129.08);
    expect(km).toBeGreaterThan(250);
    expect(km).toBeLessThan(400);
  });

  it("nearestAround puts selected first then nearest neighbors", () => {
    const selected = note({ id: "a", lat: 37.5, lng: 127.0, title: "Seoul" });
    const near = note({ id: "b", lat: 37.6, lng: 127.1, title: "Near" });
    const far = note({ id: "c", lat: 35.0, lng: 129.0, title: "Far" });
    const ranked = nearestAround(selected, [selected, far, near], 2);
    expect(ranked.map((r) => r.note.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].km).toBe(0);
    expect(ranked[1].km).toBeLessThan(ranked[2].km);
  });

  it("nearestAround respects neighborCount", () => {
    const selected = note({ id: "a", lat: 0, lng: 0 });
    const others = [
      note({ id: "b", lat: 0.1, lng: 0 }),
      note({ id: "c", lat: 0.2, lng: 0 }),
      note({ id: "d", lat: 0.3, lng: 0 }),
    ];
    const ranked = nearestAround(selected, [selected, ...others], 1);
    expect(ranked).toHaveLength(2);
    expect(ranked[1].note.id).toBe("b");
  });
});

describe("nearestTo", () => {
  // The dashboard map's default-region list (nothing selected) ranks from a point, not a note.
  it("ranks located candidates nearest-first from a point, capped, skipping unlocated", () => {
    const origin = { lat: 0, lng: 0 };
    const ranked = nearestTo(
      origin,
      [
        note({ id: "far", lat: 0.3, lng: 0 }),
        note({ id: "none" }),
        note({ id: "near", lat: 0.1, lng: 0 }),
        note({ id: "mid", lat: 0.2, lng: 0 }),
      ],
      2
    );
    expect(ranked.map((r) => r.note.id)).toEqual(["near", "mid"]);
    expect(ranked[0].km).toBeGreaterThan(0);
  });

  it("excludeId drops that note; a non-finite origin ranks nothing", () => {
    const cands = [note({ id: "a", lat: 0, lng: 0 }), note({ id: "b", lat: 1, lng: 1 })];
    expect(nearestTo({ lat: 0, lng: 0 }, cands, 5, "a").map((r) => r.note.id)).toEqual(["b"]);
    expect(nearestTo({ lat: Number.NaN, lng: 0 }, cands, 5)).toEqual([]);
  });
});

describe("formatKm", () => {
  it("formats tiers", () => {
    expect(formatKm(0.01)).toBe("");
    expect(formatKm(2.14)).toBe("2.1km");
    expect(formatKm(18.4)).toBe("18km");
    expect(formatKm(250)).toBe("250km");
  });
});
