import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import {
  createMarkdownEditor,
  createMarkdownSchemaExtensions,
  mdSerializeEditor,
  mdSerializeHtml,
} from "../../lib/mdSerialize";
import { PREVIEW_EXTENSIONS } from "../../lib/editorExtensions";
import { setTableMarkdownExtensions } from "./tableColwidth";

// W0 (PLAN-2026-10-07-doc-import-export) — 병합·셀 배경·여러 블록 셀이 있는 표는 GFM 대신
// `<table>` HTML 조각으로 저장된다. 이 파일은 그 왕복과 "나머지 표는 예전 바이트 그대로"를 못 박는다.
// 조각 표가 나가는 조건은 tableColwidth.ts 의 cellNeedsHtml 이고, 읽기는 marked 의 HTML 블록 +
// @tiptap/markdown 의 parseHTML 경로라 손볼 것이 없다.

const reportFallback = vi.hoisted(() => vi.fn());
vi.mock("../../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallback(...a),
}));

beforeEach(() => reportFallback.mockClear());

/** 조사 §2.4 에서 실측한 병합 표 — 예전엔 `| AB | C | |` / `| 1 | 2 | 3 |` / `| 5 | 6 | |` 로 밀렸다. */
const MERGED_HTML =
  '<table><tr><th colspan="2">AB</th><th>C</th></tr><tr><td rowspan="2">1</td><td>2</td><td>3</td></tr><tr><td>5</td><td>6</td></tr></table>';
const MERGED_GRID = [
  ["AB", "AB", "C"],
  ["1", "2", "3"],
  ["1", "5", "6"],
];

function roundTrip(md: string): { out: string; json: JSONContent } {
  const ed = createMarkdownEditor(md, true);
  const out = mdSerializeEditor(ed);
  const json = ed.getJSON();
  ed.destroy();
  return { out, json };
}

/** 표의 격자 위치별 글자 — 병합 칸은 차지한 모든 위치에 같은 글자가 나온다. */
function gridText(ed: Editor): string[][] {
  let grid: string[][] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name !== "table") return true;
    const map = TableMap.get(node);
    grid = Array.from({ length: map.height }, (_, r) =>
      Array.from({ length: map.width }, (_, c) => node.nodeAt(map.map[r * map.width + c])?.textContent ?? "?"),
    );
    return false;
  });
  return grid;
}

function collect(node: JSONContent | undefined, type: string, out: JSONContent[] = []): JSONContent[] {
  if (!node) return out;
  if (node.type === type) out.push(node);
  node.content?.forEach((c) => collect(c, type, out));
  return out;
}

/** 값을 표시하는 모든 요소가 한 표 안에 든 문서 — 두 번 왕복 바이트 비교용. */
const RICH_HTML =
  "<h2>제목</h2><p>앞 <strong>문단</strong></p>" +
  '<table><tr><th style="background-color:#ffff00" colwidth="120" colspan="2">헤더</th><th>C</th></tr>' +
  '<tr><td rowspan="2"><ul><li>a</li><li>b</li></ul><p>p2</p></td><td><p style="text-align:center" data-brise-align="center">가운데</p></td><td>3</td></tr>' +
  "<tr><td><pre><code>x\n\ny</code></pre></td>" +
  '<td><p><img src="attachments/a.png" data-rel-path="attachments/a.png" style="width: 70%"> <span style="color: red">빨강</span> <span data-footnote="fn-1">각주</span> <span data-date="date-1">날짜</span></p></td></tr></table>' +
  "<p>뒤 문단</p>";

