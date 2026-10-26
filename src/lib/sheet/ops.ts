// 구조 편집 — 행/열 삽입·삭제·정렬·자동 성장. 전부 순수 함수(새 doc 반환).
// 반환의 `undo` 를 그대로 history 에 넣으면 되돌아간다.

import { colToLetters, parseRef, refKey } from './a1';
import { remapRows, shiftFormula } from './rewrite';
import { literal } from './literal';
import { SHEET_LIMITS, type Cell, type CellPatch, type ChartSpec, type ColSpec, type SheetDoc } from './types';

/** 자동 성장 트리거 — 마지막 N행/N열 안에 내용이 생기면 늘린다(specs/features/sheet.md 크기 결정). */
const GROW_TRIGGER_ROWS = 10;
const GROW_TRIGGER_COLS = 2;

/**
 * 되돌리기 1단계. **그 편집이 실제로 바꾼 것만 싣는다** — 없는 칸은 되돌릴 때 현재 값을 유지한다.
 * 셀만 고친 편집이 rows/cols/charts 스냅샷을 들고 있으면, 그 뒤에 바꾼 열 서식·차트까지
 * 같이 되감긴다(라이브 QA 2026-08-19: 셀 undo 한 번에 차트가 사라졌다).
 * cols 는 개수가 아니라 배열 그대로 — 열 폭/서식까지 원상복구된다.
 */
export interface UndoStep {
  patch: CellPatch;
  rows?: number;
  cols?: ColSpec[];
  charts?: ChartSpec[];
  /** 첫 행 고정 — 0 = 해제(문서에선 필드 자체가 없다). 스텝이 들고 있을 때만 복원(rows/cols 와 같은 규칙). */
  frozenRows?: number;
}

export interface OpResult {
  doc: SheetDoc;
  undo: UndoStep;
}

/** 내용이 있는 마지막 행/열 (0-based). 아무것도 없으면 -1. */
export function usedBounds(doc: SheetDoc): { row: number; col: number } {
  let row = -1;
  let col = -1;
  for (const key of Object.keys(doc.cells)) {
    const ref = parseRef(key);
    if (!ref) continue;
    if (ref.row > row) row = ref.row;
    if (ref.col > col) col = ref.col;
  }
  return { row, col };
}

/** 셀 맵 전체 교체를 하나의 패치 + 그 역패치로 만든다. */
function diffCells(before: Record<string, Cell>, after: Record<string, Cell>): { patch: CellPatch; undo: CellPatch } {
  const patch: CellPatch = {};
  const undo: CellPatch = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b && a && b.raw === a.raw && b.fmt === a.fmt && b.dp === a.dp && b.cur === a.cur) continue;
    patch[key] = a ? { raw: a.raw, fmt: a.fmt ?? null, dp: a.dp ?? null, cur: a.cur ?? null } : { raw: null };
    undo[key] = b ? { raw: b.raw, fmt: b.fmt ?? null, dp: b.dp ?? null, cur: b.cur ?? null } : { raw: null };
  }
  return { patch, undo };
}

/** 모든 셀의 수식을 구조 편집에 맞춰 다시 쓴다. */
function rewriteAll(cells: Record<string, Cell>, axis: 'row' | 'col', at: number, delta: number): void {
  for (const key of Object.keys(cells)) {
    const raw = cells[key].raw;
    if (raw.startsWith('=')) cells[key] = { ...cells[key], raw: shiftFormula(raw, { axis, at, delta }) };
  }
}

function structural(doc: SheetDoc, axis: 'row' | 'col', at: number, delta: number): OpResult {
  const next: Record<string, Cell> = {};
  const n = Math.abs(delta);
  for (const [key, cell] of Object.entries(doc.cells)) {
    const ref = parseRef(key);
    if (!ref) continue;
    const v = axis === 'row' ? ref.row : ref.col;
    let moved: number;
    if (delta > 0) moved = v >= at ? v + delta : v;
    else {
      if (v >= at && v < at + n) continue; // 삭제된 행/열의 셀은 사라진다
      moved = v >= at + n ? v - n : v;
    }
    next[axis === 'row' ? refKey(ref.col, moved) : refKey(moved, ref.row)] = { ...cell };
  }
  rewriteAll(next, axis, at, delta);

  let rows = doc.rows;
  let cols = doc.cols;
  if (axis === 'row') {
    rows = Math.max(1, Math.min(doc.rows + delta, SHEET_LIMITS.maxRows));
  } else if (delta > 0) {
    const room = Math.min(delta, SHEET_LIMITS.maxCols - doc.cols.length);
    cols = [...doc.cols.slice(0, at), ...Array.from({ length: Math.max(0, room) }, () => ({}) as ColSpec), ...doc.cols.slice(at)];
  } else {
    cols = [...doc.cols.slice(0, at), ...doc.cols.slice(at + n)];
  }

  const { undo } = diffCells(doc.cells, next);
  const step: UndoStep = { patch: undo };
  if (rows !== doc.rows) step.rows = doc.rows;
  if (cols !== doc.cols) step.cols = doc.cols;
  return {
    doc: { ...doc, rows, cols, cells: next },
    undo: step,
  };
}

export function insertRows(doc: SheetDoc, at: number, n = 1): OpResult {
  return structural(doc, 'row', at, n);
}
export function deleteRows(doc: SheetDoc, at: number, n = 1): OpResult {
  return structural(doc, 'row', at, -n);
}
export function insertCols(doc: SheetDoc, at: number, n = 1): OpResult {
  return structural(doc, 'col', at, n);
}
export function deleteCols(doc: SheetDoc, at: number, n = 1): OpResult {
  return structural(doc, 'col', at, -n);
}

