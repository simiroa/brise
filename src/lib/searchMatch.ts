/** One navigable search hit: tree row index + note id. Headers (empty, …) are skipped. */
export type SearchMatch = { rowIndex: number; noteId: string };

/** Minimal row shape — avoids importing the full TreeRow union into the store layer. */
export type MatchableRow = { kind: string; note?: { id: string } };

/**
 * Walk flattened search rows in display order.
 * Skips non-note rows so the cursor never lands on empty placeholders.
 */
export function collectSearchMatches(rows: MatchableRow[]): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "note" && row.note) {
      out.push({ rowIndex: i, noteId: row.note.id });
    }
  }
  return out;
}

/**
 * Step the match cursor. null means "no current match".
 * First ArrowDown from none → 0; first ArrowUp from none → last.
 * Clamps at ends (no wrap) so stepping past the last hit is a no-op.
 */
export function stepMatchCursor(
  cursor: number | null,
  delta: number,
  matchCount: number,
): number | null {
  if (matchCount <= 0) return null;
  if (cursor === null) {
    return delta >= 0 ? 0 : matchCount - 1;
  }
  return Math.max(0, Math.min(matchCount - 1, cursor + delta));
}

/** When the result list shrinks or grows, keep a live cursor in range; empty list → none. */
export function clampMatchCursor(cursor: number | null, matchCount: number): number | null {
  if (cursor === null || matchCount <= 0) return null;
  return Math.max(0, Math.min(matchCount - 1, cursor));
}
