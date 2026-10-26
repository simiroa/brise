/**
 * Pure helper for turning an editor text selection into a new note's title (발췌 title). A
 * multi-line selection is collapsed to a single line first.
 */

/** Collapse all whitespace runs (including newlines from a multi-paragraph selection) to a
 *  single space, and trim the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** First ~40 chars of the selection's plain text, for the new note's title. Empty when the
 *  selection is all whitespace — caller falls back to the app's usual "untitled" label. */
export function deriveExcerptTitle(text: string): string {
  return collapseWhitespace(text).slice(0, 40).trim();
}
