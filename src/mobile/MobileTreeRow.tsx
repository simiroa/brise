import type { Folder, NoteSummary } from "../lib/commands.gen";
import { displayTitle } from "../stores/notes";
import { t } from "../i18n/t";
import { IconNote, IconFolder, IconFolderOpen, IconStar, IconCaret, IconTrash, IconArchive, IconCheckMark } from "../components/icons";
import { noteIconComp } from "../lib/noteIcons";
import { HighlightedText, splitByQuery, splitSnippet } from "../components/leftpanel/notetree/highlight";
import { TreeRowBadges } from "../components/leftpanel/notetree/TreeRowBadges";
import type { TreeRow } from "../components/leftpanel/notetree/rows";
import { beginLongPress, cancelLongPress, consumeLongPress, moveLongPress } from "../lib/longPress";
import { useSettingsStore } from "../stores/settings";
import { formatCompactDate } from "./compactDate";
import { MobileNote } from "../lazySurfaces";

interface MobileTreeRowProps {
  row: TreeRow;
  searchQuery: string;
  favoriteCount: number;
  favoritesOpen: boolean;
  inboxCount: number;
  inboxOpen: boolean;
  selectionActive: boolean;
  selected: boolean;
  folderNameById: Map<string, string>;
  onToggleFavorites: () => void;
  onToggleInbox: () => void;
  onToggleFolder: (f: Folder) => void;
  onOpenTrash: () => void;
  onOpenArchive: () => void;
  onOpenNote: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onLongPressNote: (note: NoteSummary) => void;
  /** Folder long-press → rename (the one folder verb desktop has that the phone lacked — desktop
   *  also blocks folder delete, `ctx.folder_delete_disabled`). */
  onLongPressFolder: (folder: Folder) => void;
  onAddFolder: () => void;
}

/**
 * One row per TreeRow kind (leftpanel/notetree/rows.ts::flattenRows) — same row kinds as desktop's
 * TreeListRow, touch-sized instead of react-window's dense 34px. No react-window here: W2's
 * ownership note calls for no virtualization (a resident window is TREE_NOTE_WINDOW=80 rows *
 * ~52px ≈ 4200px, inside DOM budget) — see MobileNoteTree's own ponytail comment for the upgrade
 * path (react-window, already a dependency) if per-folder paging ever pushes past that.
 * More/click/dblclick/drag are gone (touch has none of those) — the only note-row gesture is
 * long-press (400ms, lib/longPress.ts) opening MobileActionSheet; a plain tap opens the note (or
 * toggles selection while multi-select is active).
 */
