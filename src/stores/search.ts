import { create } from "zustand";
import { call, callSilent } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import type { NoteSummary } from "../lib/commands.gen";
import {
  clampMatchCursor,
  stepMatchCursor as stepMatchCursorPure,
  type SearchMatch,
} from "../lib/searchMatch";
import { padYearRange } from "../lib/yearRangePad";

// QA8 Wave 3A — search autocomplete / history. One settings kv key (like emoji_recent), no table.
// Device-local (export.rs::is_device_local_setting_key) so notebooks handed to others don't leak
// query strings. Cap + promote-on-dedupe live here; backend validate_setting only checks shape.
export const SEARCH_RECENT_KEY = "search_recent";
export const SEARCH_RECENT_MAX = 20;
/** Per-query string length cap (backend validate_setting must match). */
export const SEARCH_RECENT_ITEM_MAX_LEN = 200;

/** LRU-insert `q` at the front, trim, dedupe, cap. Empty/whitespace is a no-op. Pure. */
export function promoteRecentSearch(
  list: string[],
  q: string,
  max = SEARCH_RECENT_MAX,
): string[] {
  const t = q.trim();
  if (!t) return list;
  const clipped = t.length > SEARCH_RECENT_ITEM_MAX_LEN ? t.slice(0, SEARCH_RECENT_ITEM_MAX_LEN) : t;
  return [clipped, ...list.filter((x) => x !== clipped)].slice(0, max);
}

export function removeRecentSearchItem(list: string[], q: string): string[] {
  return list.filter((x) => x !== q);
}

/** Case-insensitive substring filter for the open dropdown (no server). Empty query → full list. */
export function filterRecentSearches(list: string[], query: string): string[] {
  const p = query.trim().toLowerCase();
  if (!p) return list;
  return list.filter((x) => x.toLowerCase().includes(p));
}

function normalizeRecentList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (!t) continue;
    const clipped = t.length > SEARCH_RECENT_ITEM_MAX_LEN ? t.slice(0, SEARCH_RECENT_ITEM_MAX_LEN) : t;
    if (out.includes(clipped)) continue;
    out.push(clipped);
    if (out.length >= SEARCH_RECENT_MAX) break;
  }
  return out;
}

// Left-panel view switcher. Status/tags/date filters live on the toggle strip (not a view).
// Old persisted "advanced"|"tags"|"status" are not views — normalize to tree.
export type YearFilterMode = "tree" | "region" | "timeline" | "gallery" | "calendar" | "chat";

const FILTER_MODES: ReadonlySet<string> = new Set([
  "tree",
  "region",
  "timeline",
  "gallery",
  "calendar",
  "chat",
]);

/** Map a raw (possibly persisted) mode string to a valid YearFilterMode. */
export function normalizeFilterMode(raw: unknown): YearFilterMode {
  // Former exclusive advanced/tags/status surfaces are filter axes now, not body views.
  if (raw === "advanced" || raw === "status" || raw === "tags") return "tree";
  if (typeof raw === "string" && FILTER_MODES.has(raw)) return raw as YearFilterMode;
  return "tree";
}

// null = 지역 필터 비활성. {kind:"none"} = region이 없는 노트만. {kind:"region", name} =
// region === name인 노트만 (단일 선택 — 동시에 여러 지역을 고를 수 없다).
export type RegionFilter = { kind: "none" } | { kind: "region"; name: string } | null;

// §2.8 HANDOFF-calendar-onboarding.md: Advanced-search date-range chips ("최근 7일/30일/올해").
// Record axis (notes.updated_at) — NOT the year (event axis) slider above, a different filter
// entirely. Stored as the chip's IDENTITY, not resolved dates: resolving "last7" to concrete
// from/to at store-write time would freeze the window at whatever moment the chip was clicked,
// so a session left open overnight keeps querying yesterday's "last 7 days" — see noteQuery.ts's
// resolveDateRange, which re-resolves at every query-build call instead.
export type DateRangeKey = "last7" | "last30" | "thisYear";

