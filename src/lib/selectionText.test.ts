import { describe, it, expect } from "vitest";
import { deriveExcerptTitle } from "./selectionText";

describe("deriveExcerptTitle", () => {
  it("takes the first ~40 chars", () => {
    const text = "a".repeat(60);
    expect(deriveExcerptTitle(text)).toBe("a".repeat(40));
  });

  it("collapses newlines/multiple spaces from a multi-paragraph selection", () => {
    expect(deriveExcerptTitle("Line one\n\n  Line   two")).toBe("Line one Line two");
  });

  it("trims leading/trailing whitespace", () => {
    expect(deriveExcerptTitle("   hello world   ")).toBe("hello world");
  });

  it("returns empty string for whitespace-only selection (caller supplies the fallback title)", () => {
    expect(deriveExcerptTitle("   \n\t  ")).toBe("");
  });
});
