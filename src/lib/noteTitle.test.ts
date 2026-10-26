import { describe, it, expect } from "vitest";
import { storedTitleOrEmpty, UNTITLED_NOTE_SENTINEL } from "./noteTitle";

describe("storedTitleOrEmpty", () => {
  it("빈 제목·공백·센티널은 \"\" 로 접는다", () => {
    expect(storedTitleOrEmpty(UNTITLED_NOTE_SENTINEL)).toBe("");
    expect(storedTitleOrEmpty("  ")).toBe("");
    expect(storedTitleOrEmpty(null)).toBe("");
    expect(storedTitleOrEmpty(undefined)).toBe("");
  });
  it("사용자 제목은 그대로 둔다", () => {
    expect(storedTitleOrEmpty("제주도여행계획")).toBe("제주도여행계획");
    expect(storedTitleOrEmpty("Untitled Note 2")).toBe("Untitled Note 2");
  });
});
