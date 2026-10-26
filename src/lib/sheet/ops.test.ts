import { describe, expect, it } from 'vitest';
import { atLimit, deleteCols, deleteRows, ensureCapacity, insertCols, insertRows, sortByCol, usedBounds } from './ops';
import { applyStep } from './history';
import { emptySheet, SHEET_LIMITS, type SheetDoc } from './types';

function docOf(cells: Record<string, string>, over: Partial<SheetDoc> = {}): SheetDoc {
  return {
    ...emptySheet(),
    ...over,
    cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])),
  };
}
const raws = (doc: SheetDoc) => Object.fromEntries(Object.entries(doc.cells).map(([k, c]) => [k, c.raw]));

describe('insert/delete rows', () => {
  it('행 삽입이 셀을 내리고 수식을 다시 쓴다', () => {
    const { doc } = insertRows(docOf({ A1: 'head', A2: '1', A3: '2', B3: '=SUM(A2:A3)' }), 1);
    expect(raws(doc)).toEqual({ A1: 'head', A3: '1', A4: '2', B4: '=SUM(A3:A4)' });
    expect(doc.rows).toBe(SHEET_LIMITS.initRows + 1);
  });

  it('행 삭제가 셀을 지우고 남은 수식을 #REF! 로 만든다', () => {
    const { doc } = deleteRows(docOf({ A1: '1', A2: '2', B1: '=A2' }), 1);
    expect(raws(doc)).toEqual({ A1: '1', B1: '=#REF!' });
    expect(doc.rows).toBe(SHEET_LIMITS.initRows - 1);
  });

  it('열 삽입·삭제', () => {
    const ins = insertCols(docOf({ A1: 'a', B1: '=A1' }), 0).doc;
    expect(raws(ins)).toEqual({ B1: 'a', C1: '=B1' });
    expect(ins.cols.length).toBe(SHEET_LIMITS.initCols + 1);

    const del = deleteCols(docOf({ A1: 'a', B1: 'b', C1: '=B1' }), 1).doc;
    expect(raws(del)).toEqual({ A1: 'a', B1: '=#REF!' });
    expect(del.cols.length).toBe(SHEET_LIMITS.initCols - 1);
  });

  it('undo 로 원래 문서가 돌아온다', () => {
    const before = docOf({ A1: '1', A2: '2', B2: '=A1+A2' });
    const { doc, undo } = insertRows(before, 1);
    const back = applyStep(doc, undo).doc;
    expect(raws(back)).toEqual(raws(before));
    expect(back.rows).toBe(before.rows);
  });
});

describe('sortByCol', () => {
  it('헤더를 고정하고 값 기준으로 행 내용을 옮긴다', () => {
    const doc = docOf({
      A1: '항목', B1: '금액',
      A2: '점심', B2: '12000',
      A3: '커피', B3: '4500',
      A4: '택시', B4: '9000',
    });
    const sorted = sortByCol(doc, 1, 'asc').doc;
    expect(raws(sorted)).toEqual({
      A1: '항목', B1: '금액',
      A2: '커피', B2: '4500',
      A3: '택시', B3: '9000',
      A4: '점심', B4: '12000',
    });
  });

  it('내림차순 · 빈 칸은 뒤로', () => {
    const doc = docOf({ A1: 'h', A2: '1', A3: '', A4: '3' });
    const sorted = sortByCol(doc, 0, 'desc').doc;
    expect(sorted.cells.A2.raw).toBe('3');
    expect(sorted.cells.A3.raw).toBe('1');
  });

  it('수식은 옮겨간 행을 계속 가리킨다', () => {
    const doc = docOf({ A1: 'h', A2: '9', A3: '1', C2: '=A2*2' });
    const sorted = sortByCol(doc, 0, 'asc').doc;
    // 9 는 2행 → 3행으로 갔고, 그 행의 수식도 함께 3행으로 가면서 A3 을 가리킨다.
    expect(sorted.cells.A2.raw).toBe('1');
    expect(sorted.cells.A3.raw).toBe('9');
    expect(sorted.cells.C3.raw).toBe('=A3*2');
  });

  it('undo 로 정렬 전으로 돌아온다', () => {
    const before = docOf({ A1: 'h', A2: '9', A3: '1' });
    const { doc, undo } = sortByCol(before, 0, 'asc');
    expect(raws(applyStep(doc, undo).doc)).toEqual(raws(before));
  });
});

describe('ensureCapacity / atLimit', () => {
  it('트리거 구역 밖이면 같은 객체를 그대로 돌려준다', () => {
    const doc = docOf({ A1: 'x' });
    expect(ensureCapacity(doc)).toBe(doc);
  });

  it('마지막 10행 안에 내용이 생기면 +50행', () => {
    const doc = docOf({ A95: 'x' });
    expect(ensureCapacity(doc).rows).toBe(SHEET_LIMITS.initRows + SHEET_LIMITS.growRows);
  });

  it('마지막 2열 안에 내용이 생기면 +26열', () => {
    const doc = docOf({ Z1: 'x' });
    expect(ensureCapacity(doc).cols.length).toBe(SHEET_LIMITS.maxCols);
  });

  it('상한을 넘지 않는다', () => {
    const doc = docOf({ A995: 'x', AZ1: 'y' }, { rows: SHEET_LIMITS.maxRows, cols: Array.from({ length: SHEET_LIMITS.maxCols }, () => ({})) });
    const grown = ensureCapacity(doc);
    expect(grown.rows).toBe(SHEET_LIMITS.maxRows);
    expect(grown.cols.length).toBe(SHEET_LIMITS.maxCols);
    expect(grown).toBe(doc);
    expect(atLimit(doc)).toBe(true);
    expect(atLimit(docOf({ A1: 'x' }))).toBe(false);
  });

  it('usedBounds 는 내용이 있는 마지막 행/열', () => {
    expect(usedBounds(docOf({ A1: 'x', C5: 'y' }))).toEqual({ row: 4, col: 2 });
    expect(usedBounds(emptySheet())).toEqual({ row: -1, col: -1 });
  });
});
