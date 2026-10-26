import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { uploadAttachment, AttachmentTooLargeError, ATTACHMENT_MAX_BYTES, fetchPing, uploadTimeoutMs } from "./mobileApi";

beforeEach(() => {
  sessionStorage.setItem("brise_sync_token", "tok-abc");
});
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("fetchPing", () => {
  it("GETs /api/v1/ping with bearer auth and returns the parsed body", async () => {
    const body = { app_version: "0.5.1", schema_version: 3, device_id: "d1", workspace_count: 2 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchPing()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/ping",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok-abc" }) }),
    );
  });

  it("never throws: a non-ok response or a network failure both resolve to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchPing()).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchPing()).toBeNull();
  });
});

describe("uploadAttachment", () => {
  function fakeFile(name: string, sizeBytes: number, type = "image/png"): File {
    return new File([new Uint8Array(sizeBytes)], name, { type });
  }

  it("POSTs the raw file bytes with the filename as a query param and bearer auth, returning the created attachment row", async () => {
    const row = { id: "a1", name: "photo.png", kind: "image", rel_path: "n1/photo.png", url: null, size_bytes: 3, position: 0 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => row });
    vi.stubGlobal("fetch", fetchMock);
    const file = fakeFile("photo.png", 3);

    const result = await uploadAttachment("n1", file);

    expect(result).toEqual(row);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/notes/n1/attachments?filename=photo.png");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file); // raw bytes, not FormData — the shipped contract (handlers/attachments.rs::attachment_upload)
  });

  it("sends X-Upload-Id header when uploadId is provided (idempotency key for retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "a1" }) });
    vi.stubGlobal("fetch", fetchMock);

    await uploadAttachment("n1", fakeFile("photo.png", 3), undefined, "upload-uuid-123");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["X-Upload-Id"]).toBe("upload-uuid-123");
  });

  it("appends recorded_at / lat / lng (S2 meta) as query params, URL-encoded, only for what is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "a1" }) });
    vi.stubGlobal("fetch", fetchMock);

    await uploadAttachment("n1", fakeFile("memo.webm", 3, "audio/webm"), {
      recordedAt: "2026-10-03T14:32:05+09:00",
      lat: 37.5665,
      lng: 126.978,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/v1/notes/n1/attachments?filename=memo.webm&recorded_at=2026-10-03T14%3A32%3A05%2B09%3A00&lat=37.5665&lng=126.978",
    );

    // 시각만 / 좌표 한쪽만 / 빈 meta — 쓸 수 있는 값만 붙고, 반쪽 좌표는 버린다.
    await uploadAttachment("n1", fakeFile("a.webm", 3), { recordedAt: "2026-10-03T00:00:00Z" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/notes/n1/attachments?filename=a.webm&recorded_at=2026-10-03T00%3A00%3A00Z");
    await uploadAttachment("n1", fakeFile("b.webm", 3), { lat: 37.5 });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/v1/notes/n1/attachments?filename=b.webm");
    await uploadAttachment("n1", fakeFile("c.webm", 3), {});
    expect(fetchMock.mock.calls[3][0]).toBe("/api/v1/notes/n1/attachments?filename=c.webm");
  });

  it("rejects client-side (before ever hitting fetch) above the 25MB cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadAttachment("n1", fakeFile("huge.mp4", ATTACHMENT_MAX_BYTES + 1))).rejects.toBeInstanceOf(
      AttachmentTooLargeError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a server-side 413 to the same AttachmentTooLargeError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413, json: async () => ({}) }));

    await expect(uploadAttachment("n1", fakeFile("photo.png", 10))).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("throws a plain error on any other non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

    await expect(uploadAttachment("n1", fakeFile("photo.png", 10))).rejects.toThrow("HTTP 500");
  });
});

describe("M-1 업로드·ping 시간 상한", () => {
  it("uploadTimeoutMs: 크기에 비례, 30초~10분", () => {
    expect(uploadTimeoutMs(1000)).toBe(30_000);
    expect(uploadTimeoutMs(25 * 1024 * 1024)).toBe(525_000);
    expect(uploadTimeoutMs(10 ** 10)).toBe(600_000);
  });

  it("멈춘 업로드는 시간 안에 IO/timeout 으로 실패하고, ping 은 5초 뒤 null", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        })),
      );
      const up = uploadAttachment("n1", new File([new Uint8Array(10)], "a.png")).catch((e) => e);
      const ping = fetchPing();
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await ping).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await up).toEqual({ code: "IO", message: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
