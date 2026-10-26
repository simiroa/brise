import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, useEditorState } from "@tiptap/react";
import { t } from "../../../i18n/t";
import { useFloatingPopover } from "../../../lib/ui";
import { markCoverageRatio, markPressFromRatio } from "./markCoverage";
import { ToolbarButton, ToolbarDropdownTrigger, type ToolbarPress } from "../../common/toolbar";
import { IconCode, IconClearFormat } from "../../icons";
import { TEXT_ALIGNS } from "../paragraphFormat";
import { FluidHoverHighlight, useFluidHover } from "../../common/FluidHover";

type Editor = NonNullable<ReturnType<typeof useEditor>>;

type MenuItem = {
  key: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
};

function ToolbarMenu({
  label,
  items,
  testid,
}: {
  label: string;
  items: MenuItem[];
  testid: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { anchorRef, popRef, x, y } = useFloatingPopover(open, close);
  const hover = useFluidHover(popRef, { axis: "y" });
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, popRef]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (!buttons.length) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      buttons[next].focus();
    }
  };

  return (
    <div ref={anchorRef} style={{ display: "inline-flex" }}>
      <ToolbarDropdownTrigger
        ref={triggerRef}
        testid={testid}
        label={label}
        open={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && createPortal(
        <div
          ref={popRef}
          className="overlay fh-host"
          role="menu"
          data-editor-pop=""
          data-testid={`${testid}-menu`}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "fixed",
            left: x,
            top: y,
            zIndex: "var(--z-dropdown)",
            minWidth: 170,
            padding: "var(--space-1)",
            boxShadow: "var(--shadow-lg)",
          }}
          {...hover.handlers}
        >
          <FluidHoverHighlight hover={hover} />
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className="menu-row menu-item"
              role="menuitemcheckbox"
              aria-checked={item.active ?? false}
              data-selected={item.active || undefined}
              disabled={item.disabled}
              onClick={() => {
                item.run();
                close();
              }}
              style={{ color: item.danger ? "var(--danger)" : "inherit" }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function ParagraphFormatMenu({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const heading = ([1, 2, 3] as const).find((level) => ed.isActive("heading", { level }));
      const inTaskList = ed.isActive("taskList");
      const inList = inTaskList || ed.isActive("bulletList") || ed.isActive("orderedList");
      const attrs = heading ? ed.getAttributes("heading") : ed.getAttributes("paragraph");
      return {
        kind: heading ? `h${heading}` : "p",
        indent: Number(attrs.indent) || 0,
        inTaskList,
        inList,
        formatAllowed: !inList && !ed.isActive("blockquote") && !ed.isActive("codeBlock"),
      };
    },
  });

  const setListDepth = (direction: "in" | "out") => {
    const item = state.inTaskList ? "taskItem" : "listItem";
    const chain = editor.chain().focus();
    if (direction === "in") chain.sinkListItem(item).run();
    else chain.liftListItem(item).run();
  };

  const items: MenuItem[] = [
    { key: "p", label: t("editor.normal"), active: state.kind === "p", disabled: !state.formatAllowed, run: () => editor.chain().focus().setParagraph().run() },
    ...([1, 2, 3] as const).map((level): MenuItem => ({
      key: `h${level}`,
      label: t(`editor.heading_${level}`),
      active: state.kind === `h${level}`,
      disabled: !state.formatAllowed,
      run: () => editor.chain().focus().setHeading({ level }).run(),
    })),
    {
      key: "outdent",
      label: t("editor.outdent"),
      disabled: state.inList ? false : !state.formatAllowed || state.indent === 0,
      run: () => state.inList ? setListDepth("out") : editor.chain().focus().outdentParagraph().run(),
    },
    {
      key: "indent",
      label: t("editor.indent"),
      disabled: state.inList ? false : !state.formatAllowed || state.indent >= 6,
      run: () => state.inList ? setListDepth("in") : editor.chain().focus().indentParagraph().run(),
    },
  ];

  return <ToolbarMenu label={t("editor.paragraph_menu")} items={items} testid="paragraph-format-menu" />;
}

