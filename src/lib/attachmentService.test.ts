import { beforeEach, describe, expect, it, vi } from "vitest";
import { addInternalAttachment, removeInternalBacklink } from "./attachmentService";
import type { NoteDetail } from "./commands.gen";

const callMock = vi.fn();
const showUndoToastMock = vi.fn();

vi.mock("./invoke", () => ({
  call: (...args: any[]) => callMock(...args),
  callSilent: (...args: any[]) => callMock(...args),
}));

vi.mock("./undo", () => ({
  showUndoToast: (...args: any[]) => showUndoToastMock(...args),
}));

vi.mock("../i18n/t", () => ({
  t: (k: string) => k,
}));

describe("attachmentService", () => {
  beforeEach(() => {
    callMock.mockReset();
    showUndoToastMock.mockReset();
  });

  describe("addInternalAttachment", () => {
    it("calls attachment_add_internal with note_id, target_note_id, name", async () => {
      callMock.mockResolvedValue({ id: "att-123" });
      const res = await addInternalAttachment("n1", "n2", "Target Note");
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
        note_id: "n1",
        target_note_id: "n2",
        name: "Target Note",
      });
      expect(res.id).toBe("att-123");
    });
  });

  describe("removeInternalBacklink", () => {
    it("finds matching attachment on source note, removes it, and registers undo toast", async () => {
      const sourceNote: NoteDetail = {
        note: { id: "s1", title: "Source", folder_id: "f", created_at: "", updated_at: "" },
        attachments: [{ id: "att-match-1", kind: "internal", url: "t1", name: "Target Note", size: 0, mime_type: "" }],
      } as any;

      callMock.mockImplementation((command: string, args: any) => {
        if (command === "note_get" && args.id === "s1") return Promise.resolve(sourceNote);
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const res = await removeInternalBacklink("s1", "t1");
      expect(res.removed).toBe(true);
      expect(res.removedCount).toBe(1);
      expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-match-1" });
      expect(showUndoToastMock).toHaveBeenCalledWith("undo.link_removed", expect.any(Function));
    });

    it("checks target note if not found on source note", async () => {
      const sourceNote: NoteDetail = {
        note: { id: "s1", title: "Source", folder_id: "f", created_at: "", updated_at: "" },
        attachments: [],
      } as any;
      const targetNote: NoteDetail = {
        note: { id: "t1", title: "Target", folder_id: "f", created_at: "", updated_at: "" },
        attachments: [{ id: "att-target-1", kind: "internal", url: "s1", name: "Source Note", size: 0, mime_type: "" }],
      } as any;

      callMock.mockImplementation((command: string, args: any) => {
        if (command === "note_get" && args.id === "s1") return Promise.resolve(sourceNote);
        if (command === "note_get" && args.id === "t1") return Promise.resolve(targetNote);
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const res = await removeInternalBacklink("s1", "t1");
      expect(res.removed).toBe(true);
      expect(res.removedCount).toBe(1);
      expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-target-1" });
    });

    it("falls back to default backlink name when attachment name is whitespace only", async () => {
      const sourceNote: NoteDetail = {
        note: { id: "s1", title: "Source", folder_id: "f", created_at: "", updated_at: "" },
        attachments: [{ id: "att-match-1", kind: "internal", url: "t1", name: "   ", size: 0, mime_type: "" }],
      } as any;

      callMock.mockImplementation((command: string, args: any) => {
        if (command === "note_get" && args.id === "s1") return Promise.resolve(sourceNote);
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const res = await removeInternalBacklink("s1", "t1");
      expect(res.removed).toBe(true);
      expect(showUndoToastMock).toHaveBeenCalledWith("undo.link_removed", expect.any(Function));
    });
  });
});
