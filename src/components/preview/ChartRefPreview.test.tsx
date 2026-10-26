import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment, NoteDetail, Section } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { ChartRefPreview, splitChartUrl } from "./ChartRefPreview";
import { t } from "../../i18n/t";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

const att: Attachment = {
  id: "att-1",
  name: "합계",
  kind: "chart",
  rel_path: null,
  url: "sec-1#c1",
  size_bytes: null,
  position: 0,
};

function sheetBody(b2: string): string {
  return JSON.stringify({
    v: 1,
    rows: 3,
    cols: [{ w: 80 }, { w: 80 }],
    cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: b2 } },
    charts: [{ id: "c1", type: "total", title: "합계", x: "A1:A2", series: ["B1:B2"] }],
  });
}

function seed(sections: Partial<Section>[]) {
  useNotesStore.setState({
    activeNote: {
      note: { id: "n1" },
      sections: sections.map((s) => ({ id: "sec-1", name: "가계부", kind: "sheet", position: 0, body_md: "", ...s })),
      sources: [],
      attachments: [att],
    } as unknown as NoteDetail,
    reloadActive: vi.fn(async () => {}),
  });
}

describe("ChartRefPreview", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("splits section#chart and rejects malformed urls", () => {
    expect(splitChartUrl("sec-1#c1")).toEqual({ sectionId: "sec-1", chartId: "c1" });
    expect(splitChartUrl("sec-1")).toBeNull();
    expect(splitChartUrl("#c1")).toBeNull();
    expect(splitChartUrl("sec-1#")).toBeNull();
    expect(splitChartUrl(null)).toBeNull();
  });

  it("renders the chart live from the sheet section body — same attachment, changed cells, changed value", () => {
    seed([{ body_md: sheetBody("200") }]);
    const { rerender } = render(<ChartRefPreview att={att} />);
    expect(screen.getByTestId("chart-ref-preview")).toBeDefined();
    expect(screen.getByText("300")).toBeDefined();

    // 시트 셀이 바뀌면(useSheetState.saveNow 가 activeNote.sections[].body_md 를 갱신) 값이 따라온다.
    seed([{ body_md: sheetBody("500") }]);
    rerender(<ChartRefPreview att={att} />);
    expect(screen.getByText("600")).toBeDefined();
    expect(screen.queryByText("300")).toBeNull();
  });

  it("shows 원본 없음 when the section is gone and removes the row on request", async () => {
    seed([]);
    callMock.mockResolvedValue({ deleted: true });
    render(<ChartRefPreview att={att} />);
    expect(screen.getByTestId("chart-ref-missing")).toBeDefined();
    expect(screen.getByText(t("attachments.chart_missing_title"))).toBeDefined();
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-1" }));
    await waitFor(() => expect(useNotesStore.getState().reloadActive).toHaveBeenCalledTimes(1));
  });

  it("shows 원본 없음 when the chart id is no longer in the sheet's charts[] or the section is not a sheet", () => {
    const noChart = JSON.stringify({ ...JSON.parse(sheetBody("1")), charts: [] });
    seed([{ body_md: noChart }]);
    const { unmount } = render(<ChartRefPreview att={att} />);
    expect(screen.getByTestId("chart-ref-missing")).toBeDefined();
    unmount();

    seed([{ kind: "text", body_md: sheetBody("1") }]);
    render(<ChartRefPreview att={att} />);
    expect(screen.getByTestId("chart-ref-missing")).toBeDefined();
  });

  it("keeps the row when removal fails (call() already toasted)", async () => {
    seed([]);
    callMock.mockRejectedValue({ code: "DB", message: "boom" });
    render(<ChartRefPreview att={att} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    expect(useNotesStore.getState().reloadActive).not.toHaveBeenCalled();
  });
});
