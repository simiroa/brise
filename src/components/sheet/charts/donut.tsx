import type { ReactElement } from "react";
import { Cell, Label, Pie, PieChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { FULL_NUM, gradientDefs, legendEl, tooltipEl } from "./shared";

export function renderDonut({ spec, data, total, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  return (
    <PieChart margin={margin} {...sizeProps}>
      {gradientDefs(spec.id, "donut", data.length, 1, 0.6)}
      <Pie
        data={data}
        dataKey={seriesKeys[0]}
        nameKey="name"
        innerRadius="55%"
        outerRadius="80%"
        cornerRadius={6}
        paddingAngle={2}
        isAnimationActive={false}
      >
        {data.map((_, i) => (
          <Cell key={i} fill={`url(#${spec.id}-donut-${i})`} stroke="var(--surface)" strokeWidth={1.5} />
        ))}
        {/* 도넛 가운데 합계 — EvilCharts 식 센터 라벨(PLAN-2026-09-30). */}
        <Label value={FULL_NUM.format(total)} position="center" fill="var(--text)" style={{ fontWeight: 600 }} />
      </Pie>
      {tooltipEl()}
      {legendEl(compact, data.length)}
    </PieChart>
  );
}