// 연도 필터 범위는 note_year_histogram 집계에서 도출한다 (Wave A-4: 코퍼스 평탄화 제거).
// 문서가 없으면 생성일(올해) 기준의 중립 범위로 폴백한다.
// min/max = data min/max + padYearRange (대시보드 deriveFullRange 와 동일). 10년 스냅·MIN_YEAR_SPAN 폐기.
// dataMin/dataMax 는 실제 노트 연도; padded 는 축이 데이터보다 넓어졌을 때(또는 빈 코퍼스 폴백).

/** Year-filter axis bounds. min/max always drive clamping; dataMin/dataMax/padded describe provenance. */
export type YearBounds = {
  min: number;
  max: number;
  /** Real note years before padding. null = empty corpus / neutral fallback. */
  dataMin?: number | null;
  dataMax?: number | null;
  /** True when min/max were widened beyond real note years (or neutral empty fallback). */
  padded?: boolean;
};

function fallbackBounds(): YearBounds {
  const y = new Date().getFullYear();
  return { min: y - 100, max: y, dataMin: null, dataMax: null, padded: true };
}

function deriveYearBoundsFromCounts(yearCounts: Record<number, number>): YearBounds {
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const key of Object.keys(yearCounts)) {
    const y = Number(key);
    if (!Number.isFinite(y)) continue;
    if (y < dataMin) dataMin = y;
    if (y > dataMax) dataMax = y;
  }
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return fallbackBounds();
  const { from: min, to: max } = padYearRange(dataMin, dataMax);
  const padded = min < dataMin || max > dataMax;
  return { min, max, dataMin, dataMax, padded };
}

function patchSummaryResults(
  results: NoteSummary[],
  id: string,
  patch: Partial<NoteSummary>,
): NoteSummary[] {
  let found = false;
  const next = results.map((note) => {
    if (note.id !== id) return note;
    found = true;
    return { ...note, ...patch };
  });
  return found ? next : results;
}