describe("조각 표 — 값이 제자리에 남는다", () => {
  it("병합 표는 HTML 조각으로 저장되고 재로드해도 같은 칸에 있다", () => {
    const md = mdSerializeHtml(MERGED_HTML);
    expect(md).toMatch(/^<table/);
    expect(md).not.toMatch(/^\|/m); // GFM 파이프 행이 한 줄도 없다
    const original = new Editor({ extensions: createMarkdownSchemaExtensions(), content: MERGED_HTML });
    const reloaded = createMarkdownEditor(md, true);
    expect(gridText(original)).toEqual(MERGED_GRID);
    expect(gridText(reloaded)).toEqual(MERGED_GRID);
    original.destroy();
    reloaded.destroy();
  });

  it("colspan·rowspan 값과 헤더 셀(th)이 그대로다", () => {
    const { json } = roundTrip(mdSerializeHtml(MERGED_HTML));
    const headers = collect(json, "tableHeader");
    const cells = collect(json, "tableCell");
    expect(headers.map((h) => h.attrs?.colspan)).toEqual([2, 1]);
    expect(cells[0].attrs?.rowspan).toBe(2);
    expect(cells).toHaveLength(5);
  });

  it("첫 열이 라벨 th 인 양식은 조각으로 남아 재로드해도 라벨 칸이 th 다(GFM 이면 td 로 접혔다)", () => {
    const md = mdSerializeHtml(
      "<table><tr><th><p>성명</p></th><td><p></p></td></tr><tr><th><p>주소</p></th><td><p>서울</p></td></tr></table>",
    );
    expect(md.startsWith("<table")).toBe(true);
    const { out, json } = roundTrip(md);
    expect(out).toBe(md);
    const rows = collect(json, "tableRow").map((r) => (r.content ?? []).map((c) => c.type));
    expect(rows).toEqual([["tableHeader", "tableCell"], ["tableHeader", "tableCell"]]);
  });

  it("첫 행 전체가 th 인 평범한 표는 GFM 그대로다", () => {
    const md = mdSerializeHtml("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(md.startsWith("| A")).toBe(true);
  });

  it("셀 안 목록과 여러 문단이 글자로 뭉개지지 않는다", () => {
    const md = mdSerializeHtml(
      "<table><tr><th>A</th><th>B</th></tr><tr><td><ul><li>a</li><li>b</li></ul><p>p2</p></td><td>x</td></tr></table>",
    );
    expect(md).not.toContain("<br>");
    expect(md).not.toContain("- a- b");
    const { json } = roundTrip(md);
    const cell = collect(json, "tableCell")[0];
    expect(cell.content?.map((b) => b.type)).toEqual(["bulletList", "paragraph"]);
    expect(collect(cell, "listItem")).toHaveLength(2);
    expect(cell.content?.[1].content?.[0].text).toBe("p2");
  });

  it("셀 안 문단 둘도 문단 둘로 돌아온다", () => {
    const { json } = roundTrip(
      mdSerializeHtml("<table><tr><th>A</th></tr><tr><td><p>첫째</p><p>둘째</p></td></tr></table>"),
    );
    const cell = collect(json, "tableCell")[0];
    expect(cell.content?.map((b) => b.content?.[0].text)).toEqual(["첫째", "둘째"]);
  });

  it("셀 안 문단의 가운데 정렬이 재로드 뒤에도 남는다(GFM 칸에서는 벗겨졌다)", () => {
    const md = mdSerializeHtml(
      '<table><tr><th>A</th></tr><tr><td><p style="text-align:center" data-brise-align="center">x</p></td></tr></table>',
    );
    expect(md).toMatch(/^<table/);
    const { json } = roundTrip(md);
    expect(collect(json, "tableCell")[0].content?.[0].attrs?.textAlign).toBe("center");
  });

  it("코드 블록 셀의 빈 줄이 표를 둘로 쪼개지 않는다", () => {
    const md = mdSerializeHtml(
      "<table><tr><th>A</th></tr><tr><td><pre><code>x\n\n\ny</code></pre></td></tr></table><p>뒤</p>",
    );
    expect(md).not.toMatch(/\n[ \t]*\n[^<]*<\/code>/); // 표 조각 안에는 빈 줄이 없다
    const { json } = roundTrip(md);
    expect(collect(json, "table")).toHaveLength(1);
    expect(collect(json, "codeBlock")[0].content?.[0].text).toBe("x\n\n\ny");
  });
});

describe("조각 표 — 셀 배경", () => {
  it("셀 배경이 style 로 저장되고 재로드해도 남는다 (th·td 모두)", () => {
    const md = mdSerializeHtml(
      '<table><tr><th style="background-color: #ffff00">A</th><th>B</th></tr><tr><td style="background-color: rgb(204, 229, 255)">1</td><td>2</td></tr></table>',
    );
    expect(md).toContain("background-color: rgb(255, 255, 0)");
    expect(md).toContain("background-color: rgb(204, 229, 255)");
    const { json } = roundTrip(md);
    expect(collect(json, "tableHeader")[0].attrs?.backgroundColor).toBe("rgb(255, 255, 0)");
    expect(collect(json, "tableHeader")[1].attrs?.backgroundColor).toBeNull();
    expect(collect(json, "tableCell")[0].attrs?.backgroundColor).toBe("rgb(204, 229, 255)");
  });

  it("Word·한글 붙여넣기에 흔한 bgcolor 속성도 배경으로 읽고, 첫 저장부터 정규화된 같은 문자열이다", () => {
    const first = mdSerializeHtml('<table><tr><th>A</th></tr><tr><td bgcolor="#FFFF00">1</td></tr></table>');
    expect(first).toContain("background-color: rgb(255, 255, 0)");
    const { out, json } = roundTrip(first);
    expect(out).toBe(first);
    expect(collect(json, "tableCell")[0].attrs?.backgroundColor).toBe("rgb(255, 255, 0)");
  });

  it("색이 아닌 값은 style 로 새지 않고, 배경 하나만으로는 조각이 되지 않는다(GFM 그대로)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { backgroundColor: "red; position: fixed; background-image: url(x)" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { backgroundColor: "transparent" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: doc });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toBe("| A   |\n| --- |\n| 1   |");
  });
});

