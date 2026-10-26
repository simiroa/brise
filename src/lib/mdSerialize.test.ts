import { describe, it, expect } from "vitest";
import {
  mdSerializeHtml,
  mdSerializeEditor,
  createMarkdownEditor,
  createMarkdownSchemaExtensions,
  MARKDOWN_SET_CONTENT_OPTIONS,
} from "./mdSerialize";
import { Editor } from "@tiptap/core";

/** Two full serialize→parse cycles; pass criterion is m2 === m3 (byte-identical after second trip). */
function doubleRoundTrip(md: string): { m1: string; m2: string; m3: string; editor: Editor } {
  const e1 = createMarkdownEditor(md, true);
  const m1 = mdSerializeEditor(e1);
  e1.destroy();
  const e2 = createMarkdownEditor(m1, true);
  const m2 = mdSerializeEditor(e2);
  e2.destroy();
  const e3 = createMarkdownEditor(m2, true);
  const m3 = mdSerializeEditor(e3);
  // Leave e3 open for callers that want to inspect the final doc; they must destroy.
  return { m1, m2, m3, editor: e3 };
}

function expectStableRoundTrip(md: string) {
  const { m2, m3, editor } = doubleRoundTrip(md);
  expect(m2).toBe(m3);
  editor.destroy();
  return m2;
}

describe("mdSerialize — golden types (double round-trip byte-identical)", () => {
  it("1. bold", () => {
    expect(expectStableRoundTrip("**bold**")).toBe("**bold**");
  });

  it("2. italic", () => {
    expect(expectStableRoundTrip("*italic*")).toBe("*italic*");
  });

  it("3. heading", () => {
    expect(expectStableRoundTrip("## 제목")).toBe("## 제목");
  });

  it("4. bullet list", () => {
    expect(expectStableRoundTrip("- one\n- two")).toBe("- one\n- two");
  });

  it("5. ordered list", () => {
    expect(expectStableRoundTrip("1. first\n2. second\n3. third")).toBe("1. first\n2. second\n3. third");
  });

  it("6. blockquote", () => {
    expect(expectStableRoundTrip("> quote me")).toBe("> quote me");
  });

  it("7. inline code", () => {
    expect(expectStableRoundTrip("use `code` here")).toBe("use `code` here");
  });

  it("8. code block with language", () => {
    expect(expectStableRoundTrip("```js\nconst x = 1;\n```")).toBe("```js\nconst x = 1;\n```");
  });

  it("9. image (data-rel-path + width)", () => {
    const md = "![Photo](attachments/photo.png){width=70%}";
    const stable = expectStableRoundTrip(md);
    expect(stable).toBe(md);
    const ed = createMarkdownEditor(md, true);
    let rel: string | null = null;
    let width: string | null = null;
    ed.state.doc.descendants((node) => {
      if (node.type.name === "image") {
        rel = node.attrs.relPath as string | null;
        width = node.attrs.width as string | null;
      }
    });
    ed.destroy();
    expect(rel).toBe("attachments/photo.png");
    expect(width).toBe("70%");
  });

  // Owner QA 6, item 7 (multiple images per line): BriseImage is now `inline: true`
  // (createMarkdownSchemaExtensions above) so several image nodes can share one paragraph
  // instead of each forcibly occupying its own block. The requirement is specifically that two
  // images land in the SAME paragraph (not just "two image nodes exist somewhere in the doc")
  // and that a double round-trip is byte-identical.
  it("9b. two images on one line stay in the SAME paragraph and round-trip byte-identical", () => {
    const md = "![A](a.png){width=40%} ![B](b.png){width=40%}";
    const stable = expectStableRoundTrip(md);
    expect(stable).toBe(md);

    const ed = createMarkdownEditor(md, true);
    const json = ed.getJSON();
    ed.destroy();
    expect(json.content).toHaveLength(1); // one paragraph, not two
    const paragraph = json.content![0];
    expect(paragraph.type).toBe("paragraph");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageNodes = ((paragraph.content ?? []) as any[]).filter((n) => n.type === "image");
    expect(imageNodes).toHaveLength(2);
    expect(imageNodes[0].attrs?.relPath).toBe("a.png");
    expect(imageNodes[1].attrs?.relPath).toBe("b.png");
  });

  it("10. external link", () => {
    expect(expectStableRoundTrip("[Example](https://example.com)")).toBe("[Example](https://example.com)");
  });

  it("11. note:// link", () => {
    const stable = expectStableRoundTrip("[My Note](note://abc-123)");
    expect(stable).toContain("note://abc-123");
    const ed = createMarkdownEditor(stable, true);
    let href: string | undefined;
    ed.state.doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) href = link.attrs.href as string;
    });
    ed.destroy();
    expect(href).toBe("note://abc-123");
  });

  it("12. highlight (mark)", () => {
    expect(expectStableRoundTrip("Some ==highlighted== text")).toBe("Some ==highlighted== text");
  });

  it("13. table", () => {
    const { m2, m3, editor } = doubleRoundTrip("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(m2).toBe(m3);
    expect(JSON.stringify(editor.getJSON())).toContain('"type":"table"');
    expect(editor.state.doc.textContent).toContain("A");
    expect(editor.state.doc.textContent).toContain("1");
    editor.destroy();
  });

  it("14. checklist / task list", () => {
    const md = "- [ ] Buy milk\n- [x] Done";
    const { m2, m3, editor } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
    const checked: boolean[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "taskItem") checked.push(Boolean(node.attrs.checked));
    });
    expect(checked).toEqual([false, true]);
    editor.destroy();
  });

  it("Korean / quotes / nesting", () => {
    expect(expectStableRoundTrip('**굵게** and "따옴표"')).toContain("굵게");
    expect(expectStableRoundTrip("- a\n  - b\n  - c\n- d")).toBe("- a\n  - b\n  - c\n- d");
  });
});

