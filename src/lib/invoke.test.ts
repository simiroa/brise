import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>;

describe("closeActionForLabel", () => {
  it("routes main to the geometry-save + window_close_confirmed flow", async () => {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const { closeActionForLabel } = await import("./invoke");
    expect(closeActionForLabel("main")).toBe("main-flow");
  });

  it("routes every non-main label (pet/pet-bubble/settings/...) to hide", async () => {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const { closeActionForLabel } = await import("./invoke");
    for (const label of ["pet", "pet-bubble", "settings", "activity", "ai-history"]) {
      expect(closeActionForLabel(label)).toBe("hide");
    }
  });
});

describe("invoke.ts — window close", () => {
  let invokeMock: (...args: unknown[]) => Promise<unknown>;
  let closeHandler: CloseHandler | null;
  let winMock: {
    label: string;
    onCloseRequested: (cb: CloseHandler) => Promise<() => void>;
    outerPosition: () => Promise<{ x: number; y: number }>;
    outerSize: () => Promise<{ width: number; height: number }>;
    isMaximized: () => Promise<boolean>;
    hide: () => Promise<void>;
    destroy: () => Promise<void>;
  };

  beforeEach(() => {
    vi.resetModules();
    invokeMock = vi.fn().mockResolvedValue({});
    closeHandler = null;
    winMock = {
      label: "main",
      onCloseRequested: (cb: CloseHandler) => {
        closeHandler = cb;
        return Promise.resolve(() => {});
      },
      outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      outerSize: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
      isMaximized: vi.fn().mockResolvedValue(false),
      hide: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (...args: unknown[]) => invokeMock(...args),
    }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => winMock,
    }));
  });

  it("registers close handler and flushes on close", async () => {
    await import("./invoke");
    await Promise.resolve();
    expect(closeHandler).not.toBeNull();
    await closeHandler!({ preventDefault: () => {} });
  });

  it("main label: saves geometry then calls window_close_confirmed, never hide()", async () => {
    winMock.label = "main";
    await import("./invoke");
    await Promise.resolve();
    await closeHandler!({ preventDefault: () => {} });
    expect(winMock.outerPosition).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("window_close_confirmed", undefined);
    expect(winMock.hide).not.toHaveBeenCalled();
  });

  it("aux label (settings/pet/...): hides without touching window_geometry or window_close_confirmed", async () => {
    winMock.label = "settings";
    await import("./invoke");
    await Promise.resolve();
    await closeHandler!({ preventDefault: () => {} });
    expect(winMock.hide).toHaveBeenCalledTimes(1);
    expect(winMock.outerPosition).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("window_close_confirmed", undefined);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: expect.objectContaining({ window_geometry: expect.anything() }) }),
    );
  });

  it("section window (section-<id>): flushes pending saves, THEN destroys — never hides", async () => {
    winMock.label = "section-abc";
    const { registerFlush } = await import("./invoke");
    const order: string[] = [];
    registerFlush(async () => {
      order.push("flush");
    });
    (winMock.destroy as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("destroy");
    });
    await Promise.resolve();
    await closeHandler!({ preventDefault: () => {} });
    expect(order).toEqual(["flush", "destroy"]);
    expect(winMock.hide).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("window_close_confirmed", undefined);
  });
});

describe("invoke.ts — flushAll (Bug fix: one rejecting flush wedged onCloseRequested/selectNote)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves and still runs remaining callbacks when an earlier callback rejects", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const { registerFlush, flushAll } = await import("./invoke");

    const second = vi.fn().mockResolvedValue(undefined);
    registerFlush(() => Promise.reject(new Error("note_create failed")));
    registerFlush(second);

    await expect(flushAll()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("also reports the rejected flush to the diag sink (AUDIT-2026-09-26 §7.2 G2)", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { registerFlush, flushAll } = await import("./invoke");

    registerFlush(() => Promise.reject(new Error("note_create failed")));
    await flushAll();

    expect(reportDiagMock).toHaveBeenCalledWith("error", "flush", "flush_rejected", "note_create failed");
  });
});

