import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { canonicalImportBody, textToParagraphs } from "./mobileImportBody";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { MARKDOWN_SET_CONTENT_OPTIONS, mdSerializeEditor } from "../lib/mdSerialize";

/** 입력 화면이 하는 그대로: body_md 를 칠하고(setContent, update 없음) flush 가 다시 직렬화한다. */
function paint(bodyMd: string): { text: string; reserialized: string; hrefs: string[] } {
  const ed = new Editor({ extensions: createMobileSchemaExtensions() });
  try {
    ed.commands.setContent(bodyMd, MARKDOWN_SET_CONTENT_OPTIONS);
    const hrefs: string[] = [];
    ed.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(String(m.attrs.href));
    });
    return { text: ed.getText(), reserialized: mdSerializeEditor(ed), hrefs };
  } finally {
    ed.destroy();
  }
}

/** 손대지 않은 초안이 flush 에서 노트를 만들지 않으려면 이 값이 body_md 와 같아야 한다. */
const STABLE_SAMPLES: Record<string, string> = {
  "일반 글": "오늘의 메모 🙂\n장소: 제주도 한림읍",
  "여러 줄·빈 줄": "첫째 줄\n둘째 줄\n\n\n셋째 줄",
  "별표·밑줄·백틱·대괄호": "*foo* and **bar** snake_case_name `code` [x](y) ![img](z)",
  "꺾쇠·앰퍼샌드": "<div>hi</div> and a < b and 5 & 6",
  "CRLF + 앞 공백": "  들여쓰기\r\n    네 칸 들여쓰기\r\n끝  ",
  "URL 하나": "https://example.com/post/42",
  "제목 + URL": "재미있는 기사\nhttps://example.com/post/42",
  "글 속 URL + 문장부호": "한글 https://m.blog.naver.com/abc/223 끝. see (https://example.com/x).",
  // 에디터가 스스로 링크로 읽는 글 — 날것으로 두면 첫 flush 가 `[..](mailto:..)` 로 다시 써 노트가 생긴다(고정점 쫓기, mobileImportBody.ts 머리말).
  "이메일 주소": "contact foo@example.com",
  "이메일 하나": "foo@example.com",
  "한글 문장 속 이메일": "문의는 홍길동 foo@example.com 으로 주세요",
  "밑줄이 든 이메일": "mail me at foo_bar@example.com",
  "점·플러스·하이픈 이메일": "a.b+c@ex-ample.co.kr",
  "www 주소": "www.example.com/page",
  "문장 끝 구두점이 붙은 www 주소": "see www.example.com/page.",
  "이메일 + www 한 줄": "a@b.co and www.x.org",
  "ftp 주소": "ftp://foo.com/a",
  "mailto:": "mailto:foo@example.com",
  // `_`·`&` 가 든 URL — 직렬화기가 링크 글자를 이스케이프하지만 그 모양을 다시 칠해도 보이는 글자가 같아 고정점이다.
  "밑줄·앰퍼샌드 URL(유튜브)": "https://youtu.be/abc_DEF?si=Zx_9&t=10s",
  "UTM URL": "제목\nhttps://x.com/?utm_source=x&utm_medium=y",
  "해시에 밑줄이 든 URL": "https://x.com/#a_b",
};

describe("canonicalImportBody — 손대지 않은 초안은 flush 가 같은 문자열을 돌려준다", () => {
  for (const [name, text] of Object.entries(STABLE_SAMPLES)) {
    it(`${name}: stable 이고 칠하기 왕복이 그대로`, () => {
      const r = canonicalImportBody(text);
      expect(r.bodyMd.length).toBeGreaterThan(0);
      expect(r.stable).toBe(true);
      // 읽기 전용으로 열리면 입력 화면이 비어 보인다(편집 불가 안내) — 평범한 공유는 반드시 편집 가능해야 한다.
      expect(r.editable).toBe(true);
      expect(paint(r.bodyMd).reserialized).toBe(r.bodyMd);
      // 보이는 글자는 원문 그대로다(이스케이프 기호·`&amp;` 가 새어 나오지 않는다) — 마크다운으로 읽혀 글자가 사라지는 일도 없다.
      expect(paint(r.bodyMd).text.replace(/\n+/g, "\n")).toBe(textToParagraphs(text).join("\n"));
    });
  }

  it("빈 문자열·공백뿐이면 빈 본문", () => {
    expect(canonicalImportBody("")).toEqual({ bodyMd: "", stable: true, editable: true });
    expect(canonicalImportBody(" \n\r\n  ")).toEqual({ bodyMd: "", stable: true, editable: true });
  });
});

