import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 커맨드 이름으로 응답을 찾아주는 디스패처 — Wave 14 이전에는 call 순서(mockResolvedValueOnce
// 스택)에 의존했는데, switchTo/load가 이제 (fire-and-forget으로) workspace_region_list /
// workspace_era_list 도 함께 호출해서 순서 기반 큐가 깨졌다(엉뚱한 커맨드가 다음 큐 값을
// 가로채 folder_list 응답이 undefined가 되는 식). 인자(커맨드명) 기준으로 응답을 찾으면
// 새 fire-and-forget 호출이 몇 번 끼어들어도 안전하다.
let responses: Record<string, unknown> = {};
// Rest-only signature (not `(cmd: string, ...)`) so `callMock(...args)` below — where args is a
// plain `unknown[]`, not a tuple — type-checks as a rest-to-rest spread.
const callMock = vi.fn((...args: unknown[]) => Promise.resolve(responses[args[0] as string]));
const flushAllMock = vi.fn(async () => {});

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
}));

import { useWorkspacesStore } from "./workspaces";
import { useTabsStore } from "./tabs";
import { useNotesStore } from "./notes";
import { useTaxonomyStore } from "./taxonomy";
// undo.ts is NOT mocked here — remove() now routes the actual backend delete through its real
// Tier 1 undo-on-delete primitive (delayed commit + onRestore), so these tests exercise it for
// real: flushPendingDeletes() to force the delayed commit, onUndoToast() to grab the onUndo
// callback the way Toast.tsx would.
import { flushPendingDeletes, onUndoToast } from "../lib/undo";

const ws = (
  id: string,
  name: string,
  note_count = 0,
  bg_image_path: string | null = null,
) => ({
  id,
  name,
  created_at: "2026-01-01T00:00:00Z",
  folder_count: 1,
  note_count,
  bg_image_path,
  icon: null,
});

