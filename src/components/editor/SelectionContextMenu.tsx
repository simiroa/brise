/**
 * Right-click selection context menu + excerpt / footnote / clipboard / translation / link actions.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type MouseEvent,
  type MutableRefObject,
} from "react";
import { getHTMLFromFragment, type Editor } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { call, emitNotice } from "../../lib/invoke";
import { insertAiSection } from "../../lib/aiSectionBridge";
import { mdSerializeHtml } from "../../lib/mdSerialize";
import { deriveExcerptTitle } from "../../lib/selectionText";
import { useMenuPos } from "../../lib/ui";
import { t } from "../../i18n/t";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../../stores/ai";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import type { NoteDetail } from "../../lib/commands.gen";
import { PromptDialog } from "../PromptDialog";
import {
  IconNote,
  IconAsterisk,
  IconAi,
  IconCopy,
  IconPaste,
  IconTranslate,
  IconLink,
  IconCalendar,
} from "../icons";
import { applyFootnoteFromSelection, buildFootnoteAssistActions } from "./footnoteMark";
import { copyEditorSelection, pasteEditorSelection } from "./selectionClipboard";
import { isValidLinkUrl } from "./toolbar/buttons";
import type { AskAiTarget } from "../AskAiModal";
import { ContextMenuShell } from "../common/ContextMenuShell";
import type { LinkNudgeCtx } from "../common/LinkNudge";
import { linkHrefsInRange } from "./linkHrefs";
import { openDateEntry } from "../../lib/dateEntryBridge";
import { parseNlDate, type NlDateLocale } from "../../lib/nlDate";

export type SelCtx = { x: number; y: number; from: number; to: number };

export type SelectionContextMenuOpen = (e: MouseEvent) => void;

/** Restore the exact captured document slice without relying on undo history surviving reloads. */
export function restoreExcerptSelection(
  editor: Editor,
  from: number,
  replacementText: string,
  slice: Slice,
): boolean {
  if (editor.isDestroyed) return false;
  const start = Math.min(from, editor.state.doc.content.size);
  const end = Math.min(start + replacementText.length, editor.state.doc.content.size);
  editor.view.dispatch(editor.state.tr.replaceRange(start, end, slice));
  return true;
}

export type SelectionContextMenuProps = {
  editor: Editor;
  /** SectionTabBar rename / delete-confirm / sectionCtx open — suppress this menu while true. */
  tabUiBusy: boolean;
  /** Parent flush of pending section edits (flushRef.current). */
  flush: () => Promise<void>;
  /**
   * True while selCtx menu or the Ask-AI PromptDialog is open — parent uses this for BubbleMenu
   * hide (same gate as pre-extract `!!(selCtx || aiAskCtx)`).
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Parent binds the editor surface's onContextMenu to this ref's current callback so open
   * logic stays inside this module (mirrors SectionTabBar owning its own sectionCtx).
   */
  openRef: MutableRefObject<SelectionContextMenuOpen | null>;
  onAskAi?: (target: AskAiTarget) => void;
  /**
   * 링크 위 우클릭 — 부모(EditorPanel)의 링크 넛지를 이 자리에서 연다. 선택이 없는 우클릭은
   * 원래 아무 메뉴도 열지 않았고, 그 빈자리가 "붙여넣기 넛지를 놓치면 링크에 다시 닿을 길이
   * 없다"는 문제였다(오너 2026-09-10). 넛지 컴포넌트는 하나뿐이므로 문구·게이트가 갈리지 않는다.
   */
  onLinkNudge?: (ctx: LinkNudgeCtx) => void;
};

/** settings store 의 `uiLang` 은 그냥 `string` — `parseNlDate` 가 받는 `NlDateLocale`("ko"|"en"|"fr")
 *  으로 좁힌다. openSelectionTranslate 의 uiLang 삼항 분기와 같은 자리(en/fr 미확정 값은 en 폴백). */
export function uiLangToNlDateLocale(uiLang: string): NlDateLocale {
  return uiLang === "ko" || uiLang === "fr" ? uiLang : "en";
}

