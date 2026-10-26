import { describe, expect, it } from "vitest";
import { CHART_TYPES, chartTypeById } from "./chartTypes";
import { CHART_TYPE_IDS } from "./types";

describe("chartTypes registry (PLAN-2026-09-20 W6)", () => {
  it("has exactly 9 types with unique ids", () => {
    expect(CHART_TYPES.length).toBe(9);
    expect(new Set(CHART_TYPES.map((c) => c.id)).size).toBe(9);
  });

  it("레지스트리와 CHART_TYPE_IDS(저장 검증·AI 프롬프트가 쓰는 id 목록)가 같은 순서로 일치한다", () => {
    expect(CHART_TYPES.map((c) => c.id)).toEqual([...CHART_TYPE_IDS]);
  });

  it("finds a type by id and returns undefined for an unknown one", () => {
    expect(chartTypeById("bar")?.id).toBe("bar");
    expect(chartTypeById("banana")).toBeUndefined();
  });

  it("scatter needs no x input and requires 2 series (x=series[0], y=series[1])", () => {
    const scatter = chartTypeById("scatter")!;
    expect(scatter.needsX).toBe(false);
    expect(scatter.minSeries).toBe(2);
  });

  it("kpi and total are card types that need no x input", () => {
    for (const id of ["kpi", "total"] as const) {
      const def = chartTypeById(id)!;
      expect(def.needsX).toBe(false);
      expect(def.isCard).toBe(true);
    }
  });

  it("the remaining 6 types need an x range and at least 1 series", () => {
    for (const id of ["bar", "line", "area", "stacked", "pie", "donut"] as const) {
      const def = chartTypeById(id)!;
      expect(def.needsX).toBe(true);
      expect(def.minSeries).toBe(1);
    }
  });
});
