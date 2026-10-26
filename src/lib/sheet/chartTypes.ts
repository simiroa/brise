// 차트 종류 레지스트리 (PLAN-2026-09-20 D2·D7·W6) — 관계도 types/registry.ts 와 같은 규율: 종류
// 하나 = 파일 하나(`components/sheet/charts/<id>.tsx`) + 여기 배열 한 줄 + `types.ts` 의 CHART_TYPE_IDS 한 칸
// + i18n 키 3벌. 지우기 = 그 넷을 지우는 것뿐(id 목록과 이 배열의 일치는 chartTypes.test.ts 가 본다). SheetChart 는 switch 없이 `chartTypeById` 로 찾는다.
import type { ReactElement } from "react";
import type { ChartSpec } from "./types";
import type { ChartDataPoint } from "./chart";
import { renderBar } from "../../components/sheet/charts/bar";
import { renderLine } from "../../components/sheet/charts/line";
import { renderArea } from "../../components/sheet/charts/area";
import { renderStacked } from "../../components/sheet/charts/stacked";
import { renderPie } from "../../components/sheet/charts/pie";
import { renderDonut } from "../../components/sheet/charts/donut";
import { renderScatter } from "../../components/sheet/charts/scatter";
import { renderKpi } from "../../components/sheet/charts/kpi";
import { renderTotal } from "../../components/sheet/charts/total";

export type ChartType = ChartSpec["type"];

export interface ChartRenderProps {
  spec: ChartSpec;
  data: ChartDataPoint[];
  seriesKeys: string[];
  total: number;
  compact: boolean;
  margin: { top: number; right: number; bottom: number; left: number };
  /** `{}` 또는 `{width, height}` — SheetChart 가 고정폭일 때만 채운다(jsdom 테스트 경로, SheetChart 헤더 참고). */
  sizeProps: { width?: number; height?: number };
  /** 카드형(`isCard`) 전용 전체 박스 크기. 나머지 종류는 무시(ResponsiveContainer/sizeProps 로 대신 정한다). */
  width: number | string;
  height: number;
}

export interface ChartTypeDef {
  id: ChartType;
  nameKey: string;
  /** false 면 ChartEditor 가 X축 범위 입력을 숨긴다(scatter·kpi — x 가 없거나 시리즈로 대신한다). */
  needsX: boolean;
  /** ChartEditor 저장 버튼이 이 수 미만의 비어있지 않은 시리즈에서 비활성화된다. */
  minSeries: number;
  /** true 면 render() 가 전체 카드(너비·높이·배경 포함)를 그린다(total·kpi) — SheetChart 가 제목
   *  줄과 ResponsiveContainer 로 감싸지 않는다. false 면 recharts 루트 컴포넌트만 반환한다. */
  isCard?: boolean;
  render(props: ChartRenderProps): ReactElement;
}

export const CHART_TYPES: readonly ChartTypeDef[] = [
  { id: "bar", nameKey: "editor.sheet_chart_type_bar", needsX: true, minSeries: 1, render: renderBar },
  { id: "line", nameKey: "editor.sheet_chart_type_line", needsX: true, minSeries: 1, render: renderLine },
  { id: "area", nameKey: "editor.sheet_chart_type_area", needsX: true, minSeries: 1, render: renderArea },
  { id: "stacked", nameKey: "editor.sheet_chart_type_stacked", needsX: true, minSeries: 1, render: renderStacked },
  { id: "pie", nameKey: "editor.sheet_chart_type_pie", needsX: true, minSeries: 1, render: renderPie },
  { id: "donut", nameKey: "editor.sheet_chart_type_donut", needsX: true, minSeries: 1, render: renderDonut },
  {
    id: "scatter",
    nameKey: "editor.sheet_chart_type_scatter",
    needsX: false,
    minSeries: 2,
    render: renderScatter,
  },
  { id: "kpi", nameKey: "editor.sheet_chart_type_kpi", needsX: false, minSeries: 1, isCard: true, render: renderKpi },
  { id: "total", nameKey: "editor.sheet_chart_type_total", needsX: false, minSeries: 1, isCard: true, render: renderTotal },
];

export function chartTypeById(id: string): ChartTypeDef | undefined {
  return CHART_TYPES.find((c) => c.id === id);
}
