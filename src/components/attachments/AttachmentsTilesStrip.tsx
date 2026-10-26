import type { MouseEvent as ReactMouseEvent, KeyboardEvent, PointerEvent } from "react";
import { t } from "../../i18n/t";
import type { NoteDetail, Source } from "../../lib/commands.gen";
import type { PreviewItem } from "../../stores/ui";
import { GhostAddButton } from "./GhostAddButton";
import { attachmentAddItems } from "./attachmentAddItems";
import { AttachmentsEmptyState } from "./AttachmentsEmptyState";
import { RegionTileItem } from "./RegionTileItem";
import { FootnotesTileItem } from "./FootnotesTileItem";
import { SourceTileItem } from "./SourceTileItem";
import { AttachmentTileItem } from "./AttachmentTileItem";
import type { PrimaryRegion, WaypointRegion } from "./regionDisplay";
import type { Tile } from "./useAttachmentActions";
import { startAttachmentImageDrag } from "./attachmentImageDrag";

interface AttachmentsTilesStripProps {
  activeNote: NoteDetail;
  tiles: Tile[];
  footnoteCount: number;
  regionPrimary: PrimaryRegion;
  regionWaypointsVisible: WaypointRegion[];
  selectedTileIdSet: Set<string>;
  thumbsMap: Map<string, string>;
  baseDir: string | null;
  convertCache: ((path: string) => string) | null;
  attachDragCollapsing: boolean;
  panStrip: (e: ReactMouseEvent<HTMLDivElement>) => void;
  isPreviewActive: (item: PreviewItem) => boolean;
  togglePreviewItem: (item: PreviewItem) => void;
  schedulePreviewToggle: (item: PreviewItem) => void;
  previewToggleKeyDown: (item: PreviewItem) => (e: KeyboardEvent<HTMLDivElement>) => void;
  onPreviewTileDoubleClick: (item: PreviewItem, action: () => void) => void;
  handleTileSelectClick: (id: string, e: ReactMouseEvent) => boolean;
  onAddFile: () => void;
  onOpenNoteDialog: () => void;
  onOpenLinkDialog: () => void;
  onPasteClipboard: () => void;
  onRenameSource: (source: Source) => void;
  onOpenAttachment: (id: string) => void;
  onRemoveTile: (e: ReactMouseEvent, tile: Tile) => void;
  /** "섹션으로 가져오기" 승격 메뉴 열기 — 사료/승격 가능한 첨부 타일에서만 호출된다
   *  (canPromoteAttachment 로 이 컴포넌트가 첨부 타일 자격을 직접 가른다). */
  onPromoteContextMenu: (e: ReactMouseEvent, tile: Tile) => void;
  /** 파일 첨부(링크 제외) 타일 우클릭 — 열기·폴더에서 보기·이름 바꾸기·삭제 메뉴(AttachmentContextMenu)를 부모가 띄운다. */
  onAttachmentContextMenu: (e: ReactMouseEvent, tile: Tile) => void;
  /** 링크 첨부 타일 우클릭 — 에디터와 같은 링크 넛지를 부모가 그 좌표에 띄운다.
   *  승격(파일 경로 → section_import_file)과는 갈래가 달라 콜백도 따로 둔다. */
  onLinkContextMenu: (e: ReactMouseEvent, url: string) => void;
}

