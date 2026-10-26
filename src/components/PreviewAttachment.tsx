import React, { useState, Suspense } from "react";
import { useUiStore } from "../stores/ui";
import { useNotesStore, displayTitle } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAttachmentsBase } from "../lib/attachmentsBase";
import { t } from "../i18n/t";
import { IconMic, IconAi, IconSummary } from "./icons";
import { centeredHintStyle, NoFormatFallback } from "./preview/shared";
import { chipStyle } from "./leftpanel/yearfilter/shared";
import type { AskAiTarget } from "./AskAiModal";
import { runMetadataProposal, runNoteSummary } from "./ai/askAiHelpers";
import { ensureAiAskGate } from "../stores/ai";
import { openAttachmentExternal } from "../lib/attachmentOpen";
import { resolvePreviewItem } from "../lib/previewResolver";
import type { Attachment, NoteDetail } from "../lib/commands.gen";
import type { PreviewItem } from "../stores/ui";
import { isFootnoteKind } from "./attachments/tileIcon";
import { ATTACHMENT_VIDEO_EXTS, fileExt } from "../lib/fileKinds";













function footnoteAttachments(attachments: Attachment[]): Attachment[] {
  return attachments
    .filter((a) => isFootnoteKind(a.kind))
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * N1-3 (owner 2026-07-31): "미리보기에서 여러 개가 노출되고 추가도 되는 식의 경험" — map +
 * full list + add/remove/reorder, all in one preview screen. NoteRegionsList used to live
 * permanently in AttachmentsBar (eating vertical space in the tile strip); it's a self-contained,
 * props-only component so moving it here is a straight lift, not a rewrite. It bumps
 * attachmentRevision on every mutation (see NoteRegionsList.tsx) — this component's own waypoint
 * fetch (for the map) depends on that same counter, so the map and the list never drift apart.
 *
 * Card width is user-resizable and can get narrow (owner note) — map and list stack vertically
 * (flex column) rather than side-by-side so neither gets clipped or overlapped.
 */


import { AudioAttachmentPlayer } from "./attachments/AudioAttachmentPlayer";
import { ErrorBoundary } from "./common/ErrorBoundary";
import { SourcePreview, NotePreview, SectionPreview, ImagePreview, LinkReaderPreview, InternalNotePreview, DocPreview, VideoPreview, FootnotePreview, RegionPreview, ChartRefPreview, AskAiModal } from "../lazySurfaces";

/**
 * 이 항목을 그릴 지연 미리보기 하나만 미리 받는다 — 아래 PreviewAttachmentContent 의 렌더 분기와 **같은
 * 갈래**다(한쪽을 바꾸면 다른 쪽도). 첨부 바 타일은 더블클릭과 가르려고 250ms 뒤에 토글하므로
 * (AttachmentsBar.schedulePreviewToggle) 그 사이에 받아 두면 첫 미리보기가 대기 화면을 건너뛴다.
 */
export function preloadPreviewFor(item: PreviewItem, activeNote: NoteDetail | null): void {
  const resolved = resolvePreviewItem(item, activeNote);
  if (!resolved) return;
  const surface = (() => {
    switch (resolved.kind) {
      case "section": return SectionPreview;
      case "source": return SourcePreview;
      case "note": return NotePreview;
      case "footnotes": return FootnotePreview;
      case "region": return RegionPreview;
      case "attachment": {
        const att = activeNote?.attachments.find((a) => a.id === resolved.id);
        if (!att) return null;
        if (att.kind === "image") return ImagePreview;
        if (att.kind === "link") return LinkReaderPreview;
        if (att.kind === "internal") return InternalNotePreview;
        if (att.kind === "chart") return ChartRefPreview;
        if (att.kind === "doc" && ATTACHMENT_VIDEO_EXTS.has(fileExt(att.name))) return VideoPreview;
        if (att.kind === "doc" || att.kind === "note") return DocPreview;
        return null;
      }
    }
  })();
  void surface?.preload();
}

function PreviewAttachmentContent() {
  const previewItem = useUiStore((s) => s.previewItem);
  const theme = useSettingsStore((s) => s.theme);
  const activeNote = useNotesStore((s) => s.activeNote);
  const selectNote = useNotesStore((s) => s.selectNote);
  const { baseDir, convert } = useAttachmentsBase();
  // Owner Q6: nothing selected in the preview + AI on + a note open → an "AI 정리" suggestion card
  // instead of the plain hint (below). aiEnabled/askAiTarget live up here (not inside the `!resolved`
  // branch) only because hooks can't be conditional — the modal itself only ever renders from
  // within that branch, the one place this card lives.
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);

  const resolved = resolvePreviewItem(previewItem, activeNote);

  if (!resolved) {
    if (aiEnabled && activeNote) {
      const noteId = activeNote.note.id;
      const noteTitle = displayTitle(activeNote.note.title);
      const openAskAi = () => {
        void (async () => {
          if (!(await ensureAiAskGate())) return;
          setAskAiTarget({ kind: "note", noteId, noteTitle });
        })();
      };
      return (
        <div style={{ ...centeredHintStyle, flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: "var(--text-md)", color: "var(--faint)" }}>
            {t("attachments.preview_ai_hint")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
            <button type="button" onClick={() => void runMetadataProposal(noteId)} style={{ ...chipStyle(false), gap: 6 }}>
              <IconAi size={13} strokeWidth={1.8} />
              <span>{t("ai.action_default_name_metadata")}</span>
            </button>
            <button type="button" onClick={() => void runNoteSummary(noteId)} style={{ ...chipStyle(false), gap: 6 }}>
              <IconSummary size={13} strokeWidth={1.8} />
              <span>{t("ai.summarize")}</span>
            </button>
            <button type="button" onClick={openAskAi} style={{ ...chipStyle(false), gap: 6 }}>
              <IconAi size={13} strokeWidth={1.8} />
              <span>{t("ai.ask_ai")}</span>
            </button>
          </div>
          {askAiTarget && (
            <Suspense fallback={null}>
              <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
            </Suspense>
          )}
        </div>
      );
    }
    return (
      <div style={centeredHintStyle}>
        {t("attachments.preview_select_hint")}
      </div>
    );
  }

  return (
    <React.Suspense fallback={null}>
      {resolved.kind === "section" && (
        <SectionPreview noteId={resolved.noteId} sectionId={resolved.sectionId} />
      )}
      {resolved.kind === "source" && (() => {
        const src = activeNote?.sources.find((s) => s.id === resolved.id);
        return src ? <SourcePreview src={src} /> : null;
      })()}
      {resolved.kind === "note" && (
        <NotePreview noteId={resolved.id} />
      )}
      {resolved.kind === "footnotes" && (
        <FootnotePreview
          footnotes={footnoteAttachments(activeNote?.attachments ?? [])}
          focusId={resolved.focusId}
        />
      )}
      {resolved.kind === "region" && activeNote && (
        <RegionPreview
          noteId={activeNote.note.id}
          primary={{
            region: activeNote.note.region,
            lat: activeNote.note.lat,
            lng: activeNote.note.lng,
          }}
        />
      )}
      {(() => {
        const targetId = "id" in resolved ? resolved.id : undefined;
        const att = targetId ? activeNote?.attachments.find((a) => a.id === targetId) : undefined;
        if (!att) return null;
        if (att.kind === "image") return <ImagePreview att={att} baseDir={baseDir} convert={convert} />;
        if (att.kind === "link") return activeNote ? <LinkReaderPreview att={att} noteId={activeNote.note.id} /> : null;
        if (att.kind === "internal") return <InternalNotePreview att={att} onSelectNote={selectNote} />;
        // 시트 차트 라이브 참조 — 파일이 없고 activeNote.sections 의 시트 본문에서 매번 다시 그린다.
        if (att.kind === "chart") return <ChartRefPreview att={att} />;
        // 동영상은 kind 가 아니라 확장자로 갈린다(lib/fileKinds.ts 주석) — pdf·html 과 같은 자리다.
        // DocPreview 안이 아니라 여기서 갈라내는 이유: DocPreview 는 "문서" 세 종류를 그리는 곳이고
        // 동영상은 그 셋과 공유할 것이 없다(텍스트 조회도, 테마 전달도 필요 없다).
        if (att.kind === "doc" && ATTACHMENT_VIDEO_EXTS.has(fileExt(att.name)))
          return <VideoPreview att={att} baseDir={baseDir} convert={convert} />;
        if (att.kind === "doc" || att.kind === "note") return <DocPreview att={att} baseDir={baseDir} convert={convert} theme={theme} />;
        if (att.kind === "audio") {
          if (!baseDir || !convert || !att.rel_path) {
            return (
              <NoFormatFallback
                icon={<IconMic size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />}
                onOpenExternal={() => openAttachmentExternal(att.id)}
              />
            );
          }
          return (
            <div style={{ padding: "var(--space-6)", display: "flex", justifyContent: "center" }}>
              <AudioAttachmentPlayer
                attachment={att}
                src={convert(`${baseDir}/${att.rel_path}`)}
                onOpenExternal={() => openAttachmentExternal(att.id)}
              />
            </div>
          );
        }
        return null;
      })()}
    </React.Suspense>
  );

  return (
    <div style={centeredHintStyle}>
      {t("attachments.preview_select_hint")}
    </div>
  );
}

export function PreviewAttachment() {
  return (
    <ErrorBoundary>
      <PreviewAttachmentContent />
    </ErrorBoundary>
  );
}
