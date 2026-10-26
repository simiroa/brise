import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import {
  ColorButton, LinkButton, TableButton,
  BoldButton, ItalicButton, StrikeButton, UnderlineButton,
  UndoButton, RedoButton,
  HighlightButton,
} from "./buttons";
import { t } from "../../../i18n/t";

// Bug: ColorButton/LinkButton's popovers used to render `position: absolute` inside their own
// trigger wrapper. That wrapper sits inside a `.overlay` ancestor (the selection BubbleMenu,
// TextBubbleMenu.tsx) or the fixed toolbar's `overflow-x:auto` row in the real app — `.overlay`
// sets `overflow: hidden` (tokens.css SINGLE-SHEET ACRYLIC CONTRACT), so the popover was clipped
// to zero visible/clickable area, which is why picking a color silently did nothing and the link
// popover was unreachable. Fix: portal to <body> (useFloatingPopover in popover.ts), same
// pattern as EmojiPicker.tsx. These tests assert the popover actually lands outside any clipping
// ancestor, and that the underlying command still runs once it's reachable.

function makeEditor(content = "<p>hello world</p>") {
  return new TiptapEditor({
    extensions: [StarterKit, TextStyle, Color, Link.configure({ openOnClick: false })],
    content,
  });
}

afterEach(() => cleanup());

describe("ColorButton popover escapes clipping ancestors", () => {
  it("portals the swatch popover to document.body, not the overflow:hidden wrapper", () => {
    const editor = makeEditor();
    const { container } = render(
      <div className="overlay" style={{ overflow: "hidden", height: 10 }}>
        <ColorButton editor={editor} />
      </div>
    );
    fireEvent.click(screen.getByTitle(t("editor.text_color")));
    // Not a descendant of the clipping wrapper (would be invisible/unclickable there)...
    const clippingWrapper = container.querySelector(".overlay") as HTMLElement;
    expect(clippingWrapper.querySelector('[role="dialog"]')).toBeNull();
    // ...portalled straight onto <body> instead.
    const dialog = screen.getByRole("dialog", { name: t("editor.text_color") });
    expect(dialog.parentElement).toBe(document.body);
    editor.destroy();
  });

  it("clicking a swatch (now reachable) actually sets the color mark on the selection", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    render(<ColorButton editor={editor} />);
    fireEvent.click(screen.getByTitle(t("editor.text_color")));
    const dialog = screen.getByRole("dialog", { name: t("editor.text_color") });
    const swatch = dialog.querySelector("button") as HTMLElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    expect(editor.getAttributes("textStyle").color).toBeTruthy();
    editor.destroy();
  });
});