/** 우클릭 지점의 http(s) 링크 주소. 링크가 아니면 null. */
function httpHrefAt(target: EventTarget | null): string | null {
  const anchor = (target as HTMLElement | null)?.closest?.(
    'a[href^="http://"], a[href^="https://"]',
  ) as HTMLAnchorElement | null;
  return anchor?.href ?? null;
}

export function SelectionContextMenu({
  editor,
  tabUiBusy,
  flush,
  onBusyChange,
  openRef,
  onAskAi,
  onLinkNudge,
}: SelectionContextMenuProps) {
  const [selCtx, setSelCtx] = useState<SelCtx | null>(null);

  // "AI에게 요청하기"
  const [aiAskCtx, setAiAskCtx] = useState<{ text: string } | null>(null);

  // 각주 달기
  const [footnoteCtx, setFootnoteCtx] = useState<{ from: number; to: number } | null>(null);

  // B-6a: 번역하기 팝오버 상태
  const [translateCtx, setTranslateCtx] = useState<{
    x: number;
    y: number;
    from: number;
    to: number;
    text: string;
    translated: string | null;
    loading: boolean;
  } | null>(null);
  const { ref: transMenuRef, x: transMenuX, y: transMenuY } = useMenuPos(translateCtx ? { x: translateCtx.x, y: translateCtx.y } : null);

  // B-6b: 링크 연결하기 팝오버 상태
  const [linkCtx, setLinkCtx] = useState<{
    x: number;
    y: number;
    from: number;
    to: number;
    url: string;
  } | null>(null);
  const { ref: linkMenuRef, x: linkMenuX, y: linkMenuY } = useMenuPos(linkCtx ? { x: linkCtx.x, y: linkCtx.y } : null);
  const [linkInputUrl, setLinkInputUrl] = useState("");
  const linkInputRef = useRef<HTMLInputElement>(null);

  const translateGateOk = useAiStore((s) => s.translateGateOk);
  useEffect(() => {
    void useAiStore.getState().refreshTranslateGate();
  }, []);

  const busy = !!(selCtx || aiAskCtx || footnoteCtx || translateCtx || linkCtx);
  useLayoutEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // 메인 선택 메뉴의 Escape 는 ContextMenuShell 이 중앙 체인(overlayStack)으로 처리한다 —
  // 여기 남은 건 아직 자작인 번역/링크 결과 팝오버 몫뿐이다. 셋을 한 리스너로 묶어두면 쉘과
  // 이 리스너가 같은 Escape 를 두 번 소비한다.
  useEffect(() => {
    if (!translateCtx && !linkCtx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTranslateCtx(null);
        setLinkCtx(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [translateCtx, linkCtx]);

  const tryOpen = useCallback(
    (e: MouseEvent) => {
      if (tabUiBusy) return;
      const { selection } = editor.state;
      if (selection.empty || selection instanceof NodeSelection) {
        // 선택 없이 링크를 우클릭한 경우만 예외 — 이 메뉴의 모든 행은 선택에 대한 명령이라
        // 열어도 대상이 없다. 대신 링크 넛지를 그 자리에 띄운다.
        const url = httpHrefAt(e.target);
        if (url && onLinkNudge) {
          e.preventDefault();
          onLinkNudge({ x: e.clientX, y: e.clientY, urls: [url] });
        }
        return;
      }
      e.preventDefault();
      setSelCtx({ x: e.clientX, y: e.clientY, from: selection.from, to: selection.to });
    },
    [editor, tabUiBusy, onLinkNudge],
  );

  useEffect(() => {
    openRef.current = tryOpen;
    return () => {
      openRef.current = null;
    };
  }, [openRef, tryOpen]);

  // 선택 영역 안의 http(s) 링크 — 있으면 "선택 안의 링크 N개…" 행이 뜬다(오너 2026-09-10:
  // "여러 링크가 포함된 선택도 가능한가"). 우클릭 이후 문서는 변하지 않으므로 렌더 시점에 센다.
  const selLinks = selCtx ? linkHrefsInRange(editor.state.doc, selCtx.from, selCtx.to) : [];

  // 1. 복사하기
  const handleCopy = async () => {
    setSelCtx(null);
    await copyEditorSelection(editor);
  };

  // 2. 클립보드로 대체하기
  const handlePasteReplace = async () => {
    setSelCtx(null);
    await pasteEditorSelection(editor);
  };

  // 3. 번역하기 (B-6a)
  const openSelectionTranslate = async () => {
    if (!selCtx) return;
    const { x, y, from, to } = selCtx;
    const text = editor.state.doc.textBetween(from, to, "\n");
    setSelCtx(null);
    const gateOk = await useAiStore.getState().refreshTranslateGate();
    if (!gateOk) {
      const avail = selectAiAvailability(useSettingsStore.getState(), useAiStore.getState());
      emitNotice(getAiDisabledHint(avail, "editor"));
      return;
    }
    setTranslateCtx({ x, y, from, to, text, translated: null, loading: true });

    const uiLang = useSettingsStore.getState().uiLang;
    const targetLang = uiLang === "ko" ? "한국어" : uiLang === "fr" ? "français" : "English";
    const prompt = `다음 텍스트를 ${targetLang}로 자연스럽게 번역하세요. 번역 결과만 출력하고 설명·따옴표·부연은 붙이지 마세요.\n\n${text}`;
    try {
      const result = await useAiStore.getState().generateFromPrompt(prompt, null);
      if (result) {
        setTranslateCtx((prev) => (prev ? { ...prev, translated: result.trim(), loading: false } : null));
      } else {
        setTranslateCtx(null);
      }
    } catch {
      setTranslateCtx(null);
    }
  };

  // 4. 각주
  const openSelectionFootnote = () => {
    if (!selCtx) return;
    const { from, to } = selCtx;
    setSelCtx(null);
    if (!editor.state.doc.textBetween(from, to, " ").trim()) return;
    setFootnoteCtx({ from, to });
  };

  // 5. 발췌하여 새 노트로
  const excerptToNewNote = async () => {
    if (!selCtx) return;
    const { from, to } = selCtx;
    const slice = editor.state.doc.slice(from, to);
    const html = getHTMLFromFragment(slice.content, editor.schema);
    const plainText = editor.state.doc.textBetween(from, to, "\n");
    const title = deriveExcerptTitle(plainText);
    const bodyMd = mdSerializeHtml(html);
    const replacementText = title ?? t("note.untitled_note");
    setSelCtx(null);

    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(replacementText, from, to);
        return true;
      })
      .run();

    const restore = async () => {
      restoreExcerptSelection(editor, from, replacementText, slice);
      try {
        await flush();
      } catch {}
    };

    let excerptSaved = false;
    try {
      await flush();
      const noteId = await useNotesStore.getState().ensureMaterialized();
      if (!noteId) {
        emitNotice(t("editor.note_required_for_section"));
        await restore();
        return;
      }
      const sourceNote = useNotesStore.getState().activeNote?.note;
      if (!sourceNote?.folder_id) {
        await restore();
        return;
      }
      const detail = await call<NoteDetail>("note_create", {
        folder_id: sourceNote.folder_id,
        title: title || undefined,
        year: sourceNote.year,
        month: sourceNote.month,
        day: sourceNote.day,
      });
      // 방금 만든 노트의 섹션에 1회 쓰기 — note_create 응답 토큰을 그대로 보낸다(D2②).
      const first = detail.sections[0];
      await call("section_update", {
        id: first.id,
        body_md: bodyMd,
        ...(first.updated_at ? { expected_updated_at: first.updated_at } : {}),
      });
      excerptSaved = true;
      await useNotesStore.getState().loadTree();
    } catch {
      if (!excerptSaved) await restore();
    }
  };

  // 6. 링크 연결하기 (B-6b)
  const openSelectionLink = () => {
    if (!selCtx) return;
    const { x, y, from, to } = selCtx;
    const existingHref = (editor.getAttributes("link").href as string) || "";
    setSelCtx(null);
    setLinkInputUrl(existingHref);
    setLinkCtx({ x, y, from, to, url: existingHref });
    setTimeout(() => linkInputRef.current?.focus(), 50);
  };

  const handleApplyLink = () => {
    if (!linkCtx) return;
    const trimmed = linkInputUrl.trim();
    const { from, to } = linkCtx;
    setLinkCtx(null);
    if (!isValidLinkUrl(trimmed) || editor.isDestroyed) return;
    const docSize = editor.state.doc.content.size;
    const start = Math.min(from, docSize);
    const end = Math.min(to, docSize);
    editor
      .chain()
      .focus()
      .setTextSelection({ from: start, to: end })
      .extendMarkRange("link")
      .setLink({ href: trimmed })
      .run();
  };

  // 7. 일정으로 등록 (§W2) — 선택 텍스트를 nlDate(W1)로 파싱해 DateEntryPopover 의 prefill 로
  // 넘긴다. 본문은 건드리지 않는다(D6) — 이미 선택된 텍스트 자체가 평문 한 줄 역할이라
  // replaceRangeOnSave 를 켜지 않는다(openDateEntry.ts 기본값 false/undefined).
  const openSelectionDateEntry = () => {
    if (!selCtx) return;
    const { x, y, from, to } = selCtx;
    const text = editor.state.doc.textBetween(from, to, "\n");
    setSelCtx(null);
    const targetNoteId = useNotesStore.getState().activeNote?.note.id;
    if (!targetNoteId) {
      emitNotice(t("editor.note_required_for_section"));
      return;
    }
    // 파싱 실패(null)해도 빈 폼으로 연다 — "파싱 안 되면 그냥 수동 입력"이 자연스러운 폴백.
    const parsed = parseNlDate(text, uiLangToNlDateLocale(useSettingsStore.getState().uiLang));
    openDateEntry({
      noteId: targetNoteId,
      anchorX: x,
      anchorY: y,
      range: { from, to },
      prefill: parsed
        ? {
            start: parsed.start,
            end: parsed.end,
            label: parsed.title ?? undefined,
            // 2026-09-19 후속 — nlDate 가 파싱한 시각도 같이 넘긴다(처음엔 빠져 있었다).
            startTime: parsed.startTime,
            endTime: parsed.endTime,
          }
        : undefined,
    });
  };

  // AI에게 요청하기
  const openSelectionAiAsk = async () => {
    if (!selCtx) return;
    const { from, to } = selCtx;
    const text = editor.state.doc.textBetween(from, to, "\n");
    setSelCtx(null);
    const gateOk = await useAiStore.getState().refreshTranslateGate();
    if (!gateOk) {
      const avail = selectAiAvailability(useSettingsStore.getState(), useAiStore.getState());
      emitNotice(getAiDisabledHint(avail, "editor"));
      return;
    }
    if (onAskAi) {
      onAskAi({ kind: "selection", selectedText: text, from, to });
      return;
    }
    setAiAskCtx({ text });
  };

  const runSelectionAiAsk = async (promptText: string, selectionText: string) => {
    const targetNoteId = useNotesStore.getState().activeNote?.note.id;
    if (!targetNoteId) {
      emitNotice(t("editor.note_required_for_section"));
      return;
    }
    const generated = await useAiStore.getState().generateFromPrompt(promptText, selectionText);
    if (generated == null || !generated.trim()) return;
    await insertAiSection(t("editor.ai_prompt_section_name"), generated, targetNoteId, undefined, {
      aiOrigin: "prompt",
    });
  };

  return (
    <>
      {selCtx && (
        <ContextMenuShell anchor={selCtx} onClose={() => setSelCtx(null)} minWidth={200} editorSafe>
            {/* 1. 복사하기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => void handleCopy()}
              style={{ color: "inherit" }}
            >
              <IconCopy size={15} strokeWidth={1.8} />
              <span>{t("ctx.copy")}</span>
            </button>

            {/* 2. 클립보드로 대체하기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => void handlePasteReplace()}
              style={{ color: "inherit" }}
            >
              <IconPaste size={15} strokeWidth={1.8} />
              <span>{t("ctx.paste_replace")}</span>
            </button>

            {/* 3. 번역하기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => void openSelectionTranslate()}
              style={{ color: "inherit" }}
            >
              <IconTranslate size={15} strokeWidth={1.8} />
              <span>{t("ctx.translate")}</span>
            </button>

            {/* 4. 각주 */}
            <button
              type="button"
              className="menu-row menu-item"
              data-testid="sel-ctx-footnote"
              onClick={() => openSelectionFootnote()}
              style={{ color: "inherit" }}
            >
              <IconAsterisk size={15} strokeWidth={1.8} />
              <span>{t("ctx.footnote")}</span>
            </button>

            {/* 5. 새 노트로 만들기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => void excerptToNewNote()}
              style={{ color: "inherit" }}
            >
              <IconNote size={15} strokeWidth={1.8} />
              <span>{t("ctx.excerpt_to_note")}</span>
            </button>

            {/* 6. 링크 연결하기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => openSelectionLink()}
              style={{ color: "inherit" }}
            >
              <IconLink size={15} strokeWidth={1.8} />
              <span>{t("ctx.link")}</span>
            </button>

            {/* 6-b. 선택 안의 링크 N개 — 같은 넛지를 이 자리에서 연다(common/LinkNudge.tsx).
                 두 제안(추출·AI 정리)을 여기 복제하지 않는 이유: 문구·게이트·배치 동작이 두 벌로
                 갈리는 순간 한쪽만 고쳐지는 일이 시작된다. 번역/링크 팝오버가 이미 쓰는 관용구
                 (메뉴를 닫고 같은 좌표에 다음 팝오버를 띄운다)를 그대로 따른다. */}
            {selLinks.length > 0 && onLinkNudge && (
              <button
                type="button"
                className="menu-row menu-item"
                data-testid="sel-ctx-links"
                onClick={() => {
                  if (!selCtx) return;
                  const { x, y } = selCtx;
                  setSelCtx(null);
                  onLinkNudge({ x, y, urls: selLinks });
                }}
                style={{ color: "inherit" }}
              >
                <IconLink size={15} strokeWidth={1.8} />
                <span>{t("editor.link_nudge_selection", { n: selLinks.length })}</span>
              </button>
            )}

            {/* 7. 일정으로 등록 */}
            <button
              type="button"
              className="menu-row menu-item"
              data-testid="sel-ctx-date"
              onClick={() => openSelectionDateEntry()}
              style={{ color: "inherit" }}
            >
              <IconCalendar size={15} strokeWidth={1.8} />
              <span>{t("ctx.register_as_date")}</span>
            </button>

            {/* AI에게 요청하기 */}
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => void openSelectionAiAsk()}
              style={{ color: "inherit" }}
            >
              <IconAi size={15} strokeWidth={1.8} />
              <span>{t("ctx.ask_ai")}</span>
            </button>
        </ContextMenuShell>
      )}

      {/* B-6a 번역 결과 팝오버 */}
      {translateCtx && (
        <>
          <div
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTranslateCtx(null)}
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
          />
          <div
            ref={transMenuRef}
            className="overlay"
            data-editor-pop=""
            data-testid="translate-popover"
            style={{
              position: "fixed",
              zIndex: "var(--z-modal)",
              width: 320,
              maxWidth: "calc(100vw - 32px)",
              border: "2px solid var(--divider)",
              boxShadow: "var(--shadow-lg)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-3)",
              left: transMenuX,
              top: transMenuY,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--accent)" }}>
                <IconTranslate size={14} strokeWidth={2} />
                <span>{t("ctx.translate")}</span>
              </div>
              {translateCtx.loading && <span style={{ fontSize: "var(--text-2xs)", color: "var(--muted)" }}>{t("presets.ai_generating")}</span>}
            </div>

            {translateCtx.loading ? (
              <div style={{ padding: "var(--space-3) 0", color: "var(--muted)", fontSize: "var(--text-xs)", textAlign: "center" }}>
                ···
              </div>
            ) : (
              <>
                <div
                  style={{
                    padding: "var(--space-2)",
                    background: "var(--surface)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "var(--text-xs)",
                    lineHeight: 1.5,
                    maxHeight: 160,
                    overflowY: "auto",
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {translateCtx.translated}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                  {/* ponytail: 번역 결과 자동 본문 치환 금지 — 사용자가 '선택 영역 치환'을 눌렀을 때만 본문을 교체한다 */}
                  <button
                    type="button"
                    className="menu-row menu-item"
                    style={{ fontSize: "var(--text-xs)", justifyContent: "center", padding: "6px" }}
                    onClick={() => {
                      if (!editor.isDestroyed && translateCtx.translated) {
                        editor.chain().focus().command(({ tr }) => {
                          const from = Math.min(translateCtx.from, tr.doc.content.size);
                          const to = Math.min(translateCtx.to, tr.doc.content.size);
                          tr.insertText(translateCtx.translated!, from, to);
                          return true;
                        }).run();
                      }
                      setTranslateCtx(null);
                    }}
                  >
                    {t("ctx.translate_replace")}
                  </button>

                  <button
                    type="button"
                    className="menu-row menu-item"
                    style={{ fontSize: "var(--text-xs)", justifyContent: "center", padding: "6px" }}
                    onClick={async () => {
                      const { from, to, translated } = translateCtx;
                      setTranslateCtx(null);
                      if (translated && !editor.isDestroyed) {
                        await applyFootnoteFromSelection(editor, { from, to }, translated);
                      }
                    }}
                  >
                    {t("ctx.translate_footnote")}
                  </button>

                  <button
                    type="button"
                    className="menu-row menu-item"
                    style={{ fontSize: "var(--text-xs)", justifyContent: "center", padding: "6px" }}
                    onClick={async () => {
                      const { translated } = translateCtx;
                      setTranslateCtx(null);
                      const targetNoteId = useNotesStore.getState().activeNote?.note.id;
                      if (targetNoteId && translated && !editor.isDestroyed) {
                        await insertAiSection(t("ctx.translate"), translated, targetNoteId, undefined, {
                          aiOrigin: "translate",
                        });
                      }
                    }}
                  >
                    {t("ctx.translate_section")}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* B-6b 링크 연결 팝오버 */}
      {linkCtx && (
        <>
          <div
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLinkCtx(null)}
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
          />
          <div
            ref={linkMenuRef}
            className="overlay"
            data-editor-pop=""
            data-testid="link-popover"
            style={{
              position: "fixed",
              zIndex: "var(--z-modal)",
              width: 280,
              maxWidth: "calc(100vw - 32px)",
              border: "2px solid var(--divider)",
              boxShadow: "var(--shadow-lg)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-3)",
              left: linkMenuX,
              top: linkMenuY,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
              <IconLink size={14} strokeWidth={2} />
              <span>{t("ctx.link")}</span>
            </div>

            <input
              ref={linkInputRef}
              type="text"
              className="field-input"
              value={linkInputUrl}
              onChange={(e) => setLinkInputUrl(e.target.value)}
              placeholder="https://..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApplyLink();
                }
              }}
              style={{ fontSize: "var(--text-xs)", width: "100%" }}
            />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setLinkCtx(null)}
                style={{ fontSize: "var(--text-xs)", padding: "4px 8px" }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!isValidLinkUrl(linkInputUrl.trim())}
                onClick={handleApplyLink}
                style={{
                  fontSize: "var(--text-xs)",
                  padding: "4px 8px",
                  background: isValidLinkUrl(linkInputUrl.trim()) ? "var(--accent)" : "transparent",
                  color: isValidLinkUrl(linkInputUrl.trim()) ? "var(--accent-text)" : "var(--muted)",
                }}
              >
                {t("editor.link_apply")}
              </button>
            </div>
          </div>
        </>
      )}

      {aiAskCtx && (
        <PromptDialog
          title={t("ctx.ask_ai")}
          mode="input"
          placeholder={t("ai.prompt_placeholder")}
          confirmLabel={t("ai.ask_btn")}
          onCancel={() => setAiAskCtx(null)}
          onSubmit={(value) => {
            const promptText = (typeof value === "string" ? value : "").trim();
            const selectionText = aiAskCtx.text;
            setAiAskCtx(null);
            if (!promptText) return;
            void runSelectionAiAsk(promptText, selectionText);
          }}
        />
      )}

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
