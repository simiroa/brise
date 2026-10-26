import { describe, it, expect, vi, afterEach } from "vitest";
import { nativeRequest, getNativeBridge, NativeRequestError } from "./nativeBridge";

type Bridge = { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: { data: string }) => void) | null };
const w = window as unknown as { BriseNative?: Bridge };

function installBridge(): Bridge {
  const b: Bridge = { postMessage: vi.fn(), onmessage: null };
  w.BriseNative = b;
  return b;
}
const reply = (b: Bridge, m: object) => b.onmessage?.({ data: JSON.stringify(m) });
const sent = (b: Bridge, n = b.postMessage.mock.calls.length - 1) => JSON.parse(b.postMessage.mock.calls[n][0]) as { id: number; type: string };

afterEach(() => {
  delete w.BriseNative;
  vi.useRealTimers();
});

describe("nativeRequest", () => {
  it("요청에 id·type·payload 를 싣고 id 가 맞는 응답으로 해석한다", async () => {
    const b = installBridge();
    const p = nativeRequest("ackImport", { importId: "abc" });
    const m = sent(b) as { id: number; type: string; importId?: string };
    expect(m.type).toBe("ackImport");
    expect(m.importId).toBe("abc");
    reply(b, { id: m.id, ok: true, extra: 1 });
    await expect(p).resolves.toMatchObject({ ok: true, extra: 1 });
  });

  it("ok:false 응답은 던지지 않고 error 코드를 돌려준다", async () => {
    const b = installBridge();
    const p = nativeRequest("getPendingImport");
    reply(b, { id: sent(b).id, ok: false, error: "unknown_type" });
    await expect(p).resolves.toEqual(expect.objectContaining({ ok: false, error: "unknown_type" }));
  });

  it("동시 요청은 id 가 달라 서로의 응답을 가로채지 않는다(하나의 onmessage 를 같이 쓴다)", async () => {
    const b = installBridge();
    const p1 = nativeRequest("getLocation");
    const p2 = nativeRequest("getPendingImport");
    const [m1, m2] = [sent(b, 0), sent(b, 1)];
    expect(m1.id).not.toBe(m2.id);
    // 두 번째 요청이 onmessage 를 다시 걸어도 첫 요청의 핸들러가 지워지지 않는다.
    reply(b, { id: m2.id, ok: true, import: null });
    reply(b, { id: m1.id, ok: true, lat: 1, lng: 2 });
    await expect(p2).resolves.toMatchObject({ import: null });
    await expect(p1).resolves.toMatchObject({ lat: 1, lng: 2 });
  });

  it("형식이 다른 메시지·모르는 id 는 무시한다", async () => {
    const b = installBridge();
    const p = nativeRequest("getLocation");
    const id = sent(b).id;
    b.onmessage?.({ data: "not json" });
    reply(b, { id: id + 999, ok: true });
    reply(b, { ok: true });
    reply(b, { id, ok: true, lat: 3 });
    await expect(p).resolves.toMatchObject({ lat: 3 });
  });

  it("시간 안에 응답이 없으면 timeout, 늦게 온 응답은 무시한다", async () => {
    vi.useFakeTimers();
    const b = installBridge();
    const p = nativeRequest("getLocation", {}, 1000);
    const id = sent(b).id;
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(() => reply(b, { id, ok: true })).not.toThrow();
  });

  it("브리지가 없으면 unavailable, postMessage 가 던져도 unavailable", async () => {
    await expect(nativeRequest("getLocation")).rejects.toBeInstanceOf(NativeRequestError);
    await expect(nativeRequest("getLocation")).rejects.toMatchObject({ code: "unavailable" });
    const b = installBridge();
    b.postMessage.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(nativeRequest("getLocation")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("브리지 객체가 바뀌면(onmessage 가 비어 있으면) 디스패처를 다시 건다", async () => {
    const b1 = installBridge();
    const p1 = nativeRequest("getLocation");
    reply(b1, { id: sent(b1).id, ok: true });
    await p1;
    const b2 = installBridge();
    expect(b2.onmessage).toBeNull();
    const p2 = nativeRequest("getLocation");
    expect(b2.onmessage).toBeTypeOf("function");
    reply(b2, { id: sent(b2).id, ok: true });
    await expect(p2).resolves.toMatchObject({ ok: true });
    expect(getNativeBridge()).toBe(b2);
  });
});
