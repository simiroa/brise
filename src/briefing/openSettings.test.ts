import { describe, it, expect, vi, beforeEach } from "vitest";

// 플레인 함수 목: vi.fn 은 반환 promise 에 내부 핸들러를 붙여, 우리가 catch 한 거절이 미처리로 보고된다.
const calls = vi.hoisted(() => ({ args: [] as unknown[][], fail: false }));
vi.mock("../lib/invoke", () => ({
  call: async (...a: unknown[]) => {
    calls.args.push(a);
    if (calls.fail) throw new Error("x");
  },
  callSilent: vi.fn(),
}));
vi.mock("../lib/env", () => ({ isBrowser: () => false }));

import { openBriefingSettings, SETTINGS_TARGETS } from "./openSettings";

describe("openBriefingSettings", () => {
  beforeEach(() => {
    calls.args = [];
    calls.fail = false;
  });

  it("키를 page/anchor 인자로 매핑한다", async () => {
    await openBriefingSettings("habits");
    expect(calls.args[0]).toEqual(["settings_window_open", { page: "briefing", anchor: "habits_add" }]);
    await openBriefingSettings("ai");
    expect(calls.args[1]).toEqual(["settings_window_open", { page: "ai", anchor: undefined }]);
    expect(SETTINGS_TARGETS.weather).toEqual({ page: "view", anchor: "weather" });
  });

  it("call 실패는 삼킨다(토스트는 call 이 이미 띄움)", async () => {
    calls.fail = true;
    await expect(openBriefingSettings("collect")).resolves.toBeUndefined();
    expect(calls.args).toHaveLength(1);
  });
});
