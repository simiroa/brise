import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVoiceDuration, rememberVoiceDuration, resetVoiceDurations } from "./voiceDurations";

beforeEach(() => resetVoiceDurations());

describe("voiceDurations", () => {
  it("returns what the recorder measured, by attachment id; unknown ids are undefined", () => {
    rememberVoiceDuration("att1", 12_345.6);
    expect(getVoiceDuration("att1")).toBe(12_346);
    expect(getVoiceDuration("other")).toBeUndefined();
  });

  it("ignores non-durations so the row falls back to the native player", () => {
    for (const bad of [0, -5, NaN, Infinity]) rememberVoiceDuration("bad", bad);
    rememberVoiceDuration("", 5000);
    expect(getVoiceDuration("bad")).toBeUndefined();
    expect(getVoiceDuration("")).toBeUndefined();
  });

  it("survives an app restart (localStorage mirror), and a corrupt mirror just starts empty", async () => {
    rememberVoiceDuration("att1", 54_000);
    vi.resetModules();
    const fresh = await import("./voiceDurations");
    expect(fresh.getVoiceDuration("att1")).toBe(54_000);

    localStorage.setItem("brise_voice_durations", "{not json");
    vi.resetModules();
    const broken = await import("./voiceDurations");
    expect(broken.getVoiceDuration("att1")).toBeUndefined();
    broken.rememberVoiceDuration("att2", 1000); // and it still works afterwards
    expect(broken.getVoiceDuration("att2")).toBe(1000);
  });

  it("keeps only the most recent entries", () => {
    for (let i = 0; i < 205; i++) rememberVoiceDuration(`a${i}`, 1000 + i);
    expect(getVoiceDuration("a0")).toBeUndefined();
    expect(getVoiceDuration("a4")).toBeUndefined();
    expect(getVoiceDuration("a5")).toBe(1005);
    expect(getVoiceDuration("a204")).toBe(1204);
  });

  it("works without storage (private window): memory only", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberVoiceDuration("att1", 7000)).not.toThrow();
    expect(getVoiceDuration("att1")).toBe(7000);
    spy.mockRestore();
  });
});
