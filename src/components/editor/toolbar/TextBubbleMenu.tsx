import { useEffect, useState } from "react";
import { useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { posToDOMRect } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import type { RectComputer } from "../stableAnchor";
import {
  ToolbarDivider, HeadingStepButtons, ToolbarButton,
  BoldButton, ItalicButton, StrikeButton, UnderlineButton,
  HighlightButton,
} from "./buttons";
import { BlockFormatMenu, ClearFormattingButton, InlineCodeButton } from "./FormatMenus";
import { applyFootnoteFromSelection, buildFootnoteAssistActions } from "../footnoteMark";
import { PromptDialog } from "../../PromptDialog";
import { IconAsterisk } from "../../icons";
import { useAiStore } from "../../../stores/ai";
import { t } from "../../../i18n/t";

/** 스크롤 지문 — see ImageBubble.tsx's identical helper for the full writeup. Kept as a separate
 *  per-file copy rather than a shared import (same tradeoff as isInsertStillOnTarget/
 *  isPasteStillOnTarget elsewhere in this codebase). */
function viewportEpochOf(editor: { view: { dom: HTMLElement } }): number {
  return Math.round(editor.view.dom.getBoundingClientRect().top);
}

/**
 * Selection mini-toolbar — appendTo/strategy "fixed" instead of the tiptap default (positioned
 * relative to the editor's parent, "absolute") because that parent sits inside a backdrop-filter
 * ancestor in acrylic mode, which creates a containing block for fixed descendants and would
 * otherwise clip/mis-position this against the scroll container instead of the viewport (same
 * reasoning as EditorPanel.tsx's sectionCtx/ContextMenu menus).
 *
 * Wave 2 L2: selection bubble is marks-only — size step + B I U S + highlight.
 * Wave 4 L2: + footnote affordance (does not replace any of the above).
 * Font-family / color / code / link / clipboard live on the fixed toolbar (or OS shortcuts).
 */
export function TextBubbleMenu({
  editor,
  scrollEl,
  textAnchorRef,
  hideForOtherUi,
  // Clipboard handlers stay on the props contract so EditorPanel.tsx (caller, not owned this
  // wave) does not need a simultaneous prop-list change. Unused after L2 slim-down.
  copySelection: _copySelection,
  cutSelection: _cutSelection,
  pasteSelection: _pasteSelection,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
  // N1-3: see ImageBubble.tsx — same scrollTarget wiring, same reason.
  scrollEl: HTMLElement | null;
  // N1-2: selection BubbleMenu anchor — (from,to) 가 그대로인 문서 변경(굵게/제목 토글)에는 rect 를
  // 다시 묻지 않는다(stableAnchor.ts 참고). EditorPanel이 소유·리셋하는 ref를 그대로 받는다(노트/
  // 섹션 전환 시 다른 문서를 가리키게 되는 사고를 막기 위해 그쪽에서 재생성한다). Structural ref
  // type (not React.MutableRefObject) so this doesn't depend on which exact ref type useRef()
  // returns in this React version.
  textAnchorRef: { current: (from: number, to: number, compute: RectComputer, viewportEpoch?: number) => DOMRect };
  // 렌더링/모달/다른 컨텍스트 메뉴가 열려 있는 동안은 숨긴다 — EditorPanel이 renamingId/
  // pendingDelete/sectionCtx/selCtx/aiAskCtx를 한데 묶어 넘긴다(우클릭 "AI에게 요청하기"가 연
  // PromptDialog가 떠 있는 동안: selCtx는 이미 null이지만 선택 자체는 여전히 살아있으므로 이
  // 가드가 없으면 다이얼로그 뒤에서 툴바가 다시 튀어나온다).
  hideForOtherUi: boolean;
  copySelection: () => void | Promise<void>;
  cutSelection: () => void | Promise<void>;
  pasteSelection: () => void | Promise<void>;
}) {
  // Footnote body prompt — capture from/to at open so the range stays stable while the dialog
  // is open (same posture as SelectionContextMenu's aiAskCtx / footnoteCtx).
  const [footnoteCtx, setFootnoteCtx] = useState<{ from: number; to: number } | null>(null);

  // Footnote dialog's 번역/설명 quick actions gate on the same translate-gate flag every other AI
  // entry point uses (stores/ai.ts's translateGateOk) — refreshed once on mount so it's ready by
  // the time the dialog opens, same posture as PresetList's ensureAiReachable() mount effect.
  const translateGateOk = useAiStore((s) => s.translateGateOk);
  useEffect(() => {
    void useAiStore.getState().refreshTranslateGate();
  }, []);

  const openFootnote = () => {
    const { from, to } = editor.state.selection;
    if (from === to) return;
    if (!editor.state.doc.textBetween(from, to, " ").trim()) return;
    setFootnoteCtx({ from, to });
  };

  return (
    <>
      <BubbleMenu
        editor={editor}
        appendTo={() => document.body}
        // N1-3: see ImageBubble.tsx's identical comment — same scrollTarget fix, same reason.
        options={{ strategy: "fixed", placement: "top", offset: 8, scrollTarget: scrollEl ?? undefined }}
        shouldShow={({ editor: ed, element, view, state, from, to }) => {
          const { selection } = state;
          if (selection.empty || selection instanceof NodeSelection || ed.isActive("image")) return false;
          if (!state.doc.textBetween(from, to, " ").trim().length) return false;
          // LinkButton/ColorButton's own popovers (buttons.tsx) are portalled straight to <body>
          // now (popover.ts's useFloatingPopover — escapes this BubbleMenu's `.overlay{overflow:
          // hidden}`, see that file). Fixed toolbar still mounts ColorButton; if a bubble ever
          // re-gains a portalled popover, `[data-editor-pop]` keeps focus counted as "in menu".
          const activeEl = document.activeElement;
          const isChildOfMenu = element.contains(activeEl) || !!(activeEl as HTMLElement | null)?.closest?.("[data-editor-pop]");
          if (!(view.hasFocus() || isChildOfMenu) || !ed.isEditable) return false;
          if (hideForOtherUi) return false;
          // Footnote PromptDialog open — hide bubble while it owns focus (also covered by
          // hasFocus loss, but keep explicit so the menu doesn't flicker on dialog dismiss).
          if (footnoteCtx) return false;
          return true;
        }}
        // N1-2: stable anchor — reuses the last rect while (from,to) is unchanged, so toggling
        // bold/heading/etc. on the SAME selection doesn't nudge the menu. A real selection change
        // still recomputes normally.
        getReferencedVirtualElement={() => {
          const { from, to } = editor.state.selection;
          const rect = textAnchorRef.current(from, to, () => posToDOMRect(editor.view, from, to), viewportEpochOf(editor));
          return { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
        }}
        className="overlay"
        data-testid="text-bubble-menu"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2xs)",
          padding: 4,
          borderRadius: "var(--radius-pill)", // 가로 툴바형 — 외곽선·배경은 .overlay 레시피
          boxShadow: "var(--shadow-lg)",
          zIndex: "var(--z-dropdown)",
        }}
      >
        <HeadingStepButtons editor={editor} />
        <ToolbarDivider />
        <BoldButton editor={editor} />
        <ItalicButton editor={editor} />
        <UnderlineButton editor={editor} />
        <StrikeButton editor={editor} />
        <ToolbarDivider />
        <HighlightButton editor={editor} />
        <InlineCodeButton editor={editor} />
        <BlockFormatMenu editor={editor} />
        <ClearFormattingButton editor={editor} />
        <ToolbarDivider />
        <ToolbarButton title={t("editor.footnote")} onClick={openFootnote}>
          <IconAsterisk size={15} strokeWidth={2} />
        </ToolbarButton>
      </BubbleMenu>

      {footnoteCtx && (
        <PromptDialog
          title={t("editor.footnote")}
          mode="input"
          multiline
          placeholder={t("editor.footnote_placeholder")}
          confirmLabel={t("editor.footnote_confirm")}
          assistActions={buildFootnoteAssistActions(
            editor.state.doc.textBetween(footnoteCtx.from, footnoteCtx.to, "\n"),
            translateGateOk === true,
          )}
          onCancel={() => setFootnoteCtx(null)}
          onSubmit={(value) => {
            const body = (typeof value === "string" ? value : "").trim();
            const range = footnoteCtx;
            setFootnoteCtx(null);
            if (!body || !range) return;
            void applyFootnoteFromSelection(editor, range, body);
          }}
        />
      )}
    </>
  );
}
