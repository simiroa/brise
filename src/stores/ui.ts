import { create } from 'zustand';
import { call, callSilent } from '../lib/invoke';
import { toIsoDateLocal } from '../components/titlebar/dueDate';

export type PreviewItem =
  | { kind: "source" | "attachment" | "note" | "region"; id: string }
  | { kind: "section"; noteId: string; sectionId: string }
  // 각주 뷰: 노트 스코프(활성 노트의 각주 전체)라 id 가 없다 — 첨부 바의 합성 타일 하나와
  // 본문 각주 마커가 같은 목록을 연다. focusId 는 "목록을 열고 이 항목으로 스크롤+강조"라는
  // 뜻이며 정체성의 일부다(아래 previewItemsEqual — 마커→다른 마커 클릭이 재스크롤을 트리거해야 함).
  | { kind: "footnotes"; focusId?: string };

/** Wave 2: inner tabs of the fixed home/dashboard surface (docs/DASHBOARD.md §3). */
export type HomeInnerTab = "board" | "calendar" | "timeline" | "map" | "graph";

/** Session-only preview back/forward stack depth. Quiet rescue affordance, not browser chrome. */
export const PREVIEW_HISTORY_CAP = 20;

/** Structural equality for PreviewItem — used to skip no-op setPreviewItem and history noise. */
export function previewItemsEqual(a: PreviewItem | null, b: PreviewItem | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "section" && b.kind === "section") {
    return a.noteId === b.noteId && a.sectionId === b.sectionId;
  }
  if (a.kind === "section" || b.kind === "section") return false;
  // focusId 는 정체성의 일부다: 각주 마커 A 를 보다가 마커 B 를 누르면 "같은 목록 화면"이지만
  // 스크롤/강조 대상이 달라지므로 setPreviewItem 이 no-op 로 삼키면 안 된다.
  if (a.kind === "footnotes" && b.kind === "footnotes") return a.focusId === b.focusId;
  if (a.kind === "footnotes" || b.kind === "footnotes") return false;
  return a.id === b.id;
}