export function MobileTreeRow({
  row,
  searchQuery,
  favoriteCount,
  favoritesOpen,
  inboxCount,
  inboxOpen,
  selectionActive,
  selected,
  folderNameById,
  onToggleFavorites,
  onToggleInbox,
  onToggleFolder,
  onOpenTrash,
  onOpenArchive,
  onOpenNote,
  onToggleSelect,
  onLongPressNote,
  onLongPressFolder,
  onAddFolder,
}: MobileTreeRowProps) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  switch (row.kind) {
    case "skeleton":
      return (
        <div className="mobile-tree-row mobile-tree-row--skeleton" aria-hidden="true">
          <span className="skeleton-bar" style={{ width: "60%", height: 14 }} />
        </div>
      );

    case "empty_workspace":
      return (
        <div className="mobile-empty">
          {t("tree.empty_workspace")}
          <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={onAddFolder}>
            {t("tree.add_folder")}
          </button>
        </div>
      );

    case "empty_filter":
    case "search_empty":
      return <div className="mobile-empty">{t("mobile.search_no_results")}</div>;

    case "search_pending":
      return (
        <div className="mobile-empty" role="status">
          {t("search.searching")}
        </div>
      );

    case "divider":
      return <div className="mobile-tree-divider" role="separator" />;

    // Never produced — MobileNoteTree never sets draftFolderId (no inline draft row alongside a
    // nowhere-nearby editor on mobile, ponytail: see MobileNoteTree header comment).
    case "draft":
      return null;

    case "inbox_hdr":
      return (
        <button type="button" className="mobile-tree-row mobile-tree-row--section" onClick={onToggleInbox}>
          <IconCaret dir={inboxOpen ? "down" : "right"} size={16} style={{ flex: "none" }} />
          {inboxOpen ? <IconFolderOpen size={18} strokeWidth={1.8} /> : <IconFolder size={18} strokeWidth={1.8} />}
          <span className="mobile-tree-row-name">{t("tree.inbox")}</span>
          <span className="mobile-tree-row-count">{inboxCount}</span>
        </button>
      );

    case "favorites_hdr":
      return (
        <button type="button" className="mobile-tree-row mobile-tree-row--section" onClick={onToggleFavorites}>
          <IconCaret dir={favoritesOpen ? "down" : "right"} size={16} style={{ flex: "none" }} />
          <IconStar size={18} strokeWidth={1.8} style={{ color: "var(--m-accent-text)" }} />
          <span className="mobile-tree-row-name">{t("tree.favorites")}</span>
          <span className="mobile-tree-row-count">{favoriteCount}</span>
        </button>
      );

    case "trash":
      return (
        <button type="button" className="mobile-tree-row mobile-tree-row--section" onClick={onOpenTrash}>
          <IconTrash size={18} strokeWidth={1.8} style={{ color: "var(--faint)" }} />
          <span className="mobile-tree-row-name">{t("trash.title")}</span>
        </button>
      );

    case "archive":
      return (
        <button type="button" className="mobile-tree-row mobile-tree-row--section" onClick={onOpenArchive}>
          <IconArchive size={18} strokeWidth={1.8} style={{ color: "var(--faint)" }} />
          <span className="mobile-tree-row-name">{t("archive.title")}</span>
        </button>
      );

    case "folder": {
      const f = row.folder;
      const Glyph = f.is_open ? IconFolderOpen : noteIconComp(f.icon, IconFolder);
      return (
        <button
          type="button"
          className="mobile-tree-row mobile-tree-row--section"
          onPointerDown={(e) => beginLongPress(() => onLongPressFolder(f), undefined, e)}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerMove={moveLongPress}
          onClick={() => {
            if (consumeLongPress()) return;
            onToggleFolder(f);
          }}
          aria-expanded={f.is_open}
        >
          <IconCaret dir={f.is_open ? "down" : "right"} size={16} style={{ flex: "none" }} />
          <Glyph size={18} strokeWidth={1.8} />
          <span className="mobile-tree-row-name">{f.name}</span>
          {typeof f.note_count === "number" && <span className="mobile-tree-row-count">{f.note_count}</span>}
        </button>
      );
    }

    case "note": {
      const n = row.note;
      const Glyph = noteIconComp(n.icon, IconNote);
      const title = displayTitle(n.title);
      return (
        <div
          role="button"
          tabIndex={0}
          className="mobile-tree-row mobile-tree-row--note"
          data-multi-selected={selected || undefined}
          aria-selected={selected || undefined}
          onPointerDown={(e) => {
            // 누르기 시작 = 열 의도(선택 모드의 탭은 노트를 열지 않는다) — 길게 누르기와 같은 핸들러에 합친다.
            if (!selectionActive) void MobileNote.preload();
            beginLongPress(() => onLongPressNote(n), undefined, e);
          }}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerMove={moveLongPress}
          onClick={() => {
            if (consumeLongPress()) return;
            if (selectionActive) onToggleSelect(n.id);
            else onOpenNote(n.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (selectionActive) onToggleSelect(n.id);
              else onOpenNote(n.id);
            }
          }}
        >
          {selected ? (
            <IconCheckMark size={18} strokeWidth={1.8} style={{ color: "var(--m-accent-text)", flex: "none" }} />
          ) : (
            <Glyph size={18} strokeWidth={1.8} style={{ flex: "none" }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mobile-tree-row-name">
              {row.indented ? title : <HighlightedText segments={splitByQuery(title, searchQuery)} />}
            </div>
            {row.indented ? (
              <div className="mobile-tree-row-meta">
                {formatCompactDate(n.updated_at, uiLang)}
                {n.snippet ? ` · ${n.snippet}` : ""}
              </div>
            ) : (
              <>
                <div className="mobile-tree-row-meta">
                  {row.folderLabel ?? folderNameById.get(n.folder_id) ?? t("tree.notes_fallback")} · {n.year}
                </div>
                {n.snippet && (
                  <div className="mobile-tree-row-meta">
                    <HighlightedText segments={splitSnippet(n.snippet)} />
                  </div>
                )}
              </>
            )}
          </div>
          <TreeRowBadges
            exportedAt={n.exported_at}
            isFavorite={n.is_favorite}
            status={n.status}
            hasImage={n.has_image}
            tagNames={n.tag_names}
          />
        </div>
      );
    }

    default:
      return null;
  }
}
