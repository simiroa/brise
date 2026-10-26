import type { ReactNode, DragEvent, RefObject } from "react";

interface AskAiAttachmentDropzoneProps {
  isDragging: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  children: ReactNode;
  /** 네이티브 OS 드래그&드롭(useFileDropZone)이 이 div의 사각형을 재는 자리 — HTML5
   *  onDrop(브라우저 File)이 붙은 그 요소와 같은 컨테이너를 공유한다. */
  dropRef?: RefObject<HTMLDivElement | null>;
}

/**
 * 드롭 영역(PLAN-2026-09-15 §4) — 테두리 없는 배치 래퍼. 옛 "빠른 액션" 버튼 3개는 `/` 메뉴와 타일이
 * 대체해 뺐고, 첨부 파일 칩 줄은 컨텍스트 줄의 file 칩과 중복이라 뺐다(2026-09-26 — 상자가 두 겹으로
 * 보이던 바깥 테두리와 함께). 드래그 중 신호는 안쪽 요청문 상자가 진다(tokens.css .askai-dropzone).
 */
export function AskAiAttachmentDropzone({ isDragging, onDragOver, onDragLeave, onDrop, children, dropRef }: AskAiAttachmentDropzoneProps) {
  return (
    <div
      ref={dropRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="askai-dropzone"
      data-dragging={isDragging || undefined}
    >
      {children}
    </div>
  );
}
