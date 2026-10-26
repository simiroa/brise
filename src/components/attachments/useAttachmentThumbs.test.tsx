import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAttachmentThumbs } from "./useAttachmentThumbs";
import { assertHookSettles } from "../../test/renderLoop";
import { useNotesStore } from "../../stores/notes";
import { callSilent } from "../../lib/invoke";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async (cmd: string, args: { note_id: string }) => {
    if (cmd === "attachment_thumbs") {
      if (args.note_id === "n1") {
        return {
          thumbs: [
            { id: "img1", rel_path: "thumbs/img1_thumb.jpg" },
          ],
        };
      }
      if (args.note_id === "n2") {
        return {
          thumbs: [
            { id: "img3", rel_path: "thumbs/img3_thumb.jpg" },
          ],
        };
      }
    }
    return { thumbs: [] };
  }),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

describe("useAttachmentThumbs", () => {
  it("resolves covered attachments to thumbnail rel_path and uncovered ones to undefined", async () => {
    let thumbsMap = new Map<string, string>();
    const { renders } = await assertHookSettles(() => {
      thumbsMap = useAttachmentThumbs("n1");
    });

    expect(renders).toBeLessThanOrEqual(5);
    expect(thumbsMap.get("img1")).toBe("thumbs/img1_thumb.jpg");
    expect(thumbsMap.get("img2")).toBeUndefined();
  });

  it("refetches when attachmentRevision bumps while noteId is unchanged", async () => {
    const { result } = renderHook(() => useAttachmentThumbs("n1"));
    await waitFor(() => {
      expect(result.current.get("img1")).toBe("thumbs/img1_thumb.jpg");
    });

    const callsBefore = vi.mocked(callSilent).mock.calls.length;

    act(() => {
      useNotesStore.getState().bumpAttachmentRevision();
    });

    await waitFor(() => {
      expect(vi.mocked(callSilent).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