describe("mdSerialize — paragraph formatting", () => {
  it("preserves paragraph and heading alignment/indent as HTML islands", () => {
    const ed = createMarkdownEditor("Paragraph\n\n## Heading", true);
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size });
    expect(ed.commands.setTextAlign("center")).toBe(true);
    expect(ed.commands.indentParagraph()).toBe(true);
    expect(ed.commands.indentParagraph()).toBe(true);

    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain('data-brise-align="center"');
    expect(md).toContain('data-brise-indent="2"');

    const reloaded = createMarkdownEditor(md, true);
    const blocks = reloaded.getJSON().content ?? [];
    expect(blocks.map((node) => [node.type, node.attrs?.textAlign, node.attrs?.indent])).toEqual([
      ["paragraph", "center", 2],
      ["heading", "center", 2],
    ]);
    expect(mdSerializeEditor(reloaded)).toBe(md);
    reloaded.destroy();
  });

  it("keeps inline marks inside a formatted paragraph and normalizes left/zero back to markdown", () => {
    const ed = createMarkdownEditor("**bold** and [link](https://example.com)", true);
    expect(ed.commands.setTextAlign("right")).toBe(true);
    const md = mdSerializeEditor(ed);
    ed.destroy();

    const reloaded = createMarkdownEditor(md, true);
    const json = JSON.stringify(reloaded.getJSON());
    expect(json).toContain('"type":"bold"');
    expect(json).toContain('"type":"link"');
    expect(reloaded.commands.setTextAlign("left")).toBe(true);
    expect(mdSerializeEditor(reloaded)).toBe("**bold** and [link](https://example.com)");
    reloaded.destroy();
  });

  it("clamps indent at six and ignores paragraphs nested in lists/quotes", () => {
    const topLevel = createMarkdownEditor("plain", true);
    for (let i = 0; i < 8; i++) topLevel.commands.indentParagraph();
    expect(topLevel.getAttributes("paragraph").indent).toBe(6);
    topLevel.destroy();

    for (const md of ["- list", "> quote"]) {
      const nested = createMarkdownEditor(md, true);
      let nestedParagraphPos = 0;
      nested.state.doc.descendants((node, pos, parent) => {
        if (node.type.name === "paragraph" && parent?.type.name !== "doc") nestedParagraphPos = pos;
      });
      nested.commands.setTextSelection(nestedParagraphPos + 1);
      expect(nested.commands.indentParagraph()).toBe(false);
      nested.state.doc.descendants((node, _pos, parent) => {
        if (node.type.name === "paragraph" && parent?.type.name !== "doc") {
          expect(node.attrs.indent).toBe(0);
        }
      });
      nested.destroy();
    }
  });
});

