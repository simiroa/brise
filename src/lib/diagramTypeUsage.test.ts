import { describe, it, expect, beforeEach } from "vitest";
import { bump, usageOf, allUsage } from "./diagramTypeUsage";

const KEY = "brise.diagramTypeUsage";

describe("diagramTypeUsage", () => {
  beforeEach(() => localStorage.clear());

  it("bump(seed) 는 seed 만 1 올리고 ai 는 0, last 는 채워진다", () => {
    bump("basic", "seed");
    const u = usageOf("basic");
    expect(u.seed).toBe(1);
    expect(u.ai).toBe(0);
    expect(u.last).not.toBe("");
  });

  it("bump 를 여러 번 섞으면 seed/ai 가 각각 누적된다", () => {
    bump("basic", "seed");
    bump("basic", "seed");
    bump("basic", "ai");
    const u = usageOf("basic");
    expect(u.seed).toBe(2);
    expect(u.ai).toBe(1);
  });

  it("건드리지 않은 타입은 0/0/빈 last", () => {
    expect(usageOf("mindmap")).toEqual({ seed: 0, ai: 0, last: "" });
  });

  it("allUsage 는 bump 된 타입만 담는다", () => {
    bump("basic", "seed");
    bump("mindmap", "ai");
    const all = allUsage();
    expect(Object.keys(all).sort()).toEqual(["basic", "mindmap"]);
  });

  it("깨진 JSON 은 조용히 무시(빈 값으로 읽힌다)", () => {
    localStorage.setItem(KEY, "{not json");
    expect(usageOf("basic")).toEqual({ seed: 0, ai: 0, last: "" });
    expect(allUsage()).toEqual({});
  });
});
