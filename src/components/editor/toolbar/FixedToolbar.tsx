import { useEditor } from "@tiptap/react";
import { t } from "../../../i18n/t";
import { useToolbarRovingFocus } from "../../common/useToolbarRovingFocus";
import { useSettingsStore } from "../../../stores/settings";
import { IconChevronsExpand, IconChevronsCollapse } from "../../icons";
import { EmojiPicker } from "../EmojiPicker";
import { SpellcheckToggle } from "../SpellcheckToggle";
import { ToolbarDivider, ToolbarButton } from "../../common/toolbar";
import {
  UndoButton, RedoButton,
  BoldButton, ItalicButton, UnderlineButton, StrikeButton,
  HighlightButton, ColorButton, LinkButton, ImageButton, TableButton,
} from "./buttons";
import { AlignFormatMenu, BlockFormatMenu, ParagraphFormatMenu, InlineCodeButton, ClearFormattingButton } from "./FormatMenus";

/**
 * Fixed top toolbar row. Left cluster: undo/redo + formatting (paragraph style + marks + inserts).
 * Right cluster, left→right: 넓게보기 · 맞춤법검사.
 * AI 진입점은 섹션 툴바에 두지 않는다 — 노트 제목 줄(TitleBar, ☆ 옆)에 늘 한 곳(2026-09-26 오너
 * 결정: 노트 단위 AI 요청이라 섹션 종류와 무관하게 같은 자리, 툴바 공간도 확보). 번역도 그 메뉴의 액션이다.
 */
export function FixedToolbar({
  editor,
  noteId,
  sectionRef,
  editorFullWidth,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
  noteId: string;
  sectionRef: { current: { id: string } | null };
  editorFullWidth: boolean;
}) {
  const roving = useToolbarRovingFocus<HTMLDivElement>();

  return (
    <div
      className="scroll noscroll section-toolbar"
      data-testid="fixed-toolbar"
      role="toolbar"
      aria-label={t("editor.text_toolbar")}
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      style={{ justifyContent: "space-between", gap: "var(--space-3)", overflowX: "auto" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        <UndoButton editor={editor} />
        <RedoButton editor={editor} />
        <ToolbarDivider />
        <ParagraphFormatMenu editor={editor} />
        <AlignFormatMenu editor={editor} />
        <BlockFormatMenu editor={editor} />
        <ToolbarDivider />
        <BoldButton editor={editor} />
        <ItalicButton editor={editor} />
        <UnderlineButton editor={editor} />
        <StrikeButton editor={editor} />
        <InlineCodeButton editor={editor} />
        <ClearFormattingButton editor={editor} />
        <ToolbarDivider />
        <HighlightButton editor={editor} />
        <ColorButton editor={editor} />
        <ToolbarDivider />
        <EmojiPicker editor={editor} />
        <LinkButton editor={editor} />
        <ImageButton editor={editor} noteId={noteId} sectionRef={sectionRef} />
        <TableButton editor={editor} />
      </div>
      <div
        data-testid="fixed-toolbar-trailing"
        style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}
      >
        <ToolbarButton
          title={t("editor.full_width_toggle")}
          active={editorFullWidth}
          onClick={() => void useSettingsStore.getState().setEditorFullWidth(!editorFullWidth)}
        >
          {editorFullWidth ? <IconChevronsCollapse size={15} strokeWidth={2} /> : <IconChevronsExpand size={15} strokeWidth={2} />}
        </ToolbarButton>
        <SpellcheckToggle editor={editor} />
      </div>
    </div>
  );
}
