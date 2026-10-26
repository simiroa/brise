import { useEffect, useMemo, useState } from "react";
import { useNotesStore } from "../../stores/notes";
import type { Attachment, NoteSummary } from "../../lib/commands.gen";

/** Stable empty id list — returning a fresh `[]` from useMemo when there are no
 * internal links churns the effect dep and can drive an effect→setState loop. */
const EMPTY_TARGET_IDS: string[] = [];

function mapsShallowEqual(
  a: Map<string, NoteSummary>,
  b: Map<string, NoteSummary>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, note] of a) {
    if (b.get(id) !== note) return false;
  }
  return true;
}

/** Resolve manual internal-link targets by id (note_summaries_map). */
export function useManualRelated(
  attachments: Attachment[],
): Map<string, NoteSummary> {
  const ensureNoteSummaries = useNotesStore((s) => s.ensureNoteSummaries);
  const [manualNotesById, setManualNotesById] = useState<Map<string, NoteSummary>>(
    () => new Map(),
  );

  const manualTargetIds = useMemo(() => {
    const ids: string[] = [];
    for (const a of attachments) {
      if (a.kind === "internal" && a.url) ids.push(a.url);
    }
    return ids.length === 0 ? EMPTY_TARGET_IDS : ids;
  }, [attachments]);

  useEffect(() => {
    if (manualTargetIds.length === 0) {
      // `new Map()` is never === an existing empty Map — only clear when non-empty.
      setManualNotesById((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void ensureNoteSummaries(manualTargetIds).then((map) => {
      if (cancelled) return;
      // ensureNoteSummaries always returns a fresh Map; skip setState when contents match
      // so a store merge (or re-run) cannot feed back into another render.
      setManualNotesById((prev) => (mapsShallowEqual(prev, map) ? prev : map));
    });
    return () => {
      cancelled = true;
    };
  }, [manualTargetIds, ensureNoteSummaries]);

  return manualNotesById;
}
