import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { MARKDOWN_SET_CONTENT_OPTIONS, mdSerializeEditor } from "../lib/mdSerialize";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { snapshotCaretParagraph, applyDateMark, stripDateMark, replaceTagToken } from "./mobileNudgeApply";

function makeEditor(html: string): Editor {
  const ed = new Editor({ extensions: createMobileSchemaExtensions(), content: html });
  ed.commands.setTextSelection(ed.state.doc.content.size - 1);
  return ed;
}

describe("폰 입력 감지 적용 조각", () => {
  it("snapshotCaretParagraph: 커서 문단 텍스트·오프셋·기존 date 마크 범위", () => {
    const ed = makeEditor('<p>앞 <span data-date="d1">내일</span> 뒤</p>');
    const snap = snapshotCaretParagraph(ed)!;
    expect(snap.paraText).toBe("앞 내일 뒤");
    expect(snap.caret).toBe(snap.paraText.length);
    expect(snap.dateRanges).toEqual([[2, 4]]);
    ed.destroy();
  });

  it("snapshotCaretParagraph: 코드 블록 안에서는 감지하지 않는다(#include·URL 이 칩이 되지 않게)", () => {
    const ed = makeEditor("<pre><code>#include https://x.com 내일 3시</code></pre>");
    expect(snapshotCaretParagraph(ed)).toBeNull();
    ed.destroy();
  });

  it("applyDateMark: 매치 범위에 마크를 걸고 body_md 에 span 이 남는다 → stripDateMark 로 걷으면 글자만 남는다", () => {
    const ed = makeEditor("<p>내일 오후 3시 치과</p>");
    const snap = snapshotCaretParagraph(ed)!;
    expect(applyDateMark(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from: 0, to: 8 }, "id-1")).toBe(true);
    expect(mdSerializeEditor(ed)).toContain('<span data-date="id-1">내일 오후 3시</span>');
    stripDateMark(ed, "id-1");
    expect(mdSerializeEditor(ed)).not.toContain("data-date");
    expect(ed.getText()).toContain("내일 오후 3시 치과");
    ed.destroy();
  });

  it("applyDateMark: 그 자리 글자가 달라졌으면 아무것도 하지 않는다", () => {
    const ed = makeEditor("<p>내일 오후 3시 치과</p>");
    const snap = snapshotCaretParagraph(ed)!;
    ed.commands.insertContentAt(1, "XX");
    expect(applyDateMark(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from: 0, to: 8 }, "id-1")).toBe(false);
    expect(mdSerializeEditor(ed)).not.toContain("data-date");
    ed.destroy();
  });

  it("replaceTagToken: #질의 를 #태그 + 공백으로 바꾸고 커서를 뒤에 둔다", () => {
    const ed = makeEditor("<p>메모 #회</p>");
    const snap = snapshotCaretParagraph(ed)!;
    const from = snap.paraText.indexOf("#");
    expect(replaceTagToken(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from, to: snap.caret }, "회사")).toBe(true);
    expect(ed.state.doc.textContent).toBe("메모 #회사 ");
    expect(ed.state.selection.from).toBe(snap.paraStart + "메모 #회사 ".length);
    ed.destroy();
  });

  it("폰 스키마 왕복: 마크를 건 본문을 다시 열어도 앵커가 남는다", () => {
    const ed = makeEditor("<p>내일 치과</p>");
    const snap = snapshotCaretParagraph(ed)!;
    applyDateMark(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from: 0, to: 2 }, "x");
    const md = mdSerializeEditor(ed);
    const ed2 = new Editor({ extensions: createMobileSchemaExtensions(), content: "" });
    ed2.commands.setContent(md, MARKDOWN_SET_CONTENT_OPTIONS);
    expect(mdSerializeEditor(ed2)).toBe(md);
    ed.destroy();
    ed2.destroy();
  });

  it("IME 조합 중에는 칩을 눌러도 문서를 바꾸지 않는다", () => {
    const ed = makeEditor("<p>내일 오후 3시 치과 #강</p>");
    const snap = snapshotCaretParagraph(ed)!;
    const before = ed.getHTML();
    Object.defineProperty(ed.view, "composing", { get: () => true, configurable: true });
    expect(applyDateMark(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from: 0, to: 8 }, "id-1")).toBe(false);
    const from = snap.paraText.indexOf("#");
    expect(replaceTagToken(ed, { paraStart: snap.paraStart, paraText: snap.paraText, from, to: snap.paraText.length }, "강의")).toBe(false);
    expect(ed.getHTML()).toBe(before);
    ed.destroy();
  });
});
