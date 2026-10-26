// 클립보드 표 행렬(엑셀/구글시트 복붙, editor/tableAiPlan.ts::parseTableClipboardMatrix 가 판정)
// → 시트 섹션 문서. 행/열 상한 계산은 src-tauri/src/repo/csv_import.rs::rows_to_sheet_json 의
// TS 쌍둥이다 — 규칙이 갈리면 같은 표가 파일로 들어올 때와 클립보드로 들어올 때 다르게 잘린다
// (specs/commands/sections.yaml CSV/TSV 규칙 노트).
import { refKey } from "./a1";
import { emptySheet, SHEET_LIMITS, type Cell, type SheetDoc } from "./types";

export interface MatrixToSheetResult {
  doc: SheetDoc;
  /** true면 원본이 상한(1000행×52열)을 넘어 잘렸다 — 호출자가 토스트로 알린다. */
  truncated: boolean;
}

/** rows_to_sheet_json과 동일: 행 = max(데이터 행 수, 100) 상한 1000, 열 = max(데이터 열 수, 26)
 *  상한 52. 상한을 넘는 데이터는 잘라낸다(거부하지 않는다). */
export function sheetFromMatrix(matrix: string[][]): MatrixToSheetResult {
  const dataRows = matrix.length;
  const dataCols = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const truncated = dataRows > SHEET_LIMITS.maxRows || dataCols > SHEET_LIMITS.maxCols;

  const rows = Math.min(Math.max(dataRows, SHEET_LIMITS.initRows), SHEET_LIMITS.maxRows);
  const cols = Math.min(Math.max(dataCols, SHEET_LIMITS.initCols), SHEET_LIMITS.maxCols);

  // 상한을 넘는 행/열은 버린다 — 안 그러면 doc.rows/cols보다 큰 좌표의 셀이 cells 맵에 생겨
  // 문서가 스스로 모순된다(Rust의 .take(MAX_ROWS)/.take(MAX_COLS)와 동일 규칙).
  //
  // 행렬을 탭 문자열로 되돌려 fromTsv에 태우지 **않는다**. 지금 유일한 호출자
  // (parseTableClipboardMatrix)는 탭/개행으로 쪼갠 결과라 셀 안에 그 문자가 없지만, 셀 안 개행을
  // 허용하는 CSV 파서(Rust csv_import)의 행렬을 누가 이 함수에 넘기는 순간 join/split 왕복이
  // 표를 조용히 어긋나게 만든다. 셀을 그대로 얹는 쪽이 더 짧기도 하다.
  const cells: Record<string, Cell> = {};
  for (let r = 0; r < Math.min(matrix.length, SHEET_LIMITS.maxRows); r++) {
    const row = matrix[r] ?? [];
    for (let c = 0; c < Math.min(row.length, SHEET_LIMITS.maxCols); c++) {
      const raw = row[c];
      if (!raw) continue; // 희소 맵 — 빈 셀은 키 자체를 넣지 않는다
      cells[refKey(c, r)] = { raw };
    }
  }

  const doc: SheetDoc = {
    ...emptySheet(),
    rows,
    cols: Array.from({ length: cols }, () => ({})),
    cells,
  };
  return { doc, truncated };
}
