import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

import { useNotesStore } from "./notes";
import type { NoteSummary } from "../lib/commands.gen";

function note(id: string, folder_id: string): NoteSummary {
  return { id, folder_id, title: id, tag_names: [] } as unknown as NoteSummary;
}

// PLAN-2026-09-15 D8: a note outside the resident tree window (opened from search) is not in
// noteIndex, so the O(1) map patch misses — fall back to loadTree() so the sidebar isn't stale.
describe("notesTree — patch/remove miss falls back to loadTree()", () => {
  const loadTree = vi.fn(async () => {});

  beforeEach(() => {
    callMock.mockReset();
    loadTree.mockClear();
    const n1 = note("n1", "f1");
    useNotesStore.setState({
      folders: [],
      notesByFolder: { f1: [n1] },
      noteIndex: new Map([["n1", n1]]),
      totalNotes: 1,
      loadTree,
    });
  });

  it("patchNoteSummary: id not in noteIndex → loadTree once; id in window → not called", () => {
    useNotesStore.getState().patchNoteSummary("outside", { title: "x" });
    expect(loadTree).toHaveBeenCalledTimes(1);

    useNotesStore.getState().patchNoteSummary("n1", { title: "y" });
    expect(loadTree).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().noteIndex.get("n1")?.title).toBe("y");
  });

  it("removeNoteSummary: id not in noteIndex → loadTree once; id in window → not called", () => {
    useNotesStore.getState().removeNoteSummary("outside");
    expect(loadTree).toHaveBeenCalledTimes(1);

    useNotesStore.getState().removeNoteSummary("n1");
    expect(loadTree).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().noteIndex.has("n1")).toBe(false);
  });
});

// GRILL-2026-10-19 W4 검증: 브리핑 창이 서버측 ensure_inbox_folder_id 로 받은편지함을 만들면 메인 창의
// 폴더 목록엔 아직 없다 — 그때 바로 folder_create 하면 노트북에 Inbox 가 둘 생겼다.
describe("notesTree — ensureInboxId 는 다른 창이 만든 받은편지함을 다시 만들지 않는다", () => {
  const loadTree = vi.fn(async () => {});

  beforeEach(async () => {
    callMock.mockReset();
    loadTree.mockClear();
    const { useSettingsStore } = await import("./settings");
    useSettingsStore.setState({ activeWorkspaceId: "ws1" });
    useNotesStore.setState({ folders: [], inboxId: null, loadTree });
  });

  const route = (serverFolders: { id: string; name: string }[]) =>
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "settings_get_all") return { settings: { inbox_ws1: "inboxX" } };
      if (cmd === "folder_list") return { folders: serverFolders, notes_by_folder: {} };
      if (cmd === "folder_create") return { id: "inboxNEW", name: "Inbox" };
      return {};
    });

  it("저장된 id 가 서버 폴더 목록에 있으면 그것을 쓰고 새로 만들지 않는다", async () => {
    route([{ id: "inboxX", name: "Inbox" }]);
    await expect(useNotesStore.getState().ensureInboxId()).resolves.toBe("inboxX");
    expect(callMock.mock.calls.some((c) => c[0] === "folder_create")).toBe(false);
    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it("서버에도 없으면(지워졌으면) 그때만 새로 만든다", async () => {
    route([]);
    await expect(useNotesStore.getState().ensureInboxId()).resolves.toBe("inboxNEW");
    expect(callMock.mock.calls.filter((c) => c[0] === "folder_create")).toHaveLength(1);
  });
});
