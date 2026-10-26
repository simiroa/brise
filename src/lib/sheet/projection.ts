// TSV / 마크다운 표 투영 — 복붙(Ctrl+C/V)·export·AI 컨텍스트 공용.
//
// **`toTsv` 의 출력은 Rust `src-tauri/src/repo/sheet.rs::sheet_to_tsv` 와 글자 그대로 같아야
// 한다** (FTS 색인·검색 스니펫은 Rust 가, 클립보드는 여기가 만든다 — 같은 문서가 두 표현으로
// 갈라지면 검색 결과와 붙여넣기 내용이 어긋난다). 양쪽 테스트가 같은 픽스처 문서와 같은 기대
// 문자열을 들고 있다: `projection.test.ts` ↔ `repo/sheet.rs` 의 FIXTURE.

import { parseRef, refKey } from './a1';
import type { CellPatch, SheetDoc } from './types';

/** 탭·개행은 격자를 깨뜨리므로 공백으로 눌러 담는다(Rust flatten 과 동일 규칙). */
function flatten(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ');
}

/** 내용이 있는 범위만큼의 2D 격자. 선언된 rows/cols 가 아니라 실제 사용 범위다. */
function grid(doc: SheetDoc, maxRows?: number): string[][] {
  const placed: Array<[number, number, string]> = [];
  let w = 0;
  let h = 0;
  for (const [key, cell] of Object.entries(doc.cells)) {
    const ref = parseRef(key);
    if (!ref || typeof cell?.raw !== 'string') continue;
    w = Math.max(w, ref.col + 1);
    h = Math.max(h, ref.row + 1);
    placed.push([ref.row, ref.col, cell.raw]);
  }
  if (maxRows !== undefined) h = Math.min(h, maxRows);
  const out = Array.from({ length: h }, () => Array.from({ length: w }, () => ''));
  for (const [r, c, raw] of placed) if (r < h) out[r][c] = flatten(raw);
  return out;
}

export function toTsv(doc: SheetDoc, maxRows?: number): string {
  return grid(doc, maxRows)
    .map((row) => row.join('\t'))
    .join('\n');
}

/** 1행 = 헤더(specs/features/sheet.md 서식 결정). 셀이 없으면 빈 문자열. */
export function toMarkdownTable(doc: SheetDoc): string {
  const g = grid(doc);
  if (!g.length) return '';
  const width = Math.max(g[0].length, 1);
  const line = (cells: string[]) =>
    `|${Array.from({ length: width }, (_, i) => ` ${(cells[i] ?? '').replace(/\|/g, '\\|')} |`).join('')}`;
  const head = line(g[0]);
  const sep = `|${' --- |'.repeat(width)}`;
  return [head, sep, ...g.slice(1).map(line)].join('\n');
}

/**
 * 엑셀/구글시트에서 복사한 TSV → 셀 패치. `anchorRef` 가 좌상단.
 * 빈 칸은 그 셀을 지운다(붙여넣기 관례). 값은 raw 문자열 그대로 — 수식 텍스트도 그대로 들어간다.
 * ponytail: 시트 내부 복사에서 수식을 상대 이동시키는 건 P2 의 채우기/복붙 경로 몫이다
 * (`rewrite.relocateFormula` 를 붙이면 된다). 외부 TSV 는 상대 이동시킬 원점 자체가 없다.
 */
export function fromTsv(text: string, anchorRef: string): CellPatch {
  const anchor = parseRef(anchorRef);
  const patch: CellPatch = {};
  if (!anchor) return patch;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, r) => {
    line.split('\t').forEach((cell, c) => {
      patch[refKey(anchor.col + c, anchor.row + r)] = { raw: cell === '' ? null : cell };
    });
  });
  return patch;
}
