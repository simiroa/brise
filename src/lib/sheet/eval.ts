// AST 평가기 — 함수 집합은 @formulajs/formulajs (MIT, specs/features/sheet.md 결정 표).
// 셀 값 조회는 주입받는다(ctx.get) — 엔진이 캐시·의존성 그래프를 갖고 있고 여기는 순수 계산만.

import * as formulajs from '@formulajs/formulajs';
import { expandRange, refKey } from './a1';
import { ERR, parseFormula, type Node } from './parser';
import { literal, numericString } from './literal';

// 리터럴 읽기는 literal.ts 로 옮겼다(수식 엔진 없이 쓰는 곳이 있어서) — 기존 import 경로는 그대로 둔다.
export { literal };

export type CellError = { error: string };
export type CellValue = number | string | boolean | null | Date | CellError;

export function isError(v: unknown): v is CellError {
  return typeof v === 'object' && v !== null && typeof (v as CellError).error === 'string';
}

export interface EvalCtx {
  /** 정규 A1 키("B2")의 현재 값. 빈 셀은 null. */
  get(key: string): CellValue;
}

const FN = formulajs as unknown as Record<string, (...args: unknown[]) => unknown>;

/**
 * formulajs 는 에러를 자기 모듈의 Error 싱글턴으로 주고받는다 — IFERROR 는 **그 싱글턴**만
 * 알아본다(동일 메시지의 새 Error 는 못 잡는다). 우리 `{error}` 표현을 메시지로 매핑해 넘긴다.
 */
const FJS_ERRORS: Record<string, Error> = Object.fromEntries(
  Object.values(
    (formulajs as unknown as { utils: { errors: Record<string, Error> } }).utils.errors,
  ).map((e) => [e.message, e]),
);

function toFormulajs(v: CellValue | CellValue[][]): unknown {
  if (Array.isArray(v)) return v.map((row) => row.map((c) => toFormulajs(c)));
  if (isError(v)) return FJS_ERRORS[v.error] ?? new Error(v.error);
  return v;
}

/** 산술 문맥의 숫자 강제. 빈 셀 = 0. 실패 → #VALUE! */
export function toNumber(v: CellValue): number | CellError {
  if (isError(v)) return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  const n = numericString(v);
  if (n === null) return v.trim() === '' ? 0 : { error: ERR.VALUE };
  return n;
}

/** 연결(&) 문맥의 문자열 강제. 빈 셀 = "" */
export function toText(v: CellValue): string | CellError {
  if (isError(v)) return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** 비교 시 타입 순위 — Excel: 숫자 < 문자열 < 논리값. */
function rank(v: CellValue): number {
  if (typeof v === 'number' || v instanceof Date) return 0;
  if (typeof v === 'string') return 1;
  return 2;
}

function compare(a: CellValue, b: CellValue): number {
  // ponytail: 빈 셀은 상대 타입에 맞춰 0/"" 로 본다 — Excel 의 `A1=0` 과 `A1=""` 가 둘 다 참인 동작.
  if (a === null) a = typeof b === 'string' ? '' : 0;
  if (b === null) b = typeof a === 'string' ? '' : 0;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = typeof a === 'boolean' ? (a ? 1 : 0) : (a as number);
  const y = typeof b === 'boolean' ? (b ? 1 : 0) : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** formulajs 는 에러를 Error 인스턴스(message = "#VALUE!")로 돌려준다. */
function fromFormulajs(v: unknown): CellValue {
  if (v instanceof Error) return { error: v.message || ERR.VALUE };
  if (v === undefined) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return { error: ERR.NUM };
  if (Array.isArray(v)) {
    // 배열 반환 함수(TRANSPOSE 등)는 P1 에서 스칼라만 지원 — 첫 칸만 쓴다.
    // ponytail: 스필(spill) 은 P2 그리드가 생긴 뒤에나 의미가 있다.
    const flat = v.flat();
    return flat.length ? fromFormulajs(flat[0]) : null;
  }
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) return { error: ERR.VALUE };
  return v as CellValue;
}

/** 평가 결과가 범위면 2D 배열, 아니면 스칼라. */
type Evaluated = CellValue | CellValue[][];

function isMatrix(v: Evaluated): v is CellValue[][] {
  return Array.isArray(v);
}

/** 스칼라 문맥으로 눌러 담기 — 범위를 산술에 쓰면 #VALUE!. */
function scalar(v: Evaluated): CellValue {
  return isMatrix(v) ? { error: ERR.VALUE } : v;
}

function evalNode(node: Node, ctx: EvalCtx): Evaluated {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'str':
      return node.v;
    case 'bool':
      return node.v;
    case 'blank':
      return null;
    case 'err':
      return { error: node.v };
    case 'ref':
      return ctx.get(refKey(node.ref.col, node.ref.row));
    case 'range': {
      const rows: CellValue[][] = [];
      for (let r = node.start.row; r <= node.end.row; r++) {
        const row: CellValue[] = [];
        for (let c = node.start.col; c <= node.end.col; c++) row.push(ctx.get(refKey(c, r)));
        rows.push(row);
      }
      return rows;
    }
    case 'un': {
      const a = toNumber(scalar(evalNode(node.a, ctx)));
      if (isError(a)) return a;
      return node.op === '-' ? -a : a;
    }
    case 'pct': {
      const a = toNumber(scalar(evalNode(node.a, ctx)));
      return isError(a) ? a : a / 100;
    }
    case 'bin':
      return evalBin(node.op, scalar(evalNode(node.a, ctx)), scalar(evalNode(node.b, ctx)));
    case 'fn':
      return evalFn(node, ctx);
  }
}

