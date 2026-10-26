import { type FC, useMemo } from "react";
import { ResponsiveContainer } from "recharts";
import type { ChartSpec, SheetDoc } from "../../lib/sheet/types";
import type { SheetEngine } from "../../lib/sheet/engine";
import { extractChartData } from "../../lib/sheet/chart";
import { chartTypeById, type ChartRenderProps } from "../../lib/sheet/chartTypes";
import { t } from "../../i18n/t";

export interface SheetChartProps {
  spec: ChartSpec;
  doc: SheetDoc;
  engine?: SheetEngine;
  width?: number | string;
  height?: number;
  compact?: boolean;
}

export const SheetChart: FC<SheetChartProps> = ({
  spec,
  doc,
  engine,
  width = "100%",
  height = 220,
  compact = false,
}) => {
  const { data, seriesKeys, total } = useMemo(
    () => extractChartData(doc, spec, engine),
    [doc, spec, engine]
  );

  const chartHeight = typeof height === "number" ? height : 220;
  const plotHeight = Math.max(spec.title ? chartHeight - 22 : chartHeight, 40);

  if (!data.length || !seriesKeys.length) {
    return (
      <div
        className="sheet-chart-empty"
        style={{
          width,
          height: chartHeight,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px dashed var(--divider)",
          borderRadius: "var(--radius-sm)",
          color: "var(--faint)",
          fontSize: "var(--text-sm)",
          boxSizing: "border-box",
        }}
      >
        {t("editor.sheet_chart_empty")}
      </div>
    );
  }

  // 레지스트리에 없는 종류(예: 옛 저장분·AI 오출력의 미지 값)는 bar 로 폴백한다 — 완성 기준(W6).
  const def = chartTypeById(spec.type) ?? chartTypeById("bar")!;

  const margin = compact ? { top: 8, right: 0, bottom: 0, left: 0 } : { top: 10, right: 14, bottom: 4, left: 0 };

  // ponytail: width 가 숫자면 ResponsiveContainer 를 건너뛰고 그 크기로 바로 그린다 —
  // jsdom(ResizeObserver 없음, 모든 박스가 0×0)에서 테스트가 실제 SVG 를 볼 수 있는 유일한 길이고,
  // 호출처가 고정 폭을 아는 경우 리사이즈 왕복도 줄인다. 문자열 폭(기본 "100%")은 그대로 반응형.
  const fixed = typeof width === "number";
  const sizeProps = fixed ? { width, height: plotHeight } : {};

  const renderProps: ChartRenderProps = {
    spec,
    data,
    seriesKeys,
    total,
    compact,
    margin,
    sizeProps,
    width,
    height: chartHeight,
  };

  // 카드형(total·kpi) 은 전체 박스(크기·배경·제목)를 스스로 그린다 — SheetChart 의 제목 줄·
  // ResponsiveContainer 래핑을 태우지 않는다.
  if (def.isCard) {
    return def.render(renderProps);
  }

  const chart = def.render(renderProps);

  return (
    <div className="sheet-chart" style={{ width, height: chartHeight }}>
      {spec.title && <div className="sheet-chart-title">{spec.title}</div>}
      {fixed ? (
        chart
      ) : (
        // SheetChartProps.width 는 number | string 이고 여기 오는 건 문자열뿐이다.
        // recharts 는 퍼센트 리터럴 타입만 받으므로 그 계약으로 좁혀 넘긴다(기본값 "100%").
        <ResponsiveContainer width={width as `${number}%`} height={plotHeight}>
          {chart}
        </ResponsiveContainer>
      )}
    </div>
  );
};