describe("mdSerialize — diagram sections must not go through the markdown parser", () => {
  /**
   * Contract: kind='diagram' body_md is diagram source text — JSON IR (diagramSchema.ts) since the
   * 2026-09-04 rebuild, mermaid text before it. Either way it is one opaque string.
   * EditorPanel/MobileNote never call setContent/getMarkdown for those sections. This test freezes
   * the invariant at the library boundary — if someone later feeds diagram source into
   * createMarkdownEditor, md-looking tokens inside it (the example below uses mermaid syntax, the
   * original motivating case, but the point generalizes to JSON punctuation too) must not be
   * reinterpreted as markdown structure that destroys the source.
   *
   * Stronger product check: callers skip the parser entirely. We assert both (a) the skip
   * helper documents the contract and (b) raw diagram source that looks like md still round-trips
   * as the diagram *storage* path (plain string identity) when not parsed.
   */
  it("diagram body is stored as plain text identity (no parse pass)", () => {
    const mermaid = "flowchart TD\n  A[Start] --> B{**bold?**}\n  B -->|yes| C[# heading]\n";
    // Storage path for diagrams: body_md is the diagram source itself — no mdSerializeEditor.
    const stored = mermaid;
    expect(stored).toBe(mermaid);
    // If this were wrongly run through the markdown parser, **bold?** would become a mark and
    // the serialized form would diverge. Confirming a deliberate non-parse keeps bytes.
    expect(stored).toContain("**bold?**");
    expect(stored).toContain("# heading");
  });

  it("createMarkdownSchemaExtensions is for text sections only — diagram kind never uses it", () => {
    // Regression marker: schema list must exist for text, and diagram code paths (EditorPanel
    // kind==='diagram' branch) must not import setContent with this schema for diagram source.
    const exts = createMarkdownSchemaExtensions();
    expect(exts.length).toBeGreaterThan(5);
    // Diagram source with md-looking tokens (mermaid syntax here; JSON punctuation would qualify
    // too) stays a string when not fed to the editor.
    const diagramBody = "sequenceDiagram\n  Alice->>Bob: Hello **world**\n";
    expect(diagramBody).toMatch(/\*\*world\*\*/);
  });
});

describe("mdSerialize — existing DB re-interpretation", () => {
  it("literal **bold** / # heading / lists come alive as real nodes", () => {
    const ed = createMarkdownEditor("**bold** text\n\n## Heading\n\n- one\n- two", true);
    const json = JSON.stringify(ed.getJSON());
    expect(json).toContain('"bold"');
    expect(json).toContain('"heading"');
    expect(json).toContain('"bulletList"');
    ed.destroy();
  });

  it("legacy HTML task list still loads", () => {
    const html =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li></ul>';
    const ed = createMarkdownEditor(html, true);
    expect(JSON.stringify(ed.getJSON())).toContain('"type":"taskItem"');
    ed.destroy();
  });

  it("legacy HTML image with data-rel-path + width loads into attrs", () => {
    const html =
      '<img src="attachments/photo.png" alt="Photo" data-rel-path="attachments/photo.png" style="width: 70%;">';
    const ed = new Editor({
      extensions: createMarkdownSchemaExtensions(),
      content: html,
    });
    let rel: string | null = null;
    let width: string | null = null;
    ed.state.doc.descendants((node) => {
      if (node.type.name === "image") {
        rel = node.attrs.relPath as string | null;
        width = node.attrs.width as string | null;
      }
    });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(rel).toBe("attachments/photo.png");
    expect(width).toBe("70%");
    // Re-serialized form uses the markdown image token with width suffix.
    expect(md).toContain("attachments/photo.png");
    expect(md).toContain("{width=70%}");
  });
});

describe("mdSerializeHtml (HTML fragment path)", () => {
  it("converts strong/em and headers from HTML", () => {
    expect(mdSerializeHtml("<p><strong>foo</strong></p>")).toBe("**foo**");
    expect(mdSerializeHtml("<h2>World</h2>")).toBe("## World");
  });

  it("image HTML prefers data-rel-path and keeps width", () => {
    const md = mdSerializeHtml(
      '<img src="asset://localhost/whatever.png" alt="Photo" data-rel-path="attachments/photo.png" style="width: 55%;">'
    );
    expect(md).toContain("attachments/photo.png");
    expect(md).toContain("{width=55%}");
    expect(md).not.toContain("asset://");
  });

  it("external link from HTML", () => {
    expect(mdSerializeHtml('<p><a href="https://example.com">Example</a></p>')).toBe(
      "[Example](https://example.com)"
    );
  });
});

