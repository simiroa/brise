import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

/** Keep multi-cell selection non-destructive; bulk edits must use an explicit command. */
export const TableCellSelectionGuard = Extension.create({
  name: "tableCellSelectionGuard",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: (view) => view.state.selection instanceof CellSelection,
        },
      }),
    ];
  },
});
