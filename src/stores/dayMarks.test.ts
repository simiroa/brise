import { describe, it, expect, vi, beforeEach } from "vitest";

const callSilentMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  callSilent: (...a: unknown[]) => callSilentMock(...a),
}));
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));
vi.mock("../lib/env", () => ({ isBrowser: () => true }));

/** 모듈 수준 상태(inflight·순번)가 테스트 사이에 새지 않게 매번 새로 읽는다. */
async function freshStore() {
  vi.resetModules();
  return (await import("./dayMarks")).useDayMarksStore;
}

const mark = (id: string) => ({ id, title: id }) as never;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useDayMarksStore.load", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    reportFallbackMock.mockReset();
  });

  it("같은 노트북 조회가 날아가는 중이면 약속을 같이 쓴다", async () => {
    const store = await freshStore();
    const d = deferred<unknown>();
    callSilentMock.mockReturnValue(d.promise);
    const a = store.getState().load("ws1");
    const b = store.getState().load("ws1");
    expect(a).toBe(b);
    expect(callSilentMock).toHaveBeenCalledTimes(1);
    d.resolve({ marks: [mark("m1")], sources: [], hides: [] });
    await a;
    expect(store.getState().marks).toHaveLength(1);
  });

  it("쓰기 뒤 force 재조회는 날아가던 옛 조회를 재사용하지 않고, 옛 응답이 늦게 와도 새 목록을 덮지 않는다", async () => {
    const store = await freshStore();
    const before = deferred<unknown>();
    const after = deferred<unknown>();
    callSilentMock.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);

    const p1 = store.getState().load("ws1");
    const p2 = store.getState().load("ws1", { force: true });
    expect(p2).not.toBe(p1);
    expect(callSilentMock).toHaveBeenCalledTimes(2);

    after.resolve({ marks: [mark("new")], sources: [], hides: [] });
    await p2;
    before.resolve({ marks: [], sources: [], hides: [] });
    await p1;
    expect(store.getState().marks.map((m) => m.id)).toEqual(["new"]);
  });

  it("읽기에 실패하면 같은 노트북의 기존 목록을 지키고 진단에 남긴다", async () => {
    const store = await freshStore();
    callSilentMock.mockResolvedValueOnce({ marks: [mark("m1")], sources: [], hides: [] });
    await store.getState().load("ws1");
    callSilentMock.mockRejectedValueOnce(new Error("db busy"));
    await store.getState().load("ws1", { force: true });
    expect(store.getState().marks.map((m) => m.id)).toEqual(["m1"]);
    expect(reportFallbackMock).toHaveBeenCalledWith("day_marks", "list_failed_kept_previous", "db busy");
  });

  it("다른 노트북으로 바꾸다 실패하면 옛 노트북 목록을 보여주지 않는다", async () => {
    const store = await freshStore();
    callSilentMock.mockResolvedValueOnce({ marks: [mark("m1")], sources: [], hides: [] });
    await store.getState().load("ws1");
    callSilentMock.mockRejectedValueOnce(new Error("nope"));
    await store.getState().load("ws2");
    expect(store.getState().workspaceId).toBe("ws2");
    expect(store.getState().marks).toEqual([]);
    expect(reportFallbackMock).toHaveBeenCalledWith("day_marks", "list_failed_cleared", "nope");
  });
});
