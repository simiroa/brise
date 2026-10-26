// A1 표기 ↔ 좌표 (specs/features/sheet.md). 순수 함수만 — DOM·React 없음.
//
// 열은 A..Z, AA..AZ 두 글자까지(상한 52열 = AZ). 행은 1-based 표기, 내부는 0-based.

export interface CellRef {
  col: number; // 0-based
  row: number; // 0-based
  absCol?: boolean; // "$A"
  absRow?: boolean; // "$1"
}

export interface CellRange {
  start: CellRef;
  end: CellRef;
}

const REF_RE = /^(\$?)([A-Z]{1,2})(\$?)([1-9][0-9]*)$/;

/** 0 → "A", 25 → "Z", 26 → "AA", 51 → "AZ". 음수는 빈 문자열. */
export function colToLetters(col: number): string {
  if (col < 0 || !Number.isInteger(col)) return '';
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" → 0, "AA" → 26. 대소문자 무시. 형식이 아니면 -1. */
export function lettersToCol(letters: string): number {
  if (!/^[A-Za-z]{1,2}$/.test(letters)) return -1;
  return (
    letters
      .toUpperCase()
      .split('')
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1
  );
}

/** "$A$1" / "b9" → CellRef. 형식이 아니면 null. */
export function parseRef(text: string): CellRef | null {
  const m = REF_RE.exec(text.trim().toUpperCase());
  if (!m) return null;
  const col = lettersToCol(m[2]);
  if (col < 0) return null;
  return {
    col,
    row: Number(m[4]) - 1,
    absCol: m[1] === '$',
    absRow: m[3] === '$',
  };
}

/** CellRef → "A1" / "$A$1". */
export function formatRef(ref: CellRef): string {
  return `${ref.absCol ? '$' : ''}${colToLetters(ref.col)}${ref.absRow ? '$' : ''}${ref.row + 1}`;
}

/** 셀 맵의 키 형태 — `$` 없는 정규 표기. */
export function refKey(col: number, row: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

/** "$b$2" → "B2". 형식이 아니면 null. */
export function normalizeRef(text: string): string | null {
  const ref = parseRef(text);
  return ref ? refKey(ref.col, ref.row) : null;
}

/** "A1:B9" → CellRange (start ≤ end 로 정규화). 형식이 아니면 null. */
export function parseRange(text: string): CellRange | null {
  const parts = text.split(':');
  if (parts.length !== 2) return null;
  const a = parseRef(parts[0]);
  const b = parseRef(parts[1]);
  if (!a || !b) return null;
  return orderRange({ start: a, end: b });
}

/** start 가 좌상단, end 가 우하단이 되도록. `$` 플래그는 각 끝점을 따라 함께 움직인다. */
export function orderRange(range: CellRange): CellRange {
  const { start, end } = range;
  return {
    start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row), absCol: start.absCol, absRow: start.absRow },
    end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row), absCol: end.absCol, absRow: end.absRow },
  };
}

export function formatRange(range: CellRange): string {
  return `${formatRef(range.start)}:${formatRef(range.end)}`;
}

/** 범위 → 정규 키 목록(행 우선). 의존성 그래프가 범위를 셀 단위로 펼칠 때 쓴다. */
export function expandRange(range: CellRange): string[] {
  const { start, end } = orderRange(range);
  const out: string[] = [];
  for (let r = start.row; r <= end.row; r++) {
    for (let c = start.col; c <= end.col; c++) out.push(refKey(c, r));
  }
  return out;
}
