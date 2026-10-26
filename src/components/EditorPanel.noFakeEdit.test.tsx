import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

const callMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({}));
vi.mock("../lib/invoke", async (orig) => {
  const actual = await orig<typeof import("../lib/invoke")>();
  return {
    ...actual,
    call: (cmd: string, args?: unknown) => callMock(cmd, args),
    callSilent: (cmd: string, args?: unknown) => callMock(cmd, args),
  };
});

import { EditorPanel } from "./EditorPanel";
import { loadExportDocs } from "./export/exportDoc";
import { useNotesStore } from "../stores/notes";
import { flushAll } from "../lib/invoke";
import { clearAllSaveFailures } from "../lib/sectionSaveFailures";
import type { NoteDetail } from "../lib/commands.gen";

/**
 * 가짜 편집(2026-10-18): 저장 경로는 에디터 직렬화를 **DB 원문**(sec.body)과 비교했다. 원문이 직렬화기의 정규형이
 * 아니면(옛 본문·AI/수집이 쓴 마크다운·역슬래시가 불던 색 글자) 손대지 않은 섹션도 다음 flushAll(내보내기 모달·
 * 새로고침의 pagehide·섹션/노트 전환·주기 스냅샷)에서 section_update 로 다시 쓰였다 — 활동 기록에 '편집'이 남고
 * 노트 수정 시각이 올랐다. 기준선은 "방금 칠한 문서" 다: 그 문서에서 바뀐 게 없으면 쓰지 않는다.
 */

// `* ` 글머리표는 직렬화기가 `- ` 로 쓴다 — 열어서 그대로 두기만 해도 직렬화 결과가 원문과 다른 본문.
const NON_CANONICAL = "* one\n* two";
// 실제 손상 본문과 같은 모양(합성): 색 글자 안 별표 앞 역슬래시가 이미 31개. 고치기 전에는 열어 두고 flush 만 해도 63개가 됐다.
const RUN31 = "\\".repeat(31) + "*";
const GROWN_COLOR_SPAN = `plain line\n\n<span style="color: rgb(78, 83, 92)">total${RUN31}${RUN31}9 won${RUN31}${RUN31}</span>`;

function makeNote(sections: Array<{ id: string; body: string }>): NoteDetail {
  return {
    note: {
      id: "n1",
      folder_id: "inbox1",
      title: "Title",
      year: 2026,
      month: 10,
      day: 18,
      is_favorite: false,
      content_locked: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
    },
    sections: sections.map((s, i) => ({ id: s.id, name: `S${i}`, body_md: s.body, position: i, kind: "text" })),
    sources: [],
    attachments: [],
  } as unknown as NoteDetail;
}

function liveEditor(container: HTMLElement): Editor {
  const dom = container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!dom?.editor) throw new Error("live editor not mounted");
  return dom.editor;
}

const sectionUpdates = () => callMock.mock.calls.filter(([cmd]) => cmd === "section_update");

describe("EditorPanel — 손대지 않은 섹션은 flush 가 다시 쓰지 않는다", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "section_update" ? { section_updated_at: "t1", updated_at: "t1" } : {},
    );
    clearAllSaveFailures();
  });

  it("정규형이 아닌 본문을 열고 flushAll 만 해도 section_update 가 나가지 않는다", async () => {
    useNotesStore.setState({
      activeNote: makeNote([{ id: "s1", body: NON_CANONICAL }]),
      activeDraft: false,
      savedState: "saved",
      isBooting: false,
    });
    const { unmount } = render(<EditorPanel />);
    await act(async () => {
      await flushAll();
      await flushAll();
    });
    expect(sectionUpdates()).toHaveLength(0);
    unmount();
  });

  it("진짜 편집은 그대로 저장되고, 저장 뒤 같은 내용의 flush 는 다시 쓰지 않는다", async () => {
    useNotesStore.setState({
      activeNote: makeNote([{ id: "s1", body: NON_CANONICAL }]),
      activeDraft: false,
      savedState: "saved",
      isBooting: false,
    });
    const { container, unmount } = render(<EditorPanel />);
    const editor = liveEditor(container);
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size, "<p>three</p>");
      await flushAll();
    });
    expect(sectionUpdates()).toHaveLength(1);
    expect(sectionUpdates()[0][1]).toEqual(expect.objectContaining({ id: "s1", body_md: expect.stringContaining("three") }));
    await act(async () => {
      await flushAll();
    });
    expect(sectionUpdates()).toHaveLength(1);
    unmount();
  });

  it.each([
    ["정규형이 아닌 본문", NON_CANONICAL, "one"],
    ["역슬래시가 불어 있던 색 글자", GROWN_COLOR_SPAN, "total"],
  ])("내보내기 모달이 여는 길(loadExportDocs → flushAll)이 %s 섹션을 다시 쓰지 않는다", async (_label, body, visible) => {
    const note = makeNote([
      { id: "s0", body: "other section" },
      { id: "s1", body },
    ]);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_get") return note;
      if (cmd === "section_update") return { section_updated_at: "t1", updated_at: "t1" };
      return {};
    });
    useNotesStore.setState({ activeNote: note, activeDraft: false, savedState: "saved", isBooting: false });
    const { container, unmount } = render(<EditorPanel />);
    expect(liveEditor(container).getText()).toContain(visible); // 마지막 섹션(s1)이 에디터에 떠 있다
    await act(async () => {
      const docs = await loadExportDocs("n1");
      expect(docs.sections).toHaveLength(2);
      await flushAll(); // 모달을 닫고 새로고침(pagehide)하는 길
    });
    expect(sectionUpdates()).toHaveLength(0);
    unmount();
  });

  it("편집했다가 원래대로 되돌리면(실행 취소) 쓰지 않는다", async () => {
    useNotesStore.setState({
      activeNote: makeNote([{ id: "s1", body: NON_CANONICAL }]),
      activeDraft: false,
      savedState: "saved",
      isBooting: false,
    });
    const { container, unmount } = render(<EditorPanel />);
    const editor = liveEditor(container);
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size, "<p>three</p>");
      editor.commands.undo();
      await flushAll();
    });
    expect(sectionUpdates()).toHaveLength(0);
    unmount();
  });
});
