import { useSettingsStore } from "../../../stores/settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, type RowComponentProps } from "react-window";
import { call } from "../../../lib/invoke";
import { openAttachmentExternal } from "../../../lib/attachmentOpen";
import { useAttachmentsBase } from "../../../lib/attachmentsBase";
import { usePendingDelay } from "../../../lib/usePendingDelay";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import type { AttachmentQueryItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { IconClose, IconSearch } from "../../icons";
import { GalleryTileFace } from "../../attachments/GalleryTileFace";
import { galleryKindIcon, galleryKindLabel } from "../../attachments/galleryKinds";
import { formatDuration, playTileAudio, stopTileAudio, useAudioDuration, useTileAudioPlaying } from "../../attachments/tileAudio";
import { PendingIndicator } from "../../common/PendingIndicator";
import {
  GALLERY_GAP,
  galleryColumnCount,
  galleryRowHeight,
  packGalleryRows,
} from "./galleryLayout";
import { useElementSize } from "../../../lib/useElementSize";
import { pickTileImageRel } from "../../attachments/tileImage";
import { startNoteDrag } from "../../../lib/noteDrag";
import { AttachmentContextMenu } from "../../attachments/AttachmentContextMenu";
import {
  GALLERY_FILTER_DEBOUNCE_MS,
  GALLERY_KIND_TABS,
  type GalleryKindTab,
  useGalleryQuery,
} from "./useGalleryQuery";

/** 호버 미리듣기 시작까지 머무는 시간(U-10). */
const HOVER_PLAY_DWELL_MS = 300;

interface FilterIconButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

function FilterIconButton({ icon, label, active, onClick, testId }: FilterIconButtonProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: "none",
        width: "var(--ctrl-h-sm)",
        height: "var(--ctrl-h-sm)",
        padding: 0,
        border: "none",
        outline: "none",
        background: "transparent",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        transition: "color var(--dur-fast), filter var(--dur-fast), opacity var(--dur-fast)",
        color: active ? "var(--accent)" : hovered ? "var(--text)" : "var(--muted)",
        opacity: active ? 1 : hovered ? 1 : 0.65,
        filter: active
          ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))"
          : hovered
          ? "drop-shadow(0 0 2px color-mix(in srgb, var(--accent) 45%, transparent))"
          : "none",
      }}
    >
      {icon}
    </button>
  );
}

function noteSubtitle(item: AttachmentQueryItem): string {
  const title = displayTitle(item.title ?? "");
  if (item.year != null && item.year !== 0) return `${title} · ${item.year}`;
  return title;
}

export interface GalleryTileProps {
  item: AttachmentQueryItem;
  baseDir: string | null;
  convert: ((path: string) => string) | null;
  /** noteId + attachment id — attachment id drives Aperçu previewItem. */
  onSelectNote: (noteId: string, attachmentId: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, item: AttachmentQueryItem) => void;
}

