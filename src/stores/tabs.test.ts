import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

import { useTabsStore, HOME_TAB_ID, isHomeTab, isNoteTabId, pushClosedMany } from "./tabs";

describe("tabs store — tab persistence (H2: restore tabs/active note across restart)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useTabsStore.setState({
      openTabs: ["n1", "n2", "n3"],
      activeTabId: "n3",
      recentClosedTabs: [],
    });
  });

  // QA8 Wave 4A — reopen closed tab (settings kv, separate from activity_log).
  it("closeTab() records the closed id in recent_closed_tabs (newest first, capped)", () => {
    useTabsStore.getState().closeTab("n2");
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n2"]);
    useTabsStore.getState().closeTab("n1");
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n2"]);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { recent_closed_tabs: ["n1", "n2"] },
    });
  });

  it("reopenClosedTab() pops newest and persists the remainder", () => {
    useTabsStore.setState({ recentClosedTabs: ["n3", "n2", "n1"] });
    const id = useTabsStore.getState().reopenClosedTab();
    expect(id).toBe("n3");
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n2", "n1"]);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { recent_closed_tabs: ["n2", "n1"] },
    });
    expect(useTabsStore.getState().reopenClosedTab()).toBe("n2");
    expect(useTabsStore.getState().reopenClosedTab()).toBe("n1");
    expect(useTabsStore.getState().reopenClosedTab()).toBeNull();
  });

  it("closeTab() persists the pruned open_tabs (+ active_tab_id) via settings_set", () => {
    useTabsStore.getState().closeTab("n3");

    expect(useTabsStore.getState().openTabs).toEqual(["n1", "n2"]);
    expect(useTabsStore.getState().activeTabId).toBe("n2");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { open_tabs: ["n1", "n2"], active_tab_id: "n2" },
    });
  });

  it("closeTab() of a non-active tab keeps the active tab and still persists open_tabs", () => {
    useTabsStore.getState().closeTab("n1");

    expect(useTabsStore.getState().openTabs).toEqual(["n2", "n3"]);
    expect(useTabsStore.getState().activeTabId).toBe("n3");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { open_tabs: ["n2", "n3"], active_tab_id: "n3" },
    });
  });

  it("closeTab() of the last remaining note tab activates home (not null)", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useTabsStore.getState().closeTab("n1");

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { open_tabs: [], active_tab_id: HOME_TAB_ID },
    });
  });

  it("closeTab(HOME_TAB_ID) is a no-op — home is not closable and not in openTabs", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: HOME_TAB_ID });
    useTabsStore.getState().closeTab(HOME_TAB_ID);

    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("closeAllTabs() empties open_tabs and activates home", () => {
    useTabsStore.getState().closeAllTabs();

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { open_tabs: [], active_tab_id: HOME_TAB_ID },
    });
  });

  it("closeOtherTabs(keepId) keeps only the specified tab and sets it as active", () => {
    useTabsStore.getState().closeOtherTabs("n2");

    expect(useTabsStore.getState().openTabs).toEqual(["n2"]);
    expect(useTabsStore.getState().activeTabId).toBe("n2");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { open_tabs: ["n2"], active_tab_id: "n2" },
    });
  });

  it("closeOtherTabs(HOME_TAB_ID) drops every note tab and stays on home", () => {
    useTabsStore.getState().closeOtherTabs(HOME_TAB_ID);

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
  });

  it("pushTab never puts home into openTabs", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useTabsStore.getState().pushTab(HOME_TAB_ID);

    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { active_tab_id: HOME_TAB_ID },
    });
  });

  it("hydrate() restores open_tabs (string[]) and active_tab_id from a settings_get_all response", () => {
    useTabsStore.getState().hydrate({
      theme: "dark",
      open_tabs: ["a", "b", "c"],
      active_tab_id: "b",
    });

    expect(useTabsStore.getState().openTabs).toEqual(["a", "b", "c"]);
    expect(useTabsStore.getState().activeTabId).toBe("b");
  });

  it("hydrate() restores active_tab_id='home' without putting home in open_tabs", () => {
    useTabsStore.getState().hydrate({
      theme: "dark",
      open_tabs: ["a"],
      active_tab_id: HOME_TAB_ID,
    });

    expect(useTabsStore.getState().openTabs).toEqual(["a"]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
  });

  it("hydrate() defaults to an empty tab list / home active tab when unset (Wave 2 boot)", () => {
    useTabsStore.getState().hydrate({ theme: "dark" });

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
  });

  it("regression: hydrate() honors a persisted active_tab_id of null instead of collapsing it to home", () => {
    // Bug report: "+ new note" button lands on the dashboard instead of the draft editor.
    // newNote()'s ambiguous entry point persists active_tab_id: null on purpose (the draft-page
    // model's "no tab active" state — see notesActive.ts::newNote()). settings_get_all round-
    // trips that back as an explicit null (settings_schema.rs), not an absent key — absent is
    // what actually means "never persisted, first boot". hydrate() used to apply `?? HOME_TAB_ID`
    // to the raw value, which conflated the two and forced null back to "home". Since
    // settings.ts's load() (and therefore this hydrate()) also re-runs on every settings-changed
    // echo (settingsChanged.ts) — including the echo of the very write that persisted this same
    // null — every live "+" click used to get silently kicked back to the dashboard ~200ms later.
    useTabsStore.getState().hydrate({ open_tabs: ["n1"], active_tab_id: null });

    expect(useTabsStore.getState().activeTabId).toBeNull();
    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
  });

  it("hydrate() still falls back to home when active_tab_id is genuinely absent, even alongside other keys", () => {
    // Distinguishes "key never persisted" (undefined) from "persisted as null" above — both are
    // real settings_get_all shapes, and only the former should default to home.
    useTabsStore.getState().hydrate({ theme: "dark", open_tabs: ["n1"] });

    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
  });
});

