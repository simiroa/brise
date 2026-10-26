import { useCallback, useEffect, useRef, useState } from "react";
import { useAttachmentsBase } from "../lib/attachmentsBase";
import { pickTileImageRel } from "../components/attachments/tileImage";
import type { AttachmentQueryItem } from "../lib/commands.gen";
import { displayTitle } from "../stores/notes";
import { t } from "../i18n/t";
import { GALLERY_KIND_TABS, useGalleryQuery, type GalleryKindTab } from "../components/leftpanel/expanded/useGalleryQuery";
import { GalleryTileFace } from "../components/attachments/GalleryTileFace";
import { galleryKindIcon, galleryKindLabel, galleryMediaKind } from "../components/attachments/galleryKinds";
import { stopTileAudio, toggleTileAudio, useTileAudioPlaying } from "../components/attachments/tileAudio";
import { beginLongPress, cancelLongPress, consumeLongPress, moveLongPress } from "../lib/longPress";
import { MobileMediaViewer } from "./MobileMediaViewer";
import "../styles/mobileGallery.css";

interface MobileGalleryViewProps {
  onOpenNote: (id: string) => void;
}

/**
 * `gallery` mode — attachment grid, mobile mirror of leftpanel/expanded/GalleryExpanded.tsx.
 * Reuses `useGalleryQuery` verbatim (GALLERY_PAGE_SIZE-paged `attachment_query` +
 * `attachmentRevision` invalidation) — the ceiling here is "one page of 60 at a time".
 *
 * 열 수는 폭이 정한다(CSS grid auto-fill, 폰 최소 3열 — mobileGallery.css). 타일 얼굴은 데스크톱과 같은
 * GalleryTileFace, 종류 필터도 같은 아이콘(galleryKinds).
 *
 * 탭(D4, PLAN-2026-10-10):
 *  - 이미지(웹뷰가 그릴 수 있는 원본) → 앱 안 전체화면 보기
 *  - 영상 → 앱 안 `<video>`
 *  - 오디오 → 가운데 재생 버튼만 재생/멈춤, 나머지는 다른 타일처럼 보기 화면
 *  - 그 밖의 파일 → 보기 화면의 내려받기 링크
 *  - 파일 본문이 없는 것(링크·노트·차트·참조 첨부) → 원본 노트
 * 보기 화면에는 늘 "노트 열기"가 있다. 길게 누르면 종류와 상관없이 보기 화면(오디오가 노트로 가는 길).
 *
 * ponytail: no name-filter input (desktop's `nameQuery` debounce field) — MobileSearch already covers
 * free-text search across the whole notebook. Upgrade path: `useState` + GALLERY_FILTER_DEBOUNCE_MS,
 * wired to `useGalleryQuery`'s second argument (already plumbed for it).
 */
