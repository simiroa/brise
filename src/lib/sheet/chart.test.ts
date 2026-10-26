import { describe, expect, it } from "vitest";
import { defaultChartRanges, extractChartData, recommendChartTypes } from "./chart";
import { emptySheet, type ChartSpec, type SheetDoc } from "./types";
import { SheetEngine } from "./engine";

describe("extractChartData", () => {
  it("extracts labels and series values correctly", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: {
        A1: { raw: "1월" },
        A2: { raw: "2월" },
        A3: { raw: "3월" },
        B1: { raw: "100" },
        B2: { raw: "150" },
        B3: { raw: "200" },
      },
    };

    const spec: ChartSpec = {
      id: "c1",
      type: "bar",
      title: "월별 매출",
      x: "A1:A3",
      series: ["B1:B3"],
    };

    const result = extractChartData(doc, spec);
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toEqual({ name: "1월", series_1: 100 });
    expect(result.data[1]).toEqual({ name: "2월", series_1: 150 });
    expect(result.data[2]).toEqual({ name: "3월", series_1: 200 });
    expect(result.total).toBe(450);
  });

  it("evaluates formulas via engine when extracting series data", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: {
        A1: { raw: "A" },
        A2: { raw: "B" },
        B1: { raw: "10" },
        B2: { raw: "=B1*2" },
      },
    };

    const engine = new SheetEngine(doc);
    const spec: ChartSpec = {
      id: "c2",
      type: "line",
      x: "A1:A2",
      series: ["B1:B2"],
    };

    const result = extractChartData(doc, spec, engine);
    expect(result.data[0]).toEqual({ name: "A", series_1: 10 });
    expect(result.data[1]).toEqual({ name: "B", series_1: 20 });
    expect(result.total).toBe(30);
  });

  it("handles empty / missing ranges gracefully", () => {
    const doc: SheetDoc = emptySheet();
    const spec: ChartSpec = {
      id: "c3",
      type: "total",
      series: ["B1:B2"],
    };

    const result = extractChartData(doc, spec);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ name: "1", series_1: 0 });
    expect(result.total).toBe(0);
  });
});

// 라이브 QA 2026-08-19: F1:F3 을 고르고 차트 버튼을 눌렀는데 x 가 A2:A10 으로 박혀
// 레이블 9개에 값 3개가 붙었다. 기본값은 선택 영역에서 나와야 한다.
describe("defaultChartRanges", () => {
  const doc: SheetDoc = {
    ...emptySheet(),
    cells: {
      A1: { raw: "커피" },
      A2: { raw: "점심" },
      A3: { raw: "택시" },
      D1: { raw: "1" },
      D2: { raw: "2" },
      D3: { raw: "3" },
      F1: { raw: "1000" },
      F2: { raw: "2000" },
      F3: { raw: "3000" },
    },
  };

  it("한 열 선택 — 행 범위는 선택 그대로, 레이블은 왼쪽에서 가장 가까운 텍스트 열", () => {
    expect(defaultChartRanges(doc, { r1: 0, c1: 5, r2: 2, c2: 5 })).toEqual({
      x: "A1:A3",
      series: ["F1:F3"],
    });
  });

  it("두 열 이상 선택 — 첫 열이 레이블, 나머지가 각각 시리즈", () => {
    expect(defaultChartRanges(doc, { r1: 0, c1: 0, r2: 2, c2: 2 })).toEqual({
      x: "A1:A3",
      series: ["B1:B3", "C1:C3"],
    });
  });

  it("왼쪽에 텍스트 열이 없으면 x 는 비고 행 번호로 떨어진다", () => {
    const numsOnly: SheetDoc = { ...emptySheet(), cells: { B1: { raw: "1" }, B2: { raw: "2" } } };
    expect(defaultChartRanges(numsOnly, { r1: 0, c1: 1, r2: 1, c2: 1 })).toEqual({ series: ["B1:B2"] });
    // 숫자만 있는 D 열은 레이블이 아니다 — 더 왼쪽의 A 열(텍스트)이 잡힌다.
    expect(defaultChartRanges(doc, { r1: 0, c1: 4, r2: 2, c2: 4 }).x).toBe("A1:A3");
  });

  it("역방향 선택도 정규화한다", () => {
    expect(defaultChartRanges(doc, { r1: 2, c1: 5, r2: 0, c2: 5 }).series).toEqual(["F1:F3"]);
  });
});

// PLAN-2026-09-20 W5 — 선택 범위 → 추천 차트 종류. 다섯 규칙이 각각 리터럴 배열이다.
describe("recommendChartTypes", () => {
  const mk = (cells: Record<string, string>): SheetDoc => ({
    ...emptySheet(),
    cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])),
  });
  const rows8 = mk({
    A1: "월", B1: "매출", C1: "비용",
    A2: "1월", B2: "10", C2: "5",
    A3: "2월", B3: "20", C3: "6",
    A4: "3월", B4: "30", C4: "7",
    A5: "4월", B5: "40", C5: "8",
    A6: "5월", B6: "50", C6: "9",
    A7: "6월", B7: "60", C7: "10",
    A8: "7월", B8: "70", C8: "11",
  });

  it("텍스트 열 1 + 숫자 열 1 → bar · line · pie", () => {
    expect(recommendChartTypes(rows8, { r1: 0, c1: 0, r2: 7, c2: 1 })).toEqual(["bar", "line", "pie"]);
  });

  it("숫자 열 2+ → stacked · line · bar", () => {
    expect(recommendChartTypes(rows8, { r1: 0, c1: 0, r2: 7, c2: 2 })).toEqual(["stacked", "line", "bar"]);
  });

  it("숫자 열만 1개(라벨 열 없음) → kpi · bar", () => {
    expect(recommendChartTypes(rows8, { r1: 1, c1: 1, r2: 7, c2: 1 })).toEqual(["kpi", "bar"]);
  });

  it("행 ≤ 6 이면 pie 가 맨 앞", () => {
    expect(recommendChartTypes(rows8, { r1: 0, c1: 0, r2: 5, c2: 1 })).toEqual(["pie", "bar", "line"]);
  });

  it("숫자 열 0개 → [] (진입점 부재)", () => {
    expect(recommendChartTypes(rows8, { r1: 0, c1: 0, r2: 7, c2: 0 })).toEqual([]);
    expect(recommendChartTypes(emptySheet(), { r1: 0, c1: 0, r2: 3, c2: 3 })).toEqual([]);
  });

  it("헤더 한 줄은 열 종류에서 빠지고, 수식 셀은 engine 값으로만 센다", () => {
    const withFormula = mk({ A1: "항목", B1: "값", A2: "a", B2: "=1+1", A3: "b", B3: "=2+2" });
    expect(recommendChartTypes(withFormula, { r1: 0, c1: 0, r2: 2, c2: 1 })).toEqual([]);
    expect(recommendChartTypes(withFormula, { r1: 0, c1: 0, r2: 2, c2: 1 }, new SheetEngine(withFormula))).toEqual(["pie", "bar", "line"]);
  });
});
