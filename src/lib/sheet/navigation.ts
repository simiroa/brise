// 선택·이동 문법의 순수 함수 (PLAN-2026-09-21 W1). DOM·React 없음 — SheetGrid.tsx 가 호출부.
//
// `SheetRange` 는 useSheetState.ts 의 `CellRange`({r1,c1,r2,c2})와 구조가 같다(같은 필드) — lib 가
// components 를 import 하지 않도록 여기서 따로 선언한다. 호출부는 구조적 타이핑으로 그대로 넘긴다.

import { refKey } from './a1';
import type { SheetDoc } from './types';

export interface SheetRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

/** 열 리사이즈·자동 맞춤 공용 최소 폭 — SheetGrid 의 드래그 리사이즈도 이 값을 쓴다. */
export const SHEET_MIN_COL_WIDTH = 40;

/** 자동 맞춤 폭 계산의 좌우 여유(px). */
export const AUTOFIT_PADDING = 16;

function isFilled(doc: SheetDoc, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= doc.rows || col >= doc.cols.length) return false;
  const raw = doc.cells[refKey(col, row)]?.raw;
  return !!raw;
}

function stepOf(dir: Dir): { dr: number; dc: number } {
  switch (dir) {
    case 'up': return { dr: -1, dc: 0 };
    case 'down': return { dr: 1, dc: 0 };
    case 'left': return { dr: 0, dc: -1 };
    case 'right': return { dr: 0, dc: 1 };
  }
}

/**
 * 엑셀 Ctrl+화살표 규칙: 인접 칸이 비었으면 다음 채워진 칸까지, 차 있으면 그 연속 블록의
 * 끝까지. 양쪽 다 없으면 가장자리. `from`·반환값 모두 0-based 좌표(행/열 어느 쪽도 문서
 * 경계를 벗어나지 않는다).
 */
export function jumpTarget(doc: SheetDoc, from: { row: number; col: number }, dir: Dir): { row: number; col: number } {
  const { dr, dc } = stepOf(dir);
  const maxRow = doc.rows - 1;
  const maxCol = doc.cols.length - 1;
  const inBounds = (r: number, c: number) => r >= 0 && r <= maxRow && c >= 0 && c <= maxCol;

  const nextR = from.row + dr;
  const nextC = from.col + dc;
  if (!inBounds(nextR, nextC)) return { row: from.row, col: from.col }; // 이미 가장자리

  let r = nextR;
  let c = nextC;
  if (!isFilled(doc, r, c)) {
    // 인접 칸이 비었다 — 다음 채워진 칸까지 건너뛴다. 못 찾으면 가장자리에서 멈춘다.
    while (!isFilled(doc, r, c)) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) return { row: r, col: c };
      r = nr; c = nc;
    }
    return { row: r, col: c };
  }
  // 인접 칸이 찼다 — 연속 블록의 끝(다음이 비었거나 가장자리)까지 간다.
  while (true) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc) || !isFilled(doc, nr, nc)) return { row: r, col: c };
    r = nr; c = nc;
  }
}

/** 활성 셀이 고정점일 때 움직이는 쪽(= 반대 모서리). Shift 확장 계열이 공통으로 쓴다. */
function oppositeCorner(range: SheetRange, active: { row: number; col: number }): { row: number; col: number } {
  return {
    row: active.row === range.r1 ? range.r2 : range.r1,
    col: active.col === range.c1 ? range.c2 : range.c1,
  };
}

/** 두 좌표를 감싸는 정규화 범위(r1<=r2, c1<=c2). */
function rangeBetween(a: { row: number; col: number }, b: { row: number; col: number }): SheetRange {
  return {
    r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
  };
}

/**
 * Shift+화살표 — 활성 셀 고정, 반대 모서리를 한 칸 확장(기존 Shift+클릭의 min/max 계산 재사용).
 * 경계는 **그리드 크기**(`numRows`/`numCols`)로 클램프한다 — 문서 크기가 아니다. SheetGrid 는
 * 빈 문서도 최소 50행×26열을 그리므로 둘이 다를 수 있다.
 */
