import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { isTextSelection, type Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { t } from "../../../i18n/t";
import { ContextMenuShell } from "../../common/ContextMenuShell";
import { createStableRectAnchor } from "../stableAnchor";
import { ToolbarDivider } from "./buttons";
import { ensureAiAskGate } from "../../../stores/ai";
import { PromptDialog } from "../../PromptDialog";
import { TableAiModal } from "../TableAiModal";

/**
 * Table v1 UI — free ProseMirror-tables commands only (addRowBefore/After, deleteRow,
 * addColumnBefore/After, deleteColumn, toggleHeaderRow, deleteTable). Deliberately NO merge/
 * split (owner decision — would silently corrupt the GFM pipe-table's markdown placement, see
 * mdSerialize.test.ts's HTML-island findings) and NO resize (Table stays `resizable: false`,
 * EditorPanel.tsx).
 *
 * Exported standalone (not just as part of TableBubbleMenu below) so tests can render it with a
 * real Editor and click a button without mounting the BubbleMenu/portal machinery — same
 * "extract the pure/testable piece" pattern EditorPanel.tsx already uses for e.g.
 * resolveGhostPreview.
 */
export type TableAction =
  | "row-before" | "row-after" | "row-duplicate" | "row-delete"
  | "column-before" | "column-after" | "column-delete"
  | "cell-clear" | "header-toggle" | "table-delete";

const TABLE_ACTION_GROUPS: Array<{ label: string; actions: Array<{ id: TableAction; label: string; danger?: boolean }> }> = [
  { label: "editor.table_row", actions: [
    { id: "row-before", label: "editor.table_row_add_before" },
    { id: "row-after", label: "editor.table_row_add_after" },
    { id: "row-duplicate", label: "editor.table_row_duplicate" },
    { id: "row-delete", label: "editor.table_row_delete", danger: true },
  ] },
  { label: "editor.table_column", actions: [
    { id: "column-before", label: "editor.table_col_add_before" },
    { id: "column-after", label: "editor.table_col_add_after" },
    { id: "column-delete", label: "editor.table_col_delete", danger: true },
  ] },
  { label: "editor.table_cell", actions: [
    { id: "cell-clear", label: "editor.table_cell_clear" },
  ] },
  { label: "editor.table", actions: [
    { id: "header-toggle", label: "editor.table_header_toggle" },
    { id: "table-delete", label: "editor.table_delete", danger: true },
  ] },
];

const MORE_TABLE_ACTIONS = [
  { id: "row-before", label: "editor.table_row_add_before" },
  { id: "row-duplicate", label: "editor.table_row_duplicate" },
  { id: "column-before", label: "editor.table_col_add_before" },
  { id: "header-toggle", label: "editor.table_header_toggle" },
  { id: "table-delete", label: "editor.table_delete", danger: true },
] satisfies Array<{ id: TableAction; label: string; danger?: boolean }>;

function findAncestorPos($from: ResolvedPos, names: string[]): number | null {
  for (let d = $from.depth; d > 0; d--) {
    if (names.includes($from.node(d).type.name)) return $from.before(d);
  }
  return null;
}

/** Small shared command surface used by the floating and right-click menus. */
export function runTableAction(editor: Editor, action: TableAction): boolean {
  if (action === "row-before") return editor.chain().focus().addRowBefore().run();
  if (action === "row-after") return editor.chain().focus().addRowAfter().run();
  if (action === "row-delete") return editor.chain().focus().deleteRow().run();
  if (action === "column-before") return editor.chain().focus().addColumnBefore().run();
  if (action === "column-after") return editor.chain().focus().addColumnAfter().run();
  if (action === "column-delete") return editor.chain().focus().deleteColumn().run();
  if (action === "header-toggle") return editor.chain().focus().toggleHeaderRow().run();
  if (action === "table-delete") return editor.chain().focus().deleteTable().run();

  editor.view.focus();
  if (action === "row-duplicate") {
    const rowPos = findAncestorPos(editor.state.selection.$from, ["tableRow"]);
    const row = rowPos == null ? null : editor.state.doc.nodeAt(rowPos);
    if (rowPos == null || !row) return false;
    editor.view.dispatch(editor.state.tr.insert(rowPos + row.nodeSize, row.copy(row.content)));
    return true;
  }

  const positions: number[] = [];
  const { selection } = editor.state;
  if (selection instanceof CellSelection) selection.forEachCell((_cell, pos) => positions.push(pos));
  else {
    const cellPos = findAncestorPos(selection.$from, ["tableCell", "tableHeader"]);
    if (cellPos != null) positions.push(cellPos);
  }
  if (!positions.length) return false;
  let tr = editor.state.tr;
  for (const pos of positions.sort((a, b) => b - a)) {
    const cell = tr.doc.nodeAt(pos);
    const emptyCell = cell?.type.createAndFill(cell.attrs);
    if (cell && emptyCell) tr = tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, emptyCell.content);
  }
  editor.view.dispatch(tr);
  return true;
}

