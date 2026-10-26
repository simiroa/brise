import { describe, it, expect } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { markCoverageRatio, markPressFromRatio } from "./markCoverage";

function makeEditor(content: string) {
  return new TiptapEditor({
    extensions: [StarterKit, Highlight],
    content,
  });
}

describe("markCoverageRatio", () => {
  it("returns 1 when the entire selection is covered by the mark", () => {
    const editor = makeEditor("<p><strong>bold</strong></p>");
    const { doc } = editor.state;
    // paragraph text "bold" spans [1, 5]
    expect(markCoverageRatio(doc, 1, 5, "bold")).toBe(1);
    editor.destroy();
  });

  it("returns 0 when none of the selection has the mark", () => {
    const editor = makeEditor("<p>plain</p>");
    const { doc } = editor.state;
    expect(markCoverageRatio(doc, 1, 6, "bold")).toBe(0);
    editor.destroy();
  });

  it("returns a value strictly between 0 and 1 for a half-marked selection", () => {
    const editor = makeEditor("<p><strong>bold</strong>plain</p>");
    const { doc } = editor.state;
    // "bold" [1,5] + "plain" [5,10] → select all text [1,10]
    const ratio = markCoverageRatio(doc, 1, 10, "bold");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeCloseTo(4 / 9, 5);
    editor.destroy();
  });

  it("returns 0 for an empty range", () => {
    const editor = makeEditor("<p><strong>bold</strong></p>");
    expect(markCoverageRatio(editor.state.doc, 2, 2, "bold")).toBe(0);
    editor.destroy();
  });

  it("works for highlight and code marks", () => {
    const editor = makeEditor("<p><mark>hi</mark><code>cd</code>xx</p>");
    const { doc } = editor.state;
    // "hi" [1,3], "cd" [3,5], "xx" [5,7]
    expect(markCoverageRatio(doc, 1, 3, "highlight")).toBe(1);
    expect(markCoverageRatio(doc, 1, 7, "highlight")).toBeCloseTo(2 / 6, 5);
    expect(markCoverageRatio(doc, 3, 5, "code")).toBe(1);
    expect(markCoverageRatio(doc, 1, 7, "code")).toBeCloseTo(2 / 6, 5);
    editor.destroy();
  });
});

describe("markPressFromRatio", () => {
  it("maps 0 / partial / 1 to off / partial / on", () => {
    expect(markPressFromRatio(0)).toBe("off");
    expect(markPressFromRatio(0.5)).toBe("partial");
    expect(markPressFromRatio(1)).toBe("on");
  });
});
