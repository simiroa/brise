import { useCallback, useEffect, useRef, useState } from "react";
import { reportFallback } from "../lib/diag";
import { publishRecLevel, resetRecLevel, useMobileAmbientStore } from "../stores/mobileAmbient";
import { getDefaultChunkStore, type ChunkStore } from "./voiceChunkStore";
import { baseMime, BITRATE, buildFile, localIso, pickMimeType, SPLIT_BYTES, TIMESLICE_MS } from "./voiceFormat";
import {
  handOff,
  type FinishedHandler,
  type VoicePosition,
  type VoicePositionAnswer,
  type VoicePositionPhase,
  type VoiceResult,
} from "./voiceHandOff";
import { startLevelMeter, type LevelMeter } from "./voiceLevelMeter";
import {
  elapsedOf,
  INITIAL_VOICE,
  reduceVoice,
  type VoiceErrorCode,
  type VoiceEvent,
  type VoiceMachine,
} from "./voiceRecorderMachine";

/**
 * Live recorder hook: owns the MediaRecorder session lifecycle (start / pause / resume / finish /
 * cancel / background-interrupt / size-cap rollover) and wires it to the pure pieces around it —
 * `voiceRecorderMachine` (status), `voiceFormat` (mime/split/file), `voiceChunkStore` (crash copy),
 * `voiceHandOff` (deliver + drop the crash copy), `voiceLevelMeter` (bars + silence hint).
 * Crash recovery of earlier sessions is the sibling `useRecoverableRecordings`.
 */

// Compat: MobileNote.tsx (outside this split) still imports the type from here.
export type { VoicePosition } from "./voiceHandOff";

const POSITION_WAIT_MS = 2000;
/** A position deferred to after the recording stopped (see `voicePositionPolicy`): the first read can sit
 *  behind a system permission dialog, so wait longer than for a read that ran during the recording. */
const STOP_POSITION_WAIT_MS = 8000;
const LOW_TIME_MS = 5 * 60 * 1000;