export function fillSelectedTableCells(editor: Editor, value: string): boolean {
  const positions: number[] = [];
  const { selection, schema } = editor.state;
  if (selection instanceof CellSelection) selection.forEachCell((_cell, pos) => positions.push(pos));
  else {
    const cellPos = findAncestorPos(selection.$from, ["tableCell", "tableHeader"]);
    if (cellPos != null) positions.push(cellPos);
  }
  const paragraph = schema.nodes.paragraph;
  if (!positions.length || !paragraph) return false;
  let tr = editor.state.tr;
  for (const pos of positions.sort((a, b) => b - a)) {
    const cell = tr.doc.nodeAt(pos);
    if (!cell) continue;
    const content = paragraph.create(null, value ? schema.text(value) : undefined);
    tr = tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, content);
  }
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export function getTableDimensions(editor: Editor): { rows: number; cols: number } | null {
  const tablePos = findTableAncestorPos(editor.state.selection.$from);
  const table = tablePos == null ? null : editor.state.doc.nodeAt(tablePos);
  return table ? { rows: table.childCount, cols: TableMap.get(table).width } : null;
}

function TableMoreMenu({ editor, onRequestDelete }: { editor: Editor; onRequestDelete: () => void }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ display: "inline-flex" }}>
      <button
        ref={btnRef}
        type="button"
        className="toolbar-btn"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={() => {
          if (anchor) {
            setAnchor(null);
          } else if (btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setAnchor({ x: r.left, y: r.bottom + 4 });
          }
        }}
        style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}
      >
        {t("editor.more")}
      </button>
      <ContextMenuShell
        anchor={anchor}
        onClose={() => setAnchor(null)}
        minWidth={150}
        ariaLabel={t("editor.more")}
      >
        {MORE_TABLE_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className="menu-row menu-item"
            onClick={() => {
              if (action.id === "table-delete") onRequestDelete();
              else runTableAction(editor, action.id);
              setAnchor(null);
            }}
            style={{ color: action.danger ? "var(--danger)" : "inherit" }}
          >
            {t(action.label)}
          </button>
        ))}
      </ContextMenuShell>
    </div>
  );
}

