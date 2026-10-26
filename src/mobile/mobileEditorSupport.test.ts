import { describe, it, expect } from "vitest";
import { canEditBodyOnMobile, stripHtmlForDisplay, shouldShowCapturePresets } from "./mobileEditorSupport";
import { mdSerializeHtml } from "../lib/mdSerialize";

describe("canEditBodyOnMobile", () => {
  it("allows plain-text / basic-markdown bodies", () => {
    expect(canEditBodyOnMobile("")).toBe(true);
    expect(canEditBodyOnMobile("Just some **plain** text.\n- item")).toBe(true);
    expect(canEditBodyOnMobile("<p>a paragraph</p><ul><li>x</li></ul>")).toBe(true);
  });

  it("allows markdown images (P0-2 — BriseImage + Markdown registered on mobile)", () => {
    expect(canEditBodyOnMobile("![photo](attachments/a.png){width=40%}")).toBe(true);
    expect(canEditBodyOnMobile("See ![x](a.png) here")).toBe(true);
    // Legacy HTML img also editable now that Image is on mobile — never lock image notes RO.
    expect(canEditBodyOnMobile('<img src="x.png" alt="x">')).toBe(true);
  });

  it("allows paragraph-format HTML that the mobile editor can preserve", () => {
    expect(
      canEditBodyOnMobile(
        '<p data-brise-align="center" data-brise-indent="2" style="text-align: center; margin-left: 4em;">text</p>'
      )
    ).toBe(true);
  });

  it("flags a table body (HTML or GFM) as unsafe to re-save through the minimal mobile editor", () => {
    expect(canEditBodyOnMobile("<table><tr><td>a</td></tr></table>")).toBe(false);
    expect(canEditBodyOnMobile("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe(false);
  });

  it("flags the <table> HTML fragment saved for merged/multi-block/shaded cells (the phone schema has no Table — re-saving would cut it)", () => {
    // 실제 저장 형태(W0, tableColwidth.ts) — 병합·셀 배경·셀 안 여러 블록이 있는 표만 GFM 대신 이렇게 나간다.
    const fragment = mdSerializeHtml(
      '<table><tr><th colspan="2" style="background-color:#ffff00">AB</th></tr><tr><td><p>a</p><p>b</p></td><td>c</td></tr></table>',
    );
    expect(fragment).toMatch(/^<table/);
    expect(canEditBodyOnMobile(fragment)).toBe(false);
    // 앞뒤 마크다운 문단이 있어도 조각이 한 줄이라도 들어 있으면 읽기 전용이다.
    expect(canEditBodyOnMobile(`앞 문단\n\n${fragment}\n\n뒤 문단`)).toBe(false);
    // 손으로 쓴 한 줄 조각(한 줄에 이어 붙인 형태)도 마찬가지.
    expect(canEditBodyOnMobile('<table><tbody><tr><td colspan="2" rowspan="1"><p>x</p></td></tr></tbody></table>')).toBe(false);
  });

  it("flags details/summary, highlight, and color spans", () => {
    expect(canEditBodyOnMobile("<details><summary>s</summary>body</details>")).toBe(false);
    expect(canEditBodyOnMobile(":::details\n\nSpoiler\n\n:::")).toBe(false);
    expect(canEditBodyOnMobile("text <mark>hit</mark> more")).toBe(false);
    expect(canEditBodyOnMobile("text ==hit== more")).toBe(false);
    expect(canEditBodyOnMobile('<span style="color:red">x</span>')).toBe(false);
  });

  it("allows markdown links (Link extension is on mobile) including note://", () => {
    expect(canEditBodyOnMobile("[My Note](note://abc)")).toBe(true);
    expect(canEditBodyOnMobile("[ex](https://example.com)")).toBe(true);
  });
});

describe("stripHtmlForDisplay", () => {
  it("strips tags and collapses excess blank lines", () => {
    expect(stripHtmlForDisplay("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
  });

  it("keeps table cells apart (cell → space, row → newline) — tags used to be deleted outright and glued them", () => {
    expect(stripHtmlForDisplay("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>")).toBe("a\nb");
    expect(stripHtmlForDisplay("<table><tr><td>a</td><td>b</td></tr></table>")).toBe("a b");
  });

  it("reads a real saved fragment table row by row (merged 3-column table — the phone shows nothing else)", () => {
    const fragment = mdSerializeHtml(
      '<table><tr><th colspan="2">성명 정보</th><th>점수</th></tr><tr><td>김하늘</td><td>이름</td><td>90</td></tr><tr><td>박</td><td>80</td><td></td></tr></table>',
    );
    expect(fragment).toMatch(/^<table/);
    expect(stripHtmlForDisplay(fragment)).toBe("성명 정보 점수\n김하늘 이름 90\n박 80");
    // 표 앞뒤 문단과도 이어붙지 않는다 — 첫 줄(저장 직후 화면의 firstLine)이 표 글자를 먹지 않는다.
    expect(stripHtmlForDisplay(`앞 문단\n\n${fragment}\n\n뒤 문단`).split("\n")[0]).toBe("앞 문단");
  });

  it("paragraphs, list items and headings do not run together; inline tags do not split words", () => {
    expect(stripHtmlForDisplay("<p>a</p><p>b</p><ul><li>c</li><li>d</li></ul>")).toBe("a b c d");
    expect(stripHtmlForDisplay("<h2>제목</h2><p>본문</p>")).toBe("제목 본문");
    expect(stripHtmlForDisplay("<p>wor<em>ld</em><strong>!</strong></p>")).toBe("world!");
    expect(stripHtmlForDisplay("a<br>b<br/>c")).toBe("a b c");
  });

  it("leaves a plain markdown body's own spacing alone", () => {
    expect(stripHtmlForDisplay("- a\n  - b\n\n본문  두 칸")).toBe("- a\n  - b\n\n본문  두 칸");
  });
});

describe("shouldShowCapturePresets", () => {
  it("shows while the body is empty and no preset has been applied yet", () => {
    expect(shouldShowCapturePresets(true, false)).toBe(true);
  });

  it("hides once real content is typed (activeBodyEmpty flips false)", () => {
    expect(shouldShowCapturePresets(false, false)).toBe(false);
  });

  it("hides after a preset is applied even if the body still strips to empty (할 일 목록)", () => {
    expect(shouldShowCapturePresets(true, true)).toBe(false);
  });
});
