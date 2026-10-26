import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { AllSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import {
  TableMenuButtons, TableBubbleMenu, TableContextMenu,
  fillSelectedTableCells, findTableAncestorPos, getTableDimensions, runTableAction,
  type TableContextMenuOpen,
} from "./TableMenu";
import { TableButton } from "./buttons";
import { t } from "../../../i18n/t";
import { TableAiModal } from "../TableAiModal";
import { useAiStore } from "../../../stores/ai";

afterEach(() => cleanup());

// Table v1 UI (item 5) — TableMenuButtons wraps the free ProseMirror-tables commands only (no
// merge/split, no resize — owner decision). Rendered standalone here (not inside
// TableBubbleMenu's BubbleMenu/portal) — same "extract the pure/testable piece" approach as
// buttons.test.tsx's ColorButton/LinkButton, just one layer further: this is a smoke test of the
// seven commands, not the floating-menu positioning.
function makeTableEditor() {
  return new TiptapEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content:
      "<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>",
  });
}

/** Places a collapsed selection inside the first text node matching `text` — puts the cursor
 *  "inside a table cell" the way a real user's caret would be, which is what
 *  addRowBefore/addRowAfter/deleteRow/etc. need to resolve table context from. */
function placeCursorIn(editor: TiptapEditor, text: string) {
  let pos: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (pos === null && node.isText && node.text === text) pos = position;
  });
  if (pos === null) throw new Error(`text "${text}" not found in doc`);
  editor.commands.setTextSelection(pos + 1);
}

function countNodesOfType(editor: TiptapEditor, typeName: string): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) n++;
  });
  return n;
}

describe("findTableAncestorPos — TableBubbleMenu's anchor lookup", () => {
  it("finds the table's start position from a caret inside a cell", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    const pos = findTableAncestorPos(editor.state.selection.$from);
    expect(pos).not.toBeNull();
    expect(editor.state.doc.nodeAt(pos!)?.type.name).toBe("table");
    editor.destroy();
  });

  it("returns null outside any table", () => {
    const editor = new TiptapEditor({ extensions: [StarterKit], content: "<p>no table here</p>" });
    editor.commands.setTextSelection(2);
    expect(findTableAncestorPos(editor.state.selection.$from)).toBeNull();
    editor.destroy();
  });

  it("returns null (not a throw) under an AllSelection (Ctrl+A) — depth-0 $from", () => {
    const editor = makeTableEditor();
    const tr = editor.state.tr.setSelection(new AllSelection(editor.state.doc));
    editor.view.dispatch(tr);
    expect(() => findTableAncestorPos(editor.state.selection.$from)).not.toThrow();
    expect(findTableAncestorPos(editor.state.selection.$from)).toBeNull();
    editor.destroy();
  });
});

