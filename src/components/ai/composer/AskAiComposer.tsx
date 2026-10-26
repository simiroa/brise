/**
 * AI에게 묻기 요청문 상자 — 단일 문단 TipTap(PLAN-2026-09-15 D11·D13, 6안 D15).
 *
 * 제어형: `value` 의 **정체성**이 밖에서 바뀌면(스탬프) 내용을 통째로 갈고 첫 슬롯 값을 선택한다.
 * 우리가 onChange 로 내보낸 문서가 그대로 돌아오는 경우는 무시한다(`lastEmitted`). 타이핑·undo·
 * IME·붙여넣기는 TipTap 이 소유하고, 이 파일은 슬롯 픽커·`/`·제출·고스트만 얹는다.
 * 문서는 **텍스트+슬롯**뿐이다 — 컨텍스트는 상자 밖(AskAiContextStrip)이 소유한다(D15).
 */
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TextSelection } from "@tiptap/pm/state";
import { t } from "../../../i18n/t";
import { useDismiss, useMenuPos } from "../../../lib/ui";
import { dismissTopOverlay } from "../../../lib/overlayStack";
import { TRANSLATE_LANGUAGES } from "../askAiTypes";
import { docToPM, pmToDoc, TONE_KEYS } from "./serialize";
import { SlashCtx, type CtxItem } from "./slashSuggestion";
import { SLOT_NODE, SlotNode } from "./slotNode";
import type { ComposerDoc, SlotKind } from "./types";

export type { CtxItem } from "./slashSuggestion";

export interface AskAiComposerProps {
  value: ComposerDoc;
  onChange: (doc: ComposerDoc) => void;
  placeholder?: string;
  ctxItems: CtxItem[];
  /** Enter(Shift 없음, IME 조합 중 아님). */
  onSubmit: () => void;
  disabled?: boolean;
  /** 호버 미리보기(D11) — 있으면 에디터 위에 흐린 비대화 오버레이로 그린다. */
  ghost?: ComposerDoc | null;
  autoFocus?: boolean;
  /** 에디터 인스턴스를 밖에 빌려준다(동작 줄에서 `focus()` 하기·테스트). */
  editorRef?: { current: Editor | null };
}

/** Enter → 제출. 키맵은 IME 조합 중엔 ProseMirror 가 부르지 않지만 `view.composing` 도 한 번 더 본다. */
const SubmitKey = Extension.create<{ onSubmit: () => void }>({
  name: "askAiSubmit",
  addOptions() {
    return { onSubmit: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (this.editor.view.composing) return false;
        this.options.onSubmit();
        return true;
      },
      // ProseMirror 는 편집기 안의 Escape 를 무조건 "처리됨"(preventDefault)으로 만든다(prosemirror-view
      // captureKeyDown). 그래서 ModalShell 의 Escape 리스너가 건너뛰었고, 이 상자가 자동 포커스라 AI
      // 모달은 Escape 로 한 번도 안 닫혔다(2026-09-27 실측). 모달이 했을 일 — 겹 스택 맨 위 한 장 닫기 —
      // 을 여기서 대신한다. 슬롯 픽커 같은 안쪽 겹이 열려 있으면 그것부터 닫히고, `/` 메뉴는 제안
      // 플러그인이 먼저 가져간다.
      Escape: () => {
        if (this.editor.view.composing) return false;
        return dismissTopOverlay();
      },
    };
  },
});

/** 첫 슬롯의 값 전체를 선택한다. 슬롯이 없으면 끝에 캐럿. */
function selectFirstSlot(editor: Editor, focus: boolean) {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.type.name === SLOT_NODE) range = { from: pos + 1, to: pos + 1 + node.content.size };
    return !range;
  });
  const chain = focus ? editor.chain().focus() : editor.chain();
  if (range) chain.setTextSelection(range).run();
  else chain.command(({ tr }) => (tr.setSelection(TextSelection.atEnd(tr.doc)), true)).run();
}

interface SlotPick {
  kind: "lang" | "tone";
  /** 슬롯 노드 위치. */
  pos: number;
  x: number;
  y: number;
}

