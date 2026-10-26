/**
 * Live-editor date mark (PLAN-2026-09-18-nl-dates.md §W3a).
 *
 * body_md wire format SSOT is `BriseDateMark` in `src/lib/mdSerialize.ts`:
 *   `<span data-date="<note_dates id>">anchored text</span>`
 *
 * Sibling of `footnoteMark.ts`'s `FootnoteMark`, but deliberately simpler: click → open the
 * date-entry popover on that row (one direction only). No hover/flash decorations — footnote
 * needed them for its own preview-panel jump; a date mark's only affordance is "click to edit"
 * (§W3a scope note in the plan doc: cheaper than the payoff for this wave).
 *
 * Dangling marks (the note_dates row was deleted) are out of scope beyond "doesn't crash": the
 * editor has no live `dates` cache to check against (NoteDetail doesn't carry note_dates; it's a
 * separate on-demand `note_dates_list` fetch), so this mark never tries to tell a live id from a
 * dangling one — `openDateEntry` is called regardless, and `DatesPanel`'s existing
 * `initialSelectedId` fallback (see its own doc comment) is what keeps a stale click from
 * crashing the popover.
 */
import { mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { BriseDateMark } from "../../lib/mdSerialize";
import { useNotesStore } from "../../stores/notes";
import { openDateEntry } from "../../lib/dateEntryBridge";

/** Schema SSOT — re-export so callers import from one place (same idiom as footnoteMark.ts). */
export { BriseDateMark };

const dateClickKey = new PluginKey("briseDateClick");

/**
 * 문서 안에서 attrs.id === id 인 date 마크가 붙은 텍스트 노드 범위들. 한 앵커가 여러 텍스트
 * 노드로 쪼개져 있을 수 있어(부분 볼드 등) 배열 — findFootnoteRanges(footnoteMark.ts)와 같은
 * 이유로 같은 모양을 그대로 따른다.
 */
export function findDateMarkRanges(doc: PMNode, id: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type.name === "date" && m.attrs.id === id)) {
      out.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return out;
}

/**
 * Live mark registered in the editor. Wire format identical to BriseDateMark
 * (name `"date"`, attr `id` ↔ `data-date`, renderMarkdown HTML island).
 * Class/style on renderHTML are DOM-only — getMarkdown still uses inherited renderMarkdown.
 */
export const DateMark = BriseDateMark.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "brise-date-mark",
        // --info (blue) instead of footnote's --accent (green) — visually distinct mark kind.
        // Solid underline (not dotted) is the other differentiator so the two don't read as the
        // same affordance at a glance.
        style: "cursor:pointer;text-decoration:underline;color:var(--info);",
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: dateClickKey,
        props: {
          // Open the date-entry popover pre-selected on this row. Return false so the caret still
          // moves — same "signal only" posture as FootnoteMark's click handler.
          handleDOMEvents: {
            click(view, event) {
              const el = (event.target as HTMLElement | null)?.closest?.(
                "span[data-date]",
              ) as HTMLElement | null;
              if (!el) return false;
              const id = el.getAttribute("data-date");
              if (!id) return false;
              const noteId = useNotesStore.getState().activeNote?.note.id;
              if (!noteId) return false;
              const ranges = findDateMarkRanges(view.state.doc, id);
              const pos = view.posAtDOM(el, 0);
              const range = ranges[0] ?? { from: pos, to: pos };
              const mouseEvent = event as MouseEvent;
              openDateEntry({
                noteId,
                anchorX: mouseEvent.clientX,
                anchorY: mouseEvent.clientY + 6,
                range,
                editRowId: id,
              });
              return false;
            },
          },
        },
      }),
    ];
  },
});