describe("TableMenuButtons — table v1 commands (free ProseMirror-tables commands only)", () => {
  it("addRowBefore / addRowAfter / deleteRow change row count", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    expect(countNodesOfType(editor, "tableRow")).toBe(2);

    runTableAction(editor, "row-before");
    expect(countNodesOfType(editor, "tableRow")).toBe(3);

    runTableAction(editor, "row-after");
    expect(countNodesOfType(editor, "tableRow")).toBe(4);

    runTableAction(editor, "row-delete");
    expect(countNodesOfType(editor, "tableRow")).toBe(3);

    editor.destroy();
  });

  it("addColumnBefore / addColumnAfter / deleteColumn change column count", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    const colsBefore = () => editor.state.doc.firstChild!.firstChild!.childCount;
    expect(colsBefore()).toBe(2);

    runTableAction(editor, "column-before");
    expect(colsBefore()).toBe(3);

    runTableAction(editor, "column-after");
    expect(colsBefore()).toBe(4);

    runTableAction(editor, "column-delete");
    expect(colsBefore()).toBe(3);

    editor.destroy();
  });

  it("toggleHeaderRow flips the first row's cells between tableCell and tableHeader", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    expect(countNodesOfType(editor, "tableHeader")).toBe(0);

    runTableAction(editor, "header-toggle");
    expect(countNodesOfType(editor, "tableHeader")).toBe(2); // both cells in the first row

    runTableAction(editor, "header-toggle");
    expect(countNodesOfType(editor, "tableHeader")).toBe(0);

    editor.destroy();
  });

  it("the danger delete button removes the whole table", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    expect(countNodesOfType(editor, "table")).toBe(1);

    runTableAction(editor, "table-delete");
    expect(countNodesOfType(editor, "table")).toBe(0);

    editor.destroy();
  });

  it("duplicates the current row and clears the current cell", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    expect(runTableAction(editor, "row-duplicate")).toBe(true);
    expect(countNodesOfType(editor, "tableRow")).toBe(3);
    expect(editor.state.doc.textContent.match(/A1/g)).toHaveLength(2);

    expect(runTableAction(editor, "cell-clear")).toBe(true);
    expect(editor.state.doc.textContent.match(/A1/g)).toHaveLength(1);
    editor.destroy();
  });

  it("clears every cell in a CellSelection", () => {
    const editor = makeTableEditor();
    const cellPositions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cellPositions.push(pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      editor.state.doc.resolve(cellPositions[0]),
      editor.state.doc.resolve(cellPositions[3]),
    )));

    expect(runTableAction(editor, "cell-clear")).toBe(true);
    expect(editor.state.doc.textContent).toBe("");
    editor.destroy();
  });

  it("shows direct add/remove actions and omits non-editable dimensions", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    expect(getTableDimensions(editor)).toEqual({ rows: 2, cols: 2 });
    render(<TableMenuButtons editor={editor} />);
    expect(screen.getByTitle(t("editor.table_row_add_after"))).toBeTruthy();
    expect(screen.getByTitle(t("editor.table_row_delete"))).toBeTruthy();
    expect(screen.getByTitle(t("editor.table_col_add_after"))).toBeTruthy();
    expect(screen.getByTitle(t("editor.table_col_delete"))).toBeTruthy();
    expect(screen.queryByTestId("table-dimensions")).toBeNull();
    editor.destroy();
  });

  it("disables row/column removal when it would delete the final table structure", () => {
    const editor = new TiptapEditor({
      extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
      content: "<table><tbody><tr><td>only</td></tr></tbody></table>",
    });
    placeCursorIn(editor, "only");
    render(<TableMenuButtons editor={editor} />);

    expect((screen.getByTitle(t("editor.table_row_delete")) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle(t("editor.table_col_delete")) as HTMLButtonElement).disabled).toBe(true);
    editor.destroy();
  });

  it("asks before deleting a table from the floating menu", () => {
    const editor = makeTableEditor();
    const cellPos = editor.state.doc.resolve(2);
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(cellPos)));
    render(<TableMenuButtons editor={editor} />);

    fireEvent.click(screen.getByRole("button", { name: t("editor.more") }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("editor.table_delete") }));
    expect(countNodesOfType(editor, "table")).toBe(1);
    expect(screen.getByRole("dialog", { name: t("editor.table_delete_confirm_title") })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("editor.table_delete_confirm_action") }));
    expect(countNodesOfType(editor, "table")).toBe(0);
    editor.destroy();
  });

  it("fills every selected cell in one command", () => {
    const editor = makeTableEditor();
    const cellPositions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cellPositions.push(pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      editor.state.doc.resolve(cellPositions[0]),
      editor.state.doc.resolve(cellPositions[3]),
    )));

    expect(fillSelectedTableCells(editor, "같음")).toBe(true);
    expect(editor.state.doc.textContent).toBe("같음같음같음같음");
    editor.destroy();
  });
});