interface SearchState {
  query: string;
  yearFrom: number;
  yearTo: number;
  // 등록된 문서에서 도출한 연도 필터 전체 범위 (notes 스토어의 loadTree 마다
  // recomputeYearBounds 로 재계산). yearFrom/yearTo 는 이 범위 안의 사용자 선택 구간이다.
  // dataMin/dataMax/padded describe provenance for labelling only — filter math uses min/max.
  yearBounds: YearBounds;
  // 등록된 문서의 연도별 개수 (loadTree 마다 recomputeYearBounds 가 함께 도출). TimelineFilter
  // 가 슬라이더 축 위에 밀도 히스토그램(연도별 노트 수)을 그리는 데 쓴다. 원시 연도→개수 맵만
  // 보관하고, 버킷팅(눈금 정렬)은 렌더 시점에 뷰가 현재 MIN/MAX 에 맞춰 한다.
  yearCounts: Record<number, number>;
  filterMode: YearFilterMode;
  selectedTags: string[];
  /**
   * Wire value for note_query's tag_mode. The UI no longer switches it — the OR/AND
   * segmented control was removed in favour of click-to-replace / Ctrl-click-to-add,
   * with the policy pinned to "and" so that picking more tags narrows, exactly like
   * every other axis in the panel (status, region, year). The backend still supports
   * both; this field is the one knob if the policy is ever revisited.
   */
  tagMode: "or" | "and";
  regionFilter: RegionFilter;
  statusFilter: string[];
  /** Advanced-search date-range chip (record axis) — see DateRangeKey. null = axis inactive. */
  dateRange: DateRangeKey | null;
  searchResults: NoteSummary[];
  /** search_notes 가 예약됐거나 비행 중 — "0건" 과 "아직 모름" 을 가른다(L-4). */
  searching: boolean;
  /**
   * Find-next cursor over search result *matches*.
   * null = no current match. Independent of activeNote / selectNote — stepping never opens.
   * Index is into matchIds / matchRowIndices, not the raw flattened tree (headers skipped).
   */
  matchCursor: number | null;
  /** Note ids in traversal order; NoteTree syncs from the displayed (filtered) rows. */
  matchIds: string[];
  /** Parallel flattened-list row indices for react-window scrollToRow. */
  matchRowIndices: number[];
  setQuery: (q: string) => void;
  setYearRange: (from: number, to: number) => void;
  setFilterMode: (m: YearFilterMode) => void;
  /**
   * `additive` (Ctrl/Cmd/Shift-click) toggles the tag in or out of the current set.
   * A plain click replaces the set with just this tag — and clears it when that tag
   * was already the only one selected, so the filter can always be undone with the
   * same gesture that set it.
   */
  selectTag: (name: string, additive: boolean) => void;
  clearTagFilter: () => void;
  setRegionFilter: (f: RegionFilter) => void;
  toggleStatusFilter: (key: string) => void;
  clearStatusFilter: () => void;
  /** Selecting the currently-active chip clears it — same undo-with-the-same-gesture rule
   * as selectTag (§2.8 HANDOFF). Raw setter — the component passes `null` on re-click of the
   * already-active chip, same pattern as setRegionFilter. */
  setDateRangeFilter: (key: DateRangeKey | null) => void;
  /** Clear every filter axis (query/year/tags/region/status/dateRange) — single source for the
   * SearchBox reset badge, FilterModal footer, and (formerly) LeftPanel's inline onResetFilters. */
  resetAllFilters: () => void;
  patchNoteSummary: (id: string, patch: Partial<NoteSummary>) => void;
  /**
   * Apply a year→count map (from note_year_histogram or tests): update yearCounts,
   * recompute yearBounds, and clamp/snap yearFrom/yearTo like the old corpus path.
   */
  applyYearCounts: (yearCounts: Record<number, number>) => void;
  /** Fetch note_year_histogram and applyYearCounts. Fire-and-forget safe. */
  refreshYearHistogram: () => Promise<void>;
  /** NoteTree pushes the current match list; clamps a live cursor, does not open notes. */
  syncSearchMatches: (matches: SearchMatch[]) => void;
  /** ArrowDown/Up: move cursor only. No-op when search mode is inert (no query/year). */
  stepMatchCursor: (delta: number) => void;
  clearMatchCursor: () => void;
  /** Current match note id, or null when cursor is none / list empty. */
  currentMatchId: () => string | null;
  /**
   * Device-local recent search queries (newest first). Hydrated via loadRecentSearches;
   * mutated by add/remove/clear — each mutation persists through settings_set(search_recent).
   */
  recentSearches: string[];
  /** Pull search_recent from settings_get_all once (idempotent after first success). */
  loadRecentSearches: () => Promise<void>;
  /** Record a committed query (Enter / pick-from-history). No-op on empty. */
  addRecentSearch: (q: string) => void;
  removeRecentSearch: (q: string) => void;
  clearRecentSearches: () => void;
}

export function isSearchFiltered(s: {
  query: string;
  yearFrom: number;
  yearTo: number;
  yearBounds: YearBounds;
  selectedTags: string[];
  regionFilter: RegionFilter;
  statusFilter: string[];
  dateRange: DateRangeKey | null;
}): boolean {
  return countActiveFilterAxes(s) > 0;
}

/** How many independent filter axes are non-default — drives the strip / toggle reset badge. */
export function countActiveFilterAxes(s: {
  query: string;
  yearFrom: number;
  yearTo: number;
  yearBounds: YearBounds;
  selectedTags: string[];
  regionFilter: RegionFilter;
  statusFilter: string[];
  dateRange: DateRangeKey | null;
}): number {
  let n = 0;
  if (s.query.trim() !== "") n += 1;
  if (s.yearFrom > s.yearBounds.min || s.yearTo < s.yearBounds.max) n += 1;
  if (s.selectedTags.length > 0) n += 1;
  if (s.regionFilter !== null) n += 1;
  if (s.statusFilter.length > 0) n += 1;
  if (s.dateRange !== null) n += 1;
  return n;
}

export function useIsFiltered(): boolean {
  return useSearchStore(isSearchFiltered);
}

