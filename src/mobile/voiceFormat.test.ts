import { afterEach, describe, expect, it, vi } from "vitest";
import { baseMime, buildFile, localIso, pickMimeType, SPLIT_BYTES } from "./voiceFormat";

function stubSupported(supported: (m: string) => boolean) {
  vi.stubGlobal("MediaRecorder", class { static isTypeSupported = supported; });
}

describe("pickMimeType", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 2026-10-07 S22 실측: 맨 "audio/mp4" 는 Opus-in-MP4 라 Gemini 전사가 엉터리였다 — AAC 를 코덱까지 명시해 먼저 고른다.
  it("prefers AAC-in-mp4 over plain audio/mp4 when the platform supports it", () => {
    stubSupported((m) => m === "audio/mp4;codecs=mp4a.40.2" || m === "audio/mp4" || m === "audio/webm;codecs=opus");
    expect(pickMimeType()).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  it("falls down the list when AAC is not recordable", () => {
    stubSupported((m) => m === "audio/webm;codecs=opus" || m === "audio/webm");
    expect(pickMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("is undefined without MediaRecorder or when nothing matches (the recorder then lets the engine choose)", () => {
    stubSupported(() => false);
    expect(pickMimeType()).toBeUndefined();
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickMimeType()).toBeUndefined();
  });
});

describe("SPLIT_BYTES", () => {
  it("splits below the 14MiB transcription limit (audio_transcribe.rs AUDIO_INLINE_MAX_BYTES)", () => {
    expect(SPLIT_BYTES).toBeLessThan(14 * 1024 * 1024);
  });
});

describe("buildFile", () => {
  it("is null when nothing was captured", () => {
    expect(buildFile([], "audio/webm", 0)).toBeNull();
    expect(buildFile([new Blob([])], "audio/webm", 0)).toBeNull();
  });

  it("types the File with the base mime (no codecs) and picks the extension from the container", () => {
    const at = Date.UTC(2026, 9, 7, 1, 2, 3);
    const aac = buildFile([new Blob(["x"])], "audio/mp4;codecs=mp4a.40.2", at)!;
    expect(aac.type).toBe("audio/mp4");
    expect(aac.name).toBe("voice-20261007-010203.m4a");
    // webm audio goes up as .weba — the server files plain .webm under video (attachments/mod.rs).
    expect(buildFile([new Blob(["x"])], "audio/webm;codecs=opus", at)!.name).toMatch(/\.weba$/);
    expect(buildFile([new Blob(["x"])], "audio/ogg", at)!.name).toMatch(/\.ogg$/);
  });
});

describe("baseMime", () => {
  it("strips the codecs parameter and never returns an empty type", () => {
    expect(baseMime("audio/mp4;codecs=mp4a.40.2")).toBe("audio/mp4");
    expect(baseMime("")).toBe("audio/webm");
  });
});

describe("localIso", () => {
  afterEach(() => vi.restoreAllMocks());
  it("carries a non-UTC offset and round-trips to the same instant", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-540); // KST
    const ms = Date.UTC(2026, 9, 3, 23, 30, 0);
    expect(localIso(ms)).toBe("2026-10-04T08:30:00+09:00");
    expect(Date.parse(localIso(ms))).toBe(ms);
  });
  it("handles negative and half-hour offsets", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(210); // -03:30
    expect(localIso(Date.UTC(2026, 0, 1, 2, 0, 0))).toBe("2025-12-31T22:30:00-03:30");
  });
});
