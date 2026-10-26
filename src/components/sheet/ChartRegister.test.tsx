// D6ⓒ: 차트 편집기의 "첨부에 등록" 체크박스와 차트 카드의 클립 버튼은 **같은 함수**
// (lib/sheet/chartAttachment::setChartRegistered)를 부르고, 체크 상태의 진실은 DB 행
// (activeNote.attachments 의 kind='chart')이다 — 시트 JSON 에 플래그가 없다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChartEditor } from "./ChartEditor";
import { SheetChartsPanel } from "./SheetChartsPanel";
import { emptySheet, type ChartSpec, type SheetDoc } from "../../lib/sheet/types";
import { SheetEngine } from "../../lib/sheet/engine";
import type { Attachment, NoteDetail } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { useSheetFocus } from "../../stores/sheetFocus";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));
vi.mock("../../lib/aiSectionBridge", () => ({ registerSheetTarget: vi.fn(() => () => {}) }));
vi.mock("../../stores/runAiAction", () => ({ runSheetFormulaHelper: vi.fn() }));

const setChartRegisteredMock = vi.fn(async (_args: unknown) => {});
vi.mock("../../lib/sheet/chartAttachment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sheet/chartAttachment")>();
  return { ...actual, setChartRegistered: (args: unknown) => setChartRegisteredMock(args) };
});

const chart: ChartSpec = { id: "c1", type: "bar", title: "매출", x: "A1:A2", series: ["B1:B2"] };
const doc: SheetDoc = {
  ...emptySheet(),
  cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
  charts: [chart],
};
const registeredRow: Attachment = {
  id: "att-1",
  name: "매출",
  kind: "chart",
  rel_path: null,
  url: "sec-1#c1",
  size_bytes: null,
  position: 0,
};

function seed(attachments: Attachment[]) {
  useNotesStore.setState({
    activeNote: {
      note: { id: "n1" },
      sections: [],
      sources: [],
      attachments,
    } as unknown as NoteDetail,
  });
}

describe("ChartEditor register toggle", () => {
  beforeEach(() => setChartRegisteredMock.mockClear());

  it("is hidden without noteId/sectionId", () => {
    seed([]);
    render(<ChartEditor doc={doc} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId("chart-register-toggle")).toBeNull();
  });

  it("reads its initial state from the DB row and unregisters through setChartRegistered", async () => {
    seed([registeredRow]);
    render(<ChartEditor initialSpec={chart} doc={doc} onSave={vi.fn()} onClose={vi.fn()} noteId="n1" sectionId="sec-1" />);
    const box = screen.getByTestId("chart-register-toggle").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(setChartRegisteredMock).toHaveBeenCalledTimes(1));
    expect(setChartRegisteredMock).toHaveBeenCalledWith({
      noteId: "n1",
      sectionId: "sec-1",
      chartId: "c1",
      name: "매출",
      on: false,
    });
  });

  it("for a new chart registers only after save, with the saved chart id and title (fallback when blank)", async () => {
    seed([]);
    const onSave = vi.fn();
    render(<ChartEditor doc={doc} defaultXRange="A1:A2" defaultSeriesRanges={["B1:B2"]} onSave={onSave} onClose={vi.fn()} noteId="n1" sectionId="sec-1" />);
    const box = screen.getByTestId("chart-register-toggle").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    // 아직 id 가 없으니 IPC 없음.
    expect(setChartRegisteredMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t("common.apply")));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ChartSpec;
    await waitFor(() => expect(setChartRegisteredMock).toHaveBeenCalledTimes(1));
    expect(setChartRegisteredMock).toHaveBeenCalledWith({
      noteId: "n1",
      sectionId: "sec-1",
      chartId: saved.id,
      name: t("attachments.chart_untitled"),
      on: true,
    });
  });
});

