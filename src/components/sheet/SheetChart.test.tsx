import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SheetChart } from "./SheetChart";
import { emptySheet, type ChartSpec, type SheetDoc } from "../../lib/sheet/types";

// Recharts 의 ResponsiveContainer 는 컨테이너를 실측한다 — jsdom 은 모든 박스가 0×0 이고
// ResizeObserver 도 없어서 반응형 경로는 아무것도 그리지 않는다. SheetChart 는 width 가 숫자면
// ResponsiveContainer 를 건너뛰므로, 테스트는 명시적 width 를 넘겨 실제 SVG 를 검사한다.
const W = 400;

describe("SheetChart component", () => {
  const doc: SheetDoc = {
    ...emptySheet(),
    cells: {
      A1: { raw: "1월" },
      A2: { raw: "2월" },
      B1: { raw: "100" },
      B2: { raw: "200" },
    },
  };

  const spec = (over: Partial<ChartSpec>): ChartSpec => ({
    id: "c1",
    type: "bar",
    x: "A1:A2",
    series: ["B1:B2"],
    ...over,
  });

  it("renders a bar chart with title, axis ticks and one bar per row", () => {
    const { container } = render(
      <SheetChart spec={spec({ type: "bar", title: "매출 현황" })} doc={doc} width={W} />
    );
    expect(screen.getByText("매출 현황")).toBeDefined();
    expect(container.querySelector(".recharts-bar")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(2);
    // x축 라벨이 실제로 그려진다 (자작 SVG 시절의 잘림 없이 원문 그대로).
    expect(screen.getByText("1월")).toBeDefined();
    expect(screen.getByText("2월")).toBeDefined();
  });

  it("renders negative values below the zero baseline", () => {
    const negDoc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "적자" }, A2: { raw: "흑자" }, B1: { raw: "-50" }, B2: { raw: "100" } },
    };
    const { container } = render(<SheetChart spec={spec({ type: "bar" })} doc={negDoc} width={W} />);
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(2);
    // 도메인이 0 을 품으므로 y축 눈금에 음수가 실제로 찍힌다(자작 SVG 는 max 만 봐서 음수가 잘렸다).
    const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value")).map(
      (el) => el.textContent ?? ""
    );
    expect(ticks.some((v) => v.startsWith("-"))).toBe(true);
  });

  it("renders a line chart with a polyline per series", () => {
    const { container } = render(
      <SheetChart spec={spec({ type: "line", title: "추이" })} doc={doc} width={W} />
    );
    expect(screen.getByText("추이")).toBeDefined();
    expect(container.querySelectorAll(".recharts-line").length).toBe(1);
    expect(container.querySelector(".recharts-line-curve")).not.toBeNull();
  });

  it("renders a pie chart with one slice per row", () => {
    const { container } = render(
      <SheetChart spec={spec({ type: "pie", title: "지출 비중" })} doc={doc} width={W} />
    );
    expect(screen.getByText("지출 비중")).toBeDefined();
    expect(container.querySelectorAll(".recharts-pie-sector").length).toBe(2);
  });

  it("hides the legend in compact mode and shows it otherwise", () => {
    const twoSeries = spec({ type: "bar", series: ["B1:B2", "B1:B2"] });
    const full = render(<SheetChart spec={twoSeries} doc={doc} width={W} />);
    expect(full.container.querySelector(".recharts-legend-wrapper")).not.toBeNull();
    full.unmount();

    const small = render(<SheetChart spec={twoSeries} doc={doc} width={W} compact />);
    expect(small.container.querySelector(".recharts-legend-wrapper")).toBeNull();
  });

  it("renders a total card chart with formatted grand total", () => {
    render(<SheetChart spec={spec({ type: "total", title: "총합계" })} doc={doc} width={W} />);
    expect(screen.getByText("총합계")).toBeDefined();
    expect(screen.getByText("300")).toBeDefined();
  });

  it("renders the empty state when the spec selects no series", () => {
    render(<SheetChart spec={spec({ series: [] })} doc={doc} width={W} />);
    expect(screen.getByText("No data to chart")).toBeDefined();
  });
});

// W6 (PLAN-2026-09-20 §2.5/D7): 9 종이 같은 데이터(x 4 개, 시리즈 2 개)로 빈 화면 없이 렌더된다.
// 스냅샷이 아니라 종류별 <svg> 안 요소 개수를 리터럴로 센다.
describe("SheetChart — 9 chart types (W6)", () => {
  const doc4: SheetDoc = {
    ...emptySheet(),
    cells: {
      A1: { raw: "1월" }, A2: { raw: "2월" }, A3: { raw: "3월" }, A4: { raw: "4월" },
      B1: { raw: "10" }, B2: { raw: "20" }, B3: { raw: "30" }, B4: { raw: "40" },
      C1: { raw: "5" }, C2: { raw: "15" }, C3: { raw: "25" }, C4: { raw: "35" },
    },
  };
  const spec4 = (over: Partial<ChartSpec>): ChartSpec => ({
    id: "c1",
    type: "bar",
    x: "A1:A4",
    series: ["B1:B4", "C1:C4"],
    ...over,
  });

  it("bar: 2 series × 4 rows = 8 rects", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "bar" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(8);
  });

  it("stacked: 2 series × 4 rows = 8 rects", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "stacked" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(8);
  });

  it("line: one polyline per series", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "line" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-line").length).toBe(2);
  });

  it("area: one area path per series, gradient fill per series", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "area" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-area").length).toBe(2);
    // 그라데이션은 area.tsx 의 <defs> 하나 안에 시리즈 수만큼(2) — recharts 자체 clipPath <defs> 는
    // 별도로 더 있을 수 있어 defs 총 개수가 아니라 linearGradient 개수로 확인한다.
    expect(container.querySelectorAll("linearGradient").length).toBe(2);
  });

  it("pie: one slice per row", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "pie" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-pie-sector").length).toBe(4);
  });

  it("donut: one slice per row, with an inner radius", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "donut" })} doc={doc4} width={W} />);
    expect(container.querySelectorAll(".recharts-pie-sector").length).toBe(4);
  });

  it("scatter: needs no x — series[0]/series[1] become x/y, 4 rows = 4 round dots", () => {
    const { container } = render(<SheetChart spec={spec4({ type: "scatter", x: undefined })} doc={doc4} width={W} />);
    expect(container.querySelectorAll("circle").length).toBe(4);
  });

  it("kpi: total number + a single sparkline path", () => {
    const { container, getByText } = render(
      <SheetChart spec={spec4({ type: "kpi", title: "합계" })} doc={doc4} width={W} />
    );
    expect(getByText("180")).toBeDefined(); // (10+20+30+40)+(5+15+25+35), extractChartData sums every series
    expect(container.querySelectorAll(".recharts-line-curve").length).toBe(1);
  });

  it("total: unchanged card behaviour survives the registry move", () => {
    render(<SheetChart spec={spec4({ type: "total", title: "합계" })} doc={doc4} width={W} />);
    expect(screen.getByText("합계")).toBeDefined();
    expect(screen.getByText("180")).toBeDefined();
  });

  it("an unknown ChartSpec.type falls back to bar instead of a blank screen", () => {
    const { container } = render(
      <SheetChart spec={spec4({ type: "banana" as unknown as ChartSpec["type"] })} doc={doc4} width={W} />
    );
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(8);
  });
});
