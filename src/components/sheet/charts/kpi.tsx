import type { ReactElement } from "react";
import { Line, LineChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { FULL_NUM, cardBoxStyle, num } from "./shared";

const SPARK_W = 96;
const SPARK_H = 28;

/**
 * KPI 카드 = 합계 숫자 + 마지막 시리즈의 스파크라인(D7). isCard:true — total.tsx 와 같은 박스를 쓰되
 * ResponsiveContainer 를 태우지 않는 고정 크기 미니 LineChart 라 축·격자·툴팁이 없다("작은 LineChart,
 * 축 없음" — 계획 §2.5).
 */
export function renderKpi({ spec, data, seriesKeys, total, width, height }: ChartRenderProps): ReactElement {
  const sparkKey = seriesKeys[seriesKeys.length - 1];
  const sparkData = data.map((d) => ({ v: num(d[sparkKey]) }));
  return (
    <div className="sheet-chart-total-card" style={cardBoxStyle(width, height)}>
      {spec.title && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>{spec.title}</div>
      )}
      <div style={{ fontSize: "var(--text-title)", fontWeight: 600, color: "var(--accent)" }}>
        {FULL_NUM.format(total)}
      </div>
      {sparkData.length > 1 && (
        <LineChart width={SPARK_W} height={SPARK_H} data={sparkData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            className="sheet-chart-glow"
            type="monotone"
            dataKey="v"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      )}
    </div>
  );
}
