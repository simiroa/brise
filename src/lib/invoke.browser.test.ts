import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * call()/callSilent() (invoke.ts) must route over HTTP instead of Tauri IPC once isBrowser() is
 * true (no __TAURI_INTERNALS__ + a sync-server token in sessionStorage — see env.ts). This is the
 * integration point the whole browser-mode bridge hangs off: every existing caller keeps calling
 * call("cmd", args) unchanged, only the transport underneath switches. No real server exists yet
 * (backend agent mid-flight this wave) — fetch is mocked against the agreed contract
 * (POST /api/v1/invoke {"cmd","args"} → result, {"error"} + 400/404/500 on failure).
 */

describe("call()/callSilent() — browser-mode HTTP routing", () => {
  let invokeMock: (...args: unknown[]) => Promise<unknown>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    invokeMock = vi.fn().mockResolvedValue({ tauri: true });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => {
        throw new Error("not running under Tauri");
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("with a browser token present, routes through fetch (not the Tauri invoke) with the bearer header", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-xyz");
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ notes: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { call } = await import("./invoke");
    const result = await call<{ notes: unknown[] }>("notes_tree", { workspace_id: "w1" });

    expect(result).toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/invoke",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok-xyz" }),
        body: JSON.stringify({ cmd: "notes_tree", args: { workspace_id: "w1" } }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("with no browser token (the existing test/desktop shape), keeps routing through the Tauri invoke unchanged", async () => {
    const { call } = await import("./invoke");
    const result = await call<{ tauri: boolean }>("notes_tree", {});
    expect(result).toEqual({ tauri: true });
    expect(invokeMock).toHaveBeenCalledWith("notes_tree", {});
  });

  it("maps an HTTP error into the same AppError shape/toast path callers already rely on", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-xyz");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));

    const { call, onAppError } = await import("./invoke");
    const toast = vi.fn();
    onAppError(toast);

    await expect(call("data_dir_open")).rejects.toEqual({
      code: "NOT_FOUND",
      message: "unavailable_in_browser: data_dir_open",
    });
    expect(toast).toHaveBeenCalledWith({ code: "NOT_FOUND", message: "unavailable_in_browser: data_dir_open" });
  });

  it("callSilent() also routes over HTTP in browser mode but never fires the toast", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-xyz");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "db locked" }) }));

    const { callSilent, onAppError } = await import("./invoke");
    const toast = vi.fn();
    onAppError(toast);

    await expect(callSilent("note_update", {})).rejects.toEqual({ code: "DB", message: "db locked" });
    expect(toast).not.toHaveBeenCalled();
  });
});
