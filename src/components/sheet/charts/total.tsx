import type { ReactElement } from "react";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { FULL_NUM, PALETTE, cardBoxStyle, num } from "./shared";

/** 합계 카드 — 차트가 아니라 요약 카드다(recharts 를 태우지 않는다). isCard:true. */
export function renderTotal({ spec, data, seriesKeys, total, width, height }: ChartRenderProps): ReactElement {
  return (
    <div className="sheet-chart-total-card" style={cardBoxStyle(width, height)}>
      {spec.title && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>{spec.title}</div>
      )}
      <div style={{ fontSize: "var(--text-title)", fontWeight: 600, color: "var(--accent)" }}>
        {FULL_NUM.format(total)}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {data.slice(0, 5).map((d, i) => (
          <div
            key={i}
            style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE[i % PALETTE.length] }} />
            <span>
              {d.name}: {FULL_NUM.format(num(d[seriesKeys[0]]))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
