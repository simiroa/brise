// 쓰기 op 전부가 **같은 골격**을 지난다는 것을 못박는 특성화 테스트.
// 왜 있나: 골격(잠금 확인 → undo 적재 → 문서 교체 → 엔진 동기화 → 리렌더 → 저장 예약)이 op 마다
// 손으로 복제돼 있었고, 실제로 한 곳이 한 줄을 빠뜨려 결함이 났다(커밋 b7ed6f3c —
// setFrozenRows 가 pushStep 을 빠뜨려 첫 행 고정이 되돌려지지 않았다). 골격을 관문 하나로 접는
// 리팩터 전에 현재 동작을 그대로 고정해 두고, 리팩터 뒤 같은 테스트가 통과하는지로 "동작 변경 0"
// 을 확인한다. op 별 세부 동작(무엇이 어떻게 바뀌는가)은 useSheetState.test.ts 와 lib/sheet/*.test.ts
// 가 이미 덮으므로, 여기서는 **골격만** 본다.

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, type RenderHookResult } from "@testing-library/react";
import { useSheetState } from "./useSheetState";
import { emptySheet, serializeSheet } from "../../lib/sheet/types";
import type { Section } from "../../lib/commands.gen";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  registerSheetTarget: vi.fn(() => () => {}),
}));

// updateSectionBody 는 저장이 실제로 예약됐는지 보는 유일한 창이라 **안정된** 스파이여야 한다
// (useSheetState.test.ts 의 목은 getState() 마다 새 vi.fn 을 만들어 관찰할 수 없다).
const updateSectionBody = vi.fn();
let locked = false;
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      updateSectionBody,
      activeNote: { note: { id: "note-1", content_locked: locked }, sections: [] },
    }),
    setState: vi.fn(),
  },
}));

const dummySection: Section = {
  id: "sec-1",
  name: "Sheet",
  kind: "sheet",
  body_md: serializeSheet(emptySheet()),
  position: 0,
};

type Hook = ReturnType<typeof useSheetState>;

/** 문서에서 쓰기 op 이 바꿀 수 있는 전부 — 되돌리기 왕복이 제자리로 오는지 이걸로 비교한다. */
const probe = (h: Hook) => ({
  cells: h.doc.cells,
  rows: h.doc.rows,
  cols: h.doc.cols,
  charts: h.doc.charts,
  frozenRows: h.doc.frozenRows,
});

interface OpCase {
  name: string;
  /** 대상이 있어야 하는 op(정렬·삭제·채우기)을 위한 사전 편집. 잠금 테스트에서는 잠그기 **전**에 돈다. */
  setup?: (h: Hook) => void;
  run: (h: Hook) => void;
}

const CASES: OpCase[] = [
  { name: "setCells", run: (h) => h.setCells({ A1: { raw: "1" }, B2: { raw: "2" } }) },
  { name: "setCell", run: (h) => h.setCell("A1", "10") },
  {
    name: "clearRange",
    setup: (h) => { h.setCell("A1", "1"); h.setCell("B1", "2"); },
    run: (h) => h.clearRange({ r1: 0, c1: 0, r2: 0, c2: 1 }),
  },
  { name: "setColWidth", run: (h) => h.setColWidth(2, 180) },
  { name: "setColFormat", run: (h) => h.setColFormat(1, "currency", 2, "KRW") },
  { name: "saveChart", run: (h) => h.saveChart({ id: "c1", type: "bar", series: ["A1:A3"] }) },
  {
    name: "deleteChart",
    setup: (h) => h.saveChart({ id: "c1", type: "bar", series: ["A1:A3"] }),
    run: (h) => h.deleteChart("c1"),
  },
  { name: "insertRow", setup: (h) => h.setCell("A1", "머리"), run: (h) => h.insertRow(0, false) },
  {
    name: "deleteRow",
    setup: (h) => { h.setCell("A1", "1"); h.setCell("A2", "2"); },
    run: (h) => h.deleteRow(0),
  },
  {
    name: "deleteRows",
    setup: (h) => { h.setCell("A1", "1"); h.setCell("A2", "2"); h.setCell("A3", "3"); },
    run: (h) => h.deleteRows([0, 2]),
  },
  { name: "insertCol", setup: (h) => h.setCell("A1", "1"), run: (h) => h.insertCol(0, false) },
  { name: "deleteCol", setup: (h) => h.setCell("A1", "1"), run: (h) => h.deleteCol(0) },
  {
    name: "sortRange",
    setup: (h) => { h.setCell("A1", "머리"); h.setCell("A2", "3"); h.setCell("A3", "1"); },
    run: (h) => h.sortRange(0, false),
  },
  { name: "setFrozenRows", run: (h) => h.setFrozenRows(1) },
  {
    name: "applyFillHandle",
    setup: (h) => { h.setCell("A1", "1"); h.setCell("A2", "2"); },
    run: (h) => h.applyFillHandle({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 }),
  },
];

