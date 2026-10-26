import type { ReactElement } from "react";
import { Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import type { ChartRenderProps } from "../../../lib/sheet/chartTypes";
import { COMPACT_NUM, cartesianGrid, tooltipEl } from "./shared";

// ponytail: recharts 의 기본 Scatter 점은 d3 symbol 이 <path> 로 그린다(SVG <circle> 태그가 아니다) —
// 원인지 다이아몬드인지 DOM 만으로 구분·검사하기 어렵다. shape 를 진짜 <circle> 로 고정해 "둥근 점"을
// 확실히 하고, 렌더 개수도 리터럴로 셀 수 있게 한다(완성 기준: 데이터 4행 → circle 4개).
function circleDot({ cx, cy }: { cx?: number; cy?: number }): ReactElement | null {
  if (typeof cx !== "number" || typeof cy !== "number") return null;
  return (
    <circle
      className="sheet-chart-glow-dot"
      cx={cx}
      cy={cy}
      r={4.5}
      fill="color-mix(in srgb, var(--accent) 65%, transparent)"
      stroke="var(--accent)"
      strokeWidth={1.5}
    />
  );
}

/**
 * 산점도는 x 축 입력이 없다(needsX:false) — 첫 시리즈가 x, 둘째가 y(minSeries:2). `extractChartData`
 * 는 시리즈를 `series_1`/`series_2` 키로 뽑으므로 그 둘을 그대로 숫자 축 dataKey 로 쓴다(범주형
 * "name" 축을 쓰는 나머지 종류와 다르다 — shared.tsx 의 xAxisEl/yAxisEl 은 재사용하지 않는다).
 */
export function renderScatter({ data, seriesKeys, compact, margin, sizeProps }: ChartRenderProps): ReactElement {
  const [xKey, yKey] = seriesKeys;
  return (
    <ScatterChart margin={margin} {...sizeProps}>
      {cartesianGrid()}
      <XAxis
        type="number"
        dataKey={xKey}
        stroke="var(--divider)"
        tickLine={!compact}
        axisLine={!compact}
        padding={compact ? { left: 6, right: 6 } : undefined}
        tickCount={compact ? 3 : 5}
        tickFormatter={(v: number) => COMPACT_NUM.format(v)}
      />
      <YAxis
        type="number"
        dataKey={yKey}
        hide={compact}
        stroke="var(--divider)"
        width={compact ? 34 : 46}
        tickCount={compact ? 3 : 5}
        tickFormatter={(v: number) => COMPACT_NUM.format(v)}
      />
      {tooltipEl()}
      <Scatter data={data} shape={circleDot} isAnimationActive={false} />
    </ScatterChart>
  );
}
