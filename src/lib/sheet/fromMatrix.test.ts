import { describe, expect, it } from "vitest";
import { sheetFromMatrix } from "./fromMatrix";
import { SHEET_LIMITS } from "./types";

// 클립보드 표 붙여넣기 → 시트 문서. 행/열 상한 규칙은 src-tauri/src/repo/csv_import.rs::
// rows_to_sheet_json 의 TS 쌍둥이 — 두 쪽이 갈리면 같은 표가 파일로 들어올 때와 클립보드로
// 들어올 때 다르게 잘린다(specs/commands/sections.yaml CSV/TSV 규칙 참고).
describe("sheetFromMatrix", () => {
  it("small matrix: rows/cols grow to the sheet init size, no truncation", () => {
    const { doc, truncated } = sheetFromMatrix([
      ["항목", "금액"],
      ["커피", "4500"],
    ]);
    expect(truncated).toBe(false);
    expect(doc.rows).toBe(SHEET_LIMITS.initRows);
    expect(doc.cols.length).toBe(SHEET_LIMITS.initCols);
    expect(doc.cells.A1).toEqual({ raw: "항목" });
    expect(doc.cells.B1).toEqual({ raw: "금액" });
    expect(doc.cells.A2).toEqual({ raw: "커피" });
    expect(doc.cells.B2).toEqual({ raw: "4500" });
  });

  it("empty cells stay out of the sparse map (pasted blank cell, not '0')", () => {
    const { doc } = sheetFromMatrix([
      ["a", ""],
      ["", "d"],
    ]);
    expect(doc.cells.B1).toBeUndefined();
    expect(doc.cells.A2).toBeUndefined();
    expect(doc.cells.A1).toEqual({ raw: "a" });
    expect(doc.cells.B2).toEqual({ raw: "d" });
  });

  it("matrix larger than init size but under the hard cap: sized to the data, not truncated", () => {
    const rows = Array.from({ length: 200 }, (_, r) => [`r${r}`, "x"]);
    const { doc, truncated } = sheetFromMatrix(rows);
    expect(truncated).toBe(false);
    expect(doc.rows).toBe(200);
    expect(doc.cols.length).toBe(SHEET_LIMITS.initCols); // 2 cols < init 26 → grows to 26
  });

  it("matrix beyond the hard cap (rows): capped at maxRows and flagged truncated", () => {
    const rows = Array.from({ length: SHEET_LIMITS.maxRows + 50 }, (_, r) => [String(r)]);
    const { doc, truncated } = sheetFromMatrix(rows);
    expect(truncated).toBe(true);
    expect(doc.rows).toBe(SHEET_LIMITS.maxRows);
    // no cell beyond the row cap leaked into the sparse map
    expect(doc.cells[`A${SHEET_LIMITS.maxRows + 1}`]).toBeUndefined();
    expect(doc.cells[`A${SHEET_LIMITS.maxRows}`]).toEqual({ raw: String(SHEET_LIMITS.maxRows - 1) });
  });

  it("matrix beyond the hard cap (cols): capped at maxCols and flagged truncated", () => {
    const row = Array.from({ length: SHEET_LIMITS.maxCols + 10 }, (_, c) => `c${c}`);
    const { doc, truncated } = sheetFromMatrix([row]);
    expect(truncated).toBe(true);
    expect(doc.cols.length).toBe(SHEET_LIMITS.maxCols);
    // column index maxCols (0-based) is the first dropped one
    expect(doc.cells.BA1).toBeUndefined(); // BA = col 52 (0-based), one past the AZ=51 cap
  });

  // 왕복 함정 회귀: 예전 구현은 행렬을 탭/개행으로 join 했다가 다시 split 했다. 셀 안에 그 문자가
  // 들어 있는 행렬(예: Rust csv_import 처럼 따옴표 안 개행을 허용하는 파서의 출력)을 넘기면
  // 표가 조용히 어긋났다. 이제는 셀을 그대로 얹으므로 모양이 보존된다.
  it("keeps a cell that itself contains a tab or newline in one cell", () => {
    const { doc } = sheetFromMatrix([
      ["a", "b\tc"],
      ["d\ne", "f"],
    ]);
    expect(doc.cells.A1?.raw).toBe("a");
    expect(doc.cells.B1?.raw).toBe("b\tc");
    expect(doc.cells.A2?.raw).toBe("d\ne");
    expect(doc.cells.B2?.raw).toBe("f");
    expect(doc.cells.C1).toBeUndefined();
  });
});
