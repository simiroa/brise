import { describe, it, expect } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { PREVIEW_EXTENSIONS } from "../../lib/editorExtensions";
import {
  createMarkdownEditor,
  createMarkdownSchemaExtensions,
  mdSerializeEditor,
  mdSerializeHtml,
  MARKDOWN_SET_CONTENT_OPTIONS,
} from "../../lib/mdSerialize";
import { createMobileSchemaExtensions } from "../../mobile/mobileEditorExtensions";
import { canEditBodyOnMobile } from "../../mobile/mobileEditorSupport";
import { TEXT_ALIGNS } from "./paragraphFormat";

/** 마크다운 → 에디터 → 마크다운을 두 번 돌린다. 합격선은 m2 === m3(두 번째 왕복부터 바이트 동일). */
function doubleRoundTrip(md: string): { m1: string; m2: string; m3: string } {
  const e1 = createMarkdownEditor(md, true);
  const m1 = mdSerializeEditor(e1);
  e1.destroy();
  const e2 = createMarkdownEditor(m1, true);
  const m2 = mdSerializeEditor(e2);
  e2.destroy();
  const e3 = createMarkdownEditor(m2, true);
  const m3 = mdSerializeEditor(e3);
  e3.destroy();
  return { m1, m2, m3 };
}

function blocks(md: string): Array<[string, unknown, unknown]> {
  const ed = createMarkdownEditor(md, true);
  const out = (ed.getJSON().content ?? []).map((node): [string, unknown, unknown] => [
    node.type ?? "",
    node.attrs?.textAlign,
    node.attrs?.indent,
  ]);
  ed.destroy();
  return out;
}

describe("paragraphFormat — justify(양쪽 정렬)", () => {
  it("TEXT_ALIGNS 에 justify 가 들어 있다", () => {
    expect(TEXT_ALIGNS).toEqual(["left", "center", "right", "justify"]);
  });

  it("붙여넣은 <p style=text-align: justify> 가 저장·재로드 뒤에도 justify 로 남는다", () => {
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: "" });
    // ProseMirror 기본 붙여넣기 경로 — 스키마의 parseHTML 규칙을 그대로 탄다.
    // 첫 문단은 커서가 있던 빈 문단에 합쳐지므로(PM 의 열린 슬라이스 규칙 — center 도 같다) 그 문단의 속성을
    // 유지한다. 정렬이 살아남는지는 그 뒤 문단들로 본다.
    ed.view.pasteHTML(
      '<p style="text-align: justify">하나</p><p style="text-align: justify">둘</p><p style="text-align: justify">셋</p>',
      new Event("paste") as ClipboardEvent,
    );
    const pasted: unknown[][] = [];
    ed.state.doc.forEach((node) => pasted.push([node.attrs.textAlign, node.textContent]));
    expect(pasted.slice(1)).toEqual([
      ["justify", "둘"],
      ["justify", "셋"],
    ]);
    const md = mdSerializeEditor(ed);
    ed.destroy();

    expect(md).toContain('data-brise-align="justify"');
    expect(md).toContain("text-align: justify");
    expect(blocks(md).slice(1)).toEqual([
      ["paragraph", "justify", 0],
      ["paragraph", "justify", 0],
    ]);
  });

  it("HTML 본문(content 로 넣은 style 만 있는 <p>)도 justify 를 읽고, 두 번 왕복하면 바이트가 같다", () => {
    const md = mdSerializeHtml('<p style="text-align: justify">한글 문서의 기본 정렬</p>');
    expect(md).toContain('data-brise-align="justify"');
    expect(blocks(md)).toEqual([["paragraph", "justify", 0]]);

    const { m1, m2, m3 } = doubleRoundTrip(md);
    expect(m1).toBe(md);
    expect(m2).toBe(m3);
    expect(blocks(m3)).toEqual([["paragraph", "justify", 0]]);
  });

  it("제목에도 동작한다(붙여넣기·커맨드·왕복)", () => {
    const fromHtml = mdSerializeHtml('<h2 style="text-align: justify">제목</h2>');
    expect(fromHtml).toContain('data-brise-align="justify"');
    expect(blocks(fromHtml)).toEqual([["heading", "justify", 0]]);
    const { m2, m3 } = doubleRoundTrip(fromHtml);
    expect(m2).toBe(m3);
    expect(blocks(m3)).toEqual([["heading", "justify", 0]]);

    const ed = createMarkdownEditor("## 제목", true);
    expect(ed.commands.setTextAlign("justify")).toBe(true);
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(blocks(md)).toEqual([["heading", "justify", 0]]);
  });

  it("들여쓰기와 함께 있어도 둘 다 남고, 인라인 마크도 살아남는다", () => {
    const ed = createMarkdownEditor("**굵게** 그리고 [링크](https://example.com)", true);
    expect(ed.commands.setTextAlign("justify")).toBe(true);
    expect(ed.commands.indentParagraph()).toBe(true);
    const md = mdSerializeEditor(ed);
    ed.destroy();

    expect(md).toContain('data-brise-align="justify"');
    expect(md).toContain('data-brise-indent="1"');
    expect(blocks(md)).toEqual([["paragraph", "justify", 1]]);
    const json = JSON.stringify(createMarkdownEditor(md, true).getJSON());
    expect(json).toContain('"type":"bold"');
    expect(json).toContain('"type":"link"');
    const { m2, m3 } = doubleRoundTrip(md);
    expect(m2).toBe(m3);
  });

  it("justify → left 로 되돌리면 섬이 풀려 평범한 마크다운이 된다", () => {
    const ed = createMarkdownEditor("그냥 문단", true);
    expect(ed.commands.setTextAlign("justify")).toBe(true);
    expect(mdSerializeEditor(ed)).toContain("data-brise-align");
    expect(ed.commands.setTextAlign("left")).toBe(true);
    expect(mdSerializeEditor(ed)).toBe("그냥 문단");
    ed.destroy();
  });

  it("모르는 정렬값은 거부하고, 모르는 text-align 은 left 로 읽는다", () => {
    const ed = createMarkdownEditor("문단", true);
    expect(ed.commands.setTextAlign("start" as never)).toBe(false);
    ed.destroy();
    expect(blocks(mdSerializeHtml('<p style="text-align: start">x</p>'))).toEqual([["paragraph", "left", 0]]);
    expect(blocks(mdSerializeHtml('<p style="text-align: justify-all">x</p>'))).toEqual([["paragraph", "left", 0]]);
  });

  it("목록 안의 문단에는 정렬이 걸리지 않는다(기존 규칙 유지)", () => {
    const ed = createMarkdownEditor("- 항목", true);
    ed.commands.setTextSelection(3);
    expect(ed.commands.setTextAlign("justify")).toBe(false);
    ed.destroy();
  });
});

