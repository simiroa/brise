import { describe, it, expect, vi } from "vitest";
import { openRegionEntry, subscribeRegionEntry, type RegionEntryPayload } from "./regionEntryBridge";

const payload = (over: Partial<RegionEntryPayload> = {}): RegionEntryPayload => ({
  noteId: "note-1",
  anchorX: 10,
  anchorY: 20,
  range: { from: 3, to: 8 },
  ...over,
});

describe("regionEntryBridge", () => {
  it("openRegionEntry is a no-op before anything subscribes", () => {
    expect(() => openRegionEntry(payload())).not.toThrow();
  });

  it("delivers the payload to the current subscriber", () => {
    const fn = vi.fn();
    subscribeRegionEntry(fn);
    const p = payload({ noteId: "note-2" });
    openRegionEntry(p);
    expect(fn).toHaveBeenCalledWith(p);
  });

  it("carries an optional query through unchanged", () => {
    const fn = vi.fn();
    subscribeRegionEntry(fn);
    const p = payload({ query: "경복궁" });
    openRegionEntry(p);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ query: "경복궁" }));
  });

  it("unsubscribing stops delivery", () => {
    const fn = vi.fn();
    const unsubscribe = subscribeRegionEntry(fn);
    unsubscribe();
    openRegionEntry(payload());
    expect(fn).not.toHaveBeenCalled();
  });

  it("a later subscriber replaces the earlier one (single-slot bridge, mirrors dateEntryBridge)", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeRegionEntry(first);
    subscribeRegionEntry(second);
    openRegionEntry(payload());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("unsubscribing a stale registration does not clobber a newer one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeRegionEntry(first);
    subscribeRegionEntry(second);
    unsubFirst();
    openRegionEntry(payload());
    expect(second).toHaveBeenCalled();
  });
});
