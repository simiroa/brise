import { useCallback, useEffect, useRef, useState } from "react";
import { reportFallback } from "../lib/diag";
import { getDefaultChunkStore, type ChunkStore, type StoredSession } from "./voiceChunkStore";
import { buildFile, localIso, TIMESLICE_MS } from "./voiceFormat";
import { handOff, isInflight, type FinishedHandler } from "./voiceHandOff";

/** Unsaved recordings left behind by a crash/kill (plan §5.2 "크래시 보호"). */
export function useRecoverableRecordings(opts: {
  enabled: boolean;
  onRecovered: FinishedHandler;
  store?: ChunkStore;
}) {
  const storeRef = useRef<ChunkStore>(opts.store ?? getDefaultChunkStore());
  const onRecoveredRef = useRef(opts.onRecovered);
  onRecoveredRef.current = opts.onRecovered;
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  /** The first listing finished (or failed) — the sheet waits for it before auto-starting (X-10). */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!opts.enabled) return;
    let cancelled = false;
    storeRef.current
      .listSessions()
      .then(async (list) => {
        // A session with no chunks is a start that died before the first slice — nothing to offer.
        for (const s of list) if (s.chunkCount === 0) await storeRef.current.deleteSession(s.id);
        if (cancelled) return;
        setSessions(list.filter((s) => s.chunkCount > 0 && !isInflight(s.id)));
        setLoaded(true);
      })
      .catch((e) => {
        reportFallback("voice", "recovery_list_failed", e instanceof Error ? e.message : "list failed");
        if (!cancelled) setLoaded(true); // a failed read must not block recording forever
      });
    return () => { cancelled = true; };
  }, [opts.enabled]);

  const recover = useCallback(async (id: string): Promise<boolean> => {
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return false;
    const chunks = await storeRef.current.getChunks(id);
    const startedAt = Date.parse(meta.startedAt);
    const file = buildFile(chunks, meta.mimeType, startedAt);
    if (!file) {
      await storeRef.current.deleteSession(id);
      setSessions((p) => p.filter((s) => s.id !== id));
      return false;
    }
    // ponytail: duration is estimated from the slice count (+-5s); exact needs decoding the audio.
    // 업로드가 확인된 뒤에만 보호본을 지운다 — 실패하면 남아서 다음 시트 열림에 다시 안내된다.
    handOff(
      (x) => onRecoveredRef.current(x),
      id,
      { file, recordedAt: localIso(startedAt), durationMs: chunks.length * TIMESLICE_MS },
      storeRef.current,
      () => {},
    );
    setSessions((p) => p.filter((s) => s.id !== id));
    return true;
  }, [sessions]);

  const discard = useCallback(async (id: string) => {
    await storeRef.current.deleteSession(id);
    setSessions((p) => p.filter((s) => s.id !== id));
  }, []);

  return { sessions, loaded, recover, discard };
}
