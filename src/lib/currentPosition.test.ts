import { describe, it, expect, vi, afterEach } from "vitest";
import { getCurrentPosition, CurrentPositionError, NATIVE_TIMEOUT_MS } from "./currentPosition";

type Bridge = { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: { data: string }) => void) | null };
const w = window as unknown as { BriseNative?: Bridge };

function installBridge(): Bridge {
  const b: Bridge = { postMessage: vi.fn(), onmessage: null };
  w.BriseNative = b;
  return b;
}
const reply = (b: Bridge, m: object) => b.onmessage?.({ data: JSON.stringify(m) });
const sentId = (b: Bridge) => JSON.parse(b.postMessage.mock.calls[b.postMessage.mock.calls.length - 1][0]).id as number;

afterEach(() => {
  delete w.BriseNative;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getCurrentPosition — native bridge", () => {
  it("성공: getLocation 요청을 보내고 id 가 맞는 응답으로 해석한다", async () => {
    const b = installBridge();
    const p = getCurrentPosition();
    expect(JSON.parse(b.postMessage.mock.calls[0][0]).type).toBe("getLocation");
    reply(b, { id: sentId(b), ok: true, lat: 37.5, lng: 127, accuracy: 20, ts: 1 });
    await expect(p).resolves.toEqual({ lat: 37.5, lng: 127, accuracy: 20 });
  });

  it("거부: error 코드를 CurrentPositionError 로 정규화한다", async () => {
    const b = installBridge();
    const p = getCurrentPosition();
    reply(b, { id: sentId(b), ok: false, error: "no_permission" });
    await expect(p).rejects.toMatchObject({ code: "no_permission" });
  });

  it("모르는 error 문자열은 unavailable", async () => {
    const b = installBridge();
    const p = getCurrentPosition();
    reply(b, { id: sentId(b), ok: false, error: "weird" });
    await expect(p).rejects.toBeInstanceOf(CurrentPositionError);
    await p.catch((e) => expect(e.code).toBe("unavailable"));
  });

  it("id 불일치 응답은 무시하고 맞는 응답을 기다린다", async () => {
    const b = installBridge();
    const p = getCurrentPosition();
    const id = sentId(b);
    reply(b, { id: id + 99, ok: true, lat: 1, lng: 2 });
    reply(b, { id, ok: true, lat: 3, lng: 4 });
    await expect(p).resolves.toMatchObject({ lat: 3, lng: 4 });
  });

  it("타임아웃: 응답이 없으면 timeout, 늦게 온 응답은 무시", async () => {
    vi.useFakeTimers();
    const b = installBridge();
    const p = getCurrentPosition();
    const id = sentId(b);
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(NATIVE_TIMEOUT_MS + 1);
    await assertion;
    expect(() => reply(b, { id, ok: true, lat: 1, lng: 2 })).not.toThrow();
  });

  it("동시 호출은 요청 하나를 공유한다", async () => {
    const b = installBridge();
    const p1 = getCurrentPosition();
    const p2 = getCurrentPosition();
    expect(b.postMessage).toHaveBeenCalledTimes(1);
    reply(b, { id: sentId(b), ok: true, lat: 1, lng: 2 });
    await Promise.all([p1, p2]);
    // 끝난 뒤에는 새 요청이 나간다
    const p3 = getCurrentPosition();
    expect(b.postMessage).toHaveBeenCalledTimes(2);
    reply(b, { id: sentId(b), ok: true, lat: 1, lng: 2 });
    await p3;
  });
});

describe("getCurrentPosition — web geolocation 분기", () => {
  it("BriseNative 가 없으면 navigator.geolocation 을 쓴다", async () => {
    const getCurrent = vi.fn((ok: (p: unknown) => void) => ok({ coords: { latitude: 10, longitude: 20, accuracy: 100 } }));
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: getCurrent } });
    await expect(getCurrentPosition()).resolves.toEqual({ lat: 10, lng: 20, accuracy: 100 });
    expect(getCurrent).toHaveBeenCalled();
  });

  it("geolocation 에러 코드 매핑(1→no_permission, 3→timeout)", async () => {
    for (const [n, code] of [[1, "no_permission"], [3, "timeout"], [2, "unavailable"]] as const) {
      vi.stubGlobal("navigator", {
        geolocation: { getCurrentPosition: (_: unknown, err: (e: { code: number }) => void) => err({ code: n }) },
      });
      await expect(getCurrentPosition()).rejects.toMatchObject({ code });
    }
  });

  it("geolocation 자체가 없으면 no_provider", async () => {
    vi.stubGlobal("navigator", {});
    await expect(getCurrentPosition()).rejects.toMatchObject({ code: "no_provider" });
  });
});
