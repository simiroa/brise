/**
 * Helpers for the sidebar's single note read endpoint (`note_query`).
 * Views fetch windows through here so they do not scan the resident corpus.
 */
import { useSyncExternalStore } from "react";
import { call } from "./invoke";
import type {
  NoteQueryInput,
  NoteQueryOutput,
  NoteSummary,
} from "./commands.gen";
import type { DateRangeKey, RegionFilter } from "../stores/search";
import { resolveDateRange } from "./dateRange";

export { resolveDateRange } from "./dateRange";

/**
 * One tree-folder window: enough for a typical virtualized viewport (~20–25 rows
 * at 34px) plus overscan. Boot and open-folder loads must never page beyond this
 * without a scroll-driven follow-up.
 */
export const TREE_NOTE_WINDOW = 80;

/**
 * Favourites strip uses the same window size as a folder body.
 */
export const TREE_FAVORITES_WINDOW = TREE_NOTE_WINDOW;

/**
 * Hard ceiling for expanded "크게 보기" boards that still group client-side.
 * Not for boot or the note tree — those use TREE_*_WINDOW only.
 */
export const EXPANDED_BOARD_MAX_NOTES = 5000;

export type NoteQueryFilterAxes = {
  yearFrom?: number;
  yearTo?: number;
  selectedTags?: string[];
  tagMode?: NoteQueryInput["tag_mode"];
  regionFilter?: RegionFilter;
  coords?: NoteQueryInput["coords"];
  statusFilter?: string[];
  /** Advanced-search date-range chip (record axis, updated_at) — resolved to updated_from/
   * updated_to here at query-build time via resolveDateRange. See stores/search.ts::DateRangeKey. */
  dateRange?: DateRangeKey | null;
  /** Calendar view's single-day pick (record axis, updated_at, UTC day) — a concrete ISO date,
   * not a chip identity, so it bypasses resolveDateRange. Takes precedence over `dateRange` when
   * both are set (CalendarExpanded never passes both). */
  updatedFrom?: string;
  updatedTo?: string;
  /** Calendar view's "created that day" group (record axis, created_at, UTC day). Independent
   * of updatedFrom/updatedTo — not folded into the dateRange resolution above — since a query
   * can filter by created and updated simultaneously (both AND). */
  createdFrom?: string;
  createdTo?: string;
  favoritesOnly?: boolean;
  sort?: NoteQueryInput["sort"];
  offset?: number;
  limit?: number;
  workspaceId?: string;
  folderIds?: string[];
};

export function regionFilterToQuery(
  regionFilter: RegionFilter | undefined
): NoteQueryInput["region"] {
  if (!regionFilter) return undefined;
  if (regionFilter.kind === "none") return { kind: "none" };
  return { kind: "region", name: regionFilter.name };
}

export function buildNoteQueryInput(axes: NoteQueryFilterAxes): NoteQueryInput {
  const input: NoteQueryInput = {};
  if (axes.workspaceId) input.workspace_id = axes.workspaceId;
  if (axes.folderIds) input.folder_ids = axes.folderIds;
  if (axes.yearFrom !== undefined) input.year_from = axes.yearFrom;
  if (axes.yearTo !== undefined) input.year_to = axes.yearTo;
  if (axes.updatedFrom || axes.updatedTo) {
    if (axes.updatedFrom) input.updated_from = axes.updatedFrom;
    if (axes.updatedTo) input.updated_to = axes.updatedTo;
  } else if (axes.dateRange) {
    const { from, to } = resolveDateRange(axes.dateRange);
    if (from) input.updated_from = from;
    if (to) input.updated_to = to;
  }
  if (axes.createdFrom) input.created_from = axes.createdFrom;
  if (axes.createdTo) input.created_to = axes.createdTo;
  if (axes.favoritesOnly) input.favorites_only = true;
  if (axes.selectedTags && axes.selectedTags.length > 0) {
    input.tags = axes.selectedTags;
  }
  if (axes.tagMode) input.tag_mode = axes.tagMode;
  const region = regionFilterToQuery(axes.regionFilter);
  if (region) input.region = region;
  if (axes.statusFilter && axes.statusFilter.length > 0) {
    input.statuses = axes.statusFilter;
  }
  if (axes.coords) input.coords = axes.coords;
  if (axes.sort) input.sort = axes.sort;
  if (axes.offset !== undefined) input.offset = axes.offset;
  if (axes.limit !== undefined) input.limit = axes.limit;
  return input;
}

