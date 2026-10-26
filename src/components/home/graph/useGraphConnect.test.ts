import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../../stores/settings";
import type { DashboardGraphEdge } from "./graphSimulation";
import { linkName, missingBacklinkPairs, tryLockPair, unlockPair } from "./useGraphConnect";

describe("linkName", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" });
  });

  it("uses the trimmed title of the target note", () => {
    expect(linkName({ title: "Alpha" })).toBe("Alpha");
    expect(linkName({ title: "  Alpha  " })).toBe("Alpha");
  });

  it("falls back to the untitled label for empty, blank, placeholder or missing notes", () => {
    expect(linkName({ title: "" })).toBe("제목 없음");
    expect(linkName({ title: "   " })).toBe("제목 없음");
    expect(linkName({ title: "Untitled Note" })).toBe("제목 없음");
    expect(linkName({})).toBe("제목 없음");
    expect(linkName(null)).toBe("제목 없음");
    expect(linkName(undefined)).toBe("제목 없음");
  });

  it("follows the UI language for the fallback", () => {
    useSettingsStore.setState({ uiLang: "en" });
    expect(linkName({ title: "" })).toBe("Untitled Note");
  });
});

describe("tryLockPair / unlockPair", () => {
  it("locks an unordered pair once and releases it", () => {
    const inFlight = new Set<string>();

    expect(tryLockPair(inFlight, "b", "a")).toBe(true);
    expect([...inFlight]).toEqual(["a:b"]);
    expect(tryLockPair(inFlight, "a", "b")).toBe(false);
    expect(tryLockPair(inFlight, "b", "a")).toBe(false);

    unlockPair(inFlight, "a", "b");
    expect(inFlight.size).toBe(0);
    expect(tryLockPair(inFlight, "a", "b")).toBe(true);
  });

  it("keeps different pairs independent", () => {
    const inFlight = new Set<string>();

    expect(tryLockPair(inFlight, "a", "b")).toBe(true);
    expect(tryLockPair(inFlight, "a", "c")).toBe(true);
    unlockPair(inFlight, "b", "a");
    expect([...inFlight]).toEqual(["a:c"]);
  });
});

describe("missingBacklinkPairs", () => {
  const edge = (source: string, target: string, kind: string): DashboardGraphEdge =>
    ({ source, target, kind, weight: 1 }) as DashboardGraphEdge;

  it("returns every i<j pair when there are no edges", () => {
    expect(missingBacklinkPairs(["a", "b", "c"], [])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(missingBacklinkPairs(["a", "b"], undefined)).toEqual([["a", "b"]]);
  });

  it("skips pairs that already have a backlink in either direction", () => {
    expect(missingBacklinkPairs(["a", "b", "c"], [edge("b", "a", "backlink")])).toEqual([
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(missingBacklinkPairs(["a", "b", "c"], [edge("a", "c", "backlink")])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
  });

  it("does not treat a related edge as a connection", () => {
    expect(missingBacklinkPairs(["a", "b"], [edge("a", "b", "related")])).toEqual([["a", "b"]]);
  });

  it("returns nothing for fewer than two ids", () => {
    expect(missingBacklinkPairs([], [])).toEqual([]);
    expect(missingBacklinkPairs(["a"], [])).toEqual([]);
  });
});
