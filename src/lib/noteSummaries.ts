/**
 * By-id note summary resolution (Wave A-4).
 * Replaces resident-corpus `noteIndex.get` for call sites that only know an id.
 */
import { call } from "./invoke";
import type { NoteSummary } from "./commands.gen";

/** Batch-fetch summaries for the given ids. Missing / trashed ids are omitted. */
export async function fetchNoteSummariesMap(
  ids: string[]
): Promise<Record<string, NoteSummary>> {
  if (ids.length === 0) return {};
  // Dedupe while preserving first-seen order for stable cache merges.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length === 0) return {};
  const r = await call<{ notes: Record<string, NoteSummary> }>("note_summaries_map", {
    ids: unique,
  });
  return r.notes ?? {};
}

/** Resolve one id; returns null when missing / trashed. */
export async function fetchNoteSummary(id: string): Promise<NoteSummary | null> {
  const map = await fetchNoteSummariesMap([id]);
  return map[id] ?? null;
}