describe("workspaces store", () => {
  beforeEach(() => {
    callMock.mockClear();
    // 기본값: taxonomy 로드는 대부분의 테스트에서 관심사가 아니므로 빈 목록으로 조용히 응답.
    responses = {
      workspace_region_list: { regions: [] },
      workspace_era_list: { eras: [] },
      // 전환은 노트북별 설정을 다시 읽는다(reloadAppearance → settings_get_all).
      settings_get_all: { settings: {} },
      window_set_effect: { applied: true },
    };
    flushAllMock.mockClear();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false });
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n1" });
    useNotesStore.setState({ activeNote: null });
    useTaxonomyStore.setState({ workspaceId: null, regions: [], eras: [], loaded: false });
  });

  // remove() schedules a real (unmocked) delayed commit via scheduleUndoableDelete — make sure no
  // test leaves one pending (which would otherwise fire its real 5s setTimeout well after this
  // test file finishes, or leak a workspace_delete call into an unrelated later test).
  afterEach(async () => {
    await flushPendingDeletes();
  });

  it("load() populates workspaces + activeId from workspace_list", async () => {
    responses.workspace_list = {
      workspaces: [ws("a", "Korean History"), ws("b", "Japan")],
      active_id: "a",
    };

    await useWorkspacesStore.getState().load();

    expect(callMock).toHaveBeenCalledWith("workspace_list");
    const state = useWorkspacesStore.getState();
    expect(state.workspaces).toHaveLength(2);
    expect(state.activeId).toBe("a");
    expect(state.loaded).toBe(true);
  });

  it("switchTo flushes pending saves, calls settings_set with the id, reloads the tree, and resets tabs/active note", async () => {
    useWorkspacesStore.setState({
      workspaces: [ws("a", "Korean History"), ws("b", "Japan")],
      activeId: "a",
      loaded: true,
    });
    useNotesStore.setState({
      activeNote: {
        note: {
          id: "n1",
          folder_id: "f1",
          title: "x",
          year: 1000,
          is_favorite: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          status: null,
          icon: null,
          lat: null,
          lng: null,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          month: null,
          day: null,
        },
        sections: [],
        sources: [],
        attachments: [],
      },
    });

    responses.settings_set = { ok: true };
    responses.folder_list = { folders: [], notes_by_folder: {} };

    const calls: string[] = [];
    flushAllMock.mockImplementationOnce(async () => {
      calls.push("flushAll");
    });

    await useWorkspacesStore.getState().switchTo("b");

    expect(flushAllMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { active_workspace_id: "b", open_tabs: [], active_tab_id: "home", recent_closed_tabs: [] },
    });
    expect(callMock).toHaveBeenCalledWith("folder_list");

    const wsState = useWorkspacesStore.getState();
    expect(wsState.activeId).toBe("b");

    const tabsState = useTabsStore.getState();
    expect(tabsState.openTabs).toEqual([]);
    // Wave 2: workspace switch activates home for the new workspace (not null).
    expect(tabsState.activeTabId).toBe("home");

    expect(useNotesStore.getState().activeNote).toBeNull();
  });

  // PLAN-2026-09-19-notebook-settings §4: 모양·언어·달력이 노트북을 따라 바뀐다 — 전환한 창이 설정을
  // 새 노트북 기준으로 다시 읽고(settings_set **뒤**), OS 창 효과를 **한 번만** 다시 건다.
  it("switchTo re-reads settings for the new notebook and reapplies the window effect once", async () => {
    useWorkspacesStore.setState({ workspaces: [ws("a", "A"), ws("b", "B")], activeId: "a", loaded: true });
    responses.settings_set = { ok: true };
    responses.folder_list = { folders: [], notes_by_folder: {} };
    responses.settings_get_all = { settings: { active_workspace_id: "b", theme: "light" } };

    await useWorkspacesStore.getState().switchTo("b");

    const names = callMock.mock.calls.map((c) => c[0] as string);
    const setIdx = names.indexOf("settings_set");
    const getIdx = names.lastIndexOf("settings_get_all");
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(getIdx).toBeGreaterThan(setIdx);
    expect(names.filter((n) => n === "window_set_effect")).toHaveLength(1);
  });

  it("create() passes copy_settings_from only when copying the current notebook's settings", async () => {
    responses.workspace_create = ws("c", "Copy");
    responses.workspace_list = { workspaces: [ws("a", "A"), ws("c", "Copy")], active_id: "a" };

    await useWorkspacesStore.getState().create("Copy", "a");
    expect(callMock).toHaveBeenCalledWith("workspace_create", { name: "Copy", copy_settings_from: "a" });

    callMock.mockClear();
    await useWorkspacesStore.getState().create("Fresh");
    expect(callMock).toHaveBeenCalledWith("workspace_create", { name: "Fresh" });
  });

  it("duplicate() calls workspace_duplicate with the new name, reloads, and keeps the active notebook", async () => {
    useWorkspacesStore.setState({ workspaces: [ws("a", "A")], activeId: "a", loaded: true });
    responses.workspace_duplicate = ws("d", "A 사본");
    responses.workspace_list = { workspaces: [ws("a", "A"), ws("d", "A 사본")], active_id: "a" };

    const copy = await useWorkspacesStore.getState().duplicate("a", "A 사본");

    expect(callMock).toHaveBeenCalledWith("workspace_duplicate", { id: "a", name: "A 사본" });
    expect(copy.id).toBe("d");
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["a", "d"]);
    expect(useWorkspacesStore.getState().activeId).toBe("a");
  });

  it("create() calls workspace_create then reloads the list", async () => {
    responses.workspace_create = ws("c", "New Workspace");
    responses.workspace_list = { workspaces: [ws("c", "New Workspace")], active_id: "c" };

    const created = await useWorkspacesStore.getState().create("New Workspace");

    expect(callMock).toHaveBeenCalledWith("workspace_create", { name: "New Workspace" });
    expect(callMock).toHaveBeenCalledWith("workspace_list");
    expect(created.id).toBe("c");
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1);
  });

  it("rename() calls workspace_rename then reloads the list", async () => {
    responses.workspace_rename = ws("a", "Renamed");
    responses.workspace_list = { workspaces: [ws("a", "Renamed")], active_id: "a" };

    await useWorkspacesStore.getState().rename("a", "Renamed");

    expect(callMock).toHaveBeenCalledWith("workspace_rename", { id: "a", name: "Renamed" });
    expect(callMock).toHaveBeenCalledWith("workspace_list");
  });

  it("remove() of the active workspace optimistically removes it and switches to the fallback workspace immediately, but delays the actual workspace_delete call (undo-on-delete)", async () => {
    useWorkspacesStore.setState({
      workspaces: [ws("a", "Korean History"), ws("b", "Japan")],
      activeId: "a",
      loaded: true,
    });

    responses.settings_set = { ok: true };
    responses.folder_list = { folders: [], notes_by_folder: {} };

    await useWorkspacesStore.getState().remove("a");

    // Local state updates immediately: "a" is gone, "b" is now active, editor state reset.
    const state = useWorkspacesStore.getState();
    expect(state.workspaces.map((w) => w.id)).toEqual(["b"]);
    expect(state.activeId).toBe("b");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { active_workspace_id: "b", open_tabs: [], active_tab_id: "home", recent_closed_tabs: [] } });
    expect(callMock).toHaveBeenCalledWith("folder_list");
    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe("home");
    expect(useNotesStore.getState().activeNote).toBeNull();

    // ...but the destructive backend cascade must NOT have fired yet — it's delayed ~5s.
    expect(callMock).not.toHaveBeenCalledWith("workspace_delete", { id: "a" });

    // Flushing (e.g. a subsequent workspace switch or window close) commits it for real.
    responses.workspace_delete = { deleted_note_count: 3 };
    await flushPendingDeletes();
    expect(callMock).toHaveBeenCalledWith("workspace_delete", { id: "a" });
  });

  it("undo restores a deleted (formerly active) workspace to its original position and switches back to it, without ever calling workspace_delete", async () => {
    useWorkspacesStore.setState({
      workspaces: [ws("a", "Korean History"), ws("b", "Japan"), ws("c", "France")],
      activeId: "b",
      loaded: true,
    });

    responses.settings_set = { ok: true };
    responses.folder_list = { folders: [], notes_by_folder: {} };

    let onUndo: (() => void) | null = null;
    onUndoToast((toast) => {
      onUndo = toast.onUndo;
    });

    await useWorkspacesStore.getState().remove("b");
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["a", "c"]);
    expect(useWorkspacesStore.getState().activeId).toBe("a");

    callMock.mockClear();
    expect(onUndo).not.toBeNull();
    onUndo!();
    // onRestore's switch-back (activateWorkspaceLocally) is async but onUndo's signature is
    // synchronous (fire-and-forget) — flush the microtask queue so its chained awaits
    // (settings_set → loadTree's folder_list) settle before asserting.
    await new Promise((r) => setTimeout(r, 0));

    const state = useWorkspacesStore.getState();
    // Restored at its original index (1), and the active workspace switches back to it.
    expect(state.workspaces.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(state.activeId).toBe("b");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { active_workspace_id: "b", open_tabs: [], active_tab_id: "home", recent_closed_tabs: [] } });

    // Undo cancels the pending commit outright — the backend cascade must never run.
    await flushPendingDeletes();
    expect(callMock).not.toHaveBeenCalledWith("workspace_delete", expect.anything());
  });

  it("setBgImage() calls workspace_set_bg_image with the file path then reloads the list", async () => {
    responses.workspace_set_bg_image = ws("a", "Korean History", 0, "a/bg.png");
    responses.workspace_list = {
      workspaces: [ws("a", "Korean History", 0, "a/bg.png")],
      active_id: "a",
    };

    await useWorkspacesStore.getState().setBgImage("a", "/tmp/photo.png");

    expect(callMock).toHaveBeenCalledWith("workspace_set_bg_image", {
      id: "a",
      file_path: "/tmp/photo.png",
    });
    expect(callMock).toHaveBeenCalledWith("workspace_list");
  });

  it("clearBgImage() calls workspace_clear_bg_image then reloads the list", async () => {
    responses.workspace_clear_bg_image = ws("a", "Korean History");
    responses.workspace_list = { workspaces: [ws("a", "Korean History")], active_id: "a" };

    await useWorkspacesStore.getState().clearBgImage("a");

    expect(callMock).toHaveBeenCalledWith("workspace_clear_bg_image", { id: "a" });
    expect(callMock).toHaveBeenCalledWith("workspace_list");
  });

  it("remove() of a non-active workspace removes it from the list without touching tabs/tree, and still delays the workspace_delete call", async () => {
    useWorkspacesStore.setState({
      workspaces: [ws("a", "Korean History"), ws("b", "Japan")],
      activeId: "a",
      loaded: true,
    });

    await useWorkspacesStore.getState().remove("b");

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(useWorkspacesStore.getState().activeId).toBe("a");
    // folder_list/settings_set should NOT have been called since "b" wasn't active
    expect(callMock).not.toHaveBeenCalledWith("folder_list");
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    expect(useTabsStore.getState().openTabs).toEqual(["n1", "n2"]);
    expect(callMock).not.toHaveBeenCalledWith("workspace_delete", { id: "b" });

    responses.workspace_delete = { deleted_note_count: 0 };
    await flushPendingDeletes();
    expect(callMock).toHaveBeenCalledWith("workspace_delete", { id: "b" });
  });

  it("remove() is a no-op when only one workspace remains (guards the last workspace)", async () => {
    useWorkspacesStore.setState({
      workspaces: [ws("a", "Korean History")],
      activeId: "a",
      loaded: true,
    });

    await useWorkspacesStore.getState().remove("a");

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(callMock).not.toHaveBeenCalledWith("workspace_delete", expect.anything());
    await flushPendingDeletes();
    expect(callMock).not.toHaveBeenCalledWith("workspace_delete", expect.anything());
  });
});
