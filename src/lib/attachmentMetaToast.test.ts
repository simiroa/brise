import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./invoke", () => ({
  call: (...a: unknown[]) => call(...a),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
}));
const showToastOnly = vi.fn();
vi.mock("./undo", () => ({ showToastOnly: (...a: unknown[]) => showToastOnly(...a) }));
const reloadActive = vi.fn();
const bumpAttachmentRevision = vi.fn();
let activeNoteId: string | null = "n1";
vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: activeNoteId ? { note: { id: activeNoteId } } : null,
      reloadActive,
      bumpAttachmentRevision,
    }),
  },
}));
vi.mock("./noteQuery", () => ({ bumpNoteQueryVersion: vi.fn() }));

import { onAttachmentMetaApplied, undoAttachmentMeta } from "./attachmentMetaToast";

beforeEach(() => {
  vi.clearAllMocks();
  activeNoteId = "n1";
  call.mockResolvedValue({ ok: true });
  reloadActive.mockResolvedValue(undefined);
});

describe("onAttachmentMetaApplied", () => {
  it("shows one undo toast with the server summary and refreshes the open note", async () => {
    onAttachmentMetaApplied({ note_id: "n1", date_row_id: "d1", summary: "2026-10-03 · Seoul" });
    expect(showToastOnly).toHaveBeenCalledTimes(1);
    const [label, , opts] = showToastOnly.mock.calls[0];
    expect(label).toContain("2026-10-03 · Seoul");
    expect(opts.actionLabel).toBe("Undo");
    await vi.waitFor(() => expect(reloadActive).toHaveBeenCalled());
    expect(bumpAttachmentRevision).toHaveBeenCalled();
  });

  it("does not reload a note that is not open", async () => {
    activeNoteId = "other";
    onAttachmentMetaApplied({ note_id: "n1", date_row_id: "d1", summary: "x" });
    await Promise.resolve();
    expect(reloadActive).not.toHaveBeenCalled();
  });

  it("ignores payloads without a summary (nothing was actually applied)", () => {
    onAttachmentMetaApplied({ note_id: "n1", summary: "" });
    expect(showToastOnly).not.toHaveBeenCalled();
  });

  it("the toast's undo button runs the undo", async () => {
    onAttachmentMetaApplied({ note_id: "n1", region_row_id: "r1", summary: "Seoul" });
    showToastOnly.mock.calls[0][1]();
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("note_region_remove", { id: "r1" }));
  });
});

describe("undoAttachmentMeta", () => {
  it("removes the related date row and the region row it added — nothing else", async () => {
    await undoAttachmentMeta({ note_id: "n1", date_row_id: "d1", region_row_id: "r1", summary: "x" });
    expect(call).toHaveBeenCalledWith("note_date_remove", { id: "d1" });
    expect(call).toHaveBeenCalledWith("note_region_remove", { id: "r1" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps undoing the rest when one step fails, and never throws", async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "note_date_remove") throw new Error("boom");
      return { ok: true };
    });
    await expect(
      undoAttachmentMeta({ note_id: "n1", date_row_id: "d1", region_row_id: "r1", summary: "x" }),
    ).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith("note_region_remove", { id: "r1" });
    expect(reloadActive).toHaveBeenCalled();
  });
});
