import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { ImageBubbleMenu } from "./ImageBubble";
import { t } from "../../../i18n/t";

afterEach(() => {
  cleanup();
});

describe("ImageBubbleMenu", () => {
  it("renders width label, copy button, and trash button with proper titles and accessibility", () => {
    const editor = new Editor({
      extensions: [StarterKit, Image.configure({ inline: true })],
      content: '<p><img src="test.png" width="40%" /></p>',
    });

    // Select the image node
    editor.commands.setNodeSelection(1);

    render(<ImageBubbleMenu editor={editor} scrollEl={null} />);

    // Width label
    const widthEl = screen.getByTitle(t("editor.image_resize_handle"));
    expect(widthEl).toBeDefined();
    expect(widthEl.textContent).toBe("40%");

    // Copy button
    const copyBtn = screen.getByTitle(t("editor.image_copy"));
    expect(copyBtn).toBeDefined();

    // Delete button (IconTrash)
    const deleteBtn = screen.getByTitle(t("ctx.remove"));
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn.getAttribute("aria-label")).toBe(t("ctx.remove"));

    editor.destroy();
  });
});
