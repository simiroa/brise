import { describe, expect, it, vi, afterEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSheetState } from "./useSheetState";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";
import { registerSheetTarget } from "../../lib/aiSectionBridge";
import { emitNotice } from "../../lib/invoke";
import { useSheetFocus } from "../../stores/sheetFocus";
import type { Section } from "../../lib/commands.gen";

// Mock Tauri invoke and store calls
vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  registerSheetTarget: vi.fn(() => () => {}),
}));

// 내용잠금 테스트가 켜고 끌 수 있게 activeNote를 모듈 스코프 변수로 둔다(다른 test 파일들의
// notesActiveNoteId 패턴과 동일). 기본은 null — 기존 테스트 전부가 이 값을 안 건드리므로 그대로다.
let mockActiveNote: { note: { content_locked: boolean } } | null = null;
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      updateSectionBody: vi.fn(),
      activeNote: mockActiveNote,
    }),
    setState: vi.fn(),
  },
}));

// 두 describe(기존 기능 + 아래 내용잠금 확장)가 같이 쓴다.
const dummySection: Section = {
  id: "sec-1",
  name: "Sheet",
  kind: "sheet",
  body_md: serializeSheet(emptySheet()),
  position: 0,
};

describe("useSheetState", () => {

  it("initializes with empty doc and active cell A1", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    expect(result.current.selection.activeCell).toBe("A1");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("updates cell value and engine evaluates it", () => {
    const { result } = renderHook(() => useSheetState(dummySection));

    act(() => {
      result.current.setCell("A1", "10");
      result.current.setCell("A2", "20");
      result.current.setCell("A3", "=SUM(A1:A2)");
    });

    expect(result.current.engine.getValue("A3")).toBe(30);
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });

    // After 1 undo (undoing A3), A3 should be null
    expect(result.current.engine.getValue("A3")).toBe(null);
  });

  // spec(specs/features/sheet.md 상호작용): "AI 편집도 한 번에 undo".
  it("AI 시트 수정하기(replaceSection)가 undo 한 단계로 들어간다 — 셀·행열·차트 전부 복구", async () => {
    const original: SheetDoc = {
      ...emptySheet(),
      cells: {
        A1: { raw: "항목" },
        B1: { raw: "금액" },
        B2: { raw: "1000", fmt: "currency" },
      },
      charts: [{ id: "c1", type: "bar", title: "지출", x: "A2:A3", series: ["B2:B3"] }],
    };
    const section: Section = { ...dummySection, body_md: serializeSheet(original) };
    const { result } = renderHook(() => useSheetState(section));

    const registerCalls = (registerSheetTarget as unknown as Mock).mock.calls;
    const target = registerCalls[registerCalls.length - 1][0]() as {
      replaceSection: (body: string) => Promise<void>;
    };

    const aiDoc: SheetDoc = {
      ...original,
      rows: original.rows + 50,
      cells: {
        A1: { raw: "항목" },
        B1: { raw: "금액" },
        B2: { raw: "2000" },
        B3: { raw: "=SUM(B2:B2)" },
      },
      charts: [{ id: "c2", type: "line", series: ["B2:B3"] }],
    };

    await act(async () => {
      await target.replaceSection(serializeSheet(aiDoc));
    });
    expect(result.current.doc.cells.B2.raw).toBe("2000");
    expect(result.current.engine.getValue("B3")).toBe(2000);
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cells).toEqual(original.cells);
    expect(result.current.doc.rows).toBe(original.rows);
    expect(result.current.doc.cols).toEqual(original.cols);
    expect(result.current.doc.charts).toEqual(original.charts);
    expect(result.current.engine.getValue("B2")).toBe(1000);

    act(() => {
      result.current.redo();
    });
    expect(result.current.doc.cells).toEqual(aiDoc.cells);
    expect(result.current.doc.rows).toBe(aiDoc.rows);
    expect(result.current.doc.charts).toEqual(aiDoc.charts);
  });

  it("handles row and column insertions", () => {
    const { result } = renderHook(() => useSheetState(dummySection));

    act(() => {
      result.current.setCell("A1", "Top");
      result.current.insertRow(0, false); // Insert above row 0
    });

    expect(result.current.engine.getValue("A2")).toBe("Top");
  });

  // 범위 지우기·채우기는 셀 수만큼이 아니라 **한 번**만 되돌아간다 — Delete 키(SheetGrid)와
  // 툴바 "선택 영역 지우기"가 같은 clearRange 를 쓰기 때문에 두 경로 모두 이 성질을 갖는다.
  it("clearRange wipes a range in ONE undo step", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("A1", "1");
      result.current.setCell("A2", "2");
      result.current.setCell("B1", "3");
    });
    act(() => {
      result.current.clearRange({ r1: 0, c1: 0, r2: 1, c2: 1 });
    });
    expect(result.current.doc.cells.A1?.raw ?? "").toBe("");
    expect(result.current.doc.cells.A2?.raw ?? "").toBe("");
    expect(result.current.doc.cells.B1?.raw ?? "").toBe("");

    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cells.A1?.raw).toBe("1");
    expect(result.current.doc.cells.A2?.raw).toBe("2");
    expect(result.current.doc.cells.B1?.raw).toBe("3");
  });

  it("clearRange on an already-empty range does not push an undo step", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("A1", "keep");
    });
    act(() => {
      result.current.clearRange({ r1: 5, c1: 5, r2: 7, c2: 7 });
    });
    act(() => {
      result.current.undo();
    });
    // 빈 범위를 지운 것이 스택에 올라갔다면 이 undo 는 아무 일도 안 하고 A1 이 남았을 것이다.
    expect(result.current.doc.cells.A1?.raw ?? "").toBe("");
  });

  // 라이브 QA 2026-08-19 재현: 셀 편집 → 열 서식 → 차트 추가 뒤 Ctrl+Z 한 번에 차트가 사라지고
  // 열 서식이 풀렸다. 스텝이 자기가 바꾸지 않은 것까지 스냅샷으로 들고 있었기 때문.
  it("셀 undo 한 번은 그 뒤에 바뀐 열 서식·차트를 건드리지 않는다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("F1", "10");
      result.current.setCell("F2", "20");
      result.current.setCell("F4", "=SUM(F1:F2)");
    });
    act(() => {
      result.current.setColFormat(5, "currency", 2, "KRW");
    });
    act(() => {
      result.current.saveChart({ id: "c1", type: "bar", series: ["F1:F2"] });
    });

    act(() => {
      result.current.undo(); // 차트 추가만 되돌린다
    });
    expect(result.current.doc.charts).toEqual([]);
    expect(result.current.doc.cols[5]).toMatchObject({ fmt: "currency", dp: 2 });
    expect(result.current.doc.cells.F4?.raw).toBe("=SUM(F1:F2)");

    act(() => {
      result.current.redo();
    });
    expect(result.current.doc.charts).toHaveLength(1);

    // 이제 셀 스텝까지 되감는다 — 차트와 열 서식은 그대로 남아야 한다.
    act(() => {
      result.current.undo(); // 차트
      result.current.undo(); // 열 서식
      result.current.undo(); // F4 수식
    });
    expect(result.current.doc.cells.F4?.raw ?? "").toBe("");
    expect(result.current.doc.cells.F2?.raw).toBe("20");
  });

  it("셀 편집이 마지막일 때, 그 undo 는 셀만 되돌린다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.saveChart({ id: "c9", type: "pie", series: ["A1:A2"] });
      result.current.setColFormat(0, "percent", 1);
      result.current.setCell("A1", "5");
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cells.A1?.raw ?? "").toBe("");
    expect(result.current.doc.charts).toHaveLength(1);
    expect(result.current.doc.cols[0]).toMatchObject({ fmt: "percent", dp: 1 });
  });

  it("열 서식 undo 는 이전 서식만 되돌리고 셀은 그대로 둔다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("B2", "1000");
      result.current.setColFormat(1, "number", 0);
    });
    act(() => {
      result.current.setColFormat(1, "currency", 2, "KRW");
    });
    expect(result.current.doc.cols[1]).toMatchObject({ fmt: "currency", dp: 2 });

    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cols[1]).toMatchObject({ fmt: "number", dp: 0 });
    expect(result.current.doc.cells.B2?.raw).toBe("1000");

    act(() => {
      result.current.redo();
    });
    expect(result.current.doc.cols[1]).toMatchObject({ fmt: "currency", dp: 2 });
  });

  it("열 폭 변경도 undo 단계 하나다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setColWidth(2, 180);
    });
    expect(result.current.doc.cols[2].w).toBe(180);
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cols[2].w).toBeUndefined();
  });

  it("차트 추가/삭제가 undo·redo 된다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    const spec = { id: "c1", type: "bar" as const, title: "지출", x: "A1:A3", series: ["B1:B3"] };
    act(() => {
      result.current.saveChart(spec);
    });
    expect(result.current.doc.charts).toEqual([spec]);

    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.charts).toEqual([]);

    act(() => {
      result.current.redo();
    });
    expect(result.current.doc.charts).toEqual([spec]);

    act(() => {
      result.current.deleteChart("c1");
    });
    expect(result.current.doc.charts).toEqual([]);
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.charts).toEqual([spec]);
  });

  it("applyFillHandle fills a column in ONE undo step", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("A1", "1");
      result.current.setCell("A2", "2");
    });
    act(() => {
      result.current.applyFillHandle({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 });
    });
    expect(result.current.doc.cells.A5?.raw).toBe("5");
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cells.A3?.raw ?? "").toBe("");
    expect(result.current.doc.cells.A2?.raw).toBe("2");
  });

  // Ctrl+R(PLAN-2026-09-21 W2)이 이 수평 분기를 부른다 — 채우기 핸들 드래그와 대칭 규칙.
  it("applyFillHandle은 오른쪽으로도 한 번에 채운다(Ctrl+R 경로)", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("A1", "값");
    });
    act(() => {
      result.current.applyFillHandle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 0, c2: 2 });
    });
    expect(result.current.doc.cells.B1?.raw).toBe("값");
    expect(result.current.doc.cells.C1?.raw).toBe("값");
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.cells.B1?.raw ?? "").toBe("");
  });

  it("setFrozenRows는 첫 행 고정을 켜고 끈다", () => {
    const { result } = renderHook(() => useSheetState(dummySection));
    expect(result.current.doc.frozenRows).toBeUndefined();
    act(() => {
      result.current.setFrozenRows(1);
    });
    expect(result.current.doc.frozenRows).toBe(1);
    act(() => {
      result.current.setFrozenRows(0);
    });
    expect(result.current.doc.frozenRows).toBeUndefined();
  });
});

