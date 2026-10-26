import {
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_VIDEO_EXTS,
  EXTRACTABLE_EXTS,
  RAW_IMAGE_EXTS,
  SECTION_SHEET_IMPORT_EXTS,
  SECTION_TEXT_IMPORT_EXTS,
  fileExt,
} from "../../lib/fileKinds";
import { isFootnoteKind } from "./tileIcon";

/* 썸네일이 없는 첨부 타일의 자리표시 — **미리보기가 아니다.**
 *
 * 썸네일이 없는 경우는 셋이다: ⓐ 참조 첨부(ext_path 만 있고 rel_path 가 NULL — 썸네일 키가
 * rel_path 규약이라 만들 수가 없다) ⓑ RAW 사진(웹뷰가 디코드 못 한다 — lib/fileKinds.ts)
 * ⓒ 애초에 이미지가 아닌 것(pdf·zip·mp4…). 셋 다 "그림처럼 보이는 무언가"를 만들면 거짓말이
 * 되므로, 여기서는 **형식이 보이는 상자**만 그린다: 갈래마다 조금씩 다른 비율의 빈 상자 +
 * 그 안의 확장자 글자.
 *
 * 변주 축은 **가로세로 비율 하나뿐이다.** 테두리·반경·틴트·글자 크기·굵기는 여섯 갈래가 전부
 * 같은 값을 쓴다 — 갈래마다 다른 그림을 그리기 시작하면 "약간씩 다른 상자"가 아니라 아이콘
 * 세트가 된다(오너 요구). 갈래를 실제로 말해주는 건 확장자 글자고, 비율은 거들 뿐이다.
 *
 * 크기가 % 가 아니라 em 인 이유: 이 컴포넌트가 놓이는 세 자리(48px 첨부 타일, 갤러리의 flex
 * 정사각 타일, 모바일 갤러리의 grid 셀)가 부모 높이를 각각 다르게 정한다 — grid/auto 높이
 * 부모에서는 % 높이가 해석되지 않는다. em 은 자기 font-size(--text-2xs, --fs 로 스케일)만
 * 보므로 어디에 놓아도 같게 그려지고, 사용자 글자 크기 설정을 따라 함께 커진다. */
export type FileShapeGroup = "doc" | "sheet" | "photo" | "video" | "audio" | "other";

/** 갈래별 상자 비율. 넓이는 여섯 갈래가 대략 같도록(약 9.9em²) 잡아 한 줄에 섞여 있어도 크기가
 *  아니라 모양이 다르게 읽힌다. 가장 넓은 audio(4.45em ≈ 40px)가 48px 타일 안에 들어간다. */
const BOX: Record<FileShapeGroup, { width: string; height: string }> = {
  doc: { width: "2.78em", height: "3.57em" }, // 0.78 — 세로로 선 종이
  other: { width: "3.15em", height: "3.15em" }, // 1.00 — 모르는 형식은 정사각(중립)
  sheet: { width: "3.52em", height: "2.82em" }, // 1.25 — 표 한 칸
  photo: { width: "3.86em", height: "2.57em" }, // 1.50 — 가로 사진
  video: { width: "4.20em", height: "2.36em" }, // 1.78 — 화면
  audio: { width: "4.45em", height: "2.23em" }, // 2.00 — 납작한 띠
};

const DOC_EXTS = new Set([...EXTRACTABLE_EXTS, ...SECTION_TEXT_IMPORT_EXTS]);
const PHOTO_EXTS = new Set([...ATTACHMENT_IMAGE_EXTS, ...RAW_IMAGE_EXTS]);

/** 첨부가 어느 갈래의 파일인가. **파일이 아닌 kind(링크·노트·내부링크·각주)는 null** — 형식이
 *  없는 것에 형식 상자를 씌우지 않는다. 호출자는 null 이면 기존 아이콘 표시를 그대로 쓴다.
 *
 *  확장자 목록은 전부 lib/fileKinds.ts 의 기존 SSOT 를 조합한 것이다(새 목록 없음). pptx 는
 *  슬라이드용 상자를 따로 두지 않고 doc 에 둔다 — 갈래가 늘수록 "약간씩 다르다"가 무너지고,
 *  슬라이드라는 사실은 상자 안 "PPTX" 가 이미 말한다. */
export function fileShapeGroup(kind: string, name: string): FileShapeGroup | null {
  if (kind === "link" || kind === "note" || kind === "internal" || kind === "chart" || isFootnoteKind(kind)) return null;
  if (kind === "audio") return "audio";
  if (kind === "image") return "photo";
  const ext = fileExt(name);
  if (PHOTO_EXTS.has(ext)) return "photo"; // RAW 는 kind 가 doc 이지만 사용자에겐 사진이다
  if (ATTACHMENT_VIDEO_EXTS.has(ext)) return "video";
  if (SECTION_SHEET_IMPORT_EXTS.has(ext)) return "sheet";
  if (DOC_EXTS.has(ext)) return "doc";
  return "other";
}

/** 타일에 쓸 확장자 글자(대문자). 확장자가 없으면 kind 로 떨어진다. 자르기는 호출자 몫 —
 *  타일 안에서는 4자로 자르지만 툴팁 메타 문자열은 온전한 값을 쓴다. */
export function tileExtText(kind: string, name: string): string {
  if (kind === "link") return "URL";
  if (kind === "note") return "NOTE";
  if (kind === "chart") return "CHART"; // 이름에 점이 있어도 확장자로 오인하지 않는다
  return (fileExt(name) || kind).toUpperCase();
}

export interface TileFilePlaceholderProps {
  group: FileShapeGroup;
  /** 이미 대문자·길이 컷이 끝난 글자(보통 tileExtText(...).slice(0, 4)). */
  ext: string;
}

/** 갈래 비율 상자 + 확장자 글자. `min-width: min-content` 는 좁은 갈래(doc)에서 네 글자
 *  ("PPTX")가 잘리는 대신 상자가 살짝 넓어지게 한다 — 비율보다 글자가 우선이다. */
export function TileFilePlaceholder({ group, ext }: TileFilePlaceholderProps) {
  return (
    <span
      data-file-group={group}
      data-file-ext={ext}
      style={{
        display: "grid",
        placeItems: "center",
        width: BOX[group].width,
        height: BOX[group].height,
        minWidth: "min-content",
        padding: "0 var(--space-2xs)",
        boxSizing: "border-box",
        fontSize: "var(--text-2xs)",
        lineHeight: 1,
        fontWeight: 600,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        /* --muted 가 아니라 --text 인 이유: 이 글자는 타일에 남은 유일한 형식 신호인데, 이미지
           자리표시 그라데이션(--img-ph-a/b) 위에서는 --muted 가 라이트 테마 기준 3.15:1 까지
           떨어진다(9px 글자에 AA 미달). --text 면 최악값이 4.51:1 로 올라오고 나머지 면에서는
           5:1 이상이다. */
        color: "var(--text)",
        background: "var(--surface-raised)",
        border: "1px solid var(--divider)",
        borderRadius: "var(--radius-xs)",
      }}
    >
      {ext}
    </span>
  );
}
