/**
 * Input level meter + long-silence detector for the recorder sheet. Optional by design: a webview
 * without AudioContext simply has no bars (`startLevelMeter` returns null).
 *
 * Reads the live MediaStream through an AnalyserNode every 100ms and reports an RMS level in 0..1;
 * `onSilent(true)` fires once the level has stayed under QUIET_LEVEL for SILENCE_MS (the sheet's
 * mobileVoice.silent_hint). Only samples while `isRecording()` — paused/idle clears the silence clock.
 */

import { reportFallback } from "../lib/diag";

export const SILENCE_MS = 6000;
const QUIET_LEVEL = 0.02;
const SAMPLE_MS = 100;

export interface LevelMeter {
  /** Stop sampling and close the AudioContext. Safe to call more than once. */
  stop(): void;
}

export interface LevelMeterOpts {
  isRecording: () => boolean;
  onLevel: (level: number) => void;
  onSilent: (silent: boolean) => void;
}

export function startLevelMeter(stream: MediaStream, { isRecording, onLevel, onSilent }: LevelMeterOpts): LevelMeter | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  // 녹음이 시트가 열리자마자 시작되면(탭 없이) 브라우저가 AudioContext 를 suspended 로 만들 수 있다 —
  // 그러면 막대가 죽고 "소리가 안 들려요" 안내가 거짓으로 뜬다. 마이크 스트림이 이미 허락됐으니 깨운다.
  if (ctx.state === "suspended") {
    void ctx.resume?.().catch((e: unknown) =>
      reportFallback("voice", "level_meter_resume_failed", e instanceof Error ? e.message.slice(0, 60) : "error"),
    );
  }
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  let quietSince: number | null = null;
  const timer = setInterval(() => {
    if (!isRecording()) { quietSince = null; onSilent(false); return; }
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const lv = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    onLevel(lv);
    if (lv < QUIET_LEVEL) {
      quietSince ??= Date.now();
      onSilent(Date.now() - quietSince >= SILENCE_MS);
    } else {
      quietSince = null;
      onSilent(false);
    }
  }, SAMPLE_MS);
  return {
    stop() {
      clearInterval(timer);
      void ctx.close?.()?.catch?.(() => { /* silent-ok: closing an already-closed context */ });
    },
  };
}
