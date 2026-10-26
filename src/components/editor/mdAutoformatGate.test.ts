/**
 * 오너 결정(2026-09-20) — editor_md_autoformat 킬 스위치(mdAutoformatGate.ts) 검증. 실제
 * `Editor` 인스턴스로 handleTextInput 경로를 태워(tr.insertText 만으로는 input rule 플러그인이
 * 안 돈다 — inputRules.test.ts 의 typeText 관용구를 그대로 재사용), 켜짐/꺼짐/런타임 토글/
 * undo 이력/조합(IME) 입력 경로를 확인한다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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
import { MdAutoformatGate } from "./mdAutoformatGate";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CellSelection } from "@tiptap/pm/tables";
import { TableCellSelectionGuard } from "./tableCellSelectionGuard";

let editorMdAutoformat = true;
vi.mock("../../stores/settings", () => ({
  useSettingsStore: { getState: () => ({ editorMdAutoformat }) },
}));

beforeEach(() => {
  editorMdAutoformat = true;
});

function makeEditor(content = "<p></p>") {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      TaskList,
      // Production uses nested:true — same schema as inputRules.test.ts's fixture.
      TaskItem.configure({ nested: true }),
      TaskListDashInputRule,
      MdAutoformatGate,
    ],
    content,
  });
}

/**
 * Fire ProseMirror input rules by going through handleTextInput (tr.insertText alone does not run
 * the inputRules plugin — only the view's text-input path does). Same idiom as
 * inputRules.test.ts's own typeText — kept as a local copy so this file stays independently
 * readable and doesn't reach into that file's internals.
 */
function typeText(ed: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    const handled = ed.view.someProp("handleTextInput", (f) =>
      f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch)),
    );
    if (!handled) {
      ed.view.dispatch(ed.state.tr.insertText(ch));
    }
  }
}

describe("MdAutoformatGate — editorMdAutoformat on (default)", () => {
  it("'# ' still makes a heading", () => {
    const ed = makeEditor();
    typeText(ed, "# ");
    expect(ed.isActive("heading", { level: 1 })).toBe(true);
    ed.destroy();
  });

  it("'- [ ] ' still makes a task item (this repo's own taskListDashInputRule)", () => {
    const ed = makeEditor();
    typeText(ed, "- [ ] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    ed.destroy();
  });
});

describe("MdAutoformatGate — editorMdAutoformat off", () => {
  it("'# ' leaves the literal characters, no heading", () => {
    editorMdAutoformat = false;
    const ed = makeEditor();
    typeText(ed, "# ");
    expect(ed.isActive("heading")).toBe(false);
    expect(ed.getText()).toBe("# ");
    ed.destroy();
  });

  it("'- [ ] ' leaves the literal characters, no task item", () => {
    editorMdAutoformat = false;
    const ed = makeEditor();
    typeText(ed, "- [ ] ");
    expect(ed.isActive("taskList")).toBe(false);
    expect(ed.isActive("bulletList")).toBe(false);
    expect(ed.getText()).toBe("- [ ] ");
    ed.destroy();
  });

  it("'**bold**' leaves literal asterisks, no bold mark", () => {
    editorMdAutoformat = false;
    const ed = makeEditor();
    typeText(ed, "**bold**");
    expect(ed.isActive("bold")).toBe(false);
    expect(ed.getText()).toBe("**bold**");
    ed.destroy();
  });

  it("undo stays sane — a single undo fully removes text typed while off (no phantom history steps)", () => {
    editorMdAutoformat = false;
    const ed = makeEditor();
    typeText(ed, "hello");
    expect(ed.getText()).toBe("hello");
    ed.commands.undo();
    expect(ed.getText().trim()).toBe("");
    ed.destroy();
  });
});

describe("MdAutoformatGate — runtime toggle on the SAME editor instance", () => {
  it("off then on: literal chars while off, rule fires immediately once flipped on (no recreation)", () => {
    editorMdAutoformat = false;
    const ed = makeEditor();
    typeText(ed, "# ");
    expect(ed.isActive("heading")).toBe(false);

    editorMdAutoformat = true;
    // Fresh paragraph so the still-literal "# " above doesn't interfere with the next match.
    ed.commands.selectAll();
    ed.commands.deleteSelection();
    typeText(ed, "> ");
    expect(ed.isActive("blockquote")).toBe(true);

    ed.destroy();
  });

  it("on then off: rule fires while on, next rule attempt stays literal once flipped off", () => {
    const ed = makeEditor();
    typeText(ed, "> ");
    expect(ed.isActive("blockquote")).toBe(true);

    editorMdAutoformat = false;
    ed.commands.selectAll();
    ed.commands.deleteSelection();
    typeText(ed, "# ");
    expect(ed.isActive("heading")).toBe(false);
    expect(ed.getText()).toBe("# ");

    ed.destroy();
  });
});

describe("MdAutoformatGate — IME composition path", () => {
  // Real IME composition can't be reproduced faithfully in jsdom (no genuine DOM mutation from a
  // real input method), so this only proves what the header comment's safety argument depends on:
  // the gate does not register any compositionend handler, so dispatching one never throws and
  // never corrupts/duplicates the document — composition end handling is left entirely to
  // ProseMirror's own native processing regardless of the flag.
  for (const enabled of [true, false]) {
    it(`does not crash or double-insert around a composition sequence (editorMdAutoformat=${enabled})`, () => {
      editorMdAutoformat = enabled;
      const ed = makeEditor("<p>abc</p>");
      const before = ed.getText();

      expect(() => {
        ed.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true, cancelable: true }));
        ed.view.dom.dispatchEvent(new Event("compositionupdate", { bubbles: true, cancelable: true }));
        ed.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true, cancelable: true }));
      }).not.toThrow();

      expect(ed.getText()).toBe(before);
      ed.destroy();
    });
  }
});