function render(): RenderHookResult<Hook, unknown> {
  return renderHook(() => useSheetState(dummySection));
}

beforeEach(() => {
  locked = false;
  updateSectionBody.mockClear();
});

afterEach(() => {
  locked = false;
});

describe("useSheetState 쓰기 관문 — 되돌리기 1스텝", () => {
  for (const c of CASES) {
    it(`${c.name}: 호출 1번 = undo 1스텝, undo 로 복원되고 redo 로 재적용된다`, () => {
      const { result } = render();
      if (c.setup) act(() => c.setup!(result.current));

      const before = probe(result.current);
      act(() => c.run(result.current));

      const after = probe(result.current);
      expect(after).not.toEqual(before);
      expect(result.current.canUndo).toBe(true);

      act(() => result.current.undo());
      expect(probe(result.current)).toEqual(before);

      act(() => result.current.redo());
      expect(probe(result.current)).toEqual(after);
    });
  }
});

describe("useSheetState 쓰기 관문 — 저장 예약", () => {
  for (const c of CASES) {
    it(`${c.name}: 700ms 디바운스 뒤 직렬화된 문서가 저장된다`, () => {
      vi.useFakeTimers();
      try {
        const { result } = render();
        if (c.setup) act(() => c.setup!(result.current));
        act(() => { vi.advanceTimersByTime(700); });
        updateSectionBody.mockClear();

        act(() => c.run(result.current));
        expect(updateSectionBody).not.toHaveBeenCalled(); // 즉시 저장이 아니라 예약이다
        act(() => { vi.advanceTimersByTime(700); });
        expect(updateSectionBody).toHaveBeenCalledWith("sec-1", serializeSheet(result.current.doc));
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe("useSheetState 쓰기 관문 — 내용잠금", () => {
  for (const c of CASES) {
    it(`${c.name}: 잠긴 노트에서는 문서가 그대로고 undo 스텝도 쌓이지 않는다`, () => {
      const { result } = render();
      if (c.setup) act(() => c.setup!(result.current)); // 사전 편집은 잠그기 전에

      const before = probe(result.current);
      const canUndoBefore = result.current.canUndo;
      locked = true;
      act(() => c.run(result.current));

      expect(probe(result.current)).toEqual(before);
      expect(result.current.canUndo).toBe(canUndoBefore);
    });
  }

  // 잠금 전에 쌓인 스택이 남아 있어도 되돌리기는 새 쓰기이므로 막힌다(useSheetState.ts 주석).
  it("undo/redo 도 잠금 가드 대상이다", () => {
    const { result } = render();
    act(() => result.current.setCell("A1", "10"));
    const before = probe(result.current);

    locked = true;
    act(() => result.current.undo());
    expect(probe(result.current)).toEqual(before);

    locked = false;
    act(() => result.current.undo());
    expect(result.current.doc.cells.A1).toBeUndefined();

    locked = true;
    act(() => result.current.redo());
    expect(result.current.doc.cells.A1).toBeUndefined();
  });
});

// 조기 반환 — 스택을 더럽히지 않는 입력들. 리팩터가 관문으로 접을 때 같이 접히면 안 되는 지점이라
// (op 마다 조건이 다르다) 목록을 그대로 못박는다.
describe("useSheetState 쓰기 관문 — no-op 입력은 스택을 더럽히지 않는다", () => {
  const NOOPS: Array<{ name: string; run: (h: Hook) => void }> = [
    { name: "setCells(빈 패치)", run: (h) => h.setCells({}) },
    { name: "clearRange(이미 빈 범위)", run: (h) => h.clearRange({ r1: 5, c1: 5, r2: 7, c2: 7 }) },
    { name: "setColWidth(없는 열)", run: (h) => h.setColWidth(999, 120) },
    { name: "setColFormat(없는 열)", run: (h) => h.setColFormat(999, "percent") },
    { name: "deleteChart(없는 id)", run: (h) => h.deleteChart("없음") },
    { name: "deleteRows(빈 목록)", run: (h) => h.deleteRows([]) },
    { name: "setFrozenRows(이미 같은 값)", run: (h) => h.setFrozenRows(0) },
    {
      name: "applyFillHandle(확장 없음)",
      run: (h) => h.applyFillHandle({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 1, c2: 0 }),
    },
  ];

  for (const c of NOOPS) {
    it(`${c.name} 은 문서도 undo 스택도 건드리지 않는다`, () => {
      const { result } = render();
      const before = probe(result.current);
      act(() => c.run(result.current));
      expect(probe(result.current)).toEqual(before);
      expect(result.current.canUndo).toBe(false);
    });
  }
});
