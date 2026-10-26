import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Suggestion } from "../../../lib/commands.gen";
import { pickRenderableSuggestion } from "./petSuggestionCards";

// A(AUDIT-2026-09-26): an unknown suggestion kind is now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("../../../lib/diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

beforeEach(() => {
  reportFallbackMock.mockClear();
});

function suggestion(overrides: Partial<Suggestion> & { kind: string; id: string }): Suggestion {
  return {
    note_id: "n1",
    note_title: "노트",
    related_note_id: "n1",
    related_note_title: "노트",
    payload: "{}",
    score: 1,
    created_at: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("pickRenderableSuggestion", () => {
  it("maps the new-note sentinel title to \"\" so both windows' formatters show their untitled label", () => {
    const s = suggestion({ kind: "overlap", id: "s0", note_id: "n1", note_title: "Untitled Note", related_note_id: "n2", related_note_title: "Untitled Note" });
    expect(pickRenderableSuggestion([s])).toMatchObject({ kind: "overlap", noteTitle: "", relatedNoteTitle: "" });
  });

  it("returns null for an empty list", () => {
    expect(pickRenderableSuggestion([])).toBeNull();
  });

  it("renders an overlap suggestion with no extra validity condition", () => {
    const s = suggestion({
      kind: "overlap",
      id: "s1",
      note_id: "n1",
      note_title: "여행 메모",
      related_note_id: "n2",
      related_note_title: "여행 계획",
    });
    expect(pickRenderableSuggestion([s])).toEqual({
      kind: "overlap",
      id: "s1",
      noteId: "n1",
      noteTitle: "여행 메모",
      relatedNoteId: "n2",
      relatedNoteTitle: "여행 계획",
    });
  });

  it("parses a valid collect_post_process suggestion into a 'collect' card", () => {
    const s = suggestion({
      kind: "collect_post_process",
      id: "s2",
      note_id: "n3",
      related_note_id: "n3", // self-reference (docs/SUGGESTIONS.md §3)
      note_title: "회의록",
      payload: JSON.stringify({ source_id: "src1", source_name: "업무 메일함", post_process_model: "gpt-x" }),
    });
    expect(pickRenderableSuggestion([s])).toEqual({
      kind: "collect",
      id: "s2",
      noteId: "n3",
      noteTitle: "회의록",
      sourceName: "업무 메일함",
      postProcessModel: "gpt-x",
    });
  });

  it("defaults postProcessModel to null when the payload omits it", () => {
    const s = suggestion({
      kind: "collect_post_process",
      id: "s3",
      payload: JSON.stringify({ source_id: "src1", source_name: "RSS" }),
    });
    const parsed = pickRenderableSuggestion([s]);
    expect(parsed?.kind).toBe("collect");
    expect(parsed && "postProcessModel" in parsed ? parsed.postProcessModel : undefined).toBeNull();
  });

  it("skips an unrenderable suggestion (missing/garbled kind-specific fields) and picks the next one — the fix for the self-merge fallback bug", () => {
    const broken = suggestion({ kind: "collect_post_process", id: "s-broken", payload: "not json" });
    const link = suggestion({
      kind: "link",
      id: "s-link",
      payload: JSON.stringify({ url: "https://example.com", summary: "요약", title: "제목" }),
    });
    const result = pickRenderableSuggestion([broken, link]);
    expect(result?.id).toBe("s-link");
    expect(result?.kind).toBe("link");
  });

  it("skips a future/unknown kind entirely instead of falling back to overlap", () => {
    // AUDIT-2026-09-26 A: the skip is also reported to diag (asserted below) — title kept verbatim for specs/features/collect.yaml covered_by.
    const unknown = suggestion({ kind: "some_future_kind", id: "s-unknown", note_id: "n9", related_note_id: "n9" });
    const overlap = suggestion({ kind: "overlap", id: "s-overlap" });
    const result = pickRenderableSuggestion([unknown, overlap]);
    expect(result?.id).toBe("s-overlap");
    expect(reportFallbackMock).toHaveBeenCalledWith("pet", "suggestion_unknown_kind", "kind=some_future_kind");
  });

  it("skips a link with an invalid payload (missing url/summary)", () => {
    const badLink = suggestion({ kind: "link", id: "s-bad-link", payload: JSON.stringify({ title: "no url or summary" }) });
    const overlap = suggestion({ kind: "overlap", id: "s-overlap" });
    expect(pickRenderableSuggestion([badLink, overlap])?.id).toBe("s-overlap");
  });

  it("skips a theme with fewer than two members", () => {
    const thinTheme = suggestion({ kind: "theme", id: "s-thin-theme", payload: JSON.stringify({ note_ids: ["n1"] }) });
    const overlap = suggestion({ kind: "overlap", id: "s-overlap" });
    expect(pickRenderableSuggestion([thinTheme, overlap])?.id).toBe("s-overlap");
  });

  it("skips a collect_post_process suggestion whose payload lacks source_name", () => {
    const noSource = suggestion({ kind: "collect_post_process", id: "s-no-source", payload: JSON.stringify({ source_id: "x" }) });
    const overlap = suggestion({ kind: "overlap", id: "s-overlap" });
    expect(pickRenderableSuggestion([noSource, overlap])?.id).toBe("s-overlap");
  });
});
