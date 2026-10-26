// D2② W2 — 섹션 버전 토큰(expected_updated_at)·CONFLICT 게이트·충돌 해결.
import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const toastMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: async (...args: unknown[]) => {
    try {
      return await callMock(...args);
    } catch (e) {
      toastMock(e);
      throw e;
    }
  },
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a), reportDiag: vi.fn() }));

import { useNotesStore, renameSection } from "./notes";
import { useTabsStore } from "./tabs";
import { persistSheetCells } from "../lib/sheet/persist";
import { __resetSectionTokens, withSectionTokenRefresh, registerBodyCacheDiscardHook } from "../lib/sectionTokens";
import type { NoteDetail } from "../lib/commands.gen";

let s2Token = "tok-s2";
const detail = (token: string, body = "server"): NoteDetail => ({
  note: { id: "n1", folder_id: "f1", title: "T", year: 2026, tag_names: [], is_favorite: false } as unknown as NoteDetail["note"],
  sections: [
    { id: "s1", name: "A", body_md: body, position: 0, kind: "text", updated_at: token },
    { id: "s2", name: "B", body_md: "", position: 1, kind: "sheet", updated_at: s2Token },
  ],
  sources: [],
  attachments: [],
});

/** 서버 흉내: 섹션 토큰을 들고 expected 가 다르면 CONFLICT. */
let serverToken = "t0";
let seq = 0;
function installServer() {
  callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "note_get":
        return detail(serverToken);
      case "section_update": {
        if (args.expected_updated_at !== undefined && args.expected_updated_at !== serverToken) {
          throw { code: "CONFLICT", message: "conflict" };
        }
        serverToken = `t${++seq}`;
        return { updated_at: "note-ts", section_updated_at: serverToken };
      }
      case "sheet_set_cells":
      case "section_reorder":
        serverToken = `t${++seq}`;
        return cmd === "section_reorder" ? { ok: true } : { updated_at: "note-ts", section_updated_at: serverToken };
      case "section_create_with_body":
        return { id: "copy1", name: args.name, body_md: args.body_md, position: 2, kind: args.kind };
      default:
        return undefined;
    }
  });
}

const sectionUpdates = () =>
  callMock.mock.calls.filter((c) => c[0] === "section_update").map((c) => c[1] as Record<string, unknown>);

async function openNote() {
  await useNotesStore.getState().selectNote("n1");
}

