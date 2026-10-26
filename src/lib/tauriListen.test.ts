import { describe, it, expect, vi, beforeEach } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { createSharedSubscription, listenMany, listenShared } from "./tauriListen";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 실제 구독을 흉내 낸다 — dispatch 를 붙잡고, 해제 함수는 스파이. */
function fakeReal() {
  let dispatch: ((v: number) => void) | null = null;
  const un = vi.fn();
  const real = vi.fn((d: (v: number) => void) => {
    dispatch = d;
    return Promise.resolve(un);
  });
  return { real, un, fire: (v: number) => dispatch?.(v) };
}

describe("createSharedSubscription", () => {
  it("구독자 둘이어도 실제 구독은 하나, 이벤트는 둘 다 받는다", async () => {
    const { real, fire } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    const a = vi.fn();
    const b = vi.fn();
    sub(a);
    sub(b);
    await flush();
    fire(1);
    expect(real).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(1);
    expect(b).toHaveBeenCalledWith(1);
  });

  it("해제가 반환된 뒤엔 핸들러가 불리지 않는다(실제 해제 전이라도)", async () => {
    const { real, fire } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    const a = vi.fn();
    const keep = vi.fn();
    sub(keep);
    const off = sub(a);
    await flush();
    off();
    fire(2);
    expect(a).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledWith(2);
  });

  it("마지막 구독자가 떠나면 마이크로태스크 뒤 실제로 해제한다", async () => {
    const { real, un } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    const off = sub(() => {});
    await flush();
    off();
    expect(un).not.toHaveBeenCalled();
    await flush();
    expect(un).toHaveBeenCalledTimes(1);
  });

  it("같은 틱에 해제→재구독(뷰 전환·StrictMode)은 실제 왕복이 없다", async () => {
    const { real, un, fire } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    const off = sub(() => {});
    await flush();
    off();
    const b = vi.fn();
    sub(b);
    await flush();
    fire(3);
    expect(real).toHaveBeenCalledTimes(1);
    expect(un).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(3);
  });

  it("실제 구독이 끝나기 전에 모두 떠나면 완료되자마자 해제한다", async () => {
    const d = deferred<() => void>();
    const un = vi.fn();
    const real = vi.fn(() => d.promise);
    const sub = createSharedSubscription<number>(real);
    const off = sub(() => {});
    off();
    await flush();
    expect(un).not.toHaveBeenCalled();
    d.resolve(un);
    await flush();
    expect(un).toHaveBeenCalledTimes(1);
    // 다음 구독자는 새로 구독한다.
    sub(() => {});
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("실제 구독이 reject 하면 다음 구독자가 다시 시도한다", async () => {
    const real = vi.fn(() => Promise.reject(new Error("not under tauri")));
    const sub = createSharedSubscription<number>(real);
    sub(() => {});
    await flush();
    sub(() => {});
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("디스패치 중 형제를 해제하면 그 형제는 이번 이벤트를 받지 않는다", async () => {
    const { real, fire } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    let offB: () => void = () => {};
    const b = vi.fn();
    sub(() => offB());
    offB = sub(b);
    await flush();
    fire(4);
    expect(b).not.toHaveBeenCalled();
  });

  it("같은 핸들러를 두 번 구독하면 각자 따로 해제된다", async () => {
    const { real, fire } = fakeReal();
    const sub = createSharedSubscription<number>(real);
    const h = vi.fn();
    const off1 = sub(h);
    sub(h);
    await flush();
    off1();
    fire(5);
    expect(h).toHaveBeenCalledTimes(1);
  });
});

describe("listenShared", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("이벤트 이름당 listen() 하나를 공유한다", async () => {
    const un = vi.fn();
    let handler: ((e: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation((_name: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return Promise.resolve(un);
    });
    const a = vi.fn();
    const b = vi.fn();
    const offA = listenShared("shared-x", a);
    const offB = listenShared("shared-x", b);
    await flush();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe("shared-x");
    handler!({ payload: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
    await flush();
    expect(un).toHaveBeenCalledTimes(1);
  });
});

describe("listenMany", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("cleanup 뒤 도착한 이벤트(실제 unlisten 전)는 핸들러까지 가지 않는다", async () => {
    let handler: ((e: { payload: unknown }) => unknown) | null = null;
    const d = deferred<() => void>();
    listenMock.mockImplementation((_name: string, h: (e: { payload: unknown }) => unknown) => {
      handler = h;
      return d.promise;
    });
    const h = vi.fn();
    const cleanup = listenMany([["many-x", h]]);
    cleanup();
    handler!({ payload: 1 });
    expect(h).not.toHaveBeenCalled();
    const un = vi.fn();
    d.resolve(un);
    await flush();
    expect(un).toHaveBeenCalledTimes(1);
  });

  it("핸들러의 반환값(비동기 Promise)을 그대로 넘긴다", async () => {
    let handler: ((e: { payload: unknown }) => unknown) | null = null;
    listenMock.mockImplementation((_name: string, h: (e: { payload: unknown }) => unknown) => {
      handler = h;
      return Promise.resolve(vi.fn());
    });
    const p = Promise.resolve("done");
    listenMany([["many-y", () => p]]);
    expect(handler!({ payload: null })).toBe(p);
  });
});
