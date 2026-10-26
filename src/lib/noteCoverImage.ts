import { callSilent } from "./invoke";
import type { NoteCoverImagesOutput } from "./commands.gen";

/**
 * Kanban card covers. Callers ask per note (each card fetches once it scrolls into view), but
 * requests made in the same tick are coalesced into ONE `note_cover_images` IPC — opening the
 * board used to send one `note_cover_image` per visible card (21 observed). Cards that become
 * visible together (one IntersectionObserver task → one React commit) land in the same batch.
 */

/** Same as Rust NOTE_COVER_BATCH_MAX — a larger pending set is split into several calls. */
const BATCH_MAX = 300;

const coverCache = new Map<string, string | null>();
const coverInFlight = new Map<string, Promise<string | null>>();
const pending = new Map<string, (rel: string | null) => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function getCachedCoverImage(noteId: string): string | null | undefined {
  if (coverCache.has(noteId)) {
    return coverCache.get(noteId);
  }
  return undefined;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (let i = 0; i < batch.length; i += BATCH_MAX) {
    const chunk = batch.slice(i, i + BATCH_MAX);
    const found = new Map<string, string | null>();
    try {
      const r = await callSilent<NoteCoverImagesOutput>("note_cover_images", {
        note_ids: chunk.map(([id]) => id),
      });
      for (const item of r?.items ?? []) found.set(item.note_id, item.rel_path ?? null);
    } catch {
      // callSilent already logged it; covers are decoration — every card falls back to none.
    }
    // Ids the backend skipped (deleted/unknown) or a failed call both resolve to "no cover".
    for (const [id, resolve] of chunk) {
      const rel = found.get(id) ?? null;
      coverCache.set(id, rel);
      coverInFlight.delete(id);
      resolve(rel);
    }
  }
}

export function fetchCoverImage(noteId: string): Promise<string | null> {
  if (coverCache.has(noteId)) {
    return Promise.resolve(coverCache.get(noteId)!);
  }
  let p = coverInFlight.get(noteId);
  if (!p) {
    p = new Promise<string | null>((resolve) => pending.set(noteId, resolve));
    coverInFlight.set(noteId, p);
    flushTimer ??= setTimeout(() => void flush(), 0);
  }
  return p;
}

export function resetCoverImageCache(): void {
  coverCache.clear();
  coverInFlight.clear();
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}
