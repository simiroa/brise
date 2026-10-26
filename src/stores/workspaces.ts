import { create } from "zustand";
import { call, flushAll } from "../lib/invoke";
import { flushPendingDeletes, scheduleUndoableDelete } from "../lib/undo";
import type { Workspace } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { useNotesStore } from "./notes";
import { useSettingsStore } from "./settings";
import { HOME_TAB_ID, useTabsStore } from "./tabs";
import { useTaxonomyStore } from "./taxonomy";
import { useTrashStore } from "./trash";
import { useArchiveStore } from "./archive";
import { useSelectionStore } from "./selection";

// 워크스페이스의 사용자 확장 지역/시대를 다시 로드.
function applyWorkspaceContext(ws: Workspace | undefined) {
  void useTaxonomyStore.getState().load(ws?.id ?? "");
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** copySettingsFrom = 새 노트북 창의 "설정만 복사" 원본 노트북 id(없으면 기본값으로 시작). */
  create: (name: string, copySettingsFrom?: string) => Promise<Workspace>;
  rename: (id: string, name: string) => Promise<void>;
  /** 노트북 복제 — 노트·설정·반복 일정·달력까지 통째로(workspace_duplicate). 활성 노트북은 그대로. */
  duplicate: (id: string, name: string) => Promise<Workspace>;
  remove: (id: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  setBgImage: (id: string, filePath: string) => Promise<void>;
  clearBgImage: (id: string) => Promise<void>;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => {
  // Reset tabs/active-note, persist active_workspace_id, apply the target workspace's local
  // context (region/era/status taxonomy), and reload its tree — the "switch to this workspace" side effects.
  const activateWorkspaceLocally = async (id: string) => {
    // Bug fix (2026-09-03): the tab reset below used to be memory-only — open_tabs/active_tab_id
    // stayed in the DB. This very settings_set emits "settings-changed" (commands/settings.rs), and
    // ~200ms later settingsChanged.ts → settings.load() → tabs.hydrate() re-read the OLD
    // notebook's tabs straight back onto the new notebook. Persist the cleared tab state in the
    // same write so the echo hydrates what the screen already shows. recent_closed_tabs is
    // cleared too — Ctrl+Shift+T would otherwise reopen another notebook's note.
    await call("settings_set", {
      entries: {
        active_workspace_id: id,
        open_tabs: [],
        active_tab_id: HOME_TAB_ID,
        recent_closed_tabs: [],
      },
    });
    set({ activeId: id });
    // L2: 트리(loadTree)가 새 워크스페이스로 갱신되기 전에 탭/활성 노트를 먼저 리셋해
    // "새 워크스페이스 트리 + 이전 워크스페이스 에디터/탭"이 동시에 보이는 창을 없앤다.
    // Wave 2: land on home for the new workspace (not the old null draft-empty). Home content
    // is workspace-scoped at query time — shell state itself is not per-workspace.
    // Dashboard views (Board, Calendar, Timeline, Map) subscribe to useSettingsStore.activeWorkspaceId.
    // Update activeWorkspaceId here so switching workspace re-fetches dashboard items for the new workspace.
    useTabsStore.setState({ openTabs: [], activeTabId: HOME_TAB_ID, recentClosedTabs: [] });
    useSettingsStore.setState({ activeWorkspaceId: id });
    useNotesStore.setState({ activeNote: null });
    useNotesStore.getState().discardDraft();
    // 노트북별 설정(PLAN-2026-09-19-notebook-settings §4): 모양·언어·달력이 노트북을 따라 통째로
    // 바뀐다. settings-changed 메아리의 load() 는 OS 창 효과(아크릴)를 다시 걸지 않으므로, 전환한
    // 이 창이 한 번 다시 읽고 효과를 한 번 건다(Rust 가 보이는 모든 창으로 퍼뜨린다). 언어가 바뀌면
    // App 의 key={uiLang} 이 크롬을 다시 마운트한다. **트리 로드 앞**에 둔다 — 큰 노트북은 트리가
    // 느려서, 뒤에 두면 새 노트북의 트리가 옛 노트북의 모양으로 한동안 그려진다. 탭 정리는 위
    // settings_set 에 이미 저장됐으므로 load() 의 tabs.hydrate 도 비워진 탭을 읽는다.
    await useSettingsStore.getState().reloadAppearance();
    const ws = get().workspaces.find((w) => w.id === id);
    applyWorkspaceContext(ws);
    await useNotesStore.getState().loadTree();
    // Trash is workspace-scoped — refresh the sidebar badge for the newly-active workspace
    // (count only; full list loads when the Trash modal opens).
    void useTrashStore.getState().loadTrashCount();
    // Bug fix: Archive is workspace-scoped too (archive.ts::archiveCount), but this used to be
    // loaded exactly once at App boot and never again — switching notebooks left the old
    // notebook's count on screen (row could show a stale ">0" for an empty notebook, or fail to
    // render at all for a notebook that actually has archived notes). Same pattern as trash above.
    void useArchiveStore.getState().loadArchiveCount();
    // W8-c 감사: 다중선택은 노트북이 바뀌면 의미가 없다. 지금까지는 노트 id 가 전역 유일이라
    // loadTree() 뒤 pruneNotes 가 뒤늦게 떨궈주는 것에 기대고 있었는데, 그건 우연히 성립하는
    // 암묵적 의존이다(그 사이 렌더에서는 남의 노트북 선택이 액션 바까지 살아 있다). 전환은
    // 선택을 비우는 게 명시적으로 옳다.
    useSelectionStore.getState().clearNotes();
    useSelectionStore.getState().clearAttachments();
  };

  return {
    workspaces: [],
    activeId: null,
    loaded: false,

    load: async () => {
      const r = await call<{ workspaces: Workspace[]; active_id: string }>("workspace_list");
      set({ workspaces: r.workspaces, activeId: r.active_id, loaded: true });
      useSettingsStore.setState({ activeWorkspaceId: r.active_id });
      applyWorkspaceContext(r.workspaces.find((w) => w.id === r.active_id));
    },

    create: async (name, copySettingsFrom) => {
      const ws = await call<Workspace>("workspace_create", {
        name,
        ...(copySettingsFrom ? { copy_settings_from: copySettingsFrom } : {}),
      });
      await get().load();
      return ws;
    },

    duplicate: async (id, name) => {
      const ws = await call<Workspace>("workspace_duplicate", { id, name });
      await get().load();
      return ws;
    },

    rename: async (id, name) => {
      await call("workspace_rename", { id, name });
      await get().load();
    },

    // Highest-blast-radius delete in the app — the backend cascades ALL of this workspace's
    // folders/notes/attachments. Routed through the Tier 1 undo-on-delete primitive
    // (src/lib/undo.ts) rather than a confirm modal, same as every other Tier 1 delete in the
    // codebase (region/era/status removal, attachment/source removal): the workspace disappears
    // from the list immediately, and the real workspace_delete call is delayed ~5s so Undo can
    // cancel it outright — the cascade simply never runs. flushPendingDeletes() (wired into
    // window-close and workspace-switch, see switchTo() below) guarantees a pending
    // workspace-delete still commits if the user moves on within the undo window instead of
    // clicking Undo.
    remove: async (id) => {
      // Preserve the "can't delete the last workspace" guard (mirrors the UI's disableDelete) —
      // bail out before touching anything.
      if (get().workspaces.length <= 1) return;

      // Same flush discipline remove() always had: any debounced note saves for the workspace
      // being left, and any OTHER already-pending undo-on-delete entries (regions/eras/statuses/
      // attachments) that belong to it — commit them now rather than leaving them to fire later
      // against a possibly-gone workspace. This must not (and does not) touch the NEW
      // workspace-delete entry scheduled below, since that one doesn't exist yet.
      await flushAll();
      await flushPendingDeletes();

      const current = get();
      const idx = current.workspaces.findIndex((w) => w.id === id);
      if (idx === -1) return; // already gone (e.g. a racing delete)
      const removedWs = current.workspaces[idx];
      const wasActive = current.activeId === id;
      const remaining = current.workspaces.filter((w) => w.id !== id);

      // Optimistic local removal — the backend cascade has not run yet.
      set({ workspaces: remaining });

      if (wasActive) {
        // Active workspace was (optimistically) removed — switch to the first remaining one
        // immediately, same UI reset switchTo() performs, so the editor doesn't keep showing the
        // deleted workspace's tabs/notes.
        const fallback = remaining[0];
        if (fallback) await activateWorkspaceLocally(fallback.id);
      }

      scheduleUndoableDelete({
        commit: () => call("workspace_delete", { id }),
        onRestore: () => {
          set((s) => {
            const next = [...s.workspaces];
            next.splice(Math.min(idx, next.length), 0, removedWs);
            return { workspaces: next };
          });
          // Fully restore prior UI state: if deleting this workspace switched us away from it,
          // switch back.
          if (wasActive) void activateWorkspaceLocally(id);
        },
        label: t("workspace.deleted"),
      });
    },

    switchTo: async (id) => {
      await flushAll();
      // See remove() above — pending undo-on-delete entries belong to the workspace being left.
      await flushPendingDeletes();
      await activateWorkspaceLocally(id);
    },

    // Wave 13: 좌상단 워크스페이스 스위처는 노트 컬렉션의 "이름"이므로 사용자가 배경 이미지를
    // 지정할 수 있어야 한다 — 파일은 attachments 와 동일하게 앱 폴더로 복사되고(서버가 처리),
    // 여기서는 선택된 절대경로를 넘기고 목록을 재로드할 뿐이다.
    setBgImage: async (id, filePath) => {
      await call("workspace_set_bg_image", { id, file_path: filePath });
      await get().load();
    },

    clearBgImage: async (id) => {
      await call("workspace_clear_bg_image", { id });
      await get().load();
    },
  };
});
