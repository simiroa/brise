import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
const selectNote = vi.fn(async () => {});
const bumpAttachmentRevision = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: { note: { id: "note-1" } },
      selectNote,
      bumpAttachmentRevision,
      ensureMaterialized: vi.fn(async () => "note-1"),
    }),
  },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: { getState: () => ({ sourceOriginalPolicy: "discard" }) },
}));

import { useAttachmentActions, type Tile } from "./useAttachmentActions";
import { emitNotice } from "../../lib/invoke";
import type { Attachment, NoteDetail, Source } from "../../lib/commands.gen";

const source = (id: string): Tile => ({ kind: "source", source: { id, name: id } as Source });
const attachment = (id: string): Tile => ({ kind: "attachment", attachment: { id, name: id } as Attachment });

function setup() {
  return renderHook(() => useAttachmentActions({ note: { id: "note-1" } } as NoteDetail, vi.fn()));
}

describe("useAttachmentActions.removeTiles — 첨부 다중선택 일괄 삭제", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({}));
  });

  it("issues exactly one delete per selected tile, routed by tile kind, then refreshes once", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.removeTiles([source("s1"), attachment("a1"), attachment("a2")]);
    });

    const cmds = call.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["source_delete", "attachment_remove", "attachment_remove"]);
    expect(call.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual(["s1", "a1", "a2"]);
    // 배치당 재수화는 한 번 — 항목마다 selectNote 를 다시 돌리지 않는다.
    expect(selectNote).toHaveBeenCalledTimes(1);
  });

  it("skips the derived region tile (no DB row to delete)", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.removeTiles([{ kind: "region" }, attachment("a1")]);
    });
    expect(call.mock.calls.filter((c) => c[0] !== "note_get")).toHaveLength(1);
  });

  it("on a mid-batch failure: finishes the rest and reports ok/failed instead of pretending", async () => {
    call.mockImplementation(async (_cmd, args) => {
      if (args?.id === "a1") throw new Error("boom");
      return {};
    });
    const { result } = setup();
    let res: { ok: string[]; failed: string[] } | undefined;
    await act(async () => {
      res = await result.current.removeTiles([source("s1"), attachment("a1"), attachment("a2")]);
    });
    expect(call).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ ok: ["s1", "a2"], failed: ["a1"] });
  });
});

describe("useAttachmentActions.removeTile — 단일 삭제", () => {
  it("skips confirm dialog for internal attachment links and schedules undo", async () => {
    const setDialog = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentActions({ note: { id: "note-1" } } as NoteDetail, setDialog),
    );

    const internalTile: Tile = {
      kind: "attachment",
      attachment: { id: "att-internal-1", kind: "internal", name: "Target Note" } as Attachment,
    };

    const stopPropagation = vi.fn();
    await act(async () => {
      await result.current.removeTile(
        { stopPropagation } as unknown as React.MouseEvent,
        internalTile,
      );
    });

    expect(stopPropagation).toHaveBeenCalled();
    expect(setDialog).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirmDelete" }));
    expect(result.current.pendingRemovedIds.has("att-internal-1")).toBe(true);
  });

  it("asks for confirm dialog for non-internal attachments", async () => {
    const setDialog = vi.fn((dialog) => {
      if (dialog && typeof dialog === "object" && "resolve" in dialog) {
        dialog.resolve(false); // User cancels
      }
    });
    const { result } = renderHook(() =>
      useAttachmentActions({ note: { id: "note-1" } } as NoteDetail, setDialog),
    );

    const fileTile: Tile = {
      kind: "attachment",
      attachment: { id: "att-file-1", kind: "file", name: "doc.pdf" } as unknown as Attachment,
    };

    const stopPropagation = vi.fn();
    await act(async () => {
      await result.current.removeTile(
        { stopPropagation } as unknown as React.MouseEvent,
        fileTile,
      );
    });

    expect(setDialog).toHaveBeenCalledWith(expect.objectContaining({ kind: "confirmDelete" }));
    expect(result.current.pendingRemovedIds.has("att-file-1")).toBe(false);
  });
});

describe("useAttachmentActions.addFromClipboard — 클립보드 붙여넣기", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({}));
  });

  it("pastes URL as link attachment", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue("https://example.com/test"),
        read: vi.fn().mockResolvedValue([]),
      },
    });

    const { result } = setup();
    await act(async () => {
      await result.current.addFromClipboard();
    });

    expect(call).toHaveBeenCalledWith("attachment_add_link", {
      note_id: "note-1",
      name: "https://example.com/test",
      url: "https://example.com/test",
    });
  });

  it("pastes code snippet as text source", async () => {
    const code = "function test() {\n  console.log('hello');\n}";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue(code),
        read: vi.fn().mockResolvedValue([]),
      },
    });

    const { result } = setup();
    await act(async () => {
      await result.current.addFromClipboard();
    });

    expect(call).toHaveBeenCalledWith(
      "source_add_text",
      expect.objectContaining({
        note_id: "note-1",
        body: code,
      }),
    );
  });

  it("pastes plain text as text source", async () => {
    const text = "간단한 메모입니다.";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue(text),
        read: vi.fn().mockResolvedValue([]),
      },
    });

    const { result } = setup();
    await act(async () => {
      await result.current.addFromClipboard();
    });

    expect(call).toHaveBeenCalledWith(
      "source_add_text",
      expect.objectContaining({
        note_id: "note-1",
        body: text,
      }),
    );
  });
});

// F-N09 확장: 첨부 추가/삭제는 잠긴 노트에서 전부 막혀야 한다(보기/다운로드는 훅 바깥의 관심사라
// 여기 대상이 아니다). addOneFile은 addFile(파일피커)과 useAttachmentsDragDrop(드래그&드롭)의
// 공통 chokepoint라 이걸 직접 부르는 것으로 두 입구를 한 번에 검증한다.
describe("useAttachmentActions — 내용잠금", () => {
  function setupLocked() {
    return renderHook(() =>
      useAttachmentActions(
        { note: { id: "note-1", content_locked: true } } as NoteDetail,
        vi.fn(),
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({}));
  });

  it("addOneFile(파일피커·드래그&드롭 공통 지점)은 아무 커맨드도 부르지 않고 잠금 안내를 띄운다", async () => {
    const { result } = setupLocked();
    await act(async () => {
      await result.current.addOneFile("note-1", "C:/tmp/file.txt");
    });
    expect(call).not.toHaveBeenCalled();
    expect(emitNotice).toHaveBeenCalledWith("Content is locked — editing disabled");
  });

  it("addLink/addNote/addInternal/addFromClipboard가 전부 막힌다", async () => {
    const { result } = setupLocked();
    await act(async () => {
      await result.current.addLink("https://example.com", "Example");
      await result.current.addNote("Memo", "text");
      await result.current.addInternal("other-note", "Linked");
      await result.current.addFromClipboard();
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("removeTile/removeTiles가 막힌다", async () => {
    const { result } = setupLocked();
    await act(async () => {
      await result.current.removeTile({ stopPropagation: () => {} } as any, source("s1"));
      const res = await result.current.removeTiles([attachment("a1")]);
      expect(res).toEqual({ ok: [], failed: [] });
    });
    expect(call).not.toHaveBeenCalled();
  });
});
