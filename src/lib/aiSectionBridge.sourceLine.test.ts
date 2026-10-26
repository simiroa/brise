import { describe, it, expect } from "vitest";
import { withSourceLine } from "./aiSectionBridge";

// 출처 라벨 단어("출처"/"Source")는 로케일에 따라 갈리므로 고정하지 않는다 — 형식만 고정한다:
// 본문 뒤 빈 줄, 인용 블록 한 줄, "라벨: " 다음에 " · " 로 이은 목록.
const LINE = /\n\n> [^\n:]+: (.+)\n$/;

describe("withSourceLine", () => {
  it("링크 출처는 마크다운 링크가 된다", () => {
    const out = withSourceLine("본문", [{ label: "제목", url: "https://x.com/a" }]);
    expect(out.startsWith("본문")).toBe(true);
    expect(out.match(LINE)?.[1]).toBe("[제목](https://x.com/a)");
  });

  it("url 없는 출처는 이름만 남는다 — AskAi 첨부 파일처럼 노트에 남지 않는 재료", () => {
    const out = withSourceLine("본문", [{ label: "data.csv" }, { label: "메모.md" }]);
    expect(out.match(LINE)?.[1]).toBe("data.csv · 메모.md");
  });

  it("대괄호·줄바꿈은 공백으로 접는다 — 남의 제목/파일명이 마크다운을 깨뜨리지 않게", () => {
    const out = withSourceLine("본문", [{ label: "제목 [초안]\n2부", url: "https://x.com" }]);
    expect(out.match(LINE)?.[1]).toBe("[제목 초안 2부](https://x.com)");
  });

  it("출처가 없으면 본문을 그대로 둔다", () => {
    expect(withSourceLine("본문", [])).toBe("본문");
    expect(withSourceLine("본문", [{ label: "   " }])).toBe("본문");
  });
});
