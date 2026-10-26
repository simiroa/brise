import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { ImageButton, isInsertStillOnTarget } from "./buttons";
import { t } from "../../../i18n/t";

// Insert-race fix (mirrors EditorPanel.tsx's pasteImageFile / isPasteStillOnTarget, a0997af;
// widened to also cover section switches, flagged follow-up from 9cb466d):
// ImageButton.insertImage awaits a native file dialog + attachment_add_file before calling
// editor.chain().setImage() — if the user switches to a different note OR a different section tab
// within the same note during either await, the insert used to land in whatever note/section
// happens to be active by the time it resolves (a cross-document write). These tests drive the
// real async insertImage flow (not just the pure comparator) so the race is proven end-to-end: no
// image node lands, and no reload fires.

let openResolve: (path: string | null) => void;
const openMock = vi.fn(() => new Promise<string | null>((resolve) => { openResolve = resolve; }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => openMock(),
}));

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  callSilent: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  emitNotice: (message: string) => emitNoticeMock(message),
}));

let activeNoteId: string | null = "note-A";
const reloadActiveMock = vi.fn();
vi.mock("../../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: activeNoteId ? { note: { id: activeNoteId } } : null,
      reloadActive: reloadActiveMock,
    }),
  },
}));

function makeEditor(content = "<p>hello</p>") {
  // inline:true mirrors the live editor's schema (mdSerialize.ts's BriseImage, item 7) — a stock
  // block-level Image here would silently test a node shape production no longer inserts.
  return new TiptapEditor({ extensions: [StarterKit, Image.configure({ inline: true })], content });
}

function countImages(editor: TiptapEditor): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") n++;
  });
  return n;
}

beforeEach(() => {
  activeNoteId = "note-A";
  openMock.mockClear();
  callMock.mockReset();
  callMock.mockResolvedValue({ name: "photo.png", rel_path: "attachments/ab/photo.png" });
  emitNoticeMock.mockClear();
  reloadActiveMock.mockClear();
});

afterEach(() => cleanup());

describe("isInsertStillOnTarget", () => {
  it("true when neither note nor section changed during the awaits", () => {
    expect(
      isInsertStillOnTarget({ noteId: "note-A", sectionId: "sec-1" }, { noteId: "note-A", sectionId: "sec-1" })
    ).toBe(true);
  });

  it("false when the active note changed mid-insert (user switched tabs)", () => {
    expect(
      isInsertStillOnTarget({ noteId: "note-A", sectionId: "sec-1" }, { noteId: "note-B", sectionId: "sec-1" })
    ).toBe(false);
  });

  it("false when the active note closed entirely (activeNote undefined)", () => {
    expect(
      isInsertStillOnTarget({ noteId: "note-A", sectionId: "sec-1" }, { noteId: undefined, sectionId: "sec-1" })
    ).toBe(false);
  });

  it("false when the section changed within the same note (multi-section tab switch)", () => {
    expect(
      isInsertStillOnTarget({ noteId: "note-A", sectionId: "sec-1" }, { noteId: "note-A", sectionId: "sec-2" })
    ).toBe(false);
  });
});

describe("ImageButton.insertImage — note/section-switch race guard", () => {
  it("skips the insert and notifies when the active note changes during the awaits", async () => {
    const editor = makeEditor();
    const sectionRef = { current: { id: "sec-1" } };
    render(<ImageButton editor={editor} noteId="note-A" sectionRef={sectionRef} />);
    fireEvent.click(screen.getByTitle(t("editor.image")));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    // The real async gap insertImage can't see: user switches to a different note while the
    // native file dialog is still open.
    activeNoteId = "note-B";
    openResolve("/tmp/photo.png");

    // attachment_add_file still runs — the attachment is saved regardless (acceptable: losing
    // the auto-insert is fine, a cross-document write is not).
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("attachment_add_file", expect.objectContaining({ file_path: "/tmp/photo.png" })));
    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.image_paste_note_changed")));

    expect(countImages(editor)).toBe(0);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("skips the insert and notifies when the section changes mid-await within the same note", async () => {
    const editor = makeEditor();
    const sectionRef = { current: { id: "sec-1" } };
    render(<ImageButton editor={editor} noteId="note-A" sectionRef={sectionRef} />);
    fireEvent.click(screen.getByTitle(t("editor.image")));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    // Same note stays active, but the user switches section tabs while the native file dialog
    // is still open — the flagged follow-up gap from 9cb466d.
    sectionRef.current = { id: "sec-2" };
    openResolve("/tmp/photo.png");

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("attachment_add_file", expect.objectContaining({ file_path: "/tmp/photo.png" })));
    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.image_paste_note_changed")));

    expect(countImages(editor)).toBe(0);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("still inserts normally when neither note nor section changes", async () => {
    const editor = makeEditor();
    const sectionRef = { current: { id: "sec-1" } };
    render(<ImageButton editor={editor} noteId="note-A" sectionRef={sectionRef} />);
    fireEvent.click(screen.getByTitle(t("editor.image")));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    openResolve("/tmp/photo.png");

    await waitFor(() => expect(countImages(editor)).toBe(1));
    expect(reloadActiveMock).toHaveBeenCalled();
    expect(emitNoticeMock).not.toHaveBeenCalled();
    editor.destroy();
  });
});

// Owner QA 6, item 4 ("이미지 삽입이 캐럿 위치에 안 들어간다"): the file dialog itself is modal (the
// user can't touch the document while it's open), but attachment_add_file is a real IPC round
// trip that hands control back to the app first — the caret CAN move during that specific gap.
// This drives the real async insertImage flow end-to-end (not the pure helper) and proves the
// image lands where the caret was when the button was clicked, not wherever it drifted to during
// the upload.
describe("ImageButton.insertImage — inserts at the captured caret, not wherever the selection drifted (item 4)", () => {
  it("lands the image where the caret was on click, even if the selection moves during attachment_add_file's IPC gap", async () => {
    const editor = makeEditor("<p>hello world</p>");
    const sectionRef = { current: { id: "sec-1" } };
    // Position the caret between "hello" and " world" before the insert starts.
    editor.commands.setTextSelection(6);
    render(<ImageButton editor={editor} noteId="note-A" sectionRef={sectionRef} />);
    fireEvent.click(screen.getByTitle(t("editor.image")));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    let resolveAttachment: (v: unknown) => void;
    callMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAttachment = resolve; })
    );
    openResolve("/tmp/photo.png");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("attachment_add_file", expect.objectContaining({ file_path: "/tmp/photo.png" })));

    // The exact race the fix closes: the caret moves while attachment_add_file is still pending.
    editor.commands.setTextSelection(1);
    resolveAttachment!({ name: "photo.png", rel_path: "attachments/ab/photo.png" });

    await waitFor(() => expect(countImages(editor)).toBe(1));

    let imagePos = -1;
    let paragraphCount = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos;
      if (node.type.name === "paragraph") paragraphCount++;
    });
    // Inline image (item 7): the insert must land inside the one paragraph, not split it into
    // two block-level siblings the way a block-level image node would.
    expect(paragraphCount).toBe(1);
    // The image must sit between "hello" and "world" (position 6, captured at click time) — not
    // at position 1 (where the caret drifted to during the upload), which would leave ALL of
    // "hello world" after the image instead of split around it.
    const before = editor.state.doc.textBetween(0, imagePos, "|").trim();
    const after = editor.state.doc.textBetween(imagePos + 1, editor.state.doc.content.size, "|").trim();
    expect(before).toBe("hello");
    expect(after).toBe("world");

    editor.destroy();
  });
});
