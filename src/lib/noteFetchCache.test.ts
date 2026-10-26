import { describe, it, expect, vi } from "vitest";
import { createNoteFetchCache, getNoteOpenGen, markNoteOpened, resetNoteFetchCaches } from "./noteFetchCache";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createNoteFetchCache", () => {
  it("shares one in-flight request per (note, version) and exposes the settled value", async () => {
    const fetch = vi.fn(async (id: string) => `v:${id}`);
    const cache = createNoteFetchCache(fetch);
    const a = cache.get("n1", "0");
    const b = cache.get("n1", "0");
    expect(a).toBe(b);
    expect(cache.peek("n1", "0")).toBeUndefined();
    await a;
    await tick();
    expect(cache.peek("n1", "0")).toBe("v:n1");
    await cache.get("n1", "0");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a new version replaces the note's entry and refetches", async () => {
    const fetch = vi.fn(async () => fetch.mock.calls.length);
    const cache = createNoteFetchCache(fetch);
    expect(await cache.get("n1", "0")).toBe(1);
    expect(await cache.get("n1", "1")).toBe(2);
    await tick();
    expect(cache.peek("n1", "0")).toBeUndefined();
    expect(cache.peek("n1", "1")).toBe(2);
  });

  it("does not cache failures — the next caller retries", async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return "ok";
    });
    const cache = createNoteFetchCache(fetch);
    await expect(cache.get("n1", "0")).rejects.toThrow("boom");
    await tick();
    fail = false;
    expect(await cache.get("n1", "0")).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used note past the cap", async () => {
    const fetch = vi.fn(async (id: string) => id);
    const cache = createNoteFetchCache(fetch, 2);
    await cache.get("a", "0");
    await cache.get("b", "0");
    await cache.get("a", "0"); // a 를 최근으로
    await cache.get("c", "0"); // b 가 밀려난다
    await tick();
    expect(cache.peek("a", "0")).toBe("a");
    expect(cache.peek("b", "0")).toBeUndefined();
    expect(cache.peek("c", "0")).toBe("c");
  });

  it("resetNoteFetchCaches clears every cache and the open generations", async () => {
    const cache = createNoteFetchCache(async () => 1);
    await cache.get("n1", "0");
    await tick();
    markNoteOpened("n1");
    expect(getNoteOpenGen("n1")).toBe(1);
    resetNoteFetchCaches();
    expect(cache.peek("n1", "0")).toBeUndefined();
    expect(getNoteOpenGen("n1")).toBe(0);
  });
});
