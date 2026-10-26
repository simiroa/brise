// R2-b 분리: stores/settings.ts 의 탭/세션 상태(activeTabId/openTabs/recentClosedTabs 와
// 그 조작 액션들)를 옮겼다 — 이건 "설정"이 아니라 세션 상태다(docs/PLAN-refactor-2026-08-04.md §R2).
// 영속 경로는 그대로다: settings_set 의 open_tabs/active_tab_id/recent_closed_tabs 키, 백엔드
// validate_setting allowlist 도 안 바뀐다. 부팅 시 hydrate()는 settings.ts::load()가 이미 받아온
// settings_get_all 결과를 그대로 넘겨 호출한다(별도 IPC 왕복 없음, 같은 부팅 시점 유지).
import { create } from "zustand";
import { call, callSilent } from "../lib/invoke";

// Wave 2 (dashboard): fixed home tab sentinel. Never enters openTabs (disk format stays a pure
// note-id array). Render layer synthesizes the 🏠 tab in first position; activeTabId may be this
// string. Backend validate_setting already accepts any string | null for active_tab_id.
export const HOME_TAB_ID = "home" as const;

/** True when the active chrome tab is the virtual home/dashboard slot. */
export function isHomeTab(id: string | null | undefined): boolean {
  return id === HOME_TAB_ID;
}

/** True when id is a real note tab (not null, not the home sentinel). */
export function isNoteTabId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length > 0 && id !== HOME_TAB_ID;
}

/** Cap for recent_closed_tabs (frontend-owned; validate_setting allows up to 20). */
export const RECENT_CLOSED_TABS_MAX = 10;

function pushClosedTab(list: string[], id: string): string[] {
  const next = [id, ...list.filter((x) => x !== id)];
  return next.slice(0, RECENT_CLOSED_TABS_MAX);
}

/** 여러 탭을 한꺼번에 닫을 때의 누적 — 뒤에서부터 밀어 넣어 왼쪽(앞) 탭이 가장 최신이 되게 한다. */
export function pushClosedMany(list: string[], ids: readonly string[]): string[] {
  let next = list;
  for (let i = ids.length - 1; i >= 0; i--) next = pushClosedTab(next, ids[i]);
  return next;
}

function persistClosedTabs(tabs: string[]) {
  // Literal key so scripts/check-settings-keys.mjs can extract it.
  void callSilent("settings_set", { entries: { recent_closed_tabs: tabs } }).catch(() => {});
}

// H2: 탭/활성 노트 복원을 위해 open_tabs + active_tab_id 를 fire-and-forget 으로 영속화.
function persistTabs(openTabs: string[], activeTabId: string | null) {
  // Literal keys so scripts/check-settings-keys.mjs can extract them.
  void callSilent("settings_set", {
    entries: { open_tabs: openTabs, active_tab_id: activeTabId },
  }).catch(() => {});
}

/** 탭을 닫는 모든 경로(하나/전부/나머지)의 종착점 — 닫힌 탭 누적 → 상태 반영 → open_tabs+active_tab_id 저장 →
 *  (닫힌 게 있을 때만) recent_closed_tabs 저장. 저장 순서(open_tabs 먼저)는 그대로 유지한다. */
function closeMany(dropped: string[], openTabs: string[], activeTabId: string | null): void {
  const recentClosedTabs = pushClosedMany(useTabsStore.getState().recentClosedTabs, dropped);
  useTabsStore.setState({ openTabs, activeTabId, recentClosedTabs });
  persistTabs(openTabs, activeTabId);
  if (dropped.length) persistClosedTabs(recentClosedTabs);
}

interface TabsState {
  activeTabId: string | null;
  openTabs: string[]; // 정렬된 탭 id 배열
  /** QA8 Wave 4A — recently closed note tab ids (newest first). Session convenience for
   *  Ctrl+Shift+T reopen; stored in settings kv `recent_closed_tabs`, NOT activity_log. */
  recentClosedTabs: string[];
  /** settings.ts::load()가 settings_get_all 결과를 받은 그 시점에 호출 — 별도 fetch 없음. */
  hydrate: (settings: Record<string, unknown>) => void;
  setActiveTab: (id: string | null) => Promise<void>;
  pushTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (keepId: string) => void;
  /** Pop the most recently closed note id (and persist). Returns null when empty. */
  reopenClosedTab: () => string | null;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  // Wave 2: boot / empty default is the fixed home tab (not null draft-empty-state).
  activeTabId: HOME_TAB_ID as string | null,
  openTabs: [],
  recentClosedTabs: [],