export function MobileGalleryView({ onOpenNote }: MobileGalleryViewProps) {
  const [kindTab, setKindTab] = useState<GalleryKindTab>("all");
  const { items, loading, hasMore, loadMore } = useGalleryQuery(kindTab, "");
  const { baseDir, convert } = useAttachmentsBase();
  const [viewing, setViewing] = useState<AttachmentQueryItem | null>(null);

  // 화면을 떠나면 미리듣기도 끝난다.
  useEffect(() => () => stopTileAudio(), []);

  const urlOf = useCallback(
    (rel: string | null) => (rel && baseDir && convert ? convert(`${baseDir}/${rel}`) : null),
    [baseDir, convert],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore();
  }, [loading, hasMore, loadMore]);

  const onTap = useCallback(
    (item: AttachmentQueryItem) => {
      const media = galleryMediaKind(item);
      if (media === "none") {
        onOpenNote(item.note_id);
        return;
      }
      stopTileAudio();
      setViewing(item);
    },
    [onOpenNote, urlOf],
  );

  // X-7: 오디오 재생은 타일 가운데의 재생 버튼 영역만. 나머지는 다른 타일처럼 보기 화면을 연다.
  const onPlay = useCallback(
    (item: AttachmentQueryItem) => {
      const url = urlOf(item.rel_path);
      if (url) toggleTileAudio(item.id, url);
    },
    [urlOf],
  );

  const onHold = useCallback(
    (item: AttachmentQueryItem) => {
      if (galleryMediaKind(item) === "none") {
        onOpenNote(item.note_id);
        return;
      }
      stopTileAudio();
      setViewing(item);
    },
    [onOpenNote],
  );

  return (
    <>
      <div className="mobile-gallery-filter" role="group" aria-label={t("search.gallery_kinds")}>
        {GALLERY_KIND_TABS.map((tab) => {
          const label = galleryKindLabel(tab);
          return (
            <button
              key={tab}
              type="button"
              className="mobile-gallery-kind"
              data-active={tab === kindTab}
              aria-pressed={tab === kindTab}
              aria-label={label}
              title={label}
              data-testid={`mobile-gallery-kind-${tab}`}
              onClick={() => setKindTab(tab)}
            >
              {galleryKindIcon(tab, 20)}
            </button>
          );
        })}
        <span className="mobile-gallery-kind-name" data-testid="mobile-gallery-kind-name">
          {galleryKindLabel(kindTab)}
        </span>
      </div>

      <div className="mobile-list mobile-gallery scroll" ref={scrollRef} onScroll={onScroll} data-testid="mobile-gallery-view">
        {items.length === 0 && !loading && <div className="mobile-empty mobile-empty--hint">{t("search.gallery_empty")}</div>}
        {items.length > 0 && (
          <div className="mobile-gallery-grid">
            {items.map((item) => (
              <MobileGalleryTile
                key={item.id}
                item={item}
                imgSrc={urlOf(pickTileImageRel(item.kind, item.rel_path, item.thumb_rel_path))}
                onTap={onTap}
                onPlay={onPlay}
                onHold={onHold}
              />
            ))}
          </div>
        )}
      </div>

      {viewing && (
        <MobileMediaViewer
          item={viewing}
          url={urlOf(viewing.rel_path)}
          thumbUrl={urlOf(viewing.thumb_rel_path)}
          onClose={() => setViewing(null)}
          onOpenNote={(id) => {
            setViewing(null);
            onOpenNote(id);
          }}
        />
      )}
    </>
  );
}

function MobileGalleryTile({
  item,
  imgSrc,
  onTap,
  onPlay,
  onHold,
}: {
  item: AttachmentQueryItem;
  imgSrc: string | null;
  onTap: (item: AttachmentQueryItem) => void;
  onPlay: (item: AttachmentQueryItem) => void;
  onHold: (item: AttachmentQueryItem) => void;
}) {
  const isAudio = galleryMediaKind(item) === "audio";
  const playing = useTileAudioPlaying(item.id);
  const playLabel = `${t(playing ? "search.gallery_pause" : "search.gallery_play")} — ${item.name}`;
  const tile = (
    <button
      type="button"
      className="gallery-tile"
      data-testid={`mobile-gallery-tile-${item.id}`}
      aria-label={item.name}
      title={`${item.name} — ${displayTitle(item.title)}`}
      onPointerDown={(e) => beginLongPress(() => onHold(item), undefined, e)}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerMove={moveLongPress}
      onClick={() => {
        if (consumeLongPress()) return;
        onTap(item);
      }}
    >
      <GalleryTileFace item={item} src={imgSrc} audioPlaying={isAudio ? playing : undefined} />
    </button>
  );
  if (!isAudio) return tile;
  return (
    <div className="mobile-gallery-tile-wrap">
      {tile}
      <button
        type="button"
        className="mobile-gallery-play"
        aria-label={playLabel}
        aria-pressed={playing}
        data-testid={`mobile-gallery-play-${item.id}`}
        onClick={() => onPlay(item)}
      />
    </div>
  );
}
