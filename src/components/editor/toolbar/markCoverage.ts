import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Fraction of the selection range covered by the named mark.
 * Uses text length only (non-text nodes contribute 0).
 * - 0 → fully off
 * - 0 < r < 1 → partial (mixed)
 * - 1 → fully on
 * Empty ranges (`from >= to`) return 0 — callers that care about caret marks should use TipTap `isActive`.
 */
export function markCoverageRatio(
  doc: PMNode,
  from: number,
  to: number,
  markName: string,
): number {
  if (from >= to) return 0;

  let covered = 0;
  let total = 0;

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const len = end - start;
    if (len <= 0) return;
    total += len;
    if (node.marks.some((m) => m.type.name === markName)) {
      covered += len;
    }
  });

  if (total === 0) return 0;
  return covered / total;
}

export type MarkPressState = "on" | "off" | "partial";

/** Map a coverage ratio to toolbar tri-state. */
export function markPressFromRatio(ratio: number): MarkPressState {
  if (ratio <= 0) return "off";
  if (ratio >= 1) return "on";
  return "partial";
}
