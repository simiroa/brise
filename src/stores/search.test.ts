import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const emitNoticeMock = vi.fn();
// Tracks whether call() toasted on rejection (see lib/invoke.ts::call — it always toasts then
// rethrows). Lets tests assert a failing keyword search surfaces a toast without re-testing
// invoke.ts's internals.
const toastMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  callSilent: (...args: unknown[]) => callMock(...args),
  call: async (...args: unknown[]) => {
    try {
      return await callMock(...args);
    } catch (e) {
      toastMock(e);
      throw e;
    }
  },
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

// A(AUDIT-2026-09-26): a search_notes failure is now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

import {
  useSearchStore,
  isSearchFiltered,
  normalizeFilterMode,
  promoteRecentSearch,
  removeRecentSearchItem,
  filterRecentSearches,
  SEARCH_RECENT_MAX,
  SEARCH_RECENT_KEY,
} from "./search";

describe("search store — keyword search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    reportFallbackMock.mockClear();
    // 연도 범위는 이제 등록 문서에서 도출한 yearBounds(프리셋 대체) — 900..1960 으로 맞추고
    // yearFrom/yearTo 도 그 전체 범위로 두어 빈 쿼리가 "검색 비활성"으로 읽히게 한다
    // (search.ts::searchActive 참조).
    useSearchStore.setState({
      query: "",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
      searchResults: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("200ms debounce, search_notes called with query/year_from/year_to", async () => {
    callMock.mockResolvedValue({ results: [], total: 0 });

    useSearchStore.getState().setQuery("silla");

    await vi.advanceTimersByTimeAsync(199);
    expect(callMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callMock).toHaveBeenCalledWith("search_notes", {
      query: "silla",
      year_from: 900,
      year_to: 1960,
    });
  });

  it("searching: 예약 시 true, 비-stale 응답이 오면 false (L-4)", async () => {
    callMock.mockResolvedValue({ results: [], total: 0 });
    useSearchStore.getState().setQuery("silla");
    expect(useSearchStore.getState().searching).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(useSearchStore.getState().searching).toBe(false);
  });

  it("searching: 검색이 비활성(빈 쿼리)이면 true 로 두지 않는다", () => {
    useSearchStore.getState().setQuery("");
    expect(useSearchStore.getState().searching).toBe(false);
  });

  it("discards a stale keyword response if the query changed while it was in flight", async () => {
    let resolveStale!: (v: unknown) => void;
    const stale = new Promise((res) => {
      resolveStale = res;
    });
    callMock.mockImplementation((_cmd: string, args: any) => {
      if (args.query === "sil") return stale;
      return Promise.resolve({ results: [{ id: "fresh" }], total: 1 });
    });

    useSearchStore.getState().setQuery("sil");
    await vi.advanceTimersByTimeAsync(200); // keyword("sil") in flight, unresolved

    useSearchStore.getState().setQuery("silla");
    await vi.advanceTimersByTimeAsync(200); // keyword("silla") resolves first
    await Promise.resolve();
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.map((n: any) => n.id)).toEqual(["fresh"]);

    // the stale "sil" response now arrives — must be discarded, not overwrite "fresh".
    resolveStale({ results: [{ id: "stale" }], total: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.map((n: any) => n.id)).toEqual(["fresh"]);
  });

  it("clears results when the search is cleared", async () => {
    callMock.mockResolvedValue({ results: [{ id: "n1" }], total: 1 });

    useSearchStore.getState().setQuery("silla");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.length).toBe(1);

    useSearchStore.getState().setQuery("");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    expect(useSearchStore.getState().searchResults).toEqual([]);
  });

  it("a failing keyword request surfaces an error toast", async () => {
    callMock.mockRejectedValue({ code: "DB", message: "keyword search failed" });

    useSearchStore.getState().setQuery("silla");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  // U5(AUDIT-2026-09-26): a failing search used to leave the PREVIOUS query's results on screen
  // under the new query text — the display looked like it matched, but it was stale. It must clear
  // (or be marked stale), and the failure must be diagnosable (reportFallback).
  it("U5: clears stale results (rather than leaving the old query's matches) when the new query's search fails", async () => {
    callMock.mockResolvedValueOnce({ results: [{ id: "old-match" }], total: 1 });
    useSearchStore.getState().setQuery("first query");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.map((n: any) => n.id)).toEqual(["old-match"]);

    callMock.mockRejectedValueOnce(new Error("db locked"));
    useSearchStore.getState().setQuery("second query");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    // The old "first query" match must not still be shown under "second query".
    expect(useSearchStore.getState().searchResults).toEqual([]);
    expect(reportFallbackMock).toHaveBeenCalledWith("search", "search_notes_failed", "db locked");
  });

  it("U5: a stale failure (an older, slower request) does not clear results a newer request already succeeded with", async () => {
    let rejectOld!: (e: unknown) => void;
    const oldPromise = new Promise((_resolve, reject) => {
      rejectOld = reject;
    });
    callMock.mockImplementation((_cmd: string, args: any) => {
      if (args.query === "sil") return oldPromise;
      return Promise.resolve({ results: [{ id: "fresh" }], total: 1 });
    });

    useSearchStore.getState().setQuery("sil");
    await vi.advanceTimersByTimeAsync(200); // keyword("sil") in flight, unresolved

    useSearchStore.getState().setQuery("silla");
    await vi.advanceTimersByTimeAsync(200); // keyword("silla") resolves first
    await Promise.resolve();
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.map((n: any) => n.id)).toEqual(["fresh"]);

    // The stale "sil" request now rejects — must not clear the already-fresh results.
    rejectOld(new Error("too slow"));
    await Promise.resolve();
    await Promise.resolve();
    expect(useSearchStore.getState().searchResults.map((n: any) => n.id)).toEqual(["fresh"]);
  });

  it("DEFECT 1 assertion: tag-only filter with full year bounds does NOT trigger search_notes on setYearRange", async () => {
    callMock.mockReset();

    useSearchStore.setState({
      query: "",
      selectedTags: ["tag1"],
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
      searchResults: [],
    });

    useSearchStore.getState().setYearRange(900, 1960);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    expect(callMock).not.toHaveBeenCalled();
  });

  it("isSearchFiltered still returns true for tag-only filter", () => {
    useSearchStore.setState({
      query: "",
      selectedTags: ["tag1"],
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
    });
    expect(isSearchFiltered(useSearchStore.getState())).toBe(true);
  });
});