interface UiState {
  focusMode: boolean;
  ctxOpen: { x: number; y: number; noteId: string } | null;
  savingCount: number;
  toggleFocus: () => void;
  // Section autosave signal for real-time section preview auto-reload
  sectionSaveEvent: { sectionId: string; tick: number } | null;
  notifySectionSaved: (sectionId: string) => void;
  // Bug fix: Aperçu 카드의 "Enlarge" 버튼은 focusMode(에디터 전체 화면)와는 별개의 기능이다 —
  // 프리뷰(이미지/PDF/텍스트/링크)만 큰 표면으로 확장한다. focusMode 는 손대지 않는다.
  previewExpanded: boolean;
  togglePreviewExpanded: () => void;
  exitPreviewExpanded: () => void;
  // Aperçu 카드 접기/숨김 — attachmentsCollapsed 와 동일한 패턴(세션 한정, 디스크 미영속).
  // previewExpanded(확대 오버레이)와는 독립적인 상태: 카드를 얇은 레일로 접어 에디터 공간을
  // 회수한다. App.tsx가 이 값을 읽어 소스 컬럼 폭을 "auto"로 바꾸고 resize grip을 숨긴다.
  previewCollapsed: boolean;
  /** 방금 만든 섹션의 탭을 바로 이름 입력 상태로 여는 신호 — SectionTabBar 가 소비하고 비운다. */
  renameSectionId: string | null;
  togglePreviewCollapsed: () => void;
  openCtx: (noteId: string, x: number, y: number) => void;
  closeCtx: () => void;
  folderFilesOpen: string | null;
  openFolderFiles: (folderId: string) => void;
  closeFolderFiles: () => void;
  // Trash view — a single global modal (mirrors folderFilesOpen's shape) toggled from the
  // sidebar's Trash row (NoteTree.tsx), same pattern as "Favoris"/folders opening context menus.
  trashOpen: boolean;
  openTrash: () => void;
  closeTrash: () => void;
  // Advanced-filter modal (leftpanel/FilterModal.tsx) — same single-global-modal shape as
  // trashOpen. Sidebar toggle opens it; ActiveFilterChips also opens it (second entry point).
  filtersOpen: boolean;
  openFilters: () => void;
  closeFilters: () => void;
  // W7-f 아카이브 뷰 — trashOpen과 동일한 패턴(단일 전역 모달, 트리의 아카이브 행에서 토글).
  archiveOpen: boolean;
  openArchive: () => void;
  closeArchive: () => void;
  attachmentsCollapsed: boolean;
  toggleAttachmentsCollapsed: () => void;
  // W22 ⑤의 attachmentsRows(2줄 확장)는 W24에서 폐기 — 스트립은 항상 1줄 + 가로 패닝.
  // Notes liées x Pièces jointes 통합 카드 — 어느 탭이 보이는지 (세션 동안, 디스크 미영속;
  // attachmentsCollapsed 와 동일한 패턴).
  attachmentsTab: "attachments" | "related";
  setAttachmentsTab: (tab: "attachments" | "related") => void;
  // Wave 2: last-viewed home inner tab (session only — same convention as attachmentsTab).
  // Spec §3 "마지막 본 탭 기억". Disk persistence can be added later if needed.
  homeInnerTab: HomeInnerTab;
  setHomeInnerTab: (tab: HomeInnerTab) => void;
  // Dashboard Map tab pan/zoom — session only, HomeMapPane sole consumer. Survives note open
  // and home-inner-tab switches (both unmount HomeMapPane). Not a settings DB key; home button
  // still uses defaultMapLocation. Other WorldMap hosts must not read this.
  //
  // W8 "아를리트" 수정: **픽셀 transform({k,x,y})이 아니라 지리({lat,lng,zoom})를 저장한다.**
  // transform 의 x/y 는 저장 당시 뷰포트 크기에 종속된 값이라, 크기가 다른 재마운트(패널 접힘,
  // 창 리사이즈, 플레이스홀더 800×450 클램프)에서 그대로 해석하면 카메라가 전혀 다른 대륙으로
  // 간다(서울이 사하라 한복판 — 도시 라벨 LOD 가 켜져 "아를리트"로 보이던 그 버그). 지리 좌표는
  // 어떤 크기에서도 computeSeedTransform 이 올바른 transform 을 다시 만들어 낸다.
  homeMapView: { lat: number; lng: number; zoom: number } | null;
  setHomeMapView: (v: { lat: number; lng: number; zoom: number } | null) => void;
  // Wave 8: unified Sources + Pièces jointes selection — tells the tab-less preview card
  // (SourcePanel.tsx) which item to render, and which store it came from.
  // "note" (related-note interaction model): a single click on a related-note tile previews
  // that note read-only (title + first section body) without opening a tab — see
  // PreviewAttachment.tsx and AttachmentsBar.tsx's related-tile click handling.
  previewItem: PreviewItem | null;
  setPreviewItem: (item: PreviewItem | null) => void;
  // Wave 3 L1 Part B: in-memory preview back/forward (session only, not a settings key).
  // Every setPreviewItem that actually changes the selection pushes the prior value onto past
  // and clears future — single point every AttachmentsBar / EditorPanel / related-tile caller
  // already passes through. Cap PREVIEW_HISTORY_CAP.
  previewPast: (PreviewItem | null)[];
  previewFuture: (PreviewItem | null)[];
  previewHistoryBack: () => void;
  previewHistoryForward: () => void;
  // Task B: sidebar fully-collapsible. Unlike relatedNotesCollapsed/attachmentsCollapsed (session
  // only), this persists across restarts via the generic settings_set/settings_get_all commands
  // (same backend used by settings.ts's leftWidth etc.) — loadSidebarCollapsed() is called once
  // from App.tsx's boot sequence.
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  loadSidebarCollapsed: () => Promise<void>;
  todayIso: string;
  setTodayIso: (iso: string) => void;
  // Wave E: dashboard search hit navigation reveal signal (noteId + monotonic sequence)
  dashboardReveal: { noteId: string; seq: number } | null;
  triggerDashboardReveal: (noteId: string) => void;
  // Dashboard-wide folder filter (nav row dot control, docs/DASHBOARD.md) — replaces the three
  // per-tab local `folderFilter` useStates (Calendar/Map/Graph each had their own). Same toggle
  // convention as those did (click selected id again → clear). Session only, survives switching
  // homeInnerTab (same convention as homeInnerTab itself).
  // ponytail: deliberately NOT reset on workspace switch (matches useSearchStore's tag/region/
  // status filters, also not reset there) — a stale folder id from a different workspace just
  // matches nothing (map/graph/timeline/board go empty, calendar dims everything) rather than
  // crashing. Upgrade path if this bites: clear it from the same place workspaces.ts's
  // activateWorkspaceLocally() already clears useSelectionStore on switch — that file wasn't in
  // this wave's scope.
  dashboardFolderFilter: string | null;
  toggleDashboardFolderFilter: (folderId: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  focusMode: false,
  ctxOpen: null,
  savingCount: 0,
  folderFilesOpen: null,
  toggleFocus: () => set((state) => ({ focusMode: !state.focusMode })),
  sectionSaveEvent: null,
  notifySectionSaved: (sectionId: string) =>
    set((state) => ({
      sectionSaveEvent: {
        sectionId,
        tick: (state.sectionSaveEvent?.tick ?? 0) + 1,
      },
    })),
  previewExpanded: false,
  togglePreviewExpanded: () => set((state) => ({ previewExpanded: !state.previewExpanded })),
  exitPreviewExpanded: () => set({ previewExpanded: false }),
  previewCollapsed: false,
  renameSectionId: null,
  togglePreviewCollapsed: () => set((state) => ({ previewCollapsed: !state.previewCollapsed })),
  openCtx: (noteId, x, y) => set({ ctxOpen: { noteId, x, y } }),
  closeCtx: () => set({ ctxOpen: null }),
  openFolderFiles: (folderId) => set({ folderFilesOpen: folderId }),
  closeFolderFiles: () => set({ folderFilesOpen: null }),
  trashOpen: false,
  openTrash: () => set({ trashOpen: true }),
  closeTrash: () => set({ trashOpen: false }),
  filtersOpen: false,
  openFilters: () => set({ filtersOpen: true }),
  closeFilters: () => set({ filtersOpen: false }),
  archiveOpen: false,
  openArchive: () => set({ archiveOpen: true }),
  closeArchive: () => set({ archiveOpen: false }),
  attachmentsCollapsed: false,
  toggleAttachmentsCollapsed: () =>
    set((state) => ({ attachmentsCollapsed: !state.attachmentsCollapsed })),
  attachmentsTab: "attachments",
  setAttachmentsTab: (tab) => set({ attachmentsTab: tab }),
  homeInnerTab: "board",
  setHomeInnerTab: (tab) => set({ homeInnerTab: tab }),
  homeMapView: null,
  setHomeMapView: (v) => set({ homeMapView: v }),
  previewItem: null,
  previewPast: [],
  previewFuture: [],
  setPreviewItem: (item) =>
    set((state) => {
      // 집중 모드에서 프리뷰 요청은 집중 해제로 응답한다 — 호출자 셋을 각각 고치지 않고
      // 관문에서 한 번. SourcePanel 이 언마운트된 채로 상태만 바뀌면 요청이 조용히 사라진다.
      // 같은 항목을 다시 요청해도(집중 전에 이미 열려 있던 프리뷰) 집중 해제는 응답해야 한다.
      const exitFocus = item !== null && state.focusMode ? { focusMode: false } : null;
      if (previewItemsEqual(state.previewItem, item)) return exitFocus ?? state;
      // footnotes→footnotes 는 화면 전환이 아니라 **같은 목록 안에서 강조 위치만 이동**한다.
      // 각주가 촘촘한 문단을 읽으며 마커를 연달아 누르면 20칸짜리 히스토리가 전부 같은 화면으로
      // 채워져 back 버튼이 무용지물이 된다 — push 대신 replace 한다(future 는 새 탐색이므로 비운다).
      if (state.previewItem?.kind === "footnotes" && item?.kind === "footnotes") {
        return { previewItem: item, previewFuture: [], ...exitFocus };
      }
      const past = [...state.previewPast, state.previewItem].slice(-PREVIEW_HISTORY_CAP);
      return {
        previewItem: item,
        previewPast: past,
        previewFuture: [],
        ...exitFocus,
      };
    }),
  previewHistoryBack: () =>
    set((state) => {
      if (state.previewPast.length === 0) return state;
      const past = state.previewPast.slice();
      const prev = past.pop()!;
      const future = [state.previewItem, ...state.previewFuture].slice(0, PREVIEW_HISTORY_CAP);
      return {
        previewItem: prev,
        previewPast: past,
        previewFuture: future,
      };
    }),
  previewHistoryForward: () =>
    set((state) => {
      if (state.previewFuture.length === 0) return state;
      const future = state.previewFuture.slice();
      const next = future.shift()!;
      const past = [...state.previewPast, state.previewItem].slice(-PREVIEW_HISTORY_CAP);
      return {
        previewItem: next,
        previewPast: past,
        previewFuture: future,
      };
    }),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      void callSilent("settings_set", { entries: { sidebar_collapsed: next } }).catch(() => {});
      return { sidebarCollapsed: next };
    }),
  loadSidebarCollapsed: async () => {
    try {
      const res = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      set({ sidebarCollapsed: Boolean(res.settings?.sidebar_collapsed) });
    } catch {
      // ignore — default (expanded) stands
    }
  },
  todayIso: toIsoDateLocal(),
  setTodayIso: (iso) => set({ todayIso: iso }),
  dashboardReveal: null,
  triggerDashboardReveal: (noteId: string) =>
    set((state) => ({
      dashboardReveal: {
        noteId,
        seq: (state.dashboardReveal?.seq ?? 0) + 1,
      },
    })),
  dashboardFolderFilter: null,
  toggleDashboardFolderFilter: (folderId: string) =>
    set((state) => ({
      dashboardFolderFilter: state.dashboardFolderFilter === folderId ? null : folderId,
    })),
}));
