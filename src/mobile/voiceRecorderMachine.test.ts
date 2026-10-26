import { describe, expect, it } from "vitest";
import { elapsedOf, INITIAL_VOICE, reduceVoice, type VoiceEvent, type VoiceMachine, type VoiceStatus } from "./voiceRecorderMachine";

const EVENTS = ["start", "pause", "resume", "finish", "cancel", "interrupt", "segment", "done", "reset", "fail"] as const;
type Ev = (typeof EVENTS)[number];
const ev = (type: Ev, at = 0): VoiceEvent => (type === "fail" ? { type, at, code: "unknown" } : { type, at });
const m = (status: VoiceStatus, extra: Partial<VoiceMachine> = {}): VoiceMachine => ({ ...INITIAL_VOICE, status, ...extra });

// The ENTIRE legal transition table. Anything not here must be ignored (same object back).
const LEGAL: Record<VoiceStatus, Partial<Record<Ev, VoiceStatus>>> = {
  idle: { start: "recording", fail: "failed" },
  recording: { pause: "paused", interrupt: "paused", finish: "finishing", segment: "recording", cancel: "idle", fail: "failed" },
  paused: { resume: "recording", finish: "finishing", cancel: "idle", fail: "failed" },
  finishing: { done: "done", fail: "failed" },
  done: { reset: "idle" },
  failed: { reset: "idle", start: "recording", fail: "failed" },
};

describe("voiceRecorderMachine", () => {
  const sample: Record<VoiceStatus, VoiceMachine> = {
    idle: m("idle"),
    recording: m("recording", { since: 0 }),
    paused: m("paused", { elapsedMs: 1000 }),
    finishing: m("finishing", { elapsedMs: 1000 }),
    done: m("done"),
    failed: m("failed", { error: "denied" }),
  };

  for (const status of Object.keys(sample) as VoiceStatus[]) {
    for (const type of EVENTS) {
      const target = LEGAL[status][type];
      it(`${status} + ${type} -> ${target ?? "ignored"}`, () => {
        const next = reduceVoice(sample[status], ev(type, 500));
        if (target) expect(next.status).toBe(target);
        else expect(next).toBe(sample[status]); // identity: ignored transitions allocate nothing
      });
    }
  }

  it("elapsed excludes paused time", () => {
    let s = reduceVoice(INITIAL_VOICE, ev("start", 1000));
    s = reduceVoice(s, ev("pause", 4000)); // 3s recorded
    expect(elapsedOf(s, 99999)).toBe(3000);
    s = reduceVoice(s, ev("resume", 10000));
    expect(elapsedOf(s, 12000)).toBe(5000);
    s = reduceVoice(s, ev("finish", 12000));
    expect(elapsedOf(s, 50000)).toBe(5000);
  });

  it("interrupt keeps the saved segment time, resume after it starts a fresh 0s segment", () => {
    let s = reduceVoice(INITIAL_VOICE, ev("start", 0));
    s = reduceVoice(s, ev("interrupt", 7000));
    expect(s).toMatchObject({ status: "paused", interrupted: true });
    expect(elapsedOf(s, 9000)).toBe(7000);
    s = reduceVoice(s, ev("resume", 20000));
    expect(s.interrupted).toBe(false);
    expect(elapsedOf(s, 21000)).toBe(1000);
  });

  it("segment rollover resets elapsed but keeps recording", () => {
    let s = reduceVoice(INITIAL_VOICE, ev("start", 0));
    s = reduceVoice(s, ev("segment", 5000));
    expect(s.status).toBe("recording");
    expect(elapsedOf(s, 6000)).toBe(1000);
  });

  it("fail records the code; retry via start clears it", () => {
    const f = reduceVoice(INITIAL_VOICE, { type: "fail", at: 0, code: "denied" });
    expect(f).toMatchObject({ status: "failed", error: "denied" });
    expect(reduceVoice(f, ev("start", 1)).error).toBeNull();
  });
});
