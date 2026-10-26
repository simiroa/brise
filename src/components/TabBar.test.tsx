import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, waitFor, act, screen, fireEvent } from "@testing-library/react";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const emitNoticeMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

import { TabBar } from "./TabBar";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { HOME_TAB_ID, useTabsStore } from "../stores/tabs";
import { useAiStore } from "../stores/ai";
import { t } from "../i18n/t";
import { AskAiModal as LazyAskAiModal } from "../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

// Bug fix regression: TabBar's close (X) button used to call only settings.closeTab(id), which
// updates openTabs/activeTabId but never touches useNotesStore.activeNote — closing the active
// tab left the editor showing the now-closed note. Mirrors the delete flows in
// TitleBar.tsx/ContextMenu.tsx (runDelete: closeTab -> selectNote(next), or clear if none left).
// Wave 2: last note tab closed activates home (replaces the old null empty-state).

describe("TabBar — close button syncs activeNote (Bug fix)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "note_get") {
        return Promise.resolve({ note: { id: args.id, title: `Note ${args.id}` }, sections: [] });
      }
      return Promise.resolve({});
    });
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useNotesStore.setState({
      notesByFolder: {
        f1: [
          { id: "n1", title: "Note n1" } as any,
          { id: "n2", title: "Note n2" } as any,
        ],
      },
      // TabBar now reads titles from noteIndex (the store's id -> NoteSummary accelerator, see
      // stores/notes.ts buildNoteIndex) rather than scanning notesByFolder itself — keep it in
      // sync here the way loadTree() does in the real store.
      noteIndex: new Map([
        ["n1", { id: "n1", title: "Note n1" } as any],
        ["n2", { id: "n2", title: "Note n2" } as any],
      ]),
      loadingNoteId: null,
      activeDraft: false,
    });
  });

  it("closing the active tab selects the next remaining tab's note", async () => {
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n2" });
    useNotesStore.setState({
      activeNote: { note: { id: "n2", title: "Note n2" }, sections: [] } as any,
    });

    const { container } = render(<TabBar />);
    const closeButtons = container.querySelectorAll(".tab-close");
    expect(closeButtons.length).toBe(2);

    // Close the second tab (n2), which is the active one.
    (closeButtons[1] as HTMLButtonElement).click();

    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
    expect(useTabsStore.getState().activeTabId).toBe("n1");

    await waitFor(() => {
      expect(useNotesStore.getState().activeNote?.note.id).toBe("n1");
    });
  });

  it("closing the last remaining note tab activates home and clears the editor", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Note n1" }, sections: [] } as any,
    });

    const { container } = render(<TabBar />);
    const closeButtons = container.querySelectorAll(".tab-close");
    expect(closeButtons.length).toBe(1);

    (closeButtons[0] as HTMLButtonElement).click();

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(useNotesStore.getState().activeNote).toBeNull();
  });

  it("closing a background (non-active) tab does not touch activeNote", async () => {
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n2" });
    useNotesStore.setState({
      activeNote: { note: { id: "n2", title: "Note n2" }, sections: [] } as any,
    });

    const { container } = render(<TabBar />);
    const closeButtons = container.querySelectorAll(".tab-close");

    // Close the first tab (n1), which is NOT active.
    (closeButtons[0] as HTMLButtonElement).click();

    expect(useTabsStore.getState().openTabs).toEqual(["n2"]);
    expect(useTabsStore.getState().activeTabId).toBe("n2");
    // activeNote must be left alone — still n2, and selectNote("n2") must not have been
    // re-triggered by closing an unrelated tab.
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n2");
    expect(callMock).not.toHaveBeenCalledWith("note_get", expect.anything());
  });

  // 회귀(2026-10-18): 닫기(×) 버튼에 접근 가능한 이름이 없어 스크린리더에 그냥 "버튼"으로 읽혔고
  // 마우스를 올려도 설명이 없었다. 노트 제목을 넣은 이름을 aria-label·title 둘 다에 단다.
  it("each close button is named after its note title (aria-label + title)", () => {
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n1" });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Note n1" }, sections: [] } as any,
    });
    render(<TabBar />);
    const name = t("tabs.close_tab", { title: "Note n2" });
    expect(name).toContain("Note n2");
    const btn = screen.getByRole("button", { name });
    expect(btn.classList.contains("tab-close")).toBe(true);
    expect(btn.getAttribute("title")).toBe(name);
    expect(screen.getByRole("button", { name: t("tabs.close_tab", { title: "Note n1" }) })).toBeTruthy();
  });

  it("fireEvent.contextMenu on a note tab renders both menu items ('tabs.close_others' & 'tabs.close_all')", async () => {
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n1" });
    const { container, getByText } = render(<TabBar />);
    // First child is home; note tabs follow.
    const tabs = container.querySelectorAll(".scroll > div");
    expect(tabs.length).toBe(3);

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(tabs[1]); // n1

    expect(getByText(/Close others|Fermer les autres|다른 탭 닫기/i)).toBeDefined();
    expect(getByText(/Close all|Fermer tout|모두 닫기/i)).toBeDefined();
  });

  it("asserts the editor is cleared and activeTabId is home after closeAllTabs", async () => {
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n1" });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Note n1" }, sections: [] } as any,
    });

    const { container, getByText } = render(<TabBar />);
    const tabs = container.querySelectorAll(".scroll > div");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(tabs[1]); // n1

    const closeAllBtn = getByText(/Close all|Fermer tout|모두 닫기/i);
    fireEvent.click(closeAllBtn);

    expect(useTabsStore.getState().openTabs).toEqual([]);
    expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    expect(useNotesStore.getState().activeNote).toBeNull();
  });

  it("renders the bar (with the '+' new-note button) at 0 note tabs — home still present (P30 item 2)", async () => {
    useTabsStore.setState({ openTabs: [], activeTabId: HOME_TAB_ID });
    useNotesStore.setState({ activeNote: null, activeDraft: false });

    const { container } = render(<TabBar />);

    // No close buttons (home has none), but home tab + "+" affordance are there.
    expect(container.querySelectorAll(".tab-close").length).toBe(0);
    expect(container.querySelector('[data-tab="home"]')).not.toBeNull();
    expect(container.querySelector(".tab-new-btn")).not.toBeNull();
  });

  it("context menu at clientX near window.innerWidth flips the menu fully inside the viewport", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    const { container } = render(<TabBar />);
    const noteTab = container.querySelector('[data-tab="n1"]');
    expect(noteTab).not.toBeNull();

    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 768 });

    // useMenuPos measures the real menu via getBoundingClientRect on mount (useLayoutEffect runs
    // before paint). jsdom returns all-0 rects by default, so stub a realistic menu size on the
    // prototype *before* the menu mounts to exercise the flip.
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        width: 210,
        height: 90,
        left: 0,
        top: 0,
        right: 210,
        bottom: 90,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(noteTab!, { clientX: 1000, clientY: 750 });

    const menu = (container.querySelector(".overlay") ?? document.querySelector(".overlay")) as HTMLElement;
    expect(menu).not.toBeNull();

    const leftVal = parseInt(menu.style.left, 10);
    const topVal = parseInt(menu.style.top, 10);
    expect(leftVal + 210).toBeLessThanOrEqual(window.innerWidth);
    expect(topVal + 90).toBeLessThanOrEqual(window.innerHeight);
    expect(leftVal).toBe(1000 - 210); // flipped left of cursor (would overflow right edge)
    expect(topVal).toBe(750 - 90); // flipped above cursor (would overflow bottom edge)

    rectSpy.mockRestore();
  });
});

