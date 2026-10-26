import { describe, expect, it } from "vitest";
import { buildClipboardHtml, buildHtmlDocument, plainTextOf } from "./exportHtml";

// renderPaperBody(…, { links: "keep", images: "embed" }) 가 내는 모양의 본문 — 헤드리스 TipTap getHTML 그대로의 구조.
const TASKS =
  '<ul data-type="taskList">' +
  '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>포트폴리오</p></div></li>' +
  '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>경력증명서</p></div></li>' +
  "</ul>";
const TABLE =
  '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody>' +
  '<tr><th colspan="1" rowspan="1"><p>항목</p></th><th colspan="1" rowspan="1"><p>금액</p></th></tr>' +
  '<tr><td colspan="1" rowspan="1" style="background-color: rgb(253, 230, 138);"><p>식비</p></td><td colspan="1" rowspan="1"><p>1,000</p></td></tr>' +
  "</tbody></table>";
const IMG =
  '<img src="" alt="사진" style="width: 40%; max-width: min(100%, var(--editor-img-max)); height: auto; display: block;" data-rel-path="n1/photo.png">';
const DETAILS = '<details open=""><summary>요약</summary><div data-type="detailsContent"><p>속 내용</p></div></details>';
const BODY =
  '<h2 class="sec-title">이력서</h2><h1>이 력 서</h1>' +
  TASKS +
  TABLE +
  IMG +
  DETAILS +
  "<blockquote><p>인용</p></blockquote>" +
  '<pre><code class="language-js">const x = 1;\nconst y = 2;</code></pre>' +
  '<p><a href="https://example.com">링크</a> 그리고 <code>코드</code> <mark>형광</mark></p>' +
  "<ol><li><p>하나</p></li><li><p>둘</p><ul><li><p>중첩</p></li></ul></li></ol>" +
  "<p>줄1<br>줄2</p><p></p><p>끝</p>";

function parse(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl.content;
}

describe("buildHtmlDocument", () => {
  it("is a standalone document: doctype, utf-8, viewport, escaped title, screen CSS + the W5 A4 print CSS, no script", () => {
    const doc = buildHtmlDocument(BODY, { title: '견적 <"A&B">' });
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(doc).toContain("<title>견적 &lt;&quot;A&amp;B&quot;&gt;</title>");
    // 읽기 폭 · 산세리프 스택 · 그림 폭 막기 · ☐/☑ 체크박스 모양(종이와 같은 규칙)
    expect(doc).toContain("max-width: 46em");
    expect(doc).toContain('"Apple SD Gothic Neo"');
    expect(doc).toContain("max-width: 100% !important");
    expect(doc).toContain('li[data-type="taskItem"] > label::before');
    expect(doc).toContain(String.raw`"\2610"`);
    // 인쇄는 W5 그대로 — A4 세로 @page
    expect(doc).toContain("@media print");
    expect(doc).toContain("size: 210mm 297mm");
    expect(doc.toLowerCase()).not.toContain("<script");
    // lang 은 부르는 쪽이 준 것만 — 주지 않으면 붙이지 않는다
    expect(doc).toContain("<html>");
    expect(buildHtmlDocument("<p>x</p>", { title: "t", lang: "fr" })).toContain('<html lang="fr">');
  });

  it("wraps each outer table in a horizontal-scroll box, keeps data-rel-path for Rust, and makes folds real folds", () => {
    const doc = buildHtmlDocument(BODY, { title: "t" });
    const body = parse(doc.slice(doc.indexOf("<body>") + 6, doc.indexOf("</body>")));
    const table = body.querySelector("table")!;
    expect(table.parentElement?.className).toBe("table-wrap");
    expect(body.querySelectorAll(".table-wrap")).toHaveLength(1);
    // 그림은 Rust(export_html)가 채운다 — 여기서 지우거나 바꾸지 않는다
    expect(body.querySelector("img")!.getAttribute("data-rel-path")).toBe("n1/photo.png");
    // 종이 렌더가 펼쳐 둔 접기를 걷는다 — 앱에서처럼 접힌 채 열리고, 누르면 펼쳐진다
    expect(body.querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(body.querySelector("details summary")!.textContent).toBe("요약");
    expect(body.querySelector("a")!.getAttribute("href")).toBe("https://example.com");
  });

  it("does not wrap a table nested inside a cell a second time", () => {
    const nested = '<table><tbody><tr><td><table><tbody><tr><td>x</td></tr></tbody></table></td></tr></tbody></table>';
    const doc = buildHtmlDocument(nested, { title: "t" });
    expect(doc.match(/class="table-wrap"/g)).toHaveLength(1);
  });

  // 결함 재현(W6 검증 V2): body 의 `overflow-wrap: anywhere` 를 칸이 물려받으면 칸의 최소 폭이 한 글자가 되어, 넓은 표가 .table-wrap
  // 안에서 가로로 스크롤하는 대신 열을 한 글자 폭까지 줄였다(₩1,234,567 이 네 줄로 쪼개짐). break-word 는 최소 폭을 낮추지 않는다.
  // 레이아웃은 jsdom 이 못 그리므로 규칙을 본다 — 실제 렌더(390px, 8열 금액 표)는 Edge 로 전후를 확인했다.
  it("table cells wrap only at word boundaries so a wide table scrolls instead of shrinking columns to one glyph", () => {
    const doc = buildHtmlDocument(TABLE, { title: "t" });
    const cellRule = /\ntd, th \{([^}]*)\}/.exec(doc)?.[1] ?? "";
    expect(cellRule).toContain("overflow-wrap: break-word;");
    expect(cellRule).not.toContain("anywhere");
  });
});

