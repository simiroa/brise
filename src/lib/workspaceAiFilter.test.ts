import { describe, it, expect } from "vitest";
import { filterWorkspaceCandidates } from "./workspaceAiFilter";
import type { NoteSummary } from "./commands.gen";

function note(partial: Partial<NoteSummary> & Pick<NoteSummary, "id" | "title">): NoteSummary {
  return {
    folder_id: "f",
    year: 2000,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    region_names: [],
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "",
    updated_at: "",
    month: null,
    day: null,
    ...partial,
  };
}

describe("filterWorkspaceCandidates", () => {
  it("returns empty for empty input", () => {
    expect(filterWorkspaceCandidates([])).toEqual({
      candidates: [],
      totalEvaluated: 0,
      truncatedCount: 0,
    });
  });

  it("detects duplicate titles", () => {
    const result = filterWorkspaceCandidates([
      note({ id: "1", title: "Paris 1940" }),
      note({ id: "2", title: "paris 1940" }),
      note({ id: "3", title: "Unrelated" }),
    ]);
    expect(result.totalEvaluated).toBe(3);
    const ids = result.candidates.map((c) => c.noteId).sort();
    expect(ids).toEqual(["1", "2"]);
    expect(result.candidates[0].reason).toMatch(/Duplicate title/i);
  });

  it("detects tag overlaps (not solo tags)", () => {
    const result = filterWorkspaceCandidates([
      note({ id: "a", title: "One", tag_names: ["war", "france"] }),
      note({ id: "b", title: "Two", tag_names: ["war"] }),
      note({ id: "c", title: "Three", tag_names: ["unique-only"] }),
    ]);
    const ids = new Set(result.candidates.map((c) => c.noteId));
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("c")).toBe(false);
    expect(result.candidates.find((c) => c.noteId === "a")!.reason).toMatch(/Tag overlap/i);
  });

  it("detects same-day collisions when 3+ notes share year/month/day", () => {
    const result = filterWorkspaceCandidates([
      note({ id: "1", title: "A", year: 1944, month: 6, day: 6 }),
      note({ id: "2", title: "B", year: 1944, month: 6, day: 6 }),
      note({ id: "3", title: "C", year: 1944, month: 6, day: 6 }),
      note({ id: "4", title: "D", year: 1945, month: 1, day: 1 }),
    ]);
    const ids = result.candidates.map((c) => c.noteId).sort();
    expect(ids).toEqual(["1", "2", "3"]);
    expect(result.candidates[0].reason).toMatch(/Same date collision/i);
  });

  it("does not use content_hash (field absent on NoteSummary) — scores only available signals", () => {
    // Two notes with no shared title/tag/date → no candidates even if we imagined a hash.
    const result = filterWorkspaceCandidates([
      note({ id: "1", title: "Alpha", tag_names: ["x"] }),
      note({ id: "2", title: "Beta", tag_names: ["y"] }),
    ]);
    expect(result.candidates).toEqual([]);
  });

  it("caps candidates at 30 and reports truncatedCount", () => {
    const notes: NoteSummary[] = [];
    // 40 notes with the same title → 40 candidates before cap
    for (let i = 0; i < 40; i++) {
      notes.push(note({ id: `n${i}`, title: "Dup Title" }));
    }
    const result = filterWorkspaceCandidates(notes);
    expect(result.candidates).toHaveLength(30);
    expect(result.truncatedCount).toBe(10);
  });
});
