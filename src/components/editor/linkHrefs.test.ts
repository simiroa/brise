import { describe, it, expect } from "vitest";
import { createMarkdownEditor } from "../../lib/mdSerialize";
import { linkHrefsInRange } from "./linkHrefs";

/** 선택 영역 전체를 훑는다 — "선택 안의 링크 N개" 행이 세는 것과 같은 범위. */
function hrefsOf(md: string): string[] {
  const ed = createMarkdownEditor(md);
  try {
    return linkHrefsInRange(ed.state.doc, 0, ed.state.doc.content.size);
  } finally {
    ed.destroy();
  }
}

describe("linkHrefsInRange", () => {
  it("문서 순서대로 모으고 같은 주소는 한 번만 센다", () => {
    expect(hrefsOf("[a](https://a.com) 그리고 [b](https://b.com) 또 [a again](https://a.com)")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("note:// 위키링크는 세지 않는다 — 가져올 원격 본문이 없다", () => {
    expect(hrefsOf("[다른 노트](note://abc) 와 [진짜 링크](https://a.com)")).toEqual(["https://a.com"]);
  });

  it("링크가 없으면 빈 배열", () => {
    expect(hrefsOf("그냥 문장입니다")).toEqual([]);
  });

  it("범위 밖 링크는 세지 않는다", () => {
    const ed = createMarkdownEditor("[a](https://a.com)\n\n[b](https://b.com)");
    try {
      const firstPara = ed.state.doc.child(0);
      expect(linkHrefsInRange(ed.state.doc, 0, firstPara.nodeSize)).toEqual(["https://a.com"]);
    } finally {
      ed.destroy();
    }
  });
});