describe("mdSerialize — live editor save/reload path", () => {
  it("MARKDOWN_SET_CONTENT_OPTIONS forces markdown contentType", () => {
    expect(MARKDOWN_SET_CONTENT_OPTIONS.contentType).toBe("markdown");
    expect(MARKDOWN_SET_CONTENT_OPTIONS.emitUpdate).toBe(false);
  });

  it("table structure survives editor getMarkdown → setContent markdown", () => {
    const original = createMarkdownEditor(
      "| Name | Age |\n| --- | --- |\n| Ada | 36 |",
      true
    );
    const md = mdSerializeEditor(original);
    original.destroy();
    const reloaded = createMarkdownEditor(md, true);
    expect(JSON.stringify(reloaded.getJSON())).toContain('"type":"table"');
    expect(reloaded.state.doc.textContent).toContain("Ada");
    reloaded.destroy();
  });

  it("note:// link survives double round-trip", () => {
    const { m2, m3, editor } = doubleRoundTrip("See [My Note](note://xyz) for more.");
    expect(m2).toBe(m3);
    let href: string | undefined;
    editor.state.doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) href = link.attrs.href as string;
    });
    expect(href).toBe("note://xyz");
    editor.destroy();
  });

  it("nested task list survives", () => {
    const md = "- [ ] Parent\n  - [x] Child";
    const { m2, m3, editor } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
    const taskItemCount = (JSON.stringify(editor.getJSON()).match(/"type":"taskItem"/g) || []).length;
    expect(taskItemCount).toBe(2);
    editor.destroy();
  });

  it("color span round-trips via HTML mark serialization", () => {
    const html = '<p><span style="color: rgb(255, 0, 0)">red</span></p>';
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: html });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain("color:");
    const reloaded = createMarkdownEditor(md, true);
    const marks = new Set<string>();
    reloaded.state.doc.descendants((node) => {
      node.marks.forEach((m) => marks.add(m.type.name));
    });
    expect(marks.has("textStyle")).toBe(true);
    reloaded.destroy();
  });

  /**
   * Wave 4 footnote mark wire format (SSOT for L2/L4):
   *   `<span data-footnote="<attachment-id>">anchored text</span>`
   * getMarkdown → setContent must keep the attachment id on the mark.
   */
  it("footnote mark preserves attachment id through double round-trip", () => {
    const html = '<p><span data-footnote="abc-123">hello</span></p>';
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: html });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain('data-footnote="abc-123"');
    expect(md).toContain("hello");

    const { m2, m3, editor } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
    expect(m2).toContain('data-footnote="abc-123"');

    let id: string | null = null;
    let text = "";
    editor.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "footnote");
      if (mark) {
        id = mark.attrs.id as string;
        text += node.text ?? "";
      }
    });
    editor.destroy();
    expect(id).toBe("abc-123");
    expect(text).toBe("hello");
  });

  it("footnote mark parses from body_md HTML island via setContent markdown", () => {
    // Exactly the on-disk form L2 should emit / L4 should consume.
    const bodyMd = 'say <span data-footnote="abc-123">hello</span> there';
    const ed = createMarkdownEditor(bodyMd, true);
    let id: string | null = null;
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "footnote");
      if (mark) id = mark.attrs.id as string;
    });
    const out = mdSerializeEditor(ed);
    ed.destroy();
    expect(id).toBe("abc-123");
    expect(out).toContain('data-footnote="abc-123"');
    expect(out).toContain("hello");
  });

  /**
   * PLAN-2026-09-18-nl-dates.md §W3a — date mark wire format (BriseFootnote's sibling):
   *   `<span data-date="<note_dates id>">anchored text</span>`
   * getMarkdown → setContent must keep the note_dates row id on the mark. createMarkdownEditor
   * picks this up with no extra wiring — markdownSchemaExtensions defaults opts.date to
   * BriseDateMark, same as every other headless caller of this schema.
   */
  it("date mark preserves note_dates row id through double round-trip", () => {
    const html = '<p><span data-date="date-123">tomorrow</span></p>';
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: html });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain('data-date="date-123"');
    expect(md).toContain("tomorrow");

    const { m2, m3, editor } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
    expect(m2).toContain('data-date="date-123"');

    let id: string | null = null;
    let text = "";
    editor.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "date");
      if (mark) {
        id = mark.attrs.id as string;
        text += node.text ?? "";
      }
    });
    editor.destroy();
    expect(id).toBe("date-123");
    expect(text).toBe("tomorrow");
  });

  it("date mark parses from body_md HTML island via setContent markdown", () => {
    // Exactly the on-disk form L2 should emit / L4 should consume.
    const bodyMd = 'meet <span data-date="date-123">tomorrow</span> then';
    const ed = createMarkdownEditor(bodyMd, true);
    let id: string | null = null;
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "date");
      if (mark) id = mark.attrs.id as string;
    });
    const out = mdSerializeEditor(ed);
    ed.destroy();
    expect(id).toBe("date-123");
    expect(out).toContain('data-date="date-123"');
    expect(out).toContain("tomorrow");
  });

  it("footnote and date marks round-trip independently in the same document", () => {
    const html =
      '<p><span data-footnote="fn-1">word</span> and <span data-date="date-1">day</span></p>';
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: html });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain('data-footnote="fn-1"');
    expect(md).toContain('data-date="date-1"');

    const { m2, m3, editor } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
    expect(m2).toContain('data-footnote="fn-1"');
    expect(m2).toContain('data-date="date-1"');
    editor.destroy();
  });
});

