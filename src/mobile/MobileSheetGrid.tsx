import type { SheetDoc } from "../lib/sheet/types";
import type { SheetEngine } from "../lib/sheet/engine";
import { colToLetters, refKey } from "../lib/sheet/a1";
import { formatCell } from "../lib/sheet/format";
import { IconCheck, IconCheckboxEmpty } from "../components/icons";

interface MobileSheetGridProps {
  doc: SheetDoc;
  engine: SheetEngine;
  /** A1-style key of the selected cell. */
  activeCell: string;
  onCellClick: (col: number, row: number) => void;
}

/**
 * Touch-friendly read grid of the phone sheet editor: sticky column letters + row numbers, the
 * selected cell outlined, checkbox cells drawn as icons. Display only — selection and edits are
 * MobileSheetEditor's job. Capped at 26 columns x 100 rows (a plain `<table>`, not virtualized —
 * ponytail: cells past that are not reachable on the phone; the upgrade path is `react-window`,
 * which desktop's components/sheet/SheetGrid.tsx already uses).
 */
export function MobileSheetGrid({ doc, engine, activeCell, onCellClick }: MobileSheetGridProps) {
  const visibleCols = Math.min(doc.cols.length, 26);
  const visibleRows = Math.min(doc.rows, 100);

  return (
    <div
      className="mobile-sheet-grid-container scroll"
      style={{
        flex: 1,
        overflow: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <table
        style={{
          borderCollapse: "collapse",
          width: "max-content",
          minWidth: "100%",
          fontSize: "var(--text-md)",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                width: 36,
                minWidth: 36,
                position: "sticky",
                top: 0,
                left: 0,
                zIndex: 3,
                background: "var(--surface-sunken)",
                borderBottom: "1px solid var(--line)",
                borderRight: "1px solid var(--line)",
              }}
            />
            {Array.from({ length: visibleCols }).map((_, c) => (
              <th
                key={c}
                style={{
                  width: doc.cols[c]?.w ?? 96,
                  minWidth: 70,
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  background: "var(--surface-sunken)",
                  borderBottom: "1px solid var(--line)",
                  borderRight: "1px solid var(--line)",
                  color: "var(--muted)",
                  fontWeight: 600,
                  fontSize: "var(--text-xs)",
                  textAlign: "center",
                  padding: "4px var(--space-2xs)",
                }}
              >
                {colToLetters(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: visibleRows }).map((_, r) => (
            <tr key={r}>
              <td
                style={{
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  background: "var(--surface-sunken)",
                  borderBottom: "1px solid var(--line)",
                  borderRight: "1px solid var(--line)",
                  color: "var(--muted)",
                  fontSize: "var(--text-xs)",
                  fontWeight: 400,
                  textAlign: "center",
                  padding: "6px var(--space-2xs)",
                }}
              >
                {r + 1}
              </td>
              {Array.from({ length: visibleCols }).map((_, c) => {
                const key = refKey(c, r);
                const isSelected = key === activeCell;
                const colDef = doc.cols[c];
                const fmt = doc.cells[key]?.fmt ?? colDef?.fmt ?? "text";
                const dp = doc.cells[key]?.dp ?? colDef?.dp;
                const cur = doc.cells[key]?.cur ?? colDef?.cur;

                const evalVal = engine.getValue(key);
                const isError = typeof evalVal === "object" && evalVal !== null && "error" in evalVal;
                const formatted = formatCell(evalVal, fmt, { dp, cur });

                return (
                  <td
                    key={c}
                    onClick={() => onCellClick(c, r)}
                    style={{
                      borderBottom: "1px solid var(--line)",
                      borderRight: "1px solid var(--line)",
                      padding: "6px 8px",
                      background: isSelected ? "var(--sel)" : undefined,
                      outline: isSelected ? "2px solid var(--accent)" : "none",
                      outlineOffset: -2,
                      color: isError ? "var(--danger)" : "var(--text)",
                      textAlign:
                        fmt === "number" || fmt === "currency" || fmt === "percent"
                          ? "right"
                          : fmt === "checkbox"
                            ? "center"
                            : "left",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    {fmt === "checkbox" ? (
                      evalVal === true || String(evalVal).toUpperCase() === "TRUE" ? (
                        <IconCheck size={14} strokeWidth={1.8} />
                      ) : (
                        <IconCheckboxEmpty size={14} strokeWidth={1.8} />
                      )
                    ) : (
                      formatted
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
