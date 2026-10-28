/**
 * Dashboard-wide folder filter — one row of folder icons in the nav's right column, shared by every
 * inner tab (owner feedback: "여기 점보다 폴더아이콘(어차피색상 적용되있으니 ) 이 있는게 보기 직관적일것같아,
 * 그리고 마우스올리면 디바운스 없이 이름이 보여야함, 해당 ui도 통일감있게 디자인되야해, 애니메이션도있음 좋음").
 * Replaces the three per-tab left-rail legends (cal-legend / graph-legend / home-map-legend) that used
 * to duplicate this as local state.
 *
 * Folder source is always useNotesStore's flat folder list (already in `position` display order —
 * see NoteTree's rows.ts, which iterates it unsorted) — deliberately NOT "folders that appear in
 * this tab's current results": recomputing per tab means the row's width/order shifts every time
 * you switch tabs, which is the thing being fixed here.
 *
 * Icons only, no label text (nav row must not grow taller) — folder name lives in aria-label and
 * instant tooltip. Native `title` is removed to eliminate browser hover delay (P-2).
 * Custom folder icons (`folder.icon`) stay synchronized with the sidebar tree via noteIconComp.
 * No wrap: overflow-x auto absorbs a long folder list instead of growing nav height (fixed 58px).
 *
 * Tooltip is rendered into popoverRoot (outside scroll container) via createPortal with position:fixed
 * to avoid overflow-x clipping (P-2).
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { clamp, folderColorCss, popoverRoot } from "../../lib/ui";
import { noteIconComp } from "../../lib/noteIcons";
import { IconClose, IconFolder, IconFolderOpen } from "../icons";

function FolderTooltip({
  name,
  rect,
}: {
  name: string;
  rect: DOMRect;
  anchor: HTMLElement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const tipRect = ref.current.getBoundingClientRect();
    const margin = 8;
    const midX = rect.left + rect.width / 2;

    // Center horizontally on the anchor button and clamp within viewport
    let left = midX - tipRect.width / 2;
    left = clamp(left, margin, Math.max(margin, window.innerWidth - tipRect.width - margin));

    // Place below if room, otherwise flip above
    let top = rect.bottom + 4;
    if (top + tipRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - tipRect.height - 4);
    }
    setPos({ left, top });
  }, [rect]);

  const initialLeft = clamp(
    rect.left + rect.width / 2 - 30,
    8,
    Math.max(8, window.innerWidth - 60),
  );
  const initialTop = rect.bottom + 4;

  return (
    <div
      ref={ref}
      role="tooltip"
      data-testid="folder-dot-tooltip"
      className="overlay tip"
      style={{
        left: pos ? pos.left : initialLeft,
        top: pos ? pos.top : initialTop,
      }}
    >
      {name}
    </div>
  );
}

export function FolderDotFilter() {
  const folders = useNotesStore((s) => s.folders);
  const dashboardFolderFilter = useUiStore((s) => s.dashboardFolderFilter);
  const toggleDashboardFolderFilter = useUiStore((s) => s.toggleDashboardFolderFilter);

  const [hovered, setHovered] = useState<{
    name: string;
    rect: DOMRect;
    anchor: HTMLElement;
  } | null>(null);

  const handleScroll = useCallback(() => {
    setHovered(null);
  }, []);

  const activeFolder = folders.find((f) => f.id === dashboardFolderFilter);

  if (folders.length <= 1) return null;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
      {activeFolder && (
        <button
          type="button"
          data-testid="folder-filter-clear-chip"
          className="folder-filter-clear-chip"
          title={activeFolder.name}
          aria-label={activeFolder.name}
          onClick={() => toggleDashboardFolderFilter(activeFolder.id)}
        >
          <span>{activeFolder.name}</span>
          <IconClose size={11} strokeWidth={2.2} />
        </button>
      )}

      <div
        data-testid="home-folder-dots"
        className="folder-dot-row"
        onScroll={handleScroll}
        style={{ flex: "0 1 auto", minWidth: 0 }}
      >
        {folders.map((folder) => {
          const color = folder.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue);
          const on = dashboardFolderFilter === folder.id;
          const Glyph =
            folder.icon && folder.icon !== "folder"
              ? noteIconComp(folder.icon, IconFolder)
              : on
                ? IconFolderOpen
                : IconFolder;

          return (
            <button
              key={folder.id}
              type="button"
              data-folder-id={folder.id}
              className="folder-dot"
              aria-label={folder.name}
              aria-pressed={on}
              onClick={() => toggleDashboardFolderFilter(folder.id)}
              onMouseEnter={(e) =>
                setHovered({
                  name: folder.name,
                  rect: e.currentTarget.getBoundingClientRect(),
                  anchor: e.currentTarget,
                })
              }
              onMouseLeave={() => setHovered(null)}
              onFocus={(e) =>
                setHovered({
                  name: folder.name,
                  rect: e.currentTarget.getBoundingClientRect(),
                  anchor: e.currentTarget,
                })
              }
              onBlur={() => setHovered(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setHovered(null);
              }}
            >
              <Glyph
                size={14}
                strokeWidth={1.8}
                style={{ color }}
                fill={on ? "currentColor" : "none"}
                fillOpacity={on ? 0.22 : 0}
              />
            </button>
          );
        })}
      </div>

      {hovered &&
        createPortal(
          <FolderTooltip name={hovered.name} rect={hovered.rect} anchor={hovered.anchor} />,
          popoverRoot(hovered.anchor),
        )}
    </div>
  );
}
