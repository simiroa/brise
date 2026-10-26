import { describe, it, expect, vi, beforeEach } from "vitest";

const emitNoticeMock = vi.fn();
const selectNoteMock = vi.fn(async (_id: string) => {});
const ensureMaterializedMock = vi.fn(async () => "note-A" as string | null);

let activeNoteId: string | undefined = "note-A";
// insertAiSection 내용잠금 가드용 — activeNote와 별개로 "이 id는 잠긴 노트다"를 표시한다
// (targetNoteId가 지금 열린 노트와 다를 수 있으므로 activeNote.content_locked만으로는 부족 —
// 실제 구현은 stores/notes.ts::isNoteContentLocked, 이 파일은 그 모듈 전체를 모킹한다).
let lockedNoteIds = new Set<string>();

vi.mock("./invoke", () => ({
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  call: vi.fn(),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
}));

vi.mock("../stores/notes", () => ({
  isNoteContentLocked: (id: string) => lockedNoteIds.has(id),
  useNotesStore: {
    getState: () => ({
      activeNote: activeNoteId ? { note: { id: activeNoteId } } : null,
      selectNote: selectNoteMock,
      ensureMaterialized: ensureMaterializedMock,
    }),
  },
}));

import {
  prepareAiInsertNoteId,
  insertAiSection,
  registerSectionInserter,
  getPendingAiInsertId,
  setPendingAiInsertId,
} from "./aiSectionBridge";
import { t } from "../i18n/t";

describe("prepareAiInsertNoteId — AI insert target-note policy (a)", () => {
  beforeEach(() => {
    emitNoticeMock.mockReset();
    selectNoteMock.mockReset();
    ensureMaterializedMock.mockReset();
    ensureMaterializedMock.mockResolvedValue("note-A");
    activeNoteId = "note-A";
    selectNoteMock.mockImplementation(async (id: string) => {
      activeNoteId = id;
    });
  });

  it("same active note: materializes and returns id (happy path)", async () => {
    const id = await prepareAiInsertNoteId("note-A");
    expect(id).toBe("note-A");
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(ensureMaterializedMock).toHaveBeenCalled();
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });

  it("active switched to B: selectNote back to A then materialize — never inserts on B", async () => {
    activeNoteId = "note-B";
    ensureMaterializedMock.mockResolvedValue("note-A");

    const id = await prepareAiInsertNoteId("note-A");

    expect(selectNoteMock).toHaveBeenCalledWith("note-A");
    expect(id).toBe("note-A");
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });

  it("selectNote bails (still on B): abandon + notice — never silent write to B", async () => {
    activeNoteId = "note-B";
    selectNoteMock.mockImplementation(async () => {
      // dictation / race: selectNote returns without switching
    });

    const id = await prepareAiInsertNoteId("note-A");

    expect(id).toBeNull();
    expect(ensureMaterializedMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.ai_insert_note_changed"));
  });

  it("discarded draft target: abandon + notice (cannot re-select __draft__)", async () => {
    activeNoteId = "note-B";

    const id = await prepareAiInsertNoteId("__draft__");

    expect(id).toBeNull();
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.ai_insert_note_changed"));
  });
});

describe("insertAiSection — forwards targetNoteId to the registered inserter", () => {
  it("passes name, body, targetNoteId, and optional kind", async () => {
    const inserted = vi.fn(async () => ({ id: "s-new" } as any));
    const unregister = registerSectionInserter(inserted as any);
    try {
      setPendingAiInsertId(null);
      await insertAiSection("Summary", "body", "note-A");
      // No opts → opts?.aiOrigin is undefined either way, but the registered inserter still
      // receives all 5 positional slots (insertAiSection always forwards kind + aiOrigin).
      expect(inserted).toHaveBeenCalledWith("Summary", "body", "note-A", undefined, undefined);
      expect(getPendingAiInsertId()).toBe("s-new");

      await insertAiSection("Diagram", "flowchart TD", "note-A", "diagram");
      expect(inserted).toHaveBeenCalledWith("Diagram", "flowchart TD", "note-A", "diagram", undefined);
    } finally {
      unregister();
    }
  });
});

// docs/AI.md "L1은 원본을 덮어쓰지 않는다 — insertAiSection 한 지점" — 이 함수가 막히면 번역/
// 프롬프트/프리셋 등 여기로 모이는 모든 AI 쓰기 경로가 다 같이 막힌다(F-N09 확장).
describe("insertAiSection — 내용잠금이면 삽입을 막는다", () => {
  beforeEach(() => {
    emitNoticeMock.mockReset();
    lockedNoteIds = new Set();
    activeNoteId = "note-A";
  });

  it("대상 노트가 잠겨 있으면 registered inserter를 부르지 않고 null을 돌려주며 안내한다", async () => {
    lockedNoteIds.add("note-A");
    const inserted = vi.fn(async () => ({ id: "s-new" } as any));
    const unregister = registerSectionInserter(inserted as any);
    try {
      const result = await insertAiSection("Summary", "body", "note-A");
      expect(result).toBeNull();
      expect(inserted).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.content_locked_tooltip"));
    } finally {
      unregister();
    }
  });

  it("대상 노트가 지금 열린 노트와 달라도(백그라운드 대상) 그 노트의 잠금을 본다", async () => {
    // 열린 노트는 note-A, 하지만 이 AI 요청의 대상은 다른(잠긴) 노트다 — activeNote만 보면
    // 놓치는 케이스.
    activeNoteId = "note-A";
    lockedNoteIds.add("note-B");
    const inserted = vi.fn(async () => ({ id: "s-new" } as any));
    const unregister = registerSectionInserter(inserted as any);
    try {
      const result = await insertAiSection("Summary", "body", "note-B");
      expect(result).toBeNull();
      expect(inserted).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("insertAiSection — W5 ai_origin provenance (opts.aiOrigin)", () => {
  it("unwraps opts.aiOrigin to the bare string the registered inserter receives", async () => {
    const inserted = vi.fn(async () => ({ id: "s-new" } as any));
    const unregister = registerSectionInserter(inserted as any);
    try {
      await insertAiSection("Summary", "body", "note-A", undefined, { aiOrigin: "summarize" });
      expect(inserted).toHaveBeenCalledWith("Summary", "body", "note-A", undefined, "summarize");

      await insertAiSection("Diagram", "flowchart TD", "note-A", "diagram", { aiOrigin: "diagram" });
      expect(inserted).toHaveBeenCalledWith("Diagram", "flowchart TD", "note-A", "diagram", "diagram");
    } finally {
      unregister();
    }
  });

  it("an insert with no aiOrigin (blank section / template skeleton) forwards undefined, not a made-up id", async () => {
    const inserted = vi.fn(async () => ({ id: "s-new" } as any));
    const unregister = registerSectionInserter(inserted as any);
    try {
      await insertAiSection("Blank", "", "note-A", undefined, { postProcess: false });
      expect(inserted).toHaveBeenCalledWith("Blank", "", "note-A", undefined, undefined);
    } finally {
      unregister();
    }
  });
});
