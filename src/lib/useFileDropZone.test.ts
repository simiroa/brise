import { describe, it, expect } from "vitest";
import { dprCorrectedPos, isInsideRect, nextDragOverState } from "./useFileDropZone";

// 다섯 존(useAttachmentsDragDrop · useEditorFileDrop · SourcePanel의 usePreviewFileDrop ·
// SidebarChat · PetSection)이 각자 복제하던 dpr 보정/적중 판정/dragOver 전이를 여기 하나로
// 모았다 — 순수 함수라 Tauri 하네스 없이 바로 검증한다.
describe("dprCorrectedPos", () => {
  it("divides raw (physical-pixel) coordinates by the device pixel ratio", () => {
    expect(dprCorrectedPos({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
  });

  it("dpr 1 (no scaling) leaves coordinates unchanged", () => {
    expect(dprCorrectedPos({ x: 42, y: 7 }, 1)).toEqual({ x: 42, y: 7 });
  });
});

describe("isInsideRect", () => {
  const rect = { left: 10, right: 110, top: 20, bottom: 220 };

  it("true for a point strictly inside", () => {
    expect(isInsideRect({ x: 50, y: 50 }, rect)).toBe(true);
  });

  it("true on the boundary (inclusive)", () => {
    expect(isInsideRect({ x: 10, y: 20 }, rect)).toBe(true);
    expect(isInsideRect({ x: 110, y: 220 }, rect)).toBe(true);
  });

  it("false outside the rect", () => {
    expect(isInsideRect({ x: 9, y: 50 }, rect)).toBe(false);
    expect(isInsideRect({ x: 50, y: 221 }, rect)).toBe(false);
  });

  it("false when there's no rect yet (zone not mounted)", () => {
    expect(isInsideRect({ x: 50, y: 50 }, null)).toBe(false);
    expect(isInsideRect({ x: 50, y: 50 }, undefined)).toBe(false);
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