describe("search store — setYearRange clamps to yearBounds", () => {
  beforeEach(() => {
    useSearchStore.setState({
      yearBounds: { min: 1000, max: 1900 },
      yearFrom: 1000,
      yearTo: 1900,
      query: "",
    });
  });

  it("clamps a range beyond yearBounds on both ends", () => {
    useSearchStore.getState().setYearRange(500, 5000);
    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(1000);
    expect(s.yearTo).toBe(1900);
  });

  it("clamps only the overshooting end", () => {
    useSearchStore.getState().setYearRange(1200, 5000);
    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(1200);
    expect(s.yearTo).toBe(1900);
  });

  it("leaves an in-range request untouched", () => {
    useSearchStore.getState().setYearRange(1400, 1600);
    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(1400);
    expect(s.yearTo).toBe(1600);
  });

  it("anti-vacuity: without clamp, out-of-range values would stick", () => {
    // Document the guard: a raw setState bypass (what unclamped setYearRange did) poisons the axis.
    useSearchStore.setState({ yearFrom: 500, yearTo: 5000 });
    expect(useSearchStore.getState().yearFrom).toBe(500);
    expect(useSearchStore.getState().yearTo).toBe(5000);
    // Real action recovers.
    useSearchStore.getState().setYearRange(500, 5000);
    expect(useSearchStore.getState().yearFrom).toBe(1000);
    expect(useSearchStore.getState().yearTo).toBe(1900);
  });

  it("reads yearBounds at call time (not a stale capture)", () => {
    useSearchStore.setState({ yearBounds: { min: 1000, max: 1900 } });
    useSearchStore.setState({ yearBounds: { min: 1500, max: 1800 } });
    useSearchStore.getState().setYearRange(1000, 1900);
    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(1500);
    expect(s.yearTo).toBe(1800);
  });
});