describe("MdAutoformatGate — out of scope, must keep working regardless of the flag", () => {
  it("Suggestion triggers ('[[', '/') are unaffected when autoformat is off — production extension set", () => {
    editorMdAutoformat = false;
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
        MdAutoformatGate,
      ],
      content: "<p></p>",
    });

    expect(() => typeText(ed, "[[")).not.toThrow();
    expect(ed.getText()).toContain("[[");

    ed.destroy();
  });

  it("'- [ ] ' still fires against the production extension set with the gate on (regression guard for priority ordering)", () => {
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
        MdAutoformatGate,
      ],
      content: "<p></p>",
    });
    typeText(ed, "- [ ] ");
    expect(ed.isActive("taskList")).toBe(true);
    expect(ed.isActive("taskItem")).toBe(true);
    ed.destroy();
  });
});

// 이 게이트는 priority 100000 이라 **모든** 다른 플러그인의 handleTextInput 보다 먼저 돈다. 꺼진
// 상태에서 무조건 입력을 직접 넣고 true 를 돌려주면, 입력 규칙만이 아니라 뒤에 선 다른
// handleTextInput 도 같이 건너뛴다 — 이 레포엔 그런 게 하나 있다: TableCellSelectionGuard 는 여러
// 셀을 선택한 채 타이핑하면 입력을 **막는다**(다중 셀 선택은 비파괴여야 한다). 검토 중 발견한 회귀:
// 자동 서식을 끄면 그 가드가 무력화돼 글자가 들어갔다.
describe("MdAutoformatGate — must not swallow other plugins' text-input guards", () => {
  function makeTableEditor() {
    return new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        Table,
        TableRow,
        TableHeader,
        TableCell,
        TableCellSelectionGuard,
        MdAutoformatGate,
      ],
      content: "<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>",
    });
  }
  function cellPositions(ed: Editor): number[] {
    const out: number[] = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell") out.push(pos);
    });
    return out;
  }

  for (const enabled of [true, false]) {
    it(`typing over a multi-cell selection stays blocked (editorMdAutoformat=${enabled})`, () => {
      editorMdAutoformat = enabled;
      const ed = makeTableEditor();
      const cells = cellPositions(ed);
      expect(ed.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[3] })).toBe(true);
      expect(ed.state.selection).toBeInstanceOf(CellSelection);
      const before = ed.getHTML();
      typeText(ed, "x");
      expect(ed.getHTML()).toBe(before);
      ed.destroy();
    });
  }

  it("with autoformat off, typing inside a single cell (no CellSelection) still inserts literally", () => {
    editorMdAutoformat = false;
    const ed = makeTableEditor();
    const cells = cellPositions(ed);
    ed.commands.setTextSelection(cells[0] + 2);
    typeText(ed, "# ");
    expect(ed.getHTML()).toContain("# ");
    expect(ed.getHTML()).not.toContain("<h1");
    ed.destroy();
  });
});
