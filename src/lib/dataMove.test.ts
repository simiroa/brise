import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDataMove, useDataMoveStore } from "./dataMove";

const callMock = vi.fn();
const flushAllMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: (...args: unknown[]) => flushAllMock(...args),
}));

describe("runDataMove", () => {
  beforeEach(() => {
    callMock.mockReset();
    flushAllMock.mockReset().mockResolvedValue(undefined);
    useDataMoveStore.setState({ moving: false });
  });

  it("flushes pending saves before applying, and sets moving while it runs", async () => {
    const order: string[] = [];
    flushAllMock.mockImplementation(async () => {
      order.push("flush");
    });
    let sawMovingDuringApply = false;
    callMock.mockImplementation(async () => {
      order.push("apply");
      sawMovingDuringApply = useDataMoveStore.getState().moving;
      // 성공 시엔 재시작이 대신하므로 이 프라미스는 여기서 그냥 끝난다(실제로는 resolve 하지 않음).
      return { split: false, restart_required: true };
    });

    await runDataMove("/new/location");

    expect(order).toEqual(["flush", "apply"]);
    expect(callMock).toHaveBeenCalledWith("data_location_apply", { path: "/new/location" });
    expect(sawMovingDuringApply).toBe(true);
    // 성공 뒤에도 moving 은 내려가지 않는다 — 재시작이 대신 끝낸다.
    expect(useDataMoveStore.getState().moving).toBe(true);
  });

  it("clears the moving flag and rethrows on failure", async () => {
    callMock.mockRejectedValueOnce(new Error("boom"));

    await expect(runDataMove("/new/location")).rejects.toThrow("boom");
    expect(useDataMoveStore.getState().moving).toBe(false);
  });

  // 인앱 설정(같은 창)에서는 요청이 window·Tauri 두 채널로 함께 온다 — 이동은 한 번만.
  it("ignores a second request while a move is already running", async () => {
    let finishApply: () => void = () => {};
    callMock.mockImplementation(() => new Promise<void>((r) => (finishApply = r)));
    const first = runDataMove("D:/a");
    const second = runDataMove("D:/a");
    await second;
    await Promise.resolve();
    finishApply();
    await first;
    expect(flushAllMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it("a failing flush clears the moving flag", async () => {
    flushAllMock.mockRejectedValue(new Error("flush"));
    await expect(runDataMove("D:/a")).rejects.toThrow("flush");
    expect(useDataMoveStore.getState().moving).toBe(false);
    expect(callMock).not.toHaveBeenCalled();
  });
});
