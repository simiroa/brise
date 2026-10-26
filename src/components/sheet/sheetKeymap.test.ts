// sheetKeymap 의 분기 배선만 본다 — 선택 수학의 리터럴 기대값은 lib/sheet/navigation.test.ts 가
// 덮고, 실제 그리드에서의 왕복은 SheetGrid.test.tsx 가 덮는다. 여기는 "이 키가 이 콜백을
// 이 값으로 부르는가"뿐(특히 Shift/Ctrl 화살표가 일반 화살표보다 먼저 잡히는 우선순위).
import { describe, expect, it, vi } from "vitest";
import { handleSheetKeyDown, type SheetKeyEvent, type SheetKeymapCtx } from "./sheetKeymap";
import { emptySheet, type SheetDoc } from "../../lib/sheet/types";

function ctxOf(over: Partial<SheetKeymapCtx> = {}) {
  const doc: SheetDoc = over.doc ?? emptySheet();
  const spies = {
    onSetSelection: vi.fn(),
    onStartEditing: vi.fn(),
    onSetCell: vi.fn(),
    onClearRange: vi.fn(),
    onApplyFillHandle: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };
  const ctx: SheetKeymapCtx = {
    doc,
    selection: { activeCell: "A1", range: null },
    activeRef: { row: 0, col: 0 },
    numRows: 50,
    numCols: 26,
    rowOffsets: [],
    pageHeight: null,
    getSelectedTsv: () => "",
    ...spies,
    ...over,
  };
  return { ctx, spies };
}

function keyEvent(over: Partial<SheetKeyEvent> & { key: string }): SheetKeyEvent {
  return {
    code: "",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...over,
  };
}

describe("handleSheetKeyDown", () => {
  it("Shift+화살표는 활성 셀을 고정하고 범위만 넓힌다(일반 화살표보다 먼저 잡힌다)", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: "ArrowDown", shiftKey: true }), ctx);
    expect(spies.onSetSelection).toHaveBeenCalledWith("A1", { r1: 0, c1: 0, r2: 1, c2: 0 });
  });

  it("Ctrl+Shift+화살표는 반대 모서리를 데이터 끝까지 점프시킨다", () => {
    const doc = { ...emptySheet(), cells: { A1: { raw: "1" }, A2: { raw: "2" }, A3: { raw: "3" } } };
    const { ctx, spies } = ctxOf({ doc });
    handleSheetKeyDown(keyEvent({ key: "ArrowDown", ctrlKey: true, shiftKey: true }), ctx);
    expect(spies.onSetSelection).toHaveBeenCalledWith("A1", { r1: 0, c1: 0, r2: 2, c2: 0 });
  });

  it("Ctrl+화살표는 활성 셀 자체가 점프하고 선택은 한 칸으로 접힌다", () => {
    const doc = { ...emptySheet(), cells: { A1: { raw: "1" }, B1: { raw: "2" }, C1: { raw: "3" } } };
    const { ctx, spies } = ctxOf({ doc });
    handleSheetKeyDown(keyEvent({ key: "ArrowRight", ctrlKey: true }), ctx);
    expect(spies.onSetSelection).toHaveBeenCalledWith("C1");
  });

  it("그냥 화살표는 한 칸 이동(범위 인자 없음)", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: "ArrowDown" }), ctx);
    expect(spies.onSetSelection).toHaveBeenCalledWith("A2");
  });

  it("Ctrl+D는 선택 범위 첫 행을 소스로 좁혀 채우기를 부른다", () => {
    const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
    const { ctx, spies } = ctxOf({ selection: { activeCell: "A1", range } });
    handleSheetKeyDown(keyEvent({ key: "d", ctrlKey: true }), ctx);
    expect(spies.onApplyFillHandle).toHaveBeenCalledWith({ r1: 0, c1: 0, r2: 0, c2: 0 }, range);
  });

  it("Ctrl+D는 한 줄짜리 선택이면 아무 것도 채우지 않는다", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: "d", ctrlKey: true }), ctx);
    expect(spies.onApplyFillHandle).not.toHaveBeenCalled();
  });

  it("Ctrl+R는 선택 범위 첫 열을 소스로 좁혀 채우기를 부른다", () => {
    const range = { r1: 0, c1: 0, r2: 0, c2: 2 };
    const { ctx, spies } = ctxOf({ selection: { activeCell: "A1", range } });
    handleSheetKeyDown(keyEvent({ key: "r", ctrlKey: true }), ctx);
    expect(spies.onApplyFillHandle).toHaveBeenCalledWith({ r1: 0, c1: 0, r2: 0, c2: 0 }, range);
  });

  it("Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: "z", ctrlKey: true }), ctx);
    handleSheetKeyDown(keyEvent({ key: "z", ctrlKey: true, shiftKey: true }), ctx);
    handleSheetKeyDown(keyEvent({ key: "y", ctrlKey: true }), ctx);
    expect(spies.onUndo).toHaveBeenCalledTimes(1);
    expect(spies.onRedo).toHaveBeenCalledTimes(2);
  });

  it("e.code 가 Semicolon 이면 e.key 가 ':' 라도 오늘/지금을 활성 셀에 넣는다", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true }), ctx);
    const [cellArg, raw] = spies.onSetCell.mock.calls[0];
    expect(cellArg).toBe("A1");
    expect(raw).toMatch(/^\d{2}:\d{2}$/); // 지금 시각
  });

  it("일반 문자는 그 글자를 초깃값으로 편집을 연다", () => {
    const { ctx, spies } = ctxOf();
    const e = keyEvent({ key: "z" });
    handleSheetKeyDown(e, ctx);
    expect(spies.onStartEditing).toHaveBeenCalledWith("A1", "z");
    expect(e.preventDefault).toHaveBeenCalled(); // 없으면 "zz" 가 된다(원본 주석)
  });

  it("Delete 는 선택 범위를 통째로 비운다", () => {
    const range = { r1: 0, c1: 0, r2: 1, c2: 1 };
    const { ctx, spies } = ctxOf({ selection: { activeCell: "A1", range } });
    handleSheetKeyDown(keyEvent({ key: "Delete" }), ctx);
    expect(spies.onClearRange).toHaveBeenCalledWith(range);
  });

  it("PageDown 은 실측 전이면 10행 폴백으로 움직인다", () => {
    const { ctx, spies } = ctxOf();
    handleSheetKeyDown(keyEvent({ key: "PageDown" }), ctx);
    expect(spies.onSetSelection).toHaveBeenCalledWith("A11");
  });
});