export function TableMenuButtons({
  editor,
  onAi,
  onFill,
}: {
  editor: Editor;
  onAi?: () => void;
  onFill?: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const singleRow = useEditorState({ editor, selector: ({ editor: current }) => getTableDimensions(current)?.rows === 1 });
  const singleColumn = useEditorState({ editor, selector: ({ editor: current }) => getTableDimensions(current)?.cols === 1 });
  return (
    <>
      <button type="button" className="toolbar-btn" title={t("editor.table_row_add_after")} onClick={() => runTableAction(editor, "row-after")} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>
        {t("editor.table_row")} +
      </button>
      <button type="button" className="toolbar-btn" title={t("editor.table_row_delete")} disabled={singleRow} onClick={() => runTableAction(editor, "row-delete")} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>
        {t("editor.table_row")} −
      </button>
      <ToolbarDivider />
      <button type="button" className="toolbar-btn" title={t("editor.table_col_add_after")} onClick={() => runTableAction(editor, "column-after")} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>
        {t("editor.table_column")} +
      </button>
      <button type="button" className="toolbar-btn" title={t("editor.table_col_delete")} disabled={singleColumn} onClick={() => runTableAction(editor, "column-delete")} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>
        {t("editor.table_column")} −
      </button>
      <ToolbarDivider />
      <button type="button" className="toolbar-btn" title={t("editor.table_cell_clear")} onClick={() => runTableAction(editor, "cell-clear")} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>
        {t("editor.table_cell_clear_short")}
      </button>
      {onFill && <button type="button" className="toolbar-btn" title={t("editor.table_cell_fill")} onClick={onFill} style={{ width: "auto", padding: "0 6px", fontSize: "var(--text-xs)" }}>{t("editor.table_cell_fill_short")}</button>}
      {onAi && <button type="button" className="toolbar-btn" title={t("editor.table_ai_title")} onClick={onAi} style={{ width: "auto", padding: "0 7px", fontSize: "var(--text-xs)", color: "var(--accent)" }}>AI</button>}
      <TableMoreMenu editor={editor} onRequestDelete={() => setDeleteOpen(true)} />
      {deleteOpen && (
        <PromptDialog
          title={t("editor.table_delete_confirm_title")}
          description={t("editor.table_delete_confirm_description")}
          mode="confirm"
          danger
          confirmLabel={t("editor.table_delete_confirm_action")}
          onCancel={() => setDeleteOpen(false)}
          onSubmit={() => {
            runTableAction(editor, "table-delete");
            setDeleteOpen(false);
          }}
        />
      )}
    </>
  );
}

/** 스크롤 지문 — EditorPanel.tsx's own viewportEpochOf, duplicated here (3 lines) rather than
 *  imported: that file imports FROM this one (TableBubbleMenu), so the reverse import would be
 *  circular. */
function viewportEpochOf(editor: { view: { dom: HTMLElement } }): number {
  return Math.round(editor.view.dom.getBoundingClientRect().top);
}

/** Exported for testing. Walks up from a resolved position to the nearest ancestor "table" node,
 *  returning its start position (nodeDOM(pos) resolves to the actual <table> DOM element) — or
 *  null when the position isn't inside one. Returns null (not a crash) for an AllSelection
 *  (Ctrl+A): $from there is doc.resolve(0), whose depth is 0, so the loop body never runs —
 *  BubbleMenuPlugin treats a null getReferencedVirtualElement result as "use the default anchor",
 *  not an error (verified against @tiptap/extension-bubble-menu's source). */
export function findTableAncestorPos($from: ResolvedPos): number | null {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") return $from.before(d);
  }
  return null;
}

/**
 * Floating table menu — shows when the caret/selection is inside a table, but NOT when there's
 * an active non-empty text selection inside a cell (isTextSelection + !empty) — that case is the
 * text-formatting BubbleMenu's job (TextBubbleMenu.tsx), and the two menus' anchors sit close
 * enough (table-top vs. selection-rect, both `placement:"top"`) to visibly stack for a first-row
 * cell if both were allowed to show. A plain caret (empty selection) or a cross-cell
 * CellSelection (not a TextSelection) still shows this menu — those aren't the text menu's
 * territory. Anchored to the table's own top edge (not the caret) so it doesn't jump around as
 * the selection moves within the same table — same stable-rect-anchor pattern as
 * ImageBubble.tsx/TextBubbleMenu.tsx.
 */
export function TableBubbleMenu({
  editor,
  scrollEl,
}: {
  editor: Editor;
  // N1-3: see ImageBubble.tsx — same scrollTarget wiring, same reason (this menu's own
  // BubbleMenuPlugin instance otherwise defaults to listening on `window`, which never fires
  // when the editor's `.scroll.editor-desktop` container scrolls).
  scrollEl: HTMLElement | null;
}) {
  const anchorRef = useRef(createStableRectAnchor());
  const [aiOpen, setAiOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);

  const openAi = async () => {
    if (await ensureAiAskGate()) setAiOpen(true);
  };

  const getReferencedVirtualElement = () => {
    const tablePos = findTableAncestorPos(editor.state.selection.$from);
    if (tablePos == null) return null;
    const rect = anchorRef.current(
      tablePos,
      tablePos,
      () => {
        const dom = editor.view.nodeDOM(tablePos) as HTMLElement | null;
        return (dom ?? editor.view.dom).getBoundingClientRect();
      },
      viewportEpochOf(editor),
    );
    return { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  };

  return (
    <>
    <BubbleMenu
      editor={editor}
      appendTo={() => document.body}
      options={{ strategy: "fixed", placement: "top", offset: 8, scrollTarget: scrollEl ?? undefined }}
      shouldShow={({ editor: ed, state }) =>
        ed.isActive("table") && !(isTextSelection(state.selection) && !state.selection.empty)
      }
      getReferencedVirtualElement={getReferencedVirtualElement}
      className="overlay"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2xs)",
        padding: 4,
        borderRadius: "var(--radius-pill)", // 가로 툴바형 — 외곽선·배경은 .overlay 레시피
        boxShadow: "var(--shadow-lg)",
        zIndex: "var(--z-dropdown)",
      }}
    >
      <TableMenuButtons editor={editor} onAi={() => void openAi()} onFill={() => setFillOpen(true)} />
    </BubbleMenu>
    {fillOpen && (
      <PromptDialog
        title={t("editor.table_cell_fill")}
        mode="input"
        placeholder={t("editor.table_cell_fill_placeholder")}
        onCancel={() => setFillOpen(false)}
        onSubmit={(value) => {
          fillSelectedTableCells(editor, typeof value === "string" ? value : "");
          setFillOpen(false);
        }}
      />
    )}
    {aiOpen && <TableAiModal editor={editor} onClose={() => setAiOpen(false)} />}
    </>
  );
}

