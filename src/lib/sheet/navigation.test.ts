import { describe, expect, it } from 'vitest';
import {
  AUTOFIT_PADDING,
  autoFitWidth,
  extendSelection,
  extendSelectionToJump,
  fillHandleDoubleClickTarget,
  jumpTarget,
  selectAllRange,
} from './navigation';
import { emptySheet, type SheetDoc } from './types';

function docWith(cells: Record<string, string>, over: Partial<SheetDoc> = {}): SheetDoc {
  return {
    ...emptySheet(),
    ...over,
    cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])),
  };
}

describe('jumpTarget', () => {
  it('인접 칸이 비었으면 다음 채워진 칸으로 건너뛴다', () => {
    const doc = docWith({ A1: '1', D1: '4' });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'right')).toEqual({ row: 0, col: 3 });
  });

  it('연속 블록이면 그 끝에서 멈춘다', () => {
    const doc = docWith({ A1: '1', B1: '2', C1: '3' });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'right')).toEqual({ row: 0, col: 2 });
  });

  it('더 채워진 칸이 없으면 가장자리에서 멈춘다', () => {
    const doc = docWith({ A1: '1' });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'right')).toEqual({ row: 0, col: doc.cols.length - 1 });
  });

  it('빈 칸에서 시작해도 같은 규칙(다음 채워진 칸 또는 그 블록 끝)을 따른다', () => {
    const doc = docWith({ D1: '1', E1: '2', G1: '3' });
    // C1(빈 칸)에서 오른쪽: 인접 D1 이 찼다 → D1·E1 블록의 끝인 E1 에서 멈춘다.
    expect(jumpTarget(doc, { row: 0, col: 2 }, 'right')).toEqual({ row: 0, col: 4 });
  });

  it('위/아래 방향도 같은 규칙', () => {
    const doc = docWith({ A1: '1', A2: '2', A4: '4' });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'down')).toEqual({ row: 1, col: 0 });
  });

  it('이미 가장자리 활성 셀이면 그대로 돌려준다(조기 반환 분기)', () => {
    const doc = docWith({ A1: '1', B1: '2' });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'up')).toEqual({ row: 0, col: 0 });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'left')).toEqual({ row: 0, col: 0 });
  });

  it('셀이 전부 빈 문서에서도 가장자리로 이동한다', () => {
    const doc = emptySheet();
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'right')).toEqual({ row: 0, col: doc.cols.length - 1 });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'down')).toEqual({ row: doc.rows - 1, col: 0 });
  });

  it('1행짜리 작은 문서에서 위/아래로 점프해도 범위를 벗어나지 않는다', () => {
    const doc = docWith({ A1: '1' }, { rows: 1 });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'down')).toEqual({ row: 0, col: 0 });
    expect(jumpTarget(doc, { row: 0, col: 0 }, 'up')).toEqual({ row: 0, col: 0 });
  });
});

// SheetGrid 가 실제로 넘기는 그리드 크기(빈 문서도 최소 50행×26열).
const ROWS = 50;
const COLS = 26;
const cell = (row: number, col: number) => ({ r1: row, c1: col, r2: row, c2: col });

