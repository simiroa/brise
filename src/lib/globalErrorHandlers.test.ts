import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests exercise the real invoke.ts (marking) + globalErrorHandlers.ts (skip/dedupe) pair
// together — the whole point of W13's design is that the two files agree on the marker, so
// mocking either one away would hide exactly the bug this is meant to catch (see
// globalErrorHandlers.ts's header comment on the double-toast trap).
//
// window.addEventListener/removeEventListener are spied so the registered "unhandledrejection"/
// "error" callbacks can be invoked directly with a hand-built event object — jsdom's real
// unhandled-rejection detection is async/best-effort and would make these tests flaky for no
// benefit, since what's under test is the handler's own logic, not the browser's dispatch.

describe("globalErrorHandlers", () => {
  let handlers: Record<string, (event: unknown) => void>;
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    handlers = {};
    addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type: string, cb: unknown) => {
        handlers[type] = cb as (event: unknown) => void;
      });
    removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => {});
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  function mockNoTauri() {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
  }

  it("double-toast suppression: a call()-failure (already toasted by call() itself) is skipped", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn().mockRejectedValue({ code: "DB", message: "call boom" }),
    }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const { call, onAppNotice, onAppError } = await import("./invoke");
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    const toastSpy = vi.fn();
    const noticeSpy = vi.fn();
    onAppError(toastSpy);
    onAppNotice(noticeSpy);

    let caught: unknown;
    try {
      await call("cmd"); // pre-approved test fixture name, see commandNames.test.ts::TEST_FIXTURE_NAMES
    } catch (e) {
      caught = e;
    }
    // call() already toasted this via its own error channel.
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Simulate the rejection reaching the window as unhandled (e.g. a `void call(...)` site).
    handlers["unhandledrejection"]({ reason: caught });

    // The global hook must NOT fire its own notice for it — that would be a second toast for the
    // same failure.
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it("marker skip: a callSilent() failure (intentionally quiet) stays quiet", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn().mockRejectedValue({ code: "DB", message: "silent boom" }),
    }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const { callSilent, onAppNotice, onAppError } = await import("./invoke");
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    const toastSpy = vi.fn();
    const noticeSpy = vi.fn();
    onAppError(toastSpy);
    onAppNotice(noticeSpy);

    let caught: unknown;
    try {
      await callSilent("cmd"); // pre-approved test fixture name, see commandNames.test.ts::TEST_FIXTURE_NAMES
    } catch (e) {
      caught = e;
    }
    // callSilent() never toasts.
    expect(toastSpy).not.toHaveBeenCalled();

    handlers["unhandledrejection"]({ reason: caught });

    // The global hook must not make an intentionally-silent failure loud either.
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it("duplicate suppression: a genuinely unhandled rejection toasts once, and an identical repeat within the dedupe window is suppressed", async () => {
    mockNoTauri();
    const { onAppNotice } = await import("./invoke");
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    const noticeSpy = vi.fn();
    onAppNotice(noticeSpy);

    const err = new Error("render loop exploded");
    handlers["unhandledrejection"]({ reason: err });
    handlers["unhandledrejection"]({ reason: err }); // same message again, right away

    expect(noticeSpy).toHaveBeenCalledTimes(1);
    expect(String(noticeSpy.mock.calls[0][0])).toContain("render loop exploded");
  });

  it("also wires window 'error' (uncaught exceptions), not just unhandledrejection", async () => {
    mockNoTauri();
    const { onAppNotice } = await import("./invoke");
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    const noticeSpy = vi.fn();
    onAppNotice(noticeSpy);

    handlers["error"]({ error: new Error("sync throw outside any render") });

    expect(noticeSpy).toHaveBeenCalledTimes(1);
    expect(String(noticeSpy.mock.calls[0][0])).toContain("sync throw outside any render");
  });

  it("never calls preventDefault — the dev console must keep showing the raw error", async () => {
    mockNoTauri();
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    const preventDefault = vi.fn();
    handlers["unhandledrejection"]({ reason: new Error("whatever"), preventDefault });
    handlers["error"]({ error: new Error("whatever else"), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  // AUDIT-2026-09-26-fallback-observability.md §7 item 3: reportDiag is called after the
  // isErrorHandled early-return and the dedupe check, not before — these tests mock ./diag
  // (a separate module from invoke.ts, so the double-toast-trap tests above stay untouched).
  it("reports a genuinely unhandled rejection to the diag sink as feature=unhandled code=unhandled_rejection", async () => {
    mockNoTauri();
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    handlers["unhandledrejection"]({ reason: new Error("boom from a fire-and-forgotten promise") });

    expect(reportDiagMock).toHaveBeenCalledWith(
      "error",
      "unhandled",
      "unhandled_rejection",
      expect.stringContaining("boom from a fire-and-forgotten promise"),
    );
  });

  it("reports a window 'error' event as code=uncaught_error", async () => {
    mockNoTauri();
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    handlers["error"]({ error: new Error("sync throw") });

    expect(reportDiagMock).toHaveBeenCalledWith(
      "error",
      "unhandled",
      "uncaught_error",
      expect.stringContaining("sync throw"),
    );
  });

  it("does not re-report an already-handled call()/callSilent() failure here (invoke.ts already reported it under the command's own feature)", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn().mockRejectedValue({ code: "DB", message: "call boom" }),
    }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    const { call } = await import("./invoke");
    const { registerGlobalErrorHandlers } = await import("./globalErrorHandlers");
    registerGlobalErrorHandlers();

    let caught: unknown;
    try {
      await call("cmd"); // pre-approved test fixture name, see commandNames.test.ts::TEST_FIXTURE_NAMES
    } catch (e) {
      caught = e;
    }
    // call() itself already reported this (feature="cmd") via invoke.ts — isolate what
    // globalErrorHandlers does with the same rejection from here on.
    reportDiagMock.mockClear();

    handlers["unhandledrejection"]({ reason: caught });

    expect(reportDiagMock).not.toHaveBeenCalled();
  });
});