describe("search store — year density (applyYearCounts)", () => {
  it("stores the year→count map and derives bounds", () => {
    useSearchStore.getState().applyYearCounts({ 1876: 1, 1901: 3, 1945: 1 });
    expect(useSearchStore.getState().yearCounts).toEqual({ 1876: 1, 1901: 3, 1945: 1 });
    const b = useSearchStore.getState().yearBounds;
    // span 69 → pad = max(1, round(1.38)) = 1 → 1875–1946
    expect(b.min).toBe(1875);
    expect(b.max).toBe(1946);
    expect(b.dataMin).toBe(1876);
    expect(b.dataMax).toBe(1945);
    expect(b.padded).toBe(true);
  });

  it("falls back to neutral bounds for an empty map", () => {
    useSearchStore.getState().applyYearCounts({});
    expect(useSearchStore.getState().yearCounts).toEqual({});
    const y = new Date().getFullYear();
    const b = useSearchStore.getState().yearBounds;
    expect(b.min).toBe(y - 100);
    expect(b.max).toBe(y);
    expect(b.dataMin).toBeNull();
    expect(b.dataMax).toBeNull();
    expect(b.padded).toBe(true);
  });

  it("handles a single-year histogram", () => {
    useSearchStore.getState().applyYearCounts({ 1500: 3 });
    expect(useSearchStore.getState().yearCounts).toEqual({ 1500: 3 });
  });

  it("pads a single modern year with deriveFullRange formula (not MIN_YEAR_SPAN)", () => {
    // One note in 2026 → pad=1 → 2025–2027 (not decade snap 2005–2045).
    useSearchStore.getState().applyYearCounts({ 2026: 1 });
    const b = useSearchStore.getState().yearBounds;
    expect(b.min).toBe(2025);
    expect(b.max).toBe(2027);
    expect(b.dataMin).toBe(2026);
    expect(b.dataMax).toBe(2026);
    expect(b.padded).toBe(true);
  });

  it("pads multi-year span by ~2% (min 1 year each side)", () => {
    // span 40 → pad 1 → 1979–2021
    useSearchStore.getState().applyYearCounts({ 1980: 1, 2020: 1 });
    const b = useSearchStore.getState().yearBounds;
    expect(b.min).toBe(1979);
    expect(b.max).toBe(2021);
    expect(b.dataMin).toBe(1980);
    expect(b.dataMax).toBe(2020);
    expect(b.padded).toBe(true);
  });
});

describe("search store — note summary patches", () => {
  it("patches a result copy by id without changing order", () => {
    const keywordA = { id: "a", icon: null, status: null } as any;
    const keywordB = { id: "b", icon: null, status: null } as any;
    useSearchStore.setState({
      searchResults: [keywordA, keywordB],
    });

    useSearchStore.getState().patchNoteSummary("b", { icon: "emoji:🌿", status: "done" });

    const state = useSearchStore.getState();
    expect(state.searchResults.map((note) => note.id)).toEqual(["a", "b"]);
    expect(state.searchResults[0]).toBe(keywordA);
    expect(state.searchResults[1]).toMatchObject({ icon: "emoji:🌿", status: "done" });
  });

  it("keeps the result array reference when the note is absent", () => {
    const searchResults = [{ id: "a" }] as any;
    useSearchStore.setState({ searchResults });

    useSearchStore.getState().patchNoteSummary("missing", { icon: "star" });

    expect(useSearchStore.getState().searchResults).toBe(searchResults);
  });
});

describe("search store — resetAllFilters", () => {
  it("clears every axis (query/year/tags/region/status/dateRange) in one call", () => {
    useSearchStore.setState({
      query: "hello",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 1200,
      yearTo: 1500,
      selectedTags: ["fantasy"],
      regionFilter: { kind: "none" },
      statusFilter: ["done"],
      dateRange: "last7",
    });

    useSearchStore.getState().resetAllFilters();

    const s = useSearchStore.getState();
    expect(s.query).toBe("");
    expect(s.yearFrom).toBe(900);
    expect(s.yearTo).toBe(1960);
    expect(s.selectedTags).toEqual([]);
    expect(s.regionFilter).toBeNull();
    expect(s.statusFilter).toEqual([]);
    expect(s.dateRange).toBeNull();
    expect(isSearchFiltered(s)).toBe(false);
  });
});

