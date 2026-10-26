import { Extension, InputRule } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/**
 * N2-6: GFM habit accommodation. Stock TaskItem's input rule only fires on bare "[ ] "/"[x] "
 * (see inputRules.test.ts) — but by the time a user has typed the leading "- " that GFM habit
 * expects, the bulletList input rule (`/^\s*([-+*])\s$/`) has ALREADY converted the block into a
 * one-item bulletList. TaskItem's own wrappingInputRule then can't retroactively unwrap that and
 * re-wrap as taskList (confirmed empirically — inputRules.test.ts's pre-existing "- [ ] does NOT
 * become taskList" case, now flipped since this rule handles it).
 *
 * This rule detects the narrower, common case directly: the cursor is in an otherwise-empty
 * paragraph whose parent listItem is the ONLY item in its enclosing bulletList (i.e. that
 * bulletList exists solely because of the "- " just typed) — and swaps that bulletList node for
 * a taskList/taskItem wrapping an empty paragraph, consuming the "[ ] "/"[x] " text as the
 * checkbox state instead of leaving it as literal characters.
 *
 * ponytail: doesn't handle "- [ ] " typed as a fresh item inside an ALREADY multi-item bulletList
 * (bulletList.childCount > 1) — splitting a mixed bullet/task list from a single keystroke is a
 * rarer case, so it falls through to plain "[ ] " text, same as the pre-existing (undocumented)
 * behavior. Upgrade path if this bites: split the bulletList at that listItem instead of
 * requiring childCount === 1.
 */
export const TaskListDashInputRule = Extension.create({
  name: "taskListDashInputRule",
  addInputRules() {
    return [
      new InputRule({
        // Same anchored regex as TaskItem's stock inputRegex, minus the "- " prefix — by the
        // time this fires, "- " has already turned the block into a bulletList (see above).
        find: /^(\[([( |x])?\])\s$/,
        handler: ({ state, match }) => {
          const { $from } = state.selection;
          const paragraphDepth = $from.depth;
          // Need at least listItem + bulletList ancestors above the paragraph.
          if (paragraphDepth < 2) return null;
          // The handler runs BEFORE the triggering character (the trailing space) is actually
          // inserted into the doc — match[0] ("[ ] ") includes it, $from.parent.textContent
          // doesn't yet. Drop the last char to compare apples to apples. This also guards the
          // (rarer) case of trailing text after the cursor in the same paragraph — if there is
          // any, the two won't match and the rule correctly bails.
          if ($from.parent.textContent !== match[0].slice(0, -1)) return null;
          const listItemDepth = paragraphDepth - 1;
          const bulletListDepth = paragraphDepth - 2;
          if ($from.node(listItemDepth).type.name !== "listItem") return null;
          const bulletList = $from.node(bulletListDepth);
          if (bulletList.type.name !== "bulletList" || bulletList.childCount !== 1) return null;
          const { schema } = state;
          if (!schema.nodes.taskList || !schema.nodes.taskItem) return null;
          const checked = match[match.length - 1] === "x";
          const taskItem = schema.nodes.taskItem.create({ checked }, schema.nodes.paragraph.create());
          const taskList = schema.nodes.taskList.create(null, taskItem);
          const start = $from.before(bulletListDepth);
          const end = $from.after(bulletListDepth);
          // Replaces the whole (single-item) bulletList node — the "[ ] " text living inside its
          // paragraph goes with it, which is exactly the desired effect (checkbox, not literal
          // characters). replaceWith's default position-mapping drops the cursor right after the
          // new node (the old paragraph it was in no longer exists), not inside it — place it
          // back in the new taskItem's empty paragraph explicitly (start + taskList/taskItem/
          // paragraph opening tokens = start + 3) so typing can continue where the user expects.
          const tr = state.tr.replaceWith(start, end, taskList);
          tr.setSelection(TextSelection.near(tr.doc.resolve(start + 3)));
        },
      }),
    ];
  },
});
