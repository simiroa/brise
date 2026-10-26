import { useRef, useCallback } from "react";
import type { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import { useNotesStore, markSnapshotDirty } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { isStillOnTarget } from "../../lib/onTargetGuard";
import { soleUrlFromPasteText, linkBodyMaybeReadable } from "../../lib/urls";
import type { LinkNudgeCtx } from "../common/LinkNudge";
import { t } from "../../i18n/t";
import type { Attachment, Section } from "../../lib/commands.gen";
import { insertImagesAtRange } from "./insertImageAtPos";
import { serializeSheet } from "../../lib/sheet/types";
import { parseTableClipboardMatrix } from "./tableAiPlan";
import { sheetFromMatrix } from "../../lib/sheet/fromMatrix";
import { showToastOnly } from "../../lib/undo";

export { isStillOnTarget as isPasteStillOnTarget };

/** Exported for testing. Clipboard-pasted image files often carry no useful `name` — Chromium
 *  names a raw bitmap paste (screenshot tools, "copy image" from a page) "image.png" or leaves
 *  it empty, only a real copied file keeps its original filename. Falls back to a name derived
 *  from the MIME type ("image/svg+xml" → "pasted-image.svg") so attachment_add_bytes always gets
 *  something to extension/kind-detect from (repo::attachments::kind_from_ext, server-side). */
export function derivePasteImageName(file: { name: string; type: string }): string {
  if (file.name) return file.name;
  const ext = file.type.split("/")[1]?.split("+")[0] || "png"; // "image/svg+xml" → "svg"
  return `pasted-image.${ext}`;
}

/** Some desktop apps put text/HTML and a bitmap fallback on the clipboard together. In that
 * case editable text wins; the image path is reserved for a genuinely image-only paste. */
export function shouldPasteClipboardImages(input: {
  imageCount: number;
  plainText: string;
  parsedText: string;
}): boolean {
  return input.imageCount > 0 && !input.plainText.trim() && !input.parsedText.trim();
}

/** Clipboard-table paste → "make it a sheet?" suggestion gate. Same shape as
 *  shouldPasteClipboardImages above — a pure predicate over the paste inputs, so the actual
 *  IPC/section-creation flow (needs a mounted note) stays untested here (see
 *  EditorPanel.paste.test.tsx's file-scope note on why). `inTable`: true when the caret is
 *  already inside a table — editor/tableMatrixPaste.ts's own ProseMirror plugin fills the
 *  selected cells in that case, so suggesting "make a sheet" on top would be redundant.
 *  `enabled` — 오너 결정(2026-09-20) `paste_table_sheet_suggest` 킬 스위치. 기본 true(구현 전
 *  동작 유지) 라서 이 세 번째 인자를 안 넘기는 기존 호출부(과 기존 단위 테스트)는 그대로 통과한다
 *  — 스토어를 이 순수 함수 안에서 읽지 않고 호출부(핸들러/훅)가 읽어서 넘긴다(CLAUDE.md 코드
 *  방침 — 순수 술어는 순수하게 유지). in-table matrix paste(tableMatrixPaste.ts)는 이 게이트를
 *  아예 거치지 않는 별도 경로라 영향받지 않는다. */
export function shouldSuggestSheetFromPaste(
  matrix: string[][] | null,
  inTable: boolean,
  enabled = true,
): boolean {
  return enabled && !inTable && !!matrix && matrix.length >= 2 && matrix[0].length >= 2;
}

/** 오너 2026-09-10: 붙여넣은 텍스트가 파일 경로 "하나뿐"이면 인라인 코드로 자동 스타일링한다
 *  (넛지·제안 아님 — 물어보지 않고 바로 적용). **보수적으로만** 판정 — 오탐이 평범한 문장을
 *  코드로 바꾸면 손해다. 파일시스템은 만지지 않는다(존재확인·타입판정 없음, 프런트는 애초에
 *  파일시스템을 못 읽는다 — 그래서 "추출"이 아니라 "스타일링"). 줄바꿈이 있으면 즉시 null.
 *  http(s) URL 로 파싱되면 무조건 제외(soleUrlFromPasteText 분기와 같은 문자열을 다르게 판정하면
 *  안 되는 방어선). POSIX 절대경로만 공백을 금지한다 — "/ 로 시작하는 평범한 문장"까지 먹지
 *  않기 위해서(윈도/UNC 경로는 "C:\Program Files\..." 처럼 공백이 흔해 허용). */
export function soleFilePathFromPasteText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return null;
  } catch {
    // URL 로 파싱 안 되는 게 정상 경로 — 계속 진행.
  }
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(trimmed); // "C:\..." / "C:/..." (드라이브 문자만은 제외)
  const isUnc = /^\\\\/.test(trimmed); // "\\server\share\..."
  // 슬래시 두 개 이상 = 실제 경로 모양. "/summarize" 처럼 슬래시로 시작하는 한 낱말을
  // 코드로 바꾸지 않기 위해 최소 2세그먼트를 요구한다(붙여넣은 슬래시 명령·약어).
  const isPosixAbsolute = /^\/[^\s/]+\/\S*$/.test(trimmed); // "/a/b" 이상, 전체에 공백 없음
  return isWindowsDrive || isUnc || isPosixAbsolute ? trimmed : null;
}