describe("paragraphFormat — justify 가 폰 스키마(BriseParagraph 공유)에서도 왕복된다", () => {
  function mobileRoundTrip(md: string): string {
    const ed = new Editor({ extensions: createMobileSchemaExtensions(), content: "" });
    try {
      ed.commands.setContent(md, MARKDOWN_SET_CONTENT_OPTIONS);
      return mdSerializeEditor(ed);
    } finally {
      ed.destroy();
    }
  }

  it("justify 문단·제목 조각이 폰에서 열었다 저장해도 같은 바이트로 남는다", () => {
    const desktop = mdSerializeHtml('<p style="text-align: justify">본문</p>\n<h2 style="text-align: justify">제목</h2>');
    expect(desktop).toContain('data-brise-align="justify"');
    expect(canEditBodyOnMobile(desktop)).toBe(true); // 읽기 전용으로 막히지 않는다

    const viaMobile = mobileRoundTrip(desktop);
    expect(viaMobile).toBe(desktop);
    expect(mobileRoundTrip(viaMobile)).toBe(viaMobile);
    expect(blocks(viaMobile)).toEqual([
      ["paragraph", "justify", 0],
      ["heading", "justify", 0],
    ]);
  });
});

// W0 검증 결함: justify 가 추가되면서 한글·Word·웹 문서의 목록 붙여넣기(`<li><p style="text-align: justify">`)가 그대로
// 목록 안 HTML 섬으로 저장됐다 — 순서 목록은 첫 재로드에 정렬이 사라지며 바이트가 바뀌고, 하위 목록이 있으면 구조가 깨졌다.
// 정렬 UI(메뉴·커맨드)는 최상위 블록에만 걸리므로 파서도 목록 항목·인용 안에서는 정렬·들여쓰기를 읽지 않는다.
describe("paragraphFormat — 목록·인용 안 붙여넣기는 정렬을 들이지 않는다", () => {
  function paste(html: string, extensions = createMarkdownSchemaExtensions()): { md: string; json: JSONContent } {
    // 빈 문서에 `<p>앞</p>` + 붙여넣을 HTML 을 붙여넣는다 — 첫 문단은 빈 문단에 합쳐지므로(PM 열린 슬라이스) 앞 문단이 기준선이다.
    const ed = new Editor({ extensions, content: "" });
    ed.view.pasteHTML(`<p>앞</p>${html}`, new Event("paste") as ClipboardEvent);
    expect(() => ed.state.doc.check()).not.toThrow();
    const out = { md: mdSerializeEditor(ed), json: ed.getJSON() as JSONContent };
    ed.destroy();
    return out;
  }

  /** md 를 세 번 재로드·저장해도 바이트가 같고(문서가 흔들리지 않고) 매번 스키마가 유효하다. */
  function expectFixedPoint(md: string): void {
    let current = md;
    for (let i = 0; i < 3; i++) {
      const ed = createMarkdownEditor(current, true);
      expect(() => ed.state.doc.check()).not.toThrow();
      const next = mdSerializeEditor(ed);
      ed.destroy();
      expect(next).toBe(current);
      current = next;
    }
  }

  const textBlocks = (json: JSONContent): string[] => {
    const out: string[] = [];
    const walk = (n: JSONContent) => {
      if (n.type === "paragraph" || n.type === "heading") out.push((n.content ?? []).map((c) => c.text ?? "").join(""));
      else n.content?.forEach(walk);
    };
    walk(json);
    return out;
  };

  const NESTED_JUSTIFY =
    '<ul><li><p style="text-align:justify">상위</p><ul><li><p style="text-align:justify">하위</p></li></ul></li></ul>';

  for (const [label, extensions] of [
    ["헤드리스 스키마", createMarkdownSchemaExtensions()],
    ["라이브 스키마(PREVIEW_EXTENSIONS)", PREVIEW_EXTENSIONS],
  ] as const) {
    it(`${label}: justify 중첩 목록을 붙여넣어도 평범한 마크다운 목록으로 저장되고 구조가 그대로다`, () => {
      const { md, json } = paste(NESTED_JUSTIFY, extensions);
      expect(md).toBe("앞\n\n- 상위\n  - 하위");
      expect(md).not.toContain("data-brise-align");
      expect(textBlocks(json).filter(Boolean)).toEqual(["앞", "상위", "하위"]); // 끝의 빈 문단은 에디터의 trailing node
      expectFixedPoint(md);
    });
  }

  it("순서 있는 목록의 justify 문단도 섬 없이 저장된다 (재로드 때 정렬이 사라지며 바이트가 바뀌던 케이스)", () => {
    const { md } = paste('<ol><li><p style="text-align:justify">하나</p></li><li><p style="text-align:justify">둘</p></li></ol>');
    expect(md).toBe("앞\n\n1. 하나\n2. 둘");
    expectFixedPoint(md);
  });

  it("center·right 도 같다 — 목록 항목 안 문단에는 정렬 속성이 남지 않는다", () => {
    for (const align of ["center", "right", "justify"]) {
      const { md, json } = paste(`<ul><li><p style="text-align:${align}">항목</p></li></ul>`);
      expect(md).toBe("앞\n\n- 항목");
      const item = json.content?.[1]?.content?.[0]?.content?.[0];
      expect(item?.attrs?.textAlign).toBe("left");
    }
  });

  it("목록 안 제목과 들여쓰기(data-brise-indent)도 읽지 않는다", () => {
    const { md } = paste(
      '<ul><li><h3 style="text-align:justify">제목</h3><p data-brise-indent="2" style="margin-left:4em">본문</p></li></ul>',
    );
    expect(md).not.toContain("data-brise-");
    expectFixedPoint(md);
  });

  it("인용 안 문단의 정렬도 읽지 않는다", () => {
    const { md } = paste('<blockquote><p style="text-align:justify">인용</p></blockquote>');
    expect(md).toBe("앞\n\n> 인용");
    expectFixedPoint(md);
  });

  it("HTML 본문(content 로 넣은 <ul><li><p style>)도 같다", () => {
    expect(mdSerializeHtml('<ul><li><p style="text-align: justify">항목</p></li></ul>')).toBe("- 항목");
  });

  it("목록 밖 최상위 justify 와 표 셀 안 정렬은 그대로 읽는다", () => {
    expect(blocks(mdSerializeHtml('<p style="text-align: justify">본문</p>'))).toEqual([["paragraph", "justify", 0]]);
    const cell = mdSerializeHtml(
      '<table><tr><th>A</th></tr><tr><td><p style="text-align:center" data-brise-align="center">x</p></td></tr></table>',
    );
    expect(cell).toContain('data-brise-align="center"');
  });

  it("목록 항목·인용 안에 든 표의 셀 문단 정렬은 살아남는다(가장 가까운 컨테이너가 셀이다)", () => {
    const table =
      '<table><tr><th colspan="2">H</th></tr><tr><td><p style="text-align:center" data-brise-align="center">x</p></td><td>y</td></tr></table>';
    for (const wrapped of [`<ul><li><p>a</p>${table}</li></ul>`, `<ol><li><p>a</p>${table}</li></ol>`, `<blockquote>${table}</blockquote>`]) {
      const md = mdSerializeHtml(wrapped);
      expect(md).toContain('data-brise-align="center"');
      const ed = createMarkdownEditor(md, true);
      expect(() => ed.state.doc.check()).not.toThrow();
      const aligns: unknown[] = [];
      ed.state.doc.descendants((n) => {
        if (n.type.name === "paragraph" && n.textContent === "x") aligns.push(n.attrs.textAlign);
      });
      ed.destroy();
      expect(aligns).toEqual(["center"]);
    }
  });

  it("셀 안 목록의 문단은 목록 항목이라 정렬을 읽지 않는다", () => {
    const md = mdSerializeHtml(
      '<table><tr><th colspan="2">H</th></tr><tr><td><ul><li><p style="text-align:justify">항목</p></li></ul></td><td>y</td></tr></table>',
    );
    expect(md).toMatch(/^<table/);
    expect(md).not.toContain("data-brise-align");
  });
});
