import type { ReactNode } from "react";
import { IconChart, IconDoc, IconFile, IconImage, IconLink, IconMic, IconNote, IconQuote } from "../icons";
import { EXTRACTABLE_EXTS, RAW_IMAGE_EXTS, fileExt } from "../../lib/fileKinds";

/** Wave 4: kind='footnote' attachments store body text like kind=note (.md on disk) but
 * render as footnotes, not generic docs. Kind is typed as a closed union in commands.gen
 * until regen adds 'footnote' — callers pass `a.kind` (string-assignable) so this stays
 * open to the runtime value. */
export function isFootnoteKind(kind: string): boolean {
  return kind === "footnote";
}

/* Attachment tile icon rule — single owner, two call sites:
 *   • GalleryExpanded.tsx (icon for tile, when no thumb is available)
 *   • AttachmentsBar.tsx   (icon for tile body + hover-enlarge)
 *
 * The previous implementation chose the icon from `kind` alone, which means every doc-kind
 * file got IconDoc regardless of extension — a `.zip` rendered as a document. Without a
 * backend kind taxonomy (see docs/SCALABILITY.md — adding a 6th kind costs the
 * `kind <> 'internal'` index the gallery's read endpoint depends on, 373ms → 93ms), the
 * right place to disambiguate is here: check the file extension and only treat the
 * extractable document shapes (pdf/docx/txt/md/pptx — the same set the backend can extract) as
 * "document". Everything else in the doc bucket is a generic file.
 *
 * Anti-vacuity: this is the one place where the rule lives. If a refactor restores the
 * legacy kind-only mapping, `tileIcon.test.tsx` will fail on the unknown-extension cases. */
export function attachmentIcon(kind: string, name: string, size = 16): ReactNode {
  if (kind === "image") return <IconImage size={size} strokeWidth={1.8} />;
  if (kind === "audio") return <IconMic size={size} strokeWidth={1.8} />;
  if (kind === "link") return <IconLink size={size} strokeWidth={1.8} />;
  if (isFootnoteKind(kind)) return <IconQuote size={size} strokeWidth={1.8} />;
  if (kind === "internal" || kind === "note") return <IconNote size={size} strokeWidth={1.8} />;
  // 시트 차트 라이브 참조(D8: 갤러리·첨부 바 타일은 아이콘+이름, 썸네일 없음).
  if (kind === "chart") return <IconChart size={size} strokeWidth={1.8} />;
  if (kind === "doc") {
    // RAW 는 kind 가 "doc" 이지만(웹뷰가 못 그려서 이미지로 분류하지 않는다 — lib/fileKinds.ts)
    // 사용자에게는 사진이다. 아이콘까지 일반 파일로 두면 목록에서 사진을 못 찾는다.
    if (RAW_IMAGE_EXTS.has(fileExt(name))) return <IconImage size={size} strokeWidth={1.8} />;
    return EXTRACTABLE_EXTS.has(fileExt(name))
      ? <IconDoc size={size} strokeWidth={1.8} />
      : <IconFile size={size} strokeWidth={1.8} />;
  }
  return <IconFile size={size} strokeWidth={1.8} />;
}
