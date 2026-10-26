import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import {
  createMarkdownEditor,
  createMarkdownSchemaExtensions,
  mdSerializeEditor,
} from "../../lib/mdSerialize";

// 표 열 너비 드래그(오너 2026-09-21) — 드래그 자체는 jsdom 으로 못 보니, 여기서는 (a) 왕복
// 보존(body_md 에 {colwidth=…} 한 줄로 남는지·다시 읽으면 복원되는지·기존 표는 안 바뀌는지)과
// (b) resizable 옵션이 라이브에서만 true 인지를 source-text 로 확인한다. 실기 드래그 확인은
// 오너 몫(다른 EditorPanel 회귀 테스트들과 같은 이유 — src/components/EditorPanel.colorSchema.test.tsx
// 참고).

function firstRowColwidths(md: string): (number[] | null)[] {
  const ed = createMarkdownEditor(md, true);
  const widths: (number[] | null)[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === "table") {
      node.firstChild?.forEach((cell) => widths.push((cell.attrs.colwidth as number[] | null) ?? null));
      return false;
    }
    return true;
  });
  ed.destroy();
  return widths;
}

describe("표 열 너비 — body_md 왕복", () => {
  it("colwidth 없는 표는 출력이 기존과 바이트 단위로 동일하다", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const ed = createMarkdownEditor(md, true);
    const rendered = mdSerializeEditor(ed);
    ed.destroy();
    expect(rendered).not.toContain("{colwidth");
    // 재직렬화도 고정점 — colwidth 처리 추가가 기존 표 포맷 자체를 건드리지 않았다는 증거.
    const reloaded = createMarkdownEditor(rendered, true);
    expect(mdSerializeEditor(reloaded)).toBe(rendered);
    reloaded.destroy();
  });

  it("첫 행 셀 colwidth [120, null, 200] 은 표 뒤에 {colwidth=120,,200} 한 줄로 직렬화된다", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", attrs: { colwidth: [120] }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
                { type: "tableHeader", attrs: { colwidth: [200] }, content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "3" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content: doc });
    const md = mdSerializeEditor(ed);
    ed.destroy();
    expect(md).toContain("{colwidth=120,,200}");
  });

  it("{colwidth=120,,200} 줄은 다시 파싱하면 첫 행 셀의 colwidth 로 복원된다", () => {
    const md = "| A   | B   | C   |\n| --- | --- | --- |\n| 1   | 2   | 3   |\n{colwidth=120,,200}\n";
    expect(firstRowColwidths(md)).toEqual([[120], null, [200]]);
  });

  it("손으로 쓴 {colwidth=...} 줄 없이 표만 있으면 그대로 파싱된다", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(firstRowColwidths(md)).toEqual([null, null]);
  });

  it("GFM 표 둘이 맞붙어도 재열기마다 사이에 빈 문단이 끼거나 빈 줄이 불어나지 않는다", () => {
    // renderTableToMarkdown 은 "\n" 으로 시작해 "\n" 으로 끝난다 — 표 둘이 맞붙으면 빈 줄 3개가 되어 로더가 빈 문단을 하나 만들고,
    // 저장할 때마다 빈 줄이 2개씩 불어났다. 앞 형제가 GFM 표이면 선두 개행을 떼서 표→문단과 같은 빈 줄 2개로 맞춘다.
    const cell = (type: "tableHeader" | "tableCell", text: string) => ({
      type,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const table = (a: string, b: string) => ({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", a), cell("tableHeader", b)] },
        { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
      ],
    });
    const ed = new Editor({
      extensions: createMarkdownSchemaExtensions(),
      content: { type: "doc", content: [table("a", "b"), table("c", "d"), table("e", "f")] },
    });
    const m1 = mdSerializeEditor(ed);
    ed.destroy();
    expect(m1).not.toMatch(/\n\n\n\n/);
    const types = (md: string) => {
      const e = createMarkdownEditor(md, true);
      const out = { md: mdSerializeEditor(e), types: (e.getJSON().content ?? []).map((n) => n.type) };
      e.destroy();
      return out;
    };
    const r2 = types(m1);
    const r3 = types(r2.md);
    expect(r2.types).toEqual(["table", "table", "table"]);
    expect(r2.md).toBe(m1);
    expect(r3.md).toBe(m1);
  });
});

describe("표 열 너비 — 라이브 에디터에서만 리사이즈 가능", () => {
  it("헤드리스 스키마(mdSerialize.ts)의 Table 은 resizable:false 다", () => {
    const src = readFileSync("src/lib/mdSerialize.ts", "utf8");
    expect(src).toMatch(/BriseTable\.configure\(\{\s*resizable:\s*false/);
  });

  it("라이브 에디터(EditorPanel.tsx)는 Table 옵션만 resizable:true 로 오버라이드한다", () => {
    const src = readFileSync("src/components/EditorPanel.tsx", "utf8");
    expect(src).toMatch(/ext\.configure\(\{\s*resizable:\s*true\s*\}\)/);
    // PREVIEW_EXTENSIONS 자체를 재포크하지 않는다 — 여전히 그 배열을 map 으로 순회한다.
    expect(src).toMatch(/\.\.\.PREVIEW_EXTENSIONS\.map/);
  });
});
