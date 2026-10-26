// CSV 직렬화 헬퍼 (RFC 4180 호환 및 Excel 친화적 CRLF)
import { parseRef } from "./a1";
import type { SheetDoc } from "./types";

/**
 * RFC 4180 호환 CSV 셀 이스케이프:
 * 큰따옴표("), 쉼표(,), 개행(\n, \r)이 포함된 경우 큰따옴표로 둘러싸고 내부의 "는 ""로 치환.
 */
export function escapeCsvCell(val: string): string {
  if (val.includes('"') || val.includes(",") || val.includes("\n") || val.includes("\r")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * SheetDoc → CSV 문자열 (내용이 있는 범위).
 */
export function toCsv(doc: SheetDoc, maxRows?: number): string {
  const placed: Array<[number, number, string]> = [];
  let w = 0;
  let h = 0;
  for (const [key, cell] of Object.entries(doc.cells)) {
    const ref = parseRef(key);
    if (!ref || typeof cell?.raw !== "string") continue;
    w = Math.max(w, ref.col + 1);
    h = Math.max(h, ref.row + 1);
    placed.push([ref.row, ref.col, cell.raw]);
  }
  if (maxRows !== undefined) h = Math.min(h, maxRows);
  const out: string[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ""));
  for (const [r, c, raw] of placed) {
    if (r < h) out[r][c] = raw;
  }
  return out.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}
