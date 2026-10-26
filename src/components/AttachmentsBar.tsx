import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNotesStore, displayTitle } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import type { Attachment } from "../lib/commands.gen";
import type { PreviewItem } from "../stores/ui";
import { t } from "../i18n/t";
import { isBrowser } from "../lib/env";
import { canPromoteAttachment } from "../lib/fileKinds";
import { call, emitNotice } from "../lib/invoke";
import { openAttachmentExternal } from "../lib/attachmentOpen";
import { useUiStore } from "../stores/ui";
import { useAttachmentsBase } from "../lib/attachmentsBase";
import { TILE } from "./attachments/AttachmentTile";
import { useAttachmentActions, type Tile } from "./attachments/useAttachmentActions";
import { useRelatedTiles } from "./attachments/useRelatedTiles";
import { useAttachmentThumbs } from "./attachments/useAttachmentThumbs";
import { useNoteRegions, useNoteRelatedHiddenCount } from "../lib/noteMeta";
import { isFootnoteKind } from "./attachments/tileIcon";
import { useAttachmentsDragDrop } from "./attachments/useAttachmentsDragDrop";
import { DropGhost } from "./attachments/DropGhost";
import { dedupeWaypoints, type PrimaryRegion, type WaypointRegion } from "./attachments/regionDisplay";
import { noteDropTargetProps, registerNoteDropHandler } from "../lib/noteDrag";
import { LinkNudge, type LinkNudgeCtx } from "./common/LinkNudge";
import { useSelectionStore } from "../stores/selection";
import { reportBatch } from "../lib/batchActions";
import { SelectionActionBar, SelectionActionButton } from "./SelectionActionBar";
import { AttachmentDialogs, type AttachmentDialogState } from "./attachments/AttachmentDialogs";
import { IconTrash } from "./icons";
import { scheduleUndoableDelete } from "../lib/undo";
import { AttachmentsBarEmpty } from "./attachments/AttachmentsBarEmpty";
import { AttachmentsBarHeader } from "./attachments/AttachmentsBarHeader";
import { AttachmentsTilesStrip } from "./attachments/AttachmentsTilesStrip";
import { preloadPreviewFor } from "./PreviewAttachment";
import { RelatedTilesStrip } from "./attachments/RelatedTilesStrip";
import { useSuggestionsStore } from "../stores/suggestions";
import { ContextMenuShell } from "./common/ContextMenuShell";
import { AttachmentContextMenu } from "./attachments/AttachmentContextMenu";
import { appendSectionWithBody, importFilesAsSections } from "../lib/noteActions";
// 승격 후 새 탭에 잠깐 켜지는 "도착" 글로우 신호 — 읽기 전용 사용(이 세션 범위 밖 파일, 편집 금지).
// SectionTabBar.tsx의 SectionTabItem이 마운트 시 이 값을 소비한다.
import { setPendingAiInsertId } from "../lib/aiSectionBridge";

type Dialog = AttachmentDialogState;

/**
 * Whether a pointer-note drop onto the attachments card (targetId "related") should create
 * an internal link. Exported for unit tests (target guard + self/duplicate guards). Handlers
 * are global — every registered drop handler runs on every drop, so targetId must be filtered here.
 */
export function shouldAcceptRelatedNoteDrop(
  noteId: string,
  targetId: string,
  activeNoteId: string | null | undefined,
  attachments: Attachment[],
): boolean {
  if (targetId !== "related") return false;
  if (!activeNoteId) return false;
  if (noteId === activeNoteId) return false;
  if (attachments.some((a) => a.kind === "internal" && a.url === noteId)) return false;
  return true;
}

/** Issue 3: the dropzone must always be visible (editor bottom), with a teaching empty state
 * when no note is active, and real OS file-path drag & drop (getCurrentWebview().onDragDropEvent —
 * HTML5 drag events do not carry real file paths under Tauri). */