describe("LinkButton popover escapes clipping ancestors", () => {
  it("gives icon-only toolbar controls an accessible name", () => {
    const editor = makeEditor();
    render(<BoldButton editor={editor} />);
    expect(screen.getByRole("button", { name: t("editor.bold") })).toBeTruthy();
    editor.destroy();
  });

  it("portals the URL input to document.body, not the overflow:hidden wrapper", () => {
    const editor = makeEditor();
    const { container } = render(
      <div className="overlay" style={{ overflow: "hidden", height: 10 }}>
        <LinkButton editor={editor} />
      </div>
    );
    fireEvent.click(screen.getByTitle(t("editor.link")));
    const clippingWrapper = container.querySelector(".overlay") as HTMLElement;
    expect(clippingWrapper.querySelector('[role="dialog"]')).toBeNull();
    const dialog = screen.getByRole("dialog", { name: t("editor.link") });
    expect(dialog.parentElement).toBe(document.body);
    editor.destroy();
  });

  it("applying a URL (now reachable) sets the link mark", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    render(<LinkButton editor={editor} />);
    fireEvent.click(screen.getByTitle(t("editor.link")));
    const dialog = screen.getByRole("dialog", { name: t("editor.link") });
    const urlInput = within(dialog).getByPlaceholderText(t("editor.link_placeholder"));
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    fireEvent.click(within(dialog).getByText(t("editor.link_apply")));
    expect(editor.isActive("link")).toBe(true);
    editor.destroy();
  });

  it("labels link fields and blocks an invalid URL with inline feedback", () => {
    const editor = makeEditor();
    render(<LinkButton editor={editor} />);
    fireEvent.click(screen.getByRole("button", { name: t("editor.link") }));
    const dialog = screen.getByRole("dialog", { name: t("editor.link") });
    const urlInput = within(dialog).getByRole("textbox", { name: t("editor.link_url_label") });
    const apply = within(dialog).getByRole("button", { name: t("editor.link_apply") });

    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(urlInput, { target: { value: "not a url" } });
    expect(within(dialog).getByRole("alert").textContent).toBe(t("editor.link_invalid"));
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(editor.isActive("link")).toBe(false);
    editor.destroy();
  });

  // Owner QA 6, item 5: applies to the range captured when the popover opened, not whatever
  // editor.state.selection happens to be by the time apply() runs — the popover's inputs live
  // outside the editor's own DOM, so anything that moves the live selection while they have
  // focus must not steer the link onto the wrong text.
  it("applies the link to the range captured at open time, not wherever the live selection drifted to while the popover was open", () => {
    const editor = makeEditor(); // "<p>hello world</p>"
    editor.commands.setTextSelection({ from: 1, to: 6 }); // selects "hello"
    render(<LinkButton editor={editor} />);
    fireEvent.click(screen.getByTitle(t("editor.link")));
    const dialog = screen.getByRole("dialog", { name: t("editor.link") });

    // Simulate the live selection drifting away from what was captured, while the popover is
    // still open (e.g. some other code path touches the selection during the interaction).
    editor.commands.setTextSelection({ from: 7, to: 12 }); // "world"

    const urlInput = within(dialog).getByPlaceholderText(t("editor.link_placeholder"));
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    fireEvent.click(within(dialog).getByText(t("editor.link_apply")));

    let helloHasLink = false;
    let worldHasLink = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const hasLink = node.marks.some((m) => m.type.name === "link");
      if (node.text === "hello") helloHasLink = hasLink;
      if (node.text === "world") worldHasLink = hasLink;
    });
    expect(helloHasLink).toBe(true);
    expect(worldHasLink).toBe(false);
    editor.destroy();
  });
});

// Owner QA 6, item 1: every bubble/popover was frozen in place while the editor's inner
// `.scroll` container scrolled underneath it (the popover only ever measured its anchor once, at
// open time). Fix: useFloatingPopover now re-measures on ANY scroll in the document (capture
// phase — scroll doesn't bubble, so this is the standard "catch it regardless of which nested
// container scrolled" technique) instead of once on open.
describe("useFloatingPopover (LinkButton/ColorButton) tracks its anchor across scroll — item 1", () => {
  it("repositions the popup after the anchor's screen position changes and a scroll event fires", () => {
    const editor = makeEditor();
    let anchorTop = 100;
    const originalGetRect = HTMLElement.prototype.getBoundingClientRect;
    // Stubs every element's rect the same way — good enough here since the only rect this test
    // reads is the popover trigger's own anchor wrapper.
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        top: anchorTop, left: 10, bottom: anchorTop + 20, right: 110,
        width: 100, height: 20, x: 10, y: anchorTop, toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      render(<LinkButton editor={editor} />);
      fireEvent.click(screen.getByTitle(t("editor.link")));
      const dialog = screen.getByRole("dialog", { name: t("editor.link") });
      const topBeforeScroll = dialog.style.top;

      // Simulate the anchor having scrolled to a new screen position, then fire the scroll event
      // any nested scroll container would dispatch — document-level capture-phase listening
      // means the test doesn't need to know exactly which element scrolled.
      anchorTop = 500;
      fireEvent.scroll(document.body);

      expect(dialog.style.top).not.toBe(topBeforeScroll);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetRect;
      editor.destroy();
    }
  });
});

