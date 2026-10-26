import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentQueryItem } from "../lib/commands.gen";
import { displayTitle } from "../stores/notes";
import { t } from "../i18n/t";
import { formatFileSize } from "../lib/ui";
import { IconClose, IconNote } from "../components/icons";
import { attachmentIcon } from "../components/attachments/tileIcon";
import { galleryMediaKind } from "../components/attachments/galleryKinds";
import { useBackClosable } from "./useBackClosable";

/**
 * 갤러리 첨부의 앱 안 보기(D4) — 이미지는 전체화면, 영상은 `<video>`, 그 밖의 파일은 이름·크기 + 내려받기.
 * 아래 띠에 늘 "노트 열기"가 있다(원본 노트로 가는 길). 검은 바탕·닫기 버튼은 노트 첨부 목록의 전체화면
 * 보기(MobileAttachmentList `.mobile-attach-viewer*`)와 같은 클래스를 쓴다 — 두 벌로 갈리지 않게.
 *
 * 바탕을 누르면 닫히지만, 영상 컨트롤·아래 띠를 누른 것은 바탕까지 올라가지 않는다.
 *
 * ponytail: 영상 탐색은 첨부 HTTP 라우트(+ 폰 프록시)가 Range 요청에 206 을 주는지에 달려 있다 — 안 주면
 * 처음부터 재생만 되고 뒤로 건너뛰기가 막힌다. 셸 인텐트("다른 앱으로 열기")는 범위 밖(PLAN D4).
 */
export function MobileMediaViewer({
  item,
  url,
  thumbUrl,
  onClose,
  onOpenNote,
}: {
  item: AttachmentQueryItem;
  url: string | null;
  /** 원본이 오는 동안 먼저 깔 썸네일(M-7) — 없으면 안내 문구만. */
  thumbUrl?: string | null;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
}) {
  const media = galleryMediaKind(item);
  const [origLoaded, setOrigLoaded] = useState(false);
  const [origFailed, setOrigFailed] = useState(false);

  // 안드로이드 뒤로 제스처는 이 보기만 닫는다(화면 스택으로 새지 않게) — 모달·시트와 같은 훅.
  useBackClosable(true, onClose);
  // 키보드가 붙은 태블릿·브라우저에서 Escape 로도 닫힌다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // MobileModal 과 같은 자리(.mobile-app)로 띄운다 — 화면 슬라이드(transform)·화면별 쌓임 맥락 안에 두면
  // position:fixed 가 그 상자에 갇혀 탭바 아래로 깔릴 수 있다. .mobile-app 은 --m-*/--fs 를 정의하는 곳이다.
  return createPortal(
    <div
      className="mobile-attach-viewer mobile-media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t("search.gallery_viewer")}
      data-testid="mobile-media-viewer"
      onClick={onClose}
    >
      <div className="mobile-media-viewer-stage">
        {media === "image" && url ? (
          <>
            {thumbUrl && !origLoaded && !origFailed && (
              <img src={thumbUrl} alt={item.name} className="mobile-attach-viewer-img" data-testid="mobile-media-viewer-thumb" />
            )}
            {!origFailed && (
              <img
                src={url}
                alt={item.name}
                className="mobile-attach-viewer-img"
                style={origLoaded || !thumbUrl ? undefined : { position: "absolute", opacity: 0, pointerEvents: "none" }}
                onLoad={() => setOrigLoaded(true)}
                onError={() => setOrigFailed(true)}
              />
            )}
            {!origLoaded && !origFailed && (
              <span className="mobile-media-viewer-status" role="status" data-testid="mobile-media-viewer-loading">
                {t("mobile.media_loading")}
              </span>
            )}
            {origFailed && (
              <span className="mobile-media-viewer-status" role="alert" data-testid="mobile-media-viewer-error">
                {t("mobile.media_load_failed")}
              </span>
            )}
          </>
        ) : media === "video" && url ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- user attachments carry no caption track
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            className="mobile-media-viewer-video"
            data-testid="mobile-media-viewer-video"
            onClick={stop}
          />
        ) : (
          <div className="overlay mobile-media-viewer-file" onClick={stop}>
            <span className="mobile-media-viewer-file-icon">{attachmentIcon(item.kind, item.name, 40)}</span>
            <span className="mobile-media-viewer-file-name">{item.name}</span>
            {item.size_bytes != null && (
              <span className="mobile-media-viewer-file-meta">{formatFileSize(item.size_bytes, "")}</span>
            )}
          </div>
        )}
      </div>

      <div className="overlay mobile-media-viewer-bar" onClick={stop}>
        <div className="mobile-media-viewer-bar-text">
          <div className="mobile-media-viewer-bar-name">{item.name}</div>
          <div className="mobile-media-viewer-bar-note">{displayTitle(item.title)}</div>
        </div>
        {url && (
          <a
            href={url}
            download={item.name}
            target="_blank"
            rel="noreferrer"
            className="mobile-media-viewer-btn"
            data-testid="mobile-media-viewer-download"
          >
            {t("mobile.attach_download")}
          </a>
        )}
        <button
          type="button"
          className="mobile-media-viewer-btn mobile-media-viewer-btn--primary"
          data-testid="mobile-media-viewer-open-note"
          onClick={() => onOpenNote(item.note_id)}
        >
          <IconNote size={16} strokeWidth={1.8} aria-hidden />
          {t("search.gallery_open_note")}
        </button>
      </div>

      <button
        type="button"
        className="mobile-attach-viewer-close"
        aria-label={t("common.close")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <IconClose size={22} strokeWidth={2} />
      </button>
    </div>,
    document.querySelector(".mobile-app") ?? document.body,
  );
}
