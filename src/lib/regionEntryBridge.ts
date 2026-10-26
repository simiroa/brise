/**
 * PLAN-2026-09-18-nl-dates.md §W6 — bridge between the editor's "/지역" slash command
 * (slashCommand.tsx) and `editor/RegionEntryPopover.tsx`, which renders the region search form.
 * Same module pub/sub shape as `dateEntryBridge.ts` (see that file's header for the full
 * reasoning): siblings mounted separately in EditorPanel have no prop path, so a module-level
 * pub/sub bridge (same idiom as `lib/aiSectionBridge.ts` / `lib/presetBridge.ts`) fills the gap
 * instead of threading callbacks through EditorPanel.
 *
 * Unlike dates (W2), region has no body-mark schema extension (no `DateMark` equivalent) — a note
 * has at most one representative region + an ordered waypoint list (`note_regions`), neither of
 * which is tied to a body position. So there's no `prefill`/`editRowId` distinction here: this
 * bridge only ever backs the "/지역" slash entry point (§W6's own scope note — post-hoc "register
 * selected text as a region" is explicitly out of scope for this wave).
 */

export interface RegionEntryPayload {
  /** Target note — the caller resolves this itself (active note at open time; the popover trusts
   *  it as-is, same trust model as dateEntryBridge's DateEntryPayload.noteId — the popover's
   *  full-viewport backdrop blocks other clicks while it's open, so the active note cannot change
   *  out from under it). */
  noteId: string;
  /** Popover anchor — screen coordinates (e.g. from `editor.view.coordsAtPos(range.from)`). */
  anchorX: number;
  anchorY: number;
  /** Doc range the caller wants touched on a successful pick — the "/지역" trigger text itself,
   *  replaced with the picked place's label (D6-style plain-text substitution, same spirit as
   *  dateEntryBridge's `replaceRangeOnSave:true` flow — this bridge has only that one flow, so
   *  there's no separate flag for it). */
  range: { from: number; to: number };
  /** Text typed after the "/지역" trigger (e.g. "/지역 경복궁" → "경복궁") to prefill the search
   *  box. Undefined/empty = blank search box. Tiptap's default Suggestion match stops at the first
   *  space, so the slash-command call site does not populate this today — the field exists so a
   *  caller that captures trailing text some other way (or a future Suggestion config change) has
   *  somewhere to put it without a payload-shape change. */
  query?: string;
}

type RegionEntryListener = (payload: RegionEntryPayload) => void;

let regionEntryListener: RegionEntryListener = () => {};

export function subscribeRegionEntry(fn: RegionEntryListener): () => void {
  regionEntryListener = fn;
  return () => {
    if (regionEntryListener === fn) regionEntryListener = () => {};
  };
}

export function openRegionEntry(payload: RegionEntryPayload): void {
  regionEntryListener(payload);
}