  hydrate: (s) => {
    const openTabs = Array.isArray(s.open_tabs)
      ? (s.open_tabs as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const recentClosedTabs = Array.isArray(s.recent_closed_tabs)
      ? (s.recent_closed_tabs as unknown[])
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .slice(0, RECENT_CLOSED_TABS_MAX)
      : [];
    // Bug fix: newNote()'s ambiguous entry point ("+") deliberately persists active_tab_id as
    // literal null — it's the draft-page model's "no tab active" state (see notesActive.ts's
    // newNote()). settings_get_all round-trips that null back as-is (settings_schema.rs's own
    // comment: "저장된 적 없음 = get_all()에 키 자체가 없음" — key ABSENT is the "never
    // persisted" signal, not a present null). `??` cannot tell "never persisted" apart from
    // "persisted as null", so it used to collapse both to HOME_TAB_ID — and settings.ts's load()
    // (hence this hydrate()) re-ran on the settings-changed echo of the draft page's own
    // tab-deactivation write, bouncing the user back to the dashboard. That echo is skipped now
    // (settingsChanged.ts WINDOW_LOCAL_KEYS), but a full reload (notebook switch, settings window,
    // old payload without keys) still re-runs hydrate(), so the distinction stays load-bearing:
    // only fall back when the key is truly absent (undefined); a persisted string or null is honored.
    const rawActiveTabId = s.active_tab_id;
    const activeTabId =
      rawActiveTabId === undefined
        ? HOME_TAB_ID
        : ((rawActiveTabId === null || typeof rawActiveTabId === "string"
            ? rawActiveTabId
            : HOME_TAB_ID) as string | null);
    set({
      openTabs,
      recentClosedTabs,
      // Wave 2: unset active_tab_id boots on home. A persisted note id (or "home") still wins —
      // deep-link / selectNote paths after boot also take priority via pushTab.
      activeTabId,
    });
  },

  setActiveTab: async (id) => {
    set({ activeTabId: id });
    await call("settings_set", { entries: { active_tab_id: id } });
  },
  pushTab: (id) => {
    // Home is virtual — never land in openTabs (disk format is note ids only).
    if (id === HOME_TAB_ID) {
      set({ activeTabId: HOME_TAB_ID });
      void callSilent("settings_set", { entries: { active_tab_id: HOME_TAB_ID } }).catch(() => {});
      return;
    }
    const tabs = get().openTabs;
    const nextTabs = tabs.includes(id) ? tabs : [...tabs, id];
    set({ openTabs: nextTabs, activeTabId: id });
    persistTabs(nextTabs, id);
  },
  closeTab: (id) => {
    // Closing the home sentinel is a no-op (pinned, not in openTabs).
    if (id === HOME_TAB_ID) return;
    const wasOpen = get().openTabs.includes(id);
    const tabs = get().openTabs.filter((t) => t !== id);
    // Last note tab closed → activate home (replaces the old null empty-state / draft-page path).
    const active =
      get().activeTabId === id ? tabs[tabs.length - 1] ?? HOME_TAB_ID : get().activeTabId;
    closeMany(wasOpen ? [id] : [], tabs, active);
  },
  closeAllTabs: () => {
    // Note tabs only — home is virtual and becomes active after "close all".
    closeMany(get().openTabs, [], HOME_TAB_ID);
  },
  closeOtherTabs: (keepId) => {
    if (keepId === HOME_TAB_ID) {
      // "Close others" from home → drop every note tab, stay on home.
      closeMany(get().openTabs, [], HOME_TAB_ID);
      return;
    }
    const dropped = get().openTabs.filter((t) => t !== keepId);
    const tabs = get().openTabs.includes(keepId) ? [keepId] : [];
    const active = tabs.length > 0 ? keepId : HOME_TAB_ID;
    closeMany(dropped, tabs, active);
  },
  reopenClosedTab: () => {
    const [id, ...rest] = get().recentClosedTabs;
    if (!id) return null;
    set({ recentClosedTabs: rest });
    persistClosedTabs(rest);
    return id;
  },
}));
