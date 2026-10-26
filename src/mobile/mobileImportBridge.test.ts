import { describe, it, expect, vi, afterEach } from "vitest";

const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

import { ackImport, fetchImportFile, hasImportBridge, pullPendingImport, PULL_TIMEOUT_MS } from "./mobileImportBridge";

type Bridge = { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: { data: string }) => void) | null };
const w = window as unknown as { BriseNative?: Bridge };

/** type 별로 응답을 정해 주는 가짜 셸. 응답은 비동기로 돌려준다(진짜 브리지처럼). */
function installShell(answers: Record<string, object | ((req: Record<string, unknown>) => object) | null>): Bridge {
  const b: Bridge = {
    onmessage: null,
    postMessage: vi.fn((raw: string) => {
      const req = JSON.parse(raw) as { id: number; type: string };
      const a = answers[req.type];
      if (a === null || a === undefined) return; // 응답 없음
      const body = typeof a === "function" ? a(req) : a;
      queueMicrotask(() => b.onmessage?.({ data: JSON.stringify({ id: req.id, ...body }) }));
    }),
  };
  w.BriseNative = b;
  return b;
}

afterEach(() => {
  delete w.BriseNative;
  reportFallbackMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const IMPORT = { importId: "i1", text: "hi", subject: "", textError: false, omitted: 0, items: [{ idx: 0, name: "a.jpg", mime: "image/jpeg", size: 3 }] };

describe("pullPendingImport", () => {
  it("셸이 없으면 null(요청도 없다)", async () => {
    expect(hasImportBridge()).toBe(false);
    await expect(pullPendingImport()).resolves.toBeNull();
  });

  it("가져오기가 있으면 배치를 돌려주고, 읽기만 한다(ack 를 보내지 않는다)", async () => {
    const b = installShell({ getPendingImport: { ok: true, import: IMPORT } });
    const r = await pullPendingImport();
    expect(r).toMatchObject({ importId: "i1", text: "hi" });
    expect(b.postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(b.postMessage.mock.calls[0][0]).type).toBe("getPendingImport");
  });

  it("없음(import:null)이면 null", async () => {
    installShell({ getPendingImport: { ok: true, import: null } });
    await expect(pullPendingImport()).resolves.toBeNull();
  });

  it("구형 셸: unknown_type → null(오류로 기록하지 않는다)", async () => {
    installShell({ getPendingImport: { ok: false, error: "unknown_type" } });
    await expect(pullPendingImport()).resolves.toBeNull();
    expect(reportFallbackMock).not.toHaveBeenCalled();
  });

  it("구형 LegacyBridge: 어떤 요청에도 위치로 답한다 → 가져오기 없음", async () => {
    installShell({ getPendingImport: { ok: true, lat: 37, lng: 127, accuracy: 20 } });
    await expect(pullPendingImport()).resolves.toBeNull();
  });

  it("응답이 없으면(시간 초과) null 이고 코드만 기록한다", async () => {
    vi.useFakeTimers();
    installShell({ getPendingImport: null });
    const p = pullPendingImport();
    await vi.advanceTimersByTimeAsync(PULL_TIMEOUT_MS + 1);
    await expect(p).resolves.toBeNull();
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-import", "pull_failed", "timeout");
  });
});

describe("ackImport", () => {
  it("importId 를 실어 보낸다", async () => {
    const b = installShell({ ackImport: { ok: true } });
    await ackImport("i1");
    expect(JSON.parse(b.postMessage.mock.calls[0][0])).toMatchObject({ type: "ackImport", importId: "i1" });
  });

  it("셸이 없거나 응답이 없어도 던지지 않는다", async () => {
    await expect(ackImport("i1")).resolves.toBeUndefined();
    vi.useFakeTimers();
    installShell({ ackImport: null });
    const p = ackImport("i1");
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toBeUndefined();
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-import", "ack_failed", "timeout");
  });
});

describe("fetchImportFile", () => {
  const file = { idx: 0, name: "a.jpg", mime: "image/jpeg", size: 3, url: "/__shell/import/i1/0" };

  it("same-origin 경로를 받아 이름·MIME 이 붙은 File 로 만든다", async () => {
    // jsdom 의 Blob 은 Response 본문으로 못 쓴다(stream 없음) — 필요한 두 멤버만 가진 응답을 쓴다.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }));
    vi.stubGlobal("fetch", fetchMock);
    const f = await fetchImportFile(file);
    expect(fetchMock).toHaveBeenCalledWith("/__shell/import/i1/0");
    expect(f.name).toBe("a.jpg");
    expect(f.type).toBe("image/jpeg");
    expect(f.size).toBe(3);
  });

  it("404(이미 ack 됐거나 파일이 사라짐)면 HTTP 404 로 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(fetchImportFile(file)).rejects.toThrow("HTTP 404");
  });
});
