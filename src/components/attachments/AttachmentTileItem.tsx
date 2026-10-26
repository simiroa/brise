import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { t } from "../../i18n/t";
import type { Attachment } from "../../lib/commands.gen";
import { formatFileSize } from "../../lib/ui";
import { isBrowser } from "../../lib/env";
import { attachmentIcon } from "./tileIcon";
import { tileImageRel } from "./tileImage";
import { AttachmentTile, TileLabel } from "./AttachmentTile";
import { TileFilePlaceholder, fileShapeGroup, tileExtText } from "./TileFilePlaceholder";
import type { Tile } from "./useAttachmentActions";

interface AttachmentTileItemProps {
  attachment: Attachment;
  thumbsMap: Map<string, string>;
  baseDir: string | null;
  convertCache: ((path: string) => string) | null;
  selected: boolean;
  active: boolean;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onPointerDown?: (e: PointerEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onDelete: (e: MouseEvent, tile: Tile) => void;
  /** "섹션으로 가져오기" — 승격 가능한 첨부(fileKinds.ts::canPromoteAttachment, 데스크톱 전용)에만
   *  넘겨진다. 생략하면 이 타일은 브라우저 기본 컨텍스트 메뉴를 그대로 둔다. */
  onContextMenu?: (e: MouseEvent) => void;
}

export function AttachmentTileItem({
  attachment: a,
  thumbsMap,
  baseDir,
  convertCache,
  selected,
  active,
  onClick,
  onDoubleClick,
  onPointerDown,
  onKeyDown,
  onDelete,
  onContextMenu,
}: AttachmentTileItemProps) {
  const isImg = a.kind === "image";
  const imgRelPath = tileImageRel(a, thumbsMap);
  const ext = tileExtText(a.kind, a.name);
  const meta = `${ext} · ${a.kind === "link" ? a.url ?? "" : formatFileSize(a.size_bytes)}`;
  const tile: Tile = { kind: "attachment", attachment: a };
  /** 실제로 그릴 썸네일이 있을 때만 non-null — 나머지는 전부 형식 자리표시(참조 첨부·RAW·문서). */
  const thumbSrc = isImg && baseDir && convertCache && imgRelPath ? convertCache(`${baseDir}/${imgRelPath}`) : null;
  const shape = fileShapeGroup(a.kind, a.name);

  return (
    <AttachmentTile
      role="button"
      tabIndex={0}
      selected={selected}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      active={active}
      ariaLabel={a.name}
      title={`${a.name}\n${meta}\n${isBrowser() ? t("common.desktop_only") : t("attachments.open_hint")}`}
      color={isImg ? "var(--on-solid)" : "var(--accent)"}
      /* 이미지 타일만 배경을 갖는다 — 썸네일이 디코드되기 전 자리를 지키는 플레이스홀더라
         면(surface)이 아니다. 그 밖의 타일은 in-flow 표면이라 테두리(--divider)만 소유한다. */
      contentBackground={isImg ? "linear-gradient(135deg,var(--img-ph-a),var(--img-ph-b))" : undefined}
      onDelete={(e) => onDelete(e, tile)}
      deleteLabel={t("attachments.remove")}
      deleteStopsKeyDownPropagation
      content={
        <>
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt={a.name}
              loading="lazy"
              decoding="async"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                e.currentTarget.nextElementSibling?.removeAttribute("style");
              }}
            />
          ) : null}
          {/* 썸네일이 안 되는 파일은 형식 상자로, 파일이 아닌 kind(링크·노트·각주)는 종전대로
              아이콘+글자로 — 형식이 없는 것에 형식 상자를 씌우지 않는다. */}
          <div style={thumbSrc ? { display: "none" } : { display: "grid", placeItems: "center", maxWidth: "100%" }}>
            {shape ? (
              <TileFilePlaceholder group={shape} ext={ext.substring(0, 4)} />
            ) : (
              <TileLabel icon={attachmentIcon(a.kind, a.name, 16)} text={ext.substring(0, 4)} uppercase />
            )}
          </div>
        </>
      }
      hoverContent={
        thumbSrc ? (
          <img
            src={thumbSrc}
            alt={a.name}
            loading="lazy"
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <TileLabel icon={attachmentIcon(a.kind, a.name, 22)} text={a.name} hover />
        )
      }
    />
  );
}
