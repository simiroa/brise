// 수식 토크나이저 + Pratt 파서 → AST (specs/features/sheet.md 수식 엔진).
// 절대 throw 하지 않는다 — 잘못된 수식은 { t: 'err' } 노드가 되어 평가 결과가 에러값이 된다.

import { parseRef, formatRef, orderRange, type CellRef } from './a1';

export const ERR = {
  DIV0: '#DIV/0!',
  VALUE: '#VALUE!',
  REF: '#REF!',
  NAME: '#NAME?',
  CYCLE: '#CYCLE!',
  NUM: '#NUM!',
  NA: '#N/A',
} as const;

const ERROR_LITERALS: string[] = Object.values(ERR);

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'blank' } // 빈 인자 `IF(A1,,0)`
  | { t: 'ref'; ref: CellRef }
  | { t: 'range'; start: CellRef; end: CellRef }
  | { t: 'un'; op: '-' | '+'; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'bin'; op: BinOp; a: Node; b: Node }
  | { t: 'fn'; name: string; args: Node[] }
  | { t: 'err'; v: string };

export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

const BIN_PRECEDENCE: Record<BinOp, number> = {
  '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};
const UNARY_PRECEDENCE = 6;

interface Token {
  k: 'num' | 'str' | 'name' | 'op' | 'err';
  v: string;
}

const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', ';', ':', '%'];

/** 토크나이저. 알 수 없는 문자는 `err` 토큰이 되어 파서가 #NAME? 로 끝낸다. */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        s += src[j++];
      }
      if (!closed) return [{ k: 'err', v: ERR.VALUE }];
      out.push({ k: 'str', v: s });
      i = j;
      continue;
    }
    if (ch === '#') {
      const lit = ERROR_LITERALS.find((e) => src.startsWith(e, i));
      if (!lit) return [{ k: 'err', v: ERR.NAME }];
      out.push({ k: 'err', v: lit });
      i += lit.length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) return [{ k: 'err', v: ERR.VALUE }];
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(src.slice(i))!;
      out.push({ k: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return [{ k: 'err', v: ERR.NAME }];
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  peek(): Token | undefined {
    return this.toks[this.i];
  }
  next(): Token | undefined {
    return this.toks[this.i++];
  }
  eat(v: string): boolean {
    const t = this.peek();
    if (t && t.k === 'op' && t.v === v) {
      this.i++;
      return true;
    }
    return false;
  }

  /** min 이상 우선순위의 이항 연산자까지 흡수하는 Pratt 루프. */
  expr(min = 0): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== 'op') break;
      const op = t.v as BinOp;
      const prec = BIN_PRECEDENCE[op];
      if (prec === undefined || prec < min) break;
      this.i++;
      // `^` 만 우결합.
      const right = this.expr(op === '^' ? prec : prec + 1);
      left = { t: 'bin', op, a: left, b: right };
    }
    return left;
  }

  unary(): Node {
    const t = this.peek();
    if (t && t.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.i++;
      return { t: 'un', op: t.v as '-' | '+', a: this.expr(UNARY_PRECEDENCE) };
    }
    return this.postfix(this.primary());
  }

  postfix(node: Node): Node {
    let out = node;
    while (this.eat('%')) out = { t: 'pct', a: out };
    return out;
  }

  primary(): Node {
    const t = this.next();
    if (!t) return { t: 'err', v: ERR.VALUE };
    if (t.k === 'err') return { t: 'err', v: t.v };
    if (t.k === 'num') return { t: 'num', v: Number(t.v) };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const inner = this.expr(0);
      if (!this.eat(')')) return { t: 'err', v: ERR.VALUE };
      return inner;
    }
    if (t.k !== 'name') return { t: 'err', v: ERR.VALUE };

    const upper = t.v.toUpperCase();
    if (this.peek()?.k === 'op' && this.peek()!.v === '(') {
      this.i++;
      return this.callArgs(upper);
    }
    if (upper === 'TRUE') return { t: 'bool', v: true };
    if (upper === 'FALSE') return { t: 'bool', v: false };
    const ref = parseRef(t.v);
    if (!ref) return { t: 'err', v: ERR.NAME };
    // 범위? 다음이 ':' 이고 그 다음도 참조여야 한다.
    if (this.peek()?.k === 'op' && this.peek()!.v === ':') {
      const after = this.toks[this.i + 1];
      const end = after && after.k === 'name' ? parseRef(after.v) : null;
      if (end) {
        this.i += 2;
        const ordered = orderRange({ start: ref, end });
        return { t: 'range', start: ordered.start, end: ordered.end };
      }
    }
    return { t: 'ref', ref };
  }

  callArgs(name: string): Node {
    const args: Node[] = [];
    if (this.eat(')')) return { t: 'fn', name, args };
    for (;;) {
      const t = this.peek();
      // 빈 인자 — `IF(A1,,0)` / 끝의 `SUM(A1,)`
      if (t && t.k === 'op' && (t.v === ',' || t.v === ';' || t.v === ')')) args.push({ t: 'blank' });
      else args.push(this.expr(0));
      if (this.eat(',') || this.eat(';')) continue;
      if (this.eat(')')) return { t: 'fn', name, args };
      return { t: 'err', v: ERR.VALUE };
    }
  }
}

