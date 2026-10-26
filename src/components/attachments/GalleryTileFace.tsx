import type { AttachmentQueryItem } from "../../lib/commands.gen";
import { IconPlay, IconPause } from "../icons";
import { attachmentIcon } from "./tileIcon";
import { TileFilePlaceholder, fileShapeGroup, tileExtText } from "./TileFilePlaceholder";
import "../../styles/galleryTile.css";

/* 갤러리 타일의 얼굴 — 데스크톱 사이드바(GalleryExpanded)와 폰(MobileGalleryView)이 같은 그림을 쓴다.
 * 누르기·끌기·길게 누르기 같은 손짓은 각자 감싸는 버튼이 갖고, 여기는 그리기만 한다.
 *
 *  - 썸네일이 있으면 정사각을 꽉 채운 그림, 이름은 호버/포커스 때만 아래 띠로.
 *  - 없으면 작은 형식 상자(또는 링크·노트 아이콘) + 이름 한 줄(굵기 400). 예전처럼 굵은 이름 + 노트 제목을
 *    두 줄로 쌓지 않는다 — 노트 제목은 타일의 title 툴팁에 있다.
 *  - 오디오는 오른쪽 위 작은 재생/멈춤 표시. 울리는 동안은 강조색. */

function PlayGlyph({ playing }: { playing: boolean }) {
  const Icon = playing ? IconPause : IconPlay;
  return <Icon size={12} fill="currentColor" strokeWidth={0} aria-hidden />;
}

export interface GalleryTileFaceProps {
  item: AttachmentQueryItem;
  /** 그릴 그림의 URL(pickTileImageRel 규칙을 지난 것). null = 형식 자리표시. */
  src: string | null;
  /** 썸네일이 있을 때 이름 띠를 보일지(호버·포커스). 썸네일이 없으면 이름은 늘 보인다. */
  revealName?: boolean;
  /** 오디오 타일의 재생 상태 — undefined 면 재생 표시를 그리지 않는다. */
  audioPlaying?: boolean;
  nameTestId?: string;
}

export function GalleryTileFace({ item, src, revealName = false, audioPlaying, nameTestId }: GalleryTileFaceProps) {
  const shape = src ? null : fileShapeGroup(item.kind, item.name);
  const showName = !src || revealName;
  return (
    <span className="gallery-face" data-has-img={src ? "true" : undefined} data-gallery-kind={item.kind}>
      {src ? (
        <img
          src={src}
          alt={item.name}
          loading="lazy"
          decoding="async"
          className="gallery-face-img"
          style={{ objectFit: "cover" }}
        />
      ) : (
        <span className="gallery-face-glyph">
          {/* 썸네일이 없는 파일은 형식 상자(비율+확장자)로, 파일이 아닌 kind(링크·노트·각주)는
              아이콘 — 형식이 없는 것에 형식 상자를 씌우지 않는다. */}
          {shape ? (
            <TileFilePlaceholder group={shape} ext={tileExtText(item.kind, item.name).substring(0, 4)} />
          ) : (
            attachmentIcon(item.kind, item.name, 18)
          )}
        </span>
      )}
      {audioPlaying !== undefined && (
        <span className="gallery-face-play" data-playing={audioPlaying ? "true" : undefined} aria-hidden="true">
          <PlayGlyph playing={audioPlaying} />
        </span>
      )}
      {showName && (
        <span className="gallery-face-name" data-testid={nameTestId}>
          {item.name}
        </span>
      )}
    </span>
  );
}
