import { describe, expect, it } from 'vitest';
import { relocateFormula, remapRows, shiftFormula } from './rewrite';

describe('shiftFormula — 행 삽입', () => {
  it('삽입 지점 아래의 참조만 내려간다', () => {
    // 0-based at=2 → 3행 자리에 1행 삽입
    expect(shiftFormula('=A2+A5', { axis: 'row', at: 2, delta: 1 })).toBe('=A2+A6');
    expect(shiftFormula('=A1', { axis: 'row', at: 2, delta: 1 })).toBe('=A1');
  });

  it('범위 안쪽에 끼면 범위가 자란다', () => {
    expect(shiftFormula('=SUM(A1:A9)', { axis: 'row', at: 4, delta: 1 })).toBe('=SUM(A1:A10)');
    expect(shiftFormula('=SUM(A1:A9)', { axis: 'row', at: 0, delta: 1 })).toBe('=SUM(A2:A10)');
    expect(shiftFormula('=SUM(A1:A9)', { axis: 'row', at: 9, delta: 1 })).toBe('=SUM(A1:A9)');
  });

  it('$ 는 출력에 보존되고, 구조 편집에서는 함께 움직인다 (Excel 동작)', () => {
    expect(shiftFormula('=$A$5', { axis: 'row', at: 0, delta: 1 })).toBe('=$A$6');
    expect(shiftFormula('=$A$5', { axis: 'col', at: 0, delta: 1 })).toBe('=$B$5');
  });

  it('문자열 리터럴 안의 A1 은 건드리지 않는다', () => {
    expect(shiftFormula('="A5"&A5', { axis: 'row', at: 0, delta: 1 })).toBe('="A5"&A6');
  });
});

describe('shiftFormula — 행/열 삭제', () => {
  it('삭제된 셀을 가리키면 #REF!', () => {
    expect(shiftFormula('=A5', { axis: 'row', at: 4, delta: -1 })).toBe('=#REF!');
    expect(shiftFormula('=A5+A9', { axis: 'row', at: 4, delta: -1 })).toBe('=#REF!+A8');
    expect(shiftFormula('=B1', { axis: 'col', at: 1, delta: -1 })).toBe('=#REF!');
  });

  it('범위는 줄어들고, 통째로 지워지면 #REF!', () => {
    expect(shiftFormula('=SUM(A1:A9)', { axis: 'row', at: 2, delta: -2 })).toBe('=SUM(A1:A7)');
    // Excel 과 같이 범위 자리만 #REF! 가 되고 함수 껍데기는 남는다.
    expect(shiftFormula('=SUM(A3:A5)', { axis: 'row', at: 2, delta: -3 })).toBe('=SUM(#REF!)');
    expect(shiftFormula('=SUM(A3:A5)', { axis: 'row', at: 2, delta: -1 })).toBe('=SUM(A3:A4)');
  });

  it('삭제 아래쪽은 위로 당겨진다', () => {
    expect(shiftFormula('=A10', { axis: 'row', at: 0, delta: -3 })).toBe('=A7');
  });
});

describe('relocateFormula — 복사/채우기', () => {
  it('상대참조만 움직이고 $ 는 고정', () => {
    expect(relocateFormula('=A1+$B$1', 1, 0)).toBe('=A2+$B$1');
    expect(relocateFormula('=A1+B$1', 2, 1)).toBe('=B3+C$1');
    expect(relocateFormula('=SUM(A1:A3)', 1, 0)).toBe('=SUM(A2:A4)');
    expect(relocateFormula('=SUM($A$1:$A$3)', 5, 5)).toBe('=SUM($A$1:$A$3)');
  });

  it('시트 밖으로 나가면 #REF!', () => {
    expect(relocateFormula('=A1', -1, 0)).toBe('=#REF!');
    expect(relocateFormula('=SUM(A1:A3)', -1, 0)).toBe('=SUM(#REF!)');
  });

  it('앞의 = 유무를 보존한다', () => {
    expect(relocateFormula('A1', 1, 0)).toBe('A2');
  });
});

describe('remapRows — 정렬', () => {
  it('단일 참조는 옮겨간 행을 따라가고 범위는 그대로', () => {
    const map = new Map([
      [1, 3],
      [3, 1],
    ]);
    expect(remapRows('=B2*2', map)).toBe('=B4*2');
    expect(remapRows('=SUM(B2:B13)', map)).toBe('=SUM(B2:B13)');
    expect(remapRows('=B9', map)).toBe('=B9');
  });
});