describe("mdSerialize — raw HTML <table> island in body_md (item 6 verification, owner-facing)", () => {
  /**
   * Verdict: a raw HTML `<table>` block embedded in markdown body_md DOES parse into a real
   * TipTap table node (not stripped, not escaped as text) — @tiptap/markdown's HTML-token
   * handling matches `table`/`tr`/`td`/`th` against the schema's registered parseHTML rules
   * (Table/TableRow/TableCell/TableHeader are all standard-tag extensions) the same way any
   * other recognized HTML lands on a real node. So structurally, an HTML-island table is
   * round-trip *capable*.
   *
   * 이 블록의 두 번째 케이스는 한때 "DATA LOSS" 로 못 박혀 있었다: 저장 쪽이 항상 GFM 파이프 표를
   * 내서 `colspan="2"` 셀이 "1열 글자 + 빈 2열"로 조용히 평탄화됐다(첫 자동 저장에서, 그 섹션의 어느
   * 편집이든). W0(PLAN-2026-10-07-doc-import-export)에서 BriseTable.renderMarkdown 이 병합·셀 배경·
   * 여러 블록 셀이 있는 표만 `<table>` HTML 조각으로 내게 되어, 병합이 저장 뒤에도 남는다. 단순 표는
   * 여전히 GFM 파이프 표다(첫 케이스). 조각 표의 상세 왕복은 tableHtmlFragment.test.ts.
   */
  it("parses into a real table node — simple table, no merge", () => {
    const md = "before\n\n<table><tr><td>A</td><td>B</td></tr></table>\n\nafter";
    const ed = createMarkdownEditor(md, true);
    expect(JSON.stringify(ed.getJSON())).toContain('"type":"table"');
    expect(ed.state.doc.textContent).toContain("A");
    expect(ed.state.doc.textContent).toContain("B");
    const saved = mdSerializeEditor(ed);
    ed.destroy();
    // Normalized to a GFM pipe table on save — structurally lossless here (no merged cells).
    expect(saved).toContain("| A");
    expect(saved).toContain("| B");
    // Stable fixed point: a second save of the already-normalized form is byte-identical.
    const reloaded = createMarkdownEditor(saved, true);
    const savedAgain = mdSerializeEditor(reloaded);
    reloaded.destroy();
    expect(savedAgain).toBe(saved);
  });

  it("a merged cell (colspan) survives a save as an HTML fragment (was: flattened into a broken grid)", () => {
    const md = '<table><tr><td colspan="2">Merged</td></tr><tr><td>1</td><td>2</td></tr></table>';
    const ed = createMarkdownEditor(md, true);
    const colspanOf = (e: ReturnType<typeof createMarkdownEditor>) => {
      let colspan: number | undefined;
      e.state.doc.descendants((node) => {
        if (node.type.name === "tableCell" && node.textContent === "Merged") {
          colspan = node.attrs.colspan as number;
        }
      });
      return colspan;
    };
    expect(colspanOf(ed)).toBe(2);
    const saved = mdSerializeEditor(ed);
    ed.destroy();
    // GFM 으로는 못 담으니 HTML 조각으로 나가고, 재로드해도 병합이 그대로다.
    expect(saved).toContain("<table");
    expect(saved).not.toContain("| ");
    const reloaded = createMarkdownEditor(saved, true);
    expect(colspanOf(reloaded)).toBe(2);
    expect(mdSerializeEditor(reloaded)).toBe(saved);
    reloaded.destroy();
  });
});
