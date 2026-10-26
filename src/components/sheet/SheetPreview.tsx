import { type FC, useMemo } from "react";
import { emptySheet, parseSheet } from "../../lib/sheet/types";
import { SheetEngine } from "../../lib/sheet/engine";
import { colToLetters, refKey } from "../../lib/sheet/a1";
import { formatCell } from "../../lib/sheet/format";
import { SheetChart } from "./SheetChart";
import { t } from "../../i18n/t";
import { IconCheck, IconCheckboxEmpty } from "../icons";

export interface SheetPreviewProps {
  bodyMd: string;
}

export const SheetPreview: FC<SheetPreviewProps> = ({ bodyMd }) => {
  const doc = useMemo(() => parseSheet(bodyMd) ?? emptySheet(), [bodyMd]);
  const engine = useMemo(() => new SheetEngine(doc), [doc]);

  const maxPreviewRows = Math.min(doc.rows, 8);
  const maxPreviewCols = Math.min(doc.cols.length, 6);

  const firstChart = doc.charts?.[0];

  return (
    <div className="sheet-preview-container" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 차트가 정의되어 있으면 첫 번째 차트 표시 */}
      {firstChart && (
        <div
          style={{
            background: "var(--surface-sunken)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line)",
            padding: 8,
          }}
        >
          <SheetChart spec={firstChart} doc={doc} engine={engine} height={150} compact />
        </div>
      )}

      {/* 미니 읽기 전용 그리드 표 */}
      <div
        className="sheet-preview-table-container"
        style={{
          overflow: "auto",
          maxHeight: 240,
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-sm)",
        }}
      >

        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ width: 32, borderBottom: "1px solid var(--line)", borderRight: "1px solid var(--line)" }} />
              {Array.from({ length: maxPreviewCols }).map((_, c) => (
                <th
                  key={c}
                  style={{
                    borderBottom: "1px solid var(--line)",
                    borderRight: "1px solid var(--line)",
                    color: "var(--muted)",
                    fontWeight: 600,
                    padding: "var(--space-2xs) 6px",
                    textAlign: "center",
                  }}
                >
                  {colToLetters(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxPreviewRows }).map((_, r) => (
              <tr key={r}>
                <td
                  style={{
                    borderBottom: "1px solid var(--line)",
                    borderRight: "1px solid var(--line)",
                    color: "var(--muted)",
                    fontSize: 11,
                    textAlign: "center",
                    padding: "var(--space-2xs) 4px",
                  }}
                >
                  {r + 1}
                </td>
                {Array.from({ length: maxPreviewCols }).map((_, c) => {
                  const a1 = refKey(c, r);
                  const colDef = doc.cols[c];
                  const fmt = colDef?.fmt ?? "text";
                  const dp = colDef?.dp;
                  const cur = colDef?.cur;

                  const evalVal = engine.getValue(a1);
                  const isError = typeof evalVal === "object" && evalVal !== null && "error" in evalVal;
                  const formatted = formatCell(evalVal, fmt, { dp, cur });

                  return (
                    <td
                      key={c}
                      style={{
                        borderBottom: "1px solid var(--line)",
                        borderRight: "1px solid var(--line)",
                        padding: "3px 6px",
                        color: isError ? "var(--danger)" : "var(--text)",
                        textAlign: fmt === "number" || fmt === "currency" || fmt === "percent" ? "right" : "left",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 120,
                      }}
                    >
                      {fmt === "checkbox" ? (
                        evalVal === true || String(evalVal).toUpperCase() === "TRUE" ? (
                          <IconCheck size={13} strokeWidth={1.8} />
                        ) : (
                          <IconCheckboxEmpty size={13} strokeWidth={1.8} />
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

      {/* 요약 통계 */}
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        <span>{t("editor.sheet_count_rows", { n: doc.rows })}</span>
        {" · "}
        <span>{t("editor.sheet_count_cols", { n: doc.cols.length })}</span>
      </div>
    </div>
  );
};