export type TableContextMenuOpen = (e: MouseEvent) => void;

/**
 * Table-cell context menu. The parent editor surface should call openRef.current from its
 * onContextMenu handler before the generic selection menu. A non-empty text selection is left
 * untouched so the text menu keeps priority; CellSelection is preserved for multi-cell clear.
 */
export function TableContextMenu({
  editor,
  disabled = false,
  openRef,
  onBusyChange,
}: {
  editor: Editor;
  disabled?: boolean;
  openRef: MutableRefObject<TableContextMenuOpen | null>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useLayoutEffect(() => {
    onBusyChange?.(!!anchor);
    return () => onBusyChange?.(false);
  }, [anchor, onBusyChange]);

  const tryOpen = useCallback((e: MouseEvent) => {
    if (disabled || (isTextSelection(editor.state.selection) && !editor.state.selection.empty)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest("td, th")) return;
    e.preventDefault();

    if (!(editor.state.selection instanceof CellSelection)) {
      const found = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (found) editor.commands.setTextSelection(found.pos);
    }
    setAnchor({ x: e.clientX, y: e.clientY });
  }, [disabled, editor]);

  useEffect(() => {
    openRef.current = tryOpen;
    return () => { openRef.current = null; };
  }, [openRef, tryOpen]);

  const menu = (
    <ContextMenuShell
      anchor={anchor}
      onClose={() => setAnchor(null)}
      minWidth={190}
      ariaLabel={t("editor.table_actions")}
    >
      <button
        type="button"
        role="menuitem"
        className="menu-row menu-item"
        onClick={() => { setAnchor(null); setFillOpen(true); }}
      >
        {t("editor.table_cell_fill")}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-row menu-item"
        onClick={() => {
          setAnchor(null);
          void ensureAiAskGate().then((ok) => { if (ok) setAiOpen(true); });
        }}
        style={{ color: "var(--accent)" }}
      >
        {t("editor.table_ai_title")}
      </button>
      <div className="menu-sep" />
      {TABLE_ACTION_GROUPS.flatMap((group, groupIndex) => [
        groupIndex ? <div key={`${group.label}-divider`} className="menu-sep" /> : null,
        ...group.actions.map((action) => {
          const dimensions = getTableDimensions(editor);
          const disabled = (action.id === "row-delete" && dimensions?.rows === 1)
            || (action.id === "column-delete" && dimensions?.cols === 1);
          return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className="menu-row menu-item"
            disabled={disabled}
            onClick={() => {
              if (action.id === "table-delete") setDeleteOpen(true);
              else runTableAction(editor, action.id);
              setAnchor(null);
            }}
            style={{ color: action.danger ? "var(--danger)" : "inherit" }}
          >
            {t(action.label)}
          </button>
          );
        }),
      ])}
    </ContextMenuShell>
  );
  return (
    <>
      {menu}
      {fillOpen && (
        <PromptDialog
          title={t("editor.table_cell_fill")}
          mode="input"
          placeholder={t("editor.table_cell_fill_placeholder")}
          onCancel={() => setFillOpen(false)}
          onSubmit={(value) => {
            fillSelectedTableCells(editor, typeof value === "string" ? value : "");
            setFillOpen(false);
          }}
        />
      )}
      {aiOpen && <TableAiModal editor={editor} onClose={() => setAiOpen(false)} />}
      {deleteOpen && (
        <PromptDialog
          title={t("editor.table_delete_confirm_title")}
          description={t("editor.table_delete_confirm_description")}
          mode="confirm"
          danger
          confirmLabel={t("editor.table_delete_confirm_action")}
          onCancel={() => setDeleteOpen(false)}
          onSubmit={() => {
            runTableAction(editor, "table-delete");
            setDeleteOpen(false);
          }}
        />
      )}
    </>
  );
}
