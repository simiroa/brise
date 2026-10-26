import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reportMock = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportMock(...a) }));

import { runBriefingHooks, HOOK_TIMEOUT_MS, type BriefingHook } from "./automationHooks";

const ctx = { kind: "morning" as const, day: "2026-10-01" };

describe("runBriefingHooks", () => {
  beforeEach(() => reportMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it("is a no-op with the default (empty) registry", async () => {
    await expect(runBriefingHooks("before_show", ctx)).resolves.toBeUndefined();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("runs only hooks of the requested phase, in order", async () => {
    const calls: string[] = [];
    const hooks: BriefingHook[] = [
      { id: "a", phase: "before_show", run: () => void calls.push("a") },
      { id: "b", phase: "after_show", run: () => void calls.push("b") },
      { id: "c", phase: "before_show", run: async () => void calls.push("c") },
    ];
    await runBriefingHooks("before_show", ctx, hooks);
    expect(calls).toEqual(["a", "c"]);
  });

  it("a throwing hook is reported and does not stop the next one", async () => {
    const after = vi.fn();
    await runBriefingHooks("after_show", ctx, [
      { id: "boom", phase: "after_show", run: () => { throw new Error("x"); } },
      { id: "ok", phase: "after_show", run: after },
    ]);
    expect(reportMock).toHaveBeenCalledWith("briefing", "hook_failed", "boom:after_show:x");
    expect(after).toHaveBeenCalled();
  });

  it("a hanging hook is cut off at the timeout", async () => {
    vi.useFakeTimers();
    const p = runBriefingHooks("before_show", ctx, [{ id: "hang", phase: "before_show", run: () => new Promise(() => {}) }]);
    await vi.advanceTimersByTimeAsync(HOOK_TIMEOUT_MS + 1);
    await p;
    expect(reportMock).toHaveBeenCalledWith("briefing", "hook_failed", "hang:before_show:timeout");
  });
});
