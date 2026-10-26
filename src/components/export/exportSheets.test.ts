import { describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { SHEET_EXPORT_MAX_COLS, SHEET_EXPORT_MAX_ROWS, sheetToTableDoc, sheetUsedRange, type SheetTruncation } from "./exportSheets";
import { emptySheet, type Cell, type ColSpec, type SheetDoc } from "../../lib/sheet/types";
import { refKey } from "../../lib/sheet/a1";

function sheet(cells: Record<string, string | Cell>, cols: ColSpec[] = [], rows = 100): SheetDoc {
  const base = emptySheet();
  const c: Record<string, Cell> = {};
  for (const [k, v] of Object.entries(cells)) c[k] = typeof v === "string" ? { raw: v } : v;
  const width = Math.max(base.cols.length, cols.length);
  return {
    ...base,
    rows,
    cols: Array.from({ length: width }, (_, i) => cols[i] ?? {}),
    cells: c,
  };
}

const noLabel = () => "";

/** 표의 칸 글자 격자(줄바꿈은 \n) — 기대값을 한눈에 비교하려고. */
function grid(doc: JSONContent | null): string[][] {
  const table = doc?.content?.find((n) => n.type === "table");
  return (table?.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content?.[0]?.content ?? []).map((n) => (n.type === "hardBreak" ? "\n" : n.text ?? "")).join(""),
    ),
  );
}

describe("sheetToTableDoc", () => {
  it("puts computed values (not formula text) in the table, formatted the way the grid shows them", () => {
    const s = sheet(
      {
        A1: "항목",
        B1: "금액",
        C1: "비율",
        A2: "커피",
        B2: "4500",
        C2: "=B2/B4",
        A3: "빵",
        B3: "=B2*2",
        C3: "=1/0",
        A4: "합계",
        B4: "=SUM(B2:B3)",
      },
      [{}, { fmt: "currency", dp: 0, cur: "KRW" }, { fmt: "percent" }],
    );
    const g = grid(sheetToTableDoc(s, noLabel));
    expect(g[0]).toEqual(["항목", "금액", "비율"]);
    expect(g[1][0]).toBe("커피");
    expect(g[1][1]).toContain("4,500");
    expect(g[1][1]).toContain("₩");
    expect(g[1][2]).toBe("33%");
    expect(g[2][1]).toContain("9,000");
    // 수식 오류는 표시 문자열 그대로
    expect(g[2][2]).toBe("#DIV/0!");
    expect(g[3][1]).toContain("13,500");
    // 수식 텍스트는 어디에도 없다
    expect(JSON.stringify(sheetToTableDoc(s, noLabel))).not.toContain("=SUM");
  });

  it("row 1 is the header (tableHeader), the rest are tableCell", () => {
    const doc = sheetToTableDoc(sheet({ A1: "머리", A2: "값", A3: "값2" }), noLabel);
    const rows = doc!.content![0].content!;
    expect(rows.map((r) => r.content!.map((c) => c.type))).toEqual([["tableHeader"], ["tableCell"], ["tableCell"]]);
  });

  it("right-aligns number/currency/percent columns like the grid, keeps text columns left", () => {
    const doc = sheetToTableDoc(sheet({ A1: "이름", B1: "수", A2: "a", B2: "3" }, [{}, { fmt: "number" }]), noLabel);
    const row = doc!.content![0].content![1].content!;
    expect(row[0].content![0].attrs).toBeUndefined();
    expect(row[1].content![0].attrs).toEqual({ textAlign: "right" });
  });

  it("checkbox columns become ☑/☐ characters", () => {
    const g = grid(sheetToTableDoc(sheet({ A1: "완료", A2: "TRUE", A3: "FALSE" }, [{ fmt: "checkbox" }]), noLabel));
    expect(g.map((r) => r[0])).toEqual(["완료", "☑", "☐"]);
  });

  it("the table spans A1 to the last filled cell; blank cells are empty paragraphs (never empty text nodes)", () => {
    const doc = sheetToTableDoc(sheet({ C3: "끝" }), noLabel);
    expect(grid(doc)).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", "끝"],
    ]);
    const empty = doc!.content![0].content![0].content![0].content![0];
    expect(empty).toEqual({ type: "paragraph" });
    expect(JSON.stringify(doc)).not.toContain('"text":""');
  });

  it("multi-line values (not formulas) keep their line breaks as hardBreak", () => {
    const doc = sheetToTableDoc(sheet({ A1: "메모", A2: "첫 줄\n둘째 줄" }), noLabel);
    const para = doc!.content![0].content![1].content![0].content![0];
    expect(para.content).toEqual([
      { type: "text", text: "첫 줄" },
      { type: "hardBreak" },
      { type: "text", text: "둘째 줄" },
    ]);
  });

  it("an empty sheet (or only blank/whitespace cells) is skipped — null, not an empty table", () => {
    expect(sheetToTableDoc(emptySheet(), noLabel)).toBeNull();
    expect(sheetToTableDoc(sheet({ A1: "   ", B2: "" }), noLabel)).toBeNull();
  });

  it("cells outside the grid the sheet draws (beyond rows/cols) are not exported", () => {
    const s = sheet({ A1: "보임", A5: "안 보임" }, [], 3);
    expect(sheetUsedRange(s)).toEqual({ rows: 1, cols: 1 });
    expect(grid(sheetToTableDoc(s, noLabel))).toEqual([["보임"]]);
  });

  it(`cuts tables past ${SHEET_EXPORT_MAX_ROWS} rows × ${SHEET_EXPORT_MAX_COLS} cols and says what was left out under the table`, () => {
    const cells: Record<string, string> = {};
    for (let r = 0; r < 600; r++) cells[refKey(0, r)] = `r${r + 1}`;
    for (let c = 0; c < 52; c++) cells[refKey(c, 0)] = `c${c + 1}`;
    const label = vi.fn((cut: SheetTruncation) => `… ${cut.moreRows}행·${cut.moreCols}열 더`);
    const doc = sheetToTableDoc(sheet(cells, Array.from({ length: 52 }, () => ({})), 1000), label);

    const rows = doc!.content![0].content!;
    expect(rows).toHaveLength(SHEET_EXPORT_MAX_ROWS);
    expect(rows[0].content).toHaveLength(SHEET_EXPORT_MAX_COLS);
    expect(label).toHaveBeenCalledWith({ moreRows: 100, moreCols: 2, shownRows: 500, shownCols: 50 });
    expect(doc!.content![1]).toEqual({ type: "paragraph", content: [{ type: "text", text: "… 100행·2열 더" }] });
  });

  it("does not ask for the label when nothing is cut", () => {
    const label = vi.fn(() => "x");
    const doc = sheetToTableDoc(sheet({ A1: "a" }), label);
    expect(label).not.toHaveBeenCalled();
    expect(doc!.content).toHaveLength(1);
  });
});