/**
 * 수식 텍스트 → AST. 앞의 `=` 는 있어도 없어도 된다.
 * 파싱 실패는 예외가 아니라 `{ t:'err' }` 노드다 — 호출자는 절대 try/catch 하지 않아도 된다.
 */
export function parseFormula(text: string): Node {
  const src = text.startsWith('=') ? text.slice(1) : text;
  if (!src.trim()) return { t: 'err', v: ERR.VALUE };
  const p = new Parser(tokenize(src));
  const node = p.expr(0);
  // 남는 토큰이 있으면 문법 오류.
  if (p.peek()) return { t: 'err', v: ERR.VALUE };
  return node;
}

/**
 * 자식을 괄호로 감싸야 하는지 — 감싸지 않으면 재파싱 결과가 달라지는 경우만.
 * (`(A1+B1)*2` 를 `A1+B1*2` 로 쓰면 rewrite 가 수식을 조용히 바꿔버린다.)
 */
function needsParens(child: Node, parentPrec: number, isRight: boolean, parentOp: BinOp): boolean {
  if (child.t !== 'bin') return false;
  const p = BIN_PRECEDENCE[child.op];
  if (p < parentPrec) return true;
  if (p > parentPrec) return false;
  // 같은 우선순위: 좌결합이면 오른쪽 자식, 우결합(`^`)이면 왼쪽 자식에 괄호가 필요하다.
  return parentOp === '^' ? !isRight : isRight;
}

/** AST → 수식 텍스트. 함수명은 대문자, 인자 구분은 `,`. rewrite 결과를 다시 저장할 때 쓴다. */
export function serializeNode(node: Node): string {
  switch (node.t) {
    case 'num':
      return String(node.v);
    case 'str':
      return `"${node.v.replace(/"/g, '""')}"`;
    case 'bool':
      return node.v ? 'TRUE' : 'FALSE';
    case 'blank':
      return '';
    case 'err':
      return node.v;
    case 'ref':
      return formatRef(node.ref);
    case 'range':
      return `${formatRef(node.start)}:${formatRef(node.end)}`;
    case 'un':
      return `${node.op}${serializeNode(node.a)}`;
    case 'pct':
      return `${serializeNode(node.a)}%`;
    case 'bin': {
      const prec = BIN_PRECEDENCE[node.op];
      const a = needsParens(node.a, prec, false, node.op) ? `(${serializeNode(node.a)})` : serializeNode(node.a);
      const b = needsParens(node.b, prec, true, node.op) ? `(${serializeNode(node.b)})` : serializeNode(node.b);
      return `${a}${node.op}${b}`;
    }
    case 'fn':
      return `${node.name}(${node.args.map(serializeNode).join(',')})`;
  }
}
