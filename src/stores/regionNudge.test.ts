import { describe, it, expect, beforeEach } from "vitest";
import { useRegionNudgeStore } from "./regionNudge";

const A = { name: "경주", lat: 35.8562, lng: 129.2247 };
const B = { name: "부산", lat: 35.1796, lng: 129.0756 };

describe("useRegionNudgeStore", () => {
  beforeEach(() => {
    useRegionNudgeStore.setState({ noteId: null, candidates: [], dismissedNames: new Set() });
  });

  it("resetForNote sets the note scope and clears candidates/dismissed", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().setCandidates("note-1", [A, B]);
    useRegionNudgeStore.getState().dismiss("note-1", "경주");

    useRegionNudgeStore.getState().resetForNote("note-2");
    const s = useRegionNudgeStore.getState();
    expect(s.noteId).toBe("note-2");
    expect(s.candidates).toEqual([]);
    expect(s.dismissedNames.size).toBe(0);
  });

  it("resetForNote is a no-op when the noteId hasn't actually changed (keeps existing state)", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().setCandidates("note-1", [A]);
    useRegionNudgeStore.getState().resetForNote("note-1"); // same id again
    expect(useRegionNudgeStore.getState().candidates).toEqual([A]);
  });

  it("setCandidates is dropped when forNoteId doesn't match the current note (stale scan guard)", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().setCandidates("note-0-stale", [A]);
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
  });

  it("setCandidates re-applies the dismiss set so a dismissed name doesn't reappear from a scan that started before the dismiss", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().dismiss("note-1", "경주");
    useRegionNudgeStore.getState().setCandidates("note-1", [A, B]);
    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["부산"]);
  });

  it("dismiss normalizes by trim+lowercase, matching sameRegionName's own comparison", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().setCandidates("note-1", [{ name: "  Paris ", lat: 1, lng: 1 }]);
    useRegionNudgeStore.getState().dismiss("note-1", "paris");
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
    expect(useRegionNudgeStore.getState().dismissedNames.has("paris")).toBe(true);
  });

  it("dismiss is dropped when forNoteId doesn't match the current note", () => {
    useRegionNudgeStore.getState().resetForNote("note-1");
    useRegionNudgeStore.getState().setCandidates("note-1", [A]);
    useRegionNudgeStore.getState().dismiss("note-0-stale", "경주");
    expect(useRegionNudgeStore.getState().candidates).toEqual([A]);
    expect(useRegionNudgeStore.getState().dismissedNames.size).toBe(0);
  });
});
