/**
 * PLAN-2026-09-19-date-region-ui.md §P3 Phase A (D10) — candidate list + per-note, in-memory-only
 * dismiss set for the region pre-match nudge. The matching engine (components/editor/
 * regionDetect.ts) is the sole writer of `candidates`; a future Phase B popover is the intended
 * reader/dismisser (not built yet — see that plan section's Phase A/Phase B split). `dismiss()`
 * exists here now even though no UI calls it yet, because D10 says the STORE needs the capability
 * in this phase even though the dismiss BUTTON is Phase B's job.
 *
 * Never persisted — D10 is explicit that this is session/in-memory scope only, reset on note
 * switch (never written to settings or the DB).
 */
import { create } from "zustand";
import type { RegionRegistryEntry } from "../lib/regionRegistry";

/** Same normalization as regionDisplay.ts::sameRegionName (trim + lowercase) — kept as a local
 *  copy rather than importing that helper because this is a Set-membership key, not the pairwise
 *  comparison sameRegionName is shaped for; the two must still agree so a name a scan excludes via
 *  sameRegionName (D9) and a name this store excludes via dismiss (D10) never disagree on what
 *  counts as "the same name". */
function normalizeRegionName(name: string): string {
  return name.trim().toLowerCase();
}

export interface RegionNudgeState {
  /** The note this candidate list / dismiss set currently belongs to. `null` = no note open (or
   *  not yet initialized). */
  noteId: string | null;
  candidates: RegionRegistryEntry[];
  /** D10: normalized (trim+lowercase) names the user dismissed for the CURRENT note this session.
   *  Never persisted. */
  dismissedNames: Set<string>;

  /** D10: call once per note switch (including closing to null) — resets both the candidate list
   *  and the dismiss set so a different note starts with a clean slate. A no-op if `noteId` is
   *  already the current note (idempotent — safe to call from an effect that also fires for
   *  unrelated re-renders). Must NOT be called on a same-note section switch; regionDetect.ts's
   *  hook keeps that reset keyed on noteId alone for exactly this reason. */
  resetForNote: (noteId: string | null) => void;

  /**
   * Matching engine's write path. `forNoteId` must equal the store's current `noteId` or the call
   * is dropped silently — guards the same race stores/notesTree.ts's `loadTreeSeq` guards: a
   * debounced scan started against note A can resolve after the user has already switched to note
   * B, and must not paint A's candidates onto B's popover. Already-dismissed names are filtered
   * back out here too, so a name dismissed while a scan was in flight doesn't reappear when that
   * scan's (now-stale-relative-to-the-dismiss) result lands.
   */
  setCandidates: (forNoteId: string, candidates: RegionRegistryEntry[]) => void;

  /** D10 — Phase B's dismiss button target. Adds the normalized name to the session dismiss set
   *  and immediately drops any matching candidate from view; guarded by the same `forNoteId`
   *  staleness check as setCandidates. */
  dismiss: (forNoteId: string, name: string) => void;
}

export const useRegionNudgeStore = create<RegionNudgeState>((set, get) => ({
  noteId: null,
  candidates: [],
  dismissedNames: new Set<string>(),

  resetForNote: (noteId) => {
    if (get().noteId === noteId) return;
    set({ noteId, candidates: [], dismissedNames: new Set<string>() });
  },

  setCandidates: (forNoteId, candidates) => {
    const s = get();
    if (s.noteId !== forNoteId) return; // stale scan result — the open note has since changed
    const visible = candidates.filter((c) => !s.dismissedNames.has(normalizeRegionName(c.name)));
    set({ candidates: visible });
  },

  dismiss: (forNoteId, name) => {
    const s = get();
    if (s.noteId !== forNoteId) return;
    const key = normalizeRegionName(name);
    if (s.dismissedNames.has(key)) return;
    const nextDismissed = new Set(s.dismissedNames);
    nextDismissed.add(key);
    set({
      dismissedNames: nextDismissed,
      candidates: s.candidates.filter((c) => normalizeRegionName(c.name) !== key),
    });
  },
}));
