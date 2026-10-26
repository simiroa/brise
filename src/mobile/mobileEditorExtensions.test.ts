import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { MARKDOWN_SET_CONTENT_OPTIONS, mdSerializeEditor } from "../lib/mdSerialize";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { canEditBodyOnMobile } from "./mobileEditorSupport";

function roundTrip(md: string): string {
  const ed = new Editor({ extensions: createMobileSchemaExtensions(), content: "" });
  try {
    ed.commands.setContent(md, MARKDOWN_SET_CONTENT_OPTIONS);
    return mdSerializeEditor(ed);
  } finally {
    ed.destroy();
  }
}

describe("폰 에디터 스키마 왕복", () => {
  it("date 마크 앵커(span data-date)가 폰에서 열었다 저장해도 남는다", () => {
    const md = '<span data-date="x">내일</span> 치과';
    expect(canEditBodyOnMobile(md)).toBe(true); // 편집 가능으로 열리는 본문이다
    expect(roundTrip(md)).toBe(md);
  });

  it("date 마크가 굵게 등 다른 마크와 섞여도 id 가 남는다", () => {
    const out = roundTrip('a <span data-date="id-1">**내일**</span> b');
    expect(out).toContain('data-date="id-1"');
  });

  it("각주 마크도 계속 왕복된다", () => {
    const md = '<span data-footnote="f1">주석</span> 끝';
    expect(roundTrip(md)).toBe(md);
  });
});