describe("canonicalImportBody — 화면에 보이는 글자", () => {
  it("줄마다 문단 — 빈 줄은 접고 줄 앞뒤 공백은 버린다", () => {
    expect(textToParagraphs("a\r\n\n  b  \n\n\nc")).toEqual(["a", "b", "c"]);
    expect(canonicalImportBody("a\n\n\nb").bodyMd.split(/\n{2,}/)).toEqual(["a", "b"]);
  });

  it("마크다운 강조 기호는 글자 그대로 남는다(기울임·굵게로 읽히지 않는다)", () => {
    const { text } = paint(canonicalImportBody("*foo* and **bar** a_b_c").bodyMd);
    expect(text).toBe("*foo* and **bar** a_b_c");
  });

  it("URL 은 링크가 되고 글자·목적지가 원문 그대로다", () => {
    const r = canonicalImportBody("제목\nhttps://example.com/post/42");
    expect(r.bodyMd).toBe("제목\n\n[https://example.com/post/42](https://example.com/post/42)");
    const p = paint(r.bodyMd);
    expect(p.text).toBe("제목\n\nhttps://example.com/post/42");
    expect(p.hrefs).toEqual(["https://example.com/post/42"]);
  });

  it("문장 끝 구두점은 URL 에 넣지 않는다", () => {
    const r = canonicalImportBody("https://example.com/x.");
    expect(r.bodyMd).toBe("[https://example.com/x](https://example.com/x).");
    expect(paint(r.bodyMd).hrefs).toEqual(["https://example.com/x"]);
  });
});

describe("canonicalImportBody — 폰 에디터가 못 여는 모양(editable=false)", () => {
  it("마크다운 표처럼 보이는 글·==강조==·:::details 는 읽기 전용으로 열린다 — 본문은 그대로 담긴다", () => {
    const samples = ["| a | b |\n|---|---|\n| 1 | 2 |", "이건 ==중요== 합니다", ":::details\n내용"];
    for (const text of samples) {
      const r = canonicalImportBody(text);
      expect(r.editable, text).toBe(false);
      expect(r.bodyMd.length).toBeGreaterThan(0);
    }
  });
});

describe("canonicalImportBody — 에디터가 스스로 링크로 읽는 글 (고정점 쫓기)", () => {
  it("이메일은 에디터가 쓰는 모양(`[주소](mailto:주소)`)이 본문이 되고, 보이는 글자는 원문 그대로다", () => {
    const r = canonicalImportBody("contact foo@example.com");
    expect(r.bodyMd).toBe("contact [foo@example.com](mailto:foo@example.com)");
    expect(r.stable).toBe(true);
    const p = paint(r.bodyMd);
    expect(p.text).toBe("contact foo@example.com");
    expect(p.hrefs).toEqual(["mailto:foo@example.com"]);
  });

  it("www 주소는 http:// 목적지의 링크가 되고 보이는 글자는 원문 그대로다", () => {
    const r = canonicalImportBody("see www.example.com/page.");
    expect(r.bodyMd).toBe("see [www.example.com/page](http://www.example.com/page).");
    expect(r.stable).toBe(true);
    expect(paint(r.bodyMd).text).toBe("see www.example.com/page.");
  });

  // 예전엔 stable=false 로 남겨 두던 글 — 에디터가 이스케이프한 모양(`\_`·`&amp;`)을 다시 칠해도 글자·목적지가 같아 고정점이다.
  for (const url of ["https://example.com/a_b_c?x=1&y=2", "https://youtu.be/abc_DEF?si=Zx_9&t=10s"]) {
    it(`${url}: stable 이고 글자·목적지는 원문 그대로`, () => {
      const r = canonicalImportBody(url);
      expect(r.stable).toBe(true);
      expect(r.editable).toBe(true); // 마크다운 링크는 편집 가능이다(canEditBodyOnMobile 이 막지 않는다)
      const p = paint(r.bodyMd);
      expect(p.reserialized).toBe(r.bodyMd);
      expect(p.text).toBe(url);
      expect(p.hrefs).toEqual([url]);
      expect(p.text).not.toContain("\\");
      expect(p.text).not.toContain("&amp;");
    });
  }

  it("괄호가 든 URL 도 에디터가 쓰는 링크 모양으로 굳고 글자·목적지가 그대로다", () => {
    const url = "https://example.com/p/(x)";
    const r = canonicalImportBody(url);
    expect(r.stable).toBe(true);
    const p = paint(r.bodyMd);
    expect(p.reserialized).toBe(r.bodyMd);
    expect(p.text).toBe(url);
    expect(p.hrefs).toEqual([url]);
  });

  it("고정점이 없는 글(URL 안의 백틱)은 던지지 않고 stable:false 로 알린다", () => {
    const r = canonicalImportBody("https://x.com/a`b");
    expect(r.stable).toBe(false);
    expect(r.bodyMd.length).toBeGreaterThan(0);
  });
});
