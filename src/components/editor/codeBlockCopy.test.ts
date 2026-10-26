import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlockWithCopy } from "./codeBlockCopy";

const editors: Editor[] = [];

function createEditor(editable = true) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    editable,
    extensions: [StarterKit.configure({ codeBlock: false }), CodeBlockWithCopy],
    content: "<pre><code>const answer = 42;</code></pre>",
  });
  editors.push(editor);
  return { editor, element };
}

afterEach(() => {
  vi.useRealTimers();
  while (editors.length) editors.pop()?.destroy();
  document.body.replaceChildren();
});

describe("CodeBlockWithCopy", () => {
  it("copies the entire live code block and briefly confirms success", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { element } = createEditor();
    const button = element.querySelector<HTMLButtonElement>(".brise-code-block-copy")!;

    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1600);
    expect(button.textContent).toBe("Copy");
  });

  it("keeps the copy button interactive in a read-only preview", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { element } = createEditor(false);
    const button = element.querySelector<HTMLButtonElement>(".brise-code-block-copy")!;

    expect(button.tabIndex).toBe(0);
    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  });
});
