import { describe, it, expect } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { mdSerializeHtml, mdSerializeEditor, createMarkdownEditor } from "./mdSerialize";

/**
 * doc_import_html 이 돌려주는 HTML 계약(specs/commands/sections.yaml, PLAN-2026-10-07-doc-import-export §3 W1)
 * 의 **샘플**을 프런트 직렬화 관문(mdSerializeHtml → section_create_with_body 의 body_md)에 넣어 본 모양을 못 박는다.
 * Rust 쪽이 이 부분집합 밖의 HTML 을 내면 여기서가 아니라 변환기 테스트에서 걸러야 하고, 이 파일은 "계약 안의
 * 입력이면 저장 형식이 이렇게 나오고, 한 번 저장된 것은 다시 열고 저장해도 바이트가 같다" 를 지킨다(무음 변형 방지).
 *
 * 순수 함수 테스트다 — IPC·스토어 목 없음. 오케스트레이션(어떤 커맨드를 어떤 순서로 부르나)은 noteActions.test.ts.
 */

/** body_md → 열고(markdown 로드) → 저장. 두 번 돌려 m2 === m3 인지 본다(mdSerialize.test.ts 와 같은 판정). */
function reload(md: string): { md: string; json: JSONContent } {
  const ed = createMarkdownEditor(md, true);
  const json = ed.getJSON();
  const out = mdSerializeEditor(ed);
  ed.destroy();
  return { md: out, json };
}

/** 계약 HTML → body_md(m1) 가 열고 저장해도 같고(m1 === m2) 한 번 더 해도 같다(m2 === m3). m1 을 돌려준다. */
function expectStable(html: string): string {
  const m1 = mdSerializeHtml(html);
  const m2 = reload(m1).md;
  const m3 = reload(m2).md;
  expect(m2).toBe(m1);
  expect(m3).toBe(m2);
  return m1;
}

function collect(node: JSONContent | undefined, type: string, out: JSONContent[] = []): JSONContent[] {
  if (!node) return out;
  if (node.type === type) out.push(node);
  node.content?.forEach((c) => collect(c, type, out));
  return out;
}

