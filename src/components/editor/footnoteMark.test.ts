/**
 * Footnote mark wire format + applyFootnoteFromSelection — Wave 4 L2.
 * body_md: `<span data-footnote="<attachment-id>">anchored text</span>`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  BriseFootnote,
  FootnoteMark,
  FOOTNOTE_FLASH_MS,
  FOOTNOTE_HOT_CLASS,
  applyFootnoteFromSelection,
  findFootnoteRanges,
  findFootnoteSectionId,
  hotFootnoteId,
  revealFootnoteInEditor,
  setHoveredFootnote,
  subscribeFootnoteSignal,
} from "./footnoteMark";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  callSilent: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  emitNotice: (message: string) => emitNoticeMock(message),
  // stores/ai.ts now imports lib/undo.ts (W6 folder-move undo toast), which registers a flush
  // callback at module load — the mock needs the export even though this file never exercises it.
  registerFlush: vi.fn(),
}));

const ensureMaterializedMock = vi.fn();
const reloadActiveMock = vi.fn();
let storeSections: { id: string; body_md: string }[] = [];
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      ensureMaterialized: () => ensureMaterializedMock(),
      reloadActive: () => reloadActiveMock(),
      activeNote: { note: { id: "note-1" }, sections: storeSections },
    }),
  },
}));

const navigateToSectionMock = vi.fn();
vi.mock("../../lib/presetBridge", () => ({
  navigateToSection: (id: string) => navigateToSectionMock(id),
}));

const setPreviewItemMock = vi.fn();
vi.mock("../../stores/ui", () => ({
  useUiStore: {
    getState: () => ({
      setPreviewItem: (...args: unknown[]) => setPreviewItemMock(...args),
    }),
  },
}));

vi.mock("../../i18n/t", () => ({
  t: (k: string) => k,
}));

function makeEditor(content = "<p>hello world</p>") {
  return new Editor({
    extensions: [StarterKit.configure({ link: false }), Markdown, FootnoteMark],
    content,
  });
}

beforeEach(() => {
  callMock.mockReset();
  emitNoticeMock.mockClear();
  ensureMaterializedMock.mockReset();
  ensureMaterializedMock.mockResolvedValue("note-1");
  reloadActiveMock.mockReset();
  reloadActiveMock.mockResolvedValue(undefined);
  callMock.mockResolvedValue({
    id: "att-99",
    name: "fn.md",
    kind: "footnote",
    rel_path: "x.md",
    url: "hello",
    size_bytes: null,
    position: 0,
  });
});

describe("footnoteMark — SSOT alignment", () => {
  it("re-exports BriseFootnote and FootnoteMark share name 'footnote'", () => {
    expect(BriseFootnote.name).toBe("footnote");
    expect(FootnoteMark.name).toBe("footnote");
  });

  it("parses span[data-footnote] into mark attrs.id", () => {
    const ed = makeEditor('<p><span data-footnote="abc-123">hello</span></p>');
    let id: string | null = null;
    let text = "";
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "footnote");
      if (mark) {
        id = mark.attrs.id as string;
        text += node.text ?? "";
      }
    });
    ed.destroy();
    expect(id).toBe("abc-123");
    expect(text).toBe("hello");
  });

  it("setMark applies id; getMarkdown emits HTML island", () => {
    const ed = makeEditor("<p>hello world</p>");
    // "hello" is positions 1..6 in a single-paragraph doc
    ed.commands.setTextSelection({ from: 1, to: 6 });
    ed.chain().setMark("footnote", { id: "fn-xyz" }).run();

    let id: string | null = null;
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "footnote");
      if (mark) id = mark.attrs.id as string;
    });
    expect(id).toBe("fn-xyz");

    const md = typeof ed.getMarkdown === "function" ? ed.getMarkdown() : "";
    expect(md).toContain('data-footnote="fn-xyz"');
    expect(md).toContain("hello");
    // Must not invent a different attribute name
    expect(md).not.toContain("data-fn=");
    ed.destroy();
  });

  it("renderHTML keeps data-footnote on the span", () => {
    const ed = makeEditor('<p><span data-footnote="id-1">x</span></p>');
    const html = ed.getHTML();
    expect(html).toContain('data-footnote="id-1"');
    expect(html).toContain("brise-footnote");
    ed.destroy();
  });

  it("clicking a marker asks for the footnotes LIST focused on that id", () => {
    // Single list view (no per-attachment footnote preview) — the id travels as focusId so the
    // list scrolls to + highlights that entry. A {kind:"attachment"} payload here would reopen
    // the removed detail mode.
    setPreviewItemMock.mockClear();
    const ed = makeEditor('<p><span data-footnote="abc-123">hello</span></p>');
    const span = ed.view.dom.querySelector("span[data-footnote]") as HTMLElement;
    span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setPreviewItemMock).toHaveBeenCalledWith({ kind: "footnotes", focusId: "abc-123" });
    ed.destroy();
  });

  it("mark schema has inclusive: false", () => {
    const ed = makeEditor();
    const markType = ed.schema.marks.footnote;
    expect(markType).toBeTruthy();
    expect(markType.spec.inclusive).toBe(false);
    ed.destroy();
  });
});

describe("각주 앵커 찾기 · hover/점프 브리지", () => {
  const MARKED = '<p>a <span data-footnote="abc-123">hello</span> b</p>';

  beforeEach(() => {
    storeSections = [];
    navigateToSectionMock.mockReset();
    navigateToSectionMock.mockResolvedValue(undefined);
  });

  // hover 는 모듈 전역 — 테스트끼리 새면 다음 테스트의 데코레이션 판정이 오염된다.
  afterEach(() => {
    setHoveredFootnote(null);
  });

  it("findFootnoteRanges: 활성 문서에 있으면 마크 범위를, 없으면 빈 배열을 준다", () => {
    const ed = makeEditor(MARKED);
    const ranges = findFootnoteRanges(ed.state.doc, "abc-123");
    expect(ranges).toHaveLength(1);
    expect(ed.state.doc.textBetween(ranges[0].from, ranges[0].to)).toBe("hello");
    expect(findFootnoteRanges(ed.state.doc, "other-id")).toEqual([]);
    ed.destroy();
  });

  it("findFootnoteSectionId: 다른 섹션의 body_md 에서 찾고, 없으면 null", () => {
    const sections = [
      { id: "sec-1", body_md: "plain text" },
      { id: "sec-2", body_md: 'x <span data-footnote="abc-123">hello</span> y' },
    ];
    expect(findFootnoteSectionId(sections, "abc-123")).toBe("sec-2");
    expect(findFootnoteSectionId(sections, "nope")).toBeNull();
  });

  it("hover 하면 그 앵커만 강조되고, 벗어나면 사라진다", () => {
    const ed = makeEditor(MARKED);
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)).toBeNull();

    setHoveredFootnote("abc-123");
    const hot = ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`);
    expect(hot?.textContent).toBe("hello");

    setHoveredFootnote(null);
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)).toBeNull();
    ed.destroy();
  });

  it("다른 섹션의 각주를 hover 해도 현재 문서는 아무 반응이 없다(섹션 전환 없음)", () => {
    const ed = makeEditor(MARKED);
    setHoveredFootnote("lives-elsewhere");
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)).toBeNull();
    expect(navigateToSectionMock).not.toHaveBeenCalled();
    ed.destroy();
  });

  it("클릭 점프: 앵커가 있는 섹션으로 전환하고 캐럿을 앵커로 옮기며 잠깐 강조한다", async () => {
    storeSections = [
      { id: "sec-1", body_md: "nothing here" },
      { id: "sec-2", body_md: '<span data-footnote="abc-123">hello</span>' },
    ];
    const ed = makeEditor(MARKED);
    ed.commands.setTextSelection(1);

    await revealFootnoteInEditor("abc-123");

    expect(navigateToSectionMock).toHaveBeenCalledWith("sec-2");
    // 앵커 텍스트 "hello" 는 "a " 다음 — 접힌 selection 이어야 BubbleMenu 가 뜨지 않는다.
    expect(ed.state.selection.empty).toBe(true);
    expect(ed.state.selection.from).toBe(3);
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)?.textContent).toBe("hello");
    ed.destroy();
  });

  it("어느 섹션에서도 못 찾으면 전환 없이 요청만 보낸다(활성 섹션 store 사본이 낡은 경우)", async () => {
    storeSections = [{ id: "sec-1", body_md: "stale copy without the anchor" }];
    const ed = makeEditor(MARKED);

    await revealFootnoteInEditor("abc-123");

    expect(navigateToSectionMock).not.toHaveBeenCalled();
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)?.textContent).toBe("hello");
    ed.destroy();
  });

  it("사라진 마크로 점프해도 조용히 아무것도 하지 않는다", async () => {
    const ed = makeEditor("<p>no footnote here</p>");
    await expect(revealFootnoteInEditor("gone-id")).resolves.toBeUndefined();
    expect(ed.view.dom.querySelector(`.${FOOTNOTE_HOT_CLASS}`)).toBeNull();
    ed.destroy();
  });

  it("점프 강조는 시간이 지나면 저절로 꺼진다", async () => {
    vi.useFakeTimers();
    try {
      await revealFootnoteInEditor("abc-123");
      expect(hotFootnoteId()).toBe("abc-123");
      vi.advanceTimersByTime(FOOTNOTE_FLASH_MS + 1);
      expect(hotFootnoteId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("구독 해제하면 더 이상 신호가 오지 않는다(언마운트 누수 방지)", () => {
    const fn = vi.fn();
    const off = subscribeFootnoteSignal(fn);
    setHoveredFootnote("abc-123");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setHoveredFootnote(null);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("applyFootnoteFromSelection", () => {
  it("calls attachment_add_footnote then setMark with returned id", async () => {
    const ed = makeEditor("<p>hello world</p>");
    ed.commands.setTextSelection({ from: 1, to: 6 });

    await applyFootnoteFromSelection(ed, { from: 1, to: 6 }, "body of footnote");

    expect(ensureMaterializedMock).toHaveBeenCalled();
    expect(callMock).toHaveBeenCalledWith("attachment_add_footnote", {
      note_id: "note-1",
      text: "body of footnote",
      anchor_text: "hello",
    });

    let id: string | null = null;
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "footnote");
      if (mark) id = mark.attrs.id as string;
    });
    expect(id).toBe("att-99");
    // reloadActive must run AFTER the mark is applied — it's what refreshes activeNote.attachments
    // (AttachmentsBar/previewResolver) and, per the invocation order here, would only ever observe
    // a doc that already has the mark (flushRef reads the live editor before reloadActive refetches).
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
    ed.destroy();
  });

  it("skips setMark when editor is destroyed after await", async () => {
    let resolveCall: (v: unknown) => void = () => {};
    const callPromise = new Promise((r) => {
      resolveCall = r;
    });
    callMock.mockReturnValue(callPromise);

    const ed = makeEditor("<p>hello world</p>");
    ed.commands.setTextSelection({ from: 1, to: 6 });

    const pending = applyFootnoteFromSelection(ed, { from: 1, to: 6 }, "body");
    ed.destroy();
    resolveCall({
      id: "att-late",
      name: "fn.md",
      kind: "footnote",
      rel_path: null,
      url: null,
      size_bytes: null,
      position: 0,
    });
    await pending;

    // Destroyed editor must not throw; mark application (and the reload that would follow it)
    // skipped entirely.
    expect(ed.isDestroyed).toBe(true);
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  it("no-ops on empty body text without calling IPC", async () => {
    const ed = makeEditor("<p>hello world</p>");
    await applyFootnoteFromSelection(ed, { from: 1, to: 6 }, "   ");
    expect(callMock).not.toHaveBeenCalled();
    ed.destroy();
  });

  it("emits notice when no note can be materialized", async () => {
    ensureMaterializedMock.mockResolvedValue(null);
    const ed = makeEditor("<p>hello world</p>");
    await applyFootnoteFromSelection(ed, { from: 1, to: 6 }, "body");
    expect(callMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith("editor.note_required_for_section");
    ed.destroy();
  });
});
