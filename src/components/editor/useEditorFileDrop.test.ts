import { describe, it, expect } from "vitest";
import { resolveDropPos, nextDragOverState } from "./useEditorFileDrop";

// Scope: the one pure branch worth a standalone check without a live editor/Tauri drag-drop
// harness — handleFileDrop's own note/section race guard is a byte-for-byte copy of
// EditorPanel.tsx's isPasteStillOnTarget, already covered there (EditorPanel.paste.test.tsx).
describe("resolveDropPos", () => {
  it("uses the posAtCoords position when the drop lands inside the document", () => {
    expect(resolveDropPos(12, 0)).toBe(12);
  });

  it("falls back to the current selection when posAtCoords misses (empty margin below the doc)", () => {
    expect(resolveDropPos(null, 7)).toBe(7);
    expect(resolveDropPos(undefined, 7)).toBe(7);
  });

  it("position 0 is a real position, not a miss", () => {
    expect(resolveDropPos(0, 7)).toBe(0);
  });
});

describe("nextDragOverState", () => {
  it("enter/over inside the rect sets dragOver on", () => {
    expect(nextDragOverState("enter", true)).toBe(true);
    expect(nextDragOverState("over", true)).toBe(true);
  });

  it("enter/over outside the rect leaves dragOver off", () => {
    expect(nextDragOverState("over", false)).toBe(false);
  });

  it("leave always clears dragOver regardless of the hit-test", () => {
    expect(nextDragOverState("leave", true)).toBe(false);
  });

  it("drop always clears dragOver regardless of the hit-test", () => {
    expect(nextDragOverState("drop", true)).toBe(false);
  });
});
