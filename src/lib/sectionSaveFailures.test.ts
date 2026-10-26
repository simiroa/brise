import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markSaveFailed,
  clearSaveFailed,
  hasSaveFailed,
  anySaveFailed,
  fieldFailureKey,
  noteHasSaveFailure,
  retryFailedSaves,
  clearAllSaveFailures,
} from "./sectionSaveFailures";

describe("sectionSaveFailures registry", () => {
  beforeEach(() => {
    clearAllSaveFailures();
  });

  it("marks and clears section save failures", () => {
    markSaveFailed("sec1");
    expect(hasSaveFailed("sec1")).toBe(true);
    expect(anySaveFailed(["sec1", "sec2"])).toBe(true);
    expect(anySaveFailed(["sec2"])).toBe(false);

    clearSaveFailed("sec1");
    expect(hasSaveFailed("sec1")).toBe(false);
  });

  it("noteHasSaveFailure checks all field keys with prefix matching, not just title and year", () => {
    expect(noteHasSaveFailure("noteA", ["sec1"])).toBe(false);

    // Any field for this note (e.g. region, tags, location, icon) must be recognized
    markSaveFailed(fieldFailureKey("noteA", "region"));
    expect(noteHasSaveFailure("noteA", [])).toBe(true);

    // A field failure for a different note should not affect noteA
    clearAllSaveFailures();
    markSaveFailed(fieldFailureKey("noteB", "region"));
    expect(noteHasSaveFailure("noteA", [])).toBe(false);
    expect(noteHasSaveFailure("noteB", [])).toBe(true);

    // Section failure for noteA
    clearAllSaveFailures();
    markSaveFailed("sec1");
    expect(noteHasSaveFailure("noteA", ["sec1"])).toBe(true);
    expect(noteHasSaveFailure("noteA", ["sec2"])).toBe(false);
  });

  it("retryFailedSaves executes registered retries", async () => {
    const retry1 = vi.fn(async () => {});
    const retry2 = vi.fn(async () => {});

    markSaveFailed("k1", retry1);
    markSaveFailed("k2", retry2);
    markSaveFailed("k3"); // no retry closure

    await retryFailedSaves();

    expect(retry1).toHaveBeenCalledTimes(1);
    expect(retry2).toHaveBeenCalledTimes(1);
  });
});