describe('extendSelection', () => {
  it('네 방향 모두 활성 셀을 고정하고 반대 모서리만 한 칸 넓힌다', () => {
    const active = { row: 5, col: 5 };
    const from = cell(5, 5);
    expect(extendSelection(from, active, 'down', ROWS, COLS)).toEqual({ r1: 5, c1: 5, r2: 6, c2: 5 });
    expect(extendSelection(from, active, 'up', ROWS, COLS)).toEqual({ r1: 4, c1: 5, r2: 5, c2: 5 });
    expect(extendSelection(from, active, 'right', ROWS, COLS)).toEqual({ r1: 5, c1: 5, r2: 5, c2: 6 });
    expect(extendSelection(from, active, 'left', ROWS, COLS)).toEqual({ r1: 5, c1: 4, r2: 5, c2: 5 });
  });

  it('이미 넓힌 범위는 활성 셀 반대편 모서리가 계속 움직인다', () => {
    const active = { row: 2, col: 2 };
    const range = { r1: 2, c1: 2, r2: 4, c2: 2 };
    expect(extendSelection(range, active, 'down', ROWS, COLS)).toEqual({ r1: 2, c1: 2, r2: 5, c2: 2 });
    // 반대로 줄이는 쪽(위)도 같은 모서리가 움직인다 — 4 → 3.
    expect(extendSelection(range, active, 'up', ROWS, COLS)).toEqual({ r1: 2, c1: 2, r2: 3, c2: 2 });
  });

  it('활성 셀이 범위의 우하단이면 좌상단 모서리가 움직인다', () => {
    const active = { row: 4, col: 4 };
    const range = { r1: 2, c1: 2, r2: 4, c2: 4 };
    expect(extendSelection(range, active, 'up', ROWS, COLS)).toEqual({ r1: 1, c1: 2, r2: 4, c2: 4 });
    expect(extendSelection(range, active, 'left', ROWS, COLS)).toEqual({ r1: 2, c1: 1, r2: 4, c2: 4 });
  });

  it('경계 0 에서 위/왼쪽은 더 못 간다', () => {
    const active = { row: 0, col: 0 };
    expect(extendSelection(cell(0, 0), active, 'up', ROWS, COLS)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(extendSelection(cell(0, 0), active, 'left', ROWS, COLS)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });

  it('경계 numRows-1 · numCols-1 에서 아래/오른쪽은 더 못 간다', () => {
    const active = { row: ROWS - 1, col: COLS - 1 };
    const at = cell(ROWS - 1, COLS - 1);
    expect(extendSelection(at, active, 'down', ROWS, COLS)).toEqual({ r1: 49, c1: 25, r2: 49, c2: 25 });
    expect(extendSelection(at, active, 'right', ROWS, COLS)).toEqual({ r1: 49, c1: 25, r2: 49, c2: 25 });
  });
});

describe('extendSelectionToJump', () => {
  it('네 방향 모두 반대 모서리를 데이터 끝까지 점프시켜 확장한다', () => {
    const doc = docWith({ A1: '1', A2: '2', A3: '3', B1: '1', C1: '1' });
    const active = { row: 0, col: 0 };
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'down')).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'right')).toEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
    // 가장자리(0행/0열)에서 위·왼쪽은 jumpTarget 이 제자리를 돌려주므로 한 칸 그대로.
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'up')).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'left')).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });

  it('데이터가 없으면 문서 경계(doc.rows-1 · doc.cols.length-1)까지 확장한다', () => {
    const doc = emptySheet(); // 100행 × 26열
    const active = { row: 0, col: 0 };
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'down')).toEqual({
      r1: 0, c1: 0, r2: doc.rows - 1, c2: 0,
    });
    expect(extendSelectionToJump(doc, cell(0, 0), active, 'right')).toEqual({
      r1: 0, c1: 0, r2: 0, c2: doc.cols.length - 1,
    });
  });

  it('활성 셀이 우하단이면 좌상단 모서리가 점프한다', () => {
    const doc = docWith({ A1: '1', A2: '2', A3: '3' });
    const active = { row: 2, col: 0 };
    expect(extendSelectionToJump(doc, { r1: 1, c1: 0, r2: 2, c2: 0 }, active, 'up')).toEqual({
      r1: 0, c1: 0, r2: 2, c2: 0,
    });
  });
});

describe('selectAllRange', () => {
  it('selectAllRange 는 문서 전체 범위를 돌려준다', () => {
    const doc = emptySheet();
    expect(selectAllRange(doc)).toEqual({ r1: 0, c1: 0, r2: doc.rows - 1, c2: doc.cols.length - 1 });
  });
});

describe('fillHandleDoubleClickTarget', () => {
  it('fillHandleDoubleClickTarget 은 인접 열의 연속 데이터 끝 행까지 확장한다', () => {
    const doc = docWith({ A1: '1', A2: '2', A3: '3', A4: '4', B1: 'x' });
    const target = fillHandleDoubleClickTarget(doc, { r1: 0, c1: 1, r2: 0, c2: 1 });
    expect(target).toEqual({ r1: 0, c1: 1, r2: 3, c2: 1 });
  });

  it('왼쪽에 이어질 데이터가 없으면 오른쪽 열을 본다', () => {
    const doc = docWith({ B1: 'x', C1: '1', C2: '2' });
    const target = fillHandleDoubleClickTarget(doc, { r1: 0, c1: 1, r2: 0, c2: 1 });
    expect(target).toEqual({ r1: 0, c1: 1, r2: 1, c2: 1 });
  });

  it('양쪽 다 이어질 데이터가 없으면 그대로 돌려준다', () => {
    const doc = docWith({ B1: 'x' });
    const source = { r1: 0, c1: 1, r2: 0, c2: 1 };
    expect(fillHandleDoubleClickTarget(doc, source)).toEqual(source);
  });
});

describe('autoFitWidth', () => {
  it('autoFitWidth 는 열의 가장 넓은 값 폭에 패딩을 더한다', () => {
    const longest = '이건 훨씬 긴 문자열입니다';
    const doc = docWith({ A1: '짧다', A2: longest });
    const measure = (text: string) => text.length * 10; // 고정 폭 가짜 측정기 — canvas 없이도 테스트 가능
    expect(autoFitWidth(doc, 0, measure)).toBe(longest.length * 10 + AUTOFIT_PADDING);
  });

  it('값이 없으면 최소 폭으로 떨어진다', () => {
    const doc = emptySheet();
    expect(autoFitWidth(doc, 0, () => 0)).toBe(40);
  });
});

