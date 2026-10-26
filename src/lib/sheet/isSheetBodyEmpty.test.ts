import { describe, it, expect } from "vitest";
import { isSheetBodyEmpty } from "./isSheetBodyEmpty";
import { emptySheet } from "./types";

describe("isSheetBodyEmpty", () => {
  it("treats null, undefined, empty, and whitespace-only strings as empty", () => {
    expect(isSheetBodyEmpty(null)).toBe(true);
    expect(isSheetBodyEmpty(undefined)).toBe(true);
    expect(isSheetBodyEmpty("")).toBe(true);
    expect(isSheetBodyEmpty("   ")).toBe(true);
    expect(isSheetBodyEmpty("\n\t  ")).toBe(true);
  });

  it("treats standard emptySheet() serialization as empty", () => {
    const doc = emptySheet();
    expect(isSheetBodyEmpty(JSON.stringify(doc))).toBe(true);
  });

  it("treats json with empty cells object as empty", () => {
    expect(isSheetBodyEmpty(JSON.stringify({ v: 1, cells: {} }))).toBe(true);
    expect(isSheetBodyEmpty(JSON.stringify({}))).toBe(true);
  });

  it("treats cells with empty or whitespace-only raw values as empty", () => {
    const body = JSON.stringify({
      cells: {
        A1: { raw: "" },
        B2: { raw: "   " },
        C3: { raw: "\t\n" },
      },
    });
    expect(isSheetBodyEmpty(body)).toBe(true);
  });

  it("treats sheet with at least one non-empty raw cell as not empty", () => {
    const bodyWithText = JSON.stringify({
      cells: {
        A1: { raw: "hello" },
        B2: { raw: "" },
      },
    });
    expect(isSheetBodyEmpty(bodyWithText)).toBe(false);

    const bodyWithNumber = JSON.stringify({
      cells: {
        A1: { raw: "42" },
      },
    });
    expect(isSheetBodyEmpty(bodyWithNumber)).toBe(false);
  });

  it("treats invalid/corrupted non-empty JSON as not empty (fallback)", () => {
    expect(isSheetBodyEmpty("invalid json string")).toBe(false);
    expect(isSheetBodyEmpty("{ broken json:")).toBe(false);
  });

  it("handles malformed cells property (null, boolean, number) without crashing", () => {
    expect(isSheetBodyEmpty(JSON.stringify({ cells: null }))).toBe(true);
    expect(isSheetBodyEmpty(JSON.stringify({ cells: 123 }))).toBe(true);
    expect(isSheetBodyEmpty(JSON.stringify({ cells: true }))).toBe(true);
  });

  it("handles null or non-object cell entries safely", () => {
    const body = JSON.stringify({
      cells: {
        A1: null,
        B2: undefined,
        C3: { raw: null },
      },
    });
    expect(isSheetBodyEmpty(body)).toBe(true);
  });

  it("handles primitive JSON values gracefully", () => {
    expect(isSheetBodyEmpty("123")).toBe(true);
    expect(isSheetBodyEmpty("true")).toBe(true);
    expect(isSheetBodyEmpty("\"plain string\"")).toBe(true);
    expect(isSheetBodyEmpty("null")).toBe(true);
  });
});