export function AttachmentsTilesStrip({
  activeNote,
  tiles,
  footnoteCount,
  regionPrimary,
  regionWaypointsVisible,
  selectedTileIdSet,
  thumbsMap,
  baseDir,
  convertCache,
  attachDragCollapsing,
  panStrip,
  isPreviewActive,
  togglePreviewItem,
  schedulePreviewToggle,
  previewToggleKeyDown,
  onPreviewTileDoubleClick,
  handleTileSelectClick,
  onAddFile,
  onOpenNoteDialog,
  onOpenLinkDialog,
  onPasteClipboard,
  onRenameSource,
  onOpenAttachment,
  onRemoveTile,
  onPromoteContextMenu,
  onAttachmentContextMenu,
  onLinkContextMenu,
}: AttachmentsTilesStripProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: attachDragCollapsing ? 0 : "var(--space-2) var(--space-5) var(--space-5)",
        minHeight: attachDragCollapsing ? 0 : "var(--row-strip)",
        maxHeight: attachDragCollapsing ? 0 : "var(--row-strip)",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        className="scroll noscroll"
        onMouseDown={panStrip}
        style={{
          display: "flex",
          flexWrap: "nowrap",
          alignItems: "flex-start",
          gap: "var(--space-3)",
          overflowX: "auto",
          minWidth: 0,
        }}
      >
        {tiles.length === 0 && (
          <AttachmentsEmptyState
            onAddFile={onAddFile}
            onAddNote={onOpenNoteDialog}
            onAddLink={onOpenLinkDialog}
            onPasteClipboard={onPasteClipboard}
          />
        )}
        {tiles.map((tile) => {
          if (tile.kind === "region") {
            const regionItem: PreviewItem = { kind: "region", id: activeNote.note.id };
            return (
              <RegionTileItem
                key="region-virtual"
                item={regionItem}
                regionPrimary={regionPrimary}
                regionWaypointsVisible={regionWaypointsVisible}
                active={isPreviewActive(regionItem)}
                onTogglePreview={togglePreviewItem}
                onKeyDown={previewToggleKeyDown(regionItem)}
              />
            );
          }
          if (tile.kind === "footnotes") {
            const footnotesItem: PreviewItem = { kind: "footnotes" };
            return (
              <FootnotesTileItem
                key="footnotes-virtual"
                item={footnotesItem}
                footnoteCount={footnoteCount}
                active={isPreviewActive(footnotesItem)}
                onSchedulePreview={schedulePreviewToggle}
                onKeyDown={previewToggleKeyDown(footnotesItem)}
              />
            );
          }
          if (tile.kind === "source") {
            const s = tile.source;
            const sourceItem: PreviewItem = { kind: "source", id: s.id };
            return (
              <SourceTileItem
                key={`source-${s.id}`}
                source={s}
                selected={selectedTileIdSet.has(s.id)}
                active={isPreviewActive(sourceItem)}
                onClick={(e) => {
                  if (handleTileSelectClick(s.id, e)) return;
                  schedulePreviewToggle(sourceItem);
                }}
                onDoubleClick={() =>
                  onPreviewTileDoubleClick(sourceItem, () => onRenameSource(s))
                }
                onKeyDown={previewToggleKeyDown(sourceItem)}
                onDelete={onRemoveTile}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onPromoteContextMenu(e, tile);
                }}
              />
            );
          }

          const a = tile.attachment;
          const isImg = a.kind === "image";
          const attachmentItem: PreviewItem = { kind: "attachment", id: a.id };
          // 링크 첨부는 디스크 파일이 없어 canPromoteAttachment 가 항상 false 다(lib/fileKinds.ts
          // 의 계약 — rel_path 가 있어야 한다). 그래서 예전엔 링크 타일 우클릭이 아무 일도 하지
          // 않았다. 그 함수를 넓히지 않고 여기서 갈래를 하나 더 둔다: 링크는 파일 승격이 아니라
          // 넛지로 간다(추출·AI 정리·브라우저에서 열기).
          const linkUrl = a.kind === "link" && a.url ? a.url : null;
          return (
            <AttachmentTileItem
              key={`attachment-${a.id}`}
              attachment={a}
              thumbsMap={thumbsMap}
              baseDir={baseDir}
              convertCache={convertCache}
              selected={selectedTileIdSet.has(a.id)}
              active={isPreviewActive(attachmentItem)}
              onClick={(e) => {
                if (handleTileSelectClick(a.id, e)) return;
                schedulePreviewToggle(attachmentItem);
              }}
              onPointerDown={isImg && a.rel_path ? (e: PointerEvent) => startAttachmentImageDrag(e, a) : undefined}
              onDoubleClick={() =>
                onPreviewTileDoubleClick(attachmentItem, () => onOpenAttachment(a.id))
              }
              onKeyDown={previewToggleKeyDown(attachmentItem)}
              onDelete={onRemoveTile}
              onContextMenu={(e) => {
                e.preventDefault();
                // 링크는 파일 메뉴가 아니라 넛지(추출·AI 정리·브라우저에서 열기)로 간다.
                if (linkUrl) onLinkContextMenu(e, linkUrl);
                else onAttachmentContextMenu(e, tile);
              }}
            />
          );
        })}
        {tiles.length > 0 && (
          <GhostAddButton
            label={t("attachments.empty_hint")}
            items={attachmentAddItems(
              {
                onAddFile,
                onAddNote: onOpenNoteDialog,
                onAddLink: onOpenLinkDialog,
                onPasteClipboard,
              },
              14,
              1.9,
            )}
          />
        )}
      </div>
    </div>
  );
}
