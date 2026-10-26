// PLAN-2026-09-20 W5 — 진입점 셋이 부르는 단일 관문. 스펙 생성 → 열린 시트의 addChart(undo 경로) →
// register 면 setChartRegistered(on:true) 한 번.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addChartFromSelection } from "./addChart";
import { useSheetFocus, type SheetFocus } from "../../stores/sheetFocus";
import { emptySheet, type ChartSpec, type SheetDoc } from "./types";
import { SheetEngine } from "./engine";

const setChartRegisteredMock = vi.fn(async (_args: unknown) => {});
vi.mock("./chartAttachment", () => ({
  setChartRegistered: (args: unknown) => setChartRegisteredMock(args),
}));

const doc: SheetDoc = {
  ...emptySheet(),
  cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
};

function focusWith(addChart: (spec: ChartSpec) => void): SheetFocus {
  return { noteId: "n1", sectionId: "sec-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, doc, engine: new SheetEngine(doc), addChart };
}

describe("addChartFromSelection", () => {
  beforeEach(() => {
    setChartRegisteredMock.mockClear();
    useSheetFocus.setState({ focus: null });
  });

  it("열린 시트가 없거나 다른 섹션이면 ok:false — 아무것도 만들지 않는다", async () => {
    expect(await addChartFromSelection({ sectionId: "sec-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: "bar", register: true })).toEqual({ ok: false });
    const addChart = vi.fn();
    useSheetFocus.setState({ focus: focusWith(addChart) });
    expect(await addChartFromSelection({ sectionId: "other", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: "bar", register: true })).toEqual({ ok: false });
    expect(addChart).not.toHaveBeenCalled();
    expect(setChartRegisteredMock).not.toHaveBeenCalled();
  });

  it("doc.charts 에 1개 추가(defaultChartRanges 규칙) + setChartRegistered 를 on:true 로 1회", async () => {
    const charts: ChartSpec[] = [];
    useSheetFocus.setState({ focus: focusWith((spec) => charts.push(spec)) });
    const res = await addChartFromSelection({ sectionId: "sec-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: "line", register: true });
    expect(res.ok).toBe(true);
    expect(charts).toHaveLength(1);
    expect(charts[0]).toEqual({ id: res.chartId, type: "line", x: "A1:A2", series: ["B1:B2"] });
    expect(charts[0].id.startsWith("chart-")).toBe(true);
    expect(setChartRegisteredMock).toHaveBeenCalledTimes(1);
    expect(setChartRegisteredMock).toHaveBeenCalledWith({ noteId: "n1", sectionId: "sec-1", chartId: res.chartId, name: expect.any(String), on: true });
  });

  it("register:false 면 등록을 부르지 않고, 등록 실패는 삼킨다(차트는 남는다)", async () => {
    const charts: ChartSpec[] = [];
    useSheetFocus.setState({ focus: focusWith((spec) => charts.push(spec)) });
    await addChartFromSelection({ sectionId: "sec-1", range: { r1: 0, c1: 1, r2: 1, c2: 1 }, type: "kpi", register: false });
    expect(setChartRegisteredMock).not.toHaveBeenCalled();
    setChartRegisteredMock.mockRejectedValueOnce(new Error("boom"));
    const res = await addChartFromSelection({ sectionId: "sec-1", range: { r1: 0, c1: 1, r2: 1, c2: 1 }, type: "kpi", register: true });
    expect(res.ok).toBe(true);
    expect(charts).toHaveLength(2);
  });
});