export function extendSelection(
  range: SheetRange,
  active: { row: number; col: number },
  dir: Dir,
  numRows: number,
  numCols: number
): SheetRange {
  const corner = oppositeCorner(range, active);
  const nextRow =
    dir === 'up' ? Math.max(0, corner.row - 1)
    : dir === 'down' ? Math.min(numRows - 1, corner.row + 1)
    : corner.row;
  const nextCol =
    dir === 'left' ? Math.max(0, corner.col - 1)
    : dir === 'right' ? Math.min(numCols - 1, corner.col + 1)
    : corner.col;
  return rangeBetween(active, { row: nextRow, col: nextCol });
}

/**
 * Ctrl+Shift+화살표 — 활성 셀 고정, 반대 모서리를 `jumpTarget` 로 점프시켜 확장.
 * 점프는 **문서 경계**(`doc.rows`/`doc.cols`)를 따른다(위 `extendSelection` 과 다른 점).
 */
export function extendSelectionToJump(
  doc: SheetDoc,
  range: SheetRange,
  active: { row: number; col: number },
  dir: Dir
): SheetRange {
  return rangeBetween(active, jumpTarget(doc, oppositeCorner(range, active), dir));
}

/** Ctrl+A · 모서리 칸 클릭 — 문서 전체 범위. */
export function selectAllRange(doc: SheetDoc): SheetRange {
  return { r1: 0, c1: 0, r2: doc.rows - 1, c2: doc.cols.length - 1 };
}

/**
 * 채우기 핸들 더블클릭 — 왼쪽 인접 열(없으면 오른쪽)의 연속 데이터 끝 행까지 아래로 확장한
 * 범위를 돌려준다. 인접 열에 이어질 데이터가 없으면 `sourceRange` 그대로(변화 없음).
 */
export function fillHandleDoubleClickTarget(doc: SheetDoc, sourceRange: SheetRange): SheetRange {
  const leftCol = sourceRange.c1 - 1;
  const rightCol = sourceRange.c2 + 1;
  const pickCol =
    leftCol >= 0 && isFilled(doc, sourceRange.r1, leftCol) ? leftCol
    : rightCol < doc.cols.length && isFilled(doc, sourceRange.r1, rightCol) ? rightCol
    : null;
  if (pickCol === null) return sourceRange;

  let endRow = sourceRange.r1;
  for (let r = sourceRange.r1 + 1; r < doc.rows; r++) {
    if (!isFilled(doc, r, pickCol)) break;
    endRow = r;
  }
  if (endRow <= sourceRange.r2) return sourceRange;
  return { ...sourceRange, r2: endRow };
}

/**
 * 열 경계 더블클릭 — 그 열 값들의 렌더 폭 최대치 + 여유. `measure` 는 실제 렌더 폭 측정을
 * 주입받는다(호출부는 canvas.measureText, 테스트는 고정 함수). 값이 없는 열은 doc.rows 만큼
 * 훑어도 비용이 크지 않다(더블클릭 1회성 호출).
 * ponytail: 수식 셀은 평가값이 아니라 raw 문자열로 측정한다(엔진 없이 순수 함수로 유지하려는
 * 선택) — 평가값 기준 자동 맞춤이 필요해지면 engine 을 인자로 추가.
 */
export function autoFitWidth(doc: SheetDoc, col: number, measure: (text: string) => number): number {
  let maxW = 0;
  for (let r = 0; r < doc.rows; r++) {
    const raw = doc.cells[refKey(col, r)]?.raw;
    if (!raw) continue;
    const w = measure(raw);
    if (w > maxW) maxW = w;
  }
  return Math.max(SHEET_MIN_COL_WIDTH, Math.ceil(maxW) + AUTOFIT_PADDING);
}
