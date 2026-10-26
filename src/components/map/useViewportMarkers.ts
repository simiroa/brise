/**
 * Viewport-scoped, server-bounded marker query — shared by HomeMapPane and RegionExpanded's
 * sidebar map. Both feed WorldMap's onViewportChange bbox into the same note_query shape and
 * filter the result to notes with coords. Extracted from the two near-identical copies (owner-
 * approved cleanup, 2026-08-10).
 */
import { useEffect, useRef, useState } from "react";
import { noteQuery, type NoteQueryFilterAxes } from "../../lib/noteQuery";
import { noteHasCoords } from "../leftpanel/expanded/viewData";
import type { NoteSummary } from "../../lib/commands.gen";
import type { MapViewportBbox } from "./geometry";

/** Server-side cap on a single viewport marker fetch. RegionExpanded also reuses this as its own
 * client-side grouped-marker cap — one constant, not two copies of `500`. */
export const MAP_MARKER_LIMIT = 500;

/** Filter axes the caller already resolved from its stores — everything note_query needs except
 * the bbox/sort/paging this hook fills in itself. A parameter (not an internal store subscription)
 * because the two call sites don't share every axis: only HomeMapPane scopes by workspaceId. */
export type ViewportMarkerFilters = Omit<NoteQueryFilterAxes, "coords" | "sort" | "offset" | "limit">;

/** How much wider than the raw viewport each fetch queries — gives panning slack before the next
 * committed transform needs a fresh round trip (see `lastQueryRef` below). 1.3 = 30% wider on
 * each axis, centered on the viewport. */
const QUERY_BBOX_PAD_FACTOR = 1.3;

function widenBbox(v: MapViewportBbox, factor: number): MapViewportBbox {
  const latPad = ((v.max_lat - v.min_lat) * (factor - 1)) / 2;
  const lngPad = ((v.max_lng - v.min_lng) * (factor - 1)) / 2;
  return {
    min_lat: Math.max(-85, v.min_lat - latPad),
    max_lat: Math.min(85, v.max_lat + latPad),
    min_lng: Math.max(-180, v.min_lng - lngPad),
    max_lng: Math.min(180, v.max_lng + lngPad),
  };
}

/** True when `outer` fully covers `inner` — the coalescing test: the previous fetch's (padded)
 * bbox still covers the newly committed viewport, so its already-fetched notes are still
 * complete for the new view (panning within the padding, or zooming in). False on any zoom-out
 * past the padded coverage, which is exactly when a refetch is needed. */
function bboxContains(outer: MapViewportBbox, inner: MapViewportBbox): boolean {
  return (
    outer.min_lat <= inner.min_lat &&
    outer.max_lat >= inner.max_lat &&
    outer.min_lng <= inner.min_lng &&
    outer.max_lng >= inner.max_lng
  );
}

export function useViewportMarkers(
  viewport: MapViewportBbox | null,
  filters: ViewportMarkerFilters,
  noteQueryVersion: number
): { located: NoteSummary[]; loading: boolean; settled: boolean } {
  const [located, setLocated] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  // True once any fetch has finished (success or failure). `loading` alone can't tell "nothing
  // here" from "not asked yet": it is false before the first viewport arrives, and a fast
  // response can flip it true→false inside one batched render. Callers that show an empty state
  // (HomeMapPane's default-region rail) gate it on this.
  const [settled, setSettled] = useState(false);
  // Value-stable dep: a fresh `filters` object literal every render must not re-fetch, only an
  // actual content change should.
  const filtersSig = JSON.stringify(filters);

  // Coverage of the last *successful, untruncated* fetch: the bbox actually queried (already
  // padded), and the filter/version signature it was fetched under. `truncated` mirrors
  // `total > MAP_MARKER_LIMIT` on that response — a truncated page is not "everything in that
  // bbox", so it can never be reused to skip a refetch (would permanently hide markers outside
  // the truncated slice). Cleared on fetch failure so a retry isn't skipped on stale coverage.
  const lastQueryRef = useRef<{
    bbox: MapViewportBbox;
    filtersSig: string;
    noteQueryVersion: number;
    truncated: boolean;
  } | null>(null);

  useEffect(() => {
    if (!viewport) return;

    const last = lastQueryRef.current;
    if (
      last &&
      last.filtersSig === filtersSig &&
      last.noteQueryVersion === noteQueryVersion &&
      !last.truncated &&
      bboxContains(last.bbox, viewport)
    ) {
      // Same filters/version, and the last fetch's padded bbox still covers this viewport —
      // reuse `located` instead of re-querying.
      return;
    }

    let cancelled = false;
    setLoading(true);
    const queryBbox = widenBbox(viewport, QUERY_BBOX_PAD_FACTOR);
    void (async () => {
      try {
        const r = await noteQuery({
          ...filters,
          coords: {
            kind: "bbox",
            min_lat: queryBbox.min_lat,
            max_lat: queryBbox.max_lat,
            min_lng: queryBbox.min_lng,
            max_lng: queryBbox.max_lng,
          },
          sort: "title_asc",
          offset: 0,
          limit: MAP_MARKER_LIMIT,
        });
        if (!cancelled) {
          setLocated(r.notes.filter(noteHasCoords));
          lastQueryRef.current = {
            bbox: queryBbox,
            filtersSig,
            noteQueryVersion,
            truncated: r.total > MAP_MARKER_LIMIT,
          };
        }
      } catch {
        if (!cancelled) {
          setLocated([]);
          lastQueryRef.current = null;
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSettled(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `filters` deliberately omitted — only its content (filtersSig) should re-trigger, not a
    // fresh object literal every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, noteQueryVersion, filtersSig]);

  return { located, loading, settled };
}
