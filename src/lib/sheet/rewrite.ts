// 수식 참조 자동 rewrite — 행/열 삽입·삭제(shiftFormula)와 채우기·복붙(relocateFormula).
// AST 기반이라 문자열 치환이 문자열 리터럴 안의 "A1" 을 건드리는 사고가 없다.
//
// `$` 의 의미가 두 경로에서 다르다 — Excel 과 같다:
//  - **구조 편집**(insert/delete): `$A$5` 도 함께 움직인다. 위에 행이 하나 끼면 그 셀은 물리적으로
//    6행이 된 것이고, 안 움직이면 수식이 조용히 다른 셀을 가리킨다. `$` 는 출력에 그대로 보존된다.
//  - **복사/채우기**(relocate): `$` 가 붙은 축은 움직이지 않는다. 이게 `$` 본래의 용도다.

import type { CellRef } from './a1';
import { ERR, parseFormula, serializeNode, type Node } from './parser';

export type Axis = 'row' | 'col';

export interface ShiftOp {
  axis: Axis;
  /** 0-based 위치. delta>0 = 이 위치에 delta 개 삽입, delta<0 = 이 위치부터 |delta| 개 삭제. */
  at: number;
  delta: number;
}

const REF_ERR = Symbol('#REF!');
type Coord = number | typeof REF_ERR;

/** 단일 좌표의 구조 편집 결과. 삭제 범위 안이면 #REF!. */
function shiftPoint(v: number, at: number, delta: number): Coord {
  if (delta >= 0) return v >= at ? v + delta : v;
  const n = -delta;
  if (v >= at + n) return v - n;
  if (v >= at) return REF_ERR;
  return v;
}

/** 범위 끝점 쌍의 구조 편집 결과. 삭제로 범위가 통째로 사라지면 #REF!. */
function shiftSpan(start: number, end: number, at: number, delta: number): [Coord, Coord] {
  if (delta >= 0) {
    // 삽입이 범위 **안쪽**이면 start 는 그대로, end 만 밀려 범위가 자란다.
    return [start >= at ? start + delta : start, end >= at ? end + delta : end];
  }
  const n = -delta;
  const s = start >= at + n ? start - n : start >= at ? at : start;
  const e = end >= at + n ? end - n : end >= at ? at - 1 : end;
  if (e < s) return [REF_ERR, REF_ERR];
  return [s, e];
}

function mapRefs(node: Node, fn: (node: Node) => Node | null): Node {
  const mapped = fn(node);
  if (mapped) return mapped;
  switch (node.t) {
    case 'un':
      return { ...node, a: mapRefs(node.a, fn) };
    case 'pct':
      return { t: 'pct', a: mapRefs(node.a, fn) };
    case 'bin':
      return { ...node, a: mapRefs(node.a, fn), b: mapRefs(node.b, fn) };
    case 'fn':
      return { ...node, args: node.args.map((a) => mapRefs(a, fn)) };
    default:
      return node;
  }
}

function refNode(col: Coord, row: Coord, src: CellRef): Node {
  if (col === REF_ERR || row === REF_ERR) return { t: 'err', v: ERR.REF };
  return { t: 'ref', ref: { col, row, absCol: src.absCol, absRow: src.absRow } };
}

/**
 * 행/열 삽입·삭제에 맞춰 수식의 참조를 옮긴다. 앞의 `=` 는 있으면 보존.
 * 삭제된 셀/범위를 가리키던 참조는 `#REF!` 리터럴이 된다.
 */
export function shiftFormula(formula: string, op: ShiftOp): string {
  const eq = formula.startsWith('=');
  const ast = parseFormula(formula);
  const next = mapRefs(ast, (node) => {
    if (node.t === 'ref') {
      const { col, row } = node.ref;
      return op.axis === 'row'
        ? refNode(col, shiftPoint(row, op.at, op.delta), node.ref)
        : refNode(shiftPoint(col, op.at, op.delta), row, node.ref);
    }
    if (node.t === 'range') {
      if (op.axis === 'row') {
        const [s, e] = shiftSpan(node.start.row, node.end.row, op.at, op.delta);
        if (s === REF_ERR || e === REF_ERR) return { t: 'err', v: ERR.REF };
        return { ...node, start: { ...node.start, row: s }, end: { ...node.end, row: e } };
      }
      const [s, e] = shiftSpan(node.start.col, node.end.col, op.at, op.delta);
      if (s === REF_ERR || e === REF_ERR) return { t: 'err', v: ERR.REF };
      return { ...node, start: { ...node.start, col: s }, end: { ...node.end, col: e } };
    }
    return null;
  });
  return (eq ? '=' : '') + serializeNode(next);
}

/**
 * 복사/채우기 — 상대참조만 (dRow, dCol) 만큼 움직이고 `$` 가 붙은 축은 고정.
 * 시트 밖(음수)으로 나가면 `#REF!`.
 */
export function relocateFormula(formula: string, dRow: number, dCol: number): string {
  const eq = formula.startsWith('=');
  const move = (r: CellRef): CellRef | null => {
    const col = r.absCol ? r.col : r.col + dCol;
    const row = r.absRow ? r.row : r.row + dRow;
    return col < 0 || row < 0 ? null : { ...r, col, row };
  };
  const next = mapRefs(parseFormula(formula), (node) => {
    if (node.t === 'ref') {
      const moved = move(node.ref);
      return moved ? { t: 'ref', ref: moved } : { t: 'err', v: ERR.REF };
    }
    if (node.t === 'range') {
      const s = move(node.start);
      const e = move(node.end);
      return s && e ? { t: 'range', start: s, end: e } : { t: 'err', v: ERR.REF };
    }
    return null;
  });
  return (eq ? '=' : '') + serializeNode(next);
}

/**
 * 임의의 행 재배치(정렬)에 맞춰 참조를 옮긴다.
 * ponytail: 범위는 건드리지 않는다 — 정렬 후 `SUM(B2:B13)` 은 여전히 "B열 그 구간"을 뜻하는 게
 * 사용자 의도이고, 임의 치환 아래에서 범위 끝점을 옮기면 연속성이 깨져 정의 자체가 무의미해진다.
 * 단일 참조만 따라간다. 매핑에 없는 행은 그대로 둔다.
 */
export function remapRows(formula: string, rowMap: Map<number, number>): string {
  const eq = formula.startsWith('=');
  const next = mapRefs(parseFormula(formula), (node) => {
    if (node.t !== 'ref') return null;
    const to = rowMap.get(node.ref.row);
    return to === undefined ? node : { t: 'ref', ref: { ...node.ref, row: to } };
  });
  return (eq ? '=' : '') + serializeNode(next);
}
