import type { ReactElement } from "react";
import { Area, AreaChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { PALETTE, cartesianGrid, gradientDefs, legendEl, seriesLabel, tooltipEl, xAxisEl, yAxisEl } from "./shared";

export function renderArea({ spec, data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  return (
    <AreaChart data={data} margin={margin} {...sizeProps}>
      {gradientDefs(spec.id, "area", seriesKeys.length, 0.5, 0.02)}
      {cartesianGrid()}
      {xAxisEl(compact)}
      {yAxisEl(compact)}
      {tooltipEl()}
      {legendEl(compact, seriesKeys.length)}
      {seriesKeys.map((key, i) => (
        <Area
          key={key}
          type="monotone"
          dataKey={key}
          name={seriesLabel(key, i)}
          stroke={PALETTE[i % PALETTE.length]}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={`url(#${spec.id}-area-${i})`}
          isAnimationActive={false}
        />
      ))}
    </AreaChart>
  );
}
