import { beforeEach, describe, expect, it, vi } from "vitest";
import { noteLocationDenied, noteLocationGranted, planVoicePosition, resetLocationPermissionMemory } from "./voicePositionPolicy";

beforeEach(() => resetLocationPermissionMemory());

describe("planVoicePosition — no permission dialog over a live recording", () => {
  it("off never reads, whatever is remembered", () => {
    noteLocationGranted();
    expect(planVoicePosition("off", "start", false)).toBe("skip");
    expect(planVoicePosition("off", "stop", false)).toBe("skip");
  });

  it("permission unknown + ask (the default): never read from the recorder — nobody turned this on", () => {
    expect(planVoicePosition("ask", "start", false)).toBe("skip");
    expect(planVoicePosition("ask", "stop", false)).toBe("skip");
  });

  it("permission unknown + auto: defer while recording, read once it has stopped", () => {
    expect(planVoicePosition("auto", "start", false)).toBe("later");
    expect(planVoicePosition("auto", "stop", false)).toBe("read");
  });

  it("permission known granted: read right away in ask and auto (no dialog can appear)", () => {
    noteLocationGranted();
    expect(planVoicePosition("ask", "start", false)).toBe("read");
    expect(planVoicePosition("auto", "start", false)).toBe("read");
  });

  it("denied (this session, or by the other location paths) skips every mode and phase", () => {
    noteLocationGranted();
    noteLocationDenied();
    expect(planVoicePosition("auto", "start", false)).toBe("skip");
    expect(planVoicePosition("auto", "stop", false)).toBe("skip");
    resetLocationPermissionMemory();
    noteLocationGranted();
    expect(planVoicePosition("auto", "start", true)).toBe("skip"); // isLocationDenied()
  });

  it("the granted memory survives a restart; a denial removes it", async () => {
    noteLocationGranted();
    vi.resetModules();
    const fresh = await import("./voicePositionPolicy");
    expect(fresh.planVoicePosition("ask", "start", false)).toBe("read");

    fresh.noteLocationDenied();
    vi.resetModules();
    const after = await import("./voicePositionPolicy");
    expect(after.planVoicePosition("ask", "start", false)).toBe("skip");
  });

  it("unreadable storage falls back to the conservative 'unknown'", async () => {
    vi.resetModules();
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const m = await import("./voicePositionPolicy");
    expect(m.planVoicePosition("ask", "start", false)).toBe("skip");
    expect(m.planVoicePosition("auto", "start", false)).toBe("later");
    spy.mockRestore();
  });
});