// 특성화 — 닫은 탭 누적(recent_closed_tabs)과 open_tabs/active_tab_id 영속의 순서·호출 수를 못 박는다.
// closeTab/closeAllTabs/closeOtherTabs(홈 분기·일반 분기)/pushTab 이 같은 조각을 공유해도 결과가
// 안 변한다는 근거다(위 describe 는 recent_closed_tabs 를 closeTab 하나로만 봤다).
describe("tabs store — 닫은 탭 누적·영속 순서 (closeAll / closeOthers / pushTab)", () => {
  const settingsSet = (entries: Record<string, unknown>) => ["settings_set", { entries }];

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useTabsStore.setState({
      openTabs: ["n1", "n2", "n3"],
      activeTabId: "n3",
      recentClosedTabs: [],
    });
  });

  it("closeAllTabs(): 왼쪽 탭이 가장 최신으로 쌓이고, open_tabs 저장 다음에 recent_closed_tabs 를 저장한다", () => {
    useTabsStore.getState().closeAllTabs();

    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n2", "n3"]);
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: [], active_tab_id: HOME_TAB_ID }),
      settingsSet({ recent_closed_tabs: ["n1", "n2", "n3"] }),
    ]);
  });

  it("closeAllTabs(): 열린 탭이 없으면 recent_closed_tabs 는 저장하지 않는다", () => {
    useTabsStore.setState({ openTabs: [], activeTabId: HOME_TAB_ID });
    useTabsStore.getState().closeAllTabs();

    expect(useTabsStore.getState().recentClosedTabs).toEqual([]);
    expect(callMock.mock.calls).toEqual([settingsSet({ open_tabs: [], active_tab_id: HOME_TAB_ID })]);
  });

  it("closeAllTabs(): 이미 있던 항목은 중복 없이 앞으로 올라오고, 10개 상한에서 오래된 것부터 잘린다", () => {
    useTabsStore.setState({ recentClosedTabs: ["n2", "x"] });
    useTabsStore.getState().closeAllTabs();
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n2", "n3", "x"]);

    const older = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
    useTabsStore.setState({ openTabs: ["n1", "n2", "n3"], recentClosedTabs: older });
    useTabsStore.getState().closeAllTabs();
    expect(useTabsStore.getState().recentClosedTabs).toEqual([
      "n1", "n2", "n3", "r0", "r1", "r2", "r3", "r4", "r5", "r6",
    ]);
  });

  it("closeOtherTabs(keepId): 남기는 탭을 뺀 나머지가 같은 순서로 쌓이고 open_tabs → recent_closed_tabs 순으로 저장한다", () => {
    useTabsStore.getState().closeOtherTabs("n2");

    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n3"]);
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: ["n2"], active_tab_id: "n2" }),
      settingsSet({ recent_closed_tabs: ["n1", "n3"] }),
    ]);
  });

  it("closeOtherTabs(keepId): 열려 있지 않은 id 를 넘기면 전부 닫히고 홈이 활성이 된다", () => {
    useTabsStore.getState().closeOtherTabs("zz");

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n2", "n3"]);
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: [], active_tab_id: HOME_TAB_ID }),
      settingsSet({ recent_closed_tabs: ["n1", "n2", "n3"] }),
    ]);
  });

  it("closeOtherTabs(keepId): 남는 탭이 하나뿐이면 닫힌 게 없어 recent_closed_tabs 를 저장하지 않는다", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useTabsStore.getState().closeOtherTabs("n1");

    expect(useTabsStore.getState().recentClosedTabs).toEqual([]);
    expect(callMock.mock.calls).toEqual([settingsSet({ open_tabs: ["n1"], active_tab_id: "n1" })]);
  });

  it("closeOtherTabs(HOME_TAB_ID): closeAllTabs 와 같은 상태·같은 저장 순서다", () => {
    useTabsStore.getState().closeOtherTabs(HOME_TAB_ID);

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(useTabsStore.getState().recentClosedTabs).toEqual(["n1", "n2", "n3"]);
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: [], active_tab_id: HOME_TAB_ID }),
      settingsSet({ recent_closed_tabs: ["n1", "n2", "n3"] }),
    ]);
  });

  it("closeTab(): open_tabs 저장 다음에 recent_closed_tabs 를 저장한다", () => {
    useTabsStore.getState().closeTab("n3");

    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: ["n1", "n2"], active_tab_id: "n2" }),
      settingsSet({ recent_closed_tabs: ["n3"] }),
    ]);
  });

  it("pushTab(): 새 탭이면 뒤에 붙이고, 이미 열린 탭이면 목록은 그대로 두고, 둘 다 open_tabs+active_tab_id 한 번만 저장한다", () => {
    useTabsStore.getState().pushTab("n4");
    expect(useTabsStore.getState().openTabs).toEqual(["n1", "n2", "n3", "n4"]);
    expect(useTabsStore.getState().activeTabId).toBe("n4");
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: ["n1", "n2", "n3", "n4"], active_tab_id: "n4" }),
    ]);

    callMock.mockClear();
    useTabsStore.getState().pushTab("n2");
    expect(useTabsStore.getState().openTabs).toEqual(["n1", "n2", "n3", "n4"]);
    expect(useTabsStore.getState().activeTabId).toBe("n2");
    expect(callMock.mock.calls).toEqual([
      settingsSet({ open_tabs: ["n1", "n2", "n3", "n4"], active_tab_id: "n2" }),
    ]);
  });
});