describe("TableButton — size picker", () => {
  it("opens instead of inserting immediately, then inserts the selected grid size", () => {
    const editor = makeTableEditor();
    editor.commands.clearContent();
    render(<TableButton editor={editor} />);

    fireEvent.click(screen.getByTitle(t("editor.table_insert")));
    expect(countNodesOfType(editor, "table")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "4 × 6" }));
    expect(getTableDimensions(editor)).toEqual({ rows: 4, cols: 6 });
    expect(countNodesOfType(editor, "tableHeader")).toBe(6);
    editor.destroy();
  });

  it("accepts 1–50 row/column inputs and can insert without a header", () => {
    const editor = makeTableEditor();
    editor.commands.clearContent();
    render(<TableButton editor={editor} />);
    fireEvent.click(screen.getByTitle(t("editor.table_insert")));
    fireEvent.change(screen.getByRole("spinbutton", { name: t("editor.table_rows") }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: t("editor.table_columns") }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: t("editor.table_first_row_header") }));
    fireEvent.click(screen.getByRole("button", { name: t("editor.table_insert_action") }));

    expect(getTableDimensions(editor)).toEqual({ rows: 2, cols: 5 });
    expect(countNodesOfType(editor, "tableHeader")).toBe(0);
    editor.destroy();
  });
});

describe("TableContextMenu — selection priority", () => {
  it("leaves a non-empty text selection to the text context menu", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    const textPos = editor.state.selection.from;
    editor.commands.setTextSelection({ from: textPos, to: textPos + 1 });
    const openRef: { current: TableContextMenuOpen | null } = { current: null };
    render(<TableContextMenu editor={editor} openRef={openRef} />);
    const preventDefault = vi.fn();
    openRef.current?.({
      target: editor.view.dom.querySelector("td")!,
      clientX: 10,
      clientY: 10,
      preventDefault,
    } as unknown as React.MouseEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: t("editor.table_actions") })).toBeNull();
    editor.destroy();
  });

  it("asks before deleting a table from the right-click menu", () => {
    const editor = makeTableEditor();
    const cellPos = editor.state.doc.resolve(2);
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(cellPos)));
    const openRef: { current: TableContextMenuOpen | null } = { current: null };
    render(<TableContextMenu editor={editor} openRef={openRef} />);
    act(() => {
      openRef.current?.({
        target: editor.view.dom.querySelector("td")!,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
    });

    fireEvent.click(screen.getByRole("menuitem", { name: t("editor.table_delete") }));
    expect(countNodesOfType(editor, "table")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: t("editor.table_delete_confirm_action") }));
    expect(countNodesOfType(editor, "table")).toBe(0);
    editor.destroy();
  });
});

describe("TableAiModal — proposal selection", () => {
  it("can select or clear every proposed change and shows the selected count", async () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    useAiStore.setState({
      refreshTranslateGate: vi.fn(async () => true),
      // 표 지문은 프롬프트에도 응답에도 없다 — 모달이 채워 넣는다.
      generateFromPrompt: vi.fn(async () => {
        return JSON.stringify({
          version: 1,
          operations: [
            { type: "cell-set", row: 0, col: 0, value: "changed" },
            { type: "cell-set", row: 1, col: 1, value: "also changed" },
          ],
        });
      }),
    } as never);
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: t("editor.table_ai_preview") }));
    await waitFor(() => expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 2, total: 2 }))).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t("editor.table_ai_select_none") }));
    expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 0, total: 2 }))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("editor.table_ai_apply", { count: 0 }) }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t("editor.table_ai_select_all") }));
    expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 2, total: 2 }))).toBeTruthy();
    editor.destroy();
  });
});

// Owner QA 6, item 1: TableBubbleMenu's own BubbleMenu instance used to default to `window` as
// its scroll target (@tiptap/extension-bubble-menu's BubbleMenuPlugin: `scrollTarget = options?.
// scrollTarget ?? window`) — since the editor scrolls inside `.scroll.editor-desktop`, not the
// window, that listener never fired and the table menu stayed frozen on screen while the table
// scrolled underneath it. This asserts the plugin now binds to the passed scrollEl instead.
describe("TableBubbleMenu — scroll tracking (owner QA 6, item 1)", () => {
  it("registers its scroll listener on the passed scrollEl, not window", () => {
    const editor = makeTableEditor();
    placeCursorIn(editor, "A1");
    const scrollEl = document.createElement("div");
    const addSpy = vi.spyOn(scrollEl, "addEventListener");

    render(<TableBubbleMenu editor={editor} scrollEl={scrollEl} />);

    expect(addSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
    editor.destroy();
  });
});