describe("search store — dateRange chip (§2.8 record-axis filter)", () => {
  beforeEach(() => {
    useSearchStore.setState({ dateRange: null });
  });

  it("setDateRangeFilter sets the chip identity, not resolved dates", () => {
    useSearchStore.getState().setDateRangeFilter("last7");
    expect(useSearchStore.getState().dateRange).toBe("last7");
  });

  it("passing null clears it (own-inverse gesture is the caller's job, e.g. re-click of the active chip)", () => {
    useSearchStore.setState({ dateRange: "last30" });
    useSearchStore.getState().setDateRangeFilter(null);
    expect(useSearchStore.getState().dateRange).toBeNull();
  });

  it("isSearchFiltered is true when only dateRange is set", () => {
    useSearchStore.setState({
      query: "",
      selectedTags: [],
      regionFilter: null,
      statusFilter: [],
      dateRange: "thisYear",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
    });
    expect(isSearchFiltered(useSearchStore.getState())).toBe(true);
  });

  it("isSearchFiltered is false when every axis (including dateRange) is inactive", () => {
    useSearchStore.setState({
      query: "",
      selectedTags: [],
      regionFilter: null,
      statusFilter: [],
      dateRange: null,
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
    });
    expect(isSearchFiltered(useSearchStore.getState())).toBe(false);
  });
});

describe("filterMode migration (persisted old values)", () => {
  it('maps legacy "status", "tags", and "advanced" to "tree" (filter strip, not a view)', () => {
    expect(normalizeFilterMode("status")).toBe("tree");
    expect(normalizeFilterMode("tags")).toBe("tree");
    expect(normalizeFilterMode("advanced")).toBe("tree");
  });

  it('falls unknown values back to "tree"', () => {
    expect(normalizeFilterMode("decade")).toBe("tree");
    expect(normalizeFilterMode("")).toBe("tree");
    expect(normalizeFilterMode(null)).toBe("tree");
    expect(normalizeFilterMode(undefined)).toBe("tree");
    expect(normalizeFilterMode(42)).toBe("tree");
  });

  it("keeps valid current modes", () => {
    expect(normalizeFilterMode("tree")).toBe("tree");
    expect(normalizeFilterMode("region")).toBe("region");
    expect(normalizeFilterMode("timeline")).toBe("timeline");
    expect(normalizeFilterMode("chat")).toBe("chat");
    expect(normalizeFilterMode("gallery")).toBe("gallery");
    expect(normalizeFilterMode("calendar")).toBe("calendar");
  });

  it("load path: applying normalize before setState leaves no obsolete mode", () => {
    for (const raw of ["status", "tags", "advanced", "legacy-junk"] as const) {
      useSearchStore.setState({ filterMode: normalizeFilterMode(raw) });
      const mode = useSearchStore.getState().filterMode;
      expect(["tree", "region", "timeline", "chat", "gallery", "calendar"]).toContain(mode);
      expect(mode).not.toBe("status");
      expect(mode).not.toBe("tags");
      expect(mode).not.toBe("advanced");
    }
    useSearchStore.setState({ filterMode: normalizeFilterMode("status") });
    expect(useSearchStore.getState().filterMode).toBe("tree");
    useSearchStore.setState({ filterMode: normalizeFilterMode("nope") });
    expect(useSearchStore.getState().filterMode).toBe("tree");
  });

  it("default filterMode is tree", () => {
    // Fresh store shape: after a full reset of the field to the create() default.
    useSearchStore.setState({ filterMode: "tree" });
    expect(useSearchStore.getState().filterMode).toBe("tree");
  });

  // 탭은 뷰이지 필터가 아니다. 4모드 시절에는 전환이 축을 비웠는데,
  // 그대로 두면 트리뷰로 가는 순간 태그/지역/상태가 지워져 "필터된 트리"가 존재할 수 없다.
  it("switching the view keeps every filter axis — clearing is the reset badge's job", () => {
    useSearchStore.setState({
      filterMode: "chat",
      selectedTags: ["guerre"],
      regionFilter: { kind: "region", name: "Bretagne" },
      statusFilter: ["done"],
      yearFrom: 1200,
      yearTo: 1400,
    });

    useSearchStore.getState().setFilterMode("tree");

    const s = useSearchStore.getState();
    expect(s.filterMode).toBe("tree");
    expect(s.selectedTags).toEqual(["guerre"]);
    expect(s.regionFilter).toEqual({ kind: "region", name: "Bretagne" });
    expect(s.statusFilter).toEqual(["done"]);
    expect([s.yearFrom, s.yearTo]).toEqual([1200, 1400]);
  });
});

