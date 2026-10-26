import { describe, it, expect, vi, beforeEach } from "vitest";

let responses: Record<string, unknown> = {};
const callMock = vi.fn((...args: unknown[]) => Promise.resolve(responses[args[0] as string]));
const loadTreeMock = vi.fn(async () => {});

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("./notes", () => ({
  useNotesStore: {
    getState: () => ({ loadTree: loadTreeMock }),
  },
}));

import { useTrashStore } from "./trash";

const note = (id: string, title: string): any => ({
  id,
  folder_id: "f1",
  title,
  year: 1900,
  is_favorite: false,
  exported_at: null,
  has_image: false,
  tag_names: [],
  region: null,
  status: null,
  icon: null,
});

describe("trash store", () => {
  beforeEach(() => {
    callMock.mockClear();
    loadTreeMock.mockClear();
    responses = {};
    useTrashStore.setState({ trashList: [], trashCount: 0, sectionTrash: [] });
  });

  it("loadTrash() calls note_trash_list with no args (active-workspace convention) and sets trashList/trashCount from the result", async () => {
    responses.note_trash_list = [note("n1", "A"), note("n2", "B")];

    await useTrashStore.getState().loadTrash();

    expect(callMock).toHaveBeenCalledWith("note_trash_list", {});
    const state = useTrashStore.getState();
    expect(state.trashList).toHaveLength(2);
    expect(state.trashCount).toBe(2);
  });

  it("loadTrashCount() calls note_trash_count and sets only trashCount (badge path)", async () => {
    responses.note_trash_count = { count: 3 };

    await useTrashStore.getState().loadTrashCount();

    expect(callMock).toHaveBeenCalledWith("note_trash_count", {});
    expect(useTrashStore.getState().trashCount).toBe(3);
    expect(useTrashStore.getState().trashList).toHaveLength(0);
  });

  it("loadTrash() swallows a failure and leaves the previous state untouched (best-effort background refresh)", async () => {
    useTrashStore.setState({ trashList: [note("n1", "A")], trashCount: 1 });
    callMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });

    await expect(useTrashStore.getState().loadTrash()).resolves.toBeUndefined();
    expect(useTrashStore.getState().trashCount).toBe(1);
  });

  it("restoreNote() calls note_restore, reloads the notes tree, then refreshes the trash list", async () => {
    responses.note_trash_list = [];
    useTrashStore.setState({ trashList: [note("n1", "A")], trashCount: 1 });

    await useTrashStore.getState().restoreNote("n1");

    expect(callMock).toHaveBeenCalledWith("note_restore", { id: "n1" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(useTrashStore.getState().trashCount).toBe(0);
  });

  it("purgeNote() calls note_purge then refreshes the trash list", async () => {
    responses.note_trash_list = [note("n2", "B")];
    useTrashStore.setState({ trashList: [note("n1", "A"), note("n2", "B")], trashCount: 2 });

    await useTrashStore.getState().purgeNote("n1");

    expect(callMock).toHaveBeenCalledWith("note_purge", { id: "n1" });
    expect(useTrashStore.getState().trashCount).toBe(1);
    expect(useTrashStore.getState().trashList.map((n) => n.id)).toEqual(["n2"]);
  });

  it("purgeAll() purges every currently-listed note then refreshes once", async () => {
    useTrashStore.setState({ trashList: [note("n1", "A"), note("n2", "B")], trashCount: 2 });
    responses.note_trash_list = [];

    await useTrashStore.getState().purgeAll();

    expect(callMock).toHaveBeenCalledWith("note_purge", { id: "n1" });
    expect(callMock).toHaveBeenCalledWith("note_purge", { id: "n2" });
    expect(useTrashStore.getState().trashCount).toBe(0);
  });

  // W5 (PLAN-2026-09-10 D4): 섹션 휴지통은 같은 스토어에 얹히되 배지(trashCount)에는 안 섞인다.
  it("섹션 왕복 — 목록/복구/완전삭제가 각 커맨드를 부르고 목록을 다시 읽는다", async () => {
    const sec = { id: "sec-1", name: "참고", kind: "text", note_id: "n1", note_title: "회의", note_deleted: false, deleted_at: "2026-09-10T00:00:00Z" };
    responses.section_trash_list = [sec];
    useTrashStore.setState({ trashCount: 2 });

    await useTrashStore.getState().loadSectionTrash();
    expect(callMock).toHaveBeenCalledWith("section_trash_list", {});
    expect(useTrashStore.getState().sectionTrash).toHaveLength(1);
    // 배지는 노트 수 그대로 — 섹션 수를 더하지 않는다.
    expect(useTrashStore.getState().trashCount).toBe(2);

    responses.section_trash_list = [];
    await useTrashStore.getState().restoreSection("sec-1");
    expect(callMock).toHaveBeenCalledWith("section_restore", { id: "sec-1" });
    expect(useTrashStore.getState().sectionTrash).toHaveLength(0);

    await useTrashStore.getState().purgeSection("sec-2");
    expect(callMock).toHaveBeenCalledWith("section_purge", { id: "sec-2" });
  });

  it("purgeAll() on an empty trash calls no note_purge and still refreshes", async () => {
    useTrashStore.setState({ trashList: [], trashCount: 0 });
    responses.note_trash_list = [];

    await useTrashStore.getState().purgeAll();

    expect(callMock).not.toHaveBeenCalledWith("note_purge", expect.anything());
    expect(callMock).toHaveBeenCalledWith("note_trash_list", {});
  });
});
