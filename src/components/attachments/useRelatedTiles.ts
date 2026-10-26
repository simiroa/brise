import { useEffect, useMemo } from "react";
import type { Attachment, NoteDetail, NoteSummary, Suggestion } from "../../lib/commands.gen";
import { useAutoRelated } from "./useAutoRelated";
import { useManualRelated } from "./useManualRelated";
import { useRelatedClickPreview } from "./useRelatedClickPreview";
import { useSuggestionsStore } from "../../stores/suggestions";

// "Notes liées" tab: one merged, deduped list of manual internal-attachment links and
// note_related's auto-computed suggestions. Manual wins on collision (see relatedTiles below).
export type RelatedTile =
  | { kind: "manual"; attachment: Attachment; note: NoteSummary | undefined }
  | { kind: "auto"; note: NoteSummary; suggestion?: Suggestion };

/** Stable empty attachments — `activeNote?.attachments ?? []` allocates a fresh [] every
 * render when there is no note / no attachments, which churns useMemo deps and can drive
 * an effect→setState loop. */
const EMPTY_ATTACHMENTS: Attachment[] = [];

/** Related-notes derivation + preview handlers for the "Notes liées" tab.
 * Manual links, auto suggestions, and click-debounce preview are separate modules;
 * this hook only merges them. JSX stays in AttachmentsBar.
 * `autoRefreshKey` is forwarded to useAutoRelated so exclude/restore can re-fetch without
 * changing noteId (otherwise it refetches only on a new note open — lib/noteMeta.ts). */
export function useRelatedTiles(
  activeNote: NoteDetail | null,
  pendingRemovedIds: Set<string>,
  autoRefreshKey = 0,
) {
  const attachments = activeNote?.attachments ?? EMPTY_ATTACHMENTS;
  const noteId = activeNote?.note.id;

  const autoRelated = useAutoRelated(noteId, autoRefreshKey);
  const manualNotesById = useManualRelated(attachments);
  const { openRelatedNote, scheduleRelatedPreview } = useRelatedClickPreview();
  const suggestions = useSuggestionsStore((s) => s.suggestions);

  // Pending suggestions are workspace-wide, not per-note — fetch once on mount and re-fetch only
  // on `autoRefreshKey` bumps, which AttachmentsBar fires solely on real mutations (exclude/
  // restore, accept-suggestion). Switching the active note must NOT re-trigger this.
  useEffect(() => {
    void useSuggestionsStore.getState().loadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshKey]);

  // Index pending overlap suggestions by normalized (lo,hi) note-id pair once per
  // suggestions-array change, so the relatedTiles memo below can do an O(1) lookup per
  // auto-related note instead of an O(n) `.find()` scan.
  const overlapSuggestionByPair = useMemo(() => {
    const map = new Map<string, Suggestion>();
    for (const s of suggestions) {
      if (s.kind !== "overlap") continue;
      const key = s.note_id < s.related_note_id ? `${s.note_id}|${s.related_note_id}` : `${s.related_note_id}|${s.note_id}`;
      map.set(key, s);
    }
    return map;
  }, [suggestions]);

  // Merge manual (internal attachment) + auto (note_related) links into one deduped list.
  // Manual wins on collision — if a note is both manually linked and auto-suggested, it shows
  // once, as the manual (removable) tile.
  const relatedTiles: RelatedTile[] = useMemo(() => {
    const seen = new Set<string>();
    const out: RelatedTile[] = [];
    for (const a of attachments) {
      if (a.kind !== "internal" || !a.url) continue;
      if (pendingRemovedIds.has(a.id)) continue;
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      out.push({ kind: "manual", attachment: a, note: manualNotesById.get(a.url) });
    }
    for (const n of autoRelated) {
      if (seen.has(n.id) || pendingRemovedIds.has(n.id)) continue;
      seen.add(n.id);
      const suggestion = noteId
        ? overlapSuggestionByPair.get(noteId < n.id ? `${noteId}|${n.id}` : `${n.id}|${noteId}`)
        : undefined;
      out.push({ kind: "auto", note: n, suggestion });
    }
    return out;
  }, [attachments, autoRelated, manualNotesById, pendingRemovedIds, noteId, overlapSuggestionByPair]);

  return { relatedTiles, openRelatedNote, scheduleRelatedPreview };
}

