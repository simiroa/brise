import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, SheetHistory, applyStep } from './history';
import { insertRows } from './ops';
import { applyPatch, emptySheet, invertPatch, type CellPatch, type SheetDoc } from './types';

function docOf(cells: Record<string, string>): SheetDoc {
  return { ...emptySheet(), cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])) };
}
const raws = (doc: SheetDoc) => Object.fromEntries(Object.entries(doc.cells).map(([k, c]) => [k, c.raw]));

/** 편집 1건을 적용하고 history 에 되돌리기 단계를 넣는다 — P2 그리드가 할 일의 축약. */
function edit(h: SheetHistory, doc: SheetDoc, patch: CellPatch): SheetDoc {
  h.push({ patch: invertPatch(doc, patch), rows: doc.rows, cols: doc.cols });
  return applyPatch(doc, patch);
}

describe('SheetHistory', () => {
  it('undo/redo 가 셀 편집을 왕복한다', () => {
    const h = new SheetHistory();
    const d0 = docOf({ A1: '1' });
    const d1 = edit(h, d0, { A1: { raw: '2' }, B1: { raw: 'new' } });
    expect(raws(d1)).toEqual({ A1: '2', B1: 'new' });

    const back = h.undo(d1)!;
    expect(raws(back)).toEqual(raws(d0));
    const fwd = h.redo(back)!;
    expect(raws(fwd)).toEqual(raws(d1));
  });

  it('rows/cols 도 함께 되돌아간다 (구조 편집)', () => {
    const h = new SheetHistory();
    const d0 = docOf({ A1: '1', A2: '2' });
    const { doc: d1, undo } = insertRows(d0, 0);
    h.push(undo);
    expect(d1.rows).toBe(d0.rows + 1);
    const back = h.undo(d1)!;
    expect(back.rows).toBe(d0.rows);
    expect(raws(back)).toEqual(raws(d0));
  });

  // 스텝은 자기가 바꾼 것만 든다 — 셀 스텝이 rows/cols/charts 를 복원하면, 그 사이에 바뀐
  // 열 서식·차트가 셀 undo 에 딸려 되감긴다(라이브 QA 2026-08-19).
  it('스텝이 들지 않은 rows/cols/charts 는 건드리지 않는다', () => {
    const doc: SheetDoc = {
      ...docOf({ A1: '1' }),
      rows: 120,
      cols: [{ fmt: 'currency', dp: 2 }],
      charts: [{ id: 'c1', type: 'bar', series: ['A1:A2'] }],
    };
    const { doc: back, inverse } = applyStep(doc, { patch: { A1: { raw: '9' } } });
    expect(back.rows).toBe(120);
    expect(back.cols).toEqual(doc.cols);
    expect(back.charts).toEqual(doc.charts);
    expect(inverse.rows).toBeUndefined();
    expect(inverse.cols).toBeUndefined();
    expect(inverse.charts).toBeUndefined();
  });

  it('charts 만 든 스텝은 charts 만 되돌린다 (차트 추가/삭제)', () => {
    const h = new SheetHistory();
    const d0: SheetDoc = { ...docOf({ A1: '1' }), charts: [] };
    const added: SheetDoc = { ...d0, charts: [{ id: 'c1', type: 'bar', series: ['A1:A1'] }] };
    h.push({ patch: {}, charts: d0.charts });

    const back = h.undo(added)!;
    expect(back.charts).toEqual([]);
    expect(raws(back)).toEqual(raws(d0));
    expect(back.rows).toBe(d0.rows);

    const fwd = h.redo(back)!;
    expect(fwd.charts).toEqual(added.charts);
  });

  it('새 편집은 redo 스택을 비운다', () => {
    const h = new SheetHistory();
    let doc = docOf({ A1: '1' });
    doc = edit(h, doc, { A1: { raw: '2' } });
    doc = h.undo(doc)!;
    expect(h.canRedo).toBe(true);
    doc = edit(h, doc, { A1: { raw: '3' } });
    expect(h.canRedo).toBe(false);
  });

  it('스택은 100단계로 잘린다', () => {
    const h = new SheetHistory();
    let doc = docOf({ A1: '0' });
    for (let i = 1; i <= HISTORY_CAP + 20; i++) doc = edit(h, doc, { A1: { raw: String(i) } });
    let steps = 0;
    while (h.canUndo) {
      doc = h.undo(doc)!;
      steps++;
    }
    expect(steps).toBe(HISTORY_CAP);
    // 가장 오래된 20건은 버려졌으므로 0 이 아니라 20 으로 돌아간다.
    expect(doc.cells.A1.raw).toBe('20');
  });

  it('빈 스택은 null', () => {
    const h = new SheetHistory();
    expect(h.undo(emptySheet())).toBeNull();
    expect(h.redo(emptySheet())).toBeNull();
  });
});

describe('applyStep — frozenRows', () => {
  it('첫 행 고정 스텝을 되돌리면 필드가 아예 없어지고, 다시하기로 돌아온다', () => {
    const d0: SheetDoc = { ...emptySheet(), frozenRows: 1 };
    const { doc: d1, inverse } = applyStep(d0, { patch: {}, frozenRows: 0 });
    expect('frozenRows' in d1).toBe(false);
    expect(inverse).toEqual({ patch: {}, frozenRows: 1 });
    const { doc: d2 } = applyStep(d1, inverse);
    expect(d2.frozenRows).toBe(1);
  });
  it('frozenRows 가 없는 스텝은 현재 값을 건드리지 않는다', () => {
    const d0: SheetDoc = { ...emptySheet(), frozenRows: 1 };
    expect(applyStep(d0, { patch: {} }).doc.frozenRows).toBe(1);
  });
});
