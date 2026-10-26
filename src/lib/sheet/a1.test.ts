import { describe, expect, it } from 'vitest';
import { colToLetters, expandRange, formatRef, lettersToCol, normalizeRef, parseRange, parseRef, refKey } from './a1';

describe('a1', () => {
  it('열 인덱스와 글자를 왕복한다 (A..AZ)', () => {
    expect(colToLetters(0)).toBe('A');
    expect(colToLetters(25)).toBe('Z');
    expect(colToLetters(26)).toBe('AA');
    expect(colToLetters(51)).toBe('AZ');
    for (let i = 0; i < 52; i++) expect(lettersToCol(colToLetters(i))).toBe(i);
    expect(lettersToCol('a')).toBe(0);
    expect(lettersToCol('AAA')).toBe(-1);
  });

  it('$ 절대참조 플래그를 파싱하고 다시 쓴다', () => {
    expect(parseRef('A1')).toEqual({ col: 0, row: 0, absCol: false, absRow: false });
    expect(parseRef('$B$9')).toEqual({ col: 1, row: 8, absCol: true, absRow: true });
    expect(parseRef('b$9')).toEqual({ col: 1, row: 8, absCol: false, absRow: true });
    expect(formatRef({ col: 1, row: 8, absCol: true, absRow: false })).toBe('$B9');
    expect(normalizeRef('$b$9')).toBe('B9');
  });

  it('잘못된 표기는 null', () => {
    for (const bad of ['', 'A', '1', 'A0', 'AAA1', 'A1B', 'A 1', '$1', 'A$']) {
      expect(parseRef(bad), bad).toBeNull();
    }
  });

  it('범위를 파싱·정규화·전개한다', () => {
    expect(parseRange('B9:A1')).toEqual({
      start: { col: 0, row: 0, absCol: false, absRow: false },
      end: { col: 1, row: 8, absCol: false, absRow: false },
    });
    expect(expandRange(parseRange('A1:B2')!)).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(parseRange('A1')).toBeNull();
    expect(parseRange('A1:ZZZ9')).toBeNull();
  });

  it('refKey 는 $ 없는 정규 표기', () => {
    expect(refKey(26, 9)).toBe('AA10');
  });
});
