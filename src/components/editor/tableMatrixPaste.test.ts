import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TableMatrixPaste } from "./tableMatrixPaste";
import { extractTableAiSnapshot } from "./tableAiPlan";

describe("TableMatrixPaste", () => {
  it("routes TSV clipboard data through the editor paste event", () => {
    const editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, TableMatrixPaste],
      content: "<table><tbody><tr><td>A</td></tr></tbody></table>",
    });
    let cellPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!cellPos && node.type.name === "tableCell") cellPos = pos;
    });
    editor.commands.setTextSelection(cellPos + 2);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "1\t2\n3\t4" } });

    expect(editor.view.dom.dispatchEvent(event)).toBe(false);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([["1", "2"], ["3", "4"]]);
    editor.destroy();
  });
});
