import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { applyTableMatrixPaste, parseTableClipboardMatrix } from "./tableAiPlan";

export const TableMatrixPaste = Extension.create({
  name: "tableMatrixPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const matrix = parseTableClipboardMatrix(text)
            ?? (text && editor.state.selection instanceof CellSelection ? [[text]] : null);
          return matrix ? applyTableMatrixPaste(editor, matrix) : false;
        },
      },
    })];
  },
});
