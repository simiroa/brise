import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { restoreExcerptSelection, uiLangToNlDateLocale } from "./SelectionContextMenu";

describe("restoreExcerptSelection", () => {
  it("restores the captured slice even when undo history is no longer usable", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>before selected after</p>" });
    const from = 8;
    const to = 16;
    const original = editor.state.doc.slice(from, to);

    editor.commands.command(({ tr }) => {
      tr.insertText("Selected", from, to);
      return true;
    });
    // Mirrors active-draft materialization: setContent rebuilds history above the replacement.
    editor.commands.setContent(editor.getHTML());

    expect(restoreExcerptSelection(editor, from, "Selected", original)).toBe(true);
    expect(editor.getText()).toBe("before selected after");
    editor.destroy();
  });
});

describe("uiLangToNlDateLocale", () => {
  it("passes ko/fr through unchanged", () => {
    expect(uiLangToNlDateLocale("ko")).toBe("ko");
    expect(uiLangToNlDateLocale("fr")).toBe("fr");
  });

  it("falls back to en for 'en' and anything unrecognized (mirrors openSelectionTranslate's own ternary)", () => {
    expect(uiLangToNlDateLocale("en")).toBe("en");
    expect(uiLangToNlDateLocale("xx")).toBe("en");
    expect(uiLangToNlDateLocale("")).toBe("en");
  });
});
