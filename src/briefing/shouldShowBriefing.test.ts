import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldShowBriefing, localDayOf, type BriefingAutoSettings } from "./shouldShowBriefing";

const base: BriefingAutoSettings = { enabled: true, when: "time", time: "08:00", lastShown: "" };
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("shouldShowBriefing", () => {
  const cases: [string, Date, Partial<BriefingAutoSettings>, "launch" | "tick", boolean][] = [
    ["disabled", at(2026, 9, 30, 9), { enabled: false }, "tick", false],
    ["manual", at(2026, 9, 30, 9), { when: "manual" }, "launch", false],
    ["already shown today", at(2026, 9, 30, 9), { lastShown: "2026-09-30" }, "tick", false],
    ["shown yesterday -> shows", at(2026, 9, 30, 9), { lastShown: "2026-09-29" }, "tick", true],
    ["launch mode on launch", at(2026, 9, 30, 3), { when: "launch" }, "launch", true],
    ["launch mode on tick", at(2026, 9, 30, 9), { when: "launch" }, "tick", false],
    ["time: before target", at(2026, 9, 30, 7, 59), {}, "tick", false],
    ["time: exactly target", at(2026, 9, 30, 8, 0), {}, "tick", true],
    ["time: missed, late launch", at(2026, 9, 30, 13), {}, "launch", true],
    ["time: early launch before target", at(2026, 9, 30, 6), {}, "launch", false],
    ["time: bad format", at(2026, 9, 30, 9), { time: "25:99" }, "tick", false],
    ["time: 00:00 target at midnight", at(2026, 10, 1, 0, 0), { time: "00:00" }, "tick", true],
    ["time: 23:59 target, 23:58 no", at(2026, 9, 30, 23, 58), { time: "23:59" }, "tick", false],
    ["midnight rollover resets lastShown", at(2026, 10, 1, 8, 0), { lastShown: "2026-09-30" }, "tick", true],
  ];
  it.each(cases)("%s", (_n, now, over, trig, want) => {
    expect(shouldShowBriefing(now, { ...base, ...over }, trig)).toBe(want);
  });

  describe("evening", () => {
    const ev: BriefingAutoSettings = { ...base, eveningEnabled: true, eveningTime: "21:00", lastShownEvening: "" };
    const eveCases: [string, Date, Partial<BriefingAutoSettings>, boolean][] = [
      ["before time", at(2026, 9, 30, 20, 59), {}, false],
      ["exactly time", at(2026, 9, 30, 21, 0), {}, true],
      ["late but inside grace (23:59 = 21:00+3h-1)", at(2026, 9, 30, 23, 59), {}, true],
      ["launch 3h after -> skipped", at(2026, 9, 30, 23, 59), { eveningTime: "20:59" }, false],
      ["exactly +3h -> skipped", at(2026, 10, 1, 0, 0), { eveningTime: "21:00" }, false],
      ["already shown today", at(2026, 9, 30, 21, 5), { lastShownEvening: "2026-09-30" }, false],
      ["shown yesterday", at(2026, 9, 30, 21, 5), { lastShownEvening: "2026-09-29" }, true],
      ["evening off", at(2026, 9, 30, 21, 5), { eveningEnabled: false }, false],
      ["briefing disabled", at(2026, 9, 30, 21, 5), { enabled: false }, false],
      ["independent of when=manual", at(2026, 9, 30, 21, 5), { when: "manual" }, true],
      ["morning lastShown does not block", at(2026, 9, 30, 21, 5), { lastShown: "2026-09-30" }, true],
      ["midnight target: 23:30 + grace ends at midnight", at(2026, 10, 1, 0, 10), { eveningTime: "23:30" }, false],
      ["23:30 target at 23:45", at(2026, 9, 30, 23, 45), { eveningTime: "23:30" }, true],
      ["bad time", at(2026, 9, 30, 22, 0), { eveningTime: "25:00" }, false],
    ];
    it.each(eveCases)("%s", (_n, now, over, want) => {
      expect(shouldShowBriefing(now, { ...ev, ...over }, "tick", "evening")).toBe(want);
    });
    it("morning kind ignores evening fields", () => {
      expect(shouldShowBriefing(at(2026, 9, 30, 9), ev, "tick", "morning")).toBe(true);
    });
  });

  it("localDayOf uses local calendar day, zero padded", () => {
    expect(localDayOf(at(2026, 1, 5, 23, 59))).toBe("2026-01-05");
    expect(localDayOf(at(2026, 12, 31, 0, 0))).toBe("2026-12-31");
  });
});

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({ call: (...a: unknown[]) => callMock(...a), callSilent: (...a: unknown[]) => callMock(...a) }));
vi.mock("../lib/env", () => ({ isBrowser: () => false }));

describe("runBriefingAutoShow", () => {
  beforeEach(() => {
    vi.resetModules();
    callMock.mockReset();
  });

  async function setup(over: Record<string, unknown> = {}) {
    const { useSettingsStore } = await import("../stores/settings");
    const setLast = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({
      loaded: true,
      briefingEnabled: true,
      briefingWhen: "time",
      briefingTime: "08:00",
      briefingLastShown: "",
      setBriefingLastShown: setLast,
      ...over,
    } as never);
    const { runBriefingAutoShow } = await import("./useBriefingAutoShow");
    return { run: runBriefingAutoShow, setLast };
  }

  it("opens once, saves lastShown after open, and does not retry the same day", async () => {
    callMock.mockResolvedValue(undefined);
    const { run, setLast } = await setup();
    await run(at(2026, 9, 30, 9), "tick");
    await run(at(2026, 9, 30, 9, 1), "tick");
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("briefing_window_open", {});
    expect(setLast).toHaveBeenCalledWith("2026-09-30");
  });

  it("failure: no lastShown save, no retry this session", async () => {
    callMock.mockRejectedValue(new Error("x"));
    const { run, setLast } = await setup();
    await run(at(2026, 9, 30, 9), "tick");
    await run(at(2026, 9, 30, 9, 1), "tick");
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(setLast).not.toHaveBeenCalled();
  });

  it("evening: opens in recap mode, saves lastShownEvening, and wins over a due morning", async () => {
    callMock.mockResolvedValue(undefined);
    const setEve = vi.fn().mockResolvedValue(undefined);
    const { run, setLast } = await setup({
      briefingEveningEnabled: true,
      briefingEveningTime: "21:00",
      setBriefingLastShownEvening: setEve,
    });
    await run(at(2026, 9, 30, 21, 5), "launch");
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("briefing_window_open", { mode: "recap" });
    expect(setEve).toHaveBeenCalledWith("2026-09-30");
    expect(setLast).toHaveBeenCalledWith("2026-09-30"); // 아침은 소진
    await run(at(2026, 9, 30, 21, 6), "tick");
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it("os-only with app notifications suppressed falls back to the window", async () => {
    callMock.mockImplementation(async (name: string) => (name === "notify_send" ? { ok: false } : undefined));
    const { run, setLast } = await setup({ briefingNotify: "os", activeWorkspaceId: "ws1" });
    await run(at(2026, 9, 30, 9), "tick");
    expect(callMock).toHaveBeenCalledWith("briefing_window_open", {});
    expect(setLast).toHaveBeenCalledWith("2026-09-30");
  });

  it("does nothing before settings are loaded", async () => {
    const { run } = await setup({ loaded: false });
    await run(at(2026, 9, 30, 9), "launch");
    expect(callMock).not.toHaveBeenCalled();
  });
});
