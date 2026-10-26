import type { Editor } from "@tiptap/core";
import { useEditorFileDrop } from "./useEditorFileDrop";
import { DropGhost } from "../attachments/DropGhost";
import { t } from "../../i18n/t";
import type { Section } from "../../lib/commands.gen";

export interface EditorDropOverlayProps {
  editor: Editor | null;
  sectionRef: { current: { id: string; kind?: string; [key: string]: any } | null };
  /** 히트테스트 rect — 섹션 종류와 무관하게 항상 마운트되는 EditorPanel 최상위 컨테이너
   *  (텍스트/시트/관계도 세 종류 전부 이 하나의 존을 공유한다). */
  containerEl?: HTMLElement | null;
  /** 가져오기로 새 섹션이 만들어지면 그 마지막 섹션으로 전환 — EditorPanel의 switchSection. */
  onImported?: (section: Section) => void;
}

/**
 * Editor Drag & Drop overlay:
 * Decomposed from EditorPanel to isolate drag-and-drop state transitions (dragOver)
 * so that dragging files over the editor does not cause unnecessary re-renders
 * of EditorPanel, EditorContent, or toolbar components.
 */
export function EditorDropOverlay({ editor, sectionRef, containerEl, onImported }: EditorDropOverlayProps) {
  // OS 파일 탐색기에서 섹션 영역 위로 드롭 → 확장자로 이미지/섹션 가져오기/첨부만 3갈래
  // (editor/useEditorFileDrop.ts). 텍스트/시트/관계도 세 종류 모두 이 하나의 존이 받는다 —
  // 히트테스트 rect는 EditorPanel 최상위 컨테이너(containerEl), 탭 바 위에 떨어뜨려도 받는다.
  // 첨부바(useAttachmentsDragDrop)/프리뷰 패널(usePreviewFileDrop)과는 각자 자기 rect만
  // 히트테스트해 겹치지 않는다.
  const { dragOver } = useEditorFileDrop(editor, sectionRef, containerEl, onImported);

  if (!dragOver) return null;

  // 텍스트 섹션은 캐럿 삽입 문구, 시트/관계도는 새 섹션 가져오기 문구.
  const label =
    sectionRef.current?.kind === "text"
      ? t("editor.drop_insert_hint")
      : t("editor.drop_import_hint");

  return <DropGhost testid="editor-drop-overlay" label={label} />;
}
