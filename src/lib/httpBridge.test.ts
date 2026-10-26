import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Browser-mode bridge (docs/SYNC.md contract): POST /api/v1/invoke {"cmd","args"} → result, errors
 * as {"error"} (plus "code" for a command's own AppError) with 400/404/409/500; GET /api/v1/events
 * is SSE of named frames (SSE_EVENTS). These tests stub fetch/EventSource against that contract
 * shape — the real server side is covered by src-tauri/src/sync_server/tests.rs.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  dispatch(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  sessionStorage.setItem("brise_sync_token", "tok-abc");
  FakeEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("httpInvoke — POST /api/v1/invoke", () => {
  it("posts {cmd,args} with bearer auth and returns the parsed JSON result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hello: "world" }) });
    vi.stubGlobal("fetch", fetchMock);
    const { httpInvoke } = await import("./httpBridge");

    const result = await httpInvoke<{ hello: string }>("note_get", { id: "n1" });

    expect(result).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/invoke",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer tok-abc",
        }),
        body: JSON.stringify({ cmd: "note_get", args: { id: "n1" } }),
      }),
    );
  });

  it("maps a 404 to a recognizable unavailable_in_browser error (excluded-over-HTTP commands)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("data_dir_open")).rejects.toEqual({
      code: "NOT_FOUND",
      message: "unavailable_in_browser: data_dir_open",
    });
  });

  it("maps a 400 to VALIDATION carrying the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "bad title" }) }));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("note_create")).rejects.toEqual({ code: "VALIDATION", message: "bad title" });
  });

  it("maps a 500 to DB carrying the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("note_create")).rejects.toEqual({ code: "DB", message: "boom" });
  });

  it("prefers the command's own AppError code (409 CONFLICT) over the status class", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "section changed", code: "CONFLICT" }) }));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("section_update")).rejects.toEqual({ code: "CONFLICT", message: "section changed" });
  });

  it("keeps a domain NOT_FOUND (500 + code) distinct from the 404 unavailable_in_browser marker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "note is in trash: n1", code: "NOT_FOUND" }) }));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("section_update")).rejects.toEqual({ code: "NOT_FOUND", message: "note is in trash: n1" });
  });

  it("maps a fetch-level failure (offline/dropped connection) to IO", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { httpInvoke } = await import("./httpBridge");

    await expect(httpInvoke("note_create")).rejects.toEqual({ code: "IO", message: "Error: network down" });
  });
});

describe("browserListen — GET /api/v1/events SSE bridge", () => {
  it("wires remote-note-write to the SSE stream, with the token in the URL", async () => {
    const { browserListen } = await import("./httpBridge");
    const handler = vi.fn();

    await browserListen("remote-note-write", handler);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/v1/events?token=tok-abc");

    FakeEventSource.instances[0].dispatch("remote-note-write", { note_id: "n1", created: true });
    expect(handler).toHaveBeenCalledWith({ payload: { note_id: "n1", created: true } });
  });

  it("unlisten stops delivering further events without closing the shared stream", async () => {
    const { browserListen } = await import("./httpBridge");
    const handler = vi.fn();
    const unlisten = await browserListen("remote-note-write", handler);

    unlisten();
    FakeEventSource.instances[0].dispatch("remote-note-write", { note_id: "n2", created: false });

    expect(handler).not.toHaveBeenCalled();
  });

  it("pet-chat-updated attaches to an already-open stream (subscribed after remote-note-write)", async () => {
    const { browserListen } = await import("./httpBridge");
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    const noteHandler = vi.fn();
    const chatHandler = vi.fn();
    await browserListen("remote-note-write", noteHandler);
    await browserListen("pet-chat-updated", chatHandler);
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0].dispatch("pet-chat-updated", { reason: "append" });
    expect(chatHandler).toHaveBeenCalledWith({ payload: { reason: "append" } });
    expect(noteHandler).not.toHaveBeenCalled();
  });

  it("S2 attachment-meta events are subscribed on the SSE stream (not the no-op stub)", async () => {
    const { browserListen } = await import("./httpBridge");
    const sug = vi.fn();
    const app = vi.fn();
    await browserListen("attachment-meta-suggested", sug);
    await browserListen("attachment-meta-applied", app);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].dispatch("attachment-meta-suggested", { note_id: "n1" });
    FakeEventSource.instances[0].dispatch("attachment-meta-applied", { note_id: "n1" });
    expect(sug).toHaveBeenCalledWith({ payload: { note_id: "n1" } });
    expect(app).toHaveBeenCalledWith({ payload: { note_id: "n1" } });
  });

  it("every other event (native-only) resolves to a no-op stub without opening a stream", async () => {
    const { browserListen } = await import("./httpBridge");
    const handler = vi.fn();

    const unlisten = await browserListen("custom:native_event", handler);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(() => unlisten()).not.toThrow();
  });

  it("rebuilds the stream with the CURRENT token on error, after a bounded backoff", async () => {
    vi.useFakeTimers();
    try {
      const { browserListen } = await import("./httpBridge");
      const handler = vi.fn();
      await browserListen("remote-note-write", handler);
      expect(FakeEventSource.instances).toHaveLength(1);

      // Token regenerated elsewhere (sessionStorage updated) while the old stream was still open,
      // then that now-invalid stream errors out.
      sessionStorage.setItem("brise_sync_token", "tok-fresh");
      FakeEventSource.instances[0].dispatch("error", {});

      // First reconnect rung is 1s — nothing rebuilt before then.
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeEventSource.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2);
      expect(FakeEventSource.instances).toHaveLength(2);
      expect(FakeEventSource.instances[1].url).toBe("/api/v1/events?token=tok-fresh");

      // A rebuilt stream still delivers events to the same handler.
      FakeEventSource.instances[1].dispatch("remote-note-write", { note_id: "n3", created: true });
      expect(handler).toHaveBeenCalledWith({ payload: { note_id: "n3", created: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule a second reconnect while one is already pending", async () => {
    vi.useFakeTimers();
    try {
      const { browserListen } = await import("./httpBridge");
      await browserListen("remote-note-write", vi.fn());
      FakeEventSource.instances[0].dispatch("error", {});
      FakeEventSource.instances[0].dispatch("error", {}); // superseded instance, ignored

      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeEventSource.instances).toHaveLength(2); // exactly one rebuild, not two
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("httpInvoke — M-1 시간 상한", () => {
  it("끝나지 않는 fetch 는 15초 안에 IO/timeout 으로 끊기고, ai_* 는 150초까지 기다린다", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        })),
      );
      const { httpInvoke } = await import("./httpBridge");
      const slow = httpInvoke("section_update", {});
      const slowResult = slow.catch((e) => e);
      const ai = httpInvoke("ai_chat", {});
      const aiResult = ai.catch((e) => e);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await slowResult).toEqual({ code: "IO", message: "timeout" });
      let aiSettled = false;
      void aiResult.then(() => (aiSettled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(aiSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(140_000);
      expect(await aiResult).toEqual({ code: "IO", message: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokeTimeoutMs: 긴 명령 목록", async () => {
    const { invokeTimeoutMs } = await import("./httpBridge");
    for (const c of [
      "ai_x",
      "audio_transcribe",
      "pet_chat",
      "link_preview",
      "collect_source_add_nl",
      "geocode_lookup",
      "attachment_thumbs_generate",
      "attachment_fetch_reader",
      "dashboard_graph",
    ]) {
      expect(invokeTimeoutMs(c)).toBe(150_000);
    }
    expect(invokeTimeoutMs("note_get")).toBe(15_000);
  });
});