export function useActiveFilterCount(): number {
  return useSearchStore(countActiveFilterAxes);
}

export const useSearchStore = create<SearchState>((set, get) => {
  // searchActive gates keyword execution — query or year filter ONLY.
  // Do NOT unify with isSearchFiltered(s) (which also checks tags, region, status to drive the reset button).
  // Tag/region/status filters go through note_query server-side for the folder tree. The client-side post-filter
  // (createMatchesTagRegion) applies ONLY to searchResults (the search_notes path).
  const searchActive = () => {
    const s = get();
    const b = s.yearBounds;
    return s.query.trim() !== "" || s.yearFrom > b.min || s.yearTo < b.max;
  };

  // Keyword search — 빠른 타이핑 응답, 항상 즉시 표시되는 검색 결과.
  // Bug fix: the 200ms debounce only clears the *timer* — it doesn't cancel an already-in-flight
  // search_notes call. Under DB load (>200ms round-trip), a new debounce can fire while the
  // previous request is still pending, putting two calls in flight. Without a guard, the
  // LATER-arriving response wins even if it's for the older query.
  let keywordDebounce: ReturnType<typeof setTimeout> | null = null;
  const recomputeKeyword = async () => {
    const s = get();
    if (!searchActive()) {
      set({ searchResults: [], searching: false });
      return;
    }
    const reqQuery = s.query;
    const reqYearFrom = s.yearFrom;
    const reqYearTo = s.yearTo;
    const isStale = () => {
      const cur = get();
      return cur.query !== reqQuery || cur.yearFrom !== reqYearFrom || cur.yearTo !== reqYearTo;
    };
    try {
      const r = await call<{ results: NoteSummary[]; total: number }>("search_notes", {
        query: reqQuery,
        year_from: reqYearFrom,
        year_to: reqYearTo,
      });
      if (isStale()) return;
      set({ searchResults: r.results, searching: false });
    } catch (e) {
      // U5(AUDIT-2026-09-26): 예전엔 여기 catch 가 없어(call() 이 이미 toast 는 띄우지만 그 뒤
      // 상태는 그대로) 실패한 질의의 이전 결과가 새 질의 텍스트 아래 그대로 남아 있었다 — 검색이
      // 실패했는데 화면은 뭔가 매치된 것처럼 보였다. 더 최근 요청이 이미 성공해 있었다면
      // (isStale()) 그 결과를 지우지 않는다.
      if (!isStale()) {
        reportFallback("search", "search_notes_failed", e instanceof Error ? e.message : String(e));
        set({ searchResults: [], searching: false });
      }
    }
  };
  const scheduleSearch = () => {
    const active = searchActive();
    if (get().searching !== active) set({ searching: active });
    if (keywordDebounce) clearTimeout(keywordDebounce);
    keywordDebounce = setTimeout(() => {
      keywordDebounce = null;
      // callSilent() inside recomputeKeyword() already toasts on failure (see invoke.ts::call); this
      // catch only prevents an unhandled-rejection warning from the un-awaited timer callback —
      // it does not change what the user sees.
      recomputeKeyword().catch(() => {});
    }, 200);
  };

  // 초기 범위는 아직 트리를 로드하기 전이라 문서가 없으므로 중립 폴백. 첫 loadTree 에서
  // 실제 문서 범위로 갱신된다(recomputeYearBounds).
  const initBounds = fallbackBounds();

  const persistRecent = (next: string[]) => {
    // Literal key (not [SEARCH_RECENT_KEY]) so scripts/check-settings-keys.mjs can extract it.
    void callSilent("settings_set", { entries: { search_recent: next } }).catch(() => {});
  };

  return {
    query: "",
    yearBounds: initBounds,
    yearCounts: {},
    yearFrom: initBounds.min,
    yearTo: initBounds.max,
    filterMode: "tree",
    selectedTags: [],
    tagMode: "and",
    regionFilter: null,
    statusFilter: [],
    dateRange: null,
    searchResults: [],
    searching: false,
    matchCursor: null,
    matchIds: [],
    matchRowIndices: [],
    recentSearches: [],

    // Query identity change clears the find-next cursor (PDF find resets on new term).
    setQuery: (q) => {
      set({ query: q, matchCursor: null });
      scheduleSearch();
    },
    // NaN 방어(defense in depth): 드래그 계산이 어떤 이유로든 비유한값을 만들어도 여기서 막아
    // 상태(yearFrom/yearTo)가 절대 NaN 으로 오염되지 않게 한다 — 한 번 오염되면 이후 모든
    // 드래그가 Math.min/max(NaN,…)=NaN 으로 영구 고착("조작불가")되기 때문이다.
    // Also clamp into the live corpus yearBounds so era chips / restore / handles cannot
    // push the selection outside the axis (handle left the track when to=5000 on a 1900 max).
    // Bounds are read at call time — yearBounds is recomputed as the corpus changes.
    setYearRange: (from, to) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      const { min, max } = get().yearBounds;
      let nf = Math.min(Math.max(from, min), max);
      let nt = Math.min(Math.max(to, min), max);
      // Collapsed or inverted after clamp → full corpus (same recovery as applyYearCounts).
      if (!(nf < nt)) {
        nf = min;
        nt = max;
      }
      set({ yearFrom: nf, yearTo: nt, matchCursor: null });
      scheduleSearch();
    },
    // 뷰 전환은 필터를 지우지 않는다. 4모드 시절에는 각 모드가 축 하나를 소유해서 전환 =
    // 그 축을 떠나는 것이었지만, 이제 탭은 뷰다 — 트리뷰로 가면서 축을 지우면 태그·지역·상태로
    // 좁혀진 트리라는 게 존재할 수 없게 되고, note_query 의 서버측 축(tag/region/status)과
    // filterAxesKey 무효화 경로가 통째로 죽는다. 축을 비우는 건 항상 노출돼 있는 초기화
    // 버튼(filter.show_all / isSearchFiltered)의 역할이다.
    setFilterMode: (m) => {
      const mode = normalizeFilterMode(m);
      if (get().filterMode === mode) return;
      set({ filterMode: mode });
    },

    // Tags 모드: 선택된 태그 목록에 토글 추가/제거. OR 매칭(선택된 태그 중 하나라도 있으면
    // 통과) — NoteTree가 이 배열을 읽어 필터링한다 (백엔드 호출 없음, 이미 로드된 데이터).
    selectTag: (name, additive) =>
      set((s) => {
        if (additive) {
          return {
            selectedTags: s.selectedTags.includes(name)
              ? s.selectedTags.filter((t) => t !== name)
              : [...s.selectedTags, name],
          };
        }
        const soleSelection = s.selectedTags.length === 1 && s.selectedTags[0] === name;
        return { selectedTags: soleSelection ? [] : [name] };
      }),
    clearTagFilter: () => set({ selectedTags: [] }),

    // Région 모드: 단일 선택(같은 값 재클릭 시 해제는 호출부에서 null을 넘긴다).
    setRegionFilter: (f) => set({ regionFilter: f }),

    // Statut 모드: Tags 와 동일한 모양 — 선택된 상태 키 목록에 토글 추가/제거, OR 매칭.
    toggleStatusFilter: (key) =>
      set((s) => ({
        statusFilter: s.statusFilter.includes(key)
          ? s.statusFilter.filter((k) => k !== key)
          : [...s.statusFilter, key],
      })),
    clearStatusFilter: () => set({ statusFilter: [] }),

    setDateRangeFilter: (key) => set({ dateRange: key }),

    resetAllFilters: () => {
      const s = get();
      s.setYearRange(s.yearBounds.min, s.yearBounds.max);
      s.setQuery("");
      s.clearTagFilter();
      s.setRegionFilter(null);
      s.clearStatusFilter();
      s.setDateRangeFilter(null);
    },

    patchNoteSummary: (id, patch) =>
      set((s) => {
        const searchResults = patchSummaryResults(s.searchResults, id, patch);
        if (searchResults === s.searchResults) return s;
        return { searchResults };
      }),

    applyYearCounts: (yearCounts) => {
      const prev = get().yearBounds;
      const nb = deriveYearBoundsFromCounts(yearCounts);
      const { yearFrom, yearTo } = get();
      const wasFull = yearFrom <= prev.min && yearTo >= prev.max;
      let nf = wasFull ? nb.min : Math.min(Math.max(yearFrom, nb.min), nb.max);
      let nt = wasFull ? nb.max : Math.max(Math.min(yearTo, nb.max), nb.min);
      // !(nf < nt) 로 써야 NaN 도 잡는다 — nf/nt 중 하나라도 NaN 이면 nf < nt 가 false 이므로
      // 전체 범위로 복구된다(이전의 nf >= nt 는 NaN >= NaN === false 라 오염을 못 풀었다).
      if (!(nf < nt)) {
        nf = nb.min;
        nt = nb.max;
      }
      set({ yearBounds: nb, yearFrom: nf, yearTo: nt, yearCounts });
    },

    refreshYearHistogram: async () => {
      try {
        const { noteYearHistogram } = await import("../lib/noteQuery");
        const serverCounts = await noteYearHistogram();
        get().applyYearCounts(serverCounts);
      } catch {
        // Keep prior bounds/counts; density strip stays empty until next success.
      }
    },

    syncSearchMatches: (matches) => {
      // Outside search mode NoteTree pushes [] — clears cursor and kills stale indices.
      const matchIds = matches.map((m) => m.noteId);
      const matchRowIndices = matches.map((m) => m.rowIndex);
      set((s) => {
        const nextCursor = clampMatchCursor(s.matchCursor, matchIds.length);
        const sameIds =
          matchIds.length === s.matchIds.length &&
          matchIds.every((id, i) => id === s.matchIds[i]);
        const sameRows =
          matchRowIndices.length === s.matchRowIndices.length &&
          matchRowIndices.every((r, i) => r === s.matchRowIndices[i]);
        if (sameIds && sameRows && nextCursor === s.matchCursor) return s;
        return { matchIds, matchRowIndices, matchCursor: nextCursor };
      });
    },

    stepMatchCursor: (delta) => {
      // Inert when search mode is off (tag/region/status-only filter must not navigate).
      if (!searchActive()) return;
      const s = get();
      const next = stepMatchCursorPure(s.matchCursor, delta, s.matchIds.length);
      if (next === s.matchCursor) return;
      set({ matchCursor: next });
    },

    clearMatchCursor: () => set({ matchCursor: null }),

    currentMatchId: () => {
      const s = get();
      if (s.matchCursor === null) return null;
      return s.matchIds[s.matchCursor] ?? null;
    },

    loadRecentSearches: async () => {
      try {
        const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
        const next = normalizeRecentList(r.settings?.[SEARCH_RECENT_KEY]);
        set({ recentSearches: next });
      } catch {
        // Boot race / offline — leave whatever is already in memory; next call retries.
      }
    },

    addRecentSearch: (q) => {
      const prev = get().recentSearches;
      const next = promoteRecentSearch(prev, q);
      // No-op when empty, or when already newest (promote still allocates — compare contents).
      if (
        next.length === prev.length &&
        next.every((v, i) => v === prev[i])
      ) {
        return;
      }
      set({ recentSearches: next });
      persistRecent(next);
    },

    removeRecentSearch: (q) => {
      const prev = get().recentSearches;
      const next = removeRecentSearchItem(prev, q);
      if (next.length === prev.length) return;
      set({ recentSearches: next });
      persistRecent(next);
    },

    clearRecentSearches: () => {
      if (get().recentSearches.length === 0) return;
      set({ recentSearches: [] });
      persistRecent([]);
    },
  };
});

/** True when keyword search mode is live (query or year slice) — not tag/region/status alone. */
export function isSearchModeActive(s: {
  query: string;
  yearFrom: number;
  yearTo: number;
  yearBounds: YearBounds;
}): boolean {
  return s.query.trim() !== "" || s.yearFrom > s.yearBounds.min || s.yearTo < s.yearBounds.max;
}
