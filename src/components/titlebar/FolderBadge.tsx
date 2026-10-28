import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Folder } from "../../lib/commands.gen";
import { moveNote } from "../../lib/noteActions";
import { t } from "../../i18n/t";
import { IconFolder } from "../icons";
import { noteIconComp } from "../../lib/noteIcons";
import { folderColorCss, useDismiss, useMenuPos } from "../../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";

/**
 * Folder belonging badge for the TitleBar meta row.
 *
 * Width policy (see TitleBar meta-row constraint): hard max-width in *px*, not em/ch.
 * At --fs:1.35 text grows inside a fixed budget, so long names ellipsize harder rather than
 * stealing horizontal room from TagPanStrip. Tooltip always carries the full path.
 *
 * Nesting: Folder has no parent_id today (flat list). "Leaf" name === folder.name; "full path"
 * is the same string until hierarchy lands. Dropdown lists folders by position then name —
 * no indent, since there is no tree depth to show.
 */
/** Fixed px budget — do not switch to em/ch (would scale with --fs and steal tag room). */
export const FOLDER_BADGE_MAX_PX = 88;

export function FolderBadge({
  noteId,
  folderId,
  folders,
}: {
  noteId: string;
  folderId: string;
  folders: Folder[];
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const listboxId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  const hover = useFluidHover(listRef, { axis: "y" });

  const folder = useMemo(
    () => folders.find((f) => f.id === folderId) ?? null,
    [folders, folderId],
  );
  const leafName = folder?.name ?? t("note.folder.unknown");
  // Flat model: path === leaf. When parent_id appears, build ancestors → "A / B / leaf" here.
  const fullPath = leafName;

  const sortedFolders = useMemo(
    () =>
      [...folders].sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name);
      }),
    [folders],
  );

  useDismiss(!!anchor, [btnRef, listRef], () => setAnchor(null), {
    onEscape: () => {
      setAnchor(null);
      btnRef.current?.focus();
    },
  });

  // Land initial focus on the selected row (or the first row) whenever the list opens.
  useEffect(() => {
    if (!anchor) return;
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const first = listRef.current?.querySelector<HTMLElement>("button");
    (selected ?? first)?.focus();
  }, [anchor, listRef]);

  const tooltip = `${t("note.folder.label")}: ${fullPath}`;
  const choose = (nextId: string) => {
    setAnchor(null);
    btnRef.current?.focus();
    if (nextId === folderId) return;
    void moveNote(noteId, nextId);
  };

  const BadgeGlyph = noteIconComp(folder?.icon, IconFolder);

  return (
    <div style={{ display: "flex", flex: "none", alignItems: "center" }} data-testid="folder-badge">
      <button
        type="button"
        ref={btnRef}
        className="tag-btn tb-quiet-chip"
        onClick={() => {
          if (anchor) {
            setAnchor(null);
          } else {
            const rect = btnRef.current?.getBoundingClientRect();
            if (rect) {
              setAnchor({ x: rect.left, y: rect.bottom + 4 });
            }
          }
        }}
        aria-label={tooltip}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={!!anchor}
        style={{
          flex: "none",
          maxWidth: FOLDER_BADGE_MAX_PX,
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "var(--tb-chip-pt) var(--space-4) 0",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-xs)",
          fontWeight: 400,
          height: "var(--tb-chip-h)",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        <BadgeGlyph
          size={12}
          strokeWidth={1.8}
          style={{
            flex: "none",
            color: folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--muted)",
          }}
        />
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {leafName}
        </span>
      </button>
      {anchor &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            className="overlay fh-host"
            role="listbox"
            aria-label={t("note.folder.move")}
            data-testid="folder-badge-menu"
            onMouseDown={(e) => e.stopPropagation()}
            {...hover.handlers}
            style={{
              position: "fixed",
              top: y,
              left: x,
              zIndex: "var(--z-dropdown)",
              display: "flex",
              flexDirection: "column",
              gap: 0,
              padding: "var(--space-1)",
              minWidth: 160,
              maxWidth: "min(280px, calc(100vw - 16px))",
              maxHeight: "min(320px, calc(100vh - 24px))",
              overflowY: "auto",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <FluidHoverHighlight hover={hover} />
            {sortedFolders.map((f) => (
              <button
                key={f.id}
                type="button"
                className="menu-row menu-item"
                role="option"
                aria-selected={f.id === folderId}
                data-selected={f.id === folderId}
                onClick={() => choose(f.id)}
                style={{ overflowWrap: "anywhere" }}
              >
                {(() => {
                  const RowGlyph = noteIconComp(f.icon, IconFolder);
                  return (
                    <RowGlyph
                      size={15}
                      strokeWidth={1.8}
                      style={{
                        flex: "none",
                        color: f.color_hue != null ? folderColorCss(f.color_hue) : "var(--muted)",
                      }}
                    />
                  );
                })()}
                {f.name}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
