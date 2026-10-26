// Wave 14: 워크스페이스별 사용자 확장 지역/시대 — Région 필터·시대 칩의 목록을 이룬다. 예전엔
// korea/france 프리셋(구 src/lib/eras.ts)의 고정 목록 위에 사용자 추가분을 얹는 구조였지만,
// 프리셋이 제거되면서(연도 범위는 문서에서 도출, 지역/시대는 자유 등록) 이제 이 스토어의
// "사용자가 추가한" 항목이 곧 전체 목록이다. 삭제 버튼은 이 스토어에서 온 항목에 보인다.
import { create } from "zustand";
import { call } from "../lib/invoke";
import { scheduleUndoableDelete } from "../lib/undo";
import { t } from "../i18n/t";
import type { EraEntry, RegionEntry, StatusEntry } from "../lib/commands.gen";
import { useSettingsStore } from "./settings";

export type { RegionEntry, EraEntry, StatusEntry };

interface TaxonomyState {
  workspaceId: string | null;
  /** 주의: 지역이 지도 기반으로 바뀐 뒤 프론트에는 더는 UI 소비처가 없다. Région 필터 칩은
   *  노트의 실제 region 값에서 도출한다. 백엔드 테이블/커맨드는 export·import 번들이 여전히
   *  싣고 있으므로 남겨둔다(지우면 번들 포맷이 바뀐다). */
  regions: RegionEntry[];
  eras: EraEntry[];
  statuses: StatusEntry[];
  loaded: boolean;
  load: (workspaceId: string) => Promise<void>;
  addRegion: (name: string) => Promise<RegionEntry | null>;
  removeRegion: (id: string) => Promise<void>;
  addEra: (name: string, fromYear: number, toYear: number) => Promise<EraEntry | null>;
  removeEra: (id: string) => Promise<void>;
  addStatus: (name: string) => Promise<StatusEntry | null>;
  renameStatus: (id: string, name: string) => Promise<void>;
  removeStatus: (id: string) => Promise<void>;
}