describe("D2② section tokens", () => {
  beforeEach(() => {
    __resetSectionTokens();
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    reportFallbackMock.mockClear();
    serverToken = "t0";
    s2Token = "tok-s2";
    seq = 0;
    installServer();
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({
      activeNote: null,
      activeDraft: false,
      loadingNoteId: null,
      savedState: "saved",
      saveConflict: null,
    });
  });

  it("sends the token seeded by selectNote, then the token from the save response", async () => {
    await openNote();
    await useNotesStore.getState().updateSectionBody("s1", "one");
    await useNotesStore.getState().updateSectionBody("s1", "two");
    expect(sectionUpdates()).toEqual([
      { id: "s1", body_md: "one", expected_updated_at: "t0" },
      { id: "s1", body_md: "two", expected_updated_at: "t1" },
    ]);
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("omits the token for a section it never saw (old last-write-wins)", async () => {
    await useNotesStore.getState().updateSectionBody("unknown", "x");
    expect(sectionUpdates()).toEqual([{ id: "unknown", body_md: "x" }]);
  });

  it("reloadActive re-seeds and replaces a stale token", async () => {
    await openNote();
    serverToken = "t-remote"; // 다른 기기가 썼다
    await useNotesStore.getState().reloadActive();
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    expect(sectionUpdates()[0].expected_updated_at).toBe("t-remote");
    expect(useNotesStore.getState().saveConflict).toBeNull();
  });

  it("CONFLICT keeps savedState 'failed', sets saveConflict and never retries silently", async () => {
    await openNote();
    serverToken = "t-remote";
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    const st = useNotesStore.getState();
    expect(st.savedState).toBe("failed");
    expect(st.saveConflict).toEqual({ noteId: "n1", sectionId: "s1" });
    expect(reportFallbackMock).toHaveBeenCalledWith("section-save", "conflict");
    // 다음 자동 저장들은 서버로 가지 않는다(토스트 반복·조용한 재시도 없음).
    await useNotesStore.getState().updateSectionBody("s1", "mine more");
    await useNotesStore.getState().updateSectionBody("s1", "mine even more");
    expect(sectionUpdates()).toHaveLength(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().savedState).toBe("failed");
    // 다른 섹션은 계속 저장된다.
    await useNotesStore.getState().updateSectionBody("s2", "{}");
    expect(sectionUpdates()).toHaveLength(2);
  });

  it("note trashed on another device: resends once without the token (lands in trash), then keeps saving token-less", async () => {
    await openNote();
    let trashed = true;
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "section_update" && trashed && args.expected_updated_at !== undefined) {
        throw { code: "NOT_FOUND", message: "note is in trash: n1" };
      }
      return base(cmd, args);
    });
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    expect(sectionUpdates()).toEqual([
      { id: "s1", body_md: "mine", expected_updated_at: "t0" },
      { id: "s1", body_md: "mine" },
    ]);
    expect(useNotesStore.getState().savedState).toBe("saved");
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(reportFallbackMock).toHaveBeenCalledWith("section-save", "saved_into_trash");
    // 이후 저장은 토큰 없이 — NOT_FOUND 토스트가 700ms 마다 쌓이지 않는다.
    await useNotesStore.getState().updateSectionBody("s1", "mine 2");
    expect(sectionUpdates()[2]).toEqual({ id: "s1", body_md: "mine 2" });
    expect(toastMock).toHaveBeenCalledTimes(1);
    trashed = false;
  });

  it("sheet cell save then body save does not self-conflict", async () => {
    await openNote();
    await persistSheetCells("s1", { A1: "1" } as never);
    await useNotesStore.getState().updateSectionBody("s1", "after cells");
    expect(sectionUpdates()[0].expected_updated_at).toBe("t1");
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("rename then body save does not self-conflict", async () => {
    await openNote();
    expect(await renameSection("s1", "A", "Renamed")).toBe("Renamed");
    await useNotesStore.getState().updateSectionBody("s1", "after rename");
    const ups = sectionUpdates();
    expect(ups[0]).toEqual({ id: "s1", name: "Renamed" });
    expect(ups[1].expected_updated_at).toBe("t1");
    expect(useNotesStore.getState().saveConflict).toBeNull();
  });

  it("reorder then body save does not self-conflict (tokens re-read after the reorder)", async () => {
    await openNote();
    await withSectionTokenRefresh("n1", ["s2", "s1"], () => callMock("section_reorder", { note_id: "n1", ordered_ids: ["s2", "s1"] }));
    await useNotesStore.getState().updateSectionBody("s1", "after reorder");
    expect(sectionUpdates()[0].expected_updated_at).toBe("t1");
    expect(useNotesStore.getState().saveConflict).toBeNull();
  });

  it("overlapping saves of one section are queued so the second carries the first's new token", async () => {
    await openNote();
    const a = useNotesStore.getState().updateSectionBody("s1", "a");
    const b = useNotesStore.getState().updateSectionBody("s1", "ab");
    await Promise.all([a, b]);
    expect(sectionUpdates().map((u) => u.expected_updated_at)).toEqual(["t0", "t1"]);
    expect(useNotesStore.getState().saveConflict).toBeNull();
  });

  it("copy mine: creates a section with the latest local body, discards the editor cache, reloads, clears the conflict", async () => {
    await openNote();
    serverToken = "t-remote";
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    await useNotesStore.getState().updateSectionBody("s1", "mine latest"); // 게이트가 최신 본문을 쥔다
    const discarded: string[] = [];
    const off = registerBodyCacheDiscardHook((id) => discarded.push(id));
    const ok = await useNotesStore.getState().resolveSaveConflict("copy");
    off();
    expect(ok).toBe(true);
    const creates = callMock.mock.calls.filter((c) => c[0] === "section_create_with_body");
    expect(creates).toEqual([
      ["section_create_with_body", { note_id: "n1", name: expect.any(String), body_md: "mine latest", kind: "text" }],
    ]);
    // 다시 읽기 전(텍스트 캐시)·후(시트 다시 마운트) 두 번.
    expect(discarded).toEqual(["s1", "s1"]);
    // 사본 생성 → 다시 읽기 순서.
    const order = callMock.mock.calls.map((c) => c[0]);
    expect(order.lastIndexOf("note_get")).toBeGreaterThan(order.indexOf("section_create_with_body"));
    expect(flushAllMock).toHaveBeenCalled();
    const st = useNotesStore.getState();
    expect(st.saveConflict).toBeNull();
    expect(st.savedState).toBe("saved");
    // 원본 섹션엔 내 본문을 쓰지 않았다 — 그리고 다음 저장은 다시 읽은 토큰으로 간다.
    expect(sectionUpdates()).toHaveLength(1);
    await useNotesStore.getState().updateSectionBody("s1", "new typing");
    expect(sectionUpdates()[1].expected_updated_at).toBe("t-remote");
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("copy mine: a failed copy keeps the conflict and does not reload", async () => {
    await openNote();
    serverToken = "t-remote";
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "section_create_with_body") throw { code: "DB", message: "x" };
      return base(cmd, args);
    });
    const getsBefore = callMock.mock.calls.filter((c) => c[0] === "note_get").length;
    expect(await useNotesStore.getState().resolveSaveConflict("copy")).toBe(false);
    expect(callMock.mock.calls.filter((c) => c[0] === "note_get").length).toBe(getsBefore);
    expect(useNotesStore.getState().saveConflict).toEqual({ noteId: "n1", sectionId: "s1" });
  });

  it("overwrite: refetches the current token and resends the local body with it", async () => {
    await openNote();
    serverToken = "t-remote";
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    const ok = await useNotesStore.getState().resolveSaveConflict("overwrite");
    expect(ok).toBe(true);
    const ups = sectionUpdates();
    expect(ups[ups.length - 1]).toEqual({ id: "s1", body_md: "mine", expected_updated_at: "t-remote" });
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("overwrite seeds tokens only for the held section: another section edited remotely still conflicts honestly (M-10)", async () => {
    await openNote(); // s1=t0, s2=tok-s2
    serverToken = "t-remote"; // 충돌: s1
    s2Token = "tok-s2-remote"; // 그 사이 상대가 s2 도 고쳤다
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    await useNotesStore.getState().resolveSaveConflict("overwrite");
    expect(useNotesStore.getState().saveConflict).toBeNull();
    await useNotesStore.getState().updateSectionBody("s2", "typed on stale cache");
    const ups = sectionUpdates();
    expect(ups[ups.length - 1]).toMatchObject({ id: "s2", expected_updated_at: "tok-s2" }); // 새 토큰(tok-s2-remote)으로 통과하지 않는다
  });

  it("switching to another note drops the conflict (and records it)", async () => {
    await openNote();
    serverToken = "t-remote";
    await useNotesStore.getState().updateSectionBody("s1", "mine");
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_get" ? { ...detail("x"), note: { ...detail("x").note, id: "n2" } } : undefined,
    );
    await useNotesStore.getState().selectNote("n2");
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(reportFallbackMock).toHaveBeenCalledWith("section-save", "conflict_dropped_on_switch");
  });

  it("reloadActive discards the editor cache of sections that moved on the server, but not gated or unchanged ones", async () => {
    await openNote(); // s1=t0, s2=tok-s2
    serverToken = "t-remote"; // s1 은 다른 기기가 썼다, s2 는 그대로
    const discarded: string[] = [];
    const off = registerBodyCacheDiscardHook((id) => discarded.push(id));
    await useNotesStore.getState().reloadActive();
    expect(discarded).toEqual(["s1"]);
    // 충돌로 게이트가 열린 섹션은 캐시가 내 본문의 사본이므로 버리지 않는다.
    discarded.length = 0;
    serverToken = "t-remote-2";
    await useNotesStore.getState().updateSectionBody("s1", "mine"); // 낡은 토큰 → CONFLICT
    expect(useNotesStore.getState().saveConflict).not.toBeNull();
    serverToken = "t-remote-3";
    await useNotesStore.getState().reloadActive();
    off();
    expect(discarded).toEqual([]);
  });

  // D2② W4 — 이 클라이언트가 만든 섹션은 생성 응답의 토큰을 받는다(다음 노트 로드까지 LWW 로 새지 않게).
  it("a section this client created carries its create-response token and does not self-conflict", async () => {
    await openNote();
    const created = { id: "new1", name: "C", body_md: "", position: 2, kind: "text" as const, updated_at: "tn0" };
    let newToken = "tn0";
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "section_update" && args.id === "new1") {
        if (args.expected_updated_at !== undefined && args.expected_updated_at !== newToken) {
          throw { code: "CONFLICT", message: "conflict" };
        }
        newToken = `tn${++seq}`;
        return { updated_at: "note-ts", section_updated_at: newToken };
      }
      return undefined;
    });
    useNotesStore.getState().appendActiveSection("n1", created);
    expect(useNotesStore.getState().activeNote!.sections.map((x) => x.id)).toEqual(["s1", "s2", "new1"]);
    await useNotesStore.getState().updateSectionBody("new1", "one");
    await useNotesStore.getState().updateSectionBody("new1", "two");
    expect(sectionUpdates()).toEqual([
      { id: "new1", body_md: "one", expected_updated_at: "tn0" },
      { id: "new1", body_md: "two", expected_updated_at: "tn1" },
    ]);
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("appendActiveSection ignores a section for a note that is no longer open", async () => {
    await openNote();
    const before = useNotesStore.getState().activeNote;
    useNotesStore.getState().appendActiveSection("other-note", { id: "x1", name: "X", body_md: "", position: 0, kind: "text", updated_at: "tx" });
    expect(useNotesStore.getState().activeNote).toBe(before);
    await useNotesStore.getState().updateSectionBody("x1", "y");
    expect(sectionUpdates()).toEqual([{ id: "x1", body_md: "y" }]); // 심지 않았다
  });

  // AI 본문 교체(askAiDispatch)는 에디터를 거치지 않고 섹션을 통째로 바꾼다. 토큰 비교만으로는 그 섹션의 에디터
  // 캐시(교체 전 본문)가 버려지지 않을 수 있다 — `rewritten` 은 reload 안의 flush **뒤에** 버린다(앞에서 버리면
  // flush 가 낡은 본문으로 다시 채운다).
  it("reloadActive({rewritten}) discards that section's cache after the flush, even with an unknown token, and seeds the new token", async () => {
    await openNote();
    __resetSectionTokens(); // 읽기 시점 토큰을 몰랐던 경우(토큰 비교로는 못 잡는다)
    const order: string[] = [];
    flushAllMock.mockImplementation(async () => {
      order.push("flush");
    });
    const off = registerBodyCacheDiscardHook((id) => order.push(`discard:${id}`));
    serverToken = "t-ai"; // AI 교체가 올린 토큰
    await useNotesStore.getState().reloadActive({ rewritten: ["s1"] });
    off();
    flushAllMock.mockImplementation(async () => {});
    expect(order).toEqual(["flush", "discard:s1"]);
    // 새 토큰은 reload 의 seed 가 심는다 — 다음 자동 저장이 자기 자신(AI 쓰기)과 충돌하지 않는다.
    await useNotesStore.getState().updateSectionBody("s1", "after ai");
    expect(sectionUpdates()).toEqual([{ id: "s1", body_md: "after ai", expected_updated_at: "t-ai" }]);
    expect(useNotesStore.getState().saveConflict).toBeNull();
  });
});
