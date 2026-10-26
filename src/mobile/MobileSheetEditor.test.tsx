import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MobileSheetEditor } from "./MobileSheetEditor";
import type { Section } from "../lib/commands.gen";
import { parseSheet, serializeSheet } from "../lib/sheet/types";
import { useNotesStore } from "../stores/notes";
import { flushAll } from "../lib/invoke";
import { t } from "../i18n/t";

// 차트 패널 토글 검증용 — 실제 SheetChart(차트 라이브러리, lazy)를 끌어오지 않는다.
vi.mock("../components/sheet/SheetChart", () => ({
  SheetChart: () => <div data-testid="chart-stub" />,
}));

describe("MobileSheetEditor", () => {
  const dummySection: Section = {
    id: "sec-1",
    name: "My Sheet",
    position: 0,
    kind: "sheet",
    body_md: serializeSheet({
      v: 1,
      rows: 5,
      cols: [
        { w: 90, fmt: "text" },
        { w: 90, fmt: "number" },
        { w: 90, fmt: "checkbox" },
      ],
      cells: {
        A1: { raw: "Item" },
        B1: { raw: "100" },
        C1: { raw: "TRUE" },
      },
      charts: [],
    }),
  };


  it("renders mobile sheet grid with cell values", () => {
    const { container } = render(<MobileSheetEditor section={dummySection} />);
    expect(screen.getByText("Item")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(container.querySelector("td svg.lucide-square-check-big")).toBeTruthy();
  });

  it("tapping a text cell opens bottom input bar and updates cell on commit", () => {
    render(<MobileSheetEditor section={dummySection} />);
    const cellA1 = screen.getByText("Item");
    fireEvent.click(cellA1);

    const input = screen.getByPlaceholderText(t("editor.sheet_formula_helper")) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Item");

    fireEvent.change(input, { target: { value: "Updated Item" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Updated Item")).toBeTruthy();
  });

  it("tapping a checkbox cell toggles boolean value immediately without opening input bar", () => {
    const { container } = render(<MobileSheetEditor section={dummySection} />);
    const checkboxCell = container.querySelector("td svg.lucide-square-check-big")!.closest("td")!;
    fireEvent.click(checkboxCell);

    expect(container.querySelectorAll("td svg.lucide-square").length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText(t("editor.sheet_formula_helper"))).toBeNull();
  });

  it("adds rows and columns when toolbar buttons are clicked", () => {
    render(<MobileSheetEditor section={dummySection} />);
    const addRowBtn = screen.getByText(t("editor.sheet_add_row"));
    const addColBtn = screen.getByText(t("editor.sheet_add_col"));

    fireEvent.click(addRowBtn);
    fireEvent.click(addColBtn);

    // Row 6 and Column D should be present
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("D")).toBeTruthy();
  });
});

// 저장 정직성 — 디바운스 자동저장은 "가장 마지막 편집"을 쓴다. 이전에는 [doc, section.id] 의존성의 정리
// 함수가 편집마다 돌아 대기 중인 700ms 타이머를 취소하고 **직전** 문서를 즉시 썼다 — 저장본이 한 편집씩
// 뒤처지고, 마지막 편집은 언마운트 때만 써졌다(그 사이 앱이 죽으면 유실).
describe("MobileSheetEditor autosave", () => {
  const body = serializeSheet({
    v: 1,
    rows: 5,
    cols: [{ w: 90, fmt: "text" }],
    cells: { A1: { raw: "Item" } },
    charts: [],
  });
  const section: Section = { id: "sec-1", name: "My Sheet", position: 0, kind: "sheet", body_md: body };
  const original = useNotesStore.getState().updateSectionBody;
  let updateSectionBody: Mock<(id: string, body_md: string) => Promise<void>>;

  const savedDocs = () => updateSectionBody.mock.calls.map(([, md]) => parseSheet(md as string)!);
  const addRow = () => fireEvent.click(screen.getByText(t("editor.sheet_add_row")));
  const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
    updateSectionBody = vi.fn<(id: string, body_md: string) => Promise<void>>().mockResolvedValue(undefined);
    useNotesStore.setState({ updateSectionBody, activeNote: null, savedState: "saved", saveConflict: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    useNotesStore.setState({ updateSectionBody: original });
  });

  it("one edit: nothing is written before 700ms, then the LATEST doc is written once", () => {
    render(<MobileSheetEditor section={section} />);
    addRow();
    tick(699);
    expect(updateSectionBody).not.toHaveBeenCalled();
    tick(1);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(updateSectionBody.mock.calls[0][0]).toBe("sec-1");
    expect(savedDocs()[0].rows).toBe(6);
  });

  it("two quick edits collapse into ONE debounced write carrying the latest doc", () => {
    render(<MobileSheetEditor section={section} />);
    addRow();
    tick(300);
    addRow();
    tick(699);
    expect(updateSectionBody).not.toHaveBeenCalled();
    tick(1);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(savedDocs()[0].rows).toBe(7);
  });

  it("unmounting with a pending edit flushes the latest doc exactly once", () => {
    const { unmount } = render(<MobileSheetEditor section={section} />);
    addRow();
    addRow();
    expect(updateSectionBody).not.toHaveBeenCalled();
    unmount();
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(savedDocs()[0].rows).toBe(7);
    tick(2000); // the cancelled debounce must not fire a second write
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
  });

  it("unmounting after the debounce already wrote does not write again", () => {
    const { unmount } = render(<MobileSheetEditor section={section} />);
    addRow();
    tick(700);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    unmount();
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
  });

  it("mounting and unmounting without an edit writes nothing", () => {
    const { unmount } = render(<MobileSheetEditor section={section} />);
    unmount();
    expect(updateSectionBody).not.toHaveBeenCalled();
  });

  it("an edit that leaves the doc unchanged does not write", () => {
    render(<MobileSheetEditor section={section} />);
    fireEvent.click(screen.getByText("Item"));
    fireEvent.keyDown(screen.getByPlaceholderText(t("editor.sheet_formula_helper")), { key: "Enter" });
    tick(2000);
    expect(updateSectionBody).not.toHaveBeenCalled();
  });

  it("flushAll() (window close / retry / conflict collect) writes a pending edit at once", async () => {
    render(<MobileSheetEditor section={section} />);
    addRow();
    expect(updateSectionBody).not.toHaveBeenCalled();
    await act(async () => {
      await flushAll();
    });
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(savedDocs()[0].rows).toBe(6);
    tick(2000);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
  });

  it("a save the conflict gate holds is not re-sent on unmount (conflict \"copy\" remounts over the fresh server copy)", () => {
    updateSectionBody.mockImplementation(async () => {
      useNotesStore.setState({ savedState: "failed", saveConflict: { noteId: "n1", sectionId: "sec-1" } });
    });
    const { unmount } = render(<MobileSheetEditor section={section} />);
    addRow();
    tick(700);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    unmount();
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
  });

  it("a rejected write (draft note materialize failure) is reported, not an unhandled rejection", async () => {
    updateSectionBody.mockRejectedValue(new Error("materialize failed"));
    const { unmount } = render(<MobileSheetEditor section={section} />);
    addRow();
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
  });

  it("keeps activeNote.sections in step with what was saved (a tab round trip must not repaint a stale body)", () => {
    useNotesStore.setState({
      activeNote: { note: { id: "n1" }, sections: [{ ...section }], attachments: [] } as never,
    });
    render(<MobileSheetEditor section={section} />);
    addRow();
    tick(700);
    const cached = useNotesStore.getState().activeNote!.sections[0].body_md;
    expect(parseSheet(cached)!.rows).toBe(6);
  });
});

// 화면 끝까지 닿는 한 장(오너 2026-10-07 "시트는 프레임 안에 갇혀 있어서 답답해 보임") — 레이아웃은 CSS 가 갖는다
// (styles/mobile/sheet.css, 계약은 sheet.contract.test.ts). jsdom 은 CSS 를 적용하지 않으니 여기서 고정하는 건 마크업이다:
// 상자(.card)·인라인 박스 스타일이 다시 붙지 않는 것, 그리고 입력 도중 눌리는 버튼이 포커스(=화면 키보드)를 뺏지 않는 것.
describe("MobileSheetEditor frame-free layout", () => {
  const sheetSection: Section = {
    id: "sec-1",
    name: "My Sheet",
    position: 0,
    kind: "sheet",
    body_md: serializeSheet({
      v: 1,
      rows: 5,
      cols: [{ w: 90, fmt: "text" }],
      cells: { A1: { raw: "Item" } },
      charts: [],
    }),
  };

  it("the root is a bare flex child: no .card frame, no inline box styles", () => {
    const { container } = render(<MobileSheetEditor section={sheetSection} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe("mobile-sheet-editor");
    expect(root.classList.contains("card")).toBe(false);
    // 인라인 height/overflow/position 이 돌아오면 sheet.css 의 flex:1 이 가려져 고정 상자로 되돌아간다.
    expect(root.getAttribute("style")).toBeNull();
  });

  it("the grid scroller keeps its hook class (sheet.css pins its padding / overscroll there)", () => {
    const { container } = render(<MobileSheetEditor section={sheetSection} />);
    expect(container.querySelector(".mobile-sheet-editor > .mobile-sheet-grid-container")).toBeTruthy();
  });

  it("the toolbar is the first child; pressing it does not steal the input focus", () => {
    const { container } = render(<MobileSheetEditor section={sheetSection} />);
    const toolbar = container.querySelector(".mobile-sheet-editor > .mobile-sheet-toolbar") as HTMLElement;
    expect(toolbar).toBeTruthy();
    expect(container.firstElementChild!.firstElementChild).toBe(toolbar);
    // fireEvent 는 preventDefault 됐으면 false.
    expect(fireEvent.mouseDown(screen.getByText(t("editor.sheet_add_row")))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText(t("editor.sheet_add_col")))).toBe(false);
  });

  it("the cell edit bar is an opaque .overlay dock; its buttons keep focus, its input does not", () => {
    const { container } = render(<MobileSheetEditor section={sheetSection} />);
    expect(container.querySelector(".mobile-sheet-editbar")).toBeNull();
    fireEvent.click(screen.getByText("Item"));

    const bar = container.querySelector(".mobile-sheet-editbar") as HTMLElement;
    expect(bar.classList.contains("overlay")).toBe(true);
    // 인라인 레이아웃(sticky/border/shadow)이 돌아오면 sheet.css 의 독 규칙이 가려진다.
    expect(bar.getAttribute("style")).toBeNull();

    const input = screen.getByPlaceholderText(t("editor.sheet_formula_helper"));
    expect(fireEvent.mouseDown(input)).toBe(true); // 입력칸은 포커스를 받아야 한다
    expect(fireEvent.mouseDown(screen.getByText("SUM("))).toBe(false);
    const actionButtons = [...bar.querySelectorAll(":scope > div:last-child > button")]; // 확인(✓) · 닫기(×)
    expect(actionButtons).toHaveLength(2);
    for (const b of actionButtons) expect(fireEvent.mouseDown(b)).toBe(false);
  });

  it("the edit bar's confirm/close are named 48px targets; the snippets are classed (sizing lives in sheet.css)", () => {
    const { container } = render(<MobileSheetEditor section={sheetSection} />);
    fireEvent.click(screen.getByText("Item"));
    const confirm = screen.getByRole("button", { name: t("common.apply") });
    expect(confirm.className).toBe("mobile-sheet-confirm");
    expect(confirm.getAttribute("style")).toBeNull(); // 색·크기는 CSS 토큰 — 인라인 리터럴 없음
    expect(screen.getByRole("button", { name: t("common.close") }).className).toBe("mobile-icon-btn");
    const snippets = container.querySelectorAll(".mobile-sheet-snippets .mobile-sheet-snippet");
    expect(Array.from(snippets).map((b) => b.textContent)).toEqual(["=", "+", "-", "*", "/", "SUM("]);
  });

  it("no chart toggle without charts; with charts it toggles a panel and reports aria-pressed", async () => {
    const { unmount } = render(<MobileSheetEditor section={sheetSection} />);
    expect(screen.queryByRole("button", { name: t("editor.sheet_chart") })).toBeNull();
    unmount();

    const withChart: Section = {
      ...sheetSection,
      body_md: serializeSheet({
        v: 1,
        rows: 5,
        cols: [{ w: 90, fmt: "text" }],
        cells: { A1: { raw: "Item" } },
        charts: [{ id: "c1", type: "bar", series: ["A1:A3"] }],
      }),
    };
    const r = render(<MobileSheetEditor section={withChart} />);
    const toggle = screen.getByRole("button", { name: t("editor.sheet_chart") });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(r.container.querySelector(".mobile-sheet-charts")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("data-active")).toBe("true");
    expect(r.container.querySelector(".mobile-sheet-charts")).toBeTruthy();
    expect(await screen.findByTestId("chart-stub")).toBeTruthy();

    fireEvent.click(toggle);
    expect(r.container.querySelector(".mobile-sheet-charts")).toBeNull();
  });
});
