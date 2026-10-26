import type { NoteSummary } from "../../lib/commands.gen";
import { useNoteRelated } from "../../lib/noteMeta";

/** note_related auto suggestions — backlink×100 + same-event-date(30) + shared-attachment×15 +
 * shared-tag×10 + year proximity, one score-sorted list (see specs/commands/notes.yaml).
 *
 * Re-fetches on each note open (selectNote) OR when `refreshKey` bumps — exclude/restore must pass
 * a new refreshKey (see AttachmentsBar). Remounts within one open reuse the shared cache
 * (lib/noteMeta.ts). */
export function useAutoRelated(noteId: string | undefined, refreshKey = 0): NoteSummary[] {
  return useNoteRelated(noteId, refreshKey);
}
