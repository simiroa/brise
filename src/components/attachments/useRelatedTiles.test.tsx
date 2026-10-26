import { describe, it, expect, vi, beforeEach } from "vitest";
import { useRelatedTiles } from "./useRelatedTiles";
import { useNotesStore } from "../../stores/notes";
import { useSuggestionsStore } from "../../stores/suggestions";
import { callSilent } from "../../lib/invoke";
import type { Attachment, NoteDetail, NoteSummary, Suggestion } from "../../lib/commands.gen";
import { assertHookSettles } from "../../test/renderLoop";

vi.mock("../../lib/invoke", () => {
  const handler = async (cmd: string) => {
    if (cmd === "note_related") return { notes: [] };
    if (cmd === "note_summaries_map") return { notes: {} };
    return {};
  };
  return {
    call: vi.fn(handler),
    callSilent: vi.fn(handler),
    flushAll: vi.fn(),
    registerFlush: () => () => {},
    emitNotice: vi.fn(),
  };
});

function makeSummary(id: string, title = id): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title,
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

function makeDetail(id: string, attachments: Attachment[] = []): NoteDetail {
  return {
    note: makeSummary(id, "Note"),
    sections: [],
    attachments,
    sources: [],
  };
}

const EMPTY_PENDING = new Set<string>();

describe("useRelatedTiles", () => {
  beforeEach(() => {
    useNotesStore.setState({
      activeNote: null,
      noteIndex: new Map(),
      notesByFolder: {},
      totalNotes: 0,
    });
  });

  it("settles with no active note (no effect→setState loop)", async () => {
    let relatedTiles: ReturnType<typeof useRelatedTiles>["relatedTiles"] = [];
    const { renders } = await assertHookSettles(() => {
      const r = useRelatedTiles(null, EMPTY_PENDING);
      relatedTiles = r.relatedTiles;
    });

    // One commit + at most a harmless extra from Strict-style double effects in some envs.
    // A loop hits maxRenders (40). Keep a tight ceiling so the gate cannot miss a recurrence.
    expect(renders).toBeLessThanOrEqual(3);
    expect(relatedTiles).toEqual([]);
  });

  it("settles with an active note that has internal links", async () => {
    const target = makeSummary("t1", "Target");
    useNotesStore.setState({
      noteIndex: new Map([["t1", target]]),
      notesByFolder: { f1: [target] },
      totalNotes: 1,
      ensureNoteSummaries: async (ids: string[]) => {
        const m = new Map<string, NoteSummary>();
        for (const id of ids) {
          if (id === "t1") m.set(id, target);
        }
        return m;
      },
    } as Partial<ReturnType<typeof useNotesStore.getState>> as never);

    const internal: Attachment = {
      id: "a1",
      name: "Target",
      kind: "internal",
      rel_path: null,
      url: "t1",
      size_bytes: null,
      position: 0,
    };
    const detail = makeDetail("n1", [internal]);

    let relatedTiles: ReturnType<typeof useRelatedTiles>["relatedTiles"] = [];
    const { renders } = await assertHookSettles(() => {
      const r = useRelatedTiles(detail, EMPTY_PENDING);
      relatedTiles = r.relatedTiles;
    });

    expect(renders).toBeLessThanOrEqual(5);
    expect(relatedTiles.some((t) => t.kind === "manual" && t.attachment.url === "t1")).toBe(
      true,
    );
  });

  it("pairs pending overlap suggestions with matching auto-related notes", async () => {
    const autoNote = makeSummary("auto-1", "Auto Note");
    const suggestion: Suggestion = {
      id: "sugg-1",
      kind: "overlap",
      note_id: "active-1",
      note_title: "Active Note",
      related_note_id: "auto-1",
      related_note_title: "Auto Note",
      payload: "",
      score: 0.95,
      created_at: "2026-08-24T00:00:00Z",
    };

    useSuggestionsStore.setState({ suggestions: [suggestion] });

    (callSilent as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "note_related") return { notes: [autoNote] };
      if (cmd === "suggestions_list") return { suggestions: [suggestion] };
      return {};
    });

    const detail = makeDetail("active-1", []);

    let relatedTiles: ReturnType<typeof useRelatedTiles>["relatedTiles"] = [];
    await assertHookSettles(() => {
      const r = useRelatedTiles(detail, EMPTY_PENDING);
      relatedTiles = r.relatedTiles;
    });

    const autoTile = relatedTiles.find((t) => t.kind === "auto" && t.note.id === "auto-1");
    expect(autoTile).toBeTruthy();
    if (autoTile && autoTile.kind === "auto") {
      expect(autoTile.suggestion).toEqual(suggestion);
    }
  });
});
