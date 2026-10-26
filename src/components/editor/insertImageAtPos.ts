import type { Editor } from "@tiptap/core";
import { IMAGE_WIDTH_DEFAULT, formatImageWidth } from "./imageResize";

/** attachment_add_file 응답 전체가 아니라 이미지 노드가 실제로 쓰는 두 필드만. */
export interface ImageAttachmentLike {
  name: string;
  rel_path?: string | null;
}

const imageContent = (attachment: ImageAttachmentLike) => ({
  type: "image",
  attrs: {
    alt: attachment.name,
    relPath: attachment.rel_path ?? null,
    width: formatImageWidth(IMAGE_WIDTH_DEFAULT),
  },
});

/**
 * OS 파일 드롭(useEditorFileDrop)과 첨부바 이미지 드래그(attachments/attachmentImageDrag)가
 * 공유하는 이미지 노드 삽입 모양 — 문서 크기를 넘는 pos는 클램프하고, 파괴된 인스턴스에는
 * 아무것도 하지 않는다(CLAUDE.md 함정 2).
 */
export function insertImageAtPos(editor: Editor, attachment: ImageAttachmentLike, pos: number): void {
  if (editor.isDestroyed) return;
  const docSize = editor.state.doc.content.size;
  const clampedPos = Math.min(pos, docSize);
  editor
    .chain()
    .focus()
    .insertContentAt(clampedPos, imageContent(attachment))
    .run();
}

/** Clipboard image batches replace the range captured at paste time in one ordered transaction. */
export function insertImagesAtRange(
  editor: Editor,
  attachments: ImageAttachmentLike[],
  range: { from: number; to: number },
): void {
  if (editor.isDestroyed || attachments.length === 0) return;
  const docSize = editor.state.doc.content.size;
  const from = Math.min(range.from, docSize);
  const to = Math.max(from, Math.min(range.to, docSize));
  editor.chain().focus().insertContentAt({ from, to }, attachments.map(imageContent)).run();
}