/**
 * 정렬은 문단 메뉴에서 떨어져 나온 별개 축이다(오너, 2026-09-09): 문단 메뉴가 "이 블록이
 * 무엇인가"(본문/제목 1~3)와 "들여쓰기"를 정하는 데 반해 정렬은 그 블록을 **어디에 놓을지**를
 * 정한다 — 한 드롭다운에 섞여 있으면 제목 고르러 연 메뉴에서 정렬이 같은 목록에 끼어 보인다.
 * 판정(어떤 블록에 정렬이 허용되는가)은 문단 메뉴와 같은 규칙을 쓴다: 목록·인용·코드블록은 제외.
 */
export function AlignFormatMenu({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const heading = ([1, 2, 3] as const).find((level) => ed.isActive("heading", { level }));
      const attrs = heading ? ed.getAttributes("heading") : ed.getAttributes("paragraph");
      return {
        textAlign: (attrs.textAlign as string) || "left",
        allowed:
          !ed.isActive("taskList") &&
          !ed.isActive("bulletList") &&
          !ed.isActive("orderedList") &&
          !ed.isActive("blockquote") &&
          !ed.isActive("codeBlock"),
      };
    },
  });

  const items: MenuItem[] = TEXT_ALIGNS.map((alignment) => ({
    key: `align-${alignment}`,
    label: t(`editor.align_${alignment}`),
    active: state.textAlign === alignment,
    disabled: !state.allowed,
    run: () => editor.chain().focus().setTextAlign(alignment).run(),
  }));

  return <ToolbarMenu label={t("editor.align_menu")} items={items} testid="align-format-menu" />;
}

export function BlockFormatMenu({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      blockquote: ed.isActive("blockquote"),
      codeBlock: ed.isActive("codeBlock"),
      bulletList: ed.isActive("bulletList"),
      orderedList: ed.isActive("orderedList"),
      taskList: ed.isActive("taskList"),
    }),
  });

  const items: MenuItem[] = [
    {
      key: "paragraph",
      label: t("editor.normal"),
      active: !Object.values(active).some(Boolean),
      run: () => editor.chain().focus().clearNodes().run(),
    },
    { key: "blockquote", label: t("editor.blockquote"), active: active.blockquote, run: () => editor.chain().focus().toggleBlockquote().run() },
    { key: "codeBlock", label: t("editor.code_block"), active: active.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
    { key: "bulletList", label: t("editor.bullet_list"), active: active.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
    { key: "orderedList", label: t("editor.ordered_list"), active: active.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: "taskList", label: t("editor.task"), active: active.taskList, run: () => editor.chain().focus().toggleTaskList().run() },
  ];

  return <ToolbarMenu label={t("editor.block_menu")} items={items} testid="block-format-menu" />;
}

export function InlineCodeButton({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }): ToolbarPress => {
      const { from, to, empty } = ed.state.selection;
      if (empty) return ed.isActive("code");
      const state = markPressFromRatio(markCoverageRatio(ed.state.doc, from, to, "code"));
      return state === "partial" ? "mixed" : state === "on";
    },
  });

  return (
    <ToolbarButton title={t("editor.code_inline")} active={active} onClick={() => editor.chain().focus().toggleCode().run()}>
      <IconCode size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

export function ClearFormattingButton({ editor }: { editor: Editor }) {
  // Bug fix: this chain used to only unset MARKS (bold/italic/.../link) — codeBlock and
  // blockquote are NODE types (StarterKit's Blockquote, CodeBlockLowlight/CodeBlockWithCopy —
  // see editorExtensions.ts), so neither was ever touched and both survived "clear formatting"
  // untouched (owner report: basic marks clear, code/blockquote state doesn't). clearNodes()
  // normalizes every node in the selection back to a plain paragraph (BlockFormatMenu's own
  // "일반 문단" item above already relies on it for the same blockquote/codeBlock/list cases —
  // see its "changes a block and can return it to a normal paragraph" test). Appended last, after
  // the mark unsets, matching TipTap's own clear-formatting recipe: marks resolve against the
  // pre-lift positions, so unsetting them first avoids the node lift remapping positions out from
  // under a mark command still queued in the same chain.
  const clear = () => editor.chain().focus()
    .unsetBold()
    .unsetItalic()
    .unsetUnderline()
    .unsetStrike()
    .unsetHighlight()
    .unsetColor()
    .unsetCode()
    .unsetLink()
    .clearNodes()
    .run();

  return (
    <ToolbarButton
      testid="clear-formatting"
      title={t("editor.clear_formatting")}
      onClick={clear}
    >
      <IconClearFormat size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}
