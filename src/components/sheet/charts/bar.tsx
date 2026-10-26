import type { ReactElement } from "react";
import { Bar, BarChart } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { cartesianGrid, gradientDefs, legendEl, seriesLabel, tooltipEl, xAxisEl, yAxisEl } from "./shared";

// ponytail: recharts 의 막대 radius 는 픽셀 고정값이라 "막대 폭의 절반"(진짜 pill)을 계산해 넣을
// 수 없다 — 폭은 카테고리 수·컨테이너 크기에 따라 매 렌더 달라진다. 8px 로 고정해 둥근 인상만
// 낸다. 막대가 8px 보다 얇아지면(카테고리 10개 이상) 실질적으로 캡슐이 된다.
const PILL: [number, number, number, number] = [8, 8, 8, 8];

export function renderBar({ spec, data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  return (
    <BarChart data={data} margin={margin} {...sizeProps}>
      {gradientDefs(spec.id, "bar", seriesKeys.length, 1, 0.55)}
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
          fill={`url(#${spec.id}-bar-${i})`}
          radius={PILL}
          isAnimationActive={false}
        />
      ))}
    </BarChart>
  );
}