// 카드는 어시스트 상단(SheetChartsPanel)에 있고 stores/sheetFocus 가 게시한 문서를 본다(2026-09-21).
describe("SheetChartsPanel chart card register button", () => {
  const openChartEditor = vi.fn();
  // 패널이 useElementSize(ResizeObserver)로 카드 폭을 잰다(오너 제안 #8) — jsdom 엔 없으니
  // 매 테스트가 스텁을 깔아야 한다(useElementSize.test.tsx·SourcePanel.test.tsx 와 같은 모양).
  // 기본 999 는 "항상 충분히 넓다"로 clamp 상한(260)에 걸려 기존 테스트들의 수치엔 영향 없다.
  let resizeObserverBoxWidth = 999;
  beforeEach(() => {
    setChartRegisteredMock.mockClear();
    openChartEditor.mockClear();
    resizeObserverBoxWidth = 999;
    global.ResizeObserver = class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        this.cb(
          [
            {
              target,
              contentRect: {
                width: resizeObserverBoxWidth,
                height: 0,
                top: 0,
                left: 0,
                right: resizeObserverBoxWidth,
                bottom: 0,
                x: 0,
                y: 0,
              },
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    };
    useSheetFocus.setState({
      focus: { noteId: "n1", sectionId: "sec-1", range: null, doc, engine: new SheetEngine(doc), addChart: vi.fn() },
      openChartEditor,
    });
  });

  it("charts 가 비면 패널 자체가 없다", () => {
    seed([]);
    useSheetFocus.setState({ focus: { noteId: "n1", sectionId: "sec-1", range: null, doc: emptySheet(), engine: new SheetEngine(emptySheet()), addChart: vi.fn() } });
    render(<SheetChartsPanel />);
    expect(screen.queryByTestId("sheet-charts-panel")).toBeNull();
  });

  it("카드 클릭 → 열린 시트의 편집기(openChartEditor)에 그 스펙, + 차트 → null", () => {
    seed([]);
    render(<SheetChartsPanel />);
    fireEvent.click(screen.getByTitle(t("editor.sheet_chart_edit_hint")));
    expect(openChartEditor).toHaveBeenCalledWith(chart);
    fireEvent.click(screen.getByTestId("sheet-charts-panel-add"));
    expect(openChartEditor).toHaveBeenLastCalledWith(null);
  });

  it("shows pressed state from the DB row and toggles through the same setChartRegistered", async () => {
    seed([registeredRow]);
    render(<SheetChartsPanel />);
    const btn = screen.getByTestId("chart-register-c1");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    await waitFor(() => expect(setChartRegisteredMock).toHaveBeenCalledTimes(1));
    expect(setChartRegisteredMock).toHaveBeenCalledWith({
      noteId: "n1",
      sectionId: "sec-1",
      chartId: "c1",
      name: "매출",
      on: false,
    });
  });

  it("registers (on: true) when no row exists and does not open the editor", async () => {
    seed([]);
    render(<SheetChartsPanel />);
    const btn = screen.getByTestId("chart-register-c1");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    await waitFor(() => expect(setChartRegisteredMock).toHaveBeenCalledTimes(1));
    expect((setChartRegisteredMock.mock.calls[0][0] as { on: boolean }).on).toBe(true);
    expect(openChartEditor).not.toHaveBeenCalled();
  });

  it("폭 320 이면 높이 180 (16:9, ResizeObserver 로 측정한 폭에서 계산)", async () => {
    resizeObserverBoxWidth = 320;
    seed([]);
    render(<SheetChartsPanel />);
    await waitFor(() => {
      const el = document.querySelector(".sheet-chart") as HTMLElement | null;
      expect(el?.style.height).toBe("180px");
    });
  });

  it("형식 버튼 → 메뉴에서 종류를 고르면 같은 id 로 type 만 바뀐 스펙을 addChart 에 넣는다(편집기는 안 열림)", () => {
    seed([]);
    render(<SheetChartsPanel />);
    fireEvent.click(screen.getByTestId("chart-type-c1"));
    // 시리즈 1개 → scatter(minSeries 2)는 목록에 없다
    expect(screen.queryByTestId("chart-type-option-scatter")).toBeNull();
    expect(screen.getByTestId("chart-type-option-bar").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("chart-type-option-line"));
    const addChart = useSheetFocus.getState().focus!.addChart as ReturnType<typeof vi.fn>;
    expect(addChart).toHaveBeenCalledWith({ ...chart, type: "line" });
    expect(openChartEditor).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chart-type-menu")).toBeNull();
  });

  it("현재 종류를 다시 고르면 아무것도 저장하지 않는다 · x 가 필요 없는 종류(kpi)로 바꾸면 x 를 뗀다", () => {
    seed([]);
    render(<SheetChartsPanel />);
    const addChart = useSheetFocus.getState().focus!.addChart as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByTestId("chart-type-c1"));
    fireEvent.click(screen.getByTestId("chart-type-option-bar"));
    expect(addChart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("chart-type-c1"));
    fireEvent.click(screen.getByTestId("chart-type-option-kpi"));
    expect(addChart).toHaveBeenCalledWith({ ...chart, type: "kpi", x: undefined });
  });
});
