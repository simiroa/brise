import { beforeEach, describe, expect, it, vi } from "vitest";

const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  flushAll: async () => {},
  emitNotice: vi.fn(),
  registerFlush: () => () => {},
}));
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", async (orig) => ({
  ...(await orig<typeof import("../../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

import { applyFootnotes, collectFootnoteIds, footnotePlainText, loadFootnoteBodies } from "./exportFootnotes";

type Mark = { type: string; attrs?: Record<string, unknown> };
const text = (t: string, marks?: Mark[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const fn = (id: string): Mark => ({ type: "footnote", attrs: { id } });
const bold: Mark = { type: "bold" };
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });

/** 문단 하나의 글자를 이어 붙인다(hardBreak = \n). */
function paraText(p: { content?: { type: string; text?: string }[] }): string {
  return (p.content ?? []).map((n) => (n.type === "hardBreak" ? "\n" : n.text ?? "")).join("");
}

describe("collectFootnoteIds", () => {
  it("lists footnote ids in document order without duplicates, across docs when out/seen are shared", () => {
    const a = doc(para(text("가", [fn("f2")]), text("나")), { type: "table", content: [{ type: "tableRow", content: [
      { type: "tableCell", content: [para(text("칸", [fn("f1")]))] },
    ] }] }, para(text("다", [fn("f2")])));
    const b = doc(para(text("라", [fn("f3")]), text("마", [fn("f1")])));
    const out: string[] = [];
    const seen = new Set<string>();
    collectFootnoteIds(a, out, seen);
    collectFootnoteIds(b, out, seen);
    expect(out).toEqual(["f2", "f1", "f3"]);
    expect(collectFootnoteIds(doc(para(text("x")), para(text("y", [{ type: "footnote", attrs: { id: null } }]))))).toEqual([]);
  });
});

describe("applyFootnotes", () => {
  it("puts [n] right after the footnoted text and the list at the end, numbering in order of first appearance", () => {
    const d = doc(para(text("서울", [fn("a")]), text("과 "), text("부산", [fn("b")]), text(" 출장")));
    const res = applyFootnotes([d], { a: "서울 본사", b: "부산 지점" }, "각주");
    const out = res!.docs[0] as ReturnType<typeof doc>;
    expect(paraText(out.content[0] as never)).toBe("서울[1]과 부산[2] 출장");
    expect(out.content[1]).toEqual({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "각주" }] });
    expect(paraText(out.content[2] as never)).toBe("[1] 서울 본사");
    expect(paraText(out.content[3] as never)).toBe("[2] 부산 지점");
    expect(out.content).toHaveLength(4);
    // [n] 은 일반 글자 — 각주 마크가 붙지 않는다(마크가 붙으면 다시 각주 섬이 된다). 원래 각주 마크는 남는다.
    const marker = (out.content[0] as { content: { text: string; marks?: Mark[] }[] }).content[1];
    expect(marker).toEqual({ type: "text", text: "[1]" });
    expect((out.content[0] as { content: { marks?: Mark[] }[] }).content[0].marks).toEqual([fn("a")]);
  });

  it("one footnote spanning several text nodes (part bold) gets ONE marker, after the last piece", () => {
    const d = doc(para(text("반은 ", [fn("a")]), text("굵게", [bold, fn("a")]), text(" 끝")));
    const out = applyFootnotes([d], { a: "x" }, "각주")!.docs[0] as ReturnType<typeof doc>;
    expect(paraText(out.content[0] as never)).toBe("반은 굵게[1] 끝");
  });

  it("a line break (or inline image) inside the footnoted span carries the mark too — still ONE marker, at the end", () => {
    const d = doc(para(
      text("서울", [fn("a")]),
      { type: "hardBreak", marks: [fn("a")] },
      text("본사", [fn("a")]),
      text(" 끝"),
    ));
    const out = applyFootnotes([d], { a: "x" }, "각주")!.docs[0] as ReturnType<typeof doc>;
    expect(paraText(out.content[0] as never)).toBe("서울\n본사[1] 끝");
  });

  it("the same footnote appearing again reuses its number; two adjacent different footnotes get their own", () => {
    const d = doc(
      para(text("A", [fn("a")]), text("B", [fn("b")])),
      para(text("다시 A", [fn("a")])),
    );
    const out = applyFootnotes([d], { a: "에이", b: "비" }, "각주")!.docs[0] as ReturnType<typeof doc>;
    expect(paraText(out.content[0] as never)).toBe("A[1]B[2]");
    expect(paraText(out.content[1] as never)).toBe("다시 A[1]");
    // 목록은 각주 하나에 한 항목
    expect(out.content.slice(3).map((p) => paraText(p as never))).toEqual(["[1] 에이", "[2] 비"]);
  });

  it("numbers across the picked sections and puts the list only at the end of the LAST one", () => {
    const first = doc(para(text("첫", [fn("x")])));
    const middle = doc(para(text("각주 없음")));
    const last = doc(para(text("둘", [fn("y")])), para(text("또 첫", [fn("x")])));
    const res = applyFootnotes([first, middle, last], { x: "엑스", y: "와이" }, "각주")!;
    expect(res.changed).toEqual([true, false, true]);
    expect(res.docs[1]).toBe(middle); // 안 바뀐 문서는 같은 객체
    const a = res.docs[0] as ReturnType<typeof doc>;
    const c = res.docs[2] as ReturnType<typeof doc>;
    expect(a.content).toHaveLength(1); // 목록은 첫 섹션에 없다
    expect(paraText(a.content[0] as never)).toBe("첫[1]");
    expect(paraText(c.content[0] as never)).toBe("둘[2]");
    expect(paraText(c.content[1] as never)).toBe("또 첫[1]");
    expect(c.content.slice(2).map((n) => (n as { type: string }).type)).toEqual(["heading", "paragraph", "paragraph"]);
    expect(c.content.slice(3).map((p) => paraText(p as never))).toEqual(["[1] 엑스", "[2] 와이"]);
  });

  it("adds the list to the last section even when that section has no footnotes of its own", () => {
    const res = applyFootnotes([doc(para(text("a", [fn("a")]))), doc(para(text("끝")))], { a: "본문" }, "Notes")!;
    expect(res.changed).toEqual([true, true]);
    const last = res.docs[1] as ReturnType<typeof doc>;
    expect(paraText(last.content[0] as never)).toBe("끝");
    expect(paraText(last.content[1] as never)).toBe("Notes");
    expect(paraText(last.content[2] as never)).toBe("[1] 본문");
  });

  it("a footnote whose body could not be read still gets its number; multi-line bodies use line breaks", () => {
    const d = doc(para(text("a", [fn("missing")]), text("b", [fn("multi")])));
    const out = applyFootnotes([d], { multi: "첫 줄\n둘째 줄" }, "각주")!.docs[0] as ReturnType<typeof doc>;
    const list = out.content.slice(2) as { content: { type: string; text?: string }[] }[];
    expect(list[0].content).toEqual([{ type: "text", text: "[1]" }]);
    expect(list[1].content).toEqual([{ type: "text", text: "[2] 첫 줄" }, { type: "hardBreak" }, { type: "text", text: "둘째 줄" }]);
  });

  it("returns null when there are no footnotes, and never mutates the input documents", () => {
    expect(applyFootnotes([doc(para(text("그냥")))], {}, "각주")).toBeNull();
    expect(applyFootnotes([], {}, "각주")).toBeNull();
    const d = doc(para(text("서울", [fn("a")]), text(" 끝")), { type: "bulletList", content: [
      { type: "listItem", content: [para(text("항목", [fn("b")]))] },
    ] });
    const before = JSON.stringify(d);
    const bodies = { a: "가", b: "나" };
    applyFootnotes([d], bodies, "각주");
    expect(JSON.stringify(d)).toBe(before);
    expect(bodies).toEqual({ a: "가", b: "나" });
  });

  it("skips the heading when it is empty (no empty text node)", () => {
    const out = applyFootnotes([doc(para(text("a", [fn("a")])))], { a: "본문" }, "")!.docs[0] as ReturnType<typeof doc>;
    expect(out.content.map((n) => (n as { type: string }).type)).toEqual(["paragraph", "paragraph"]);
  });
});

