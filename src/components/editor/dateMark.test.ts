/**
 * Date mark wire format + click → openDateEntry — PLAN-2026-09-18-nl-dates.md §W3a.
 * body_md: `<span data-date="<note_dates id>">anchored text</span>`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { BriseDateMark, DateMark, findDateMarkRanges } from "./dateMark";

const openDateEntryMock = vi.fn();
vi.mock("../../lib/dateEntryBridge", () => ({
  openDateEntry: (...args: unknown[]) => openDateEntryMock(...args),
}));

let activeNoteId: string | null = "note-1";
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: activeNoteId ? { note: { id: activeNoteId } } : null,
    }),
  },
}));

function makeEditor(content = "<p>hello world</p>") {
  return new Editor({
    extensions: [StarterKit.configure({ link: false }), Markdown, DateMark],
    content,
  });
}

beforeEach(() => {
  openDateEntryMock.mockReset();
  activeNoteId = "note-1";
});

describe("dateMark — SSOT alignment", () => {
  it("re-exports BriseDateMark and DateMark share name 'date'", () => {
    expect(BriseDateMark.name).toBe("date");
    expect(DateMark.name).toBe("date");
  });

  it("parses span[data-date] into mark attrs.id", () => {
    const ed = makeEditor('<p><span data-date="date-123">tomorrow</span></p>');
    let id: string | null = null;
    let text = "";
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "date");
      if (mark) {
        id = mark.attrs.id as string;
        text += node.text ?? "";
      }
    });
    ed.destroy();
    expect(id).toBe("date-123");
    expect(text).toBe("tomorrow");
  });

  it("setMark applies id; getMarkdown emits HTML island", () => {
    const ed = makeEditor("<p>hello world</p>");
    // "hello" is positions 1..6 in a single-paragraph doc
    ed.commands.setTextSelection({ from: 1, to: 6 });
    ed.chain().setMark("date", { id: "date-xyz" }).run();

    let id: string | null = null;
    ed.state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "date");
      if (mark) id = mark.attrs.id as string;
    });
    expect(id).toBe("date-xyz");

    const md = typeof ed.getMarkdown === "function" ? ed.getMarkdown() : "";
    expect(md).toContain('data-date="date-xyz"');
    expect(md).toContain("hello");
    // Must not collide with footnote's attribute name.
    expect(md).not.toContain("data-footnote=");
    ed.destroy();
  });

  it("renderHTML keeps data-date on the span, distinct class from footnote", () => {
    const ed = makeEditor('<p><span data-date="id-1">x</span></p>');
    const html = ed.getHTML();
    expect(html).toContain('data-date="id-1"');
    expect(html).toContain("brise-date-mark");
    ed.destroy();
  });

  it("mark schema has inclusive: false", () => {
    const ed = makeEditor();
    const markType = ed.schema.marks.date;
    expect(markType).toBeTruthy();
    expect(markType.spec.inclusive).toBe(false);
    ed.destroy();
  });

  it("findDateMarkRanges: 문서에 있으면 마크 범위를, 없으면 빈 배열을 준다", () => {
    const ed = makeEditor('<p>a <span data-date="date-123">tomorrow</span> b</p>');
    const ranges = findDateMarkRanges(ed.state.doc, "date-123");
    expect(ranges).toHaveLength(1);
    expect(ed.state.doc.textBetween(ranges[0].from, ranges[0].to)).toBe("tomorrow");
    expect(findDateMarkRanges(ed.state.doc, "other-id")).toEqual([]);
    ed.destroy();
  });

  it("clicking a marker opens the date entry popover pre-selected on that row", () => {
    const ed = makeEditor('<p><span data-date="date-123">tomorrow</span></p>');
    const span = ed.view.dom.querySelector("span[data-date]") as HTMLElement;
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 42, clientY: 84 }));

    expect(openDateEntryMock).toHaveBeenCalledTimes(1);
    const payload = openDateEntryMock.mock.calls[0][0];
    expect(payload.noteId).toBe("note-1");
    expect(payload.editRowId).toBe("date-123");
    expect(payload.anchorX).toBe(42);
    expect(payload.anchorY).toBe(90); // clientY + 6, same offset idiom as slashCommand.tsx
    expect(payload.range).toEqual({ from: 1, to: 9 }); // "tomorrow" (8 chars) spans 1..9 in this doc
    ed.destroy();
  });

  it("clicking without an active note no-ops (no popover, no throw)", () => {
    activeNoteId = null;
    const ed = makeEditor('<p><span data-date="date-123">tomorrow</span></p>');
    const span = ed.view.dom.querySelector("span[data-date]") as HTMLElement;
    expect(() =>
      span.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 })),
    ).not.toThrow();
    expect(openDateEntryMock).not.toHaveBeenCalled();
    ed.destroy();
  });

  it("clicking plain text (no data-date) does not open the popover", () => {
    const ed = makeEditor("<p>no date mark here</p>");
    ed.view.dom.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(openDateEntryMock).not.toHaveBeenCalled();
    ed.destroy();
  });
});
