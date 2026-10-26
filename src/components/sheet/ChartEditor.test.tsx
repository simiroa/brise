// W6 (PLAN-2026-09-20 §4 W6 item 5): 종류 목록 = 레지스트리 순회, needsX:false 종류는 x 입력을
// 숨기고, minSeries 미달이면 저장 버튼이 비활성화된다.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChartEditor } from "./ChartEditor";
import { emptySheet, type SheetDoc } from "../../lib/sheet/types";
import { CHART_TYPES } from "../../lib/sheet/chartTypes";
import { t } from "../../i18n/t";

const doc: SheetDoc = {
  ...emptySheet(),
  cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
};

describe("ChartEditor — chart type registry (W6)", () => {
  it("renders one button per registry entry", () => {
    render(<ChartEditor doc={doc} onSave={() => {}} onClose={() => {}} />);
    for (const c of CHART_TYPES) {
      expect(screen.getByTestId(`chart-type-${c.id}`)).toBeDefined();
    }
    expect(document.querySelectorAll('[data-testid^="chart-type-"]').length).toBe(CHART_TYPES.length);
  });

  it("hides the X axis field for a needsX:false type (scatter) and shows it for bar", () => {
    render(<ChartEditor doc={doc} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId("chart-x-range-field")).toBeDefined();

    fireEvent.click(screen.getByTestId("chart-type-scatter"));
    expect(screen.queryByTestId("chart-x-range-field")).toBeNull();
  });

  it("disables Apply and shows a hint when scatter has fewer than its minSeries (2)", () => {
    render(
      <ChartEditor doc={doc} defaultSeriesRanges={["B1:B2"]} onSave={() => {}} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId("chart-type-scatter"));

    const apply = screen.getByText(t("common.apply")) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByTestId("chart-min-series-hint")).toBeDefined();

    fireEvent.click(screen.getByText(t("editor.sheet_add_col")));
    const inputs = screen.getAllByPlaceholderText("e.g. B2:B10");
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "C1:C2" } });

    expect((screen.getByText(t("common.apply")) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("chart-min-series-hint")).toBeNull();
  });

  it("saving is a no-op while minSeries is unmet", () => {
    let saved: unknown = null;
    render(
      <ChartEditor doc={doc} defaultSeriesRanges={["B1:B2"]} onSave={(s) => { saved = s; }} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId("chart-type-scatter"));
    fireEvent.click(screen.getByText(t("common.apply")));
    expect(saved).toBeNull();
  });
});