describe("invoke.ts — diag reporting (logError -> reportDiag, AUDIT-2026-09-26 §7.2 G2)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockNoTauriTransport(rejection: unknown) {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(rejection) }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
  }

  it('call() failure reports level "error" with the command name as feature and the AppError code/message', async () => {
    mockNoTauriTransport({ code: "DB", message: "call boom" });
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await import("./invoke");

    await expect(call("note_get")).rejects.toMatchObject({ code: "DB" });

    expect(reportDiagMock).toHaveBeenCalledWith("error", "note_get", "DB", "call boom");
    // scripts/smoke.mjs matches /^\[brise\]\s/ — changing this prefix silently kills the smoke gate.
    expect(consoleSpy.mock.calls[0][0]).toMatch(/^\[brise\]/);
  });

  it('callSilent() failure reports level "warn" (same cmd/code/message shape as call())', async () => {
    mockNoTauriTransport({ code: "VALIDATION", message: "silent boom" });
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { callSilent } = await import("./invoke");

    await expect(callSilent("settings_set")).rejects.toMatchObject({ code: "VALIDATION" });

    expect(reportDiagMock).toHaveBeenCalledWith("warn", "settings_set", "VALIDATION", "silent boom");
    expect(consoleSpy.mock.calls[0][0]).toMatch(/^\[brise\]/);
  });

  it('falls back to code "unknown" when the rejection has no AppError-shaped code', async () => {
    mockNoTauriTransport({ message: "weird failure, no code field" });
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { callSilent } = await import("./invoke");

    await expect(callSilent("cmd")).rejects.toBeTruthy(); // "cmd" = pre-approved test fixture name, see commandNames.test.ts::TEST_FIXTURE_NAMES

    expect(reportDiagMock).toHaveBeenCalledWith("warn", "cmd", "unknown", "weird failure, no code field");
  });

  // AUDIT-2026-09-26 리뷰: Tauri 는 커맨드 본문에 닿기 전 실패(인자 역직렬화·창 허용 목록)를 **문자열**로
  // 거절한다 — D1 이 정확히 이 경로였다. 진단에는 그 문자열이 남아야 하고, 호출자는 예전과 같은 값을 받는다.
  it("records a bare-string rejection's text (the D1 path) and still rethrows the original string", async () => {
    const reason = "invalid args `provider` for command `ai_generate_from_prompt`: missing field `provider`";
    mockNoTauriTransport(reason);
    const reportDiagMock = vi.fn();
    vi.doMock("./diag", () => ({ reportDiag: reportDiagMock }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { callSilent } = await import("./invoke");

    await expect(callSilent("cmd")).rejects.toBe(reason);

    expect(reportDiagMock).toHaveBeenCalledWith("warn", "cmd", "VALIDATION", reason);
  });
});

describe("invoke.ts — settings_get_all 동시 호출 합치기", () => {
  async function setup() {
    vi.resetModules();
    const resolvers: Array<(v: unknown) => void> = [];
    const invoke = vi.fn((cmd: string) =>
      cmd === "settings_get_all" ? new Promise((r) => resolvers.push(r)) : Promise.resolve({ ok: true }),
    );
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
    const mod = await import("./invoke");
    return { ...mod, invoke, resolvers };
  }

  it("동시에 진행 중인 읽기는 한 번만 보내고, 호출자마다 사본을 준다", async () => {
    const { call, callSilent, invoke, resolvers } = await setup();
    const a = call<{ settings: { x: number } }>("settings_get_all");
    const b = callSilent<{ settings: { x: number } }>("settings_get_all");
    expect(invoke.mock.calls.filter(([c]) => c === "settings_get_all")).toHaveLength(1);
    resolvers[0]({ settings: { x: 1 } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ settings: { x: 1 } });
    ra.settings.x = 2;
    expect(rb.settings.x).toBe(1);
  });

  it("끝난 읽기는 캐시하지 않는다 — 다음 읽기는 다시 보낸다", async () => {
    const { call, invoke, resolvers } = await setup();
    const a = call("settings_get_all");
    resolvers[0]({ settings: {} });
    await a;
    void call("settings_get_all");
    expect(invoke.mock.calls.filter(([c]) => c === "settings_get_all")).toHaveLength(2);
  });

  it("쓰기(settings_set)가 나가면 그 뒤 읽기는 진행 중인 옛 읽기에 합쳐지지 않는다", async () => {
    const { call, invoke } = await setup();
    void call("settings_get_all");
    await call("settings_set", { entries: { theme: "dark" } });
    void call("settings_get_all");
    expect(invoke.mock.calls.filter(([c]) => c === "settings_get_all")).toHaveLength(2);
  });
});
