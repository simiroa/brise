import { describe, it, expect } from "vitest";
import { Editor, type Extensions } from "@tiptap/core";
import {
  createMarkdownSchemaExtensions,
  MARKDOWN_SET_CONTENT_OPTIONS,
  mdSerializeEditor,
} from "./mdSerialize";
import { PREVIEW_EXTENSIONS } from "./editorExtensions";
import { createMobileSchemaExtensions } from "../mobile/mobileEditorExtensions";

/**
 * 색 글자·각주·날짜 span 섬 안의 글자가 저장할 때마다 역슬래시를 불리던 버그(2026-10-18, P1 데이터 손상).
 *
 * 직렬화기는 `<span …>` 안의 글자를 다른 글자처럼 마크다운 이스케이프(`*` → `\*`)하는데, @tiptap/markdown
 * 의 기본 파서는 여는 태그부터 닫는 태그까지의 **원문**을 이어 붙여 DOM 으로 읽었다 — 안쪽의 `\*` 가 글자
 * 그대로 남고, 다음 저장이 그 역슬래시와 별표를 또 이스케이프해 1→3→7→15→31 로 불었다. 같은 이유로 색 글자
 * 안의 굵게(`**…**`)는 다시 열면 별표 글자가 됐다. 픽스처는 전부 합성 — 실제 노트 본문은 넣지 않는다.
 */

function roundTrip(md: string, extensions: Extensions): string {
  const ed = new Editor({ extensions, content: "" });
  try {
    ed.commands.setContent(md, MARKDOWN_SET_CONTENT_OPTIONS);
    return mdSerializeEditor(ed);
  } finally {
    ed.destroy();
  }
}

function fromHtml(html: string, extensions: Extensions): string {
  const ed = new Editor({ extensions, content: html });
  try {
    return mdSerializeEditor(ed);
  } finally {
    ed.destroy();
  }
}

/** 마크다운을 열어 글자별 마크를 모은다 — "어느 글자에 어떤 마크가 붙었나"를 비교하기 위해. */
function marksByText(md: string, extensions: Extensions): Array<{ text: string; marks: string[] }> {
  const ed = new Editor({ extensions, content: "" });
  try {
    ed.commands.setContent(md, MARKDOWN_SET_CONTENT_OPTIONS);
    const out: Array<{ text: string; marks: string[] }> = [];
    ed.state.doc.descendants((node) => {
      if (!node.isText) return;
      const marks = node.marks
        .map((m) => (m.attrs.id ? `${m.type.name}:${m.attrs.id}` : m.attrs.color ? `${m.type.name}:${m.attrs.color}` : m.type.name))
        .sort();
      out.push({ text: node.text ?? "", marks });
    });
    return out;
  } finally {
    ed.destroy();
  }
}

const SCHEMAS: Array<[string, () => Extensions]> = [
  ["헤드리스(createMarkdownSchemaExtensions)", createMarkdownSchemaExtensions],
  ["라이브·프리뷰(PREVIEW_EXTENSIONS)", () => PREVIEW_EXTENSIONS],
];

