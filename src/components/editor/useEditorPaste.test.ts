import { describe, it, expect, vi, beforeEach } from "vitest";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({ id: "att-1" }));
const callSilent = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
const emitNotice = vi.fn();
const reloadActive = vi.fn(async () => {});
const ensureMaterialized = vi.fn(async () => "note-1");
const markSnapshotDirty = vi.fn();
const insertImagesAtRange = vi.fn();
const isStillOnTarget = vi.fn((_a?: unknown, _b?: unknown) => true);
const showToastOnly = vi.fn((_msg: string, onAction?: () => void, _opts?: unknown) => {
  onAction?.();
});

let mockAiEnabled = true;
let mockLinkSuggestions = true;
// 오너 결정(2026-09-20) — 세 붙여넣기 토글, 전부 기본 ON(구현 전 동작 유지) 이라 값을 명시적으로
// false 로 바꾸는 테스트가 아니면 이 기본값이 기존 테스트를 그대로 통과시킨다.
let mockPastePathInlineCode = true;
let mockPasteLinkNudge = true;
let mockPasteTableSheetSuggest = true;

vi.mock("../../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => callSilent(cmd, args),
  emitNotice: (...a: unknown[]) => emitNotice(...a),
}));

vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      ensureMaterialized,
      reloadActive,
      activeNote: { note: { id: "note-1" } },
    }),
  },
  markSnapshotDirty: () => markSnapshotDirty(),
}));

vi.mock("../../stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      aiEnabled: mockAiEnabled,
      linkSuggestions: mockLinkSuggestions,
      pastePathInlineCode: mockPastePathInlineCode,
      pasteLinkNudge: mockPasteLinkNudge,
      pasteTableSheetSuggest: mockPasteTableSheetSuggest,
    }),
  },
}));

vi.mock("./insertImageAtPos", () => ({
  insertImagesAtRange: (...a: unknown[]) => insertImagesAtRange(...a),
}));

vi.mock("../../lib/onTargetGuard", () => ({
  isStillOnTarget: (...a: unknown[]) => isStillOnTarget(...(a as [unknown, unknown])),
}));

vi.mock("../../lib/undo", () => ({
  showToastOnly: (msg: string, onAction?: () => void, opts?: unknown) =>
    showToastOnly(msg, onAction, opts),
}));

import { renderHook, act } from "@testing-library/react";
import { t } from "../../i18n/t";

// Mock FileReader in jsdom / node environment
class MockFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  error: Error | null = null;

  readAsDataURL(blob: Blob) {
    setTimeout(() => {
      if ((blob as any)._simulateError) {
        this.error = new Error("FileReader failure");
        this.onerror?.();
        return;
      }
      this.result = "data:image/png;base64,QUJD";
      this.onload?.();
    }, 0);
  }
}
vi.stubGlobal("FileReader", MockFileReader);

import {
  pasteImageFiles,
  pasteUrlSuggest,
  suggestSheetFromPaste,
  shouldSuggestSheetFromPaste,
  handleImagePaste,
  useEditorPaste,
} from "./useEditorPaste";

function fakeEditor(overrides: Record<string, unknown> = {}) {
  const chainObj = {
    insertContent: vi.fn().mockReturnThis(),
    unsetMark: vi.fn().mockReturnThis(),
    run: vi.fn(),
  };
  return {
    isDestroyed: false,
    isActive: vi.fn(() => false),
    chain: vi.fn(() => chainObj),
    ...overrides,
  } as any;
}

function fakeView(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: false,
    state: { selection: { from: 5, to: 5 } },
    coordsAtPos: vi.fn(() => ({ left: 100, bottom: 200 })),
    ...overrides,
  } as any;
}

function fakeSlice(text = "") {
  return {
    content: {
      size: text.length,
      textBetween: () => text,
    },
  } as any;
}

