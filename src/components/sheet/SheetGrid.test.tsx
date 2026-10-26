// 선택·이동 문법(PLAN-2026-09-21 W1)의 키 조합 계약. 순수 함수(navigation.ts)는 그쪽에서
// 리터럴로 다 덮으니, 여기는 SheetGrid 가 그 순수 함수를 올바른 값으로 부르는지만 본다 —
// 렌더는 SheetGrid.perf.test.tsx 와 같은 패턴(SheetSection 을 통째로 그려 실제 DOM으로 검증).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SheetSection } from "./SheetSection";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";
import { DEFAULT_ROW_HEIGHT, rowHeightOf } from "../../lib/sheet/rowHeights";
import type { Section } from "../../lib/commands.gen";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  registerSheetTarget: vi.fn(() => () => {}),
}));

vi.mock("../../stores/runAiAction", () => ({
  runSheetFormulaHelper: vi.fn(async () => null),
}));

vi.mock("../../stores/notes", () => {
  const storeState = { updateSectionBody: vi.fn(), activeNote: null };
  const mockHook = vi.fn((selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState));
  (mockHook as unknown as { getState: () => typeof storeState }).getState = () => storeState;
  (mockHook as unknown as { setState: () => void }).setState = vi.fn();
  return { useNotesStore: mockHook };
});

function sectionOf(doc: SheetDoc, id = "sec-1"): Section {
  return { id, name: "시트", kind: "sheet", body_md: serializeSheet(doc), position: 0 };
}

/** 활성 셀/범위가 찍히는 수식 입력줄 라벨. "A1" 또는 "A1:B2" 형태(SheetSection 의 rangeLabel). */
function cellRefLabel(container: HTMLElement): string {
  return container.querySelector('[data-testid="sheet-formula-cell-ref"]')!.textContent ?? "";
}

function gridOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".sheet-grid-container") as HTMLElement;
}

describe("SheetGrid 선택·이동 문법", () => {
  it("Ctrl+A는 문서 전체를 선택하고 활성 셀은 그대로 둔다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });

    // emptySheet() = 100행×26열 → A1:Z100. "range: "A1:Z100"" 은 아래 이 리터럴과 그대로 일치.
    expect(cellRefLabel(container)).toBe("A1:Z100");
  });

  it("모서리 칸 클릭도 Ctrl+A와 같은 전체 선택을 한다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const corner = container.querySelector(".sheet-corner-header") as HTMLElement;

    fireEvent.click(corner);

    expect(cellRefLabel(container)).toBe("A1:Z100");
  });

  it("Ctrl+화살표는 연속 데이터 끝으로 점프한다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "1" };
    doc.cells.B1 = { raw: "2" };
    doc.cells.C1 = { raw: "3" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "ArrowRight", ctrlKey: true });

    expect(cellRefLabel(container)).toBe("C1");
  });

  it("Shift+화살표는 활성 셀을 고정하고 반대 모서리를 확장한다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });

    expect(cellRefLabel(container)).toBe("A1:B2");
  });

  it("Ctrl+Shift+화살표는 확장 모서리를 데이터 끝까지 점프시킨다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "1" };
    doc.cells.A2 = { raw: "2" };
    doc.cells.A3 = { raw: "3" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true, shiftKey: true });

    expect(cellRefLabel(container)).toBe("A1:A3");
  });

  it("End 는 그 행의 마지막 채워진 열로 이동한다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "1" };
    doc.cells.C1 = { raw: "3" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "End" });

    expect(cellRefLabel(container)).toBe("C1");
  });

  it("Ctrl+End 는 채워진 영역의 우하단으로 이동한다", () => {
    const doc = emptySheet();
    doc.cells.B3 = { raw: "x" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });

    expect(cellRefLabel(container)).toBe("B3");
  });

  it("열 경계 더블클릭은 값 폭에 맞춰 열 너비를 바꾼다(자동 맞춤)", () => {
    const doc = emptySheet();
    // jsdom 은 canvas 2d 컨텍스트가 없어 글자 수 어림값(7px/자)으로 떨어진다 — 기본 열 폭(100px)과
    // 확실히 갈라지도록 30자를 넣는다(30*7+16=226 ≠ 100).
    doc.cells.A1 = { raw: "가".repeat(30) };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    const handle = container.querySelector(".sheet-col-resize-handle") as HTMLElement;
    const before = (container.querySelector(".sheet-header-cell") as HTMLElement).style.width;
    fireEvent.doubleClick(handle);
    const after = (container.querySelector(".sheet-header-cell") as HTMLElement).style.width;

    expect(after).not.toBe(before);
  });

  it("PageDown/PageUp은 보이는 행 수(jsdom 폴백 10행)만큼 활성 셀을 이동시킨다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(cellRefLabel(container)).toBe("A11");

    fireEvent.keyDown(grid, { key: "PageUp" });
    expect(cellRefLabel(container)).toBe("A1");
  });

  it("PageDown은 마지막 행(numRows-1)을 넘지 않는다(경계 클램프)", () => {
    // numRows = Math.max(doc.rows, 50) — rows 를 20 으로 줄여도 바닥은 50 이라 경계는 49행(A50).
    const doc = { ...emptySheet(), rows: 20 };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    // 0→10→20→30→40→(50 을 49 로 클램프) — 5회.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(grid, { key: "PageDown" });
    expect(cellRefLabel(container)).toBe("A50");

    // 이미 경계 — 한 번 더 눌러도 그대로.
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(cellRefLabel(container)).toBe("A50");
  });

  it("채우기 핸들 더블클릭은 인접 열 길이만큼 아래로 채운다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "1" };
    doc.cells.A2 = { raw: "2" };
    doc.cells.A3 = { raw: "3" };
    doc.cells.B1 = { raw: "x" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    // B1 을 활성 셀로 만든 뒤(범위 = B1 한 칸) 그 채우기 핸들을 더블클릭.
    const cells = Array.from(container.querySelectorAll(".sheet-cell"));
    const b1 = cells.find((el) => el.textContent === "x")!;
    fireEvent.mouseDown(b1);

    const handle = b1.querySelector(".sheet-fill-handle") as HTMLElement;
    fireEvent.doubleClick(handle);

    const filled = cells.filter((el) => el.textContent === "x");
    expect(filled.length).toBe(3); // B1·B2·B3 — A열의 연속 데이터(1~3행) 길이만큼.
  });
});