export const useTaxonomyStore = create<TaxonomyState>((set, get) => ({
  workspaceId: null,
  regions: [],
  eras: [],
  statuses: [],
  loaded: false,

  // workspaces.ts::load/switchTo 가 워크스페이스 전환마다 호출한다(활성 워크스페이스 id 확정
  // 시점을 그쪽이 이미 알고 있으므로, 여기서 설정 스토어를 다시 구독하기보다 직접 호출이 더
  // 단순하고 경합이 적다).
  load: async (workspaceId) => {
    set({ workspaceId, loaded: false });
    try {
      const [r, e, s] = await Promise.all([
        call<{ regions: RegionEntry[] }>("workspace_region_list", { workspace_id: workspaceId }),
        call<{ eras: EraEntry[] }>("workspace_era_list", { workspace_id: workspaceId }),
        call<{ statuses: StatusEntry[] }>("workspace_status_list", { workspace_id: workspaceId }),
      ]);
      // 로딩 도중 다른 워크스페이스로 다시 전환됐으면 stale 응답은 버린다.
      if (get().workspaceId !== workspaceId) return;
      set({ regions: r.regions, eras: e.eras, statuses: s.statuses, loaded: true });
    } catch {
      if (get().workspaceId !== workspaceId) return;
      set({ regions: [], eras: [], statuses: [], loaded: true });
    }
  },

  addRegion: async (name) => {
    const ws = get().workspaceId;
    const trimmed = name.trim();
    if (!ws || !trimmed) return null;
    // 이미 같은 이름(대소문자 무시)이 있으면 재요청하지 않는다 — 서버도 CONFLICT로 거부하지만,
    // 흔한 "이미 추가된 이름을 다시 타이핑" 경로에서 왕복 없이 조용히 넘어간다.
    const existing = get().regions.find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    try {
      const entry = await call<RegionEntry>("workspace_region_add", {
        workspace_id: ws,
        name: trimmed,
      });
      set((s) => ({ regions: [...s.regions, entry] }));
      return entry;
    } catch {
      return null;
    }
  },

  // Tier 1 undo-on-delete: hide it locally NOW, delay the real workspace_region_remove call
  // ~5s so "Undo" can cancel it outright (the backend is never touched if undone) — see
  // src/lib/undo.ts. This also naturally prevents any status→NULL-style backend side effects
  // for the remove call from ever firing when the user undoes in time.
  removeRegion: async (id) => {
    const prev = get().regions;
    const idx = prev.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const removed = prev[idx];
    set({ regions: prev.filter((r) => r.id !== id) });
    scheduleUndoableDelete({
      commit: () => call("workspace_region_remove", { id }),
      onRestore: () => {
        set((s) => {
          const next = [...s.regions];
          next.splice(Math.min(idx, next.length), 0, removed);
          return { regions: next };
        });
      },
      label: t("undo.deleted_named", { name: removed.name }),
    });
  },

  addEra: async (name, fromYear, toYear) => {
    const ws = get().workspaceId;
    const trimmed = name.trim();
    if (!ws || !trimmed) return null;
    try {
      const entry = await call<EraEntry>("workspace_era_add", {
        workspace_id: ws,
        name: trimmed,
        from_year: fromYear,
        to_year: toYear,
      });
      set((s) => ({ eras: [...s.eras, entry] }));
      return entry;
    } catch {
      return null;
    }
  },

  removeEra: async (id) => {
    const prev = get().eras;
    const idx = prev.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const removed = prev[idx];
    set({ eras: prev.filter((e) => e.id !== id) });
    scheduleUndoableDelete({
      commit: () => call("workspace_era_remove", { id }),
      onRestore: () => {
        set((s) => {
          const next = [...s.eras];
          next.splice(Math.min(idx, next.length), 0, removed);
          return { eras: next };
        });
      },
      label: t("undo.deleted_named", { name: removed.name }),
    });
  },

  addStatus: async (name) => {
    if (useSettingsStore.getState().statusAddLocked) return null;
    const ws = get().workspaceId;
    const trimmed = name.trim();
    if (!ws || !trimmed) return null;
    const existing = get().statuses.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    try {
      const entry = await call<StatusEntry>("workspace_status_add", {
        workspace_id: ws,
        name: trimmed,
      });
      set((s) => ({ statuses: [...s.statuses, entry] }));
      return entry;
    } catch {
      return null;
    }
  },

  // 커스텀 상태 이름 변경 — 노트는 상태를 id 로 참조하므로 서버도 여기서도 notes 는 건드리지
  // 않는다. 서버 거부(내장 충돌/NOCASE 중복)면 조용히 이전 이름 유지(add 와 동일한 실패 방침).
  renameStatus: async (id, name) => {
    const trimmed = name.trim();
    const cur = get().statuses.find((s) => s.id === id);
    if (!trimmed || !cur || cur.name === trimmed) return;
    try {
      const entry = await call<StatusEntry>("workspace_status_rename", { id, name: trimmed });
      set((s) => ({ statuses: s.statuses.map((x) => (x.id === id ? entry : x)) }));
    } catch {
      // keep old name
    }
  },

  // Deleting a status also NULLs it on every note that has it (backend side effect) — undo
  // means that call never runs, so the side effect never happens either.
  removeStatus: async (id) => {
    const prev = get().statuses;
    const idx = prev.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const removed = prev[idx];
    set({ statuses: prev.filter((s) => s.id !== id) });
    scheduleUndoableDelete({
      commit: () => call("workspace_status_remove", { id }),
      onRestore: () => {
        set((s) => {
          const next = [...s.statuses];
          next.splice(Math.min(idx, next.length), 0, removed);
          return { statuses: next };
        });
      },
      label: t("undo.deleted_named", { name: removed.name }),
    });
  },
}));
