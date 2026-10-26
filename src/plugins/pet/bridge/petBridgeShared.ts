import { emit } from "@tauri-apps/api/event";
import { callSilent } from "../../../lib/invoke";
import type { SearchNotesOutput } from "../../../lib/commands.gen";
import { appendSectionWithBody, createInboxMemo } from "../../../lib/noteActions";
import { PET_EVENT } from "./petEvents";

/** Notify the pet window. Failures are silent — the pet window may already be closed. */
export function petSignal(kind: string): void {
  void emit(PET_EVENT.signal, { kind }).catch(() => {});
}

/** Preview length for the 260px pet bubble. */
export const PREVIEW_CHARS = 180;
/** Search query cap — clipboard/screenshot bodies can be a whole document. */
export const QUERY_CHARS = 300;

export async function searchTopHit(query: string): Promise<{ id: string; title: string } | null> {
  const q = query.trim();
  if (!q) return null;
  const hit = await callSilent<SearchNotesOutput>("search_notes", { query: q.slice(0, QUERY_CHARS) })
    .then((r) => r.results[0] ?? null)
    .catch(() => null);
  return hit ? { id: hit.id, title: hit.title } : null;
}

export async function saveToTargetOrInbox(opts: {
  choice: string;
  targetNoteId: string | null;
  targetTitle: string | null;
  title?: string;
  body: string;
}): Promise<{ noteId: string; noteTitle: string }> {
  if (opts.choice === "append" && opts.targetNoteId) {
    await appendSectionWithBody(opts.targetNoteId, opts.title, opts.body);
    return { noteId: opts.targetNoteId, noteTitle: opts.targetTitle ?? "" };
  }
  const created = await createInboxMemo(opts.body, opts.title);
  return { noteId: created.note_id, noteTitle: created.title };
}
