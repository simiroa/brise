import { describe, expect, it } from 'vitest';
import { evaluate, evaluateRaw, isError, literal, precedentsOf, type CellValue } from './eval';
import { ERR, parseFormula } from './parser';

function ctxOf(cells: Record<string, CellValue>) {
  return { get: (ref: string) => cells[ref] ?? null };
}

const run = (formula: string, cells: Record<string, CellValue> = {}) =>
  evaluate(parseFormula(formula), ctxOf(cells));

describe('eval', () => {
  it('산술과 참조', () => {
    expect(run('=1+2*3')).toBe(7);
    expect(run('=A1+B1', { A1: 2, B1: 3 })).toBe(5);
    expect(run('=-A1', { A1: 4 })).toBe(-4);
    expect(run('=2^10')).toBe(1024);
    expect(run('=50%')).toBe(0.5);
  });

  it('빈 셀은 산술에서 0, 연결에서 ""', () => {
    expect(run('=A1+1')).toBe(1);
    expect(run('="x"&A1')).toBe('x');
    expect(run('=A1&"y"&B1', { B1: 2 })).toBe('y2');
  });

  it('숫자처럼 생긴 문자열은 산술에서 숫자가 된다', () => {
    expect(run('=A1*2', { A1: '21' })).toBe(42);
    expect(run('=A1*2', { A1: 'abc' })).toEqual({ error: ERR.VALUE });
  });

  it('0 으로 나누면 #DIV/0!', () => {
    expect(run('=1/0')).toEqual({ error: ERR.DIV0 });
    expect(run('=A1/B1', { A1: 5 })).toEqual({ error: ERR.DIV0 });
  });

  it('formulajs 함수 — SUM/AVERAGE/COUNT/ROUND/IF/DATE', () => {
    const cells = { A1: 1, A2: 2, A3: 3, B1: 'x' as CellValue };
    expect(run('=SUM(A1:A3)', cells)).toBe(6);
    expect(run('=AVERAGE(A1:A3)', cells)).toBe(2);
    expect(run('=COUNT(A1:B1)', cells)).toBe(1);
    expect(run('=ROUND(1.2345,2)')).toBe(1.23);
    expect(run('=IF(A1>0,"yes","no")', cells)).toBe('yes');
    expect(run('=IF(A1>5,"yes","no")', cells)).toBe('no');
    expect(run('=SUM(A1:A3)*2+1', cells)).toBe(13);
    const d = run('=DATE(2026,8,19)');
    expect(d).toBeInstanceOf(Date);
  });

  it('알 수 없는 함수는 #NAME?', () => {
    expect(run('=NOSUCHFN(1)')).toEqual({ error: ERR.NAME });
  });

  it('에러는 전파된다', () => {
    expect(run('=A1+1', { A1: { error: ERR.REF } })).toEqual({ error: ERR.REF });
    expect(run('=SUM(A1:A2)+1', { A1: { error: ERR.DIV0 } })).toEqual({ error: ERR.DIV0 });
    expect(isError(run('=1/0+5'))).toBe(true);
  });

  it('IFERROR 는 에러 인자를 직접 본다', () => {
    expect(run('=IFERROR(A1,"fallback")', { A1: { error: ERR.DIV0 } })).toBe('fallback');
  });

  it('비교 연산', () => {
    expect(run('=1<2')).toBe(true);
    expect(run('="a"="A"')).toBe(true);
    expect(run('=A1=0')).toBe(true); // 빈 셀 = 0
    expect(run('=A1=""')).toBe(true); // 빈 셀 = ""
  });

  it('literal / evaluateRaw', () => {
    expect(literal('')).toBeNull();
    expect(literal('12.5')).toBe(12.5);
    expect(literal('TRUE')).toBe(true);
    expect(literal('커피')).toBe('커피');
    expect(evaluateRaw('=1+1', ctxOf({}))).toBe(2);
    expect(evaluateRaw('3', ctxOf({}))).toBe(3);
  });

  it('precedentsOf 는 범위를 펼친다', () => {
    expect([...precedentsOf(parseFormula('=SUM(A1:A3)+B1'))]).toEqual(['A1', 'A2', 'A3', 'B1']);
  });
});
