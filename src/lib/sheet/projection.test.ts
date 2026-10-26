import { describe, expect, it } from 'vitest';
import { fromTsv, toMarkdownTable, toTsv } from './projection';
import { applyPatch, emptySheet, invertPatch, parseSheet, serializeSheet, type SheetDoc } from './types';

/**
 * **Rust 와 공유하는 픽스처.** `src-tauri/src/repo/sheet.rs` 의 tests::FIXTURE / FIXTURE_TSV 와
 * 글자 그대로 같아야 한다 — 한쪽만 고치면 다른 쪽 테스트가 깨지도록 일부러 양쪽에 리터럴로 둔다.
 */
const FIXTURE =
  '{"v":1,"rows":100,"cols":[{"w":96},{"w":96},{"w":96}],"cells":{"A1":{"raw":"항목"},"B1":{"raw":"금액"},"C1":{"raw":"메모"},"A2":{"raw":"커피"},"B2":{"raw":"4500"},"A3":{"raw":"점심"},"B3":{"raw":"12000"},"C3":{"raw":"회사 근처"},"B4":{"raw":"=SUM(B2:B3)"}},"charts":[]}';
const FIXTURE_TSV = '항목\t금액\t메모\n커피\t4500\t\n점심\t12000\t회사 근처\n\t=SUM(B2:B3)\t';
const FIXTURE_MD =
  '| 항목 | 금액 | 메모 |\n| --- | --- | --- |\n| 커피 | 4500 |  |\n| 점심 | 12000 | 회사 근처 |\n|  | =SUM(B2:B3) |  |';

const doc = () => parseSheet(FIXTURE)!;

describe('projection — Rust 와 같은 출력', () => {
  it('toTsv 가 공유 픽스처와 일치한다', () => {
    expect(toTsv(doc())).toBe(FIXTURE_TSV);
  });

  it('toMarkdownTable 이 공유 픽스처와 일치한다', () => {
    expect(toMarkdownTable(doc())).toBe(FIXTURE_MD);
  });

  it('maxRows 로 상위 N 행만', () => {
    expect(toTsv(doc(), 2)).toBe('항목\t금액\t메모\n커피\t4500\t');
  });

  it('빈 시트', () => {
    expect(toTsv(emptySheet())).toBe('');
    expect(toMarkdownTable(emptySheet())).toBe('');
  });

  it('탭·개행은 공백으로 눌러 담고 | 는 이스케이프한다', () => {
    const d: SheetDoc = { ...emptySheet(), cells: { A1: { raw: 'a|b' }, B1: { raw: 'two\nlines' } } };
    expect(toTsv(d)).toBe('a|b\ttwo lines');
    expect(toMarkdownTable(d)).toBe('| a\\|b | two lines |\n| --- | --- |');
  });
});

describe('fromTsv', () => {
  it('앵커 기준으로 셀 패치를 만든다', () => {
    expect(fromTsv('a\tb\nc\td', 'B2')).toEqual({
      B2: { raw: 'a' }, C2: { raw: 'b' },
      B3: { raw: 'c' }, C3: { raw: 'd' },
    });
  });

  it('빈 칸은 그 셀을 지운다', () => {
    expect(fromTsv('a\t\tc', 'A1')).toEqual({
      A1: { raw: 'a' }, B1: { raw: null }, C1: { raw: 'c' },
    });
  });

  it('CRLF 와 끝의 빈 줄을 무시한다', () => {
    expect(Object.keys(fromTsv('a\r\nb\r\n', 'A1'))).toEqual(['A1', 'A2']);
  });

  it('앵커가 A1 표기가 아니면 빈 패치', () => {
    expect(fromTsv('a', 'nope')).toEqual({});
  });

  it('붙여넣기 왕복 — TSV → 패치 → 문서 → TSV', () => {
    const patched = applyPatch(emptySheet(), fromTsv(FIXTURE_TSV, 'A1'));
    // 수식 텍스트도 raw 그대로 들어간다.
    expect(patched.cells.B4.raw).toBe('=SUM(B2:B3)');
    expect(toTsv(patched)).toBe(FIXTURE_TSV);
  });
});

describe('types', () => {
  it('parseSheet/serializeSheet 왕복', () => {
    const d = doc();
    expect(d.rows).toBe(100);
    expect(d.cols.length).toBe(3);
    expect(parseSheet(serializeSheet(d))).toEqual(d);
  });

  it('시트가 아닌 본문은 null', () => {
    expect(parseSheet('그냥 산문')).toBeNull();
    expect(parseSheet('[1,2]')).toBeNull();
    expect(parseSheet('{"v":1}')).toBeNull();
  });

  it('applyPatch — 설정 · 부분 갱신 · 삭제', () => {
    const d0: SheetDoc = { ...emptySheet(), cells: { A1: { raw: '1', fmt: 'currency', cur: 'KRW' } } };
    const d1 = applyPatch(d0, { A1: { raw: '2' }, B1: { raw: 'x' } });
    expect(d1.cells.A1).toEqual({ raw: '2', fmt: 'currency', cur: 'KRW' }); // fmt 유지
    expect(d1.cells.B1).toEqual({ raw: 'x' });
    expect(d0.cells.A1.raw).toBe('1'); // 원본 불변

    expect(applyPatch(d0, { A1: { raw: '2', fmt: null } }).cells.A1).toEqual({ raw: '2', cur: 'KRW' });
    expect(applyPatch(d0, { A1: { raw: null } }).cells.A1).toBeUndefined();
  });

  it('invertPatch 로 정확히 되돌아간다 (서식 포함)', () => {
    const d0: SheetDoc = { ...emptySheet(), cells: { A1: { raw: '1', fmt: 'currency', cur: 'KRW' } } };
    const patch = { A1: { raw: '2', fmt: 'number' as const }, B1: { raw: 'new' } };
    const back = applyPatch(applyPatch(d0, patch), invertPatch(d0, patch));
    expect(back.cells).toEqual(d0.cells);
  });
});