// Owner QA 6, item 3: Bold/Italic/Underline/Strike must show a pressed style AND update on a
// PURE selection change (moving the caret, no doc edit) — the bug was that EditorPanel doesn't
// force a re-render on plain transactions (useEditor's shouldRerenderOnTransaction defaults off),
// so the old inline `active={editor.isActive("bold")}` JSX only refreshed by accident, whenever
// some unrelated state happened to re-render the whole panel. Each button now owns its own
// useEditorState subscription instead.
describe("BoldButton/ItalicButton/StrikeButton/UnderlineButton — active state (owner QA 6, item 3)", () => {
  function makeMarkEditor() {
    return new TiptapEditor({
      extensions: [StarterKit],
      content: "<p><strong><em><s><u>styled</u></s></em></strong> plain</p>",
    });
  }

  it.each([
    ["bold", BoldButton, "editor.bold"],
    ["italic", ItalicButton, "editor.italic"],
    ["strike", StrikeButton, "editor.strikethrough"],
    ["underline", UnderlineButton, "editor.underline"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as [string, (props: { editor: TiptapEditor }) => any, string][])(
    "%s button: aria-pressed + data-active reflect isActive and update on a pure selection change",
    (markName, Button, titleKey) => {
      const editor = makeMarkEditor();
      render(<Button editor={editor} />);
      const btn = screen.getByTitle(t(titleKey));

      // Caret starts inside the marked run (content is fully wrapped) — active.
      act(() => {
        editor.commands.setTextSelection(3);
      });
      expect(editor.isActive(markName)).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.getAttribute("data-active")).toBe("true");

      // Move the caret into the trailing "plain" text — no doc edit, pure selection change —
      // and the button must still reflect the new (inactive) state.
      act(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size - 2);
      });
      expect(editor.isActive(markName)).toBe(false);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("data-active")).toBe("false");

      editor.destroy();
    }
  );

  it("a non-toggle ToolbarButton (no `active` prop) omits aria-pressed entirely", () => {
    const editor = makeMarkEditor();
    // TableButton never passes `active` — it's an action (insert a table), not a toggle.
    render(<TableButton editor={editor} />);
    const btn = screen.getByTitle(t("editor.table_insert"));
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
    editor.destroy();
  });
});

// QA8 1A: mark buttons report tri-state (on / partial=mixed / off) based on coverage ratio,
// and re-subscribe via useEditorState so pure selection moves update the pressed state.
describe("mark tri-state (QA8 1A) — bold / highlight / code", () => {
  function makeBoldHalfEditor() {
    return new TiptapEditor({
      extensions: [StarterKit],
      content: "<p><strong>bold</strong>plain</p>",
    });
  }

  function makeHighlightHalfEditor() {
    return new TiptapEditor({
      extensions: [StarterKit, Highlight],
      content: "<p><mark>high</mark>plain</p>",
    });
  }

  it("BoldButton: full selection → on; half → mixed; none → off", () => {
    const editor = makeBoldHalfEditor();
    render(<BoldButton editor={editor} />);
    const btn = screen.getByTitle(t("editor.bold"));

    // Full bold run only ("bold" is [1,5])
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("data-active")).toBe("true");

    // Half bold: select bold+plain
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 10 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("mixed");
    expect(btn.getAttribute("data-active")).toBe("partial");

    // None: plain only ("plain" starts at 5)
    act(() => {
      editor.commands.setTextSelection({ from: 5, to: 10 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("data-active")).toBe("false");

    editor.destroy();
  });

  it("HighlightButton: full → on; half → mixed; none → off", () => {
    const editor = makeHighlightHalfEditor();
    render(<HighlightButton editor={editor} />);
    const btn = screen.getByTitle(t("editor.highlight"));

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("data-active")).toBe("true");

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 10 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("mixed");
    expect(btn.getAttribute("data-active")).toBe("partial");

    act(() => {
      editor.commands.setTextSelection({ from: 5, to: 10 });
    });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("data-active")).toBe("false");

    editor.destroy();
  });

});

