import { describe, it, expect } from "vitest";
import { createOffsetTracker, FAVORITES_OFFSET_KEY } from "./windowLoad";

describe("createOffsetTracker — scroll load-more ask-once", () => {
  it("claims each offset only once for a folder key", () => {
    const t = createOffsetTracker();
    expect(t.claim("f1", 0)).toBe(true);
    expect(t.claim("f1", 0)).toBe(false);
    expect(t.claim("f1", 80)).toBe(true);
    expect(t.claim("f1", 80)).toBe(false);
    // Same offset under another folder is independent.
    expect(t.claim("f2", 0)).toBe(true);
  });

  it("does not re-request after a successful claim even if list length would change", () => {
    const t = createOffsetTracker();
    // Simulate: viewport near end → claim next window; append would bump length
    // and re-fire onRowsRendered with the same section — second claim is denied.
    const requests: number[] = [];
    const tryLoad = (offset: number) => {
      if (!t.claim("folder-a", offset)) return;
      requests.push(offset);
    };
    tryLoad(80);
    tryLoad(80); // re-entrant after append / callback identity churn
    tryLoad(80);
    expect(requests).toEqual([80]);
  });

  it("release allows a retry after failure", () => {
    const t = createOffsetTracker();
    expect(t.claim("f1", 80)).toBe(true);
    t.release("f1", 80);
    expect(t.claim("f1", 80)).toBe(true);
  });

  it("clear drops all claims (filter / open-folder change)", () => {
    const t = createOffsetTracker();
    t.claim("f1", 0);
    t.claim(FAVORITES_OFFSET_KEY, 0);
    t.clear();
    expect(t.claim("f1", 0)).toBe(true);
    expect(t.claim(FAVORITES_OFFSET_KEY, 0)).toBe(true);
  });

  it("clearKey only affects one section", () => {
    const t = createOffsetTracker();
    t.claim("f1", 0);
    t.claim("f2", 0);
    t.clearKey("f1");
    expect(t.claim("f1", 0)).toBe(true);
    expect(t.claim("f2", 0)).toBe(false);
  });
});