/** `p`, or null once `ms` has passed (the read keeps running; its late answer is ignored). */
async function withTimeout(p: Promise<VoicePosition>, ms: number): Promise<VoicePosition> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<VoicePosition>((res) => { timer = setTimeout(() => res(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyMicError(e: unknown): VoiceErrorCode {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_mic";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unknown";
}

interface Session {
  id: string;
  rec: MediaRecorder;
  mime: string;
  chunks: Blob[];
  bytes: number;
  seq: number;
  startedAt: number;
  pos: Promise<VoicePosition>;
  /** The start-phase provider answered "later": ask again once the recording has stopped. */
  posLater: boolean;
  ending: boolean;
}

export interface UseVoiceRecorderOpts {
  onFinished: FinishedHandler;
  /** Position provider (MobileNote maps the device location mode + permission memory). Called with "start"
   *  at the start of every segment — it must NOT pop a permission dialog over the live recorder, so it answers
   *  `"later"` when it would — and, only after such a "later", once more with "stop" when the segment has
   *  stopped. null = no fix: the recording carries on without coordinates. */
  getPosition?: (phase: VoicePositionPhase) => Promise<VoicePositionAnswer>;
  /** Test seam; defaults to the shared IndexedDB store. */
  store?: ChunkStore;
}

export function useVoiceRecorder({ onFinished, getPosition, store }: UseVoiceRecorderOpts) {
  const storeRef = useRef<ChunkStore>(store ?? getDefaultChunkStore());
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const getPositionRef = useRef(getPosition);
  getPositionRef.current = getPosition;

  const machineRef = useRef<VoiceMachine>(INITIAL_VOICE);
  const [m, setM] = useState<VoiceMachine>(INITIAL_VOICE);
  const [now, setNow] = useState(() => Date.now());
  const [bytes, setBytes] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);

  const sessionRef = useRef<Session | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef = useRef<LevelMeter | null>(null);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);
  const interruptRef = useRef<() => Promise<void>>(async () => {});
  const busyRef = useRef(false); // start/rollover/interrupt in flight
  /** False once the hook unmounted. The sheet now starts recording the moment it opens, so a close while the
   *  permission dialog is still up (getUserMedia pending) is common — the late stream must not start a recorder. */
  const aliveRef = useRef(true);
  const storeWarnedRef = useRef(false);

  const dispatch = useCallback((ev: { type: VoiceEvent["type"]; code?: VoiceErrorCode }) => {
    machineRef.current = reduceVoice(machineRef.current, { at: Date.now(), ...ev } as VoiceEvent);
    setM(machineRef.current);
  }, []);

  const warnStore = useCallback((e: unknown) => {
    if (storeWarnedRef.current) return;
    storeWarnedRef.current = true;
    reportFallback("voice", "chunk_store_failed", e instanceof Error ? e.message : "store write failed");
  }, []);

  const release = useCallback(() => {
    meterRef.current?.stop();
    meterRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void wakeRef.current?.release().catch(() => { /* silent-ok: lock may already be released by the OS */ });
    wakeRef.current = null;
    setLevel(0);
    setSilent(false);
    resetRecLevel();
  }, []);

  const fail = useCallback((code: VoiceErrorCode) => {
    const s = sessionRef.current;
    if (s) {
      s.ending = true;
      s.rec.onstop = null;
      try { if (s.rec.state !== "inactive") s.rec.stop(); } catch { /* silent-ok: recorder already dead; chunks stay in the store for recovery */ }
    }
    sessionRef.current = null;
    release();
    dispatch({ type: "fail", code });
  }, [dispatch, release]);

  const startSession = useCallback((stream: MediaStream) => {
    const mime = pickMimeType();
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: BITRATE });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    const usedMime = rec.mimeType || mime || "audio/webm";
    const s: Session = { id, rec, mime: usedMime, chunks: [], bytes: 0, seq: 0, startedAt, ending: false,
      pos: Promise.resolve(null), posLater: false };
    const gp = getPositionRef.current;
    if (gp) {
      s.pos = gp("start").then(
        (a) => {
          if (a === "later") { s.posLater = true; return null; }
          return a;
        },
        (e) => {
          reportFallback("voice", "position_failed", e instanceof Error ? e.message : "position failed");
          return null;
        },
      );
    }
    storeRef.current
      .putSession({ id, mimeType: baseMime(usedMime), startedAt: localIso(startedAt) })
      .catch(warnStore);
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        s.chunks.push(e.data);
        s.bytes += e.data.size;
        storeRef.current.putChunk(id, s.seq++, e.data).catch(warnStore);
        setBytes(s.bytes);
      }
      // Cap reached: finish this file and keep going in a new one.
      if (!s.ending && s.bytes >= SPLIT_BYTES) void rollover();
    };
    rec.onerror = () => {
      if (s.ending) return;
      // 이미 받은 청크가 있으면 버리지 않고 인터럽트 경로로 확정한다(앱이 백그라운드로 갈 때와 같다).
      if (s.chunks.length > 0) void interruptRef.current();
      else fail("unknown");
    };
    sessionRef.current = s;
    setBytes(0);
    rec.start(TIMESLICE_MS);
    // `rollover` is declared below; it is only read when a slice arrives, long after render.
  }, [fail, warnStore]);

  /** Stop the recorder, wait for the final slice, assemble the file. Does NOT touch the store.
   *  `continues` = a rollover: recording goes on in a new file right after, so a deferred position is NOT asked
   *  for now (a permission dialog mid-recording is exactly what the deferral avoids, and the wait would be audio lost). */
  const closeSession = useCallback(async (s: Session, durationMs: number, continues = false): Promise<VoiceResult | null> => {
    s.ending = true;
    if (s.rec.state !== "inactive") {
      const stopped = new Promise<void>((res) => { s.rec.onstop = () => res(); });
      s.rec.stop();
      await stopped;
    }
    const file = buildFile(s.chunks, s.mime, s.startedAt);
    if (!file) return null;
    let pos = await withTimeout(s.pos, POSITION_WAIT_MS);
    const gp = getPositionRef.current;
    if (!pos && s.posLater && gp && !continues && !document.hidden) {
      // The start-phase read was deferred so a permission dialog would not land on the live recorder. The
      // recording has stopped (the file is already assembled), so asking now interrupts nothing. Not while the
      // app is backgrounded (an interruption save): there is no screen for a dialog, and the save must not wait.
      pos = await withTimeout(
        gp("stop").then(
          (a) => (a === "later" ? null : a),
          (e) => {
            reportFallback("voice", "position_failed", e instanceof Error ? e.message : "position failed");
            return null;
          },
        ),
        STOP_POSITION_WAIT_MS,
      );
    }
    return {
      file,
      recordedAt: localIso(s.startedAt),
      durationMs,
      ...(pos ? { lat: pos.lat, lng: pos.lng } : {}),
    };
  }, []);

  /** Hand the file to the caller; the crash copy goes only after the caller confirms (see FinishedHandler). */
  const emit = useCallback((s: Session, r: VoiceResult) => {
    handOff((x) => onFinishedRef.current(x), s.id, r, storeRef.current, warnStore);
  }, [warnStore]);

  const rollover = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.ending || busyRef.current) return;
    busyRef.current = true;
    try {
      const r = await closeSession(s, elapsedOf(machineRef.current, Date.now()), true);
      if (r) emit(s, r);
      if (streamRef.current) startSession(streamRef.current);
      dispatch({ type: "segment" });
    } finally {
      busyRef.current = false;
    }
  }, [closeSession, dispatch, emit, startSession]);

  const begin = useCallback(async (): Promise<boolean> => {
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no mediaDevices"), { name: "NotFoundError" });
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!aliveRef.current) return false;
      const code = classifyMicError(e);
      if (code === "unknown") reportFallback("voice", "mic_error", e instanceof Error ? e.name : "unknown");
      fail(code);
      return false;
    }
    if (!aliveRef.current) {
      // Closed while the mic was being granted: hand the mic straight back, start nothing.
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    if (typeof MediaRecorder === "undefined") {
      stream.getTracks().forEach((t) => t.stop());
      reportFallback("voice", "no_media_recorder");
      fail("unknown");
      return false;
    }
    streamRef.current = stream;
    try {
      startSession(stream);
    } catch (e) {
      reportFallback("voice", "recorder_start_failed", e instanceof Error ? e.message : "start failed");
      fail("unknown");
      return false;
    }
    // Level meter. Optional: a webview without AudioContext just has no bars.
    try {
      meterRef.current = startLevelMeter(stream, {
        isRecording: () => machineRef.current.status === "recording",
        // 시트의 막대(setLevel)와 화면 바닥 이퀄라이저(MobileAmbient)가 같은 샘플을 쓴다. 후자는 상태가 아니라 비반응 채널이다.
        onLevel: (lv) => {
          setLevel(lv);
          publishRecLevel(lv);
        },
        onSilent: setSilent,
      });
    } catch (e) {
      reportFallback("voice", "analyser_failed", e instanceof Error ? e.message : "analyser failed");
    }
    // Screen-off protection. Optional too.
    const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (wl) {
      wl.request("screen").then((l) => {
        // The request can resolve after this session already ended (finish/cancel/unmount ran release()):
        // storing it then would hold the screen on with nothing recording.
        if (streamRef.current !== stream) {
          void l.release().catch(() => { /* silent-ok: lock may already be released by the OS */ });
          return;
        }
        wakeRef.current = l;
      }).catch((e) =>
        reportFallback("voice", "wakelock_failed", e instanceof Error ? e.message : "wake lock failed"));
    }
    navigator.vibrate?.(40);
    return true;
  }, [fail, startSession]);

  const start = useCallback(async () => {
    const st = machineRef.current.status;
    if (busyRef.current || (st !== "idle" && st !== "failed")) return;
    busyRef.current = true;
    try {
      if (await begin()) dispatch({ type: "start" });
    } finally {
      busyRef.current = false;
    }
  }, [begin, dispatch]);

  const pause = useCallback(() => {
    const s = sessionRef.current;
    if (machineRef.current.status !== "recording" || !s) return;
    s.rec.pause();
    dispatch({ type: "pause" });
  }, [dispatch]);

  const resume = useCallback(async () => {
    const cur = machineRef.current;
    if (cur.status !== "paused" || busyRef.current) return;
    if (cur.interrupted) {
      // The previous recorder is gone (and already saved) — a resume is a brand-new segment.
      busyRef.current = true;
      try {
        if (await begin()) dispatch({ type: "resume" });
      } finally {
        busyRef.current = false;
      }
      return;
    }
    sessionRef.current?.rec.resume();
    dispatch({ type: "resume" });
  }, [begin, dispatch]);

  /** Resolves true when the file was handed to onFinished. */
  const finish = useCallback(async (): Promise<boolean> => {
    const st = machineRef.current.status;
    const s = sessionRef.current;
    if ((st !== "recording" && st !== "paused") || !s || busyRef.current) return false;
    busyRef.current = true;
    try {
      const dur = elapsedOf(machineRef.current, Date.now());
      dispatch({ type: "finish" });
      const r = await closeSession(s, dur);
      sessionRef.current = null;
      release();
      if (!r) {
        await storeRef.current.deleteSession(s.id).catch(warnStore);
        dispatch({ type: "fail", code: "empty" });
        return false;
      }
      emit(s, r);
      dispatch({ type: "done" });
      navigator.vibrate?.(40);
      return true;
    } finally {
      busyRef.current = false;
    }
  }, [closeSession, dispatch, emit, release, warnStore]);

  const cancel = useCallback(() => {
    const s = sessionRef.current;
    if (machineRef.current.status !== "recording" && machineRef.current.status !== "paused") return;
    if (s) {
      s.ending = true;
      s.rec.ondataavailable = null;
      s.rec.onstop = null;
      try { if (s.rec.state !== "inactive") s.rec.stop(); } catch { /* silent-ok: already stopped, we are discarding anyway */ }
      void storeRef.current.deleteSession(s.id).catch(warnStore);
    }
    sessionRef.current = null;
    release();
    dispatch({ type: "cancel" });
  }, [dispatch, release, warnStore]);

  // Backgrounded (or the recorder died mid-way): the webview may kill the recording silently, so save what we have right now.
  const interruptAndSave = useCallback(async () => {
    const st = machineRef.current.status;
    const s = sessionRef.current;
    if ((st !== "recording" && st !== "paused") || !s || busyRef.current) return;
    busyRef.current = true;
    try {
      const dur = elapsedOf(machineRef.current, Date.now());
      dispatch({ type: "interrupt" });
      const r = await closeSession(s, dur);
      sessionRef.current = null;
      release();
      if (r) emit(s, r);
      else await storeRef.current.deleteSession(s.id).catch(warnStore);
    } finally {
      busyRef.current = false;
    }
  }, [closeSession, dispatch, emit, release, warnStore]);
  interruptRef.current = interruptAndSave;
  useEffect(() => {
    const onVis = () => { if (document.hidden) void interruptAndSave(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [interruptAndSave]);

  // Elapsed ticker (only while the clock is running).
  useEffect(() => {
    if (m.status !== "recording") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [m.status]);

  // Ambient screen signal (MobileAmbient's bottom equalizer): on only while audio is actually being captured. An interrupted
  // pause (the recorder is already gone and saved) is NOT a live recording, so it is off too.
  useEffect(() => {
    useMobileAmbientStore.getState().setRec(
      m.status === "recording" ? "on" : m.status === "paused" && !m.interrupted ? "paused" : "off",
    );
  }, [m.status, m.interrupted]);
  // Whatever way this recorder goes away (sheet closed, discard, parent unmount) the signal must not outlive it.
  useEffect(() => () => useMobileAmbientStore.getState().setRec("off"), []);

  // Unmount while live (parent closed us): stop, keep the chunks — the next open offers recovery.
  // Setup re-arms `aliveRef` so StrictMode's simulated unmount/remount does not leave it false.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const s = sessionRef.current;
      if (s) {
        s.ending = true;
        s.rec.onstop = null;
        try { if (s.rec.state !== "inactive") s.rec.stop(); } catch { /* silent-ok: unmounting */ }
      }
      release();
    };
  }, [release]);

  const live = m.status === "recording" || m.status === "paused";
  const remainingMs = Math.max(0, Math.floor(((SPLIT_BYTES - bytes) / (BITRATE / 8)) * 1000));
  return {
    machine: m,
    status: m.status,
    error: m.error,
    interrupted: m.interrupted,
    elapsedMs: elapsedOf(m, now),
    level,
    silent,
    remainingMs,
    lowTime: live && remainingMs <= LOW_TIME_MS,
    start,
    pause,
    resume,
    finish,
    cancel,
  };
}