// F-N09 갭 메우기: content_locked인 노트는 시트 쓰기 경로 전부(셀 편집 + AI 시트 수정하기)가
// 막혀야 한다. 복사는 예외지만 SheetGrid.tsx::onCopy는 클립보드 API만 부르고 이 훅을 거치지
// 않으므로(파일 헤더 조사 내용) 여기서 다시 검증할 게 없다.
describe("useSheetState — 내용잠금 (F-N09 확장)", () => {
  afterEach(() => {
    mockActiveNote = null;
  });

  it("잠긴 노트에서는 setCell이 셀을 바꾸지 않는다", () => {
    mockActiveNote = { note: { content_locked: true } };
    const { result } = renderHook(() => useSheetState(dummySection));
    act(() => {
      result.current.setCell("A1", "10");
    });
    expect(result.current.doc.cells.A1).toBeUndefined();
    expect(result.current.canUndo).toBe(false);
  });

  it("잠긴 노트에서는 insertRow/deleteCol 같은 구조 편집도 막힌다", () => {
    mockActiveNote = { note: { content_locked: true } };
    const { result } = renderHook(() => useSheetState(dummySection));
    const rowsBefore = result.current.doc.rows;
    const colsBefore = result.current.doc.cols.length;
    act(() => {
      result.current.insertRow(0, false);
      result.current.deleteCol(0);
    });
    expect(result.current.doc.rows).toBe(rowsBefore);
    expect(result.current.doc.cols.length).toBe(colsBefore);
  });

  it("잠긴 노트에서는 AI 시트 수정하기(replaceSection)가 문서를 바꾸지 않고 잠금 안내를 띄운다", async () => {
    mockActiveNote = { note: { content_locked: true } };
    const { result } = renderHook(() => useSheetState(dummySection));
    const registerCalls = (registerSheetTarget as unknown as Mock).mock.calls;
    const target = registerCalls[registerCalls.length - 1][0]() as {
      replaceSection: (body: string) => Promise<void>;
    };
    await act(async () => {
      await target.replaceSection(serializeSheet({ ...emptySheet(), cells: { A1: { raw: "x" } } }));
    });
    expect(result.current.doc.cells.A1).toBeUndefined();
    expect(emitNotice).toHaveBeenCalledWith("Content is locked — editing disabled");
  });
});

