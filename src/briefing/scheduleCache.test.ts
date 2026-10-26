import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/invoke", () => ({ call: vi.fn(), callSilent: vi.fn() }));

import { callSilent } from "../lib/invoke";
import { resetScheduleCache, scheduleMonth, scheduleRoutines } from "./scheduleCache";

describe("scheduleCache focus 무효화", () => {
  beforeEach(() => {
    resetScheduleCache();
    vi.mocked(callSilent).mockReset();
    vi.mocked(callSilent).mockImplementation(async (cmd: string) =>
      (cmd === "timeline_routine_list" ? { routines: [] } : { items: [] }) as never,
    );
  });

  it("포커스 복귀 시 반복 일정 캐시만 만료되고 월 캐시는 TTL 규칙 유지", async () => {
    await scheduleRoutines("w");
    await scheduleRoutines("w");
    await scheduleMonth("w", 2026, 10);
    await scheduleMonth("w", 2026, 10);
    expect(vi.mocked(callSilent)).toHaveBeenCalledTimes(2); // 둘 다 캐시 적중
    window.dispatchEvent(new Event("focus"));
    await scheduleRoutines("w"); // 다시 읽는다 — 오늘/내일/달력 카드가 같은 캐시를 본다
    await scheduleMonth("w", 2026, 10); // 월은 그대로 적중
    expect(vi.mocked(callSilent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callSilent).mock.calls[2][0]).toBe("timeline_routine_list");
  });
});