export async function noteQuery(axes: NoteQueryFilterAxes): Promise<NoteQueryOutput> {
  return call<NoteQueryOutput>(
    "note_query",
    buildNoteQueryInput(axes) as unknown as Record<string, unknown>
  );
}

/**
 * Signature-keyed cache for `noteQueryCollect` below: the same filter axes + maxNotes, asked
 * again while nothing has mutated, returns the prior result instead of re-paging note_query.
 * `bumpNoteQueryVersion()` is the invalidation — a full clear on any note mutation, which is
 * simplest-correct here since collected windows are small (<=5000 rows) and mutations are rare
 * relative to filter-change/remount fetches. Called from stores/notes.ts (loadTree + the shared
 * patchNoteSummary) rather than from every individual mutation, since those two are already the
 * chokepoints every note mutation routes through.
 */
let noteQueryDataVersion = 0;
const collectCache = new Map<string, { notes: NoteSummary[]; total: number }>();
const versionListeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Counter bump + cache clear are synchronous (noteQueryCollect's in-flight guard reads the
 * counter mid-flight and needs it current). The listener fan-out — which is what makes every
 * mounted expanded view re-run its fetch effect — is coalesced on a short trailing timer instead:
 * patchNoteSummary() (stores/notes.ts) calls this on every keystroke of a title/year edit (well
 * before the 700ms save debounce) and RegionExpanded's marker-drag path calls it 3-4x per drop.
 * Without coalescing, each of those would re-page every open board's note_query (up to
 * EXPANDED_BOARD_MAX_NOTES=5000 notes) on every keystroke. 250ms is well under human perception
 * for "the view updated" but collapses a keystroke burst into one re-fetch.
 * ponytail: fixed 250ms rather than a real debounce util — raise/tune if a real workload needs it.
 */
export function bumpNoteQueryVersion(): void {
  noteQueryDataVersion++;
  collectCache.clear();
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const l of versionListeners) l();
  }, 250);
}

function subscribeNoteQueryVersion(onChange: () => void): () => void {
  versionListeners.add(onChange);
  return () => versionListeners.delete(onChange);
}

/**
 * Re-renders (with a fresh number) whenever `bumpNoteQueryVersion()` fires — i.e. on every
 * note mutation that routes through loadTree()/patchNoteSummary(). Expanded filter views that
 * fetch via `noteQuery`/`noteQueryCollect` in a useEffect must add this to that effect's
 * dependency array, otherwise a create/rename elsewhere never triggers their re-fetch (their
 * effect only reacts to search-axis changes, not to data changes).
 */
export function useNoteQueryVersion(): number {
  return useSyncExternalStore(
    subscribeNoteQueryVersion,
    () => noteQueryDataVersion,
    () => noteQueryDataVersion
  );
}

function collectCacheKey(axes: NoteQueryFilterAxes, maxNotes: number): string {
  return `${maxNotes}:${JSON.stringify(buildNoteQueryInput(axes))}`;
}

/**
 * Collect up to `maxNotes` notes by paging note_query.
 *
 * **Not for boot or the note tree.** Those paths must use a single `noteQuery`
 * with `TREE_NOTE_WINDOW`. This helper exists only for expanded boards that still
 * group on the client (Tags / Status / Timeline / unlocated list) and *requires*
 * an explicit `maxNotes` so an unbounded corpus fetch cannot be invoked by
 * accident (the old `noteQueryAll` foot-gun).
 */