export type SectionAccessor =
  | { current: { id: string; kind?: string } | null }
  | (() => { id: string; kind?: string } | null);

export function resolveSection(sec: SectionAccessor): { id: string; kind?: string } | null {
  return typeof sec === "function" ? sec() : sec.current;
}

export interface PasteImageFilesDeps {
  editor: Editor | null;
  sectionRef: SectionAccessor;
}

/**
 * Clipboard image paste — routes through attachment_add_bytes.
 * Reads image files via FileReader, calls attachment_add_bytes, and inserts image nodes at range.
 * Complies with CLAUDE.md Pitfall 2: guards against editor.isDestroyed before and after async awaits.
 */
export async function pasteImageFiles(
  files: File[],
  range: { from: number; to: number },
  deps: PasteImageFilesDeps
): Promise<void> {
  const { editor, sectionRef } = deps;
  if (!editor || editor.isDestroyed || files.length === 0) return;
  try {
    const id = await useNotesStore.getState().ensureMaterialized();
    if (!id) {
      emitNotice(t("editor.note_required_for_section"));
      return;
    }
    // CLAUDE.md 함정 2: ensureMaterialized await 후 파괴된 인스턴스 접근 방어
    if (editor.isDestroyed) return;
    // Paste-race guard: capture target note/section identity AFTER materialization
    // but BEFORE async awaits (FileReader + attachment_add_bytes).
    const sec = resolveSection(sectionRef);
    const target = { noteId: id, sectionId: sec?.id ?? null };
    const attachments = await Promise.all(
      files.map(async (file) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
          reader.readAsDataURL(file);
        });
        const data_base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const name = derivePasteImageName(file);
        return call<Attachment>("attachment_add_bytes", { note_id: id, name, data_base64 });
      })
    );

    // CLAUDE.md 함정 2: await 후 파괴된 인스턴스 접근 방어
    if (editor.isDestroyed) return;

    const currentSec = resolveSection(sectionRef);
    const current = {
      noteId: useNotesStore.getState().activeNote?.note.id,
      sectionId: currentSec?.id ?? null,
    };
    if (!isStillOnTarget(target, current)) {
      emitNotice(t("editor.image_paste_note_changed"));
      return;
    }

    insertImagesAtRange(editor, attachments, range);
    await useNotesStore.getState().reloadActive();
  } catch (err) {
    console.warn("image paste failed", err);
    emitNotice(t("editor.image_insert_failed"));
  }
}

/**
 * P2 3단계 링크 붙여넣기 후행 제안 (fire-and-forget, 에디터 반응성에 영향 0).
 */
export function pasteUrlSuggest(url: string): void {
  const { aiEnabled, linkSuggestions } = useSettingsStore.getState();
  if (!aiEnabled || !linkSuggestions) return;
  void (async () => {
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) return;
      await callSilent("link_suggest", { note_id: id, url });
    } catch {
      // fire-and-forget — 배경 작업 실패는 사용자에게 보일 필요가 없다.
    }
  })();
}

export interface SuggestSheetDeps {
  appendSectionLocally: (noteId: string, section: Section) => void;
  switchSection: (section: Section) => Promise<void>;
  buildSectionArgs?: (
    noteId: string,
    name: string,
    bodyMd: string,
    kind?: "text" | "diagram" | "sheet"
  ) => { note_id: string; name: string; body_md: string; kind?: "text" | "diagram" | "sheet" };
}