export function AskAiComposer({
  value, onChange, placeholder, ctxItems, onSubmit, disabled, ghost, autoFocus, editorRef,
}: AskAiComposerProps) {
  // 콜백·항목은 ref 로 — 에디터는 한 번만 만들고(함정 #2) 옵션 함수가 최신 값을 읽는다.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const ctxItemsRef = useRef(ctxItems);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  ctxItemsRef.current = ctxItems;

  const lastEmitted = useRef<ComposerDoc | null>(null);
  const [pick, setPick] = useState<SlotPick | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, dropcursor: false,
        gapcursor: false, hardBreak: false, heading: false, horizontalRule: false, italic: false, link: false,
        listItem: false, listKeymap: false, orderedList: false, strike: false, underline: false, trailingNode: false,
      }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      SlotNode,
      SlashCtx.configure({ getItems: () => ctxItemsRef.current }),
      SubmitKey.configure({ onSubmit: () => onSubmitRef.current() }),
    ],
    content: docToPM(value),
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: "field askai-composer__editor", role: "textbox", "aria-multiline": "false" },
      // 붙여넣기는 평문만 — 서식·줄바꿈은 문장에 들어오지 않는다.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text == null) return false;
        view.dispatch(view.state.tr.insertText(text.replace(/\s*\r?\n\s*/g, " ")));
        return true;
      },
      // lang·tone 슬롯 클릭 → 픽커. handleClickOn 대신 DOM click 인 이유: 위치는 좌표가 아니라
      // 클릭된 칩 엘리먼트에서 posAtDOM 으로 얻는다(좌표 경로는 jsdom 에 없고 여기선 필요도 없다).
      handleDOMEvents: {
        click: (view, event) => {
          const el = (event.target as HTMLElement).closest?.(".askai-slot") as HTMLElement | null;
          if (!el || !view.dom.contains(el)) return false;
          const nodePos = view.posAtDOM(el, 0) - 1;
          const node = view.state.doc.nodeAt(nodePos);
          if (node?.type.name !== SLOT_NODE) return false;
          const kind = node.attrs.kind as SlotKind;
          if (kind !== "lang" && kind !== "tone") return false;
          const r = el.getBoundingClientRect();
          setPick({ kind, pos: nodePos, x: r.left, y: r.bottom + 4 });
          return true;
        },
      },
    },
    onUpdate: ({ editor }) => {
      const doc = pmToDoc(editor.getJSON());
      lastEmitted.current = doc;
      onChangeRef.current(doc);
    },
  }, []);

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // 제어형 동기화 — 밖에서 새 문서(스탬프)가 오면 갈아 끼우고 첫 슬롯을 선택한다.
  const first = useRef(true);
  useEffect(() => {
    if (!editor || editor.isDestroyed || value === lastEmitted.current) return;
    if (first.current) {
      first.current = false; // 초기 내용은 useEditor 가 이미 넣었다.
      if (autoFocus) selectFirstSlot(editor, true);
      return;
    }
    editor.commands.setContent(docToPM(value), { emitUpdate: false });
    selectFirstSlot(editor, true);
    setPick(null);
  }, [editor, value, autoFocus]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!disabled);
  }, [editor, disabled]);

  const pickSlot = (label: string) => {
    if (!editor || editor.isDestroyed || !pick) return;
    const node = editor.state.doc.nodeAt(pick.pos);
    if (node?.type.name === SLOT_NODE) {
      editor
        .chain()
        .focus()
        .command(({ tr, state }) => {
          tr.replaceWith(pick.pos + 1, pick.pos + 1 + node.content.size, state.schema.text(label));
          return true;
        })
        .run();
    }
    setPick(null);
  };

  return (
    // data-ghost: 미리보기가 떠 있는 동안 상자 속 글자를 숨긴다(tokens.css .askai-ghost — 미리보기가
    // 상자를 불투명하게 덮지 않고 같은 자리에 겹친다).
    <div className="askai-composer" data-disabled={disabled || undefined} data-ghost={ghost ? "" : undefined}>
      <EditorContent editor={editor} />
      {ghost ? (
        <div className="askai-ghost field" aria-hidden data-testid="askai-ghost">
          <p>
            {ghost.map((p, i) =>
              p.t === "text" ? (
                <span key={i}>{p.v}</span>
              ) : (
                <span key={i} className="askai-slot" data-kind={p.kind} data-ph={p.ph}>{p.v}</span>
              ),
            )}
          </p>
        </div>
      ) : null}
      {pick ? (
        <SlotPicker
          kind={pick.kind}
          anchor={pick}
          onPick={pickSlot}
          onClose={() => setPick(null)}
        />
      ) : null}
    </div>
  );
}

/** lang·tone 슬롯 선택지 — body 포탈(모달의 backdrop-filter 가 fixed 의 기준이 되는 것을 피한다). */
function SlotPicker({ kind, anchor, onPick, onClose }: {
  kind: "lang" | "tone";
  anchor: { x: number; y: number };
  onPick: (label: string) => void;
  onClose: () => void;
}) {
  const { ref, x, y } = useMenuPos(anchor);
  const options = kind === "lang" ? TRANSLATE_LANGUAGES.map((l) => l.name) : TONE_KEYS.map((k) => t(k));
  useDismiss(true, [ref], onClose);

  return createPortal(
    <div
      ref={ref}
      role="listbox"
      className="overlay askai-slash-menu"
      data-testid="askai-slot-picker"
      style={{ left: x, top: y }}
    >
      <div className="askai-slash-menu__list">
        {options.map((label) => (
          <button key={label} type="button" role="option" className="menu-row menu-item askai-slash-menu__item" onClick={() => onPick(label)}>
            {label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
