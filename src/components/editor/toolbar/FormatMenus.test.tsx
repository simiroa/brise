import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import { t } from "../../../i18n/t";
import { BriseHeading, BriseParagraph, ParagraphFormatCommands } from "../paragraphFormat";
import { AlignFormatMenu, BlockFormatMenu, ClearFormattingButton, InlineCodeButton, ParagraphFormatMenu } from "./FormatMenus";

afterEach(cleanup);

function makeEditor(content = "<p>hello world</p>") {
  return new Editor({ extensions: [StarterKit, Highlight, TextStyle, Color, Link.configure({ openOnClick: false })], content });
}

describe("selection formatting controls", () => {
  it("focuses the first enabled menu item and supports arrow/Home/End/Escape navigation", () => {
    const editor = makeEditor();
    render(<BlockFormatMenu editor={editor} />);
    const trigger = screen.getByTestId("block-format-menu");

    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "End" });
    const lastItem = items[items.length - 1];
    expect(document.activeElement).toBe(lastItem);
    fireEvent.keyDown(lastItem, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    editor.destroy();
  });

  it("applies indentation from the paragraph menu and alignment from its own menu", () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false, heading: false }),
        BriseParagraph,
        BriseHeading,
        ParagraphFormatCommands,
      ],
      content: "<p>hello</p>",
    });
    render(
      <>
        <ParagraphFormatMenu editor={editor} />
        <AlignFormatMenu editor={editor} />
      </>,
    );

    // 정렬은 문단 메뉴 안에 없다 — 별개 드롭다운이다(오너 2026-09-09).
    fireEvent.click(screen.getByTestId("paragraph-format-menu"));
    expect(screen.queryByText(t("editor.align_center"))).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByTestId("align-format-menu"));
    fireEvent.click(screen.getByText(t("editor.align_center")));
    expect(editor.getAttributes("paragraph").textAlign).toBe("center");

    fireEvent.click(screen.getByTestId("paragraph-format-menu"));
    fireEvent.click(screen.getByText(t("editor.indent")));
    expect(editor.getAttributes("paragraph").indent).toBe(1);
    editor.destroy();
  });

  it("정렬 메뉴에 양쪽 정렬 항목이 있고, 고르면 문단·제목에 justify 가 걸린다", () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false, heading: false }),
        BriseParagraph,
        BriseHeading,
        ParagraphFormatCommands,
      ],
      content: "<p>hello</p><h2>title</h2>",
    });
    render(<AlignFormatMenu editor={editor} />);

    fireEvent.click(screen.getByTestId("align-format-menu"));
    expect(screen.getAllByRole("menuitemcheckbox").map((item) => item.textContent)).toEqual([
      t("editor.align_left"),
      t("editor.align_center"),
      t("editor.align_right"),
      t("editor.align_justify"),
    ]);
    fireEvent.click(screen.getByText(t("editor.align_justify")));
    expect(editor.getAttributes("paragraph").textAlign).toBe("justify");

    // 제목 위에서도 같은 항목이 동작하고, 메뉴를 다시 열면 현재 정렬이 체크로 보인다.
    // 문서 끝에는 StarterKit 의 trailing 빈 문단이 붙으므로 끝 위치가 아니라 제목 안(앞 문단 크기 7 + 2)을 고른다.
    editor.commands.setTextSelection(9);
    fireEvent.click(screen.getByTestId("align-format-menu"));
    fireEvent.click(screen.getByText(t("editor.align_justify")));
    expect(editor.getAttributes("heading").textAlign).toBe("justify");
    fireEvent.click(screen.getByTestId("align-format-menu"));
    expect(screen.getByText(t("editor.align_justify")).getAttribute("aria-checked")).toBe("true");
    editor.destroy();
  });

  it("toggles inline code and clears inline marks without changing the paragraph", () => {
    const editor = makeEditor("<p><strong>hello</strong> world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <>
        <InlineCodeButton editor={editor} />
        <ClearFormattingButton editor={editor} />
      </>,
    );

    fireEvent.click(screen.getByTitle(t("editor.code_inline")));
    expect(editor.isActive("code")).toBe(true);

    fireEvent.click(screen.getByTestId("clear-formatting"));
    expect(editor.isActive("code")).toBe(false);
    expect(editor.isActive("bold")).toBe(false);
    expect(editor.isActive("paragraph")).toBe(true);
    editor.destroy();
  });

  it("regression: Clear Formatting also reverts blockquote and codeBlock, not just marks", () => {
    // Owner report: "clear formatting undoes the basics but doesn't properly undo code/blockquote
    // state." Root cause: ClearFormattingButton's chain only ever unset MARKS (bold/italic/.../
    // link) — blockquote and codeBlock are NODE types, so neither was touched and both survived.
    // Combined case (blockquote wrapping a bold run), not just the isolated node states, so an
    // ordering regression between the mark-unsets and clearNodes() would also be caught here.
    const editor = makeEditor("<blockquote><p><strong>hello</strong></p></blockquote>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.isActive("blockquote")).toBe(true);
    expect(editor.isActive("bold")).toBe(true);

    render(<ClearFormattingButton editor={editor} />);
    fireEvent.click(screen.getByTestId("clear-formatting"));

    expect(editor.isActive("blockquote")).toBe(false);
    expect(editor.isActive("bold")).toBe(false);
    expect(editor.isActive("paragraph")).toBe(true);
    editor.destroy();
  });

  it("regression: Clear Formatting reverts a codeBlock back to a normal paragraph", () => {
    const editor = makeEditor();
    editor.chain().focus().toggleCodeBlock().run();
    expect(editor.isActive("codeBlock")).toBe(true);

    render(<ClearFormattingButton editor={editor} />);
    fireEvent.click(screen.getByTestId("clear-formatting"));

    expect(editor.isActive("codeBlock")).toBe(false);
    expect(editor.isActive("paragraph")).toBe(true);
    editor.destroy();
  });

  it("changes a block and can return it to a normal paragraph", () => {
    const editor = makeEditor();
    render(<BlockFormatMenu editor={editor} />);

    fireEvent.click(screen.getByTestId("block-format-menu"));
    fireEvent.click(screen.getByText(t("editor.blockquote")));
    expect(editor.isActive("blockquote")).toBe(true);

    fireEvent.click(screen.getByTestId("block-format-menu"));
    fireEvent.click(screen.getByText(t("editor.normal")));
    expect(editor.isActive("blockquote")).toBe(false);
    expect(editor.isActive("paragraph")).toBe(true);
    editor.destroy();
  });

  it("renders trigger buttons with toolbar-btn and toolbar-btn--text classes and without field-select", () => {
    const editor = makeEditor();
    render(
      <>
        <ParagraphFormatMenu editor={editor} />
        <BlockFormatMenu editor={editor} />
      </>,
    );

    const paragraphTrigger = screen.getByTestId("paragraph-format-menu");
    const blockTrigger = screen.getByTestId("block-format-menu");

    expect(paragraphTrigger.className).toContain("toolbar-btn");
    expect(paragraphTrigger.className).toContain("toolbar-btn--text");
    expect(paragraphTrigger.className).not.toContain("field-select");

    expect(blockTrigger.className).toContain("toolbar-btn");
    expect(blockTrigger.className).toContain("toolbar-btn--text");
    expect(blockTrigger.className).not.toContain("field-select");
    editor.destroy();
  });

  it("renders exactly 1 chevron svg inside the trigger button", () => {
    const editor = makeEditor();
    render(
      <>
        <ParagraphFormatMenu editor={editor} />
        <BlockFormatMenu editor={editor} />
      </>,
    );

    const paragraphTrigger = screen.getByTestId("paragraph-format-menu");
    const blockTrigger = screen.getByTestId("block-format-menu");

    expect(paragraphTrigger.querySelectorAll("svg")).toHaveLength(1);
    expect(blockTrigger.querySelectorAll("svg")).toHaveLength(1);
    editor.destroy();
  });
});