/**
 * 클립보드 표 붙여넣기 → "시트로 만들기" 제안 토스트 표출 및 실행.
 */
export function suggestSheetFromPaste(
  matrix: string[][],
  deps: SuggestSheetDeps
): void {
  showToastOnly(
    t("editor.paste_table_suggest_sheet"),
    () => {
      void (async () => {
        try {
          const noteId = await useNotesStore.getState().ensureMaterialized();
          if (!noteId) return;
          const { doc, truncated } = sheetFromMatrix(matrix);
          const args = deps.buildSectionArgs
            ? deps.buildSectionArgs(noteId, t("presets.sheet_name"), serializeSheet(doc), "sheet")
            : {
                note_id: noteId,
                name: t("presets.sheet_name"),
                body_md: serializeSheet(doc),
                kind: "sheet" as const,
              };
          const newSec = await call<Section>("section_create_with_body", args);
          deps.appendSectionLocally(noteId, newSec);
          markSnapshotDirty();
          await deps.switchSection(newSec);
          if (truncated) emitNotice(t("editor.section_import_truncated"));
        } catch {
          /* call() 이 AppError 토스트를 이미 표출함 */
        }
      })();
    },
    { actionLabel: t("editor.paste_table_make_sheet") }
  );
}

export interface HandlePasteDeps {
  getEditor: () => Editor | null;
  sectionRef: SectionAccessor;
  setLinkNudge: (nudge: LinkNudgeCtx | null) => void;
  appendSectionLocally: (noteId: string, section: Section) => void;
  switchSection: (section: Section) => Promise<void>;
  buildSectionArgs?: (
    noteId: string,
    name: string,
    bodyMd: string,
    kind?: "text" | "diagram" | "sheet"
  ) => { note_id: string; name: string; body_md: string; kind?: "text" | "diagram" | "sheet" };
}

/**
 * ProseMirror hook: returning false/undefined falls through to default paste chain.
 */