describe("TabBar — home tab invariants (Wave 2)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    useNotesStore.setState({
      noteIndex: new Map([
        ["n1", { id: "n1", title: "Note n1" } as any],
      ]),
      activeNote: null,
      activeDraft: false,
      loadingNoteId: null,
    });
  });

  it("always renders home as the first tab with no close button", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    const { container } = render(<TabBar />);

    const tabs = container.querySelectorAll(".scroll > div");
    expect(tabs.length).toBe(2);
    expect(tabs[0].getAttribute("data-tab")).toBe("home");
    expect(tabs[1].getAttribute("data-tab")).toBe("n1");
    // Only the note tab has a close button.
    expect(tabs[0].querySelector(".tab-close")).toBeNull();
    expect(tabs[1].querySelector(".tab-close")).not.toBeNull();
  });

  it("clicking home sets activeTabId to home and clears activeNote", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Note n1" }, sections: [] } as any,
    });

    const { container } = render(<TabBar />);
    const home = container.querySelector('[data-tab="home"]') as HTMLElement;
    home.click();

    await waitFor(() => {
      expect(useTabsStore.getState().activeTabId).toBe(HOME_TAB_ID);
    });
    expect(useNotesStore.getState().activeNote).toBeNull();
    // openTabs unchanged — home is virtual.
    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
  });

  it("home has no context menu (right-click does not open overlay)", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: HOME_TAB_ID });
    const { container } = render(<TabBar />);
    const home = container.querySelector('[data-tab="home"]') as HTMLElement;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(home);
    expect(container.querySelector(".overlay") ?? document.querySelector(".overlay")).toBeNull();
  });
});

