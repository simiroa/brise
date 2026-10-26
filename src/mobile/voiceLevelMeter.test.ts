import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENCE_MS, startLevelMeter } from "./voiceLevelMeter";

// getByteTimeDomainData fills 128 for silence (zero amplitude) and 255/0 swings for loud input.
let fill = 128;
const close = vi.fn(() => Promise.resolve());

class FakeAudioContext {
  createAnalyser() {
    return {
      fftSize: 0,
      getByteTimeDomainData(buf: Uint8Array) { buf.fill(fill); },
    };
  }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  close = close;
}

const stream = {} as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  fill = 128;
  close.mockClear();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startLevelMeter", () => {
  it("is null (no bars, no throw) when the webview has no AudioContext", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(startLevelMeter(stream, { isRecording: () => true, onLevel: vi.fn(), onSilent: vi.fn() })).toBeNull();
  });

  it("reports an RMS level while recording", () => {
    const onLevel = vi.fn();
    startLevelMeter(stream, { isRecording: () => true, onLevel, onSilent: vi.fn() });
    fill = 255; // (127/128)^2 rms ~ 0.99 -> x4, clamped to 1
    vi.advanceTimersByTime(100);
    expect(onLevel).toHaveBeenLastCalledWith(1);
  });

  it("flags silence only after SILENCE_MS of quiet, and clears it as soon as sound returns", () => {
    const onSilent = vi.fn();
    startLevelMeter(stream, { isRecording: () => true, onLevel: vi.fn(), onSilent });
    vi.advanceTimersByTime(SILENCE_MS - 200);
    expect(onSilent).not.toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(400);
    expect(onSilent).toHaveBeenLastCalledWith(true);
    fill = 255;
    vi.advanceTimersByTime(100);
    expect(onSilent).toHaveBeenLastCalledWith(false);
  });

  it("does not sample while paused and restarts the silence clock on resume", () => {
    let recording = false;
    const onLevel = vi.fn();
    const onSilent = vi.fn();
    startLevelMeter(stream, { isRecording: () => recording, onLevel, onSilent });
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(onLevel).not.toHaveBeenCalled();
    expect(onSilent).not.toHaveBeenCalledWith(true);
    recording = true;
    vi.advanceTimersByTime(SILENCE_MS - 200);
    expect(onSilent).not.toHaveBeenCalledWith(true);
  });

  it("stop() ends sampling and closes the context (twice is harmless)", () => {
    const onLevel = vi.fn();
    const meter = startLevelMeter(stream, { isRecording: () => true, onLevel, onSilent: vi.fn() })!;
    meter.stop();
    meter.stop();
    vi.advanceTimersByTime(1000);
    expect(onLevel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
