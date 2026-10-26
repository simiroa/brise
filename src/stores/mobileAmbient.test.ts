import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishRecLevel,
  readRecLevel,
  REC_LEVEL_MIN_MS,
  resetRecLevel,
  useMobileAmbientStore,
} from "./mobileAmbient";

/** 녹음 레벨 채널 — 상태가 아닌 비반응 채널이라, 구독자를 깨우지 않는다는 것까지 계약이다. */
beforeEach(() => {
  vi.useFakeTimers();
  resetRecLevel();
  useMobileAmbientStore.setState({ rec: "off", aiWork: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recording level channel", () => {
  it("only counts while the recording is live ('on')", () => {
    publishRecLevel(0.5);
    expect(readRecLevel().seq).toBe(0);
    useMobileAmbientStore.getState().setRec("paused");
    publishRecLevel(0.5);
    expect(readRecLevel().seq).toBe(0);
    useMobileAmbientStore.getState().setRec("on");
    publishRecLevel(0.5);
    expect(readRecLevel()).toEqual({ level: 0.5, seq: 1 });
  });

  it("throttles to ~18fps: samples closer than the minimum gap are dropped, the next one after it lands", () => {
    useMobileAmbientStore.getState().setRec("on");
    publishRecLevel(0.2);
    vi.advanceTimersByTime(REC_LEVEL_MIN_MS - 1);
    publishRecLevel(0.9);
    expect(readRecLevel()).toEqual({ level: 0.2, seq: 1 });
    vi.advanceTimersByTime(1);
    publishRecLevel(0.9);
    expect(readRecLevel()).toEqual({ level: 0.9, seq: 2 });
    // the real meter ticks every 100ms — none of those get dropped
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      publishRecLevel(0.1 * i);
    }
    expect(readRecLevel().seq).toBe(12);
  });

  it("clamps to 0..1 and ignores non-finite values", () => {
    useMobileAmbientStore.getState().setRec("on");
    publishRecLevel(7);
    expect(readRecLevel().level).toBe(1);
    vi.advanceTimersByTime(REC_LEVEL_MIN_MS);
    publishRecLevel(-3);
    expect(readRecLevel().level).toBe(0);
    vi.advanceTimersByTime(REC_LEVEL_MIN_MS);
    publishRecLevel(Number.NaN);
    publishRecLevel(Number.POSITIVE_INFINITY);
    expect(readRecLevel().seq).toBe(2);
  });

  it("a rec transition clears it (the next recording must not start on the last peak); a repeat of the same value does not", () => {
    useMobileAmbientStore.getState().setRec("on");
    publishRecLevel(0.8);
    useMobileAmbientStore.getState().setRec("on");
    expect(readRecLevel().seq).toBe(1);
    useMobileAmbientStore.getState().setRec("paused");
    expect(readRecLevel()).toEqual({ level: 0, seq: 0 });
    useMobileAmbientStore.getState().setRec("on");
    vi.advanceTimersByTime(REC_LEVEL_MIN_MS);
    publishRecLevel(0.4);
    useMobileAmbientStore.getState().setRec("off");
    expect(readRecLevel().seq).toBe(0);
  });

  it("is not store state: publishing never notifies subscribers", () => {
    useMobileAmbientStore.getState().setRec("on");
    const listener = vi.fn();
    const unsubscribe = useMobileAmbientStore.subscribe(listener);
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(REC_LEVEL_MIN_MS);
      publishRecLevel(Math.random());
    }
    unsubscribe();
    expect(readRecLevel().seq).toBe(30);
    expect(listener).not.toHaveBeenCalled();
  });
});
