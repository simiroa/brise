import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentPosition = vi.fn();
vi.mock("../lib/currentPosition", async (orig) => ({
  ...(await orig<typeof import("../lib/currentPosition")>()),
  getCurrentPosition: () => getCurrentPosition(),
}));
vi.mock("../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));
const reportFallback = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallback(...a) }));
const denied = { v: false };
const resolveCurrentLocation = vi.fn();
vi.mock("./useCurrentLocationApply", () => ({
  isLocationDenied: () => denied.v,
  resolveCurrentLocation: (...a: unknown[]) => resolveCurrentLocation(...a),
}));

import { CurrentPositionError } from "../lib/currentPosition";
import { applyCurrentLocation, getVoicePosition } from "./mobileNoteInputActions";
import { setLocMode } from "./mobilePrefs";
import { resetLocationPermissionMemory } from "./voicePositionPolicy";

beforeEach(() => {
  getCurrentPosition.mockReset();
  resolveCurrentLocation.mockReset();
  reportFallback.mockReset();
  denied.v = false;
  localStorage.clear();
  resetLocationPermissionMemory();
});

describe("getVoicePosition — when the recorder may ask for a position (permission dialog timing)", () => {
  it("default ask mode, permission unknown: never touches the position (no dialog over the recorder)", async () => {
    expect(await getVoicePosition("start")).toBeNull();
    expect(await getVoicePosition("stop")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("off: never reads", async () => {
    setLocMode("off");
    expect(await getVoicePosition("start")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("auto, permission unknown: the start phase defers ('later') without reading; the stop phase reads", async () => {
    setLocMode("auto");
    getCurrentPosition.mockResolvedValue({ lat: 37.5, lng: 127 });
    expect(await getVoicePosition("start")).toBe("later");
    expect(getCurrentPosition).not.toHaveBeenCalled(); // nothing that could pop a dialog while recording

    expect(await getVoicePosition("stop")).toEqual({ lat: 37.5, lng: 127 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("once a read has succeeded, later recordings read at the start (ask included): the permission is known", async () => {
    setLocMode("auto");
    getCurrentPosition.mockResolvedValue({ lat: 1, lng: 2 });
    await getVoicePosition("stop"); // first-ever read, after a recording stopped
    setLocMode("ask");
    expect(await getVoicePosition("start")).toEqual({ lat: 1, lng: 2 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("a successful 'current location' apply also teaches the recorder the permission is granted", async () => {
    resolveCurrentLocation.mockResolvedValue({ region: "Seoul", lat: 37.5, lng: 127 });
    expect(await applyCurrentLocation("n1", false)).toBe(true);
    getCurrentPosition.mockResolvedValue({ lat: 37.5, lng: 127 });
    expect(await getVoicePosition("start")).toEqual({ lat: 37.5, lng: 127 }); // default ask mode
  });

  it("no_permission is remembered: the recorder does not ask again this session (no dialog per recording)", async () => {
    setLocMode("auto");
    getCurrentPosition.mockRejectedValue(new CurrentPositionError("no_permission"));
    expect(await getVoicePosition("stop")).toBeNull();
    expect(reportFallback).toHaveBeenCalledWith("location", "voice_position_no_permission");

    getCurrentPosition.mockClear();
    expect(await getVoicePosition("start")).toBeNull();
    expect(await getVoicePosition("stop")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("a denial found by 'current location' (and the app-wide denied flag) also stops the recorder", async () => {
    setLocMode("auto");
    denied.v = true;
    expect(await getVoicePosition("stop")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    denied.v = false;
    resolveCurrentLocation.mockRejectedValue(new CurrentPositionError("no_permission"));
    expect(await applyCurrentLocation("n1", false)).toBe(false);
    expect(await getVoicePosition("stop")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("other failures are recorded and give null (the recording carries on) without forgetting the permission", async () => {
    setLocMode("auto");
    getCurrentPosition.mockResolvedValueOnce({ lat: 1, lng: 2 });
    await getVoicePosition("stop");
    getCurrentPosition.mockRejectedValue(new CurrentPositionError("timeout"));
    expect(await getVoicePosition("start")).toBeNull();
    expect(reportFallback).toHaveBeenCalledWith("location", "voice_position_timeout");
    getCurrentPosition.mockResolvedValue({ lat: 3, lng: 4 });
    expect(await getVoicePosition("start")).toEqual({ lat: 3, lng: 4 });
  });

  it("with no argument it behaves as the start phase (MobileNote passes the function as is)", async () => {
    setLocMode("auto");
    expect(await getVoicePosition()).toBe("later");
  });
});
