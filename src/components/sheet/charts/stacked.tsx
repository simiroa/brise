import type { ReactElement } from "react";
import { Bar, BarChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { PALETTE, cartesianGrid, legendEl, seriesLabel, tooltipEl, xAxisEl, yAxisEl } from "./shared";

const SQUARE: [number, number, number, number] = [0, 0, 0, 0];
// ponytail: 스택의 맨 위 시리즈만 위쪽 모서리를 둥글린다(pill 인상은 bar.tsx 와 같은 8px 고정) —
// 세그먼트마다 전부 둥글리면 중간 이음매가 갈라져 보인다. 아래 세그먼트는 각지게 둔다.
const TOP_ROUND: [number, number, number, number] = [8, 8, 0, 0];

export function renderStacked({ data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  return (
    <BarChart data={data} margin={margin} {...sizeProps}>
      {cartesianGrid()}
      {xAxisEl(compact)}
      {yAxisEl(compact)}
      {tooltipEl()}
      {legendEl(compact, seriesKeys.length)}
      {seriesKeys.map((key, i) => (
        <Bar
          key={key}
          dataKey={key}
          name={seriesLabel(key, i)}
          stackId="stack"
          fill={PALETTE[i % PALETTE.length]}
          radius={i === seriesKeys.length - 1 ? TOP_ROUND : SQUARE}
          isAnimationActive={false}
        />
      ))}
    </BarChart>
  );
}