/**
 * 임의의(연속이 아닐 수도 있는) 행 목록을 한 번에 삭제 — dedupe_rows 어시스트 전용(구간이 아니라
 * "이 행들만" 골라 지운다). 큰 인덱스부터 기존 deleteRows(단일 구간)를 반복 적용한다 — 구조 편집의
 * shiftPoint 는 삭제 지점보다 큰 행만 당기므로, 내림차순으로 처리하면 아직 처리 안 한 더 작은
 * 인덱스는 앞선 삭제로 밀리지 않는다(직접 한 행씩 지우는 것과 같은 순서). undo 는 시작·끝 문서
 * 스냅샷의 diff 하나로 접어(중간 스텝은 버리고) 1스텝을 지킨다.
 */
export function deleteRowsAt(doc: SheetDoc, rows: number[]): OpResult {
  const unique = [...new Set(rows)].filter((r) => r >= 0 && r < doc.rows).sort((a, b) => b - a);
  if (unique.length === 0) return { doc, undo: { patch: {} } };
  let current = doc;
  for (const r of unique) current = deleteRows(current, r, 1).doc;
  const { undo } = diffCells(doc.cells, current.cells);
  const step: UndoStep = { patch: undo };
  if (current.rows !== doc.rows) step.rows = doc.rows;
  return { doc: current, undo: step };
}

/**
 * 한 열의 값 기준 정렬 — 실제 데이터가 움직이고, 단일 참조는 따라 움직인다(rewrite.remapRows).
 * headerRows 만큼의 윗행은 고정. 정렬 키는 raw 의 리터럴 값(수식 결과가 아니라 — 계산값은
 * 저장하지 않으므로 순수 함수로 남기려면 여기까지가 천장이다).
 * ponytail: 수식 셀 기준 정렬이 필요해지면 엔진의 계산값 스냅샷을 인자로 받으면 된다.
 */
export function sortByCol(
  doc: SheetDoc,
  col: number,
  dir: 'asc' | 'desc' = 'asc',
  opts: { headerRows?: number } = {},
): OpResult {
  const headerRows = opts.headerRows ?? 1;
  const bounds = usedBounds(doc);
  const lastRow = Math.max(bounds.row, headerRows - 1);
  const body: number[] = [];
  for (let r = headerRows; r <= lastRow; r++) body.push(r);

  const keyOf = (row: number) => literal(doc.cells[refKey(col, row)]?.raw ?? '');
  const sorted = [...body].sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    // 빈 칸은 언제나 뒤로 (오름/내림 무관) — 스프레드시트 관례.
    if (x === null && y === null) return a - b;
    if (x === null) return 1;
    if (y === null) return -1;
    let c: number;
    if (typeof x === 'number' && typeof y === 'number') c = x - y;
    else c = String(x).localeCompare(String(y));
    if (c === 0) return a - b; // 안정 정렬
    return dir === 'asc' ? c : -c;
  });

  const rowMap = new Map<number, number>();
  sorted.forEach((oldRow, i) => rowMap.set(oldRow, headerRows + i));

  const next: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(doc.cells)) {
    const ref = parseRef(key);
    if (!ref) continue;
    const to = rowMap.get(ref.row) ?? ref.row;
    next[refKey(ref.col, to)] = { ...cell };
  }
  for (const key of Object.keys(next)) {
    const raw = next[key].raw;
    if (raw.startsWith('=')) next[key] = { ...next[key], raw: remapRows(raw, rowMap) };
  }

  const { undo } = diffCells(doc.cells, next);
  // 정렬은 rows/cols 를 건드리지 않는다 — 스텝도 셀 패치만 든다.
  return {
    doc: { ...doc, cells: next },
    undo: { patch: undo },
  };
}

/**
 * 자동 성장 — 마지막 10행/2열 안에 내용이 있으면 +50행 / +26열, 상한 1000행 × 52열(AZ).
 * 변화가 없으면 **같은 객체**를 그대로 돌려준다(호출부의 === 비교로 저장을 건너뛸 수 있게).
 */
export function ensureCapacity(doc: SheetDoc): SheetDoc {
  const b = usedBounds(doc);
  let rows = doc.rows;
  let cols = doc.cols;
  if (b.row >= rows - GROW_TRIGGER_ROWS && rows < SHEET_LIMITS.maxRows) {
    rows = Math.min(rows + SHEET_LIMITS.growRows, SHEET_LIMITS.maxRows);
  }
  if (b.col >= cols.length - GROW_TRIGGER_COLS && cols.length < SHEET_LIMITS.maxCols) {
    const room = Math.min(SHEET_LIMITS.growCols, SHEET_LIMITS.maxCols - cols.length);
    cols = [...cols, ...Array.from({ length: room }, () => ({}) as ColSpec)];
  }
  if (rows === doc.rows && cols === doc.cols) return doc;
  return { ...doc, rows, cols };
}

/** 상한에 닿아 더는 자랄 수 없는데 내용이 성장 트리거 구역까지 온 상태 — "CSV 로 내보내기" 배너 조건. */
export function atLimit(doc: SheetDoc): boolean {
  const b = usedBounds(doc);
  return (
    (doc.rows >= SHEET_LIMITS.maxRows && b.row >= doc.rows - GROW_TRIGGER_ROWS) ||
    (doc.cols.length >= SHEET_LIMITS.maxCols && b.col >= doc.cols.length - GROW_TRIGGER_COLS)
  );
}

/** 열 머리글 표기 — 그리드/에러 메시지 공용. */
export { colToLetters };
