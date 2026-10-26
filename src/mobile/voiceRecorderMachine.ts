/**
 * Recorder state machine (pure). Scope = the recorder sheet only (which dispatches `start` as soon as it opens —
 * PLAN-2026-10-10 W-B; idle is only the moment the mic is being granted); upload and transcription belong
 * to the caller (plan §5.2). One "segment" = one output file: an interruption (backgrounded app) or
 * the size cap ends a segment, so `elapsedMs` always describes the CURRENT segment.
 *
 *   idle -start-> recording <-> paused      recording/paused -finish-> finishing -done-> done
 *   recording/paused -interrupt-> paused(interrupted) -resume-> recording (new segment, 0s)
 *   recording -segment-> recording (size cap rollover, elapsed resets)
 *   recording/paused -cancel-> idle      any live state -fail-> failed -reset-> idle / start-> recording
 * Every pair not listed is ignored: `reduceVoice` returns the SAME object (identity is the contract).
 */
export type VoiceStatus = "idle" | "recording" | "paused" | "finishing" | "done" | "failed";
export type VoiceErrorCode = "denied" | "no_mic" | "busy" | "empty" | "unknown";

export interface VoiceMachine {
  status: VoiceStatus;
  /** Milliseconds banked so far; add `now - since` while `since` is set (recording). */
  elapsedMs: number;
  since: number | null;
  interrupted: boolean;
  error: VoiceErrorCode | null;
}

export type VoiceEvent =
  | { type: "start" | "pause" | "resume" | "finish" | "cancel" | "interrupt" | "segment" | "done" | "reset"; at: number }
  | { type: "fail"; at: number; code: VoiceErrorCode };

export const INITIAL_VOICE: VoiceMachine = { status: "idle", elapsedMs: 0, since: null, interrupted: false, error: null };

export function elapsedOf(m: VoiceMachine, now: number): number {
  return m.elapsedMs + (m.since != null ? Math.max(0, now - m.since) : 0);
}

const failed = (code: VoiceErrorCode): VoiceMachine => ({ ...INITIAL_VOICE, status: "failed", error: code });
const recordingFrom = (at: number): VoiceMachine => ({ ...INITIAL_VOICE, status: "recording", since: at });

export function reduceVoice(m: VoiceMachine, ev: VoiceEvent): VoiceMachine {
  const at = ev.at;
  switch (m.status) {
    case "idle":
      if (ev.type === "start") return recordingFrom(at);
      if (ev.type === "fail") return failed(ev.code);
      return m;
    case "recording":
      switch (ev.type) {
        case "pause": return { ...m, status: "paused", elapsedMs: elapsedOf(m, at), since: null };
        case "interrupt": return { ...m, status: "paused", elapsedMs: elapsedOf(m, at), since: null, interrupted: true };
        case "finish": return { ...m, status: "finishing", elapsedMs: elapsedOf(m, at), since: null };
        case "segment": return { ...m, elapsedMs: 0, since: at };
        case "cancel": return INITIAL_VOICE;
        case "fail": return failed(ev.code);
        default: return m;
      }
    case "paused":
      switch (ev.type) {
        // After an interruption the old segment is already saved: resuming starts a fresh one.
        case "resume": return m.interrupted ? recordingFrom(at) : { ...m, status: "recording", since: at };
        case "finish": return { ...m, status: "finishing" };
        case "cancel": return INITIAL_VOICE;
        case "fail": return failed(ev.code);
        default: return m;
      }
    case "finishing":
      if (ev.type === "done") return { ...m, status: "done" };
      if (ev.type === "fail") return failed(ev.code);
      return m;
    case "done":
      return ev.type === "reset" ? INITIAL_VOICE : m;
    case "failed":
      if (ev.type === "reset") return INITIAL_VOICE;
      if (ev.type === "start") return recordingFrom(at);
      if (ev.type === "fail") return { ...m, error: ev.code };
      return m;
  }
}
