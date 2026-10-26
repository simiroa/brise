import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { buildNoteQueryInput, resolveDateRange } from "./noteQuery";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

// §2.8 HANDOFF-calendar-onboarding.md: date-range chips resolve to updated_from/updated_to at
// query-build time (never stored resolved), UTC calendar-day boundaries (see resolveDateRange's
// own doc comment for why UTC rather than local).
describe("resolveDateRange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("null/undefined key resolves to no bounds", () => {
    expect(resolveDateRange(null)).toEqual({});
    expect(resolveDateRange(undefined)).toEqual({});
  });

  it("last7 spans 7 UTC calendar days inclusive, ending today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T15:00:00.000Z"));
    expect(resolveDateRange("last7")).toEqual({ from: "2026-07-22", to: "2026-07-28" });
  });

  it("last30 spans 30 UTC calendar days inclusive, ending today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T15:00:00.000Z"));
    expect(resolveDateRange("last30")).toEqual({ from: "2026-06-29", to: "2026-07-28" });
  });

  it("thisYear spans Jan 1 (UTC) through today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T15:00:00.000Z"));
    expect(resolveDateRange("thisYear")).toEqual({ from: "2026-01-01", to: "2026-07-28" });
  });

  it("uses the UTC date, not the local date, near a UTC day boundary", () => {
    vi.useFakeTimers();
    // 2026-01-01 23:30 UTC — a local timezone behind UTC would still call this Dec 31 locally,
    // but the pinned rule is UTC calendar days (see resolveDateRange doc comment).
    vi.setSystemTime(new Date("2026-01-01T23:30:00.000Z"));
    expect(resolveDateRange("last7")).toEqual({ from: "2025-12-26", to: "2026-01-01" });
  });
});

describe("buildNoteQueryInput — dateRange axis", () => {
  it("omits updated_from/updated_to when dateRange is absent or null", () => {
    expect(buildNoteQueryInput({})).not.toHaveProperty("updated_from");
    expect(buildNoteQueryInput({})).not.toHaveProperty("updated_to");
    expect(buildNoteQueryInput({ dateRange: null })).not.toHaveProperty("updated_from");
  });

  it("resolves the chip identity to updated_from/updated_to", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const input = buildNoteQueryInput({ dateRange: "last7" });
    expect(input.updated_from).toBe("2026-07-22");
    expect(input.updated_to).toBe("2026-07-28");
    vi.useRealTimers();
  });

  it("does not conflate with year_from/year_to (event axis)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const input = buildNoteQueryInput({ dateRange: "last7", yearFrom: 1400, yearTo: 1500 });
    expect(input.year_from).toBe(1400);
    expect(input.year_to).toBe(1500);
    expect(input.updated_from).toBe("2026-07-22");
    expect(input.updated_to).toBe("2026-07-28");
    vi.useRealTimers();
  });
});

describe("noteQueryCollect — signature-keyed cache", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ notes: [{ id: "n1" }], total: 1 });
  });

  it("same axes+maxNotes twice hits the cache; a version bump forces a refetch", async () => {
    const { noteQueryCollect, bumpNoteQueryVersion } = await import("./noteQuery");
    const axes = { yearFrom: 1900, yearTo: 2000 };

    const first = await noteQueryCollect(axes, { maxNotes: 50 });
    expect(callMock).toHaveBeenCalledTimes(1);

    const second = await noteQueryCollect(axes, { maxNotes: 50 });
    expect(callMock).toHaveBeenCalledTimes(1); // cache hit, no second IPC round-trip
    expect(second).toBe(first); // same cached object, not just equal

    bumpNoteQueryVersion();
    await noteQueryCollect(axes, { maxNotes: 50 });
    expect(callMock).toHaveBeenCalledTimes(2); // cache cleared, refetched
  });
});

describe("useNoteQueryVersion — expanded-view re-fetch subscription", () => {
  // Real timers (not vi.useFakeTimers): bumpNoteQueryVersion's coalescing timer is module-level
  // state shared with the "noteQueryCollect" tests above, which already scheduled a real timeout
  // — mixing fake/real timers here would advance the wrong clock for that leftover timer.
  it("does not notify synchronously on a burst of bumps, but does after the coalescing delay settles", async () => {
    const { useNoteQueryVersion, bumpNoteQueryVersion } = await import("./noteQuery");
    const { result } = renderHook(() => useNoteQueryVersion());
    const before = result.current;

    // Simulates a title-edit keystroke burst: patchNoteSummary bumps on every keystroke, well
    // before the 700ms save debounce — this must not fire a re-fetch per keystroke.
    act(() => {
      bumpNoteQueryVersion();
      bumpNoteQueryVersion();
      bumpNoteQueryVersion();
    });
    expect(result.current).toBe(before); // not yet — still coalescing

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(result.current).not.toBe(before); // settles to a fresh version once the burst quiets
  });
});
