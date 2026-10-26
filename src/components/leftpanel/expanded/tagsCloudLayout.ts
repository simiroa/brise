/**
 * Pure layout helpers for the Tags expanded cloud.
 * Chips wrap into rows so a virtual list can mount only the visible strips —
 * a few thousand tags must not become a few thousand DOM nodes.
 */

/** Chip horizontal padding + border, matching chipStyle (--space-2 each side). */
const CHIP_H_PAD = 14;
/** Gap between the tag name and its count, plus the count's own left margin. */
const COUNT_GAP = 4;
/** Selected chips carry a 6px dot with a 4px margin. Budget it for every chip so
 *  selecting one never reflows the row it sits in. */
const DOT_W = 10;

// ponytail: character-width estimate, not real text metrics. Chips are --text-xs in a
// single line, so a per-character average is within a few px and a row that guesses
// slightly wide just wraps one chip early. Upgrade to canvas measureText only if the
// packing visibly misfits (mixed scripts at large tag counts is the likely trigger).
function charWidth(ch: string): number {
  // CJK / Hangul are full-width; latin digits and letters are roughly half that.
  return ch.charCodeAt(0) > 0x1100 ? 11 : 6.2;
}

export const ADD_TAG_KEY = "__ADD_TAG__";

export function estimateChipWidth(tag: string, count: number, isAdding = false): number {
  if (tag === ADD_TAG_KEY) {
    return isAdding ? 110 : 28;
  }
  let w = CHIP_H_PAD + DOT_W + COUNT_GAP;
  for (const ch of tag) w += charWidth(ch);
  w += String(count).length * 6.2;
  return w;
}

/**
 * Pack tag names into rows that fill `containerWidth` — as many chips per row as fit,
 * not a fixed column count. Chips are content-sized, so a short tag no longer reserves
 * a full column's worth of empty space.
 *
 * Always emits at least one chip per row: a tag wider than the container gets its own
 * row and ellipsises inside it rather than producing an empty row and looping forever.
 */
export function packTagsIntoRows(
  tags: string[],
  counts: Map<string, number>,
  containerWidth: number,
  gap = 4,
  isAdding = false,
): string[][] {
  if (tags.length === 0) return [];
  // Before the container is measured, fall back to one chip per row — the list
  // re-packs as soon as useElementSize reports a real width.
  const width = containerWidth > 0 ? containerWidth : 0;

  const rows: string[][] = [];
  let row: string[] = [];
  let used = 0;

  for (const tag of tags) {
    const w = estimateChipWidth(tag, counts.get(tag) ?? 0, isAdding);
    const needed = row.length === 0 ? w : used + gap + w;
    if (row.length > 0 && needed > width) {
      rows.push(row);
      row = [tag];
      used = w;
    } else {
      row.push(tag);
      used = needed;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Row height for a chip strip (padding + text-xs chip + gap). */
export const TAG_CLOUD_ROW_HEIGHT = 30;