describe("useEditorPaste pipeline safety-net tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({ id: "att-1" }));
    callSilent.mockImplementation(async () => ({}));
    ensureMaterialized.mockImplementation(async () => "note-1");
    isStillOnTarget.mockReturnValue(true);
    mockAiEnabled = true;
    mockLinkSuggestions = true;
    mockPastePathInlineCode = true;
    mockPasteLinkNudge = true;
    mockPasteTableSheetSuggest = true;
  });

  describe("pasteImageFiles", () => {
    it("successfully uploads image bytes, inserts image nodes, and reloads active note", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      await pasteImageFiles([file], { from: 2, to: 2 }, { editor, sectionRef });

      expect(ensureMaterialized).toHaveBeenCalled();
      expect(call).toHaveBeenCalledWith("attachment_add_bytes", {
        note_id: "note-1",
        name: "photo.png",
        data_base64: "QUJD",
      });
      expect(insertImagesAtRange).toHaveBeenCalledWith(editor, [{ id: "att-1" }], { from: 2, to: 2 });
      expect(reloadActive).toHaveBeenCalled();
    });

    it("aborts early if editor is null or destroyed", async () => {
      const destroyedEditor = fakeEditor({ isDestroyed: true });
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor: null, sectionRef });
      expect(ensureMaterialized).not.toHaveBeenCalled();

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor: destroyedEditor, sectionRef });
      expect(ensureMaterialized).not.toHaveBeenCalled();
    });

    it("aborts early if files array is empty without materializing note", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      await pasteImageFiles([], { from: 0, to: 0 }, { editor, sectionRef });
      expect(ensureMaterialized).not.toHaveBeenCalled();
    });

    it("emits notice when note materialization fails", async () => {
      ensureMaterialized.mockResolvedValueOnce(null as any);
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(emitNotice).toHaveBeenCalledWith(t("editor.note_required_for_section"));
      expect(call).not.toHaveBeenCalledWith("attachment_add_bytes", expect.anything());
      expect(insertImagesAtRange).not.toHaveBeenCalled();
    });

    it("aborts insertion if editor is destroyed during async FileReader/IPC await (CLAUDE.md Pitfall 2)", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      call.mockImplementationOnce(async () => {
        editor.isDestroyed = true; // Editor destroyed during IPC
        return { id: "att-1" };
      });

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(call).toHaveBeenCalledWith("attachment_add_bytes", expect.anything());
      expect(insertImagesAtRange).not.toHaveBeenCalled();
      expect(reloadActive).not.toHaveBeenCalled();
    });

    it("aborts early without reading files or calling IPC if editor is destroyed during ensureMaterialized await", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      ensureMaterialized.mockImplementationOnce(async () => {
        editor.isDestroyed = true;
        return "note-1";
      });

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(call).not.toHaveBeenCalledWith("attachment_add_bytes", expect.anything());
      expect(insertImagesAtRange).not.toHaveBeenCalled();
      expect(reloadActive).not.toHaveBeenCalled();
    });

    it("emits notice and skips node insertion if active note changed mid-paste", async () => {
      isStillOnTarget.mockReturnValueOnce(false);
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(emitNotice).toHaveBeenCalledWith(t("editor.image_paste_note_changed"));
      expect(insertImagesAtRange).not.toHaveBeenCalled();
      expect(reloadActive).not.toHaveBeenCalled();
    });

    it("emits notice and skips node insertion when attachment_add_bytes throws an error", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });
      call.mockRejectedValueOnce(new Error("disk full"));

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(emitNotice).toHaveBeenCalledWith(t("editor.image_insert_failed"));
      expect(insertImagesAtRange).not.toHaveBeenCalled();
      expect(reloadActive).not.toHaveBeenCalled();
    });

    it("emits notice and skips node insertion when FileReader fails", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "sec-1", kind: "text" } };
      const file = new File(["dummy"], "photo.png", { type: "image/png" });
      (file as any)._simulateError = true;

      await pasteImageFiles([file], { from: 0, to: 0 }, { editor, sectionRef });

      expect(emitNotice).toHaveBeenCalledWith(t("editor.image_insert_failed"));
      expect(insertImagesAtRange).not.toHaveBeenCalled();
      expect(reloadActive).not.toHaveBeenCalled();
    });
  });

  describe("pasteUrlSuggest", () => {
    it("calls link_suggest when AI and link suggestions are enabled", async () => {
      pasteUrlSuggest("https://example.com");
      await vi.waitFor(() => {
        expect(callSilent).toHaveBeenCalledWith("link_suggest", {
          note_id: "note-1",
          url: "https://example.com",
        });
      });
    });

    it("does not call IPC when AI is disabled", async () => {
      mockAiEnabled = false;
      pasteUrlSuggest("https://example.com");
      expect(callSilent).not.toHaveBeenCalled();
    });

    it("does not call IPC when linkSuggestions is disabled", async () => {
      mockLinkSuggestions = false;
      pasteUrlSuggest("https://example.com");
      expect(callSilent).not.toHaveBeenCalled();
    });
  });

  describe("suggestSheetFromPaste", () => {
    it("shows toast and executes sheet creation and section switch on action", async () => {
      const appendSectionLocally = vi.fn();
      const switchSection = vi.fn(async () => {});
      const matrix = [["A", "B"], ["1", "2"]];
      const newSec = { id: "s-sheet", kind: "sheet" };
      call.mockResolvedValueOnce(newSec);

      suggestSheetFromPaste(matrix, { appendSectionLocally, switchSection });

      expect(showToastOnly).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(call).toHaveBeenCalledWith("section_create_with_body", expect.objectContaining({
          note_id: "note-1",
          kind: "sheet",
        }));
        expect(appendSectionLocally).toHaveBeenCalledWith("note-1", newSec);
        expect(markSnapshotDirty).toHaveBeenCalled();
        expect(switchSection).toHaveBeenCalledWith(newSec);
      });
    });

    it("aborts early when ensureMaterialized returns null", async () => {
      ensureMaterialized.mockResolvedValueOnce(null as any);
      const appendSectionLocally = vi.fn();
      const switchSection = vi.fn(async () => {});
      const matrix = [["A", "B"], ["1", "2"]];

      suggestSheetFromPaste(matrix, { appendSectionLocally, switchSection });

      expect(showToastOnly).toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 10));
      expect(call).not.toHaveBeenCalledWith("section_create_with_body", expect.anything());
      expect(appendSectionLocally).not.toHaveBeenCalled();
    });

    it("emits notice when matrix exceeds sheet dimensions and is truncated", async () => {
      const appendSectionLocally = vi.fn();
      const switchSection = vi.fn(async () => {});
      // 53 columns exceeds SHEET_LIMITS.maxCols (52)
      const bigRow = Array.from({ length: 53 }, (_, i) => `c${i}`);
      const matrix = [bigRow, bigRow];
      call.mockResolvedValueOnce({ id: "s-sheet-trunc", kind: "sheet" });

      suggestSheetFromPaste(matrix, { appendSectionLocally, switchSection });

      await vi.waitFor(() => {
        expect(emitNotice).toHaveBeenCalledWith(t("editor.section_import_truncated"));
      });
    });

    it("handles call failure gracefully without throwing unhandled error", async () => {
      const appendSectionLocally = vi.fn();
      const switchSection = vi.fn(async () => {});
      const matrix = [["A", "B"], ["1", "2"]];
      call.mockRejectedValueOnce(new Error("RPC failed"));

      expect(() => {
        suggestSheetFromPaste(matrix, { appendSectionLocally, switchSection });
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 10));
      expect(switchSection).not.toHaveBeenCalled();
    });
  });

  describe("handleImagePaste", () => {
    it("handles image-only clipboard payload by calling pasteImageFiles and preventing default", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const preventDefault = vi.fn();
      const file = new File(["image-data"], "screenshot.png", { type: "image/png" });
      const event = {
        preventDefault,
        clipboardData: {
          files: [file],
          getData: () => "",
        },
      } as any;
      const slice = fakeSlice("");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
    });

    it("styles single file path with inline code mark outside of code blocks", () => {
      const editor = fakeEditor({ isActive: vi.fn(() => false) });
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "C:\\Users\\test.txt" : ""),
        },
      } as any;
      const slice = fakeSlice("C:\\Users\\test.txt");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(editor.chain).toHaveBeenCalled();
      expect(editor.chain().insertContent).toHaveBeenCalledWith({
        type: "text",
        text: "C:\\Users\\test.txt",
        marks: [{ type: "code" }],
      });
      expect(editor.chain().unsetMark).toHaveBeenCalledWith("code");
      expect(editor.chain().run).toHaveBeenCalled();
    });

    it("falls through without code styling if caret is already inside code", () => {
      const editor = fakeEditor({ isActive: vi.fn((name: string) => name === "code") });
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "C:\\Users\\test.txt" : ""),
        },
      } as any;
      const slice = fakeSlice("C:\\Users\\test.txt");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("falls through safely without crashing if editor is destroyed during file path paste", () => {
      const destroyedEditor = fakeEditor({ isDestroyed: true });
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "C:\\Users\\test.txt" : ""),
        },
      } as any;
      const slice = fakeSlice("C:\\Users\\test.txt");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => destroyedEditor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(destroyedEditor.chain).not.toHaveBeenCalled();
    });

    it("detects single URL, triggers pasteUrlSuggest and schedules linkNudge without preventDefault", async () => {
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
        cb();
        return 1;
      });

      const editor = fakeEditor();
      const view = fakeView();
      const preventDefault = vi.fn();
      const setLinkNudge = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "https://example.com/page" : ""),
        },
      } as any;
      const slice = fakeSlice("https://example.com/page");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge,
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(setLinkNudge).toHaveBeenCalledWith({
        x: 100,
        y: 206,
        urls: ["https://example.com/page"],
      });
    });

    it("detects 2x2 tabular paste and triggers suggestSheetFromPaste", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "col1\tcol2\nval1\tval2" : ""),
        },
      } as any;
      const slice = fakeSlice("col1\tcol2\nval1\tval2");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(showToastOnly).toHaveBeenCalled();
    });

    it("falls through for ordinary plain text paste", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "just some regular note text" : ""),
        },
      } as any;
      const slice = fakeSlice("just some regular note text");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("does not set link nudge if view is destroyed when rAF callback fires", () => {
      let rAFCallback: (() => void) | null = null;
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
        rAFCallback = cb;
        return 1;
      });

      const editor = fakeEditor();
      const view = fakeView();
      const setLinkNudge = vi.fn();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: () => "https://example.com/page",
        },
      } as any;
      const slice = fakeSlice("https://example.com/page");

      handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge,
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(rAFCallback).not.toBeNull();
      view.isDestroyed = true; // View destroyed before rAF fires
      rAFCallback!();

      expect(setLinkNudge).not.toHaveBeenCalled();
    });

    it("does not set link nudge for non-readable URL extensions (e.g. zip file)", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const setLinkNudge = vi.fn();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: () => "https://example.com/archive.zip",
        },
      } as any;
      const slice = fakeSlice("https://example.com/archive.zip");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge,
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(setLinkNudge).not.toHaveBeenCalled();
    });

    it("handles null or empty clipboardData safely without crashing", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: null,
      } as any;
      const slice = fakeSlice("");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
    });
  });

  // 오너 결정(2026-09-20) — 세 붙여넣기 토글. 각각 off/on 한 쌍씩.
  describe("handleImagePaste — paste toggle gates", () => {
    it("pastePathInlineCode=false: skips the inline-code branch entirely, falls through to plain paste", () => {
      mockPastePathInlineCode = false;
      const editor = fakeEditor({ isActive: vi.fn(() => false) });
      const view = fakeView();
      const preventDefault = vi.fn();
      const event = {
        preventDefault,
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "C:\\Users\\test.txt" : ""),
        },
      } as any;
      const slice = fakeSlice("C:\\Users\\test.txt");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false); // falls through to the default paste chain
      expect(preventDefault).not.toHaveBeenCalled();
      expect(editor.chain).not.toHaveBeenCalled();
    });

    it("pastePathInlineCode=true (default): still styles the sole file path (regression guard)", () => {
      const editor = fakeEditor({ isActive: vi.fn(() => false) });
      const view = fakeView();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "C:\\Users\\test.txt" : ""),
        },
      } as any;
      const slice = fakeSlice("C:\\Users\\test.txt");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(true);
      expect(editor.chain).toHaveBeenCalled();
    });

    it("pasteLinkNudge=false: does not open the link-body nudge, but pasteUrlSuggest still fires", async () => {
      mockPasteLinkNudge = false;
      const editor = fakeEditor();
      const view = fakeView();
      const setLinkNudge = vi.fn();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "https://example.com/page" : ""),
        },
      } as any;
      const slice = fakeSlice("https://example.com/page");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge,
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(setLinkNudge).not.toHaveBeenCalled();
      // pasteUrlSuggest is the AI link-summary suggestion (aiEnabled && linkSuggestions gate) — a
      // separate axis from this "가져올까요?" nudge toggle, so it must still fire.
      await vi.waitFor(() => {
        expect(callSilent).toHaveBeenCalledWith("link_suggest", {
          note_id: "note-1",
          url: "https://example.com/page",
        });
      });
    });

    it("pasteLinkNudge=true (default): opens the link-body nudge (regression guard)", () => {
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
        cb();
        return 1;
      });
      const editor = fakeEditor();
      const view = fakeView();
      const setLinkNudge = vi.fn();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "https://example.com/page" : ""),
        },
      } as any;
      const slice = fakeSlice("https://example.com/page");

      handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge,
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(setLinkNudge).toHaveBeenCalled();
    });

    it("pasteTableSheetSuggest=false: no sheet suggestion at the paste call site", () => {
      mockPasteTableSheetSuggest = false;
      const editor = fakeEditor();
      const view = fakeView();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "col1\tcol2\nval1\tval2" : ""),
        },
      } as any;
      const slice = fakeSlice("col1\tcol2\nval1\tval2");

      const result = handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(result).toBe(false);
      expect(showToastOnly).not.toHaveBeenCalled();
    });

    it("pasteTableSheetSuggest=true (default): still suggests a sheet (regression guard)", () => {
      const editor = fakeEditor();
      const view = fakeView();
      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          files: [],
          getData: (format: string) => (format === "text/plain" ? "col1\tcol2\nval1\tval2" : ""),
        },
      } as any;
      const slice = fakeSlice("col1\tcol2\nval1\tval2");

      handleImagePaste(view, event, slice, {
        getEditor: () => editor,
        sectionRef: { current: { id: "s1" } },
        setLinkNudge: vi.fn(),
        appendSectionLocally: vi.fn(),
        switchSection: vi.fn(),
      });

      expect(showToastOnly).toHaveBeenCalled();
    });
  });

  describe("shouldSuggestSheetFromPaste — enabled parameter", () => {
    it("defaults to enabled when the third argument is omitted (existing call sites/tests unaffected)", () => {
      expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], false)).toBe(true);
    });

    it("false when explicitly disabled, regardless of an otherwise-matching matrix", () => {
      expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], false, false)).toBe(false);
    });

    it("true when explicitly enabled with a matching matrix", () => {
      expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], false, true)).toBe(true);
    });
  });

  describe("useEditorPaste hook", () => {
    it("returns bound helpers and reflects latest callback props without stale closures", async () => {
      const editor = fakeEditor();
      const sectionRef = { current: { id: "s-1", kind: "text" } };
      const append1 = vi.fn();
      const append2 = vi.fn();
      const switch1 = vi.fn(async () => {});
      const switch2 = vi.fn(async () => {});
      const setLinkNudge = vi.fn();

      const { result, rerender } = renderHook(
        ({ append, sw }) =>
          useEditorPaste(
            () => editor,
            sectionRef,
            setLinkNudge,
            append,
            sw
          ),
        {
          initialProps: { append: append1, sw: switch1 },
        }
      );

      expect(typeof result.current.handlePaste).toBe("function");
      expect(typeof result.current.pasteImageFiles).toBe("function");
      expect(typeof result.current.pasteUrlSuggest).toBe("function");
      expect(typeof result.current.suggestSheetFromPaste).toBe("function");

      // Re-render with new callback identities
      rerender({ append: append2, sw: switch2 });

      // Trigger suggestSheetFromPaste
      const matrix = [["A", "B"], ["1", "2"]];
      const newSec = { id: "s-sheet-2", kind: "sheet" };
      call.mockResolvedValueOnce(newSec);

      act(() => {
        result.current.suggestSheetFromPaste(matrix);
      });

      await vi.waitFor(() => {
        expect(append2).toHaveBeenCalledWith("note-1", newSec);
        expect(append1).not.toHaveBeenCalled();
        expect(switch2).toHaveBeenCalledWith(newSec);
        expect(switch1).not.toHaveBeenCalled();
      });
    });

    // 오너 결정(2026-09-20) — 이 훅이 직접 노출하는 suggestSheetFromPaste 는
    // shouldSuggestSheetFromPaste 를 거치지 않는 두 번째 호출 지점이라, 별도로 게이트를 확인한다.
    it("second call site (the hook's exposed suggestSheetFromPaste): pasteTableSheetSuggest=false suppresses it too", () => {
      mockPasteTableSheetSuggest = false;
      const editor = fakeEditor();
      const sectionRef = { current: { id: "s-1", kind: "text" } };
      const { result } = renderHook(() =>
        useEditorPaste(() => editor, sectionRef, vi.fn(), vi.fn(), vi.fn(async () => {}))
      );

      act(() => {
        result.current.suggestSheetFromPaste([["A", "B"], ["1", "2"]]);
      });

      expect(showToastOnly).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalledWith("section_create_with_body", expect.anything());
    });

    it("keeps handlePaste identity stable across re-renders and dynamically resolves getEditor/sectionRef", () => {
      const editor1 = fakeEditor({ id: "ed-1" });
      const editor2 = fakeEditor({ id: "ed-2" });
      const sec1 = { id: "s-1" };
      const sec2 = { id: "s-2" };
      let currentEditor = editor1;
      let currentSec = sec1;

      const { result, rerender } = renderHook(() =>
        useEditorPaste(
          () => currentEditor,
          () => currentSec,
          vi.fn(),
          vi.fn(),
          vi.fn(async () => {})
        )
      );

      const initialHandlePaste = result.current.handlePaste;

      // Swap editor and section references
      currentEditor = editor2;
      currentSec = sec2;
      rerender();

      // handlePaste callback identity must remain stable to avoid ProseMirror re-binding
      expect(result.current.handlePaste).toBe(initialHandlePaste);
    });
  });
});
