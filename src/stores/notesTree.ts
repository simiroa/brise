// R2-a 분리: stores/notes.ts 의 트리·코퍼스 캐시 관심사(folders/notesByFolder/noteIndex 및
// loadTree 계열)를 이 슬라이스로 옮겼다. 태그 분류(tagCounts/tagColors)는 별도 홈
// (stores/taxonomy.ts)으로 옮기기엔 소비처가 커밋 시점 기준 여러 곳이라(§R2 리포트 참고)
// loadTree/hydrateTagMaps 와 결합이 강한 이쪽에 그대로 둔다 — 무엇보다 notes.test.ts(수정 금지
// 계약)가 useNotesStore.getState().tagCounts 를 직접 검증한다.
import type { StateCreator } from "zustand";
import { call, callSilent } from "../lib/invoke";
import type { Folder, NoteSummary } from "../lib/commands.gen";
import { useSettingsStore } from "./settings";
import { useSearchStore } from "./search";
import { buildNoteIndex, patchNoteInMaps, removeNoteFromMaps } from "./noteHelpers";
import {
  mergeNoteSummariesInState,
  setFolderNotesInState,
  appendFolderNotesInState,
} from "./noteWindowCache";
import { bumpNoteQueryVersion } from "../lib/noteQuery";
import { isBrowser, isMobileViewport } from "../lib/env";
import type { NotesState } from "./notes";

export interface NotesTreeSlice {
  isBooting: boolean;
  folders: Folder[];
  notesByFolder: Record<string, NoteSummary[]>;
  totalNotes: number;
  noteIndex: Map<string, NoteSummary>;
  folderQueryTotals: Record<string, number>;
  tagCounts: Record<string, number> | null;
  tagColors: Record<string, number> | null;
  refreshTagCounts: () => Promise<void>;
  loadTree: () => Promise<void>;
  loadTreeForBoot: (rawSettings?: Record<string, unknown>) => Promise<void>;
  patchNoteSummary: (id: string, patch: Partial<NoteSummary>) => void;
  removeNoteSummary: (id: string) => void;
  patchFolder: (id: string, patch: Partial<Folder>) => void;
  mergeNoteSummaries: (notes: NoteSummary[]) => void;
  setFolderNotes: (folderId: string, notes: NoteSummary[]) => void;
  appendFolderNotes: (folderId: string, notes: NoteSummary[]) => void;
  setFolderQueryTotal: (folderId: string, total: number) => void;
  ensureNoteSummaries: (ids: string[]) => Promise<Map<string, NoteSummary>>;
  inboxId: string | null;
  ensureInboxId: () => Promise<string>;
}