export async function noteQueryCollect(
  axes: NoteQueryFilterAxes,
  opts: { maxNotes: number; pageSize?: number }
): Promise<{ notes: NoteSummary[]; total: number }> {
  const maxNotes = Math.max(0, Math.floor(opts.maxNotes));
  if (maxNotes === 0) return { notes: [], total: 0 };

  const cacheKey = collectCacheKey(axes, maxNotes);
  const cached = collectCache.get(cacheKey);
  if (cached) return cached;
  const versionAtStart = noteQueryDataVersion;

  const pageSize = Math.min(
    opts.pageSize ?? Math.min(1000, maxNotes),
    maxNotes,
    1000
  );
  const first = await noteQuery({ ...axes, offset: 0, limit: pageSize });
  let result: { notes: NoteSummary[]; total: number };
  if (first.notes.length >= maxNotes || first.total <= first.notes.length) {
    result = {
      notes: first.notes.slice(0, maxNotes),
      total: first.total,
    };
  } else {
    const notes = [...first.notes];
    while (notes.length < first.total && notes.length < maxNotes) {
      const remaining = Math.min(pageSize, maxNotes - notes.length);
      const next = await noteQuery({
        ...axes,
        offset: notes.length,
        limit: remaining,
      });
      if (next.notes.length === 0) break;
      notes.push(...next.notes);
      if (next.notes.length < remaining) break;
    }
    result = { notes: notes.slice(0, maxNotes), total: first.total };
  }

  // A mutation may have bumped the version while this was in flight — don't cache a result that
  // could already be stale by the time it lands.
  if (versionAtStart === noteQueryDataVersion) {
    collectCache.set(cacheKey, result);
  }
  return result;
}

/**
 * note_query returns light summaries (tag_names=[]). Tags expanded needs names for
 * multi-section grouping — merge from note_tags_index (same source as loadTree hydrate).
 */
export async function hydrateTagNames(notes: NoteSummary[]): Promise<NoteSummary[]> {
  if (notes.length === 0) return notes;
  try {
    const r = await call<{ tags_by_note: Record<string, string[]> }>("note_tags_index");
    const map = r.tags_by_note ?? {};
    return notes.map((n) => {
      const tnames = map[n.id];
      return tnames ? { ...n, tag_names: tnames } : n;
    });
  } catch {
    return notes;
  }
}

export async function noteYearHistogram(
  workspaceId?: string
): Promise<Record<number, number>> {
  const r = await call<{ counts: { year: number; count: number }[] }>(
    "note_year_histogram",
    (workspaceId ? { workspace_id: workspaceId } : {}) as Record<string, unknown>
  );
  const out: Record<number, number> = {};
  for (const row of r.counts ?? []) {
    out[row.year] = row.count;
  }
  return out;
}

/**
 * Calendar grid day counts (record axis). `from`/`to` are inclusive ISO dates (YYYY-MM-DD).
 * `axis` defaults to "updated" server-side; the calendar grid passes "union" so a day lights up
 * for either creation or an edit (see specs/commands/notes.yaml::note_record_histogram — "union"
 * dedupes per-note, it is not the sum of the "created" and "updated" histograms). The backend
 * buckets by UTC calendar day (substr(ts,1,10)) — the grid this feeds renders those same UTC day
 * buckets rather than re-deriving local days, so grid counts and the day-click note lists never
 * disagree.
 */
export async function noteRecordHistogram(
  from: string,
  to: string,
  axis?: "updated" | "created" | "union",
  workspaceId?: string
): Promise<Record<string, number>> {
  const r = await call<{ counts: { day: string; count: number }[] }>(
    "note_record_histogram",
    {
      from,
      to,
      ...(axis ? { axis } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    } as Record<string, unknown>
  );
  const out: Record<string, number> = {};
  for (const row of r.counts ?? []) {
    out[row.day] = row.count;
  }
  return out;
}