export function AttachmentsBar() {
  const activeNote = useNotesStore((s) => s.activeNote);
  const sources = activeNote?.sources ?? [];
  const attachments = activeNote?.attachments ?? [];
  // internal-kind attachments are manual "Notes liées" links, not Pièces jointes tiles.
  // footnote-kind rows are collapsed into ONE synthetic tile below (owner decision) — a note with
  // 12 footnotes used to bury its real attachments under 12 near-identical "FN" tiles.
  const tileAttachments = attachments.filter((a) => a.kind !== "internal" && !isFootnoteKind(a.kind));
  const footnoteCount = attachments.filter((a) => isFootnoteKind(a.kind)).length;
  const {
    attachmentsCollapsed,
    toggleAttachmentsCollapsed,
    attachmentsTab,
    previewItem,
    setPreviewItem,
  } = useUiStore(
    useShallow((s) => ({
      attachmentsCollapsed: s.attachmentsCollapsed,
      toggleAttachmentsCollapsed: s.toggleAttachmentsCollapsed,
      attachmentsTab: s.attachmentsTab,
      previewItem: s.previewItem,
      setPreviewItem: s.setPreviewItem,
    }))
  );
  // W24: 1줄 스트립의 빈공간 드래그 패닝 — 타일이 넘치면 가로 스크롤(스크롤바는 noscroll로
  // 숨김)로 보되, 타일/버튼 위 드래그는 각자의 동작(클릭·이미지 드래그)에 양보한다.
  const panStrip = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startLeft = el.scrollLeft;
    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const uiLock = useSettingsStore((s) => s.uiLock);
  // Owner spec (6차 QA): clicking the tile that's already active in the preview panel closes
  // it (own-inverse toggle — same re-click-to-clear convention as calendar day pick / tag
  // select); clicking a different tile (or none active) opens/switches to it as before.
  const isPreviewActive = (item: PreviewItem) => {
    if (!previewItem) return false;
    if (item.kind === "section") {
      return previewItem.kind === "section" && previewItem.sectionId === item.sectionId;
    }
    // 각주는 노트당 목록 뷰 하나뿐 — focusId(본문 마커가 실어 보내는 스크롤 대상)가 달라도
    // "그 화면이 열려 있다"는 사실은 같으므로 타일은 계속 활성이다.
    if (item.kind === "footnotes") return previewItem.kind === "footnotes";
    if (previewItem.kind === "section" || previewItem.kind === "footnotes") return false;
    return previewItem.kind === item.kind && previewItem.id === item.id;
  };
  const togglePreviewItem = (item: PreviewItem) => setPreviewItem(isPreviewActive(item) ? null : item);
  // Debounce single-click toggle (~var(--dur-slow)) so a double-click (OS open / rename) is not counted
  // as click×2 and does not open-then-close the preview. Same pattern as useRelatedClickPreview.
  const previewClickTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = previewClickTimers.current;
    return () => {
      timers.forEach((tm) => clearTimeout(tm));
      timers.clear();
    };
  }, []);
  const previewTileKey = (item: PreviewItem) =>
    item.kind === "section"
      ? `section:${item.sectionId}`
      : item.kind === "footnotes"
        ? "footnotes"
        : `${item.kind}:${item.id}`;
  const cancelScheduledPreviewToggle = (key: string) => {
    const tm = previewClickTimers.current.get(key);
    if (tm !== undefined) {
      clearTimeout(tm);
      previewClickTimers.current.delete(key);
    }
  };
  const schedulePreviewToggle = (item: PreviewItem) => {
    preloadPreviewFor(item, activeNote);
    const key = previewTileKey(item);
    cancelScheduledPreviewToggle(key);
    const tm = setTimeout(() => {
      previewClickTimers.current.delete(key);
      togglePreviewItem(item);
    }, 250);
    previewClickTimers.current.set(key, tm);
  };
  const onPreviewTileDoubleClick = (item: PreviewItem, action: () => void) => {
    cancelScheduledPreviewToggle(previewTileKey(item));
    action();
  };
  const previewToggleKeyDown = (item: PreviewItem) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    // Keyboard has no double-click race — toggle immediately (tests + a11y).
    cancelScheduledPreviewToggle(previewTileKey(item));
    togglePreviewItem(item);
  };
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // "섹션으로 가져오기" 승격 메뉴 — SectionTabBar.tsx의 sectionCtx와 같은 관용구
  // (ContextMenuShell + menu-row menu-item), AttachmentsBar 전용 상태.
  const [promoteCtx, setPromoteCtx] = useState<{ tile: Tile; x: number; y: number } | null>(null);
  // 파일 첨부 타일 우클릭 메뉴(열기·폴더에서 보기·이름 바꾸기·삭제) — 갤러리와 같은 AttachmentContextMenu.
  const [attachCtx, setAttachCtx] = useState<{ tile: Tile; x: number; y: number } | null>(null);
  // 링크 첨부 타일 우클릭 → 에디터와 **같은** 링크 넛지(common/LinkNudge.tsx). 이미 저장해 둔
  // 링크도 추출/정리에 닿아야 한다(오너 2026-09-10). 승격 메뉴로 합치지 않은 이유: 링크는
  // 파일 승격(rel_path + section_import_file)과 갈래가 완전히 달라 같은 메뉴 항목이 아니고,
  // 넛지 쪽엔 이미 raw/AI/브라우저 세 행이 있다.
  const [linkNudge, setLinkNudge] = useState<LinkNudgeCtx | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // W22 ⑤→W24: 상단 그립은 이제 접기 전용 — 2줄 확장(attachmentsRows)은 세로 스크롤바를
  // 만들어 폐기(오너). 스트립은 항상 1줄이고 넘치는 타일은 가로 패닝으로 본다.
  const [attachDragCollapsing, setAttachDragCollapsing] = useState(false);
  const ATTACH_DRAG_THRESHOLD = TILE / 2;
  const ATTACH_COLLAPSE_ENTER = ATTACH_DRAG_THRESHOLD;
  const ATTACH_COLLAPSE_EXIT = ATTACH_DRAG_THRESHOLD - 8;
  const onAttachResizeDown = (e: React.MouseEvent) => {
    if (uiLock) return;
    e.preventDefault();
    const startY = e.clientY;
    let collapsing = false;
    document.body.style.cursor = "ns-resize";
    const finish = () => {
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const nowCollapsing = collapsing ? dy > ATTACH_COLLAPSE_EXIT : dy > ATTACH_COLLAPSE_ENTER;
      if (nowCollapsing !== collapsing) {
        collapsing = nowCollapsing;
        setAttachDragCollapsing(nowCollapsing);
      }
    };
    const onUp = () => {
      finish();
      if (collapsing) {
        setAttachDragCollapsing(false);
        if (!useUiStore.getState().attachmentsCollapsed) {
          useUiStore.setState({ attachmentsCollapsed: true });
        }
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const { baseDir, convert: convertCache } = useAttachmentsBase();
  // Bumps after note_related_exclude / note_related_restore so useAutoRelated re-fetches and
  // the hidden count (useNoteRelatedHiddenCount) re-reads.
  const [relatedRefreshKey, setRelatedRefreshKey] = useState(0);
  const bumpRelatedRefresh = () => setRelatedRefreshKey((k) => k + 1);

  // Attachment CRUD (add*/removeTile) + the busy/pendingRemovedIds state they share.
  const {
    busy,
    setBusy,
    pendingRemovedIds,
    setPendingRemovedIds,
    addOneFile,
    renameSource,
    addFile,
    addLink,
    addNote,
    addInternal,
    addFromClipboard,
    removeTile,
    removeTiles,
  } = useAttachmentActions(activeNote, setDialog);

  /* ── W7-g 다중선택 (첨부) ── */
  const selectedTileIds = useSelectionStore((s) => s.attachments.ids);
  const clickAttachment = useSelectionStore((s) => s.clickAttachment);
  const pruneAttachments = useSelectionStore((s) => s.pruneAttachments);
  const clearAttachments = useSelectionStore((s) => s.clearAttachments);
  const keepAttachments = useSelectionStore((s) => s.keepAttachments);
  const [batchBusy, setBatchBusy] = useState(false);

  // "Notes liées" tab: merged manual/auto related notes + click-debounce preview/open handlers.
  const { relatedTiles, openRelatedNote, scheduleRelatedPreview } = useRelatedTiles(
    activeNote,
    pendingRemovedIds,
    relatedRefreshKey,
  );

  const thumbsMap = useAttachmentThumbs(activeNote?.note.id);

  // OS-level file-path drag & drop (Tauri) — depends on addOneFile's extraction-policy routing.
  const { dragOver } = useAttachmentsDragDrop(barRef, addOneFile, setBusy);

  // Note-row drops onto the attachments card
  useEffect(() => {
    return registerNoteDropHandler((noteId, targetId) => {
      const current = useNotesStore.getState().activeNote;
      const atts = current?.attachments ?? [];
      if (!shouldAcceptRelatedNoteDrop(noteId, targetId, current?.note.id, atts)) return;
      useUiStore.setState({ attachmentsTab: "related", attachmentsCollapsed: false });
      void useNotesStore
        .getState()
        .ensureNoteSummaries([noteId])
        .then((map) => {
          const target = map.get(noteId);
          if (target) void addInternal(noteId, target.title);
        });
    });
  }, [addInternal]);

  // Tier 1 undo-on-delete
  const realTiles: Tile[] = [
    ...sources.map((source): Tile => ({ kind: "source", source })),
    ...tileAttachments.map((attachment): Tile => ({ kind: "attachment", attachment })),
  ].filter((tile) => {
    const id = tile.kind === "source" ? tile.source.id : tile.kind === "attachment" ? tile.attachment.id : null;
    return id ? !pendingRemovedIds.has(id) : true;
  });

  const regionPrimary: PrimaryRegion = {
    region: activeNote?.note.region ?? null,
    lat: activeNote?.note.lat ?? null,
    lng: activeNote?.note.lng ?? null,
  };
  const regionHasPrimary = Boolean(regionPrimary.region) || (regionPrimary.lat != null && regionPrimary.lng != null);
  // 제목줄 지역 칩·지역 감지와 같은 캐시(lib/noteMeta.ts) — 노트를 열 때 note_regions_list 는 한 번.
  const regionWaypoints = useNoteRegions(activeNote?.note.id).regions;

  const regionWaypointsVisible: WaypointRegion[] = dedupeWaypoints(
    regionPrimary,
    regionWaypoints.map(
      (r): WaypointRegion => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, position: r.position }),
    ),
  );

  const regionTile: Tile | null =
    activeNote && (regionHasPrimary || regionWaypoints.length > 0) ? { kind: "region" } : null;

  const footnotesTile: Tile | null = footnoteCount > 0 ? { kind: "footnotes" } : null;

  const hiddenCount = useNoteRelatedHiddenCount(activeNote?.note.id, relatedRefreshKey);
  const tiles: Tile[] = [
    ...(regionTile ? [regionTile] : []),
    ...(footnotesTile ? [footnotesTile] : []),
    ...realTiles,
  ];

  const selectableTileIds = tiles
    .map((tile) => (tile.kind === "source" ? tile.source.id : tile.kind === "attachment" ? tile.attachment.id : null))
    .filter((id): id is string => id !== null);
  const selectableKey = selectableTileIds.join(",");

  useEffect(() => {
    pruneAttachments(selectableKey ? selectableKey.split(",") : []);
  }, [selectableKey, pruneAttachments]);

  useEffect(() => {
    if (selectedTileIds.length === 0) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") clearAttachments();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTileIds.length, clearAttachments]);

  const selectedTileIdSet = new Set(selectedTileIds);

  const handleTileSelectClick = (id: string, e: React.MouseEvent): boolean => {
    const mods = { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
    if (!mods.toggle && !mods.range) {
      if (selectedTileIds.length > 0) clearAttachments();
      return false;
    }
    e.preventDefault();
    clickAttachment(id, mods, selectableTileIds);
    return true;
  };

  const runDeleteSelected = () =>
    void (async () => {
      const targets = tiles.filter((tile) =>
        selectedTileIdSet.has(tile.kind === "source" ? tile.source.id : tile.kind === "attachment" ? tile.attachment.id : ""),
      );
      setBatchBusy(true);
      const res = await removeTiles(targets);
      setBatchBusy(false);
      reportBatch(res);
      keepAttachments(res.failed);
    })();

  const onOpenAttachment = (id: string) => openAttachmentExternal(id);

  /**
   * "섹션으로 가져오기" 승격 — 우클릭 메뉴 클릭 시.
   * 사료: body가 이미 프런트에 있으므로 section_create_with_body 하나로 끝난다
   * (noteActions.ts::appendSectionWithBody, 파일을 다시 읽지 않는다).
   * 첨부: rel_path + baseDir 로 절대 경로를 만들어 기존 파일 가져오기 배치
   * (importFilesAsSections)를 그대로 태운다 — 두 번째 구현을 만들지 않는다. hwpx 가 서식형
   * (doc_import_html)으로 가는 갈래도 그 배치 안에서 정해지므로 여기서는 확장자를 보지 않는다.
   * 두 갈래 모두 새로 만든 섹션 id를 setPendingAiInsertId 에 실어 탭에 "도착" 글로우를 준다 —
   * AttachmentsBar는 EditorPanel의 형제 컴포넌트라 activeSectionId(EditorPanel 로컬 상태)를
   * 직접 바꿀 수 없다(TitleBar "…" 다중 가져오기도 같은 제약으로 탭을 강제 전환하지 않는다).
   */
  const runPromoteTile = async (tile: Tile) => {
    if (!activeNote) return;
    const noteId = activeNote.note.id;
    try {
      if (tile.kind === "source") {
        const section = await appendSectionWithBody(noteId, tile.source.name, tile.source.body);
        setPendingAiInsertId(section.id);
        emitNotice(t("editor.section_promoted_from_source", { name: tile.source.name }));
        return;
      }
      if (tile.kind === "attachment" && tile.attachment.rel_path && baseDir) {
        const absPath = `${baseDir}/${tile.attachment.rel_path}`;
        const sections = await importFilesAsSections(noteId, [absPath]);
        if (sections[0]) setPendingAiInsertId(sections[0].id);
      }
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함(useSectionActions.ts의 handleAddSection과 같은
       * 관례) — 여기서 되돌릴 낙관적 상태가 없어(§9) 조용히 삼킨다. */
    }
  };

  if (!activeNote) {
    return <AttachmentsBarEmpty barRef={barRef} dragOver={dragOver} />;
  }

  return (
    <div
      ref={barRef}
      data-testid="attachments-drop-target"
      {...noteDropTargetProps("related")}
      style={{
        flex: "none",
        margin: 0,
        borderTop: "1px solid var(--divider)",
        outline: dragOver ? "2px solid var(--accent)" : "2px solid transparent",
        outlineOffset: -2,
        overflow: "hidden",
        opacity: busy ? 0.75 : 1,
        transition: "outline-color var(--dur-med) ease",
        position: "relative",
      }}
    >
      {dragOver && <DropGhost testid="attachments-drop-overlay" label={t("attachments.drop_hint")} />}
      {!attachmentsCollapsed && !uiLock && (
        <div
          className="attach-rgrip"
          data-testid="attachments-resize-grip"
          onMouseDown={onAttachResizeDown}
          style={{
            height: 7,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "ns-resize",
          }}
        >
          <div className="rbar" style={{ width: 40, height: 2 }} />
        </div>
      )}
      <AttachmentsBarHeader
        attachmentsCollapsed={attachmentsCollapsed}
        attachmentsTab={attachmentsTab}
        busy={busy}
        itemCount={attachmentsTab === "related" ? relatedTiles.length : tiles.length}
        hiddenCount={hiddenCount}
        onToggleCollapse={toggleAttachmentsCollapsed}
        onExpand={() => useUiStore.setState({ attachmentsCollapsed: false })}
        onSelectTab={(tab) => useUiStore.setState({ attachmentsTab: tab, attachmentsCollapsed: false })}
        onRestoreHidden={async () => {
          await call("note_related_restore", { id: activeNote.note.id });
          bumpRelatedRefresh();
        }}
      />

      {!attachmentsCollapsed && attachmentsTab === "attachments" && (
        <AttachmentsTilesStrip
          activeNote={activeNote}
          tiles={tiles}
          footnoteCount={footnoteCount}
          regionPrimary={regionPrimary}
          regionWaypointsVisible={regionWaypointsVisible}
          selectedTileIdSet={selectedTileIdSet}
          thumbsMap={thumbsMap}
          baseDir={baseDir}
          convertCache={convertCache}
          attachDragCollapsing={attachDragCollapsing}
          panStrip={panStrip}
          isPreviewActive={isPreviewActive}
          togglePreviewItem={togglePreviewItem}
          schedulePreviewToggle={schedulePreviewToggle}
          previewToggleKeyDown={previewToggleKeyDown}
          onPreviewTileDoubleClick={onPreviewTileDoubleClick}
          handleTileSelectClick={handleTileSelectClick}
          onAddFile={() => void addFile()}
          onOpenNoteDialog={() => setDialog({ kind: "note" })}
          onOpenLinkDialog={() => setDialog({ kind: "link" })}
          onPasteClipboard={() => void addFromClipboard()}
          onRenameSource={(source) => setDialog({ kind: "renameSource", source })}
          onOpenAttachment={onOpenAttachment}
          onRemoveTile={(e, tile) => void removeTile(e, tile)}
          onPromoteContextMenu={(e, tile) => setPromoteCtx({ tile, x: e.clientX, y: e.clientY })}
          onAttachmentContextMenu={(e, tile) => setAttachCtx({ tile, x: e.clientX, y: e.clientY })}
          onLinkContextMenu={(e, url) => setLinkNudge({ x: e.clientX, y: e.clientY, urls: [url] })}
        />
      )}

      <LinkNudge ctx={linkNudge} onClose={() => setLinkNudge(null)} />
      {attachCtx && attachCtx.tile.kind === "attachment" && (
        <AttachmentContextMenu
          x={attachCtx.x}
          y={attachCtx.y}
          attachment={attachCtx.tile.attachment}
          onClose={() => setAttachCtx(null)}
          onDelete={(e) => void removeTile(e, attachCtx.tile)}
          // 첨부 승격은 데스크톱 전용(브라우저 모드는 baseDir 가 HTTP 접두사라 파일 경로가 아니다 —
          // attachmentsBase.ts 주석) + 확장자가 section_import_file 지원 목록 안일 때만.
          extra={
            !isBrowser() && canPromoteAttachment(attachCtx.tile.attachment.rel_path) ? (
              <button
                type="button"
                className="menu-row menu-item"
                data-testid="promote-tile-to-section"
                onClick={() => {
                  const { tile } = attachCtx;
                  setAttachCtx(null);
                  void runPromoteTile(tile);
                }}
                style={{ color: "inherit" }}
              >
                <span>{t("ctx.promote_to_section")}</span>
              </button>
            ) : null
          }
        />
      )}
      <ContextMenuShell anchor={promoteCtx} onClose={() => setPromoteCtx(null)} minWidth={180}>
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="promote-tile-to-section"
          onClick={() => {
            if (!promoteCtx) return;
            const { tile } = promoteCtx;
            setPromoteCtx(null);
            void runPromoteTile(tile);
          }}
          style={{ color: "inherit" }}
        >
          <span>{t("ctx.promote_to_section")}</span>
        </button>
      </ContextMenuShell>

      {!attachmentsCollapsed && attachmentsTab === "related" && (
        <RelatedTilesStrip
          relatedTiles={relatedTiles}
          attachDragCollapsing={attachDragCollapsing}
          panStrip={panStrip}
          onSchedulePreview={scheduleRelatedPreview}
          onOpenNote={openRelatedNote}
          onOpenInternalDialog={() => setDialog({ kind: "internal" })}
          onDeleteManual={(e, tile) => void removeTile(e, tile)}
          onExcludeAuto={(e, noteId, displayName) => {
            e.stopPropagation();
            setPendingRemovedIds((prev) => new Set(prev).add(noteId));
            scheduleUndoableDelete({
              commit: async () => {
                try {
                  await call("note_related_exclude", { id_1: activeNote.note.id, id_2: noteId });
                  bumpRelatedRefresh();
                } finally {
                  setPendingRemovedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(noteId);
                    return next;
                  });
                }
              },
              onRestore: () => {
                setPendingRemovedIds((prev) => {
                  const next = new Set(prev);
                  next.delete(noteId);
                  return next;
                });
              },
              label: t("undo.deleted_named", { name: displayName }),
            });
          }}
          onAcceptSuggestion={async (e, tile) => {
            e.stopPropagation();
            if (tile.kind !== "auto" || !tile.suggestion) return;
            const targetId = tile.note.id;
            const targetTitle = tile.note.title;
            try {
              await useSuggestionsStore
                .getState()
                .acceptSuggestion(tile.suggestion.id, activeNote.note.id, targetId, targetTitle);
              emitNotice(t("related.connected_notice", { name: displayTitle(targetTitle) }));
              bumpRelatedRefresh();
            } catch (err: unknown) {
              emitNotice((err as Error)?.message ?? String(err));
            }
          }}
        />
      )}

      {selectedTileIds.length >= 2 && attachmentsTab === "attachments" && (
        <SelectionActionBar
          count={selectedTileIds.length}
          onClear={clearAttachments}
          busy={batchBusy}
          placement="inline"
        >
          <SelectionActionButton
            label={t("selection.delete")}
            icon={<IconTrash size={14} strokeWidth={1.8} />}
            onClick={() => setDialog({ kind: "confirmDeleteSelected" })}
            disabled={batchBusy}
            danger
            testid="selection-attachment-delete"
          />
        </SelectionActionBar>
      )}

      <AttachmentDialogs
        dialog={dialog}
        activeNoteId={activeNote.note.id}
        selectedTileCount={selectedTileIds.length}
        onClose={() => setDialog(null)}
        onAddLink={(url, name) => void addLink(url, name)}
        onAddNote={(name, text) => void addNote(name, text)}
        onAddInternal={(noteId, title) => void addInternal(noteId, title)}
        onRenameSource={(id, name) => void renameSource(id, name)}
        onDeleteSelected={() => runDeleteSelected()}
      />
    </div>
  );
}
