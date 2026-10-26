import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { IconChart, IconDoc, IconImage, IconLayoutGrid, IconLink, IconMic, IconNote } from "../icons";
import { ATTACHMENT_IMAGE_EXTS, ATTACHMENT_VIDEO_EXTS, UNRENDERABLE_IMAGE_EXTS, fileExt } from "../../lib/fileKinds";
import type { GalleryKindTab } from "../leftpanel/expanded/useGalleryQuery";

/* 갤러리 종류 필터의 아이콘·이름 — 데스크톱 사이드바(GalleryExpanded)와 폰(MobileGalleryView)이 같은
 * 표를 쓴다. 탭 목록 자체(GALLERY_KIND_TABS)는 쿼리 계약이라 useGalleryQuery 에 남는다. */

export function galleryKindLabel(tab: GalleryKindTab): string {
  // 키를 문자열 조립으로 만들지 않는다 — check:i18n 이 쓰이는 키를 리터럴로 찾는다.
  switch (tab) {
    case "all":
      return t("search.gallery_kind_all");
    case "image":
      return t("search.gallery_kind_image");
    case "doc":
      return t("search.gallery_kind_doc");
    case "audio":
      return t("search.gallery_kind_audio");
    case "link":
      return t("search.gallery_kind_link");
    case "note":
      return t("search.gallery_kind_note");
    case "chart":
      return t("search.gallery_kind_chart");
  }
}

export function galleryKindIcon(tab: GalleryKindTab, size = 14): ReactNode {
  const p = { size, strokeWidth: 1.8, "aria-hidden": true } as const;
  switch (tab) {
    case "all":
      return <IconLayoutGrid {...p} />;
    case "image":
      return <IconImage {...p} />;
    case "doc":
      return <IconDoc {...p} />;
    case "audio":
      return <IconMic {...p} />;
    case "link":
      return <IconLink {...p} />;
    case "note":
      return <IconNote {...p} />;
    case "chart":
      return <IconChart {...p} />;
  }
}

/** 갤러리 타일을 눌렀을 때 무엇으로 볼 수 있는가.
 *  - `none`  : 파일 본문이 없다(링크·노트·차트·참조 첨부 — rel_path NULL) → 원본 노트로 간다
 *  - `image` : 웹뷰가 그릴 수 있는 원본(HEIC·RAW 제외)
 *  - `video` : `<video>` 로 재생할 확장자
 *  - `audio` : 타일에서 바로 재생
 *  - `file`  : 그 밖의 파일 → 내려받기 */
export type GalleryMediaKind = "none" | "image" | "video" | "audio" | "file";

export function galleryMediaKind(item: { kind: string; name: string; rel_path: string | null }): GalleryMediaKind {
  if (!item.rel_path) return "none";
  if (item.kind === "audio") return "audio";
  const ext = fileExt(item.name);
  if (ATTACHMENT_VIDEO_EXTS.has(ext)) return "video";
  if (item.kind === "image" && ATTACHMENT_IMAGE_EXTS.has(ext) && !UNRENDERABLE_IMAGE_EXTS.has(ext)) return "image";
  return "file";
}
