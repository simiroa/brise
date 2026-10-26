import { describe, it, expect, vi } from "vitest";
import { openDateEntry, subscribeDateEntry, type DateEntryPayload } from "./dateEntryBridge";

const payload = (over: Partial<DateEntryPayload> = {}): DateEntryPayload => ({
  noteId: "note-1",
  anchorX: 10,
  anchorY: 20,
  range: { from: 3, to: 8 },
  ...over,
});

describe("dateEntryBridge", () => {
  it("openDateEntry is a no-op before anything subscribes", () => {
    expect(() => openDateEntry(payload())).not.toThrow();
  });

  it("delivers the payload to the current subscriber", () => {
    const fn = vi.fn();
    subscribeDateEntry(fn);
    const p = payload({ noteId: "note-2" });
    openDateEntry(p);
    expect(fn).toHaveBeenCalledWith(p);
  });

  it("unsubscribing stops delivery", () => {
    const fn = vi.fn();
    const unsubscribe = subscribeDateEntry(fn);
    unsubscribe();
    openDateEntry(payload());
    expect(fn).not.toHaveBeenCalled();
  });

  it("a later subscriber replaces the earlier one (single-slot bridge, mirrors presetBridge/aiSectionBridge)", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeDateEntry(first);
    subscribeDateEntry(second);
    openDateEntry(payload());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("unsubscribing a stale registration does not clobber a newer one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeDateEntry(first);
    subscribeDateEntry(second);
    unsubFirst();
    openDateEntry(payload());
    expect(second).toHaveBeenCalled();
  });
});