describe.each(SCHEMAS)("span 섬 왕복 — %s", (_label, schema) => {
  it("색 글자 안의 이스케이프된 별표는 저장해도 그대로다(역슬래시가 불지 않는다)", () => {
    const md = '<span style="color: rgb(1, 2, 3)">price \\*\\*100\\*\\* won</span>';
    const m1 = roundTrip(md, schema());
    expect(m1).toBe(md);
    expect(roundTrip(m1, schema())).toBe(md);
  });

  it("이미 불어난 본문(역슬래시 31개)은 더 불지 않는다", () => {
    const run = "\\".repeat(31) + "*";
    const md = `<span style="color: rgb(78, 83, 92)">total${run}9${run}</span>`;
    expect(roundTrip(md, schema())).toBe(md);
  });

  it("색 글자 안의 굵게가 다시 열어도 굵게로 남는다", () => {
    const md = fromHtml('<p><span style="color: rgb(255, 0, 0)">total <strong>100</strong></span></p>', schema());
    expect(roundTrip(md, schema())).toBe(md);
    expect(marksByText(md, schema())).toEqual([
      { text: "total ", marks: ["textStyle:rgb(255, 0, 0)"] },
      { text: "100", marks: ["bold", "textStyle:rgb(255, 0, 0)"] },
    ]);
  });

  it("색 글자 안의 별표 글자는 글자 그대로 남는다", () => {
    const md = fromHtml('<p><span style="color: rgb(255, 0, 0)">a*b_c[d]~e\\f</span></p>', schema());
    expect(roundTrip(md, schema())).toBe(md);
    expect(marksByText(md, schema())).toEqual([{ text: "a*b_c[d]~e\\f", marks: ["textStyle:rgb(255, 0, 0)"] }]);
  });

  it("링크 글자 안의 색 글자(span 두 개)도 왕복이 고정된다", () => {
    const md =
      '[<span style="color: rgb(34, 34, 34)">\\*\\*Guide\\*\\*</span><span style="color: rgb(108, 108, 108)">sub text</span>](https://example.com/guide)';
    const m1 = roundTrip(md, schema());
    expect(m1).toBe(md);
    expect(roundTrip(m1, schema())).toBe(md);
  });

  it("색 글자 안의 인라인 코드에 든 `</span>` 이 섬을 일찍 끝내지 않는다", () => {
    // 직렬화기는 코드 마크(다른 마크를 배제)를 span 밖으로 빼서 쓰므로 이 모양은 손으로 쓴 본문에서만 나온다 —
    // 그래도 닫는 태그 찾기가 코드 안의 태그 모양 글자에 속으면 섬이 반쯤에서 끊긴다.
    const md = '<span style="color: rgb(1, 2, 3)">see `</span>` here</span> after';
    const m1 = roundTrip(md, schema());
    expect(roundTrip(m1, schema())).toBe(m1);
    const nodes = marksByText(md, schema());
    expect(nodes.find((n) => n.text === "</span>")?.marks).toContain("code");
    expect(nodes.find((n) => n.text === " here")?.marks).toEqual(["textStyle:rgb(1, 2, 3)"]);
    expect(nodes[nodes.length - 1]).toEqual({ text: " after", marks: [] });
  });

  it("각주 span 안의 이스케이프 글자도 불지 않고 id 가 남는다", () => {
    const md = '<span data-footnote="fn-1">a\\*b\\_c\\[d\\]</span> tail';
    expect(roundTrip(md, schema())).toBe(md);
    expect(marksByText(md, schema())[0]).toEqual({ text: "a*b_c[d]", marks: ["footnote:fn-1"] });
  });

  it("각주 span 안의 줄바꿈(<br>)도 같은 각주 마크를 받는다 — 앵커가 두 조각으로 갈리지 않는다", () => {
    const ed = new Editor({ extensions: schema(), content: "" });
    try {
      ed.commands.setContent('<span data-footnote="f">서울<br>본사</span> 끝', MARKDOWN_SET_CONTENT_OPTIONS);
      const inline: Array<[string, string[]]> = [];
      ed.state.doc.descendants((n) => {
        if (n.isInline) inline.push([n.isText ? (n.text ?? "") : n.type.name, n.marks.map((m) => m.type.name)]);
      });
      expect(inline).toEqual([
        ["서울", ["footnote"]],
        ["hardBreak", ["footnote"]],
        ["본사", ["footnote"]],
        [" 끝", []],
      ]);
    } finally {
      ed.destroy();
    }
  });

  it("날짜 span 안의 굵게가 남고 id 도 남는다", () => {
    // 직렬화기는 굵게를 날짜 span 바깥에 쓴다(`**<span …>…</span>**`) — 첫 저장의 정규화일 뿐 그다음부터 고정이다.
    const md = 'a <span data-date="d-1">**tomorrow**</span> b';
    const m1 = roundTrip(md, schema());
    expect(roundTrip(m1, schema())).toBe(m1);
    expect(marksByText(m1, schema())).toEqual(marksByText(md, schema()));
    expect(marksByText(md, schema())).toEqual([
      { text: "a ", marks: [] },
      { text: "tomorrow", marks: ["bold", "date:d-1"] },
      { text: " b", marks: [] },
    ]);
  });

  it("색 글자 안의 각주 · 각주 안의 색 글자 모두 마크와 글자가 그대로다", () => {
    for (const html of [
      '<p><span style="color: rgb(255, 0, 0)"><span data-footnote="fn-2">x*y</span></span> z</p>',
      '<p><span data-footnote="fn-2"><span style="color: rgb(255, 0, 0)">x*y</span></span> z</p>',
    ]) {
      const md = fromHtml(html, schema());
      expect(roundTrip(md, schema())).toBe(md);
      expect(marksByText(md, schema())).toEqual([
        { text: "x*y", marks: ["footnote:fn-2", "textStyle:rgb(255, 0, 0)"] },
        { text: " z", marks: [] },
      ]);
    }
  });

  it("우리가 쓰지 않는 모양의 span(여러 선언)은 예전처럼 DOM 으로 읽혀 색이 남는다", () => {
    const marks = marksByText('<span style="color: rgb(9, 9, 9); font-size: 12px">x</span>', schema());
    expect(marks).toEqual([{ text: "x", marks: ["textStyle:rgb(9, 9, 9)"] }]);
  });
});

describe("span 섬 왕복 — 폰 스키마(createMobileSchemaExtensions)", () => {
  it("각주·날짜 span 안의 이스케이프 글자가 폰에서 저장해도 불지 않는다", () => {
    for (const md of [
      '<span data-footnote="fn-1">a\\*b</span> tail',
      '<span data-date="d-1">x\\_y</span> tail',
    ]) {
      expect(roundTrip(md, createMobileSchemaExtensions())).toBe(md);
    }
  });

  it("날짜 span 안의 굵게가 폰에서도 굵게로 남는다", () => {
    const md = 'a <span data-date="id-1">**내일**</span> b';
    const m1 = roundTrip(md, createMobileSchemaExtensions());
    expect(m1).toBe('a **<span data-date="id-1">내일</span>** b');
    expect(roundTrip(m1, createMobileSchemaExtensions())).toBe(m1);
  });
});
