import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/settings";
import { runCollectDetectOnce, __resetCollectDetectOnceForTest } from "./collectDetectOnce";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

describe("runCollectDetectOnce (PLAN-2026-09-04-local-import §3b)", () => {
  beforeEach(() => {
    __resetCollectDetectOnceForTest();
    callMock.mockReset().mockResolvedValue({});
    callSilentMock.mockReset();
    useSettingsStore.setState({ collectDetectSeen: false, collectDetectPending: 0 } as any);
  });

  it("does nothing when collect_detect_seen is already true", async () => {
    useSettingsStore.setState({ collectDetectSeen: true } as any);

    await runCollectDetectOnce();

    expect(callSilentMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().collectDetectPending).toBe(0);
  });

  it("detects and saves the count of source_id-less candidates when seen is false", async () => {
    callSilentMock.mockResolvedValue({
      candidates: [{ source_id: null }, { source_id: null }, { source_id: "existing-source" }],
    });

    await runCollectDetectOnce();

    expect(callSilentMock).toHaveBeenCalledWith("collect_detect_local", {});
    expect(useSettingsStore.getState().collectDetectPending).toBe(2);
  });

  it("saves nothing when collect_detect_local rejects", async () => {
    callSilentMock.mockRejectedValue(new Error("boom"));

    await runCollectDetectOnce();

    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    expect(useSettingsStore.getState().collectDetectPending).toBe(0);
  });

  it("only ever calls detect once per module lifetime, even across repeated calls", async () => {
    callSilentMock.mockResolvedValue({ candidates: [] });

    await runCollectDetectOnce();
    callSilentMock.mockClear();
    await runCollectDetectOnce();

    expect(callSilentMock).not.toHaveBeenCalled();
  });
});
