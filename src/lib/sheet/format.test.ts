import { describe, expect, it } from 'vitest';
import { defaultCurrency, formatCell } from './format';
import { ERR } from './parser';

describe('formatCell', () => {
  it('빈 값과 에러', () => {
    expect(formatCell(null, 'number')).toBe('');
    expect(formatCell({ error: ERR.DIV0 }, 'number')).toBe(ERR.DIV0);
  });

  it('text 가 기본', () => {
    expect(formatCell('커피', undefined)).toBe('커피');
    expect(formatCell(1234.5, 'text')).toBe('1234.5');
    expect(formatCell(true, 'text')).toBe('TRUE');
  });

  it('number — 자릿수', () => {
    expect(formatCell(1234.567, 'number', { locale: 'en' })).toBe('1,234.567');
    expect(formatCell(1234.567, 'number', { dp: 1, locale: 'en' })).toBe('1,234.6');
    expect(formatCell(1234, 'number', { dp: 2, locale: 'en' })).toBe('1,234.00');
    expect(formatCell('숫자아님', 'number', { locale: 'en' })).toBe('숫자아님');
  });

  it('currency — 로케일 기본 통화', () => {
    expect(defaultCurrency('ko')).toBe('KRW');
    expect(defaultCurrency('en')).toBe('USD');
    expect(defaultCurrency('fr')).toBe('EUR');
    expect(formatCell(4500, 'currency', { locale: 'ko' })).toContain('₩');
    expect(formatCell(4500, 'currency', { locale: 'ko' })).toContain('4,500');
    expect(formatCell(1234.5, 'currency', { locale: 'en' })).toBe('$1,234.50');
    expect(formatCell(1234.5, 'currency', { locale: 'fr' })).toContain('€');
    expect(formatCell(1000, 'currency', { locale: 'en', cur: 'JPY' })).toContain('¥');
  });

  it('percent', () => {
    expect(formatCell(0.256, 'percent', { locale: 'en' })).toBe('26%');
    expect(formatCell(0.256, 'percent', { dp: 1, locale: 'en' })).toBe('25.6%');
  });

  it('date — ISO 문자열과 Date 둘 다', () => {
    expect(formatCell('2026-08-19', 'date', { locale: 'en' })).toBe('08/19/2026');
    expect(formatCell(new Date('2026-08-19T00:00:00Z'), 'date', { locale: 'en' })).toBe('08/19/2026');
    expect(formatCell('날짜아님', 'date', { locale: 'en' })).toBe('날짜아님');
  });

  it('checkbox', () => {
    expect(formatCell(true, 'checkbox')).toBe('☑');
    expect(formatCell('TRUE', 'checkbox')).toBe('☑');
    expect(formatCell('FALSE', 'checkbox')).toBe('☐');
    expect(formatCell(0, 'checkbox')).toBe('☐');
  });
});
