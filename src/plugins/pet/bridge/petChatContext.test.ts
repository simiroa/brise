import { describe, expect, it } from "vitest";
import {
  ACTIVE_NOTE_EXCERPT_CAP,
  excerptFromActiveNote,
  composeChatAttachMessage,
  fileToChatAttach,
} from "./petChatContext";

describe("excerptFromActiveNote", () => {
  it("returns null without a note", () => {
    expect(excerptFromActiveNote(null)).toBeNull();
    expect(excerptFromActiveNote(undefined)).toBeNull();
  });

  it("strips tags, joins sections, and caps the excerpt", () => {
    const excerpt = excerptFromActiveNote({
      note: { id: "n1", title: "지금 노트" },
      sections: [
        { body_md: "<p>첫 줄</p>" },
        { body_md: "가".repeat(ACTIVE_NOTE_EXCERPT_CAP + 40) },
      ],
    });
    expect(excerpt).toEqual({
      active_note_id: "n1",
      active_note_title: "지금 노트",
      active_note_excerpt: expect.stringMatching(/^첫 줄 가+/),
    });
    expect(excerpt!.active_note_excerpt.length).toBe(ACTIVE_NOTE_EXCERPT_CAP);
  });
});

describe("composeChatAttachMessage", () => {
  it("joins draft and attachment blocks", () => {
    expect(
      composeChatAttachMessage("hi", [
        { id: "1", name: "a.txt", kind: "file", excerpt: "body" },
        { id: "2", name: "pic.png", kind: "image" },
      ]),
    ).toBe("hi\n\n[첨부: a.txt]\nbody\n\n[첨부: pic.png]");
  });

  it("allows attach-only messages", () => {
    expect(composeChatAttachMessage("  ", [{ id: "1", name: "x.pdf", kind: "file" }])).toBe("[첨부: x.pdf]");
  });
});

describe("fileToChatAttach", () => {
  it("reads text files as excerpt + name", async () => {
    const file = new File(["hello body"], "note.txt", { type: "text/plain" });
    const att = await fileToChatAttach(file);
    expect(att).toMatchObject({ name: "note.txt", kind: "file", excerpt: "hello body" });
  });

  it("skips extract for pdf File (name only)", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "scan.pdf", { type: "application/pdf" });
    const att = await fileToChatAttach(file);
    expect(att).toMatchObject({ name: "scan.pdf", kind: "file" });
    expect(att?.excerpt).toBeUndefined();
  });

  it("treats a png with empty MIME as an image", async () => {
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const url = `blob:test-${created.length}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = () => {};
    try {
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "" });
      const att = await fileToChatAttach(file);
      expect(att).toMatchObject({ name: "shot.png", kind: "image", mime: "image/png" });
      expect(att?.previewUrl).toBeTruthy();
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
