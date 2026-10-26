// PLAN-2026-09-20 W5 D6ⓑ — 선택 모서리 퀵 칩 + 팝오버. 칩은 2셀 이상 선택 + 추천 종류가 있을 때만
// DOM 에 있고, 팝오버의 종류 클릭은 어시스트 타일과 **같은 addChartFromSelection 인자**를 만든다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SheetSection } from "./SheetSection";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";
import type { Section } from "../../lib/commands.gen";
import { useSheetFocus } from "../../stores/sheetFocus";
import * as addChartMod from "../../lib/sheet/addChart";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));
vi.mock("../../lib/aiSectionBridge", () => ({ registerSheetTarget: vi.fn(() => () => {}) }));
vi.mock("../../stores/runAiAction", () => ({ runSheetFormulaHelper: vi.fn() }));
vi.mock("../../stores/notes", () => {
  const storeState = { updateSectionBody: vi.fn(), activeNote: null, reloadActive: vi.fn(async () => {}) };
  const mockHook = vi.fn((selector) => (selector ? selector(storeState) : storeState));
  (mockHook as any).getState = () => storeState;
  (mockHook as any).setState = vi.fn();
  return { useNotesStore: mockHook };
});
const setChartRegisteredMock = vi.fn(async (_args: unknown) => {});
vi.mock("../../lib/sheet/chartAttachment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sheet/chartAttachment")>();
  return { ...actual, setChartRegistered: (args: unknown) => setChartRegisteredMock(args) };
});

const doc: SheetDoc = {
  ...emptySheet(),
  cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
};
const section: Section = { id: "sec-1", name: "Sheet", kind: "sheet", body_md: serializeSheet(doc), position: 0 };

/** A1 클릭 → Shift+클릭 B2 = 범위 A1:B2. 셀은 값 텍스트로 찾는다. */
// recharts 가 body 에 남기는 측정용 span(#recharts_measurement_span)이 같은 글자를 갖고 있어 getByText 는
// 여러 개로 잡힌다 — 셀 안에서만 찾는다.
const cellOf = (text: string) => Array.from(document.querySelectorAll(".sheet-cell")).find((c) => c.textContent === text)!;
function selectA1B2() {
  fireEvent.mouseDown(cellOf("1월"));
  fireEvent.mouseDown(cellOf("200"), { shiftKey: true });
}

describe("SheetQuickChart — 퀵 칩과 팝오버", () => {
  beforeEach(() => {
    setChartRegisteredMock.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useSheetFocus.setState({ focus: null });
  });

  it("한 칸 선택엔 칩이 없고, 2셀 이상 + 추천이 있으면 sheet-quick-chart 가 선택 우하단 셀에 있다", () => {
    render(<SheetSection section={section} />);
    expect(screen.queryByTestId("sheet-quick-chart")).toBeNull();
    selectA1B2();
    const chip = screen.getByTestId("sheet-quick-chart");
    expect(chip.closest(".sheet-cell")!.textContent).toContain("200");
  });

  it("숫자가 없는 범위(A1:A2)엔 추천이 없어 칩도 없다", () => {
    render(<SheetSection section={section} />);
    fireEvent.mouseDown(screen.getByText("1월").closest(".sheet-cell")!);
    fireEvent.mouseDown(screen.getByText("2월").closest(".sheet-cell")!, { shiftKey: true });
    expect(screen.queryByTestId("sheet-quick-chart")).toBeNull();
  });

  it("칩 클릭 → 팝오버에 추천 카드 1장(미리보기 svg 하나 + 종류 칩), 고정 클릭 → 어시스트와 같은 관문 같은 인자", async () => {
    const spy = vi.spyOn(addChartMod, "addChartFromSelection").mockResolvedValue({ ok: true, chartId: "c" });
    render(<SheetSection section={section} />);
    selectA1B2();
    fireEvent.click(screen.getByTestId("sheet-quick-chart"));
    const pop = screen.getByTestId("sheet-quick-chart-popover");
    // 2행 → pie 가 1위(recommendChartTypes 규칙과 같다). 칩은 전 종류, 미리보기는 한 장.
    expect(pop.querySelector('[data-testid="chart-suggest-card"]')!.getAttribute("data-chart-type")).toBe("pie");
    const chips = Array.from(pop.querySelectorAll('[data-testid^="chart-suggest-type-"]')).map((b) => b.getAttribute("data-testid"));
    expect(chips).toEqual(["chart-suggest-type-pie", "chart-suggest-type-bar", "chart-suggest-type-line"]);
    await waitFor(() => expect(pop.querySelectorAll(".sheet-chart svg").length).toBe(1));

    fireEvent.click(screen.getByTestId("chart-suggest-type-bar"));
    fireEvent.click(screen.getByTestId("chart-suggest-pin"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ sectionId: "sec-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: "bar", register: true });
    expect(screen.queryByTestId("sheet-quick-chart-popover")).toBeNull();
  });

  it("Esc 로 닫으면 고정하지 않는다", () => {
    const spy = vi.spyOn(addChartMod, "addChartFromSelection").mockResolvedValue({ ok: true, chartId: "c" });
    render(<SheetSection section={section} />);
    selectA1B2();
    fireEvent.click(screen.getByTestId("sheet-quick-chart"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("sheet-quick-chart-popover")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("실제 관문: 고정 클릭 → 열린 시트의 doc.charts 에 1개(sheetFocus 재게시) + setChartRegistered on:true 1회", async () => {
    render(<SheetSection section={section} />);
    selectA1B2();
    // useSheetState 가 100ms 뒤 sheetFocus 를 게시해야 addChartFromSelection 이 열린 시트를 찾는다.
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(useSheetFocus.getState().focus?.sectionId).toBe("sec-1");
    fireEvent.click(screen.getByTestId("sheet-quick-chart"));
    await act(async () => { fireEvent.click(screen.getByTestId("chart-suggest-pin")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(useSheetFocus.getState().focus?.doc.charts?.length).toBe(1);
    await waitFor(() => expect(setChartRegisteredMock).toHaveBeenCalledTimes(1));
    expect(setChartRegisteredMock.mock.calls[0][0]).toMatchObject({ sectionId: "sec-1", on: true });
    expect((setChartRegisteredMock.mock.calls[0][0] as { chartId: string }).chartId.startsWith("chart-")).toBe(true);
  });
});