/** Single attachment cell — exported for tests and image rule checks. */
export function GalleryTile({
  item,
  baseDir,
  convert,
  onSelectNote,
  onOpen,
  onContextMenu,
}: GalleryTileProps) {
  // 설정 › 첨부파일 › 파일 이름 항상 표시 — 꺼져 있으면 호버·포커스 때만 이름이 드러난다(기존 동작).
  const showNames = useSettingsStore((s) => s.galleryShowNames);
  const imgRel = pickTileImageRel(item.kind, item.rel_path, item.thumb_rel_path);
  const src =
    imgRel && baseDir && convert ? convert(`${baseDir}/${imgRel}`) : null;
  // 오디오는 호버하는 동안 바로 듣는다(떠나면 멈춤) — 소리 엔진은 tileAudio 의 하나뿐인 <audio>.
  const audioSrc =
    item.kind === "audio" && item.rel_path && baseDir && convert ? convert(`${baseDir}/${item.rel_path}`) : null;
  const audioPlaying = useTileAudioPlaying(item.id);

  /* 드래그가 이미지 정체를 끝까지 들고 간다 — 캔버스에선 이미지 아이템, 이미지를 받는
     위젯에선 이미지 아티팩트가 된다. 넘기는 건 **원본 rel 경로**(썸네일이 아니다): 공간
     이미지 아이템의 source_id 와 같은 규약이라 참조만으로 끝나고 파일 복사가 없다.
     그릴 썸네일이 없으면(imgRel === null) 갈라지지 않고 기존대로 노트로 떨어진다 —
     문서·오디오 첨부와 아직 썸네일이 안 생긴 이미지가 여기에 해당한다. */
  const dragImage =
    imgRel && item.rel_path ? { sourceId: item.rel_path, title: item.name } : undefined;

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const duration = useAudioDuration(item.id, audioSrc, hovered);
  // U-10: 훑기·휠로 지나가는 타일이 연달아 울리지 않게, 300ms 머문 뒤에만 재생한다.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => clearHoverTimer, []);

  return (
    <button
      type="button"
      className="gallery-tile"
      data-testid={`gallery-tile-${item.id}`}
      data-gallery-kind={item.kind}
      // Deliberately no artificial delay to suppress single click before double click;
      // opening the note then the file on double click is intended and keeps single click responsive.
      onClick={() => onSelectNote(item.note_id, item.id)}
      onDoubleClick={() => onOpen(item.id)}
      onPointerDown={(e) => {
        // 누르면(선택·끌기) 미리듣기는 끝난다 — 노트를 옮기는 중에 소리가 따라다니지 않게. 끝까지
        // 들으려면 선택 후 프리뷰의 첨부 재생기를 쓴다.
        clearHoverTimer();
        if (audioSrc) stopTileAudio(item.id);
        startNoteDrag(e, item.note_id, item.name, { image: dragImage });
      }}
      onContextMenu={(e) => onContextMenu(e, item)}
      onMouseEnter={() => {
        setHovered(true);
        if (audioSrc) {
          clearHoverTimer();
          hoverTimer.current = setTimeout(() => playTileAudio(item.id, audioSrc), HOVER_PLAY_DWELL_MS);
        }
      }}
      onMouseLeave={() => {
        setHovered(false);
        clearHoverTimer();
        if (audioSrc) stopTileAudio(item.id);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      title={`${item.name}${duration != null ? ` · ${formatDuration(duration)}` : ""}\n${noteSubtitle(item)}`}
      /* 정사각은 CSS(.gallery-tile 의 flex:1 + aspect-ratio)가 보장한다. JS 로 한 변을 계산해
         width/height 에 박으면 스크롤바가 생기는 순간 어긋난다 — 실측: 래퍼 299px 로 계산한 85px
         타일이 실제 내부폭 262px 안에서 flex 로 82px 까지 눌려 82×85 가 됐다(높이만 명시값이라 안 눌림).
         tileWidth 는 react-window 행 슬롯 추정에만 쓰인다. */
    >
      <GalleryTileFace
        item={item}
        src={src}
        revealName={hovered || focused || showNames}
        audioPlaying={audioSrc ? audioPlaying : undefined}
        nameTestId={`gallery-tile-meta-${item.id}`}
      />
    </button>
  );
}

interface GridRowProps {
  rows: AttachmentQueryItem[][];
  cols: number;
  baseDir: string | null;
  convert: ((path: string) => string) | null;
  onSelectNote: (noteId: string, attachmentId: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, item: AttachmentQueryItem) => void;
}

function GalleryGridRow({
  index,
  style,
  rows,
  cols,
  baseDir,
  convert,
  onSelectNote,
  onOpen,
  onContextMenu,
}: RowComponentProps<GridRowProps>): React.ReactElement | null {
  const row = rows[index];
  if (!row) return null;

  return (
    <div
      style={{
        ...style,
        display: "flex",
        gap: GALLERY_GAP,
        // stretch 면 타일 높이가 행 슬롯으로 늘어나 aspect-ratio 를 덮어쓴다.
        alignItems: "flex-start",
        paddingLeft: "var(--sidebar-pad)",
        paddingRight: "var(--sidebar-pad)",
        boxSizing: "border-box",
      }}
    >
      {row.map((item) => (
        <GalleryTile
          key={item.id}
          item={item}
          baseDir={baseDir}
          convert={convert}
          onSelectNote={onSelectNote}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
        />
      ))}
      {/* Pad incomplete last row so tiles keep equal width. */}
      {Array.from({ length: Math.max(0, cols - row.length) }).map((_, i) => (
        <div key={`pad-${i}`} style={{ flex: 1, minWidth: 0 }} />
      ))}
    </div>
  );
}

/**
 * Workspace gallery: type tabs, name filter, virtualised attachment grid.
 * Single click selects the source note in workspace; double click opens attachment via `attachment_open`.
 * Right click opens the shared AttachmentContextMenu (open / reveal / rename / remove).
 */
export function GalleryExpanded() {
  const [selectedTabs, setSelectedTabs] = useState<Set<GalleryKindTab>>(new Set(["all"]));
  const [lastClickedTab, setLastClickedTab] = useState<GalleryKindTab>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    item: AttachmentQueryItem;
    x: number;
    y: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const tm = window.setTimeout(() => setNameQuery(draft), GALLERY_FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(tm);
  }, [draft]);

  const handleTabClick = useCallback(
    (tab: GalleryKindTab, e: React.MouseEvent<HTMLButtonElement>) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      if (tab === "all") {
        setSelectedTabs(new Set(["all"]));
        setLastClickedTab("all");
        return;
      }

      if (isShift && lastClickedTab) {
        const lastIdx = GALLERY_KIND_TABS.indexOf(lastClickedTab);
        const curIdx = GALLERY_KIND_TABS.indexOf(tab);
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        const next = new Set(isCtrl ? selectedTabs : []);
        next.delete("all");
        for (let i = start; i <= end; i++) {
          const t = GALLERY_KIND_TABS[i];
          if (t !== "all") next.add(t);
        }
        const contentTabs = GALLERY_KIND_TABS.filter((t) => t !== "all");
        if (contentTabs.every((t) => next.has(t)) || next.size === 0) {
          setSelectedTabs(new Set(["all"]));
        } else {
          setSelectedTabs(next);
        }
        setLastClickedTab(tab);
        return;
      }

      if (isCtrl) {
        const next = new Set(selectedTabs);
        if (next.has("all")) {
          next.clear();
          next.add(tab);
        } else {
          if (next.has(tab)) {
            next.delete(tab);
          } else {
            next.add(tab);
          }
        }
        const contentTabs = GALLERY_KIND_TABS.filter((t) => t !== "all");
        if (next.size === 0 || contentTabs.every((t) => next.has(t))) {
          setSelectedTabs(new Set(["all"]));
        } else {
          setSelectedTabs(next);
        }
        setLastClickedTab(tab);
        return;
      }

      setSelectedTabs(new Set([tab]));
      setLastClickedTab(tab);
    },
    [lastClickedTab, selectedTabs],
  );

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      return next;
    });
  }, []);

  const tileSize = useSettingsStore((s) => s.galleryTileSize);
  const gallerySort = useSettingsStore((s) => s.gallerySort);
  const { items, loading, hasMore, loadMore } = useGalleryQuery(selectedTabs, nameQuery, gallerySort);
  const { baseDir, convert } = useAttachmentsBase();
  const selectNote = useNotesStore((s) => s.selectNote);
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);
  const showPending = usePendingDelay(loading, 150);

  const wrapRef = useRef<HTMLDivElement>(null);
  const { height: listHeight, width: listWidth } = useElementSize(wrapRef, {
    height: 160,
    width: 160,
  });

  const visibleItems = useMemo(
    () => items.filter((item) => !removedIds.has(item.id)),
    [items, removedIds],
  );

  const cols = galleryColumnCount(listWidth, tileSize);
  // 행 슬롯 높이 추정치. 타일 자체는 flex + aspect-ratio 로 항상 정사각이므로 이 값이 몇 px
  // 어긋나도 정사각은 안 깨지고 행 사이 여백만 그만큼 달라진다(스크롤바 폭 ~9px 이 그 차이).
  const rowHeight = galleryRowHeight(listWidth, cols);
  const rows = useMemo(() => packGalleryRows(visibleItems, cols), [visibleItems, cols]);

  const onSelectNote = useCallback(
    (noteId: string, attachmentId: string) => {
      // previewItem is never cleared elsewhere — set it even while selectNote is in flight;
      // PreviewAttachment shows the select-hint until activeNote.attachments resolve.
      setPreviewItem({ kind: "attachment", id: attachmentId });
      selectNote(noteId);
    },
    [selectNote, setPreviewItem],
  );

  const onOpen = useCallback((id: string) => openAttachmentExternal(id), []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent, item: AttachmentQueryItem) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ item, x: e.clientX, y: e.clientY });
    },
    [],
  );

  // We choose optimistic local removal over page-0 refetch because optimistic removal provides
  // instant visual feedback and preserves the user's scroll position and loaded pages, whereas
  // resetting the query to page 0 discards paged results and scrolls back to top.
  const handleRemove = useCallback((item: AttachmentQueryItem) => {
    setRemovedIds((prev) => new Set(prev).add(item.id));
    void (async () => {
      try {
        await call("attachment_remove", { id: item.id });
        useNotesStore.getState().reloadActive();
      } catch {
        // attachment_remove 가 실패하면 첨부는 DB·디스크에 그대로 남아 있다 — 낙관적으로 숨긴
        // removedIds 를 되돌리지 않으면 파일은 살아있는데 화면에서만 영구히 사라져 사용자에게
        // 거짓말하게 된다. 방금 누른 삭제가 실패했다는 걸 사용자가 알아야 하므로 call() 을
        // 유지해 에러 토스트를 그대로 띄우고, 여기서는 롤백만 한다(try/catch 로 rejection 처리 —
        // call 뒤 catch 체이닝 안티패턴 금지).
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    })();
  }, []);

  const closeCtxMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const onRowsRendered = useCallback(
    (visible: { startIndex: number; stopIndex: number }) => {
      if (!hasMore || loading) return;
      if (visible.stopIndex >= rows.length - 2) {
        loadMore();
      }
    },
    [hasMore, loading, rows.length, loadMore],
  );

  const rowProps: GridRowProps = useMemo(
    () => ({
      rows,
      cols,
      baseDir,
      convert,
      onSelectNote,
      onOpen,
      onContextMenu,
    }),
    [rows, cols, baseDir, convert, onSelectNote, onOpen, onContextMenu],
  );

  return (
    <div
      data-testid="view-gallery"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      <PendingIndicator active={showPending} />

      <div
        style={{
          flex: "none",
          padding: "var(--space-4) var(--sidebar-pad) var(--space-2)",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <div
          role="group"
          aria-label={t("search.gallery_kinds")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          {GALLERY_KIND_TABS.map((tab) => (
            <FilterIconButton
              key={tab}
              icon={galleryKindIcon(tab)}
              label={galleryKindLabel(tab)}
              active={selectedTabs.has(tab)}
              onClick={(e) => handleTabClick(tab, e)}
              testId={`gallery-kind-${tab}`}
            />
          ))}
          <FilterIconButton
            icon={<IconSearch size={14} strokeWidth={1.8} aria-hidden />}
            label={t("search.gallery_filter_placeholder")}
            active={searchOpen || draft.trim().length > 0}
            onClick={toggleSearch}
            testId="gallery-search-toggle"
          />
        </div>

        {/* Search input: toggled via search button, keeps DOM node for tests & instant show */}
        <div
          style={{
            display: searchOpen || draft ? "flex" : "none",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-1) var(--space-2)",
            border: "1px solid var(--divider)",
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, var(--surface) 60%, transparent)",
            boxSizing: "border-box",
            width: "100%",
          }}
        >
          <IconSearch size={13} strokeWidth={1.8} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <input
            ref={searchInputRef}
            data-testid="gallery-name-filter"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (draft) setDraft("");
                else setSearchOpen(false);
              }
            }}
            placeholder={t("search.gallery_filter_placeholder")}
            aria-label={t("search.gallery_filter_placeholder")}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: "var(--text-xs)",
              padding: 0,
            }}
          />
          {draft && (
            <button
              type="button"
              onClick={() => setDraft("")}
              title={t("search.clear")}
              aria-label={t("search.clear")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--muted)",
                cursor: "pointer",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <IconClose size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div
        ref={wrapRef}
        // Gap above the first row must be a margin, not padding: useElementSize reads
        // clientHeight initially (includes padding) and contentRect afterwards (excludes
        // it), so padding here would make the two measurements disagree.
        style={{ flex: 1, minHeight: 0, position: "relative", width: "100%", marginTop: "var(--space-2)" }}
      >
        {visibleItems.length === 0 && !loading ? (
          <div
            data-testid="gallery-empty"
            style={{
              padding: "var(--space-6) var(--sidebar-pad)",
              color: "var(--faint)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
            }}
          >
            {t("search.gallery_empty")}
          </div>
        ) : (
          <List
            className="scroll scroll--slim"
            rowComponent={GalleryGridRow}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowProps={rowProps}
            overscanCount={3}
            onRowsRendered={onRowsRendered}
            defaultHeight={listHeight}
            style={{ height: listHeight, width: "100%" }}
          />
        )}
      </div>

      {ctxMenu && (
        <AttachmentContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          attachment={ctxMenu.item}
          onClose={closeCtxMenu}
          onDelete={() => handleRemove(ctxMenu.item)}
        />
      )}
    </div>
  );
}