describe("조각 표 — 열 너비·셀 안 서식", () => {
  it("조각 안에서도 colwidth 가 셀 속성으로 보존되고 {colwidth=…} 마커 줄은 쓰지 않는다", () => {
    const md = mdSerializeHtml(
      '<table><tr><th colspan="2" colwidth="120,200">AB</th><th colwidth="90">C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    );
    expect(md).not.toContain("{colwidth");
    expect(md).toContain('colwidth="120,200"');
    const { json } = roundTrip(md);
    const headers = collect(json, "tableHeader");
    expect(headers[0].attrs?.colwidth).toEqual([120, 200]);
    expect(headers[1].attrs?.colwidth).toEqual([90]);
    expect(collect(json, "tableCell").every((c) => c.attrs?.colwidth == null)).toBe(true);
  });

  it("셀 안 이미지(너비·data-rel-path)·글자색 span·각주·날짜 span 이 보존된다", () => {
    const { json } = roundTrip(mdSerializeHtml(RICH_HTML));
    const image = collect(json, "image")[0];
    expect(image.attrs?.width).toBe("70%");
    expect(image.attrs?.relPath).toBe("attachments/a.png");
    const marks = collect(json, "text").flatMap((t) => t.marks ?? []);
    expect(marks.find((m) => m.type === "textStyle")?.attrs?.color).toBe("red");
    expect(marks.find((m) => m.type === "footnote")?.attrs?.id).toBe("fn-1");
    expect(marks.find((m) => m.type === "date")?.attrs?.id).toBe("date-1");
  });
});

describe("조각 표 — 첨부 이미지는 이식 가능한 경로로 저장된다", () => {
  /** 병합 칸 하나 + 이미지 한 장이 든 표 JSON — `src` 는 호출부가 정한다. */
  function tableWithImage(imageAttrs: Record<string, unknown>): JSONContent {
    return {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2 },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "image", attrs: imageAttrs }] }],
                },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
              ],
            },
          ],
        },
      ],
    };
  }

  it("막 넣은 첨부 이미지(src 없음, relPath 만)가 재로드 뒤에도 남는다", () => {
    // insertImageAtPos·toolbar 가 넣는 모양 — ImageNodeView 가 렌더 때만 relPath 를 풀어 src 는 null 이다.
    const ed = new Editor({
      extensions: createMarkdownSchemaExtensions(),
      content: tableWithImage({ alt: "사진", relPath: "attachments/a.png", width: "40%" }),
    });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toMatch(/^<table/);
    expect(md).toContain('src="attachments/a.png"'); // src 없는 <img> 는 재로드 때 img[src] 규칙에 안 잡힌다
    const { out, json } = roundTrip(md);
    const image = collect(json, "image")[0];
    expect(image.attrs?.relPath).toBe("attachments/a.png");
    expect(image.attrs?.width).toBe("40%");
    expect(out).toBe(md);
  });

  it("세션 한정 asset URL 이 src 에 있어도 저장 본문에는 relPath 만 나간다", () => {
    const ed = new Editor({
      extensions: createMarkdownSchemaExtensions(),
      content: tableWithImage({
        src: "http://asset.localhost/C%3A/Users/me/attachments/a.png",
        relPath: "attachments/a.png",
        width: "40%",
      }),
    });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).not.toContain("asset.localhost");
    expect(md).toContain('data-rel-path="attachments/a.png"');
  });

  it("원격 http(s) 이미지는 src 가 그대로다", () => {
    const { json } = roundTrip(
      mdSerializeHtml(
        '<table><tr><th colspan="2">A</th></tr><tr><td><img src="https://example.com/p.png"></td><td>x</td></tr></table>',
      ),
    );
    const image = collect(json, "image")[0];
    expect(image.attrs?.src).toBe("https://example.com/p.png");
    expect(image.attrs?.relPath).toBeNull();
  });
});