describe("buildClipboardHtml", () => {
  const out = parse(buildClipboardHtml(BODY));

  it("puts the styling inline (mail editors drop <style>): table borders, header background, keeps a cell's own background last", () => {
    expect(buildClipboardHtml(BODY)).not.toContain("<style");
    expect(out.querySelector("table")!.getAttribute("style")).toContain("border-collapse: collapse");
    const th = out.querySelector("th")!.getAttribute("style")!;
    expect(th).toContain("border: 1px solid");
    expect(th).toContain("background-color:");
    const td = out.querySelector("td")!.getAttribute("style")!;
    expect(td).toContain("border: 1px solid");
    // 원래 셀 배경은 우리 style 뒤에 남아 이긴다
    expect(td.endsWith("background-color: rgb(253, 230, 138)")).toBe(true);
    expect(out.querySelector("blockquote")!.getAttribute("style")).toContain("border-left:");
    expect(out.querySelector("pre")!.getAttribute("style")).toContain("monospace");
    expect(out.querySelector("pre > code")!.hasAttribute("style")).toBe(false); // 코드 블록 안은 pre 가 맡는다
    expect(out.querySelector("p > code")!.getAttribute("style")).toContain("monospace");
    expect(out.querySelector("h1")!.getAttribute("style")).toContain("font-size:");
    expect(out.querySelector("mark")!.getAttribute("style")).toContain("background-color:");
  });

  it("images: drops the app-token declaration, caps the width, keeps data-rel-path for export_html_inline", () => {
    const img = out.querySelector("img")!;
    const style = img.getAttribute("style")!;
    expect(style).not.toContain("var(");
    expect(style).toContain("width: 40%");
    expect(style).toContain("max-width: 100%");
    expect(img.getAttribute("data-rel-path")).toBe("n1/photo.png");
  });

  it("task items become ☐/☑ text with no checkbox input; folds become their open content with a bold summary", () => {
    expect(out.querySelector("input")).toBeNull();
    const items = [...out.querySelectorAll('li[data-type="taskItem"]')].map((li) => li.textContent);
    expect(items).toEqual(["☐ 포트폴리오", "☑ 경력증명서"]);
    expect(out.querySelector('ul[data-type="taskList"]')!.getAttribute("style")).toContain("list-style: none");
    expect(out.querySelector("details")).toBeNull();
    expect(out.querySelector("summary")).toBeNull();
    const strong = [...out.querySelectorAll("p > strong")].find((s) => s.textContent === "요약");
    expect(strong).toBeTruthy();
    expect(buildClipboardHtml(BODY)).toContain("<p>속 내용</p>");
  });

  it("unwraps nested folds without leaving a details behind", () => {
    const nested =
      '<details><summary>밖</summary><div data-type="detailsContent">' +
      '<details><summary>안</summary><div data-type="detailsContent"><p>속</p></div></details>' +
      "</div></details>";
    const html = buildClipboardHtml(nested);
    expect(html).not.toContain("<details");
    expect(html).toContain("<strong>밖</strong>");
    expect(html).toContain("<strong>안</strong>");
    expect(html).toContain("<p>속</p>");
  });
});

describe("plainTextOf", () => {
  it("reads without Markdown symbols: block line breaks, - / 1. lists, ☐/☑ tasks, tab-separated table rows", () => {
    expect(plainTextOf(BODY)).toBe(
      [
        "이력서",
        "이 력 서",
        "☐ 포트폴리오",
        "☑ 경력증명서",
        "항목\t금액",
        "식비\t1,000",
        "요약",
        "속 내용",
        "인용",
        "const x = 1;",
        "const y = 2;",
        "링크 그리고 코드 형광",
        "1. 하나",
        "2. 둘",
        "  - 중첩",
        "줄1",
        "줄2",
        "",
        "끝",
      ].join("\n"),
    );
  });

  it("keeps the image placeholder text but not images, and respects an ordered list's start", () => {
    expect(plainTextOf('<p>앞 <span class="img-ph">[그림]</span></p><img src="x.png" alt="a"><ol start="3"><li><p>셋</p></li></ol>')).toBe(
      "앞 [그림]\n3. 셋",
    );
  });
});