describe("doc_import_html 계약 HTML → body_md", () => {
  it("제목 h1~h3 — 왼쪽 정렬은 마크다운 그대로, 가운데 정렬 제목은 HTML 섬", () => {
    const md = expectStable('<h1>하나</h1><h2>둘</h2><h3 style="text-align: center">셋</h3>');
    expect(md).toBe(
      '# 하나\n\n## 둘\n\n<h3 data-brise-align="center" style="text-align: center;">셋</h3>',
    );
  });

  it("정렬 justify·center·right 는 data-brise-align 섬이고, 읽는 쪽은 style 의 text-align 으로 받는다", () => {
    const md = expectStable(
      '<p style="text-align: justify">양쪽</p><p style="text-align: center">가운데</p><p style="text-align: right">오른쪽</p>',
    );
    expect(md).toBe(
      '<p data-brise-align="justify" style="text-align: justify;">양쪽</p>\n\n' +
        '<p data-brise-align="center" style="text-align: center;">가운데</p>\n\n' +
        '<p data-brise-align="right" style="text-align: right;">오른쪽</p>',
    );
    const blocks = reload(md).json.content ?? [];
    expect(blocks.map((b) => b.attrs?.textAlign)).toEqual(["justify", "center", "right"]);
  });

  it("왼쪽 정렬·들여쓰기 0 은 서식 없는 일반 문단으로 돌아간다", () => {
    expect(expectStable('<p style="text-align: left">왼쪽</p><p data-brise-indent="0">영</p>')).toBe("왼쪽\n\n영");
  });

  it("들여쓰기 data-brise-indent 1..6 은 정렬과 함께 한 섬에 실린다", () => {
    const md = expectStable(
      '<p data-brise-indent="2">둘</p><p style="text-align: justify" data-brise-indent="1">양쪽+하나</p>',
    );
    expect(md).toBe(
      '<p data-brise-indent="2" style="margin-left: 4em;">둘</p>\n\n' +
        '<p data-brise-align="justify" data-brise-indent="1" style="text-align: justify; margin-left: 2em;">양쪽+하나</p>',
    );
    const blocks = reload(md).json.content ?? [];
    expect(blocks.map((b) => [b.attrs?.textAlign, b.attrs?.indent])).toEqual([
      ["left", 2], // 정렬 속성이 없으면 스키마 기본값(left)
      ["justify", 1],
    ]);
  });

  it("글자 서식 — 굵게·기울임·밑줄·취소선·형광·글자색·링크", () => {
    const md = expectStable(
      '<p><strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s> <mark>형광</mark> ' +
        '<span style="color: #ff0000">빨강</span> <a href="https://example.com/x">링크</a></p>',
    );
    expect(md).toBe(
      '**굵게** *기울임* ++밑줄++ ~~취소~~ ==형광== <span style="color: #ff0000">빨강</span> [링크](https://example.com/x)',
    );
  });

  it("정렬 섬 안에서도 글자 서식이 살아 있다", () => {
    const md = expectStable('<p style="text-align: justify">앞 <strong>굵게</strong> <mark>형광</mark> 뒤</p>');
    const json = reload(md).json;
    const marks = collect(json, "text").flatMap((n) => (n.marks ?? []).map((m) => m.type));
    expect(marks).toContain("bold");
    expect(marks).toContain("highlight");
    expect(md).toContain('data-brise-align="justify"');
  });

  it("목록 — ul·ol·중첩", () => {
    expect(expectStable("<ul><li><p>가</p></li><li><p>나</p></li></ul>")).toBe("- 가\n- 나");
    expect(expectStable("<ol><li><p>하나</p></li><li><p>둘</p></li></ol>")).toBe("1. 하나\n2. 둘");
    expect(expectStable("<ul><li><p>상위</p><ul><li><p>하위</p></li></ul></li></ul>")).toBe("- 상위\n  - 하위");
  });

  it("번호 목록 <ol start> — 문단에 끊겼다 이어지는 목록이 1 로 되돌아가지 않고, 다시 열고 저장해도 같다", () => {
    const md = expectStable(
      '<ol><li><p>첫째</p></li></ol><p>보충</p><ol start="2"><li><p>둘째</p></li></ol><p>보충</p>' +
        '<ol start="3"><li><p>셋째</p><ol start="3"><li><p>c</p></li></ol></li></ol>',
    );
    expect(md).toBe("1. 첫째\n\n보충\n\n2. 둘째\n\n보충\n\n3. 셋째\n  3. c");
    const lists = collect(reload(md).json, "orderedList");
    expect(lists.map((l) => l.attrs?.start)).toEqual([1, 2, 3, 3]);
  });

  it("병합·셀 배경·colwidth 표는 한 줄 <table> 조각이고 병합·배경·열 너비가 재로드 뒤에도 남는다", () => {
    const html =
      '<table><tr><th colspan="2" colwidth="120,200" style="background-color: #ffff00"><p>병합 헤더</p></th><th colwidth="90"><p>C</p></th></tr>' +
      '<tr><td><p>1</p></td><td rowspan="2"><p>2</p></td><td style="background-color: #cce5ff"><p>3</p></td></tr>' +
      "<tr><td><p>4</p></td><td><p>6</p></td></tr></table>";
    const md = expectStable(html);
    expect(md).toMatch(/^<table/);
    expect(md).not.toContain("\n"); // 한 줄 조각 — 줄이 갈리면 마크다운 파서가 중간에서 끊는다
    expect(md).not.toContain("| "); // GFM 파이프 행 없음
    expect(md).toContain('colspan="2"');
    expect(md).toContain('rowspan="2"');
    expect(md).toContain('colwidth="120,200"');
    expect(md).toContain("background-color: rgb(255, 255, 0)");
    expect(md).toContain("background-color: rgb(204, 229, 255)");

    const json = reload(md).json;
    const headers = collect(json, "tableHeader");
    const cells = collect(json, "tableCell");
    expect(headers.map((h) => [h.attrs?.colspan, h.attrs?.colwidth])).toEqual([
      [2, [120, 200]],
      [1, [90]],
    ]);
    expect(headers[0].attrs?.backgroundColor).toBe("rgb(255, 255, 0)");
    expect(cells.map((c) => c.attrs?.rowspan)).toEqual([1, 2, 1, 1, 1]);
    expect(cells[2].attrs?.backgroundColor).toBe("rgb(204, 229, 255)");
  });

  it("병합·배경이 없는 표는 GFM 파이프 표 그대로다", () => {
    const md = expectStable("<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>");
    expect(md).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("그림 — data-rel-path 가 경로가 되고 style width % 가 {width=N%} 로 남는다 (<p> 로 감싸도 맨몸이어도 같다)", () => {
    const img = (alt: string) =>
      `<img src="attachments/n1/pic.png" data-rel-path="attachments/n1/pic.png" alt="${alt}" style="width: 60%">`;
    expect(expectStable(`<p>${img("그림")}</p>`)).toBe("![그림](attachments/n1/pic.png){width=60%}");
    expect(expectStable(img("그림"))).toBe("![그림](attachments/n1/pic.png){width=60%}");
    // alt 가 빈 그림도 형태가 같다 — 한글 파일은 대체 텍스트가 없는 그림이 흔하다.
    expect(expectStable(img(""))).toBe("![](attachments/n1/pic.png){width=60%}");
    // src 가 상대 경로여도 저장되는 건 data-rel-path 쪽이다(asset:// 같은 표시용 주소가 새지 않는다).
    expect(mdSerializeHtml(img("그림"))).not.toContain("asset://");
  });

  it("줄바꿈 br 과 코드 블록 pre/code", () => {
    expect(expectStable("<p>줄<br>바꿈</p>")).toBe("줄  \n바꿈");
    expect(expectStable("<pre><code>let x = 1;</code></pre>")).toBe("```\nlet x = 1;\n```");
  });

  describe("hwpx 가져오기 검증에서 나온 회귀", () => {
    const plainTable = (a: string, b: string, c: string, d: string) =>
      `<table><tr><th colwidth="100"><p>${a}</p></th><th colwidth="150"><p>${b}</p></th></tr>` +
      `<tr><td colwidth="100"><p>${c}</p></td><td colwidth="150"><p>${d}</p></td></tr></table>`;
    const mergedTable = (a: string) =>
      `<table><tr><th colspan="2" colwidth="100,150"><p>${a}</p></th></tr><tr><td colwidth="100"><p>1</p></td><td colwidth="150"><p>2</p></td></tr></table>`;

    it("병합·배경이 없는 평범한 표가 문단 없이 맞붙어도 고정점이고 사이에 빈 문단이 끼지 않는다", () => {
      // GFM 표는 앞뒤에 "\n" 을 달고 나온다 — 둘이 맞붙으면 빈 줄 3개가 되어 마크다운 로더가 사이에 빈 문단을 만들었고, 저장할 때마다
      // 빈 줄이 2개씩 불어났다(tableColwidth.ts BriseTable.renderMarkdown). 한글 양식에서는 드물지 않은 모양이다.
      const two = expectStable(plainTable("a", "b", "c", "d") + plainTable("e", "f", "g", "h"));
      expect(two).not.toMatch(/\n\n\n\n/); // 빈 줄 3개 이상이 없다
      expect((reload(two).json.content ?? []).map((b) => b.type)).toEqual(["table", "table"]);

      const three = expectStable(plainTable("a", "b", "c", "d") + plainTable("e", "f", "g", "h") + plainTable("i", "j", "k", "l"));
      expect((reload(three).json.content ?? []).map((b) => b.type)).toEqual(["table", "table", "table"]);

      // 앞뒤 문단과 섞여도, 사이에 HTML 조각 표(병합)가 끼어도 같다.
      const mixed = expectStable(
        "<p>앞</p>" + plainTable("a", "b", "c", "d") + plainTable("e", "f", "g", "h") + "<p>뒤</p>" +
          plainTable("i", "j", "k", "l") + mergedTable("병합") + plainTable("m", "n", "o", "p"),
      );
      expect((reload(mixed).json.content ?? []).map((b) => b.type)).toEqual([
        "paragraph", "table", "table", "paragraph", "table", "table", "table",
      ]);
      // 열 너비 마커 줄({colwidth=…})도 표마다 자기 표에 붙어 있다.
      expect(two.match(/\{colwidth=100,150\}/g)).toHaveLength(2);
    });

    it("공백뿐인 조각은 서식 기호 없이 일반 글자로 남는다 (밑줄 친 빈칸)", () => {
      // hwpx_import 의 render_piece 가 내는 모양 — 공백만 감싼 `++ ++`·`**` 는 마크다운이 표지로 안 읽어 기호가 글자로 남았다.
      for (const html of [`<p>이름 :${" ".repeat(7)}</p>`, "<p>앞 뒤</p>", "<p><strong>A B</strong></p>"]) {
        const md = expectStable(html);
        const text = collect(reload(md).json, "text").map((n) => n.text).join("");
        expect(text, html).not.toMatch(/[*+~=]/);
      }
    });

    it("링크 주소의 괄호·대괄호는 퍼센트 인코딩돼 있어 새 링크·이미지로 번지지 않는다", () => {
      // hwpx_import 의 safe_href 출력. 프런트 직렬화기는 링크 주소의 괄호를 이스케이프하지 않아, 날것 `)` 가 있으면 링크가 닫히고
      // `[x](javascript:…)`·`![i](http://evil/…)` 가 파일 안 글자만으로 생겼다.
      const inputs = [
        '<p>pre <a href="http://x.com/%29%5Bx%5D%28javascript:alert%281%29">L</a> post</p>',
        '<p><a href="http://a.com/%29!%5Bi%5D%28http://evil.example/p.png%29">L</a></p>',
        '<p><a href="https://en.wikipedia.org/wiki/Foo_%28bar%29">L</a></p>',
      ];
      for (const html of inputs) {
        const md = expectStable(html);
        const json = reload(md).json;
        const links = collect(json, "text").flatMap((n) => (n.marks ?? []).filter((m) => m.type === "link"));
        expect(links, html).toHaveLength(1);
        expect(collect(json, "image"), html).toHaveLength(0);
        expect(String(links[0].attrs?.href)).toContain("%2");
      }
    });
  });

  it("계약 부분집합을 한 문서에 모두 넣어도 두 번 왕복이 바이트 동일하다", () => {
    // 표와 표 사이 문단은 이 테스트가 읽기 쉬우라고 둔 것이다 — 문단 없이 맞붙은 표도 계약 입력이고 아래 전용 테스트가 지킨다.
    const html =
      "<h1>제목</h1>" +
      '<p style="text-align: justify">양쪽 <strong>굵게</strong> <span style="color: #ff0000">빨강</span> <a href="https://example.com/x">링크</a></p>' +
      '<p style="text-align: center">가운데</p><p data-brise-indent="2">들여쓰기</p>' +
      "<ul><li><p>가</p></li><li><p>나</p></li></ul><ol><li><p>하나</p></li><li><p>둘</p></li></ol>" +
      '<table><tr><th colspan="2" colwidth="120,200" style="background-color: #ffff00"><p>병합</p></th></tr><tr><td><p>1</p></td><td rowspan="1"><p>2</p></td></tr></table>' +
      "<p>사이 문단</p>" +
      "<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>" +
      '<p><img src="attachments/n1/pic.png" data-rel-path="attachments/n1/pic.png" alt="그림" style="width: 60%"></p>' +
      "<p>줄<br>바꿈</p><pre><code>let x = 1;</code></pre>";
    const md = expectStable(html);
    expect(md).toContain("# 제목");
    expect(md).toContain("![그림](attachments/n1/pic.png){width=60%}");
  });
});