export function handleImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  slice: Slice,
  deps: HandlePasteDeps
): boolean {
  const editor = deps.getEditor();
  const clipboard = event.clipboardData;
  // 오너 결정(2026-09-20) — 세 붙여넣기 토글. dateNudge.ts/regionDetect.ts 와 같은 관용구로
  // 플러그인/핸들러 콜백 안에서 getState() 를 그때그때 읽는다(훅이 아니므로 구독 불필요 — 매
  // 붙여넣기 이벤트마다 다시 호출되는 함수라 다음 붙여넣기부터 바로 반영된다).
  const { pastePathInlineCode, pasteLinkNudge, pasteTableSheetSuggest } = useSettingsStore.getState();
  const files = Array.from(clipboard?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (
    shouldPasteClipboardImages({
      imageCount: files.length,
      plainText: clipboard?.getData("text/plain") ?? "",
      parsedText: slice.content.textBetween(0, slice.content.size, " "),
    })
  ) {
    event.preventDefault();
    const { from, to } = view.state.selection;
    void pasteImageFiles(files, { from, to }, { editor, sectionRef: deps.sectionRef });
    return true;
  }

  // 붙여넣은 파일 경로 자동 스타일링 — pastePathInlineCode=false 면 이 분기를 통째로 건너뛴다,
  // 그러면 아래로 떨어져 기본 붙여넣기(평문)를 탄다.
  const pastedPath = pastePathInlineCode ? soleFilePathFromPasteText(clipboard?.getData("text/plain") ?? "") : null;
  if (pastedPath && editor && !editor.isDestroyed && !editor.isActive("code") && !editor.isActive("codeBlock")) {
    event.preventDefault();
    editor
      .chain()
      .insertContent({ type: "text", text: pastedPath, marks: [{ type: "code" }] })
      .unsetMark("code")
      .run();
    return true;
  }

  // 단독 URL 붙여넣기 감지
  const url = soleUrlFromPasteText(clipboard?.getData("text/plain") ?? "");
  if (url) {
    // pasteUrlSuggest 는 AI 링크 요약 제안(aiEnabled && linkSuggestions 가 실효 게이트)이라
    // pasteLinkNudge 와는 별개 축 — pasteLinkNudge=false 여도 계속 부른다. 이 토글이 끄는 것은
    // 바로 아래 "가져올까요?" 넛지(deps.setLinkNudge) 뿐이다.
    pasteUrlSuggest(url);
    if (pasteLinkNudge && linkBodyMaybeReadable(url)) {
      requestAnimationFrame(() => {
        if (view.isDestroyed) return;
        const c = view.coordsAtPos(view.state.selection.from);
        deps.setLinkNudge({ x: c.left, y: c.bottom + 6, urls: [url] });
      });
    }
  }

  // 표 모양 클립보드(2행×2열 이상) 감지 — pasteTableSheetSuggest 는 shouldSuggestSheetFromPaste의
  // 세 번째 인자로 전달(순수 함수 안에서 스토어를 읽지 않는다). 테이블 안 matrix paste
  // (tableMatrixPaste.ts) 는 이 분기 자체를 거치지 않는 별도 플러그인이라 영향 없음.
  const tableMatrix = parseTableClipboardMatrix(clipboard?.getData("text/plain") ?? "");
  const inTable = editor && !editor.isDestroyed ? editor.isActive("table") : false;
  if (shouldSuggestSheetFromPaste(tableMatrix, inTable, pasteTableSheetSuggest)) {
    suggestSheetFromPaste(tableMatrix!, {
      appendSectionLocally: deps.appendSectionLocally,
      switchSection: deps.switchSection,
      buildSectionArgs: deps.buildSectionArgs,
    });
  }
  return false;
}

/**
 * EditorPanel 전용 붙여넣기 오케스트레이션 훅.
 * 최신 ref를 보존해 stale closure 없이 ProseMirror handlePaste 핸들러를 바인딩한다.
 */
export function useEditorPaste(
  getEditor: () => Editor | null,
  sectionRef: SectionAccessor,
  setLinkNudge: (nudge: LinkNudgeCtx | null) => void,
  appendSectionLocally: (noteId: string, section: Section) => void,
  switchSection: (section: Section) => Promise<void>,
  buildSectionArgs?: (
    noteId: string,
    name: string,
    bodyMd: string,
    kind?: "text" | "diagram" | "sheet"
  ) => { note_id: string; name: string; body_md: string; kind?: "text" | "diagram" | "sheet" }
) {
  const depsRef = useRef({
    getEditor,
    sectionRef,
    appendSectionLocally,
    switchSection,
    setLinkNudge,
    buildSectionArgs,
  });
  depsRef.current = {
    getEditor,
    sectionRef,
    appendSectionLocally,
    switchSection,
    setLinkNudge,
    buildSectionArgs,
  };

  const handlePaste = useCallback(
    (view: EditorView, event: ClipboardEvent, slice: Slice): boolean => {
      return handleImagePaste(view, event, slice, {
        getEditor: () => depsRef.current.getEditor(),
        sectionRef: () => resolveSection(depsRef.current.sectionRef),
        setLinkNudge: (n) => depsRef.current.setLinkNudge(n),
        appendSectionLocally: (noteId, s) => depsRef.current.appendSectionLocally(noteId, s),
        switchSection: (s) => depsRef.current.switchSection(s),
        buildSectionArgs: depsRef.current.buildSectionArgs,
      });
    },
    []
  );

  return {
    handlePaste,
    pasteImageFiles: (files: File[], range: { from: number; to: number }) =>
      pasteImageFiles(files, range, {
        editor: depsRef.current.getEditor(),
        sectionRef: depsRef.current.sectionRef,
      }),
    pasteUrlSuggest,
    // 두 번째 호출 지점(handleImagePaste 내부 분기가 첫 번째) — 이 훅의 반환값을 직접 쥐고 부르는
    // 호출부용. shouldSuggestSheetFromPaste 를 거치지 않고 바로 suggestSheetFromPaste(토스트를
    // 띄우는 쪽)를 부르므로, "어떤 호출 지점에서도 제안하지 않는다" 요건을 지키려면 여기서도
    // 같은 플래그를 확인해야 한다.
    suggestSheetFromPaste: (matrix: string[][]) => {
      if (!useSettingsStore.getState().pasteTableSheetSuggest) return;
      suggestSheetFromPaste(matrix, {
        appendSectionLocally: (noteId, s) => depsRef.current.appendSectionLocally(noteId, s),
        switchSection: (s) => depsRef.current.switchSection(s),
        buildSectionArgs: depsRef.current.buildSectionArgs,
      });
    },
  };
}
