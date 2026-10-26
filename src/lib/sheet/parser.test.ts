import { describe, expect, it } from 'vitest';
import { ERR, parseFormula, serializeNode } from './parser';
import { evaluate, isError } from './eval';

/** 파싱 → 재직렬화. 괄호가 필요한 곳에만 다시 붙는지까지 본다. */
const round = (src: string) => serializeNode(parseFormula(src));

describe('parser', () => {
  it('연산자 우선순위를 지킨다', () => {
    expect(round('=1+2*3')).toBe('1+2*3');
    expect(round('=(1+2)*3')).toBe('(1+2)*3');
    expect(round('=1-2-3')).toBe('1-2-3');
    expect(round('=1-(2-3)')).toBe('1-(2-3)');
    expect(round('=2^3^2')).toBe('2^3^2'); // ^ 는 우결합
    expect(round('=(2^3)^2')).toBe('(2^3)^2');
    expect(round('=A1&B1&"x"')).toBe('A1&B1&"x"');
    expect(round('=A1+B1>C1')).toBe('A1+B1>C1');
    expect(round('=A1<>B1')).toBe('A1<>B1');
    expect(round('=-A1')).toBe('-A1');
    expect(round('=5%')).toBe('5%');
  });

  it('참조·범위·$ 를 보존한다', () => {
    expect(round('=sum(a1:b9)')).toBe('SUM(A1:B9)');
    expect(round('=$A$1+b$2')).toBe('$A$1+B$2');
    expect(round('=SUM(B9:B2)')).toBe('SUM(B2:B9)'); // 정규화
  });

  it('함수 호출은 중첩·세미콜론 구분자·빈 인자를 받는다', () => {
    expect(round('=IF(A1>0;SUM(B1:B3);0)')).toBe('IF(A1>0,SUM(B1:B3),0)');
    expect(round('=IF(A1,,0)')).toBe('IF(A1,,0)');
    expect(round('=PI()')).toBe('PI()');
  });

  it('문자열 리터럴의 "" 이스케이프', () => {
    const n = parseFormula('="a""b"');
    expect(n).toEqual({ t: 'str', v: 'a"b' });
    expect(serializeNode(n)).toBe('"a""b"');
  });

  it('TRUE/FALSE 와 에러 리터럴', () => {
    expect(parseFormula('=TRUE')).toEqual({ t: 'bool', v: true });
    expect(parseFormula('=#REF!')).toEqual({ t: 'err', v: ERR.REF });
  });

  it('문법 오류는 throw 하지 않고 에러값으로 평가된다', () => {
    const ctx = { get: () => null };
    for (const bad of ['=1+', '=(1+2', '=SUM(A1', '="unterminated', '=@@', '=1 2', '=']) {
      expect(() => parseFormula(bad), bad).not.toThrow();
      expect(isError(evaluate(parseFormula(bad), ctx)), bad).toBe(true);
    }
  });

  it('참조도 함수도 아닌 이름은 #NAME?', () => {
    expect(parseFormula('=총합')).toEqual({ t: 'err', v: ERR.NAME });
  });
});
