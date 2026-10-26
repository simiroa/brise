import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CellSelection } from "@tiptap/pm/tables";
import {
  TableAiPlanError,
  applyTableMatrixPaste,
  applyTableAiPlan,
  extractTableAiSnapshot,
  normalizeTableAiPlan,
  parseTableClipboardMatrix,
  previewTableAiPlan,
} from "./tableAiPlan";

function makeEditor() {
  return new Editor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: "<p>before</p><table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table><p>after</p>",
  });
}

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") positions.push(pos);
  });
  return positions;
}

function selectCell(editor: Editor, anchorIndex: number, headIndex = anchorIndex) {
  const positions = cellPositions(editor);
  editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
    editor.state.doc.resolve(positions[anchorIndex]),
    editor.state.doc.resolve(positions[headIndex]),
  )));
}

describe("table AI plan core", () => {
  it("parses spreadsheet clipboard text without inventing a trailing row", () => {
    expect(parseTableClipboardMatrix("A\tB\r\n1\t2\r\n")).toEqual([["A", "B"], ["1", "2"]]);
    expect(parseTableClipboardMatrix("plain text")).toBeNull();
  });

  it("pastes a matrix at the current cell, expands the table, and undoes once", () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    editor.commands.setTextSelection(cellPositions(editor)[3] + 2); // row 2, column 2

    expect(applyTableMatrixPaste(editor, [["x", "y", "z"], ["7", "8", "9"]])).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([
      ["A", "B", "", ""],
      ["1", "x", "y", "z"],
      ["3", "7", "8", "9"],
    ]);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("fills a multi-cell selection when one clipboard cell is pasted", () => {
    const editor = makeEditor();
    selectCell(editor, 2, 5);

    expect(applyTableMatrixPaste(editor, [["same"]])).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([
      ["A", "B"], ["same", "same"], ["same", "same"],
    ]);
    editor.destroy();
  });

  // 회귀(2026-09-24): 웹에서 붙여넣은 병합 셀 표에 캐럿이 있으면 어시스트 패널 렌더가 이 함수에서
  // 던져 에디터 패널 전체가 ErrorBoundary 로 떨어졌다. 지원 안 하는 표는 "표 없음"(null)이어야 한다.
  it("returns null (not a throw) for merged or irregular tables, and matrix paste falls through", () => {
    const editor = new Editor({
      extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
      content: '<table><tbody><tr><td colspan="2">merged</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    });
    editor.commands.setTextSelection(cellPositions(editor)[0] + 2);

    expect(() => extractTableAiSnapshot(editor)).not.toThrow();
    expect(extractTableAiSnapshot(editor)).toBeNull();
    expect(applyTableMatrixPaste(editor, [["x", "y"]])).toBe(false);
    editor.destroy();
  });

  it("extracts a serializable table and its rectangular CellSelection", () => {
    const editor = makeEditor();
    selectCell(editor, 2, 5);

    const snapshot = extractTableAiSnapshot(editor);

    expect(snapshot).toMatchObject({
      version: 1,
      rows: [["A", "B"], ["1", "2"], ["3", "4"]],
      headerRow: true,
      selection: { fromRow: 1, toRow: 2, fromCol: 0, toCol: 1 },
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    editor.destroy();
  });

  it("normalizes untrusted JSON, assigns stable IDs, and previews sequential changes", () => {
    const editor = makeEditor();
    selectCell(editor, 0, 5);
    const snapshot = extractTableAiSnapshot(editor)!;
    const plan = normalizeTableAiPlan({
      version: 1,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [
        { type: "cell-set", row: 1, col: 0, value: "10", ignored: true },
        { type: "row-insert", index: 3, values: ["sum", "6"] },
        { type: "header-set", enabled: false },
      ],
    }, snapshot);

    expect(plan.operations.map((op) => op.id)).toEqual([
      "op-001-cell-set", "op-002-row-insert", "op-003-header-set",
    ]);
    expect(previewTableAiPlan(snapshot, plan).map(({ id, before, after }) => ({ id, before, after }))).toEqual([
      { id: "op-001-cell-set", before: "1", after: "10" },
      { id: "op-002-row-insert", before: undefined, after: "sum | 6" },
      { id: "op-003-header-set", before: "머리글", after: "일반 행" },
    ]);
    editor.destroy();
  });

  it("rejects unknown, conflicting, out-of-range, and out-of-selection operations", () => {
    const editor = makeEditor();
    selectCell(editor, 2, 3); // second row only
    const snapshot = extractTableAiSnapshot(editor)!;
    const base = { version: 1, baseTableFingerprint: snapshot.tableFingerprint };

    for (const operations of [
      [{ type: "merge-cells", row: 1, col: 0 }],
      [{ type: "cell-set", row: 9, col: 0, value: "x" }],
      [{ type: "cell-set", row: 1, col: 0, value: "x" }, { type: "cell-clear", row: 1, col: 0 }],
      [{ type: "cell-set", row: 2, col: 0, value: "outside" }],
      [{ type: "row-insert", index: 3 }],
      [{ type: "column-delete", index: 2 }],
    ]) {
      expect(() => normalizeTableAiPlan({ ...base, operations }, snapshot)).toThrow(TableAiPlanError);
    }
    editor.destroy();
  });

  it("rejects structural changes unless the selection covers complete rows or columns", () => {
    const editor = makeEditor();
    selectCell(editor, 2); // one body cell, not a complete row or column
    const snapshot = extractTableAiSnapshot(editor)!;
    const base = { version: 1, baseTableFingerprint: snapshot.tableFingerprint };

    expect(() => normalizeTableAiPlan({ ...base, operations: [{ type: "row-delete", index: 1 }] }, snapshot)).toThrow(TableAiPlanError);
    expect(() => normalizeTableAiPlan({ ...base, operations: [{ type: "column-delete", index: 0 }] }, snapshot)).toThrow(TableAiPlanError);
    editor.destroy();
  });

  it("applies selected cell and structural operations in one undoable transaction", () => {
    const editor = makeEditor();
    selectCell(editor, 0, 5);
    const snapshot = extractTableAiSnapshot(editor)!;
    const before = editor.getJSON();
    const plan = normalizeTableAiPlan({
      version: 1,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [
        { type: "cell-set", row: 1, col: 1, value: "changed" },
        { type: "row-move", from: 2, to: 1 },
        { type: "column-insert", index: 2, values: ["C", "x", "y"] },
        { type: "header-set", enabled: false },
      ],
    }, snapshot);

    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([
      ["A", "B", "C"], ["3", "4", "x"], ["1", "changed", "y"],
    ]);
    expect(extractTableAiSnapshot(editor)?.headerRow).toBe(false);

    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("applies only checked operations and rejects a subset whose dependencies no longer hold", () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(cellPositions(editor)[0] + 2);
    const snapshot = extractTableAiSnapshot(editor)!;
    const plan = normalizeTableAiPlan({
      version: 1,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [
        { type: "row-insert", index: 3, values: ["5", "6"] },
        { type: "cell-set", row: 3, col: 0, value: "five" },
      ],
    }, snapshot);

    expect(() => applyTableAiPlan(editor, snapshot, plan, new Set([plan.operations[1].id]))).toThrow(TableAiPlanError);
    expect(applyTableAiPlan(editor, snapshot, plan, new Set([plan.operations[0].id]))).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows.slice(-1)[0]).toEqual(["5", "6"]);
    editor.destroy();
  });

  it("rejects approval after any document change", () => {
    const editor = makeEditor();
    selectCell(editor, 0, 5);
    const snapshot = extractTableAiSnapshot(editor)!;
    const plan = normalizeTableAiPlan({
      version: 1,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [{ type: "cell-set", row: 1, col: 0, value: "new" }],
    }, snapshot);
    editor.commands.insertContentAt(1, "changed elsewhere");

    expect(() => applyTableAiPlan(editor, snapshot, plan)).toThrow(/stale/i);
    editor.destroy();
  });
});