/** 편집 오버레이 — CellEditor 는 <textarea>(Alt+Enter 셀 내 줄바꿈, W2). */
function overlayOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea.sheet-cell-input-overlay") as HTMLTextAreaElement;
}

describe("SheetGrid 편집 근육 기억(W2)", () => {
  it("수식 편집 중 다른 셀을 클릭하면 캐럿 위치에 참조가 삽입된다", () => {
    const doc = emptySheet();
    doc.cells.B2 = { raw: "9" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    // 기본 활성 셀 A1(.active-cell) 을 더블클릭해 편집 시작.
    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    fireEvent.doubleClick(a1);
    const overlay = overlayOf(container);
    fireEvent.change(overlay, { target: { value: "=" } });
    overlay.setSelectionRange(1, 1); // '=' 바로 뒤 — 삽입 가능 문맥.

    const b2 = Array.from(container.querySelectorAll(".sheet-cell")).find((el) => el.textContent === "9") as HTMLElement;
    fireEvent.mouseDown(b2);

    expect(overlayOf(container).value).toBe("=B2");
  });

  it("F4는 캐럿이 걸친 참조의 $ 를 순환시킨다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    fireEvent.doubleClick(a1);
    const overlay = overlayOf(container);
    fireEvent.change(overlay, { target: { value: "=A1" } });
    overlay.setSelectionRange(3, 3); // 참조 A1 끝.

    fireEvent.keyDown(overlay, { key: "F4" });
    expect(overlayOf(container).value).toBe("=$A$1");
  });

  it("편집 중 Ctrl+Shift+;는 캐럿에 지금 시각을 삽입한다(표준 배열의 e.key=':' 실제 이벤트)", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    fireEvent.doubleClick(a1);
    const overlay = overlayOf(container);
    fireEvent.change(overlay, { target: { value: "" } });
    overlay.setSelectionRange(0, 0);

    fireEvent.keyDown(overlay, { key: ":", ctrlKey: true, shiftKey: true });

    expect(/^\d{2}:\d{2}$/.test(overlayOf(container).value)).toBe(true);
  });

  it("Ctrl+D는 선택 범위 첫 행을 나머지 행에 한 번에 채운다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "값" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "d", ctrlKey: true });

    const filled = Array.from(container.querySelectorAll(".sheet-cell")).filter((el) => el.textContent === "값");
    expect(filled.length).toBe(3); // A1·A2·A3
  });

  it("Ctrl+R는 선택 범위 첫 열을 나머지 열에 한 번에 채운다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "값" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(grid, { key: "r", ctrlKey: true });

    const filled = Array.from(container.querySelectorAll(".sheet-cell")).filter((el) => el.textContent === "값");
    expect(filled.length).toBe(3); // A1·B1·C1
  });

  it("Ctrl+;는 편집 중이 아니면 활성 셀에 오늘 날짜를 채운다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const grid = gridOf(container);
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

    fireEvent.keyDown(grid, { key: ";", ctrlKey: true });

    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    expect(a1.textContent).toBe(today);
  });

  it("Ctrl+Shift+;는 편집 중이 아니면 활성 셀에 지금 시각을 채운다(표준 배열의 e.key=':' 실제 이벤트)", () => {
    // 리뷰 발견(PLAN-2026-09-21 W2): 표준 US 배열에서 Shift 를 누르면 세미콜론 키의 e.key 가
    // ";" 가 아니라 ":" 로 바뀐다 — 실제 브라우저 이벤트를 흉내내려면 key:":" 로 쏴야 한다.
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const grid = gridOf(container);

    fireEvent.keyDown(grid, { key: ":", ctrlKey: true, shiftKey: true });

    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    expect(/^\d{2}:\d{2}$/.test(a1.textContent ?? "")).toBe(true);
  });

  it("Alt+Enter는 커밋하지 않고 편집칸에 줄바꿈을 넣는다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const a1 = container.querySelector(".sheet-cell.active-cell") as HTMLElement;
    fireEvent.doubleClick(a1);
    const overlay = overlayOf(container);
    fireEvent.change(overlay, { target: { value: "가나" } });
    overlay.setSelectionRange(2, 2);

    fireEvent.keyDown(overlay, { key: "Enter", altKey: true });

    expect(overlayOf(container).value).toBe("가나\n");
    expect(cellRefLabel(container)).toBe("A1"); // 아직 A1 편집 중 — 커밋 안 됨(다음 칸으로 안 감).
  });

  it("자동완성 제안은 Tab으로 수락하고 그 칸에 남아 있는다(커밋 아님)", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "사과주스" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    // A2 를 편집(빈 칸) — 활성 셀을 옮긴 뒤 더블클릭 대신 F2 로 진입. 접두 2자 이상 조건(계획 §2 W2).
    const grid = gridOf(container);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "F2" });
    const overlay = overlayOf(container);
    fireEvent.change(overlay, { target: { value: "사과" } });

    expect(container.querySelector(".sheet-cell-suggest-rest")?.textContent).toBe("주스");

    fireEvent.keyDown(overlay, { key: "Tab" });

    expect(overlayOf(container).value).toBe("사과주스");
    expect(cellRefLabel(container)).toBe("A2"); // 여전히 A2 — Tab이 다음 칸으로 넘기지 않았다.
  });

  it("우클릭 행 메뉴의 첫 행 고정은 토글되고 고정 레이어가 나타난다/사라진다", () => {
    const { container } = render(<SheetSection section={sectionOf(emptySheet())} />);
    const rowHeader = container.querySelector(".sheet-row-header-cell") as HTMLElement;

    fireEvent.contextMenu(rowHeader);
    fireEvent.click(screen.getByText(t("editor.sheet_freeze_row")));
    expect(container.querySelector(".sheet-frozen-rows")).not.toBeNull();

    fireEvent.contextMenu(rowHeader);
    fireEvent.click(screen.getByText(t("editor.sheet_unfreeze_row")));
    expect(container.querySelector(".sheet-frozen-rows")).toBeNull();
  });

  it("B2 에 3줄 값이면 2행 높이가 rowHeightOf(3) 이고 3행 머리글 top 이 그만큼 밀린다", () => {
    const doc = emptySheet();
    doc.cells.B2 = { raw: "첫 줄\n둘째 줄\n셋째 줄" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    const rowHeaders = container.querySelectorAll(".sheet-row-header-cell");
    // 1행(A1) — B2 는 2행이라 아직 기본 높이 그대로.
    expect((rowHeaders[0] as HTMLElement).style.height).toBe(`${DEFAULT_ROW_HEIGHT}px`);
    // 2행(B2 가 속한 행) — 3줄 값이라 rowHeightOf(3) 으로 늘어난다.
    expect((rowHeaders[1] as HTMLElement).style.height).toBe(`${rowHeightOf(3)}px`);
    // 3행 머리글 top 은 1·2행 높이 합만큼 밀린다.
    expect((rowHeaders[2] as HTMLElement).style.top).toBe(`${DEFAULT_ROW_HEIGHT + rowHeightOf(3)}px`);
  });

  it("다중 줄 셀에만 data-multiline 이 붙는다", () => {
    const doc = emptySheet();
    doc.cells.A1 = { raw: "한 줄" };
    doc.cells.B1 = { raw: "첫 줄\n둘째 줄" };
    const { container } = render(<SheetSection section={sectionOf(doc)} />);

    const cells = Array.from(container.querySelectorAll(".sheet-cell"));
    const a1 = cells.find((c) => c.textContent === "한 줄") as HTMLElement;
    const b1 = cells.find((c) => c.textContent?.startsWith("첫 줄")) as HTMLElement;

    expect(a1.hasAttribute("data-multiline")).toBe(false);
    expect(b1.hasAttribute("data-multiline")).toBe(true);
  });
});
