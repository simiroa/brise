import { type FC, useMemo } from "react";
import { usePresetsStore } from "../../stores/presets";
import { parseRef } from "../../lib/sheet/a1";
import { SHEET_PRESET_GHOSTS } from "./SheetGrid";
import { t } from "../../i18n/t";

export interface SheetGhostOverlayProps {
  isEmpty: boolean;
}

interface GhostCellItem {
  col: number;
  row: number;
  raw: string;
}

export const SheetGhostOverlay: FC<SheetGhostOverlayProps> = ({ isEmpty }) => {
  const hovered = usePresetsStore((s) => s.hovered);
  const targetState = usePresetsStore((s) => s.targetState);
  const isEditorEmpty = usePresetsStore((s) => s.isEditorEmpty);

  const isSheetPreset = useMemo(() => {
    if (!hovered) return false;
    if (
      hovered.id === "sheet" ||
      hovered.id === "budget" ||
      hovered.id === "sheet_schedule" ||
      hovered.id === "sheet_tracker" ||
      hovered.id.startsWith("sheet_")
    ) {
      return true;
    }
    // Check if bodyMd is a serialized SheetDoc JSON
    try {
      const parsed = JSON.parse(hovered.bodyMd);
      return parsed && typeof parsed === "object" && (parsed.cells || parsed.cols);
    } catch {
      return false;
    }
  }, [hovered]);

  const canShowGhost = isEmpty && (targetState === "ready" || isEditorEmpty) && isSheetPreset;

  const ghostData = useMemo<{ cells: GhostCellItem[]; cols: number[]; title: string } | null>(() => {
    if (!canShowGhost || !hovered) return null;

    let cellsMap: Record<string, string> = {};
    let colWidths: number[] = [100, 100, 100, 100, 100, 100];
    let presetTitle = hovered.id;

    // 1. Try JSON bodyMd
    let parsedJson = false;
    if (hovered.bodyMd && hovered.bodyMd.trim().startsWith("{")) {
      try {
        const doc = JSON.parse(hovered.bodyMd);
        if (doc.cells && typeof doc.cells === "object") {
          for (const [key, cell] of Object.entries<any>(doc.cells)) {
            if (cell && typeof cell.raw === "string") {
              cellsMap[key] = cell.raw;
            }
          }
          parsedJson = true;
        }
        if (Array.isArray(doc.cols) && doc.cols.length > 0) {
          colWidths = doc.cols.map((c: any) => (c && typeof c.w === "number" ? c.w : 100));
        }
      } catch {
        // Fallback to SHEET_PRESET_GHOSTS
      }
    }

    // 2. Fallback to SHEET_PRESET_GHOSTS if no JSON parsed
    if (!parsedJson && SHEET_PRESET_GHOSTS[hovered.id]) {
      cellsMap = SHEET_PRESET_GHOSTS[hovered.id];
    }

    const items: GhostCellItem[] = [];
    for (const [a1, raw] of Object.entries(cellsMap)) {
      if (!raw || !raw.trim()) continue;
      const ref = parseRef(a1);
      if (ref) {
        items.push({ col: ref.col, row: ref.row, raw });
      }
    }

    if (items.length === 0) return null;

    const titleMap: Record<string, string> = {
      sheet: t("presets.sheet_name"),
      budget: t("presets.budget_name"),
      sheet_schedule: t("presets.sheet_schedule_name"),
      sheet_tracker: t("presets.sheet_tracker_name"),
    };
    presetTitle = titleMap[hovered.id] || hovered.id;

    return { cells: items, cols: colWidths, title: presetTitle };
  }, [canShowGhost, hovered]);

  if (!canShowGhost || !ghostData) return null;

  const ROW_HEADER_WIDTH = 45;
  const COL_HEADER_HEIGHT = 24;
  const DEFAULT_ROW_HEIGHT = 24;

  return (
    <div
      data-testid="sheet-ghost-overlay"
      className="sheet-ghost-overlay"
      style={{
        position: "absolute",
        top: COL_HEADER_HEIGHT,
        left: ROW_HEADER_WIDTH,
        right: 0,
        bottom: 0,
        pointerEvents: "none",
        zIndex: 10,
        overflow: "hidden",
      }}
    >
      {/* 템플릿 미리보기 안내 뱃지 */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 16,
          padding: "4px 10px",
          background: "color-mix(in srgb, var(--accent) 14%, var(--surface))",
          border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--line))",
          borderRadius: "var(--radius-sm)",
          color: "var(--accent)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          // 기하(0 2px 8px)가 --shadow-md 와 **동일**하다 — 생값은 알파만 8% 로 얕았고, 그
          // 8% 는 다크 바탕에서 사실상 보이지 않아 접촉 그림자 노릇을 못 했다. 앱의 다른 떠
          // 있는 작은 면과 같은 단(24%)으로 맞춘다.
          boxShadow: "var(--shadow-md)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          backdropFilter: "blur(4px)",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: "var(--accent)",
            display: "inline-block",
          }}
        />
        <span>{ghostData.title} {t("presets.ghost_hint") || "템플릿 미리보기 (클릭하여 적용)"}</span>
      </div>

      {/* 고스트 셀들 */}
      {ghostData.cells.map(({ col, row, raw }) => {
        // Calculate X offset by summing previous columns' widths
        let left = 0;
        for (let i = 0; i < col; i++) {
          left += ghostData.cols[i] ?? 100;
        }
        const width = ghostData.cols[col] ?? 100;
        const top = row * DEFAULT_ROW_HEIGHT;

        const isHeaderRow = row === 0;

        return (
          <div
            key={`${col}-${row}`}
            data-testid={`sheet-ghost-cell-${col}-${row}`}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height: DEFAULT_ROW_HEIGHT,
              boxSizing: "border-box",
              borderRight: "1px dashed color-mix(in srgb, var(--accent) 30%, var(--line))",
              borderBottom: "1px dashed color-mix(in srgb, var(--accent) 30%, var(--line))",
              background: isHeaderRow
                ? "color-mix(in srgb, var(--accent) 12%, var(--surface))"
                : "color-mix(in srgb, var(--accent) 4%, var(--surface))",
              display: "flex",
              alignItems: "center",
              padding: "0 6px",
              fontSize: "var(--text-sm)",
              fontFamily: "var(--font-mono, monospace)",
              fontWeight: isHeaderRow ? 600 : 400,
              color: isHeaderRow ? "var(--accent)" : "color-mix(in srgb, var(--text) 70%, var(--accent))",
              opacity: 0.82,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {raw}
          </div>
        );
      })}
    </div>
  );
};
