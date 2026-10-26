import { describe, it, expect, vi, beforeEach } from "vitest";
import { callSilent } from "./invoke";
import { loadRegionRegistry, getCachedRegionRegistry, invalidateRegionRegistry } from "./regionRegistry";
import { useSettingsStore } from "../stores/settings";

// CLAUDE.md 함정: vi.mock("../../lib/invoke", ...) 류는 call/callSilent 를 둘 다 목해야
// check:surface 게이트를 통과한다 — 이 파일은 invoke.ts 자체를 상대경로로 import 하므로 같은 규칙.
vi.mock("./invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./invoke")>();
  return {
    ...actual,
    call: vi.fn(),
    callSilent: vi.fn(),
  };
});

describe("regionRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRegionRegistry();
  });

  it("fetches once and caches — a second call returns the cached value without a second IPC call", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    mockCallSilent.mockResolvedValueOnce({ entries: [{ name: "경주", lat: 35.8, lng: 129.2 }] });

    const first = await loadRegionRegistry();
    expect(first).toEqual([{ name: "경주", lat: 35.8, lng: 129.2 }]);
    expect(getCachedRegionRegistry()).toEqual(first);

    const second = await loadRegionRegistry();
    expect(second).toBe(first);
    expect(mockCallSilent).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent callers during the first in-flight fetch into one IPC call", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    let resolveFn: (v: { entries: { name: string; lat: number; lng: number }[] }) => void;
    mockCallSilent.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );

    const p1 = loadRegionRegistry();
    const p2 = loadRegionRegistry();
    resolveFn!({ entries: [{ name: "부산", lat: 35.1, lng: 129.0 }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(mockCallSilent).toHaveBeenCalledTimes(1);
  });

  it("a failed fetch resolves to an empty array (no toast, no throw) and does not poison the cache for a later retry", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    mockCallSilent.mockRejectedValueOnce(new Error("network down"));

    const result = await loadRegionRegistry();
    expect(result).toEqual([]);
    expect(getCachedRegionRegistry()).toBeNull();

    mockCallSilent.mockResolvedValueOnce({ entries: [{ name: "서울", lat: 37.5, lng: 126.9 }] });
    const retry = await loadRegionRegistry();
    expect(retry).toEqual([{ name: "서울", lat: 37.5, lng: 126.9 }]);
  });

  it("invalidateRegionRegistry() clears the cache so the next load re-fetches", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    mockCallSilent
      .mockResolvedValueOnce({ entries: [{ name: "A", lat: 1, lng: 1 }] })
      .mockResolvedValueOnce({ entries: [{ name: "B", lat: 2, lng: 2 }] });

    const first = await loadRegionRegistry();
    expect(first[0].name).toBe("A");

    invalidateRegionRegistry();
    expect(getCachedRegionRegistry()).toBeNull();

    const second = await loadRegionRegistry();
    expect(second[0].name).toBe("B");
    expect(mockCallSilent).toHaveBeenCalledTimes(2);
  });

  it("force:true re-fetches even with a warm cache", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    mockCallSilent
      .mockResolvedValueOnce({ entries: [{ name: "A", lat: 1, lng: 1 }] })
      .mockResolvedValueOnce({ entries: [{ name: "A2", lat: 9, lng: 9 }] });

    await loadRegionRegistry();
    const forced = await loadRegionRegistry({ force: true });
    expect(forced[0].name).toBe("A2");
    expect(mockCallSilent).toHaveBeenCalledTimes(2);
  });

  // §P3 Phase B 검증 중 발견 — 이 모듈 캐시는 프로세스 수명이라 노트북(= 기존 workspace)을 바꿔도
  // 남는다. 키 없이는 A 노트북의 지역명이 B 노트북 본문에서 "감지됨"으로 뜬다.
  it("re-fetches when the active notebook changes instead of serving the other notebook's names", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    const before = useSettingsStore.getState().activeWorkspaceId;
    try {
      useSettingsStore.setState({ activeWorkspaceId: "nb-a" });
      mockCallSilent.mockResolvedValueOnce({ entries: [{ name: "경주", lat: 35.8, lng: 129.2 }] });
      expect(await loadRegionRegistry()).toEqual([{ name: "경주", lat: 35.8, lng: 129.2 }]);

      useSettingsStore.setState({ activeWorkspaceId: "nb-b" });
      mockCallSilent.mockResolvedValueOnce({ entries: [{ name: "파리", lat: 48.85, lng: 2.35 }] });
      expect(await loadRegionRegistry()).toEqual([{ name: "파리", lat: 48.85, lng: 2.35 }]);
      expect(mockCallSilent).toHaveBeenCalledTimes(2);

      // 같은 노트북에 머무는 동안은 다시 캐시.
      await loadRegionRegistry();
      expect(mockCallSilent).toHaveBeenCalledTimes(2);
    } finally {
      useSettingsStore.setState({ activeWorkspaceId: before });
    }
  });

  // 진행 중이던 조회가 무효화 **뒤에** 끝나면, 쓰기 이전 스냅샷을 캐시에 도로 심어 무효화를
  // 덮어쓰던 경합.
  it("an in-flight fetch that resolves after invalidate() does not repopulate the cache", async () => {
    const mockCallSilent = vi.mocked(callSilent);
    let resolveStale: (v: { entries: { name: string; lat: number; lng: number }[] }) => void;
    mockCallSilent.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    const stale = loadRegionRegistry();
    invalidateRegionRegistry(); // a region write landed while the fetch was in flight
    resolveStale!({ entries: [{ name: "옛값", lat: 1, lng: 1 }] });
    await stale;
    expect(getCachedRegionRegistry()).toBeNull();

    mockCallSilent.mockResolvedValueOnce({ entries: [{ name: "새값", lat: 2, lng: 2 }] });
    expect(await loadRegionRegistry()).toEqual([{ name: "새값", lat: 2, lng: 2 }]);
    expect(mockCallSilent).toHaveBeenCalledTimes(2);
  });
});
