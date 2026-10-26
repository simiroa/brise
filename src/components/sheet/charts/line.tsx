import type { ReactElement } from "react";
import { Line, LineChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { PALETTE, cartesianGrid, legendEl, seriesLabel, tooltipEl, xAxisEl, yAxisEl } from "./shared";

export function renderLine({ data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  return (
    <LineChart data={data} margin={margin} {...sizeProps}>
      {cartesianGrid()}
      {xAxisEl(compact)}
      {yAxisEl(compact)}
      {tooltipEl()}
      {legendEl(compact, seriesKeys.length)}
      {seriesKeys.map((key, i) => (
        <Line
          key={key}
          type="monotone"
          className="sheet-chart-glow"
          dataKey={key}
          name={seriesLabel(key, i)}
          stroke={PALETTE[i % PALETTE.length]}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          dot={compact ? false : { r: 3, fill: "var(--surface)", strokeWidth: 2 }}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}