export const createNotesTreeSlice: StateCreator<NotesState, [], [], NotesTreeSlice> = (
  set,
  get
) => {
  let loadTreeSeq = 0;
  let inboxPromise: Promise<string> | null = null;

  const refreshTagCounts = async () => {
    const seq = loadTreeSeq;
    try {
      const r = await call<{ counts: Record<string, number> }>("tag_counts");
      if (seq !== loadTreeSeq) return;
      set({ tagCounts: r.counts ?? {} });
    } catch {
      // keep prior server map
    }
  };

  const hydrateTagMaps = async (seq: number, withNoteTagsIndex: boolean) => {
    try {
      const [tags, counts, colors] = await Promise.all([
        withNoteTagsIndex
          ? callSilent<{ tags_by_note: Record<string, string[]> }>("note_tags_index").catch(() => null)
          : Promise.resolve(null),
        callSilent<{ counts: Record<string, number> }>("tag_counts").catch(() => null),
        callSilent<{ colors: Record<string, number> }>("tag_colors").catch(() => null),
      ]);
      if (seq !== loadTreeSeq) return;
      const tagCounts = counts?.counts ?? null;
      const tagColors = colors?.colors ?? null;
      if (tags?.tags_by_note) {
        const tagsByNote = tags.tags_by_note;
        const s = get();
        const nextFolder: Record<string, NoteSummary[]> = {};
        for (const [fid, notes] of Object.entries(s.notesByFolder)) {
          nextFolder[fid] = notes.map((n) => {
            const tnames = tagsByNote[n.id];
            return tnames ? { ...n, tag_names: tnames } : n;
          });
        }
        const built = buildNoteIndex(nextFolder);
        set({
          notesByFolder: nextFolder,
          noteIndex: built.noteIndex,
          tagCounts,
          tagColors,
        });
      } else {
        set({ tagCounts, tagColors });
      }
    } catch {
      // ignore
    }
  };

  return {
    isBooting: true,
    folders: [],
    notesByFolder: {},
    totalNotes: 0,
    noteIndex: new Map(),
    folderQueryTotals: {},
    tagCounts: null,
    tagColors: null,
    refreshTagCounts,
    inboxId: null,

    loadTree: async () => {
      // W2b(모바일 재편 통합): 모바일은 이 트리 스토어를 렌더하지 않는다 — MobileNoteTree 는
      // useFolderWindows/useFavoritesWindow(headless 훅) 로 자기 창을 noteQuery() 직접 채운다
      // (setFolderNotes/setFolderQueryTotal 로 "쓰기"만 하지, 이 스토어의 folders/notesByFolder 를
      // "읽지" 않는다 — 두 훅 다 확인함). 그런데 folder_list(바로 아래)는 LIMIT 없는 전수
      // 조회라 모바일 성능 계약 위반(WORKORDER-2026-09-02-mobile-rework.md 공통 규칙 §8) — 모바일
      // 경로에서는 그 IPC 자체를 건너뛰고 캐시 무효화 축만 올린다. 이게 이전엔 호출자마다
      // (lib/noteActions.ts 의 renameNote/moveNote/deleteNote, stores/archive.ts, mobile/mobileRows.ts
      // 의 복제 mobile* 헬퍼 7개)에서 각자 판단했던 것 — 그 호출자 전부가 지나가는 여기 한 곳으로
      // 옮겨 복제를 없앤다.
      if (isBrowser() && isMobileViewport()) {
        bumpNoteQueryVersion();
        return;
      }
      const seq = ++loadTreeSeq;
      const wsId = useSettingsStore.getState().activeWorkspaceId;
      const [r, settingsRes] = await Promise.all([
        callSilent<{ folders: Folder[]; notes_by_folder: Record<string, NoteSummary[]> }>("folder_list"),
        wsId
          ? callSilent<{ settings: Record<string, unknown> }>("settings_get_all").catch(() => null)
          : Promise.resolve(null),
      ]);
      if (seq !== loadTreeSeq) return;
      const { totalNotes, noteIndex } = buildNoteIndex(r.notes_by_folder);
      let inboxId: string | null = null;
      if (wsId && settingsRes) {
        const persistedId = settingsRes.settings[`inbox_${wsId}`] as string | undefined;
        if (persistedId && r.folders.some((f) => f.id === persistedId)) inboxId = persistedId;
      }
      const folderQueryTotals: Record<string, number> = {};
      for (const [fid, notes] of Object.entries(r.notes_by_folder)) {
        folderQueryTotals[fid] = notes.length;
      }
      set({
        isBooting: false,
        folders: r.folders,
        notesByFolder: r.notes_by_folder,
        totalNotes,
        noteIndex,
        folderQueryTotals,
        inboxId,
      });
      // loadTree() is the refresh every create/rename/move/delete/import/workspace-switch path
      // already calls — bumping here (rather than at each of those call sites) is the one place
      // that can't miss a future caller that follows the same convention.
      bumpNoteQueryVersion();
      void useSearchStore.getState().refreshYearHistogram();
      void hydrateTagMaps(seq, true);
    },

    loadTreeForBoot: async (rawSettings?: Record<string, unknown>) => {
      const seq = ++loadTreeSeq;
      const wsId = useSettingsStore.getState().activeWorkspaceId;
      const [meta, settingsRes] = await Promise.all([
        call<{ folders: Folder[]; notes_by_folder: Record<string, NoteSummary[]> }>(
          "folder_list_meta"
        ),
        rawSettings !== undefined
          ? Promise.resolve({ settings: rawSettings })
          : wsId
          ? callSilent<{ settings: Record<string, unknown> }>("settings_get_all").catch(() => null)
          : Promise.resolve(null),
      ]);
      if (seq !== loadTreeSeq) return;

      let metaInbox: string | null = null;
      if (wsId && settingsRes) {
        const persistedId = settingsRes.settings[`inbox_${wsId}`] as string | undefined;
        if (persistedId && meta.folders.some((f) => f.id === persistedId)) {
          metaInbox = persistedId;
        }
      }
      set({
        isBooting: false,
        folders: meta.folders,
        totalNotes: meta.folders.reduce((acc, f) => acc + (f.note_count ?? 0), 0),
        inboxId: metaInbox,
        notesByFolder: meta.notes_by_folder,
        noteIndex: new Map(),
        folderQueryTotals: {},
      });

      const afterFirstPaint = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        });
      void (async () => {
        await afterFirstPaint();
        if (seq !== loadTreeSeq) return;
        void useSearchStore.getState().refreshYearHistogram();
        void hydrateTagMaps(seq, false);

        const openIds = meta.folders
          .filter((f) => f.is_open || f.id === metaInbox)
          .map((f) => f.id);
        if (openIds.length === 0) return;
        try {
          const { noteQuery, TREE_NOTE_WINDOW } = await import("../lib/noteQuery");
          const pages = await Promise.all(
            openIds.map((fid) =>
              noteQuery({
                folderIds: [fid],
                sort: "year_asc",
                offset: 0,
                limit: TREE_NOTE_WINDOW,
              }).then((r) => ({ fid, r }))
            )
          );
          if (seq !== loadTreeSeq) return;
          const nextFolder: Record<string, NoteSummary[]> = { ...get().notesByFolder };
          const folderQueryTotals: Record<string, number> = { ...get().folderQueryTotals };
          const noteIndex = new Map(get().noteIndex);
          for (const { fid, r } of pages) {
            nextFolder[fid] = r.notes;
            folderQueryTotals[fid] = r.total;
            for (const n of r.notes) noteIndex.set(n.id, n);
          }
          set({ notesByFolder: nextFolder, noteIndex, folderQueryTotals });
        } catch {
          // ignore
        }
      })();
    },

    patchNoteSummary: (id, patch) => {
      useSearchStore.getState().patchNoteSummary(id, patch);
      // Every field-level mutation (tags/region/status/favorite/location/event-precision/title/
      // year/icon/folder_id) routes through here — the shared chokepoint, so one bump covers all
      // of them instead of one per setter in this file plus noteActions.ts/RegionExpanded.tsx.
      // Must run even when the note isn't in the resident tree window (below): an expanded board's
      // cached collect (up to EXPANDED_BOARD_MAX_NOTES) can hold notes this store's own
      // TREE_NOTE_WINDOW-sized noteIndex does not, and those still need the cache dropped.
      bumpNoteQueryVersion();
      const s = get();
      const patched = patchNoteInMaps(s.notesByFolder, s.noteIndex, id, patch);
      if (!patched) {
        // Note outside the resident window (e.g. opened from search): reload so the sidebar
        // counts/labels don't go stale. Window hits stay O(1). Best-effort: loadTree re-throws
        // callSilent failures and a sync setter has no one to hand them to.
        void get().loadTree().catch(() => {});
        return;
      }
      set({ notesByFolder: patched.notesByFolder, noteIndex: patched.noteIndex });
      if (patch.year !== undefined) {
        void useSearchStore.getState().refreshYearHistogram();
      }
    },

    // Delete's counterpart to patchNoteSummary — same chokepoint reasoning (bump once here, not
    // per caller), plus the count bookkeeping a patch never needs (totalNotes/folderQueryTotals/
    // folders[].note_count all drop by one). Replaces the old note_delete → full loadTree()
    // reload, which cost 2.6s+ at 100k notes (docs/reviews perf audit) for a single row removed.
    removeNoteSummary: (id) => {
      bumpNoteQueryVersion();
      const s = get();
      const removed = removeNoteFromMaps(s.notesByFolder, s.noteIndex, id);
      if (!removed) {
        // Same fallback as patchNoteSummary: note outside the resident window.
        void get().loadTree().catch(() => {});
        return;
      }
      const { folderId } = removed;
      set({
        notesByFolder: removed.notesByFolder,
        noteIndex: removed.noteIndex,
        totalNotes: Math.max(0, s.totalNotes - 1),
        folderQueryTotals:
          s.folderQueryTotals[folderId] !== undefined
            ? { ...s.folderQueryTotals, [folderId]: Math.max(0, s.folderQueryTotals[folderId] - 1) }
            : s.folderQueryTotals,
        folders: s.folders.map((f) =>
          f.id === folderId && typeof f.note_count === "number"
            ? { ...f, note_count: Math.max(0, f.note_count - 1) }
            : f
        ),
      });
    },

    patchFolder: (id, patch) => {
      set((s) => ({
        folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      }));
    },

    mergeNoteSummaries: (notes) => {
      const patch = mergeNoteSummariesInState(get(), notes);
      if (patch) set(patch);
    },

    setFolderNotes: (folderId, notes) => {
      set(setFolderNotesInState(get(), folderId, notes));
    },

    appendFolderNotes: (folderId, notes) => {
      const patch = appendFolderNotesInState(get(), folderId, notes);
      if (patch) set(patch);
    },

    setFolderQueryTotal: (folderId, total) => {
      set((s) => ({
        folderQueryTotals: { ...s.folderQueryTotals, [folderId]: total },
      }));
    },

    ensureNoteSummaries: async (ids) => {
      const out = new Map<string, NoteSummary>();
      if (ids.length === 0) return out;
      const missing: string[] = [];
      const index = get().noteIndex;
      for (const id of ids) {
        const hit = index.get(id);
        if (hit) out.set(id, hit);
        else if (id) missing.push(id);
      }
      if (missing.length === 0) return out;
      try {
        const { fetchNoteSummariesMap } = await import("../lib/noteSummaries");
        const map = await fetchNoteSummariesMap(missing);
        const fetched = Object.values(map);
        if (fetched.length > 0) get().mergeNoteSummaries(fetched);
        for (const [id, n] of Object.entries(map)) out.set(id, n);
      } catch {
        // missing ids unresolved
      }
      return out;
    },

    ensureInboxId: () => {
      const s = get();
      if (s.inboxId) return Promise.resolve(s.inboxId);
      if (inboxPromise) return inboxPromise;

      inboxPromise = (async () => {
        try {
          const wsId = useSettingsStore.getState().activeWorkspaceId;
          if (wsId) {
            try {
              const settings = await call<{ settings: Record<string, unknown> }>(
                "settings_get_all"
              );
              const persistedId = settings?.settings[`inbox_${wsId}`] as string | undefined;
              if (persistedId && get().folders.some((f) => f.id === persistedId)) {
                set({ inboxId: persistedId });
                return persistedId;
              }
              // 저장된 id 가 이 창의 폴더 목록에 없다 — 다른 창(브리핑의 일정 만들기 · 서버측
              // ensure_inbox_folder_id)이 방금 만든 받은편지함일 수 있다. 바로 새로 만들면 노트북에
              // Inbox 가 둘 생기므로 서버의 폴더 목록으로 한 번 더 확인한다(GRILL-2026-10-19 W4 검증).
              if (persistedId) {
                const fresh = await callSilent<{ folders: Folder[] }>("folder_list").catch(() => null);
                if (fresh?.folders.some((f) => f.id === persistedId)) {
                  await get().loadTree().catch(() => {}); // silent-ok: 트리 새로고침 실패는 callSilent 가 이미 기록, 받은편지함 id 는 아래에서 확정
                  set({ inboxId: persistedId });
                  return persistedId;
                }
              }
            } catch {
              // ignore
            }
          }

          const folder = await call<Folder>("folder_create", { name: "Inbox" });
          if (wsId) {
            await call("settings_set", {
              entries: { [`inbox_${wsId}`]: folder.id },
            });
          }
          set((curr) => ({
            inboxId: folder.id,
            folders: curr.folders.some((f) => f.id === folder.id)
              ? curr.folders
              : [...curr.folders, folder],
            notesByFolder: curr.notesByFolder[folder.id]
              ? curr.notesByFolder
              : { ...curr.notesByFolder, [folder.id]: [] },
          }));
          return folder.id;
        } finally {
          inboxPromise = null;
        }
      })();

      return inboxPromise;
    },
  };
};
