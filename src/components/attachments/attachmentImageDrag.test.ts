import { describe, it, expect } from "vitest";
import { isInsideRect } from "./attachmentImageDrag";

// Scope: the one pure branch worth a standalone check — the pointer-drag glue itself
// (window listeners, ghost element, live editor) mirrors lib/noteDrag.ts's startNoteDrag,
// which likewise has no direct unit test (only its pure DRAG_THRESHOLD_PX/handler wiring is
// exercised indirectly through the callers that mock it).
describe("isInsideRect", () => {
  const rect = { left: 10, right: 110, top: 20, bottom: 220 } as DOMRect;

  it("accepts a point inside the rect", () => {
    expect(isInsideRect(50, 100, rect)).toBe(true);
  });

  it("accepts the boundary edges (inclusive)", () => {
    expect(isInsideRect(10, 20, rect)).toBe(true);
    expect(isInsideRect(110, 220, rect)).toBe(true);
  });

  it("rejects a point outside each edge", () => {
    expect(isInsideRect(9, 100, rect)).toBe(false);
    expect(isInsideRect(111, 100, rect)).toBe(false);
    expect(isInsideRect(50, 19, rect)).toBe(false);
    expect(isInsideRect(50, 221, rect)).toBe(false);
  });
});
