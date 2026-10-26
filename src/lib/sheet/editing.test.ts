import { describe, expect, it } from 'vitest';
import {
  columnSuggestion,
  cycleAbsolute,
  fillDownPatch,
  fillRightPatch,
  insertRefIntoFormula,
  refAtCaret,
} from './editing';
import { emptySheet, type SheetDoc } from './types';

function docWith(cells: Record<string, string>, over: Partial<SheetDoc> = {}): SheetDoc {
  return {
    ...emptySheet(),
    ...over,
    cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])),
  };
}

describe('refAtCaret', () => {
  it('캐럿이 참조 바로 뒤면 그 토큰을 찾는다', () => {
    expect(refAtCaret('=A1+B2', 3)).toEqual({ text: 'A1', start: 1, end: 3 });
  });

  it('캐럿이 범위 토큰 안이면 범위 전체를 찾는다', () => {
    expect(refAtCaret('=SUM(A1:B2)', 8)).toEqual({ text: 'A1:B2', start: 5, end: 10 });
  });

  it('참조가 없으면 null', () => {
    expect(refAtCaret('=1+1', 2)).toBeNull();
  });
});

describe('insertRefIntoFormula', () => {
  it('캐럿 앞이 연산자면 그 자리에 삽입한다', () => {
    expect(insertRefIntoFormula('=A1+', 4, 'B2')).toEqual({ draft: '=A1+B2', caret: 6 });
  });

  it('캐럿이 빈 수식(= 뒤)이면 삽입한다', () => {
    expect(insertRefIntoFormula('=', 1, 'A1')).toEqual({ draft: '=A1', caret: 3 });
  });

  it('캐럿이 참조 직후면 그 참조를 교체한다', () => {
    expect(insertRefIntoFormula('=A1+B2', 3, 'C3')).toEqual({ draft: '=C3+B2', caret: 3 });
  });

  it('캐럿 앞이 삽입 불가 문맥이면 그대로 둔다', () => {
    expect(insertRefIntoFormula('=SUM', 4, 'A1')).toEqual({ draft: '=SUM', caret: 4 });
  });
});

describe('cycleAbsolute', () => {
  it('단일 참조는 4단계로 순환한다', () => {
    expect(cycleAbsolute('B2')).toBe('$B$2');
    expect(cycleAbsolute('$B$2')).toBe('B$2');
    expect(cycleAbsolute('B$2')).toBe('$B2');
    expect(cycleAbsolute('$B2')).toBe('B2');
  });

  it('범위는 양끝에 같은 상태를 함께 적용한다', () => {
    expect(cycleAbsolute('B2:C3')).toBe('$B$2:$C$3');
  });

  it('형식이 아니면 원문 그대로', () => {
    expect(cycleAbsolute('SUM')).toBe('SUM');
  });
});

describe('fillDownPatch', () => {
  it('첫 행 값을 나머지 행에 복제한다', () => {
    const doc = docWith({ A1: '값' });
    expect(fillDownPatch(doc, { r1: 0, c1: 0, r2: 2, c2: 0 })).toEqual({
      A2: { raw: '값' },
      A3: { raw: '값' },
    });
  });

  it('수식은 relocateFormula 로 행만 이동한다', () => {
    const doc = docWith({ A1: '=B1*2' });
    expect(fillDownPatch(doc, { r1: 0, c1: 0, r2: 1, c2: 0 })).toEqual({ A2: { raw: '=B2*2' } });
  });
});

describe('fillRightPatch', () => {
  it('첫 열 값을 나머지 열에 복제한다', () => {
    const doc = docWith({ A1: '값' });
    expect(fillRightPatch(doc, { r1: 0, c1: 0, r2: 0, c2: 2 })).toEqual({
      B1: { raw: '값' },
      C1: { raw: '값' },
    });
  });

  it('수식은 relocateFormula 로 열만 이동한다', () => {
    const doc = docWith({ A1: '=A2*2' });
    expect(fillRightPatch(doc, { r1: 0, c1: 0, r2: 0, c2: 1 })).toEqual({ B1: { raw: '=B2*2' } });
  });
});

describe('columnSuggestion', () => {
  it('접두 일치하는 문자열 값을 최근 행(바로 위) 우선으로 제안한다', () => {
    const doc = docWith({ A1: '사과', A2: '사탕' });
    // 활성 행(2행, 0-based row=2)에서 위로 훑으면 바로 위(A2)가 먼저 걸린다 — "최근" = 더 가까운 행.
    expect(columnSuggestion(doc, 0, 2, '사')).toBe('사탕');
  });

  it('위에 없으면 아래를 본다', () => {
    const doc = docWith({ A3: '바나나' });
    expect(columnSuggestion(doc, 0, 0, '바')).toBe('바나나');
  });

  it('숫자·수식 값은 제외한다', () => {
    const doc = docWith({ A1: '123', A2: '=SUM(A1)' });
    expect(columnSuggestion(doc, 0, 2, '1')).toBeNull();
  });

  it('자기 행은 제외한다', () => {
    const doc = docWith({ A1: '사과' });
    expect(columnSuggestion(doc, 0, 0, '사')).toBeNull();
  });

  it('일치가 없으면 null', () => {
    const doc = docWith({ A1: '사과' });
    expect(columnSuggestion(doc, 0, 1, '포')).toBeNull();
  });
});
