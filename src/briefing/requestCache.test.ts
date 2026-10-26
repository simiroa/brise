import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedRequest, invalidate, REQUEST_TTL_MS, resetRequestCache } from "./requestCache";

describe("requestCache", () => {
  beforeEach(resetRequestCache);

  it("진행 중 요청 공유 + TTL 재사용 + fresh 우회", async () => {
    const load = vi.fn(async () => 1);
    const t = 1_000_000;
    await Promise.all([cachedRequest("k", load, {}, t), cachedRequest("k", load, {}, t)]);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedRequest("k", load, {}, t + REQUEST_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedRequest("k", load, { fresh: true }, t);
    expect(load).toHaveBeenCalledTimes(2);
    await cachedRequest("k", load, {}, t + REQUEST_TTL_MS + 1);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("ttl 옵션 / 실패 비캐시 / invalidate(prefix)", async () => {
    const load = vi.fn(async () => 1);
    await cachedRequest("a:1", load, { ttl: 10 }, 100);
    await cachedRequest("a:1", load, { ttl: 10 }, 111);
    expect(load).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(2);
    await expect(cachedRequest("b", bad)).rejects.toThrow();
    await Promise.resolve();
    await cachedRequest("b", bad);
    expect(bad).toHaveBeenCalledTimes(2);
    await cachedRequest("habit:1", load);
    await cachedRequest("habit:2", load);
    await cachedRequest("src:1", load);
    const n = load.mock.calls.length;
    invalidate("habit:");
    await cachedRequest("habit:1", load);
    await cachedRequest("habit:2", load);
    await cachedRequest("src:1", load);
    expect(load.mock.calls.length).toBe(n + 2);
  });
});
