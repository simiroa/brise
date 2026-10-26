import { describe, expect, it } from 'vitest';
import { SheetEngine } from './engine';
import { ERR } from './parser';
import { emptySheet, type CellPatch, type SheetDoc } from './types';

function docOf(cells: Record<string, string>): SheetDoc {
  return {
    ...emptySheet(),
    cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])),
  };
}

const patch = (cells: Record<string, string | null>): CellPatch =>
  Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }]));

describe('SheetEngine', () => {
  it('연쇄 A1→B1→C1 을 위상 순서로 계산한다', () => {
    const e = new SheetEngine(docOf({ A1: '2', B1: '=A1*3', C1: '=B1+1' }));
    expect(e.getValue('A1')).toBe(2);
    expect(e.getValue('B1')).toBe(6);
    expect(e.getValue('C1')).toBe(7);

    const changed = e.setCells(patch({ A1: '5' }));
    expect(e.getValue('B1')).toBe(15);
    expect(e.getValue('C1')).toBe(16);
    expect([...changed].sort()).toEqual(['A1', 'B1', 'C1']);
  });

  it('영향받지 않은 셀은 반환 집합에 없다', () => {
    const e = new SheetEngine(docOf({ A1: '1', B1: '=A1+1', Z9: '=100' }));
    const changed = e.setCells(patch({ A1: '2' }));
    expect([...changed].sort()).toEqual(['A1', 'B1']);
    expect(changed.has('Z9')).toBe(false);
  });

  it('값이 실제로 안 바뀌면 후행 셀은 반환되지 않는다', () => {
    const e = new SheetEngine(docOf({ A1: '1', B1: '=IF(A1>0,10,20)', C1: '=B1' }));
    const changed = e.setCells(patch({ A1: '2' }));
    expect(changed.has('A1')).toBe(true);
    expect(changed.has('B1')).toBe(false);
    expect(changed.has('C1')).toBe(false);
  });

  it('범위 안의 셀이 바뀌면 범위를 쓰는 수식이 다시 계산된다', () => {
    const e = new SheetEngine(docOf({ B2: '1', B3: '2', B4: '=SUM(B2:B3)' }));
    expect(e.getValue('B4')).toBe(3);
    e.setCells(patch({ B3: '10' }));
    expect(e.getValue('B4')).toBe(11);
    // 범위 안이지만 비어 있던 셀에 값이 새로 생겨도 반영된다.
    e.setCells(patch({ B2: '100' }));
    expect(e.getValue('B4')).toBe(110);
  });

  it('셀 삭제도 후행에 전파된다', () => {
    const e = new SheetEngine(docOf({ A1: '5', B1: '=A1+1' }));
    e.setCells(patch({ A1: null }));
    expect(e.getValue('A1')).toBeNull();
    expect(e.getValue('B1')).toBe(1);
  });

  it('순환 참조는 #CYCLE!', () => {
    const e = new SheetEngine(docOf({ A1: '=B1', B1: '=A1' }));
    expect(e.getValue('A1')).toEqual({ error: ERR.CYCLE });
    expect(e.getValue('B1')).toEqual({ error: ERR.CYCLE });

    // 편집으로 순환을 만들었다가 풀 수 있어야 한다.
    const e2 = new SheetEngine(docOf({ A1: '1', B1: '=A1+1' }));
    e2.setCells(patch({ A1: '=B1' }));
    expect(e2.getValue('A1')).toEqual({ error: ERR.CYCLE });
    e2.setCells(patch({ A1: '3' }));
    expect(e2.getValue('A1')).toBe(3);
    expect(e2.getValue('B1')).toBe(4);
  });

  it('자기 참조도 #CYCLE!', () => {
    const e = new SheetEngine(docOf({ A1: '=A1+1' }));
    expect(e.getValue('A1')).toEqual({ error: ERR.CYCLE });
  });

  it('5000칸 연쇄가 증분 갱신에서 빠르게 끝난다', () => {
    const cells: Record<string, string> = { A1: '1' };
    for (let r = 2; r <= 5000; r++) cells[`A${r}`] = `=A${r - 1}+1`;
    const t0 = Date.now();
    const e = new SheetEngine(docOf(cells));
    expect(e.getValue('A5000')).toBe(5000);
    const changed = e.setCells(patch({ A1: '2' }));
    expect(e.getValue('A5000')).toBe(5001);
    expect(changed.size).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('snapshot 은 빈 셀을 담지 않는다', () => {
    const e = new SheetEngine(docOf({ A1: '1', B1: '' }));
    const snap = e.snapshot();
    expect(snap.get('A1')).toBe(1);
    expect(snap.has('B1')).toBe(false);
  });
});
