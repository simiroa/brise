/**
 * 텍스트 작업 어시스트의 "파생" 항목(오너 제안 #6, PLAN-2026-09-21-assist-modes.md §6)이 쓰는
 * 순수 함수 둘 — React/에디터 접근 없음, body_md 문자열만 받아 문자열/행렬을 돌려준다.
 *   findMarkdownTables — 본문에 이미 굳어 있는 GFM 파이프 표를 찾는다(클립보드 TSV 표는
 *     editor/tableAiPlan.ts::parseTableClipboardMatrix, 라이브 캐럿 표는 extractTableAiSnapshot 의
 *     몫 — 이건 셋째 경로: 손으로 쓰거나 다른 곳에서 붙여넣어 이미 마크다운으로 굳은 표).
 *   listToDiagramText — 들여쓰기 목록(- / 1.)을 diagram/diagramText.ts 의 들여쓰기 트리 문법으로
 *     변환한다(한 방향, 역변환 없음 — diagramText.ts 자신과 같은 규율).
 */

/** 구분 행(`---`, 정렬 콜론 허용)의 셀 하나. */
const SEP_CELL_RE = /^:?-+:?$/;

/** 파이프로 구분된 한 행 → 셀 배열. 이스케이프(`\|`)만 처리 — 병합 셀은 GFM 표 문법에 없다. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => SEP_CELL_RE.test(cell));
}

/** 본문에서 GFM 파이프 표를 전부 찾는다 — 각 표는 헤더 행 포함 전체 행렬(구분 행은 제외). */
export function findMarkdownTables(md: string): string[][][] {
  const lines = md.split(/\r\n|\r|\n/);
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|") || !isSeparatorRow(lines[i + 1])) continue;
    const header = splitTableRow(lines[i]);
    const sep = splitTableRow(lines[i + 1]);
    if (header.length < 1 || sep.length !== header.length) continue;
    const rows: string[][] = [header];
    let j = i + 2;
    while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
      rows.push(splitTableRow(lines[j]));
      j++;
    }
    tables.push(rows);
    i = j - 1; // 이 표가 끝난 줄부터 다시 스캔(같은 표를 두 번 잡지 않는다)
  }
  return tables;
}

interface ListItem {
  text: string;
  children: ListItem[];
}

const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/;

function parseListItems(md: string): { items: ListItem[]; count: number } {
  const lines = md.split(/\r\n|\r|\n/);
  const roots: ListItem[] = [];
  const stack: { indent: number; item: ListItem }[] = [];
  let count = 0;
  for (const raw of lines) {
    const m = LIST_ITEM_RE.exec(raw);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    const indent = m[1].length;
    const node: ListItem = { text, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : roots).push(node);
    stack.push({ indent, item: node });
    count++;
  }
  return { items: roots, count };
}

// diagramText.ts 의 연결자 문법(`->`·`--`·`=>`·`<->`)과 충돌하는 기호 뭉치를 안전하게 뭉갠다 —
// 목록 항목은 자유 텍스트라 우연히 대시/화살표가 여러 개 붙어도 parseDiagramText 가 깨지면 안 된다.
// ponytail: 완전한 마크다운 인라인 이스케이프가 아니라 "파싱 실패를 막는" 최소 치환.
function sanitizeDiagramLabel(text: string): string {
  let s = text.replace(/[-=<>]{2,}/g, "-");
  s = s.replace(/^#+/, "").trim(); // 주석 줄(#...)로 오인 방지
  if (/^\[.*\]$/.test(s)) s = s.slice(1, -1).trim(); // 그룹 헤더([...]) 문법과 충돌 방지
  return s || "·";
}

function emitDiagramLines(items: ListItem[], depth: number, out: string[]): void {
  for (const item of items) {
    out.push("  ".repeat(depth) + sanitizeDiagramLabel(item.text));
    emitDiagramLines(item.children, depth + 1, out);
  }
}

/** 들여쓰기 목록(- / 1.)을 diagramText 문법(공백 2칸 = 한 단계)으로. 항목이 3개 미만이면
 *  파생 대상이 아니므로 null. */
export function listToDiagramText(md: string): string | null {
  const { items, count } = parseListItems(md);
  if (count < 3) return null;
  const lines: string[] = [];
  emitDiagramLines(items, 0, lines);
  return lines.join("\n");
}
