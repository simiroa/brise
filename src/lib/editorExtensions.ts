import { FootnoteMark } from "../components/editor/footnoteMark";
import { DateMark } from "../components/editor/dateMark";
import { CodeBlockWithCopy } from "../components/editor/codeBlockCopy";
import { TableCellSelectionGuard } from "../components/editor/tableCellSelectionGuard";
import { TableMatrixPaste } from "../components/editor/tableMatrixPaste";
import { markdownSchemaExtensions } from "./mdSerialize";

// Wave R1-b dedup: the actual extension list (StarterKit/Table/Link/BriseImage/… — ~15 entries)
// now lives once in mdSerialize.ts's markdownSchemaExtensions builder, shared with this file's own
// headless schema. FootnoteMark/DateMark (not mdSerialize's BriseFootnote/BriseDateMark) are the
// live/preview wire-compatible marks — EditorPanel.tsx's useEditor extensions list also spreads
// this same PREVIEW_EXTENSIONS (outside L2 ownership) instead of re-listing the same ~15
// extensions a third time. DateMark here is what makes the mark render (and its click handler
// live) in both the live editor and the preview panel (PLAN-2026-09-18-nl-dates.md §W3a).
export const PREVIEW_EXTENSIONS = markdownSchemaExtensions({
  footnote: FootnoteMark,
  date: DateMark,
  tableRenderWrapper: true,
  typography: true,
  codeBlock: CodeBlockWithCopy,
}).concat(TableCellSelectionGuard, TableMatrixPaste);
