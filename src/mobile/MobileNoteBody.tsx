import type { Ref } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Attachment, Section } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { emitNotice } from "../lib/invoke";
import { fetchNoteSummary } from "../lib/noteSummaries";
import { PlainTextBody } from "../components/preview/shared";
// Reuse the desktop diagram component verbatim (owner brief: don't fork it). It's self-contained
// given a Section — owns its editing UI (React Flow canvas, the structured authoring controls, note
// linking via InternalNotePicker, the 되돌리기 stack), a 700ms save debounce through the SAME
// useNotesStore.updateSectionBody() prose uses, and a registerFlush hook so a pending edit is
// committed on tab/note switch (that's also how desktop's EditorPanel gets its flush guarantee for it,
// keyed by section.id; mobile keys it the same way below). Mobile therefore adds NO second copy of any
// of that — the only thing that was desktop-shaped was the SIZE and PLACEMENT of the controls, which
// `.mobile-diagram-host` retargets in styles/mobile/editor-touch.css (48px targets, 16px fields, the
// selection action rows promoted to a real bottom sheet). Duplicating the component to restyle it
// would have forked the save/undo core, so it stays single-sourced. Not ours to edit:
// src/components/diagram/**.
import { DiagramSection } from "../components/diagram/DiagramSection";
import { MobileSheetEditor } from "./MobileSheetEditor";
import { MobileImageSizeControls } from "./MobileImageSizeControls";
import { MobileAttachmentList, type PendingAttachment, type VoiceRowProps } from "./MobileAttachmentList";
import { stripHtmlForDisplay } from "./mobileEditorSupport";

interface Props {
  editor: Editor;
  /** 현재 섹션이 관계도/시트면 그 Section(아니면 null). rev 는 소스를 통째로 바꾼 뒤 다시 마운트시키는 키. */
  diagramSection: Section | null;
  diagramRev: number;
  sheetSection: Section | null;
  sheetRev: number;
  readOnly: boolean;
  /** 읽기 전용 본문 표시용 — 현재 섹션의 본문(sectionRef). 렌더 때 읽는다. */
  sectionRef: { current: { body: string } | null };
  attachments: Attachment[];
  pending: PendingAttachment[];
  onRetryUpload: (key: string) => void;
  voiceRow: VoiceRowProps;
  /** Wiki-link(note://) 탭 이동 — MobileApp 이 flushAll -> selectNote -> navigate 로 묶어 둔다. */
  onOpenNote: (id: string) => void;
  /** 스크롤 영역(.mobile-note-body-wrap) — 문장 위 말풍선(MobileNudgeBubble)이 보이는 범위·스크롤 이벤트를 여기서 읽는다. */
  scrollRef?: Ref<HTMLDivElement>;
}

/**
 * 스크롤되는 본문 영역 — 섹션 모양(관계도/시트/읽기 전용/Tiptap) 분기와 첨부 목록, note:// 링크 탭 이동.
 * Tiptap 인스턴스·섹션 상태는 부모(useMobileBodyEditor)가 쥐고, 여기는 그것을 그리기만 한다.
 */
export function MobileNoteBody({
  editor,
  diagramSection,
  diagramRev,
  sheetSection,
  sheetRev,
  readOnly,
  sectionRef,
  attachments,
  pending,
  onRetryUpload,
  voiceRow,
  onOpenNote,
  scrollRef,
}: Props) {
  /**
   * D2(오너 2026-10-10): 화면에 들어올 때 키보드를 저절로 올리지 않으므로, 쓰려면 본문을 탭한다. 글자 위 탭은 ProseMirror 가
   * 스스로 캐럿을 놓는다. 그 아래 빈 자리(글이 짧으면 화면 대부분)는 ProseMirror 밖 — 이 스크롤 상자 — 에 떨어지므로 여기서
   * 끝으로 포커스한다. 텍스트 섹션·편집 가능할 때만, 그리고 첨부 목록·버튼·링크 같은 제 할 일이 있는 것 위의 탭은 건드리지 않는다.
   */
  const focusBodyOnEmptyTap = (target: HTMLElement) => {
    if (diagramSection || sheetSection || readOnly || editor.isDestroyed) return;
    if (target.closest?.(".ProseMirror, .mobile-attach-section, button, a, input, textarea, select, [role='button']")) return;
    editor.commands.focus("end");
  };

  return (
    <div
      ref={scrollRef}
      className="mobile-note-body-wrap scroll"
      // Wiki-link tap navigation — mobile equivalent of EditorPanel.tsx's scroll-wrapper click
      // handler (desktop). Same parse (`closest('a[href^="note://"]')` + slice off the scheme),
      // same missing-note guard (fetchNoteSummary first; a stale/deleted target gets the notice
      // instead of a dead-end selectNote), same preventDefault so the webview never tries to
      // follow a note:// URL as a real link. Not extracted into a shared helper: the parse is one
      // `.slice()` call, and desktop already has two independent copies of this exact guard
      // (EditorPanel.tsx, DiagramSection.tsx openNote) — a module with a single mobile caller
      // wouldn't remove either existing duplicate. A three-file extraction is the cross-cut
      // candidate in docs/PLAN-2026-09-13-separation-of-concerns.md §4-i.
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest?.('a[href^="note://"]');
        if (!anchor) {
          focusBodyOnEmptyTap(e.target as HTMLElement);
          return;
        }
        e.preventDefault();
        const noteId = anchor.getAttribute("href")!.slice("note://".length);
        void (async () => {
          const summary = await fetchNoteSummary(noteId);
          if (!summary) {
            emitNotice(t("attachments.preview_note_unavailable"));
            return;
          }
          onOpenNote(noteId);
        })();
      }}
    >
      {diagramSection ? (
        // key={id}: DiagramSection only initializes its internal draft state from `section.body_md`
        // on mount (see its own header comment — desktop's EditorPanel relies on the exact same
        // keying for the same reason), so switching to a different diagram section MUST remount it
        // rather than update it in place, or it would keep showing the previous section's source.
        <div className="mobile-diagram-host">
          {/* touch: keep the persistent controls sheet instead of the desktop's in-picture
              bubbles (no hover on a phone, and an anchored bar would sit under the finger). Same
              verbs either way — diagram/verbs.tsx is the single source both render. */}
          <DiagramSection key={`${diagramSection.id}:${diagramRev}`} section={diagramSection} touch />
        </div>
      ) : sheetSection ? (
        <div className="mobile-sheet-host" style={{ height: "100%", minHeight: 300 }}>
          <MobileSheetEditor key={`${sheetSection.id}:${sheetRev}`} section={sheetSection} />
        </div>
      ) : readOnly ? (
        <PlainTextBody text={stripHtmlForDisplay(sectionRef.current?.body ?? "")} />
      ) : (
        <>
          <EditorContent editor={editor} className="mdbody" />
          <BubbleMenu
            editor={editor}
            appendTo={() => document.body}
            options={{ strategy: "fixed", placement: "top", offset: 8 }}
            shouldShow={({ editor: ed }: any) => ed.isActive("image")}
            className="overlay mobile-image-bubble"
          >
            {/* Same 3-step control as the top toolbar — single source (MobileImageSizeControls). */}
            <MobileImageSizeControls editor={editor} />
          </BubbleMenu>
        </>
      )}

      {/* Independent of body markup — renders (and upload above still works) even for a
          read-only/unsupported-body note (owner brief). */}
      <MobileAttachmentList attachments={attachments} pending={pending} onRetry={onRetryUpload} voice={voiceRow} />
    </div>
  );
}
