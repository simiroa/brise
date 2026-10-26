import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

let windowLabel = "main";
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel }),
}));

const mockIsBrowser = vi.fn().mockReturnValue(false);
const mockIsTauri = vi.fn().mockReturnValue(false);
vi.mock("./env", () => ({
  isBrowser: () => mockIsBrowser(),
  isTauri: () => mockIsTauri(),
}));

const mockHttpInvoke = vi.fn();
vi.mock("./httpBridge", () => ({
  httpInvoke: (...args: unknown[]) => mockHttpInvoke(...args),
}));

// diag.ts keeps module-level dedupe/rate-limit state — vi.resetModules() + a fresh dynamic
// import per test gives every test its own instance (same pattern as updater.test.ts).
async function freshDiag() {
  return import("./diag");
}

describe("diag.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    windowLabel = "main";
    mockInvoke.mockReset().mockResolvedValue({ ok: true });
    mockHttpInvoke.mockReset().mockResolvedValue({ ok: true });
    mockIsBrowser.mockReset().mockReturnValue(false);
    mockIsTauri.mockReset().mockReturnValue(false);
  });

  // ── never throws, no backend reachable (jsdom/vitest default: no Tauri, no browser token) ──
  it("never throws in jsdom when neither Tauri nor browser mode is available", async () => {
    const { reportDiag, reportFallback } = await freshDiag();
    expect(() => reportDiag("error", "feat", "code", "boom")).not.toThrow();
    expect(() => reportFallback("feat", "code", "detail")).not.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockHttpInvoke).not.toHaveBeenCalled();
  });

  it("never throws even if invoke() rejects", async () => {
    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockRejectedValue(new Error("backend down"));
    const { reportDiag } = await freshDiag();
    expect(() => reportDiag("error", "feat", "code", "boom")).not.toThrow();
  });

  it("never calls console.* about its own failure", async () => {
    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockRejectedValue(new Error("backend down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { reportDiag, reportFallback } = await freshDiag();
    reportDiag("error", "feat", "code", "boom");
    reportFallback("feat2", "code2", "detail");
    // Let the rejected invoke()'s .catch() microtask actually run before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  // ── routes to the right transport ────────────────────────────────────────────────────────
  it("calls raw invoke('diag_record', ...) in Tauri mode, attaching the window label as source", async () => {
    mockIsTauri.mockReturnValue(true);
    windowLabel = "settings";
    const { reportDiag } = await freshDiag();

    reportDiag("warn", "my-feature", "my-code", "something fell back");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("diag_record", {
      source: "settings",
      feature: "my-feature",
      code: "my-code",
      level: "warn",
      message: "something fell back",
    });
    expect(mockHttpInvoke).not.toHaveBeenCalled();
  });

  it("routes through httpInvoke with source \"browser\" in browser mode", async () => {
    mockIsBrowser.mockReturnValue(true);
    const { reportDiag } = await freshDiag();

    reportDiag("info", "feat", "code", "msg");

    expect(mockHttpInvoke).toHaveBeenCalledTimes(1);
    expect(mockHttpInvoke).toHaveBeenCalledWith("diag_record", expect.objectContaining({ source: "browser" }));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("reportFallback() reports at warn level with an empty message when detail is omitted", async () => {
    mockIsTauri.mockReturnValue(true);
    const { reportFallback } = await freshDiag();

    reportFallback("feat", "code");

    expect(mockInvoke).toHaveBeenCalledWith(
      "diag_record",
      expect.objectContaining({ level: "warn", message: "" }),
    );
  });

  // ── client-side dedupe (4s) ──────────────────────────────────────────────────────────────
  it("drops a repeat of the same (feature, code, level) within 4s", async () => {
    mockIsTauri.mockReturnValue(true);
    const nowSpy = vi.spyOn(Date, "now");
    const { reportDiag } = await freshDiag();

    nowSpy.mockReturnValue(1_000);
    reportDiag("warn", "feat", "code", "first");
    nowSpy.mockReturnValue(1_000 + 3_999);
    reportDiag("warn", "feat", "code", "second"); // within 4s — dropped

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("does not drop the same key once 4s have passed", async () => {
    mockIsTauri.mockReturnValue(true);
    const nowSpy = vi.spyOn(Date, "now");
    const { reportDiag } = await freshDiag();

    nowSpy.mockReturnValue(1_000);
    reportDiag("warn", "feat", "code", "first");
    nowSpy.mockReturnValue(1_000 + 4_001);
    reportDiag("warn", "feat", "code", "second");

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("does not dedupe across different feature/code/level keys", async () => {
    mockIsTauri.mockReturnValue(true);
    const { reportDiag } = await freshDiag();

    reportDiag("warn", "feat-a", "code-a", "msg");
    reportDiag("warn", "feat-b", "code-a", "msg");
    reportDiag("error", "feat-a", "code-a", "msg");

    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  // ── client-side rate cap (~30/minute) ────────────────────────────────────────────────────
  it("caps at 30 reports per minute per module instance, then drops the rest", async () => {
    mockIsTauri.mockReturnValue(true);
    const { reportDiag } = await freshDiag();

    for (let i = 0; i < 40; i++) {
      // Distinct codes so the 4s dedupe never kicks in — isolates the rate cap.
      reportDiag("info", "feat", `code-${i}`, "msg");
    }

    expect(mockInvoke).toHaveBeenCalledTimes(30);
  });

  it("resets the rate cap after the window passes", async () => {
    mockIsTauri.mockReturnValue(true);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const { reportDiag } = await freshDiag();

    for (let i = 0; i < 30; i++) reportDiag("info", "feat", `code-${i}`, "msg");
    expect(mockInvoke).toHaveBeenCalledTimes(30);

    reportDiag("info", "feat", "code-over-cap", "msg");
    expect(mockInvoke).toHaveBeenCalledTimes(30); // still capped

    nowSpy.mockReturnValue(60_001);
    reportDiag("info", "feat", "code-next-window", "msg");
    expect(mockInvoke).toHaveBeenCalledTimes(31);

    nowSpy.mockRestore();
  });

  // ── message truncation ───────────────────────────────────────────────────────────────────
  it("truncates an overly long message before sending", async () => {
    mockIsTauri.mockReturnValue(true);
    const { reportDiag } = await freshDiag();
    const long = "x".repeat(500);

    reportDiag("error", "feat", "code", long);

    const sentArgs = mockInvoke.mock.calls[0][1] as { message: string };
    expect(sentArgs.message.length).toBe(300);
  });

  // ── does not fall into the "no backend reachable" case just because getCurrentWindow throws ──
  it("falls back to source \"unknown\" if getCurrentWindow() throws, without crashing", async () => {
    mockIsTauri.mockReturnValue(true);
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    vi.resetModules();
    const { reportDiag } = await freshDiag();

    expect(() => reportDiag("error", "feat", "code", "msg")).not.toThrow();
    expect(mockInvoke).toHaveBeenCalledWith("diag_record", expect.objectContaining({ source: "unknown" }));
  });
});

// 펫 캐릭터 창(#/pet) 전용 — i18n 없이 진단만 보내는 전역 핸들러.
describe("registerDiagOnlyErrorHandlers", () => {
  beforeEach(() => {
    vi.resetModules();
    // 위 "getCurrentWindow() throws" 테스트의 vi.doMock 은 resetModules 뒤에도 남는다 — 되돌린다.
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({ label: windowLabel }),
    }));
    windowLabel = "pet";
    mockInvoke.mockReset().mockResolvedValue({ ok: true });
    mockIsBrowser.mockReset().mockReturnValue(false);
    mockIsTauri.mockReset().mockReturnValue(true);
  });

  function rejection(reason: unknown): PromiseRejectionEvent {
    const ev = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(ev, "reason", { value: reason });
    return ev;
  }

  it("reports an unhandled rejection and an uncaught error to the sink, then unregisters", async () => {
    const { registerDiagOnlyErrorHandlers } = await freshDiag();
    const off = registerDiagOnlyErrorHandlers();

    window.dispatchEvent(rejection(new Error("sprite load blew up")));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("render loop"), message: "render loop" }));

    expect(mockInvoke).toHaveBeenCalledWith("diag_record", expect.objectContaining({
      source: "pet", feature: "unhandled", code: "unhandled_rejection", level: "error", message: "sprite load blew up",
    }));
    expect(mockInvoke).toHaveBeenCalledWith("diag_record", expect.objectContaining({
      code: "uncaught_error", message: "render loop",
    }));

    off();
    mockInvoke.mockClear();
    window.dispatchEvent(rejection(new Error("after unregister")));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("skips failures invoke.ts already recorded (same global handled marker, no invoke.ts import)", async () => {
    const { registerDiagOnlyErrorHandlers } = await freshDiag();
    const off = registerDiagOnlyErrorHandlers();

    const handled = { code: "DB", message: "already logged by callSilent" };
    Object.defineProperty(handled, Symbol.for("brise.errorAlreadyHandled"), { value: true });
    window.dispatchEvent(rejection(handled));

    expect(mockInvoke).not.toHaveBeenCalled();
    off();
  });
});

describe("diag.ts does not import lib/invoke.ts (circularity guard)", () => {
  it("has no import of ./invoke in its own source", () => {
    const src = readFileSync("src/lib/diag.ts", "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/invoke["']/);
    expect(src).not.toMatch(/\brequire\(\s*["']\.\/invoke["']\s*\)/);
  });
});