// Wave 2 L2 — toolbar composition / order. Source contracts (not full EditorPanel mount): the
// selection bubble is marks-only, and the fixed trailing cluster is 넓게보기 → 맞춤법 → 마이크 → AI.
describe("Wave 2 L2 toolbar composition", () => {
  // Strip line/block comments so composition asserts don't false-positive on prose.
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("TextBubbleMenu mounts inline code + block menu + clear formatting without color/link/clipboard clutter", async () => {
    const { readFileSync } = await import("node:fs");
    const src = stripComments(readFileSync("src/components/editor/toolbar/TextBubbleMenu.tsx", "utf8"));
    // Allowed controls (import + JSX)
    expect(src).toMatch(/HeadingStepButtons/);
    expect(src).toMatch(/BoldButton/);
    expect(src).toMatch(/ItalicButton/);
    expect(src).toMatch(/UnderlineButton/);
    expect(src).toMatch(/StrikeButton/);
    expect(src).toMatch(/HighlightButton/);
    expect(src).toMatch(/InlineCodeButton/);
    expect(src).toMatch(/BlockFormatMenu/);
    expect(src).toMatch(/ClearFormattingButton/);
    // Color/link remain on the fixed toolbar.
    expect(src).not.toMatch(/ColorButton/);
    expect(src).not.toMatch(/LinkButton/);
    expect(src).not.toMatch(/IconCopy|IconCut|IconPaste/);
    expect(src).not.toMatch(/ParagraphStyleSelect/);
  });

  it("FixedToolbar replaces duplicate paragraph style/step controls with paragraph + block menus", async () => {
    const { readFileSync } = await import("node:fs");
    const src = stripComments(readFileSync("src/components/editor/toolbar/FixedToolbar.tsx", "utf8"));
    expect(src).toMatch(/ParagraphFormatMenu/);
    expect(src).toMatch(/BlockFormatMenu/);
    expect(src).not.toMatch(/ParagraphStyleSelect/);
    expect(src).not.toMatch(/HeadingStepButtons/);
  });

  it("FixedToolbar trailing cluster order is full-width → spellcheck, with no AI entry", async () => {
    const { readFileSync } = await import("node:fs");
    const src = stripComments(readFileSync("src/components/editor/toolbar/FixedToolbar.tsx", "utf8"));
    const trailingStart = src.indexOf('data-testid="fixed-toolbar-trailing"');
    expect(trailingStart).toBeGreaterThan(-1);
    const trailing = src.slice(trailingStart);
    const fullWidth = trailing.indexOf("editor.full_width_toggle");
    const spell = trailing.indexOf("SpellcheckToggle");
    expect(fullWidth).toBeGreaterThan(-1);
    expect(spell).toBeGreaterThan(fullWidth);
    // 2026-09-26: AI 진입점은 노트 제목 줄(☆ 옆) 한 곳 — 섹션 툴바엔 두지 않는다.
    expect(src).not.toMatch(/AiActionsMenu/);
    // Dictation removed; translate is an AI-menu action — no TranslateControl/DictateControl import/JSX.
    expect(src).not.toMatch(/DictateControl/);
    expect(src).not.toMatch(/TranslateControl/);
  });
});

// Bug (실사용 리포트): 패널이 통째로 "컴포넌트를 불러오지 못했습니다 / Cannot read properties of
// null (reading 'can')" 로 바뀌는 일이 가끔 있었다. TipTap v3 의 Editor.destroy() 는
// `this.commandManager = null` 로 비우는데, useEditorState 셀렉터 중 commandManager 를 타는 것은
// UndoButton/RedoButton 의 `ed.can()` 하나뿐이다 — isActive/state 계열은 unmount 후에도 마지막
// editorState 를 계속 읽어(core 의 `get state()`) 조용히 살아남는다. useEditorState 의 스냅샷은
// 레이아웃 이펙트에서만 갱신되므로 파괴된 인스턴스로 렌더가 한 번 더 도는 창이 있고, 그때
// 렌더 도중 throw → EditorPanel 을 감싼 App.tsx 의 ErrorBoundary 가 패널 전체를 대체한다.
// EditorPanel.tsx / SectionPreview.tsx 가 `.commands` 앞에 두는 isDestroyed 가드와 같은 이유.
describe("undo/redo survive a destroyed editor instance", () => {
  it("does not throw when re-rendered with an already-destroyed editor", () => {
    const editor = makeEditor();
    const { rerender } = render(
      <>
        <UndoButton editor={editor} />
        <RedoButton editor={editor} />
      </>
    );
    editor.destroy();
    expect(() =>
      rerender(
        <>
          <UndoButton editor={editor} />
          <RedoButton editor={editor} />
        </>
      )
    ).not.toThrow();
    // 파괴된 인스턴스에서는 실행할 수 있는 것이 없으므로 둘 다 비활성.
    expect(screen.getByTestId("editor-undo").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("editor-redo").hasAttribute("disabled")).toBe(true);
  });
});