describe("pushClosedMany — 여러 탭을 뒤에서부터 누적하는 순수 함수", () => {
  it("빈 ids 는 목록을 그대로 돌려준다", () => {
    const list = ["a", "b"];
    expect(pushClosedMany(list, [])).toBe(list);
    expect(pushClosedMany([], [])).toEqual([]);
  });

  it("ids 의 앞쪽이 가장 최신이 된다 (뒤에서부터 밀어 넣는다)", () => {
    expect(pushClosedMany([], ["n1", "n2", "n3"])).toEqual(["n1", "n2", "n3"]);
    expect(pushClosedMany(["x"], ["n1", "n2"])).toEqual(["n1", "n2", "x"]);
  });

  it("이미 있던 id 는 중복 없이 앞으로 올라온다", () => {
    expect(pushClosedMany(["n2", "x", "n1"], ["n1", "n2", "n3"])).toEqual(["n1", "n2", "n3", "x"]);
  });

  it("RECENT_CLOSED_TABS_MAX(10) 를 넘으면 오래된 것부터 잘린다", () => {
    const older = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
    expect(pushClosedMany(older, ["n1", "n2"])).toEqual([
      "n1", "n2", "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
    ]);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const list = ["x"];
    const ids = ["n1", "n2"];
    pushClosedMany(list, ids);
    expect(list).toEqual(["x"]);
    expect(ids).toEqual(["n1", "n2"]);
  });
});

describe("home tab helpers", () => {
  it("isHomeTab / isNoteTabId distinguish the sentinel from note ids", () => {
    expect(isHomeTab(HOME_TAB_ID)).toBe(true);
    expect(isHomeTab("n1")).toBe(false);
    expect(isHomeTab(null)).toBe(false);
    expect(isNoteTabId(HOME_TAB_ID)).toBe(false);
    expect(isNoteTabId("n1")).toBe(true);
    expect(isNoteTabId(null)).toBe(false);
  });
});