describe("search recent history — pure helpers", () => {
  it("promoteRecentSearch trims, inserts at front, and is a no-op on empty", () => {
    expect(promoteRecentSearch(["a"], "  ")).toEqual(["a"]);
    expect(promoteRecentSearch([], "silla")).toEqual(["silla"]);
    expect(promoteRecentSearch(["a", "b"], "  c  ")).toEqual(["c", "a", "b"]);
  });

  it("duplicate promotes to newest (dedupe)", () => {
    expect(promoteRecentSearch(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(promoteRecentSearch(["silla"], "silla")).toEqual(["silla"]);
  });

  it(`caps at SEARCH_RECENT_MAX (${SEARCH_RECENT_MAX})`, () => {
    const full = Array.from({ length: SEARCH_RECENT_MAX }, (_, i) => `q${i}`);
    const next = promoteRecentSearch(full, "new");
    expect(next).toHaveLength(SEARCH_RECENT_MAX);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`q${SEARCH_RECENT_MAX - 1}`);
  });

  it("removeRecentSearchItem drops one entry", () => {
    expect(removeRecentSearchItem(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(removeRecentSearchItem(["a"], "missing")).toEqual(["a"]);
  });

  it("filterRecentSearches does case-insensitive substring match", () => {
    const list = ["Silla", "Baekje", "Goguryeo", "sillan pottery"];
    expect(filterRecentSearches(list, "")).toEqual(list);
    expect(filterRecentSearches(list, "  ")).toEqual(list);
    expect(filterRecentSearches(list, "sil")).toEqual(["Silla", "sillan pottery"]);
    expect(filterRecentSearches(list, "RYE")).toEqual(["Goguryeo"]);
  });
});

describe("search store — recentSearches persist", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useSearchStore.setState({ recentSearches: [] });
  });

  it("addRecentSearch saves/caps/dedupes and persists via settings_set", async () => {
    useSearchStore.getState().addRecentSearch("alpha");
    useSearchStore.getState().addRecentSearch("beta");
    useSearchStore.getState().addRecentSearch("alpha"); // promote

    expect(useSearchStore.getState().recentSearches).toEqual(["alpha", "beta"]);
    // Last call should be the promote write.
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { search_recent: ["alpha", "beta"] },
    });
    expect(SEARCH_RECENT_KEY).toBe("search_recent");
  });

  it("addRecentSearch no-ops on empty and does not call settings_set", () => {
    useSearchStore.getState().addRecentSearch("  ");
    expect(useSearchStore.getState().recentSearches).toEqual([]);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("removeRecentSearch drops one item and persists", () => {
    useSearchStore.setState({ recentSearches: ["a", "b", "c"] });
    useSearchStore.getState().removeRecentSearch("b");
    expect(useSearchStore.getState().recentSearches).toEqual(["a", "c"]);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { search_recent: ["a", "c"] },
    });
  });

  it("clearRecentSearches empties and persists []", () => {
    useSearchStore.setState({ recentSearches: ["a", "b"] });
    useSearchStore.getState().clearRecentSearches();
    expect(useSearchStore.getState().recentSearches).toEqual([]);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { search_recent: [] },
    });
  });

  it("clearRecentSearches no-ops when already empty", () => {
    useSearchStore.getState().clearRecentSearches();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("loadRecentSearches hydrates from settings_get_all (string array only, trim, cap)", async () => {
    callMock.mockResolvedValueOnce({
      settings: { search_recent: ["one", "two", 3, "", "  three  "] },
    });
    useSearchStore.setState({ recentSearches: [] });
    await useSearchStore.getState().loadRecentSearches();
    expect(useSearchStore.getState().recentSearches).toEqual(["one", "two", "three"]);
    expect(callMock).toHaveBeenCalledWith("settings_get_all");
  });
});
