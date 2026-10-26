import type { ReactElement } from "react";
import { Cell, Pie, PieChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { gradientDefs, legendEl, tooltipEl } from "./shared";

export function renderPie({ spec, data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  // ponytail: 원형은 첫 시리즈만(스펙 결정, ChartEditor 도 시리즈 1개로 충분). 여러 시리즈를
  // 겹쳐 보여줄 필요가 생기면 그때 두 번째 링(도넛과 같은 방식)을 추가한다.
  return (
    <PieChart margin={margin} {...sizeProps}>
      {gradientDefs(spec.id, "pie", data.length, 1, 0.6)}
      <Pie data={data} dataKey={seriesKeys[0]} nameKey="name" outerRadius="80%" isAnimationActive={false}>
        {data.map((_, i) => (
          <Cell key={i} fill={`url(#${spec.id}-pie-${i})`} stroke="var(--surface)" strokeWidth={1.5} />
        ))}
      </Pie>
      {tooltipEl()}
      {legendEl(compact, data.length)}
    </PieChart>
  );
}
