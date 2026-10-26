import { useNoteThumbs, type ThumbsMap } from "../../lib/noteMeta";

/** Maps attachment.id -> thumbnail rel_path */
export type { ThumbsMap };

/**
 * Attachment thumbnail rel_paths for a note (`attachment_id -> rel_path`). Empty map until
 * fetched — never blocks rendering. Shared per-note cache (lib/noteMeta.ts): refetches on
 * attachmentRevision bumps and on each note open, consumers/remounts within one open share it.
 */
export function useAttachmentThumbs(noteId: string | undefined): ThumbsMap {
  return useNoteThumbs(noteId);
}