function evalBin(op: string, a: CellValue, b: CellValue): CellValue {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === '&') {
    const x = toText(a);
    const y = toText(b);
    if (isError(x)) return x;
    if (isError(y)) return y;
    return x + y;
  }
  if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const c = compare(a, b);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      default: return c >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? { error: ERR.DIV0 } : x / y;
    case '^': {
      const r = Math.pow(x, y);
      return Number.isFinite(r) ? r : { error: ERR.NUM };
    }
    default: return { error: ERR.VALUE };
  }
}

function evalFn(node: { name: string; args: Node[] }, ctx: EvalCtx): CellValue {
  const fn = FN[node.name];
  if (typeof fn !== 'function') return { error: ERR.NAME };
  // 에러는 formulajs 의 에러 표현으로 바꿔 넘긴다 — 대부분의 함수가 그대로 전파하고
  // IFERROR/ISERROR 는 잡아낸다. 우리만 아는 에러(#CYCLE!)는 새 Error 로 넘어가 전파만 된다.
  const args = node.args.map((a) => toFormulajs(evalNode(a, ctx)));
  try {
    return fromFormulajs(fn(...args));
  } catch {
    return { error: ERR.VALUE };
  }
}

/** 수식 AST 를 평가한다. 범위가 최상위로 나오면 좌상단 셀 값으로 눌러 담는다. */
export function evaluate(node: Node, ctx: EvalCtx): CellValue {
  const v = evalNode(node, ctx);
  if (isMatrix(v)) return v[0]?.[0] ?? null;
  return v;
}

/** `raw` 한 칸 → 값. `=` 로 시작하면 수식, 아니면 리터럴(숫자로 읽히면 숫자). */
export function evaluateRaw(raw: string, ctx: EvalCtx): CellValue {
  if (raw.startsWith('=')) return evaluate(parseFormula(raw), ctx);
  return literal(raw);
}


/** 수식이 참조하는 셀 키 전부(범위는 펼친다). 의존성 그래프용. */
export function precedentsOf(node: Node, out: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case 'ref':
      out.add(refKey(node.ref.col, node.ref.row));
      break;
    case 'range':
      for (const k of expandRange({ start: node.start, end: node.end })) out.add(k);
      break;
    case 'un':
    case 'pct':
      precedentsOf(node.a, out);
      break;
    case 'bin':
      precedentsOf(node.a, out);
      precedentsOf(node.b, out);
      break;
    case 'fn':
      for (const a of node.args) precedentsOf(a, out);
      break;
  }
  return out;
}
