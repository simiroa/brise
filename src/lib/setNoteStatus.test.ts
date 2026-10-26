import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();

vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

import { setNoteStatus } from "./noteActions";
import { useNotesStore } from "../stores/notes";
import type { NoteSummary } from "./commands.gen";

function makeNote(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    year: 2024,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: partial.status ?? null,
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

describe("setNoteStatus", () => {
  beforeEach(() => {
    callMock.mockReset();
    const note = makeNote({ id: "n1", status: "in_progress" });
    useNotesStore.setState({
      noteIndex: new Map([["n1", note]]),
      notesByFolder: { f1: [note] },
      activeNote: null,
    });
  });

  it("rejected note_set_status rolls the note's summary status back to its previous value", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_set_status") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({});
    });

    await setNoteStatus("n1", "done");

    expect(callMock).toHaveBeenCalledWith(
      "note_set_status",
      expect.objectContaining({ id: "n1", status: "done" }),
    );
    expect(useNotesStore.getState().noteIndex.get("n1")?.status).toBe("in_progress");
  });
});