// Bug fix regression: a note opened by an id-only path (dashboard board/calendar/timeline/map,
// search, note:// links) never populates noteIndex — only loadTree()'s tree window and
// selectNote()'s own mergeNoteSummaries do. Once the tab stops being activeNote (e.g. the user
// activates home), TabBar's titleById used to fall back to a noteIndex miss and render
// "Untitled note" forever. TabBar now self-heals via the existing ensureNoteSummaries
// (note_summaries_map + mergeNoteSummaries), the same mechanism App.tsx already uses for
// boot-restored tabs.
describe("TabBar — self-heal missing tab titles via ensureNoteSummaries (Bug fix)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "note_summaries_map") {
        const notes: Record<string, unknown> = {};
        for (const id of args.ids as string[]) {
          notes[id] = { id, folder_id: "f1", title: `Note ${id}` };
        }
        return Promise.resolve({ notes });
      }
      return Promise.resolve({});
    });
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useNotesStore.setState({
      notesByFolder: {},
      noteIndex: new Map(),
      loadingNoteId: null,
      activeDraft: false,
      activeNote: null,
    });
  });

  it("id-only open (dashboard-style): tab absent from noteIndex still gets a real title once home is active", async () => {
    // Simulates the dashboard opening a note by id, then the user switching to home — the tab
    // is no longer activeNote, and it was never written into noteIndex.
    useTabsStore.setState({ openTabs: ["dash1"], activeTabId: HOME_TAB_ID });

    const { container } = render(<TabBar />);

    // Title starts as the untitled fallback (noteIndex miss)...
    const tab = () => container.querySelector('[data-tab="dash1"]') as HTMLElement;
    expect(tab()).not.toBeNull();

    // ...then self-heals once ensureNoteSummaries resolves.
    await waitFor(() => {
      expect(tab().textContent).toContain("Note dash1");
    });
    expect(callMock).toHaveBeenCalledWith("note_summaries_map", { ids: ["dash1"] });
    expect(useNotesStore.getState().noteIndex.get("dash1")?.title).toBe("Note dash1");
  });

  it("re-fires after loadTree() wholesale-replaces noteIndex (wipes a previously-healed title)", async () => {
    useTabsStore.setState({ openTabs: ["dash1"], activeTabId: HOME_TAB_ID });
    const { container } = render(<TabBar />);
    const tab = () => container.querySelector('[data-tab="dash1"]') as HTMLElement;

    await waitFor(() => {
      expect(tab().textContent).toContain("Note dash1");
    });
    callMock.mockClear();

    // loadTree() replaces the whole noteIndex Map on nearly every mutation — simulate that
    // wiping this tab's entry back out.
    act(() => {
      useNotesStore.setState({ noteIndex: new Map() });
    });

    await waitFor(() => {
      expect(tab().textContent).toContain("Note dash1");
    });
    expect(callMock).toHaveBeenCalledWith("note_summaries_map", { ids: ["dash1"] });
  });

  it("does not refire ensureNoteSummaries for an id that stays missing (no infinite loop)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_summaries_map") return Promise.resolve({ notes: {} }); // never resolves the id
      return Promise.resolve({});
    });
    useTabsStore.setState({ openTabs: ["ghost"], activeTabId: HOME_TAB_ID });

    render(<TabBar />);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_summaries_map", { ids: ["ghost"] });
    });
    const callsAfterFirstResolve = callMock.mock.calls.length;

    // Give React/microtasks a beat to settle — the missing set is unchanged, so no re-fetch.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(callMock.mock.calls.length).toBe(callsAfterFirstResolve);
  });
});

describe("TabBar — Ask-AI tab row (AskAiModal.tsx)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useAiStore.setState({ translateGateOk: null });
    useNotesStore.setState({
      noteIndex: new Map([["n1", { id: "n1", title: "Note n1" } as any]]),
      activeNote: null,
      activeDraft: false,
      loadingNoteId: null,
    });
  });

  it("does not render when aiEnabled is off", () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useSettingsStore.setState({ aiEnabled: false });
    const { container } = render(<TabBar />);
    const tab = container.querySelector('[data-tab="n1"]') as HTMLElement;
    fireEvent.contextMenu(tab);
    expect(screen.queryByText(/AI에게 묻기|Ask AI/)).toBeNull();
  });

  it("renders when aiEnabled is on, and clicking it (gate open) opens the Ask-AI modal with the tab's title", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useSettingsStore.setState({ aiEnabled: true });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      }
      return Promise.resolve({});
    });
    const { container } = render(<TabBar />);
    const tab = container.querySelector('[data-tab="n1"]') as HTMLElement;
    fireEvent.contextMenu(tab);

    fireEvent.click(screen.getByText(/AI에게 묻기|Ask AI/));

    await waitFor(() => expect(screen.getByTestId("modal-shell")).toBeTruthy());
    // "Note n1" also appears in the tab strip itself (still rendered behind the modal) — scope
    // the title check to the modal shell so this doesn't false-positive.
    expect(screen.getByTestId("modal-shell").textContent).toContain("Note n1");
  });

  it("clicking it while the AI gate is blocked notices instead of opening the modal", async () => {
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    useSettingsStore.setState({ aiEnabled: true });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "https://api.openai.com" } });
      }
      return Promise.resolve({});
    });
    const { container } = render(<TabBar />);
    const tab = container.querySelector('[data-tab="n1"]') as HTMLElement;
    fireEvent.contextMenu(tab);

    fireEvent.click(screen.getByText(/AI에게 묻기|Ask AI/));

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });
});
