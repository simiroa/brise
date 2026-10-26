/**
 * Verifies markdown input rules that the cheatsheet documents.
 * Why: list icons were removed from the toolbar (P1-1); the cheatsheet must only show rules that
 * actually fire with our TaskItem nested:true configuration.
 */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Typography from "@tiptap/extension-typography";
import Link from "@tiptap/extension-link";
import { Markdown } from "@tiptap/markdown";
import { TaskListDashInputRule } from "./taskListDashInputRule";
import { WikiLink } from "./wikiLink";
import { SlashCommand } from "./slashCommand";

function makeEditor(content = "<p></p>") {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      TaskList,
      // Production uses nested:true — cheatsheet gate requires this exact config.
      TaskItem.configure({ nested: true }),
      // N2-6: GFM habit accommodation — see taskListDashInputRule.ts.
      TaskListDashInputRule,
    ],
    content,
  });
}

/**
 * Fire ProseMirror input rules by going through handleTextInput (tr.insertText alone
 * does not run the inputRules plugin — only the view's text-input path does).
 */
function typeText(ed: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    // ProseMirror: handleTextInput(view, from, to, text, deflt). Input-rule plugins ignore
    // deflt; we only need them to run, then fall back to insertText if nothing handled.
    const handled = ed.view.someProp("handleTextInput", (f) =>
      f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch)),
    );
    if (!handled) {
      ed.view.dispatch(ed.state.tr.insertText(ch));
    }
  }
}

describe("editor input rules (cheatsheet gate)", () => {
  it("heading: '# ' → h1", () => {
    const ed = makeEditor();
    typeText(ed, "# ");
    expect(ed.isActive("heading", { level: 1 })).toBe(true);
    ed.destroy();
  });

  it("blockquote: '> ' → blockquote", () => {
    const ed = makeEditor();
    typeText(ed, "> ");
    expect(ed.isActive("blockquote")).toBe(true);
    ed.destroy();
  });

  it("bullet list: '- ' → bulletList", () => {
    const ed = makeEditor();
    typeText(ed, "- ");
    expect(ed.isActive("bulletList")).toBe(true);
    ed.destroy();
  });

  it("ordered list: '1. ' → orderedList", () => {
    const ed = makeEditor();
    typeText(ed, "1. ");
    expect(ed.isActive("orderedList")).toBe(true);
    ed.destroy();
  });

  it("horizontal rule: '---' → horizontalRule", () => {
    const ed = makeEditor();
    typeText(ed, "---");
    const types = ed.state.doc.content.content.map((n) => n.type.name);
    // After '---' the rule inserts a horizontalRule node (often followed by an empty paragraph).
    expect(types).toContain("horizontalRule");
    ed.destroy();
  });

  it("task list: '[ ] ' (no dash) → taskList/taskItem with nested:true", () => {
    // Stock TaskItem inputRegex is /^\s*(\[([( |x])?\])\s$/ — brackets only, no leading '-'.
    const ed = makeEditor();
    typeText(ed, "[ ] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    ed.destroy();
  });

  it("task list: '[x] ' → checked taskItem", () => {
    const ed = makeEditor();
    typeText(ed, "[x] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    expect(ed.getAttributes("taskItem").checked).toBe(true);
    ed.destroy();
  });

  it("task list: '- [ ] ' becomes taskList (N2-6: TaskListDashInputRule swaps the bullet rule's list)", () => {
    // '- ' first turns the block into a one-item bulletList (bulletList rule wins the race);
    // TaskListDashInputRule then detects that single-item bulletList and swaps it for taskList.
    const ed = makeEditor();
    typeText(ed, "- [ ] ");
    expect(ed.isActive("bulletList")).toBe(false);
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    expect(ed.getAttributes("taskItem").checked).toBe(false);
    ed.destroy();
  });

  it("task list: '- [x] ' becomes a checked taskItem", () => {
    const ed = makeEditor();
    typeText(ed, "- [x] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.getAttributes("taskItem").checked).toBe(true);
    ed.destroy();
  });

  it("task list: '[ ] ' inside an EXISTING multi-item bullet list stays plain text (documented gap)", () => {
    // ponytail scope in taskListDashInputRule.ts: only a single-item (freshly created) bulletList
    // is swapped. A second bullet item is not retroactively split out of an already multi-item
    // list — falls through to literal "[ ] " text, same as before this rule existed.
    const ed = makeEditor("<ul><li><p>one</p></li><li><p></p></li></ul>");
    ed.commands.setTextSelection(ed.state.doc.content.size - 1); // cursor in the 2nd, empty item
    expect(ed.isActive("bulletList")).toBe(true); // sanity: cursor landed inside the list
    typeText(ed, "[ ] ");
    expect(ed.isActive("bulletList")).toBe(true);
    expect(ed.isActive("taskList")).toBe(false);
    ed.destroy();
  });

  it("task list after bullet: type '[ ] ' inside a fresh paragraph (not after '- ')", () => {
    // Confirms the working syntax for the cheatsheet: bare '[ ] '.
    const ed = makeEditor();
    typeText(ed, "[ ] todo");
    expect(ed.isActive("taskList")).toBe(true);
    ed.destroy();
  });

  it("task list: '- [ ] ' still fires against the PRODUCTION extension set (Markdown/Typography/WikiLink/SlashCommand)", () => {
    // makeEditor() above is intentionally the minimal fixture the other cases in this file share
    // (unchanged, so it can't regress them). This test alone uses a wider extension list closer to
    // EditorPanel.tsx's real editor — the cheatsheet now advertises "- [ ] " (see EditorPanel.tsx's
    // CheatsheetPopover), so the claim needs proof against the schema users actually type into, not
    // just the reduced fixture. In particular: WikiLink registers its own suggestion plugin on the
    // "[[" trigger char, and Typography/Markdown both add input rules of their own that share the
    // same rules array — either could plausibly have intercepted "[ ] " first.
    const ed = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false, link: false }),
        Markdown,
        TaskList,
        TaskItem.configure({ nested: true }),
        Link.configure({ openOnClick: false, protocols: ["note"] }),
        Typography,
        TaskListDashInputRule,
        WikiLink,
        SlashCommand,
      ],
      content: "<p></p>",
    });
    typeText(ed, "- [ ] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    ed.destroy();
  });
});