describe("조각 표 — 왕복 안정성", () => {
  it("직렬화 → 파싱 → 직렬화를 두 번 돌려도 바이트가 같다", () => {
    const first = mdSerializeHtml(RICH_HTML);
    const second = roundTrip(first).out;
    const third = roundTrip(second).out;
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("두 번째 왕복의 문서 JSON 도 첫 번째와 같다", () => {
    const first = mdSerializeHtml(RICH_HTML);
    const a = roundTrip(first).json;
    const b = roundTrip(roundTrip(first).out).json;
    expect(b).toEqual(a);
  });

  it("앞뒤 마크다운과 섞여도 블록이 그대로고 표 하나만 조각이다", () => {
    const md = [
      "# 제목",
      "",
      "앞 문단 **굵게**",
      "",
      mdSerializeHtml(MERGED_HTML),
      "",
      "- 목록 1",
      "- 목록 2",
      "",
      "| X | Y |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "뒤 문단",
    ].join("\n");
    const { out, json } = roundTrip(md);
    expect(json.content?.map((n) => n.type)).toEqual(["heading", "paragraph", "table", "bulletList", "table", "paragraph"]);
    expect(out.match(/<table/g)).toHaveLength(1); // 병합 표만 조각 — 단순 표는 GFM 으로 남는다
    expect(out).toContain("| X   | Y   |");
    expect(out).toContain("앞 문단 **굵게**");
    expect(out).toContain("뒤 문단");
    expect(roundTrip(out).out).toBe(out);
  });

  it("조각 표 둘이 붙어 있어도(빈 줄 하나로 구분) 각각 살아남는다", () => {
    const one = mdSerializeHtml(MERGED_HTML);
    const { json } = roundTrip(`${one}\n\n${one}`);
    expect(collect(json, "table")).toHaveLength(2);
  });
});

describe("단순 표 — 출력은 예전과 바이트 단위로 같다", () => {
  it("병합·배경·여러 블록이 없는 표는 GFM 그대로다", () => {
    const md = mdSerializeHtml("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(md).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("colwidth 만 있는 표는 {colwidth=…} 마커 줄을 단 GFM 그대로다", () => {
    const md = mdSerializeHtml(
      '<table><tr><th colwidth="120">A</th><th>B</th><th colwidth="200">C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    );
    expect(md).toBe("| A   | B   | C   |\n| --- | --- | --- |\n| 1   | 2   | 3   |\n{colwidth=120,,200}");
  });

  it("셀 정렬(align)만 있는 표도 GFM 정렬 행 그대로다", () => {
    const md = mdSerializeHtml(
      '<table><tr><th style="text-align:center">A</th><th>B</th></tr><tr><td style="text-align:center">1</td><td>2</td></tr></table>',
    );
    expect(md).toBe("| A   | B   |\n| :---: | --- |\n| 1   | 2   |");
  });
});

describe("조각 표 — 폴백과 라이브 스키마", () => {
  it("조각을 못 만들면 GFM 으로 물러나고 진단에 남긴다", () => {
    setTableMarkdownExtensions(() => {
      throw new Error("boom");
    });
    try {
      const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: MERGED_HTML });
      const md = mdSerializeEditor(ed);
      ed.destroy();
      expect(md).toContain("| AB");
      expect(md).not.toContain("<table");
      expect(reportFallback).toHaveBeenCalledWith("md-serialize", "table_html_failed", "Error");
    } finally {
      setTableMarkdownExtensions(createMarkdownSchemaExtensions);
    }
  });

  it("라이브 에디터 스키마(PREVIEW_EXTENSIONS)로 저장해도 조각과 셀 배경이 살아 있다", () => {
    const ed = new Editor({
      extensions: PREVIEW_EXTENSIONS,
      content:
        '<table><tr><th colspan="2" style="background-color:#ffff00">AB</th></tr><tr><td>1</td><td><p>a</p><p>b</p></td></tr></table>',
    });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toMatch(/^<table/);
    expect(md).not.toContain("tableWrapper"); // 라이브 DOM 래퍼가 저장 본문에 새지 않는다
    expect(md).toContain("background-color: rgb(255, 255, 0)");
    const reloaded = new Editor({ extensions: PREVIEW_EXTENSIONS });
    reloaded.commands.setContent(md, { contentType: "markdown", emitUpdate: false });
    expect(mdSerializeEditor(reloaded)).toBe(md);
    reloaded.destroy();
  });

  it("셀 배경 속성은 공용 스키마 빌더 하나에만 등록된다 (라이브·헤드리스가 갈라지지 않는다)", () => {
    const src = readFileSync("src/lib/mdSerialize.ts", "utf8");
    const builder = src.slice(
      src.indexOf("export function markdownSchemaExtensions("),
      src.indexOf("export function createMarkdownSchemaExtensions("),
    );
    expect(builder).toMatch(/\bBriseTableCell\b/);
    expect(builder).toMatch(/\bBriseTableHeader\b/);
    // 맨 TableCell/TableHeader 가 다시 들어오면 backgroundColor 가 저장 때 조용히 벗겨진다.
    expect(builder).not.toMatch(/\bTableCell,/);
    expect(builder).not.toMatch(/\bTableHeader,/);
  });
});

// ── 목록 항목 안 조각 표 (W0 검증에서 확인된 결함: 저장 바이트가 두 모양을 오가고 문서가 스키마 위반이 됐다) ──
// 원인은 조각이 앞 문단 줄에 바로 붙어 나가던 것(GFM 경로는 앞뒤에 개행이 있다)과, 목록 항목 안에서 줄마다
// 붙는 들여쓰기·marked 의 탭 풀기가 `<pre>` 안 코드 줄에 닿던 것이다.
describe("조각 표 — 목록 항목 안", () => {
  const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
  /** 병합 헤더 하나 + 본문 셀 둘. `code` 가 있으면 첫 본문 셀이 그 글자를 담은 코드 블록이다. */
  function mergedTable(code?: string): JSONContent {
    return {
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [para("H")] }] },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [code ? { type: "codeBlock", content: [{ type: "text", text: code }] } : para("c")],
            },
            { type: "tableCell", content: [para("x")] },
          ],
        },
      ],
    };
  }
  const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
  const bullet = (...items: JSONContent[]): JSONContent => ({ type: "bulletList", content: items });
  const ordered = (start: number, ...items: JSONContent[]): JSONContent => ({
    type: "orderedList",
    attrs: { start },
    content: items,
  });
  const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
  const types = (node: JSONContent | undefined): string[] => node?.content?.map((c) => c.type ?? "") ?? [];

  function save(doc: JSONContent, extensions = createMarkdownSchemaExtensions()): string {
    const ed = new Editor({ extensions, content: doc });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    return md;
  }

  /** md 를 재로드(스키마 검증 포함)해 다시 저장하기를 `times` 번 — 매번 문서가 유효하고 바이트가 같아야 한다. */
  function expectFixedPoint(md: string, times = 3): JSONContent {
    let json: JSONContent = {};
    for (let i = 0; i < times; i++) {
      const ed = createMarkdownEditor(md, true);
      expect(() => ed.state.doc.check()).not.toThrow();
      json = ed.getJSON();
      const next = mdSerializeEditor(ed);
      ed.destroy();
      expect(next).toBe(md);
    }
    return json;
  }

  const list = (json: JSONContent) => json.content?.[0];
  const firstItem = (json: JSONContent) => list(json)?.content?.[0];

  it("불릿 항목 [문단, 표, 문단] — 뒤 문단이 표에 삼켜지지 않고 바이트가 고정점이다", () => {
    const md = save(docOf(bullet(item(para("pre"), mergedTable(), para("after")))));
    const json = expectFixedPoint(md);
    expect(types(firstItem(json))).toEqual(["paragraph", "table", "paragraph"]);
    expect(firstItem(json)?.content?.[2].content?.[0].text).toBe("after");
  });

  it("불릿 항목 [문단, 표] — 표가 문단 줄에 붙어 나가지 않는다", () => {
    const md = save(docOf(bullet(item(para("pre"), mergedTable()))));
    expect(md).toMatch(/^- pre\n\s*\n\s+<table/); // 문단 줄과 표 사이에 빈 줄이 있다(GFM 경로와 같다)
    expect(types(firstItem(expectFixedPoint(md)))).toEqual(["paragraph", "table"]);
  });

  it("불릿 항목 [문단, 표, 하위 목록] — 하위 목록이 표 뒤에 그대로 있다", () => {
    const md = save(docOf(bullet(item(para("pre"), mergedTable(), bullet(item(para("sub")))))));
    const json = expectFixedPoint(md);
    expect(types(firstItem(json))).toEqual(["paragraph", "table", "bulletList"]);
  });

  it("중첩 목록 안 [문단, 표, 문단]", () => {
    const md = save(docOf(bullet(item(para("pre"), bullet(item(para("in"), mergedTable(), para("after")))))));
    const json = expectFixedPoint(md);
    const inner = firstItem(json)?.content?.[1]?.content?.[0];
    expect(types(inner)).toEqual(["paragraph", "table", "paragraph"]);
  });

  it("항목 여럿 — 표가 든 항목 다음 항목이 그대로 다음 항목이다", () => {
    const md = save(docOf(bullet(item(para("a"), mergedTable()), item(para("b")))));
    const json = expectFixedPoint(md);
    expect(list(json)?.content).toHaveLength(2);
    expect(list(json)?.content?.[1].content?.[0].content?.[0].text).toBe("b");
  });

  it("표 둘이 한 항목에 이어져도 둘 다 표다", () => {
    const md = save(docOf(bullet(item(para("pre"), mergedTable(), mergedTable()))));
    expect(types(firstItem(expectFixedPoint(md)))).toEqual(["paragraph", "table", "table"]);
  });

  it("순서 있는 목록 항목 [문단, 표] — 표가 문단 안으로 들어가지 않는다 (스키마 위반이던 케이스)", () => {
    const md = save(docOf(ordered(1, item(para("pre"), mergedTable()))));
    const json = expectFixedPoint(md);
    expect(json.content?.[0].type).toBe("orderedList");
    expect(types(firstItem(json))).toEqual(["paragraph", "table"]);
    expect(firstItem(json)?.content?.[0].content?.[0].text).toBe("pre"); // 문단 글자에 줄바꿈이 새지 않는다
  });

  it("순서 있는 목록 항목 [문단, 표, 문단] — 시작 번호 10 도 같다", () => {
    const md = save(docOf(ordered(10, item(para("pre"), mergedTable(), para("after")))));
    expect(md).toMatch(/^10\. pre/);
    const json = expectFixedPoint(md);
    expect(list(json)?.attrs?.start).toBe(10);
    expect(types(firstItem(json))).toEqual(["paragraph", "table", "paragraph"]);
  });

  it("표가 항목 첫 자식인 문서(스키마상 불가능한 입력)도 한 번 로드되면 유효하고 그 뒤로 고정점이다", () => {
    const md = save(docOf(bullet(item(mergedTable(), para("after")))));
    // 첫 저장은 입력이 이미 위반이라 고정점이 아닐 수 있다 — 재로드가 유효 문서를 만들고 그 뒤로 안 변하면 된다.
    const ed = createMarkdownEditor(md, true);
    expect(() => ed.state.doc.check()).not.toThrow();
    const settled = mdSerializeEditor(ed);
    ed.destroy();
    const json = expectFixedPoint(settled);
    expect(collect(json, "table")).toHaveLength(1);
  });

  it("라이브 스키마(PREVIEW_EXTENSIONS)로도 순서 목록 안 표가 유효하고 고정점이다", () => {
    const md = save(docOf(ordered(1, item(para("pre"), mergedTable(), para("after")))), PREVIEW_EXTENSIONS);
    const ed = new Editor({ extensions: PREVIEW_EXTENSIONS });
    ed.commands.setContent(md, { contentType: "markdown", emitUpdate: false });
    expect(() => ed.state.doc.check()).not.toThrow();
    expect(mdSerializeEditor(ed)).toBe(md);
    expect(types(firstItem(ed.getJSON()))).toEqual(["paragraph", "table", "paragraph"]);
    ed.destroy();
  });

  describe("코드 셀 — 줄·탭이 목록 들여쓰기에 오염되지 않는다", () => {
    const codeOf = (json: JSONContent): string | undefined => collect(json, "codeBlock")[0]?.content?.[0].text;

    it.each(["a\n---\nb", "a\n===\nb"])("불릿 항목 안에서 코드 줄이 %j 여도 표가 제목·글자로 부서지지 않는다", (code) => {
      const md = save(docOf(bullet(item(para("pre"), mergedTable(code)))));
      const json = expectFixedPoint(md);
      expect(types(firstItem(json))).toEqual(["paragraph", "table"]);
      expect(codeOf(json)).toBe(code);
    });

    it("순서 목록 안에서도 '---' 코드가 그대로다", () => {
      const md = save(docOf(ordered(1, item(para("pre"), mergedTable("a\n---\nb")))));
      expect(codeOf(expectFixedPoint(md))).toBe("a\n---\nb");
    });

    it("표가 항목 첫 자식이고 코드 줄이 '---' 여도 가로줄로 목록이 끊기지 않고 코드가 남는다", () => {
      const md = save(docOf(bullet(item(mergedTable("a\n---\nb")))));
      const ed = createMarkdownEditor(md, true);
      expect(() => ed.state.doc.check()).not.toThrow();
      const json = ed.getJSON();
      ed.destroy();
      expect(collect(json, "horizontalRule")).toHaveLength(0);
      expect(codeOf(json)).toBe("a\n---\nb");
    });

    it("목록 안 코드의 탭이 공백 4칸으로 바뀌지 않는다", () => {
      const md = save(docOf(bullet(item(para("pre"), mergedTable("a\n\tb")))));
      expect(codeOf(expectFixedPoint(md))).toBe("a\n\tb");
    });

    it("최상위 코드 셀의 탭·개행·빈 줄도 그대로다", () => {
      const code = "a\n\tb\n\nc";
      const md = save(docOf(mergedTable(code)));
      expect(md.split("\n")).toHaveLength(1); // 조각은 한 줄이다
      expect(codeOf(expectFixedPoint(md))).toBe(code);
    });
  });

  describe("목록 밖은 예전 바이트 그대로", () => {
    it("최상위에서 조각 표 둘이 붙어도 빈 문단이 불어나지 않는다", () => {
      const md = save(docOf(mergedTable(), mergedTable()));
      expect(md).not.toMatch(/<\/table>\n\n\n/);
      expect(types(expectFixedPoint(md))).toEqual(["table", "table"]);
    });

    it("인용 안에서 조각 표 둘이 붙어도 표 둘이다", () => {
      const md = save(docOf({ type: "blockquote", content: [mergedTable(), mergedTable()] }));
      expect(types(expectFixedPoint(md).content?.[0])).toEqual(["table", "table"]);
    });

    it("체크리스트 항목 안 [문단, 표, 문단]도 고정점이다", () => {
      const md = save(
        docOf({
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: false }, content: [para("pre"), mergedTable(), para("after")] }],
        }),
      );
      expect(types(firstItem(expectFixedPoint(md)))).toEqual(["paragraph", "table", "paragraph"]);
    });

    it("최상위 [문단, 표, 문단] 의 저장 형태는 표 앞뒤로 빈 줄 하나다", () => {
      const md = save(docOf(para("a"), mergedTable(), para("b")));
      expect(md).toMatch(/^a\n\n<table[^\n]*<\/table>\n\nb$/);
    });
  });
});
