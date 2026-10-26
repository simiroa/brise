import { describe, expect, it } from "vitest";
import { escapeCsvCell, toCsv } from "./csv";
import { emptySheet } from "./types";

describe("sheet csv serialization", () => {
  it("escapes cells containing special characters", () => {
    expect(escapeCsvCell("hello")).toBe("hello");
    expect(escapeCsvCell('hello "world"')).toBe('"hello ""world"""');
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("a\nb")).toBe('"a\nb"');
  });

  it("converts SheetDoc into CSV format", () => {
    const doc = emptySheet();
    doc.cells = {
      A1: { raw: "Name" },
      B1: { raw: "Amount, KRW" },
      A2: { raw: 'Item "A"' },
      B2: { raw: "1000" },
    };

    const csv = toCsv(doc);
    expect(csv).toBe('Name,"Amount, KRW"\r\n"Item ""A""",1000');
  });
});
