// 편집 근육 기억의 순수 함수 (PLAN-2026-09-21 W2). DOM·React 없음 — SheetGrid.tsx 가 호출부.
// W1(navigation.ts)과 같은 원칙: 여기 있는 함수는 doc/문자열/좌표만 받고 부작용이 없다.

import { formatRef, parseRange, parseRef, refKey } from './a1';
import { relocateFormula } from './rewrite';
import type { CellPatch, SheetDoc } from './types';
import type { SheetRange } from './navigation';

/** 캐럿 삽입이 허용되는 "참조 앞" 문맥 — 연산자·여는 괄호·쉼표·콜론·공백. `=` 도 연산자 취급. */
const INSERTABLE_BEFORE = /[-+*/^&=<>(),:\s]$/;

/** 수식 텍스트에서 캐럿이 걸친(또는 바로 뒤에 붙은) A1 참조/범위 토큰. 없으면 null.
 * ponytail: 수식 파서(parser.ts)를 다시 쓰지 않는다 — 캐럿 히트테스트는 문자열 스캔으로 충분하고,
 * 파서까지 동원하면 위치(offset) 복원이 더 복잡해진다. */
export function refAtCaret(draft: string, caret: number): { text: string; start: number; end: number } | null {
  const re = /\$?[A-Za-z]{1,2}\$?[1-9][0-9]*(?::\$?[A-Za-z]{1,2}\$?[1-9][0-9]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(draft))) {
    const start = m.index;
    const end = start + m[0].length;
    if (caret >= start && caret <= end) return { text: m[0], start, end };
  }
  return null;
}

/**
 * 수식 편집 중 셀/범위 클릭 → 캐럿 위치에 참조 삽입. 캐럿이 참조 직후(= 그 참조의 끝)면
 * 그 참조를 통째로 교체하고, 아니면 캐럿 앞 문맥이 연산자·`(`·`,`·`:`·공백일 때만 삽입한다.
 * 조건에 안 맞으면 아무것도 바뀌지 않는다(캐럿도 그대로) — 수식 중간(식별자 안)을 잘못 끊지 않는다.
 */
export function insertRefIntoFormula(draft: string, caret: number, ref: string): { draft: string; caret: number } {
  const hit = refAtCaret(draft, caret);
  if (hit && hit.end === caret) {
    return {
      draft: draft.slice(0, hit.start) + ref + draft.slice(hit.end),
      caret: hit.start + ref.length,
    };
  }
  const before = draft.slice(0, caret);
  if (before === '' || INSERTABLE_BEFORE.test(before)) {
    return { draft: draft.slice(0, caret) + ref + draft.slice(caret), caret: caret + ref.length };
  }
  return { draft, caret };
}

function nextAbsFlags(absCol: boolean, absRow: boolean): { absCol: boolean; absRow: boolean } {
  if (!absCol && !absRow) return { absCol: true, absRow: true }; // B2 → $B$2
  if (absCol && absRow) return { absCol: false, absRow: true }; // $B$2 → B$2
  if (!absCol && absRow) return { absCol: true, absRow: false }; // B$2 → $B2
  return { absCol: false, absRow: false }; // $B2 → B2
}

/** F4 — 참조의 `$` 순환: `B2 → $B$2 → B$2 → $B2 → B2`. 범위는 양끝에 같은 상태를 함께 적용한다.
 * 형식이 아니면 원문 그대로. */
export function cycleAbsolute(ref: string): string {
  if (ref.includes(':')) {
    const range = parseRange(ref);
    if (!range) return ref;
    const next = nextAbsFlags(!!range.start.absCol, !!range.start.absRow);
    return `${formatRef({ ...range.start, ...next })}:${formatRef({ ...range.end, ...next })}`;
  }
  const parsed = parseRef(ref);
  if (!parsed) return ref;
  const next = nextAbsFlags(!!parsed.absCol, !!parsed.absRow);
  return formatRef({ ...parsed, ...next });
}

/** raw 값이 있는 칸인가 — 빈 문자열/미존재는 제외. */
function rawAt(doc: SheetDoc, col: number, row: number): string | undefined {
  return doc.cells[refKey(col, row)]?.raw;
}

/** Ctrl+D — 범위 첫 행을 나머지 행에 복제(수식은 relocateFormula 로 행만 이동). */
export function fillDownPatch(doc: SheetDoc, range: SheetRange): CellPatch {
  const patch: CellPatch = {};
  for (let c = range.c1; c <= range.c2; c++) {
    const srcRaw = rawAt(doc, c, range.r1) ?? '';
    for (let r = range.r1 + 1; r <= range.r2; r++) {
      const dRow = r - range.r1;
      patch[refKey(c, r)] = { raw: srcRaw.startsWith('=') ? relocateFormula(srcRaw, dRow, 0) : srcRaw };
    }
  }
  return patch;
}

/** Ctrl+R — 범위 첫 열을 나머지 열에 복제(수식은 relocateFormula 로 열만 이동). */
export function fillRightPatch(doc: SheetDoc, range: SheetRange): CellPatch {
  const patch: CellPatch = {};
  for (let r = range.r1; r <= range.r2; r++) {
    const srcRaw = rawAt(doc, range.c1, r) ?? '';
    for (let c = range.c1 + 1; c <= range.c2; c++) {
      const dCol = c - range.c1;
      patch[refKey(c, r)] = { raw: srcRaw.startsWith('=') ? relocateFormula(srcRaw, 0, dCol) : srcRaw };
    }
  }
  return patch;
}

/**
 * 같은 열의 자동완성 제안 — 문자열 값만(숫자·수식·자기 행 제외), 접두 일치 1개.
 * 최근 행 우선: 활성 행에서 위로 훑고, 못 찾으면 아래로(엑셀의 "위 → 아래" 탐색과 같다).
 */
export function columnSuggestion(doc: SheetDoc, col: number, row: number, prefix: string): string | null {
  if (!prefix) return null;
  const lower = prefix.toLowerCase();
  const order: number[] = [];
  for (let r = row - 1; r >= 0; r--) order.push(r);
  for (let r = row + 1; r < doc.rows; r++) order.push(r);
  for (const r of order) {
    const raw = rawAt(doc, col, r);
    if (!raw || raw.startsWith('=')) continue;
    if (raw.trim() !== '' && !isNaN(Number(raw))) continue; // 숫자 값 제외
    if (raw.length > prefix.length && raw.toLowerCase().startsWith(lower)) return raw;
  }
  return null;
}
