import { reportFallback } from "../lib/diag";
import type { ChunkStore } from "./voiceChunkStore";

/**
 * Hand-off of a finished recording to the caller, and the lifecycle of its crash copy.
 *
 * Shared by `useVoiceRecorder` (a segment just closed) and `useRecoverableRecordings` (a copy left
 * behind by a kill). Both must see the SAME `inflight` set, so it lives only here: a second copy
 * would stop the recovery list from hiding sessions whose upload is still pending.
 */

export interface VoiceResult {
  file: File;
  /** RFC3339 segment start with the phone's LOCAL offset (e.g. 2026-10-04T08:30:00+09:00), see localIso. */
  recordedAt: string;
  durationMs: number;
  lat?: number;
  lng?: number;
  /** Set by handOff: drops this recording's crash copy. A handler whose first upload failed calls it when a later
   *  retry succeeds — otherwise the copy would reappear in the recovery list and be uploaded a second time. Idempotent. */
  confirmSession?: () => Promise<void>;
}
export type VoicePosition = { lat: number; lng: number } | null;
/** When the recorder asks for the position: at the start of a segment (the recording is live and must
 *  not be interrupted) or once it has stopped (a permission dialog can no longer break anything). */
export type VoicePositionPhase = "start" | "stop";
/** What a `getPosition` provider answers. `"later"` (start phase only) = "reading it now could pop a
 *  permission dialog over the live recorder — ask me again after the recording stops". */
export type VoicePositionAnswer = VoicePosition | "later";

/**
 * Resolve true ONLY once the file is safely stored (uploaded). The crash copy in IndexedDB is dropped
 * on true and kept on false/throw/void — a void return is "unconfirmed", never "ok".
 */
export type FinishedHandler = (r: VoiceResult) => Promise<boolean> | boolean | void;

/** True while the recorder sheet is mounted — an upload failure of a recording is then already shown on the sheet
 *  (result stage), so the upload line skips its toast (X-8). Module state: one sheet at a time. */
let recorderSheetOpen = false;
export const setRecorderSheetOpen = (open: boolean): void => { recorderSheetOpen = open; };
export const isRecorderSheetOpen = (): boolean => recorderSheetOpen;

/** Sessions handed to onFinished whose confirmation is still pending — hidden from the recovery list. */
const inflight = new Set<string>();
export const isInflight = (sessionId: string): boolean => inflight.has(sessionId);

/** Hand `r` to the caller without waiting for the upload (a long upload must not stall a rollover);
 *  drop the crash copy later, only when the caller confirms. */
export function handOff(
  handler: FinishedHandler,
  sessionId: string,
  r: VoiceResult,
  store: ChunkStore,
  warn: (e: unknown) => void,
): boolean {
  let ret: ReturnType<FinishedHandler>;
  try {
    ret = handler({ ...r, confirmSession: () => store.deleteSession(sessionId) });
  } catch (e) {
    reportFallback("voice", "on_finished_failed", e instanceof Error ? e.message : "onFinished threw");
    return false;
  }
  inflight.add(sessionId);
  void Promise.resolve(ret)
    .then(async (ok) => {
      if (ok === true) await store.deleteSession(sessionId);
    })
    .catch((e) => {
      reportFallback("voice", "on_finished_failed", e instanceof Error ? e.message : "onFinished rejected");
      warn(e);
    })
    .finally(() => inflight.delete(sessionId));
  return true;
}
