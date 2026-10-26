import type { Attachment } from "../../lib/commands.gen";
import type { ThumbsMap } from "./useAttachmentThumbs";

/* 타일에 그릴 이미지 경로를 정한다 — 이 규칙 하나가 썸네일 작업의 성패다.
   폴백이 원본이면 안 된다: 썸네일 맵이 오기 전 한 프레임만 원본을 가리켜도 브라우저가
   12메가픽셀을 디코드하고, 그 비트맵은 src 를 바꿔도 Chromium 이미지 캐시에 남는다
   (실측: <img> 를 전부 떼고 GC 를 강제해도 298MB 중 37MB 만 반환). 그래서 썸네일을
   모르는 동안에는 아무것도 그리지 않고 플레이스홀더로 둔다 — 사용자가 "노트 열고 썸네일이
   1~2초 늦게 떠도 된다"고 확정한 동작이다.
   svg 만 예외로 원본을 쓴다: 백엔드가 썸네일을 만들지 않고(디코드 불가), 벡터라 래스터
   디코드 폭증도 없다. */
export function tileImageRel(a: Attachment, thumbs: ThumbsMap): string | null {
  return pickTileImageRel(a.kind, a.rel_path, thumbs.get(a.id) ?? null);
}

/* 규칙의 단일 소유자. 첨부바는 썸네일을 별도 맵으로, 갤러리는 행에 실린 thumb_rel_path 로
   들고 오지만 판단은 하나여야 한다 — 사본이 둘이면 한쪽만 "고쳐서" 원본 폴백이 돌아온다. */
export function pickTileImageRel(
  kind: string,
  relPath: string | null | undefined,
  thumbRel: string | null | undefined,
): string | null {
  if (kind !== "image" || !relPath) return null;
  if (isSvgPath(relPath)) return relPath;
  return thumbRel ?? null;
}

function isSvgPath(rel: string): boolean {
  return rel.slice(rel.lastIndexOf(".") + 1).toLowerCase() === "svg";
}