// PLAN-2026-09-20 §2.4 — 활성 시트가 선택·문서를 stores/sheetFocus 에 게시한다(100ms 트레일링), 언마운트에 null.
describe("useSheetState — sheetFocus 게시", () => {
  it("선택 변경 100ms 뒤 range·doc·addChart 를 게시하고 언마운트 시 sheetFocus === null", () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useSheetState(dummySection));
      act(() => { vi.advanceTimersByTime(100); });
      expect(useSheetFocus.getState().focus?.sectionId).toBe("sec-1");
      expect(useSheetFocus.getState().focus?.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });

      act(() => { result.current.setSelection("B2", { r1: 1, c1: 1, r2: 3, c2: 2 }); });
      expect(useSheetFocus.getState().focus?.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
      act(() => { vi.advanceTimersByTime(100); });
      expect(useSheetFocus.getState().focus?.range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 });

      // 게시된 addChart 는 훅의 saveChart 다 — 부르면 doc.charts 에 들어가고 undo 한 단계.
      act(() => { useSheetFocus.getState().focus!.addChart({ id: "c1", type: "bar", series: ["B2:B4"] }); });
      expect(result.current.doc.charts.map((c) => c.id)).toEqual(["c1"]);
      expect(result.current.canUndo).toBe(true);
      act(() => { vi.advanceTimersByTime(100); });
      expect(useSheetFocus.getState().focus?.doc.charts).toHaveLength(1);

      unmount();
      expect(useSheetFocus.getState().focus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
