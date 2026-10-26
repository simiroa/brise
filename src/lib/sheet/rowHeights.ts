// 행 높이 자동(오너 제안 #2, PLAN-2026-09-21-sheet-excel-muscle.md §3 잔여).
// 순수 함수만 — DOM·React 없음. **지속 없음**: SheetDoc 에 필드를 추가하지 않는다.
// 행 높이는 셀 raw 의 개행 수에서 매번 다시 파생한다(단일 소스 = 셀 raw, 캐시 없음).
import { refKey } from "./a1";
import type { SheetDoc } from "./types";

/** 그 이상은 줄 수를 세지 않는다 — 시트 한 칸이 화면을 뒤덮는 사고 방지. */
export const MAX_LINES = 6;

/** SheetGrid.tsx 가 이 값을 그대로 import 한다(로컬 상수 없음, §3 가변 행 높이 배선 완료). */
export const DEFAULT_ROW_HEIGHT = 24;

/**
 * 한 줄 늘 때마다 더할 픽셀. sheetSection.css `.sheet-cell` 의 실제 폰트/줄간격에서 계산한다:
 * font-size: var(--text-md) = 13px * var(--fs)(기본 배율 1) → 13px
 * line-height: var(--lh-ui) = 1.45 → 13 * 1.45 = 18.85px, 잘리지 않게 올림 → 19px
 * (`--fs` 로 글자 크기를 키운 사용자 설정에선 근사치다 — ponytail: 정밀 대응은 실사용 후.)
 */
export const LINE_STEP = 19;

/**
 * 행마다 가장 긴 셀의 줄 수(최소 1, 상한 {@link MAX_LINES}).
 * 수식(`raw` 가 `=` 로 시작)은 화면에 계산 결과 한 줄만 보이므로 raw 안의 개행은 세지 않는다.
 */
export function rowLineCounts(doc: SheetDoc, numRows: number): number[] {
  const out = new Array<number>(numRows).fill(1);
  for (let r = 0; r < numRows; r++) {
    let max = 1;
    for (let c = 0; c < doc.cols.length; c++) {
      const raw = doc.cells[refKey(c, r)]?.raw;
      if (!raw || raw.startsWith("=")) continue;
      const lines = raw.split("\n").length;
      if (lines > max) max = lines;
    }
    out[r] = Math.min(max, MAX_LINES);
  }
  return out;
}

/** 줄 수 → 픽셀 행 높이. */
export function rowHeightOf(lines: number): number {
  const clamped = Math.min(Math.max(1, lines), MAX_LINES);
  return DEFAULT_ROW_HEIGHT + (clamped - 1) * LINE_STEP;
}

/** 행 높이 배열 → 누적 오프셋(길이 = heights.length + 1, out[i] = 0..i-1 행의 총 높이). */
export function rowOffsets(heights: number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}
