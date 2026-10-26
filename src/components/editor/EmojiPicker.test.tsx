import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EmojiPicker } from "./EmojiPicker";
import { t } from "../../i18n/t";

function makeEditor() {
  return new TiptapEditor({
    extensions: [StarterKit],
    content: "<p>hello</p>",
  });
}

afterEach(() => cleanup());

describe("EmojiPicker positioning and resize tracking", () => {
  it("renders emoji trigger button and opens popover on click", () => {
    const editor = makeEditor();
    render(<EmojiPicker editor={editor} />);
    const btn = screen.getByTitle(t("editor.emoji"));
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    const dialog = screen.getByRole("dialog", { name: t("editor.emoji") });
    expect(dialog).toBeTruthy();
    expect(dialog.parentElement).toBe(document.body);
    editor.destroy();
  });

  it("anchors popover to the button rather than hardcoding far right", () => {
    const editor = makeEditor();
    const { container } = render(
      <div className="content-canvas" style={{ width: 1000, height: 800 }}>
        <EmojiPicker editor={editor} />
      </div>
    );

    const btnWrapper = container.querySelector('[style*="inline-flex"]') as HTMLElement;
    vi.spyOn(btnWrapper, "getBoundingClientRect").mockReturnValue({
      left: 120,
      right: 150,
      top: 40,
      bottom: 64,
      width: 30,
      height: 24,
      x: 120,
      y: 40,
      toJSON: () => {},
    });

    const canvas = container.querySelector(".content-canvas") as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 50,
      right: 950,
      top: 30,
      bottom: 750,
      width: 900,
      height: 720,
      x: 50,
      y: 30,
      toJSON: () => {},
    });

    fireEvent.click(screen.getByTitle(t("editor.emoji")));
    const dialog = screen.getByRole("dialog", { name: t("editor.emoji") });
    // Should be anchored to button at 120px (not 950 - 300 - 8 = 642px)
    expect(dialog.style.left).toBe("120px");
    expect(dialog.style.top).toBe("70px"); // 64 + 6

    editor.destroy();
  });

  it("clamps popover position within container when button is near right edge", () => {
    const editor = makeEditor();
    const { container } = render(
      <div className="content-canvas" style={{ width: 400, height: 800 }}>
        <EmojiPicker editor={editor} />
      </div>
    );

    const btnWrapper = container.querySelector('[style*="inline-flex"]') as HTMLElement;
    vi.spyOn(btnWrapper, "getBoundingClientRect").mockReturnValue({
      left: 350,
      right: 380,
      top: 40,
      bottom: 64,
      width: 30,
      height: 24,
      x: 350,
      y: 40,
      toJSON: () => {},
    });

    const canvas = container.querySelector(".content-canvas") as HTMLElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 400,
      top: 30,
      bottom: 750,
      width: 400,
      height: 720,
      x: 0,
      y: 30,
      toJSON: () => {},
    });

    fireEvent.click(screen.getByTitle(t("editor.emoji")));
    const dialog = screen.getByRole("dialog", { name: t("editor.emoji") });
    // Canvas right is 400, inset is 8 -> rightLimit is 392.
    // 350 + 300 = 650 > 392, so it slides left to 392 - 300 = 92px.
    expect(dialog.style.left).toBe("92px");

    editor.destroy();
  });

  it("dynamically recalculates position on window resize while open", () => {
    const editor = makeEditor();
    const { container } = render(
      <div className="content-canvas" style={{ width: 800, height: 800 }}>
        <EmojiPicker editor={editor} />
      </div>
    );

    const btnWrapper = container.querySelector('[style*="inline-flex"]') as HTMLElement;
    vi.spyOn(btnWrapper, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 230,
      top: 40,
      bottom: 64,
      width: 30,
      height: 24,
      x: 200,
      y: 40,
      toJSON: () => {},
    });

    const canvas = container.querySelector(".content-canvas") as HTMLElement;
    let canvasRight = 800;
    vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(() => ({
      left: 0,
      right: canvasRight,
      top: 30,
      bottom: 750,
      width: canvasRight,
      height: 720,
      x: 0,
      y: 30,
      toJSON: () => {},
    }));

    fireEvent.click(screen.getByTitle(t("editor.emoji")));
    const dialog = screen.getByRole("dialog", { name: t("editor.emoji") });
    expect(dialog.style.left).toBe("200px");

    // Shrink window/canvas so 200 + 300 > rightLimit (e.g. canvasRight shrinks to 450)
    canvasRight = 450;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // rightLimit = 450 - 8 = 442. 442 - 300 = 142px.
    expect(dialog.style.left).toBe("142px");

    editor.destroy();
  });
});
