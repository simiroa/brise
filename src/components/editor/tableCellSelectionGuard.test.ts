import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CellSelection } from "@tiptap/pm/tables";
import { TableCellSelectionGuard } from "./tableCellSelectionGuard";

function makeEditor() {
  return new Editor({
    extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, TableCellSelectionGuard],
    content: "<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>",
  });
}

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell") positions.push(pos);
  });
  return positions;
}

function typeText(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  const handled = editor.view.someProp("handleTextInput", (handler) =>
    handler(editor.view, from, to, text, () => editor.state.tr.insertText(text)),
  );
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(text));
  return !!handled;
}

describe("table multi-cell selection", () => {
  it("uses the native CellSelection and marks every selected cell", () => {
    const editor = makeEditor();
    const cells = cellPositions(editor);

    expect(editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[3] })).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(editor.view.dom.querySelectorAll(".selectedCell")).toHaveLength(4);
    editor.destroy();
  });

  it("ignores direct typing across selected cells but still types normally in one cell", () => {
    const editor = makeEditor();
    const cells = cellPositions(editor);
    editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[3] });
    const before = editor.state.doc.textContent;

    expect(typeText(editor, "X")).toBe(true);
    expect(editor.state.doc.textContent).toBe(before);

    editor.commands.setTextSelection(cells[0] + 1);
    expect(typeText(editor, "X")).toBe(false);
    expect(editor.state.doc.textContent).toContain("XA1");
    editor.destroy();
  });
});
