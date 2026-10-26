import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGeocodeSearch, meetsMinQueryLength } from "./useGeocodeSearch";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

describe("useGeocodeSearch", () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces 1100ms then calls geocode_search and returns results", async () => {
    callMock.mockResolvedValue({ results: [{ label: "Seoul, KR", lat: 37.57, lng: 126.98 }] });
    const { result, rerender } = renderHook(({ q, lang }) => useGeocodeSearch(q, lang), {
      initialProps: { q: "Seoul", lang: "en" },
    });

    expect(result.current.searching).toBe(true);
    expect(callMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    rerender({ q: "Seoul", lang: "en" });

    expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "Seoul", lang: "en" });
    expect(result.current.searching).toBe(false);
    expect(result.current.results).toEqual([{ label: "Seoul, KR", lat: 37.57, lng: 126.98 }]);
    expect(result.current.unavailable).toBe(false);
  });

  it("sets unavailable on a rejected geocode_search", async () => {
    callMock.mockRejectedValue(new Error("network down"));
    const { result, rerender } = renderHook(({ q, lang }) => useGeocodeSearch(q, lang), {
      initialProps: { q: "Paris", lang: "en" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    rerender({ q: "Paris", lang: "en" });

    expect(result.current.unavailable).toBe(true);
    expect(result.current.results).toEqual([]);
  });

  // The stale-response guard: a slower response to an older query must not clobber a faster
  // response to a newer one. This is the bug RegionPickerDialog/MobileNoteBadges had before A-1
  // (only MapPlaceSearch guarded against it).
  it("drops a late response for a stale query once a newer query has resolved", async () => {
    let resolveParis: (v: unknown) => void = () => {};
    let resolveBerlin: (v: unknown) => void = () => {};
    callMock.mockImplementation((_cmd: string, args: { query: string }) => {
      if (args.query === "Paris") return new Promise((r) => (resolveParis = r));
      if (args.query === "Berlin") return new Promise((r) => (resolveBerlin = r));
      return Promise.resolve({ results: [] });
    });

    const { result, rerender } = renderHook(({ q, lang }) => useGeocodeSearch(q, lang), {
      initialProps: { q: "Paris", lang: "en" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    rerender({ q: "Berlin", lang: "en" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Berlin (newer) resolves first.
    await act(async () => {
      resolveBerlin({ results: [{ label: "Berlin, DE", lat: 52.52, lng: 13.4 }] });
      await Promise.resolve();
    });
    rerender({ q: "Berlin", lang: "en" });
    expect(result.current.results).toEqual([{ label: "Berlin, DE", lat: 52.52, lng: 13.4 }]);

    // Paris (older, slower) resolves late — must be dropped, not overwrite Berlin's results.
    await act(async () => {
      resolveParis({ results: [{ label: "Paris, FR", lat: 48.85, lng: 2.35 }] });
      await Promise.resolve();
    });
    rerender({ q: "Berlin", lang: "en" });
    expect(result.current.results).toEqual([{ label: "Berlin, DE", lat: 52.52, lng: 13.4 }]);
  });

  it("clears state synchronously when the query is emptied", async () => {
    callMock.mockResolvedValue({ results: [{ label: "Seoul, KR", lat: 37.57, lng: 126.98 }] });
    const { result, rerender } = renderHook(({ q, lang }) => useGeocodeSearch(q, lang), {
      initialProps: { q: "Seoul", lang: "en" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    rerender({ q: "Seoul", lang: "en" });
    expect(result.current.results.length).toBe(1);

    rerender({ q: "", lang: "en" });
    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.unavailable).toBe(false);
  });

  describe("안정화 가드", () => {
    const flush = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    it("한글 IME 조합 중에는 요청을 보내지 않고, 조합이 끝나면 디바운스 뒤 검색한다", async () => {
      callMock.mockResolvedValue({ results: [{ label: "부산", lat: 35.18, lng: 129.08 }] });
      const { result, rerender } = renderHook(({ q }) => useGeocodeSearch(q, "ko"), { initialProps: { q: "" } });

      act(() => result.current.compositionProps.onCompositionStart());
      rerender({ q: "부산" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(callMock).not.toHaveBeenCalled();
      expect(result.current.searching).toBe(false);

      act(() => result.current.compositionProps.onCompositionEnd());
      expect(result.current.searching).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "부산", lang: "ko" });
    });

    it("최소 길이 미만(ASCII 한 글자)은 보내지 않고 tooShort, 한글 한 글자는 허용", async () => {
      callMock.mockResolvedValue({ results: [] });
      expect(meetsMinQueryLength("S")).toBe(false);
      expect(meetsMinQueryLength("서")).toBe(true);
      expect(meetsMinQueryLength("Se")).toBe(true);
      expect(meetsMinQueryLength("  ")).toBe(false);

      const { result, rerender } = renderHook(({ q }) => useGeocodeSearch(q, "en"), { initialProps: { q: "S" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(callMock).not.toHaveBeenCalled();
      expect(result.current.tooShort).toBe(true);
      expect(result.current.searching).toBe(false);

      rerender({ q: "서" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(callMock).toHaveBeenCalledTimes(1);
      expect(result.current.tooShort).toBe(false);
    });

    it("searchNow(Enter)는 디바운스를 건너뛰고 즉시 검색한다", async () => {
      callMock.mockResolvedValue({ results: [{ label: "Seoul", lat: 1, lng: 2 }] });
      const { result } = renderHook(() => useGeocodeSearch("Seoul", "en"));
      expect(callMock).not.toHaveBeenCalled();

      act(() => result.current.searchNow());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await flush();
      expect(callMock).toHaveBeenCalledTimes(1);
      expect(result.current.results).toHaveLength(1);

      // 이미 이 질의로 정착했으면 또 쏘지 않는다.
      act(() => result.current.searchNow());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(callMock).toHaveBeenCalledTimes(1);
    });

    it("실패하면 unavailable, searchNow 로 재시도하면 복구된다", async () => {
      callMock.mockRejectedValueOnce(new Error("down"));
      const { result } = renderHook(() => useGeocodeSearch("Paris", "en"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(result.current.unavailable).toBe(true);

      callMock.mockResolvedValue({ results: [{ label: "Paris", lat: 48.85, lng: 2.35 }] });
      act(() => result.current.searchNow());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await flush();
      expect(callMock).toHaveBeenCalledTimes(2);
      expect(result.current.unavailable).toBe(false);
      expect(result.current.results).toEqual([{ label: "Paris", lat: 48.85, lng: 2.35 }]);
    });

    it("요청 순번 가드: 같은 질의의 옛 요청이 늦게 와도 최신 재시도 결과를 덮지 않는다", async () => {
      const resolvers: ((v: unknown) => void)[] = [];
      callMock.mockImplementation(() => new Promise((r) => resolvers.push(r)));
      const { result } = renderHook(() => useGeocodeSearch("Seoul", "en"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(resolvers).toHaveLength(1);

      // 첫 요청이 아직 안 끝난 채 Enter — 새 요청이 나간다.
      act(() => result.current.searchNow());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(resolvers).toHaveLength(2);

      await act(async () => {
        resolvers[1]({ results: [{ label: "NEW", lat: 1, lng: 1 }] });
        await Promise.resolve();
      });
      await act(async () => {
        resolvers[0]({ results: [{ label: "OLD", lat: 2, lng: 2 }] });
        await Promise.resolve();
      });
      expect(result.current.results).toEqual([{ label: "NEW", lat: 1, lng: 1 }]);
    });
  });
});