describe("footnotePlainText", () => {
  it("strips markdown to plain text, one line per block, dropping blank lines", () => {
    expect(footnotePlainText("**굵게** 그리고 [링크](https://x.test)\n\n- 하나\n- 둘")).toBe("굵게 그리고 링크\n하나\n둘");
    expect(footnotePlainText("")).toBe("");
    expect(footnotePlainText("   \n  ")).toBe("");
  });
});

describe("loadFootnoteBodies", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    reportFallbackMock.mockReset();
  });

  it("reads each footnote over attachment_read_text, flattens it, marks a truncated body, and records failures", async () => {
    callSilentMock.mockImplementation(async (cmd: string, args: { id: string }) => {
      if (cmd !== "attachment_read_text") throw new Error(`unexpected ${cmd}`);
      if (args.id === "ok") return { text: "*기울임* 본문", truncated: false };
      if (args.id === "big") return { text: "앞부분", truncated: true };
      throw { code: "NOT_FOUND", message: "gone" };
    });
    const bodies = await loadFootnoteBodies(["ok", "big", "gone"]);
    expect(bodies).toEqual({ ok: "기울임 본문", big: "앞부분…" });
    expect(callSilentMock).toHaveBeenCalledWith("attachment_read_text", { id: "ok" });
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock.mock.calls[0].slice(0, 2)).toEqual(["export", "footnote_read_failed"]);
  });
});
