import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useLocalImport, type LocalCandidate } from "./useLocalImport";
import type { CollectSource } from "../../../lib/commands.gen";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

const cand = (key: string, source_id: string | null): LocalCandidate => ({
  key,
  kind: "claude_prompts",
  label: key,
  detail: "",
  recent_count: 1,
  last_seen_at: null,
  source_id,
  config: "{}",
});

const created = { id: "created-1", kind: "claude_prompts", name: "Claude prompts" } as unknown as CollectSource;

describe("useLocalImport", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
  });

  it("감지 전에는 detectDone=false, 감지하면 source_id 가 없는 후보만 유령 행으로 남긴다", async () => {
    callMock.mockResolvedValue({ candidates: [cand("a", null), cand("b", "existing"), cand("c", null)] });
    const { result } = renderHook(() => useLocalImport(vi.fn()));
    expect(result.current.detectDone).toBe(false);
    expect(result.current.ghostCandidates).toEqual([]);

    await act(() => result.current.detectLocal());

    expect(callMock).toHaveBeenCalledWith("collect_detect_local", {});
    expect(result.current.detectDone).toBe(true);
    expect(result.current.ghostCandidates.map((c) => c.key)).toEqual(["a", "c"]);
    expect(result.current.detecting).toBe(false);
  });

  it("감지가 실패하면 detectDone 은 그대로 false 이고 detecting 만 풀린다", async () => {
    callMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useLocalImport(vi.fn()));

    await act(() => result.current.detectLocal());

    expect(result.current.detectDone).toBe(false);
    expect(result.current.detecting).toBe(false);
  });

  it("dropCandidate 는 그 키의 유령 행만 지운다", async () => {
    callMock.mockResolvedValue({ candidates: [cand("a", null), cand("c", null)] });
    const { result } = renderHook(() => useLocalImport(vi.fn()));
    await act(() => result.current.detectLocal());

    act(() => result.current.dropCandidate("a"));

    expect(result.current.ghostCandidates.map((c) => c.key)).toEqual(["c"]);
  });

  it("importCandidate 는 소스를 만든 뒤 confirm 모드(키 동봉)로 드라이런을 연다", async () => {
    callMock.mockResolvedValue(created);
    const runDryRun = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useLocalImport(runDryRun));

    await act(() => result.current.importCandidate(cand("claude_prompts", null)));

    expect(callMock).toHaveBeenCalledWith("collect_import_local", { key: "claude_prompts" });
    expect(runDryRun).toHaveBeenCalledWith(created, "claude_prompts");
    expect(result.current.importingKey).toBeNull();
  });

  it("소스 생성이 실패하면 드라이런을 열지 않고 importingKey 를 푼다", async () => {
    callMock.mockRejectedValue(new Error("nope"));
    const runDryRun = vi.fn();
    const { result } = renderHook(() => useLocalImport(runDryRun));

    await act(() => result.current.importCandidate(cand("k", null)));

    expect(runDryRun).not.toHaveBeenCalled();
    expect(result.current.importingKey).toBeNull();
  });

  it("가져오는 동안 importingKey 가 잡히고, 그 사이 두 번째 가져오기는 무시된다", async () => {
    let resolveImport: (v: CollectSource) => void = () => {};
    callMock.mockImplementation(() => new Promise<CollectSource>((r) => { resolveImport = r; }));
    const runDryRun = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useLocalImport(runDryRun));

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.importCandidate(cand("k1", null));
    });
    await waitFor(() => expect(result.current.importingKey).toBe("k1"));

    await act(() => result.current.importCandidate(cand("k2", null)));
    expect(callMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveImport(created);
      await first;
    });
    expect(result.current.importingKey).toBeNull();
  });
});
