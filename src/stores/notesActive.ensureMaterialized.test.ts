/**
 * ensureMaterialized(진짜) — IPC 층(call)만 가짜. note_create 가 성공한 뒤 다음 호출이 실패하는 길을 본다.
 * (MobileNote.draftLeave.realEditor.test.tsx 는 ensureMaterialized 를 통째로 가짜로 바꿔서 이 catch 가 한 번도 안 돌았다.)
 *
 * P0-2: 예전엔 catch 가 selectNote → flushAll 을 불러, 폰의 flush(쓰기 줄 안)가 자기 자신을 기다리며 영구 정지했고,
 *       selectNote 가 서버본(빈 본문)으로 activeNote 를 갈아 끼워 에디터가 빈 글로 다시 칠해졌다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => callMock(...a),
  emitNotice: vi.fn(),
}));

import { emitNotice, flushAll } from "../lib/invoke";
import { t } from "../i18n/t";
import { useNotesStore } from "./notes";
import { clearAllSaveFailures, fieldFailureKey, hasSaveFailed } from "../lib/sectionSaveFailures";

const TYPED = "typed text";

function draftNote() {
  return {
    note: {
      id: "__draft__",
      folder_id: "inbox1",
      title: "Untitled Note",
      year: 2026,
      month: 10,
      day: 7,
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
    sections: [{ id: "draft_sec", name: "Overview", body_md: TYPED, position: 0, kind: "text" }],
    sources: [],
    attachments: [],
  } as any;
}

function createdDetail() {
  const d = draftNote();
  d.note.id = "real1";
  d.sections = [{ id: "sec_real", name: "Overview", body_md: "", position: 0, kind: "text", updated_at: "t0" }];
  return d;
}

let failCmd: string | null = null;
let deferSectionUpdate: Promise<void> | null = null;
beforeEach(() => {
  clearAllSaveFailures();
  failCmd = null;
  deferSectionUpdate = null;
  callMock.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "note_create") return createdDetail();
    if (cmd === "section_update") {
      if (deferSectionUpdate) await deferSectionUpdate;
      if (failCmd === cmd) throw { code: "IO", message: "boom" };
      return { section_updated_at: "t1", updated_at: "t1" };
    }
    if (cmd === failCmd) throw { code: "IO", message: "boom" };
    if (cmd === "note_get") return createdDetail(); // 서버본: 본문이 비어 있다
    return {};
  });
  useNotesStore.setState({
    activeNote: draftNote(),
    activeDraft: true,
    savedState: "saving",
    saveConflict: null,
    loadTree: vi.fn(async () => {}),
  } as any);
});

describe("ensureMaterialized — note_create 성공 뒤 실패 (P0-2)", () => {
  it("본문 쓰기가 실패해도 selectNote(note_get)를 부르지 않고, activeNote 의 본문은 사용자가 친 글 그대로이며 saved 가 아니다", async () => {
    failCmd = "section_update";
    await expect(useNotesStore.getState().ensureMaterialized()).rejects.toBeTruthy();

    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("note_get");
    const s = useNotesStore.getState();
    expect(s.activeNote?.note.id).toBe("real1");
    expect(s.activeDraft).toBe(false);
    expect(s.activeNote?.sections[0].body_md).toBe(TYPED); // 서버(빈) 본문으로 다시 칠하지 않는다
    expect(s.savedState).toBe("failed");
  });

  it("그 뒤 같은 본문을 다시 보내면 (진짜 섹션 id 로) section_update 가 나간다", async () => {
    failCmd = "section_update";
    await expect(useNotesStore.getState().ensureMaterialized()).rejects.toBeTruthy();
    failCmd = null;
    callMock.mockClear();
    await useNotesStore.getState().updateSectionBody("sec_real", TYPED);
    expect(callMock.mock.calls.filter((c) => c[0] === "section_update").map((c) => c[1])).toEqual([
      expect.objectContaining({ id: "sec_real", body_md: TYPED }),
    ]);
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("본문은 필드 호출보다 먼저 나가고, 필드(제목) 쓰기가 실패해도 중단 없이 savedState 는 failed 가 되며 키가 등록된다", async () => {
    useNotesStore.setState({ activeNote: { ...draftNote(), note: { ...draftNote().note, title: "My title" } } } as any);
    failCmd = "note_update";
    const noteId = await useNotesStore.getState().ensureMaterialized();
    expect(noteId).toBe("real1");
    const cmds = callMock.mock.calls.map((c) => c[0]);
    expect(cmds.indexOf("section_update")).toBeGreaterThan(-1);
    expect(cmds.indexOf("section_update")).toBeLessThan(cmds.indexOf("note_update"));
    expect(cmds).not.toContain("note_get");
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe(TYPED);
    expect(useNotesStore.getState().savedState).toBe("failed");
    expect(hasSaveFailed(fieldFailureKey("real1", "title"))).toBe(true);
  });

  it("본문이 쓰이기 전에는 saved 로 표시하지 않는다(가짜 저장됨)", async () => {
    let release!: () => void;
    deferSectionUpdate = new Promise<void>((r) => (release = r));
    const p = useNotesStore.getState().ensureMaterialized();
    await vi.waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "section_update")).toBe(true));
    expect(useNotesStore.getState().savedState).not.toBe("saved");
    release();
    await p;
    expect(useNotesStore.getState().savedState).toBe("saved");
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe(TYPED);
  });
});

describe("제목 저장 실패 (M-16)", () => {
  it("실패하면 다시 시도(flushAll)가 제목을 다시 보내고, 토스트는 raw 메시지가 아니라 i18n 실패 문구다", async () => {
    const real = createdDetail();
    useNotesStore.setState({ activeNote: real, activeDraft: false, savedState: "saved" } as any);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_update") throw { code: "IO", message: "HTTP 502" };
      return {};
    });
    useNotesStore.getState().setTitle("New title");
    await flushAll();
    expect(vi.mocked(emitNotice)).toHaveBeenCalledWith(t("note.save_title_failed"));
    expect(vi.mocked(emitNotice)).not.toHaveBeenCalledWith("HTTP 502");
    expect(useNotesStore.getState().savedState).toBe("failed");

    callMock.mockClear();
    callMock.mockImplementation(async () => ({ title: "New title" }));
    await flushAll();
    expect(callMock.mock.calls.filter((c) => c[0] === "note_update").map((c) => c[1])).toEqual([
      { id: "real1", title: "New title" },
    ]);
    expect(useNotesStore.getState().savedState).toBe("saved");
  });
});
