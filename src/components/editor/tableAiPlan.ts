import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";

export type TableAiSelection = {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
};

/** 병합 셀 하나 — 0부터, 격자 좌표(TableMap 기준), 병합 셀의 왼쪽 위. */
export type TableAiMerge = { row: number; col: number; rowspan: number; colspan: number };

/** 격자의 칸 하나 — 0부터, 병합 셀이면 그 왼쪽 위. */
export type TableAiCellRef = { row: number; col: number };

export type TableAiSnapshot = {
  version: 1;
  tablePos: number;
  tableNodeSize: number;
  docFingerprint: string;
  tableFingerprint: string;
  /** 병합 표에서는 격자(높이 × 너비)이고 병합에 가려진 칸은 "" 이다. */
  rows: string[][];
  headerRow: boolean;
  selection?: TableAiSelection;
  /** allowMerged 로 뽑은 표에만 있다. 병합이 없으면 빈 배열. 단순 표·기본 호출에는 키 자체가 없다. */
  merges?: TableAiMerge[];
  /** allowMerged 로 뽑은 "단순 표가 아닌" 표(병합 · 첫 열 th 같은 양식)에만 true. 이 표는 cell-set / cell-clear 만
   *  허용한다 — 행/열 구조 변경은 rebuildTable 이 th 를 td 로 바꿔 양식을 망친다. 병합이 없는 양식도 있어서
   *  `merges` 만으로는 표현이 안 된다. */
  structureLocked?: boolean;
  /** 그림 같은 **글자가 아닌 내용**이 든 칸(allowMerged 로 뽑은 표에만, 있을 때만). 이 칸은 `rows` 에서 글자가 없어 "" 로
   *  보이지만 빈 칸이 아니다 — 채우거나 지우면 그림이 사라지므로 normalizeTableAiPlan 이 이 칸의 셀 연산을 계획에서 뺀다. */
  opaque?: TableAiCellRef[];
};

export type TableAiOperation =
  | { type: "cell-set"; row: number; col: number; value: string }
  | { type: "cell-clear"; row: number; col: number }
  | { type: "row-insert"; index: number; values?: string[] }
  | { type: "row-delete"; index: number }
  | { type: "row-move"; from: number; to: number }
  | { type: "column-insert"; index: number; values?: string[] }
  | { type: "column-delete"; index: number }
  | { type: "column-move"; from: number; to: number }
  | { type: "header-set"; enabled: boolean };

export type TableAiPlanOperation = TableAiOperation & { id: string };

export type TableAiPlan = {
  version: 1;
  baseTableFingerprint: string;
  operations: TableAiPlanOperation[];
};

export type TableAiPreviewEntry = {
  id: string;
  checked: boolean;
  kind: TableAiOperation["type"];
  /** 셀 연산에서 그 칸을 사람이 알아볼 이름 — 같은 행 왼쪽의 가장 가까운 짧은 글자 칸, 없으면 그 열의 머리글.
   *  예전의 "2행 1열 수정" 요약 문구(아무도 안 읽었다 — 모달은 operation + i18n 으로 직접 만든다)를 대체한다. */
  label?: string;
  before?: string;
  after?: string;
  operation: TableAiPlanOperation;
};

export class TableAiPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableAiPlanError";
  }
}

const MAX_OPERATIONS = 200;
const MAX_ROWS = 50;
const MAX_COLUMNS = 50;
const MAX_CELL_LENGTH = 100_000;

function fail(message: string): never {
  throw new TableAiPlanError(message);
}

function fingerprint(node: ProseMirrorNode): string {
  // Exact JSON avoids a hash collision approving a stale AI response.
  return JSON.stringify(node.toJSON());
}

function tableAncestorPos($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "table") return $pos.before(depth);
  }
  return null;
}

function assertSimpleTable(table: ProseMirrorNode): TableMap {
  const map = TableMap.get(table);
  if (!table.childCount || !map.width) fail("Table must contain at least one cell");
  table.forEach((row, _offset, rowIndex) => {
    if (row.childCount !== map.width) fail("Merged or irregular tables are not supported");
    row.forEach((cell) => {
      if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1) {
        fail("Merged cells are not supported");
      }
      const shouldBeHeader = rowIndex === 0 && table.firstChild?.firstChild?.type.name === "tableHeader";
      if ((cell.type.name === "tableHeader") !== shouldBeHeader) {
        fail("Only a complete first header row is supported");
      }
    });
  });
  return map;
}

/** 병합 표의 격자 — 칸마다 "그 자리를 차지한 셀"이 아니라 "그 자리에서 시작하는 셀"의 글자만 담고, 병합에 가려진
 *  칸은 ""다. 셀 안 블록은 줄바꿈으로 이어(목록·여러 문단이 한 덩어리로 뭉개져 AI 가 구조를 못 보는 걸 막는다).
 *  못 읽는 표(빈 표 · TableMap 이 문제를 낸 불규칙 표 · 격자에 안 잡히는 셀이 있는 표 — rowspan="0" 같은 것)는 null. */
type TableGrid = { map: TableMap; rows: string[][]; merges: TableAiMerge[]; headerRow: boolean; opaque: TableAiCellRef[] };

function gridCellText(cell: ProseMirrorNode): string {
  return cell.textBetween(0, cell.content.size, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : ""));
}

/** 글자로 읽히지 않는 내용 — 그림 같은 글자 없는 리프(hardBreak 만 글자 취급)와 칸 속 표. 이것이 든 칸은 gridCellText 가
 *  "" 거나 일부만 읽어 빈 칸처럼 보이지만, 칸 내용을 새 문단으로 갈아 끼우면 사라진다. */
function isOpaqueNode(node: ProseMirrorNode): boolean {
  return (node.isLeaf && !node.isText && node.type.name !== "hardBreak") || node.type.name === "table";
}

function hasOpaqueContent(node: ProseMirrorNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (isOpaqueNode(child)) found = true;
    return !found;
  });
  return found;
}

function readTableGrid(table: ProseMirrorNode): TableGrid | null {
  const map = TableMap.get(table);
  if (!table.childCount || !map.width || !map.height) return null;
  // problems 중 "colwidth mismatch"(열 너비가 칸마다 어긋남)는 글자 위치와 무관해 거르지 않는다 — 가져온 양식에 흔하다.
  // 나머지(collision · overlong_rowspan · missing)는 격자가 칸을 잘못 가리키는 불규칙 표다.
  if (map.problems?.some((problem) => problem.type !== "colwidth mismatch")) return null;
  const rows = Array.from({ length: map.height }, () => Array.from({ length: map.width }, () => ""));
  const merges: TableAiMerge[] = [];
  const opaque: TableAiCellRef[] = [];
  // 행 우선으로 훑으면 한 셀을 처음 만나는 자리가 곧 그 셀의 왼쪽 위다 — findCell(O(칸 수))을 셀마다 부를 일이 없다.
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const offset = map.map[row * map.width + col];
      if (seen.has(offset)) continue;
      seen.add(offset);
      const cell = table.nodeAt(offset);
      // rowspan="0" 셀은 격자에 자리를 못 얻어 map 의 빈 칸(0)이 남는데, 0 은 첫 행 노드의 오프셋이기도 해서 셀이 아닌 행을
      // 셀로 읽게 된다(problems 에도 안 잡힌다). 셀이 아니면 못 읽는 표다.
      if (!cell || (cell.type.name !== "tableCell" && cell.type.name !== "tableHeader")) return null;
      rows[row][col] = gridCellText(cell);
      if (hasOpaqueContent(cell)) opaque.push({ row, col });
      const colspan = Number(cell.attrs.colspan ?? 1);
      const rowspan = Number(cell.attrs.rowspan ?? 1);
      if (colspan > 1 || rowspan > 1) merges.push({ row, col, rowspan, colspan });
    }
  }
  let cellCount = 0;
  table.forEach((row) => { cellCount += row.childCount; });
  if (seen.size !== cellCount) return null;
  // 병합 표에선 "완전한 첫 머리글 행" 제약을 푼다(양식은 첫 열이 라벨 th 인 경우가 많다). 첫 행 전부가 th 일 때만 머리글 행.
  const firstRow = table.firstChild;
  let headerRow = !!firstRow && firstRow.childCount > 0;
  firstRow?.forEach((cell) => { if (cell.type.name !== "tableHeader") headerRow = false; });
  return { map, rows, merges, headerRow, opaque };
}

/**
 * 캐럿(또는 셀 선택)이 있는 표의 스냅샷.
 *
 * 기본(`allowMerged` 없음)은 병합·불규칙 표를 null 로 본다 — TextAssist(표 → 시트로) · applyTableMatrixPaste · textDerive 가
 * 이 모양을 전제로 한다. `allowMerged: true` 면 단순 표는 똑같이(키 하나 안 늘리고) 주고, 단순 표가 아닌 표는 격자 +
 * `merges` + `structureLocked` 로 준다(그림 같은 글자 아닌 내용이 든 칸이 있는 단순 표도 — 그 칸은 `opaque` 로 알린다).
 * 양식을 채우는 AI 표 편집(TableAiModal)만 이걸 켠다.
 */
export function extractTableAiSnapshot(editor: Editor, opts?: { allowMerged?: boolean }): TableAiSnapshot | null {
  const { doc, selection } = editor.state;
  const tablePos = tableAncestorPos(selection.$from);
  if (tablePos == null) return null;
  const table = doc.nodeAt(tablePos);
  if (!table || table.type.name !== "table") return null;
  // 병합 셀·불규칙 표(웹/워드에서 붙여넣은 표가 흔히 이렇다)는 "지원 대상 표 없음"으로 본다.
  // 이 함수는 어시스트 패널이 매 렌더(선택·업데이트마다) 부르므로, 여기서 던지면 렌더 예외가 되어
  // 에디터 패널 전체가 ErrorBoundary 로 떨어진다(2026-09-24 붙여넣기 사고). 호출자 셋 모두
  // null 을 이미 "표 없음"으로 처리한다.
  let simpleMap: TableMap | null = null;
  try {
    simpleMap = assertSimpleTable(table);
  } catch (e) {
    if (!(e instanceof TableAiPlanError)) throw e;
    if (!opts?.allowMerged) return null;
  }
  // 단순 표여도 그림 같은 글자 아닌 내용이 든 칸이 있으면 격자 경로(구조 잠금 + opaque 목록)로 보낸다 — 단순 경로의
  // textContent 는 그 칸을 "" 로 읽어, 채우거나 지우는 순간 그림이 사라진다. 기본 호출은 그대로다(allowMerged 만의 경로).
  let grid: TableGrid | null = null;
  if (!simpleMap || (opts?.allowMerged && hasOpaqueContent(table))) {
    grid = readTableGrid(table);
    if (!grid) return null;
  }
  const map = grid?.map ?? simpleMap;
  if (!map) return null;
  const rows: string[][] = grid?.rows ?? [];
  if (!grid) {
    table.forEach((row) => rows.push(Array.from({ length: row.childCount }, (_, col) => row.child(col).textContent)));
  }

  let selected: TableAiSelection | undefined;
  if (selection instanceof CellSelection) {
    const tableStart = tablePos + 1;
    const rect = map.rectBetween(selection.$anchorCell.pos - tableStart, selection.$headCell.pos - tableStart);
    selected = {
      fromRow: rect.top,
      toRow: rect.bottom - 1,
      fromCol: rect.left,
      toCol: rect.right - 1,
    };
  }

  return {
    version: 1,
    tablePos,
    tableNodeSize: table.nodeSize,
    docFingerprint: fingerprint(doc),
    tableFingerprint: fingerprint(table),
    rows,
    headerRow: grid ? grid.headerRow : table.firstChild?.firstChild?.type.name === "tableHeader",
    ...(selected ? { selection: selected } : {}),
    ...(grid ? { merges: grid.merges, structureLocked: true } : {}),
    ...(grid?.opaque.length ? { opaque: grid.opaque } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`);
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length > MAX_CELL_LENGTH) fail(`${label} is too long`);
  return value;
}

function texts(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function inRange(value: number, min: number, max: number, label: string) {
  if (value < min || value > max) fail(`${label} is out of range`);
}

function assertScope(op: TableAiOperation, selection: TableAiSelection | undefined, rows: number, cols: number) {
  if (!selection) return;
  const { fromRow, toRow, fromCol, toCol } = selection;
  switch (op.type) {
    case "cell-set":
    case "cell-clear":
      inRange(op.row, fromRow, toRow, "cell row");
      inRange(op.col, fromCol, toCol, "cell column");
      return;
    case "row-insert":
      if (fromCol !== 0 || toCol !== cols - 1) fail("Row changes require complete rows in the selection");
      inRange(op.index, fromRow, toRow + 1, "row insertion");
      return;
    case "row-delete":
      if (fromCol !== 0 || toCol !== cols - 1) fail("Row changes require complete rows in the selection");
      inRange(op.index, fromRow, toRow, "row deletion");
      return;
    case "row-move":
      if (fromCol !== 0 || toCol !== cols - 1) fail("Row changes require complete rows in the selection");
      inRange(op.from, fromRow, toRow, "source row");
      inRange(op.to, fromRow, toRow, "destination row");
      return;
    case "column-insert":
      if (fromRow !== 0 || toRow !== rows - 1) fail("Column changes require complete columns in the selection");
      inRange(op.index, fromCol, toCol + 1, "column insertion");
      return;
    case "column-delete":
      if (fromRow !== 0 || toRow !== rows - 1) fail("Column changes require complete columns in the selection");
      inRange(op.index, fromCol, toCol, "column deletion");
      return;
    case "column-move":
      if (fromRow !== 0 || toRow !== rows - 1) fail("Column changes require complete columns in the selection");
      inRange(op.from, fromCol, toCol, "source column");
      inRange(op.to, fromCol, toCol, "destination column");
      return;
    case "header-set":
      if (fromRow !== 0 || fromCol !== 0 || toCol !== cols - 1) {
        fail("Header changes require the complete first row in the selection");
      }
      return;
  }
}

type StringState = {
  rows: string[][];
  headerRow: boolean;
  /** 구조가 잠긴 표(병합 · 양식) — cell-set / cell-clear 만 허용한다. */
  locked: boolean;
  merges: readonly TableAiMerge[];
  /** 병합 셀에 가려진 칸 "row:col" — 셀 연산의 대상이 될 수 없다. */
  hidden: ReadonlySet<string>;
  /** 그림 등 글자 아닌 내용이 든 칸 "row:col" — 셀 연산이 오면 계획에서 뺀다(채우거나 지우면 그 내용이 사라진다). */
  opaque: ReadonlySet<string>;
};

function isStructureLocked(snapshot: TableAiSnapshot): boolean {
  return snapshot.structureLocked === true || (snapshot.merges?.length ?? 0) > 0;
}

function stringStateOf(snapshot: TableAiSnapshot): StringState {
  const merges = snapshot.merges ?? [];
  const hidden = new Set<string>();
  for (const m of merges) {
    for (let row = m.row; row < m.row + m.rowspan && row < snapshot.rows.length; row++) {
      for (let col = m.col; col < m.col + m.colspan; col++) {
        if (row !== m.row || col !== m.col) hidden.add(`${row}:${col}`);
      }
    }
  }
  return {
    rows: snapshot.rows.map((row) => [...row]),
    headerRow: snapshot.headerRow,
    locked: isStructureLocked(snapshot),
    merges,
    hidden,
    opaque: new Set((snapshot.opaque ?? []).map((cell) => `${cell.row}:${cell.col}`)),
  };
}

function parseOperation(value: unknown, index: number): TableAiOperation {
  const op = record(value, `operations[${index}]`);
  switch (op.type) {
    case "cell-set": return { type: op.type, row: integer(op.row, "row"), col: integer(op.col, "col"), value: text(op.value, "value") };
    case "cell-clear": return { type: op.type, row: integer(op.row, "row"), col: integer(op.col, "col") };
    case "row-insert": return { type: op.type, index: integer(op.index, "index"), ...(op.values === undefined ? {} : { values: texts(op.values, "values") }) };
    case "row-delete": return { type: op.type, index: integer(op.index, "index") };
    case "row-move": return { type: op.type, from: integer(op.from, "from"), to: integer(op.to, "to") };
    case "column-insert": return { type: op.type, index: integer(op.index, "index"), ...(op.values === undefined ? {} : { values: texts(op.values, "values") }) };
    case "column-delete": return { type: op.type, index: integer(op.index, "index") };
    case "column-move": return { type: op.type, from: integer(op.from, "from"), to: integer(op.to, "to") };
    case "header-set":
      if (typeof op.enabled !== "boolean") fail("enabled must be a boolean");
      return { type: op.type, enabled: op.enabled };
    default: return fail(`Unsupported operation: ${String(op.type)}`);
  }
}

/** 연산을 상태에 반영한다. 반환값 = 이 연산이 표를 실제로 바꾸는가 — false 면 계획에서 뺀다(validateOperations).
 *  빼는 것: 그림 등 글자 아닌 내용이 든 칸의 셀 연산(채우거나 지우면 그 내용이 사라진다), 값이 지금과 같은 cell-set · 이미
 *  빈 칸의 cell-clear(적용하면 칸 내용을 새 문단으로 갈아 끼워 목록·굵게·링크가 평문으로 납작해지는데, 미리보기는 before = after 라
 *  변화가 없어 보인다). 범위 밖·가려진 칸·구조 변경 같은 **잘못된** 연산은 빼지 않고 던진다. */
function applyStringOperation(
  state: StringState,
  op: TableAiOperation,
  touched: Set<string>,
  selection?: TableAiSelection,
  scopeRows = state.rows.length,
  scopeColumns = state.rows[0]?.length ?? 0,
): boolean {
  const rowCount = state.rows.length;
  const colCount = state.rows[0]?.length ?? 0;
  if (state.locked && op.type !== "cell-set" && op.type !== "cell-clear") {
    fail("Merged or form tables only support cell edits");
  }
  assertScope(op, selection, scopeRows, scopeColumns);
  switch (op.type) {
    case "cell-set":
    case "cell-clear": {
      inRange(op.row, 0, rowCount - 1, "row");
      inRange(op.col, 0, colCount - 1, "column");
      const key = `${op.row}:${op.col}`;
      if (state.hidden.has(key)) fail("Cell is covered by a merged cell");
      if (state.opaque.has(key)) return false;
      const next = op.type === "cell-clear" ? "" : op.value;
      if (state.rows[op.row][op.col] === next) return false;
      // 빼는 연산은 touched 에 안 넣는다 — 값이 같은 군더더기 연산 뒤에 진짜 변경이 와도 "같은 칸" 충돌이 아니다.
      if (touched.has(key)) fail("Conflicting changes target the same cell");
      touched.add(key);
      state.rows[op.row][op.col] = next;
      return true;
    }
    case "row-insert":
      inRange(op.index, 0, rowCount, "row insertion");
      if (rowCount >= MAX_ROWS) fail("Too many rows");
      if ((op.values?.length ?? 0) > colCount) fail("Inserted row has too many values");
      state.rows.splice(op.index, 0, Array.from({ length: colCount }, (_, col) => op.values?.[col] ?? ""));
      return true;
    case "row-delete":
      inRange(op.index, 0, rowCount - 1, "row deletion");
      if (rowCount === 1) fail("Cannot delete the final row");
      state.rows.splice(op.index, 1);
      return true;
    case "row-move": {
      inRange(op.from, 0, rowCount - 1, "source row");
      inRange(op.to, 0, rowCount - 1, "destination row");
      if (op.from === op.to) fail("Row move must change position");
      const [row] = state.rows.splice(op.from, 1);
      state.rows.splice(op.to, 0, row);
      return true;
    }
    case "column-insert":
      inRange(op.index, 0, colCount, "column insertion");
      if (colCount >= MAX_COLUMNS) fail("Too many columns");
      if ((op.values?.length ?? 0) > rowCount) fail("Inserted column has too many values");
      state.rows.forEach((row, index) => row.splice(op.index, 0, op.values?.[index] ?? ""));
      return true;
    case "column-delete":
      inRange(op.index, 0, colCount - 1, "column deletion");
      if (colCount === 1) fail("Cannot delete the final column");
      state.rows.forEach((row) => row.splice(op.index, 1));
      return true;
    case "column-move":
      inRange(op.from, 0, colCount - 1, "source column");
      inRange(op.to, 0, colCount - 1, "destination column");
      if (op.from === op.to) fail("Column move must change position");
      state.rows.forEach((row) => {
        const [cell] = row.splice(op.from, 1);
        row.splice(op.to, 0, cell);
      });
      return true;
    case "header-set":
      if (state.headerRow === op.enabled) fail("Header change has no effect");
      state.headerRow = op.enabled;
      return true;
  }
}

function validateOperations(raw: unknown[], snapshot: TableAiSnapshot): TableAiPlanOperation[] {
  if (raw.length > MAX_OPERATIONS) fail("Too many operations");
  const state = stringStateOf(snapshot);
  const touched = new Set<string>();
  const operations: TableAiPlanOperation[] = [];
  raw.forEach((value, index) => {
    const operation = parseOperation(value, index);
    // 표를 바꾸지 않는 연산(그림 칸 · 값이 같은 칸)은 뺀다. id 는 **남은 연산**을 세어 붙인다 — applyTableAiPlan 이 정규화를
    // 한 번 더 돌려 JSON 이 같은지 보는데, 원래 순번으로 붙이면 구멍 난 번호가 두 번째 정규화에서 당겨져 항상 달라진다.
    if (!applyStringOperation(state, operation, touched, snapshot.selection, snapshot.rows.length, snapshot.rows[0]?.length ?? 0)) return;
    operations.push({ ...operation, id: `op-${String(operations.length + 1).padStart(3, "0")}-${operation.type}` });
  });
  return operations;
}

export function normalizeTableAiPlan(input: unknown, snapshot: TableAiSnapshot): TableAiPlan {
  const value = record(input, "plan");
  if (value.version !== 1) fail("Unsupported plan version");
  if (value.baseTableFingerprint !== snapshot.tableFingerprint) fail("Plan targets a stale table");
  if (!Array.isArray(value.operations)) fail("operations must be an array");
  return {
    version: 1,
    baseTableFingerprint: snapshot.tableFingerprint,
    operations: validateOperations(value.operations, snapshot),
  };
}

function summary(op: TableAiOperation, state: StringState): Pick<TableAiPreviewEntry, "before" | "after"> {
  switch (op.type) {
    case "cell-set": return { before: state.rows[op.row]?.[op.col], after: op.value };
    case "cell-clear": return { before: state.rows[op.row]?.[op.col], after: "" };
    case "row-insert": return { after: Array.from({ length: state.rows[0].length }, (_, col) => op.values?.[col] ?? "").join(" | ") };
    case "row-delete": return { before: state.rows[op.index]?.join(" | ") };
    case "row-move": return { before: `${op.from + 1}행`, after: `${op.to + 1}행` };
    case "column-insert": return { after: (op.values ?? []).join(" | ") };
    case "column-delete": return { before: state.rows.map((row) => row[op.index]).join(" | ") };
    case "column-move": return { before: `${op.from + 1}열`, after: `${op.to + 1}열` };
    case "header-set": return { before: state.headerRow ? "머리글" : "일반 행", after: op.enabled ? "머리글" : "일반 행" };
  }
}

const LABEL_MAX = 20;

function labelText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 격자 (row, col) 를 차지한 셀의 글자 — 병합에 가려진 칸이면 그 병합 셀(왼쪽 위)의 글자. */
function coveringText(state: StringState, row: number, col: number): string {
  if (!state.hidden.has(`${row}:${col}`)) return labelText(state.rows[row]?.[col]);
  const m = state.merges.find((x) => row >= x.row && row < x.row + x.rowspan && col >= x.col && col < x.col + x.colspan);
  return m ? labelText(state.rows[m.row]?.[m.col]) : "";
}

/** 그 칸을 사람이 알아볼 이름. 같은 행 왼쪽에서 가장 가까운 "비어 있지 않고 짧은" 칸(양식의 라벨 칸 — 왼쪽에 세로로 병합된
 *  라벨이 있으면 그 글자), 없으면 그 열의 머리글 칸 글자. 어느 쪽도 없으면 undefined(모달이 "행 N · 열 M" 으로 대신한다).
 *  긴 글(= 라벨이 아니라 값일 가능성이 큰 칸)은 건너뛴다. */
function cellLabel(state: StringState, row: number, col: number): string | undefined {
  for (let c = col - 1; c >= 0; c--) {
    const text = coveringText(state, row, c);
    if (text && [...text].length <= LABEL_MAX) return text;
  }
  if (state.headerRow && row > 0) {
    const header = coveringText(state, 0, col);
    if (header) return [...header].slice(0, LABEL_MAX).join("");
  }
  return undefined;
}

export function previewTableAiPlan(snapshot: TableAiSnapshot, plan: TableAiPlan): TableAiPreviewEntry[] {
  const normalized = normalizeTableAiPlan(plan, snapshot);
  const state = stringStateOf(snapshot);
  // 라벨을 찾는 표 — 구조 연산(행/열 추가·이동)만 반영하고 셀 연산은 반영하지 않는다. 라벨이 AI 가 방금 채운 옆 칸의 값
  // ("성명 | 홍길동 | [여기]" 에서 홍길동)으로 바뀌면 사용자가 칸을 못 알아본다.
  const layout = stringStateOf(snapshot);
  const touched = new Set<string>();
  const scopeRows = snapshot.rows.length;
  const scopeCols = snapshot.rows[0]?.length ?? 0;
  return normalized.operations.map((operation) => {
    const isCellOp = operation.type === "cell-set" || operation.type === "cell-clear";
    const label = isCellOp ? cellLabel(layout, operation.row, operation.col) : undefined;
    const entry = {
      id: operation.id, checked: true, kind: operation.type,
      ...(label ? { label } : {}),
      ...summary(operation, state), operation,
    };
    applyStringOperation(state, operation, touched, snapshot.selection, scopeRows, scopeCols);
    if (!isCellOp) applyStringOperation(layout, operation, new Set(), snapshot.selection, scopeRows, scopeCols);
    return entry;
  });
}

type NodeState = { rows: ProseMirrorNode[][]; headerRow: boolean };

function cellWithText(cell: ProseMirrorNode, value: string, schema: Schema): ProseMirrorNode {
  const paragraph = schema.nodes.paragraph.create(null, value ? schema.text(value) : undefined);
  return cell.type.create(cell.attrs, paragraph);
}

function applyNodeOperation(state: NodeState, op: TableAiOperation, schema: Schema) {
  const rowCount = state.rows.length;
  const colCount = state.rows[0].length;
  switch (op.type) {
    case "cell-set": state.rows[op.row][op.col] = cellWithText(state.rows[op.row][op.col], op.value, schema); return;
    case "cell-clear": state.rows[op.row][op.col] = cellWithText(state.rows[op.row][op.col], "", schema); return;
    case "row-insert": {
      const template = state.rows[Math.min(op.index, rowCount - 1)];
      state.rows.splice(op.index, 0, template.map((cell, col) => cellWithText(cell, op.values?.[col] ?? "", schema)));
      return;
    }
    case "row-delete": state.rows.splice(op.index, 1); return;
    case "row-move": { const [row] = state.rows.splice(op.from, 1); state.rows.splice(op.to, 0, row); return; }
    case "column-insert":
      state.rows.forEach((row, index) => {
        const template = row[Math.min(op.index, colCount - 1)];
        row.splice(op.index, 0, cellWithText(template, op.values?.[index] ?? "", schema));
      });
      return;
    case "column-delete": state.rows.forEach((row) => row.splice(op.index, 1)); return;
    case "column-move": state.rows.forEach((row) => { const [cell] = row.splice(op.from, 1); row.splice(op.to, 0, cell); }); return;
    case "header-set": state.headerRow = op.enabled; return;
  }
}

function rebuildTable(table: ProseMirrorNode, state: NodeState, schema: Schema): ProseMirrorNode {
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  const rows = state.rows.map((cells, rowIndex) => rowType.create(null, cells.map((cell) => {
    const type = state.headerRow && rowIndex === 0 ? headerType : cellType;
    return type.create(cell.attrs, cell.content);
  })));
  return table.type.create(table.attrs, rows);
}

export function parseTableClipboardMatrix(text: string): string[][] | null {
  if (!text.includes("\t") && !/[\r\n]/.test(text)) return null;
  const withoutTrailingLineBreak = text.replace(/(?:\r\n|\r|\n)$/, "");
  const rows = withoutTrailingLineBreak.split(/\r\n|\r|\n/).map((row) => row.split("\t"));
  if (!rows.length || rows.some((row) => !row.length)) return null;
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, col) => row[col] ?? ""));
}

function currentTableCell(editor: Editor, snapshot: TableAiSnapshot, map: TableMap): TableAiSelection | null {
  if (snapshot.selection) return snapshot.selection;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "tableCell" && node.type.name !== "tableHeader") continue;
    const rect = map.findCell($from.before(depth) - snapshot.tablePos - 1);
    return { fromRow: rect.top, toRow: rect.top, fromCol: rect.left, toCol: rect.left };
  }
  return null;
}

/** Spreadsheet-style paste: one transaction, so one undo restores the complete table. */
export function applyTableMatrixPaste(editor: Editor, matrix: string[][]): boolean {
  if (!matrix.length || !matrix[0]?.length || matrix.some((row) => row.length !== matrix[0].length)) return false;
  if (matrix.some((row) => row.some((value) => value.length > MAX_CELL_LENGTH))) return false;
  const snapshot = extractTableAiSnapshot(editor);
  if (!snapshot) return false;
  const table = editor.state.doc.nodeAt(snapshot.tablePos);
  if (!table) return false;
  const map = assertSimpleTable(table);
  const selected = currentTableCell(editor, snapshot, map);
  if (!selected) return false;

  const selectedRows = selected.toRow - selected.fromRow + 1;
  const selectedCols = selected.toCol - selected.fromCol + 1;
  const fillSelection = matrix.length === 1 && matrix[0].length === 1 && (selectedRows > 1 || selectedCols > 1);
  if (!fillSelection && matrix.length === 1 && matrix[0].length === 1) return false;
  const pasteRows = fillSelection ? selectedRows : matrix.length;
  const pasteCols = fillSelection ? selectedCols : matrix[0].length;
  const neededRows = selected.fromRow + pasteRows;
  const neededCols = selected.fromCol + pasteCols;
  if (neededRows > MAX_ROWS || neededCols > MAX_COLUMNS) return false;

  const state: NodeState = {
    rows: Array.from({ length: table.childCount }, (_, row) => {
      const rowNode = table.child(row);
      return Array.from({ length: rowNode.childCount }, (_, col) => rowNode.child(col));
    }),
    headerRow: snapshot.headerRow,
  };
  while (state.rows.length < neededRows) applyNodeOperation(state, { type: "row-insert", index: state.rows.length }, editor.schema);
  while (state.rows[0].length < neededCols) applyNodeOperation(state, { type: "column-insert", index: state.rows[0].length }, editor.schema);
  for (let row = 0; row < pasteRows; row++) {
    for (let col = 0; col < pasteCols; col++) {
      const value = fillSelection ? matrix[0][0] : matrix[row][col];
      state.rows[selected.fromRow + row][selected.fromCol + col] = cellWithText(
        state.rows[selected.fromRow + row][selected.fromCol + col], value, editor.schema,
      );
    }
  }

  const replacement = rebuildTable(table, state, editor.schema);
  const tr = editor.state.tr.replaceWith(snapshot.tablePos, snapshot.tablePos + table.nodeSize, replacement);
  const replacementMap = TableMap.get(replacement);
  const firstCell = replacementMap.map[selected.fromRow * replacementMap.width + selected.fromCol];
  tr.setSelection(TextSelection.near(tr.doc.resolve(snapshot.tablePos + 1 + firstCell + 2), 1));
  editor.view.dispatch(tr);
  return true;
}

/** 셀 안 첫 블록의 정렬·들여쓰기(W0 의 BriseParagraph textAlign/indent)를 새 문단에 물려준다 — 가운데 정렬된 칸에 값을
 *  채웠더니 왼쪽으로 돌아가면 양식이 깨진다. 스키마에 그 속성이 없으면(기본 문단) create 가 알아서 버린다. */
function paragraphLike(first: ProseMirrorNode | null | undefined, value: string, schema: Schema): ProseMirrorNode {
  const attrs: Record<string, unknown> = {};
  for (const key of ["textAlign", "indent"]) {
    if (first && key in first.attrs) attrs[key] = first.attrs[key];
  }
  return schema.nodes.paragraph.create(attrs, inlineContent(value, schema));
}

/** 여러 줄 값은 문단을 쪼개지 않고 한 문단 안의 줄바꿈(hardBreak)으로 — 단순 표 경로(cellWithText)가 개행을 글자에 그대로 두는
 *  것과 같은 "한 칸 안 줄바꿈"이다. 다만 글자 속 개행은 `<table>` HTML 조각으로 저장될 때 `&#10;` 이 되고 재로드에서 공백으로
 *  접혀(첫 저장과 둘째 저장의 바이트가 달라진다 — 실측) hardBreak 노드(`<br>`)로 둬야 저장이 안정된다. GFM 칸은 어느 쪽이든
 *  `<br>` 로 나가 바이트가 같다. */
function inlineContent(value: string, schema: Schema): ProseMirrorNode[] {
  const hardBreak = schema.nodes.hardBreak;
  const out: ProseMirrorNode[] = [];
  (hardBreak ? value.split(/\r\n|\r|\n/) : [value]).forEach((line, index) => {
    if (index > 0) out.push(hardBreak.create());
    if (line) out.push(schema.text(line));
  });
  return out;
}

/** 구조가 잠긴 표(병합 · 양식)의 셀 연산. 표를 다시 짓지 않고 **셀 안쪽만** 바꾼다 — 셀 노드의 속성(colspan · rowspan ·
 *  colwidth · 배경 · th/td)은 손대지 않으니 구조적으로 보존된다. 보존되지 않는 것은 **셀 내용**이다: 대상 칸의 내용은 통째로 새
 *  문단 하나가 된다(목록 · 굵게 · 링크는 평문으로). 그래서 값이 같은 연산 · 그림 등 글자 아닌 내용이 든 칸의 연산은 정규화가
 *  미리 빼고(applyStringOperation), 그 판정이 의존하는 스냅샷의 opaque 목록은 applyTableAiPlan 이 실제 표와 대조한다.
 *  뒤쪽 셀부터 바꿔 앞쪽 위치가 밀리지 않게 한다(한 트랜잭션 = 한 번의 undo). */
function applyLockedCellOperations(
  editor: Editor,
  table: ProseMirrorNode,
  tablePos: number,
  operations: TableAiPlanOperation[],
): void {
  const map = TableMap.get(table);
  const targets = operations.map((op) => {
    if (op.type !== "cell-set" && op.type !== "cell-clear") fail("Merged or form tables only support cell edits");
    const offset = map.map[op.row * map.width + op.col];
    const rect = map.findCell(offset);
    // 정규화가 이미 거른 것을 실제 표로 한 번 더 — 가려진 칸의 좌표로는 엉뚱한 셀(병합 셀 본체)을 덮어쓰게 된다.
    if (rect.top !== op.row || rect.left !== op.col) fail("Cell is covered by a merged cell");
    const cell = table.nodeAt(offset);
    if (!cell) fail("Cannot apply a stale table snapshot");
    return { from: tablePos + 1 + offset, cell, value: op.type === "cell-clear" ? "" : op.value };
  }).sort((a, b) => b.from - a.from);

  const tr = editor.state.tr;
  for (const { from, cell, value } of targets) {
    tr.replaceWith(from + 1, from + cell.nodeSize - 1, paragraphLike(cell.firstChild, value, editor.schema));
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(targets[targets.length - 1].from + 1), 1));
  editor.view.dispatch(tr);
}

export function applyTableAiPlan(
  editor: Editor,
  snapshot: TableAiSnapshot,
  plan: TableAiPlan,
  selectedIds?: ReadonlySet<string>,
): boolean {
  const { doc } = editor.state;
  if (fingerprint(doc) !== snapshot.docFingerprint) fail("Cannot apply a stale table snapshot");
  const table = doc.nodeAt(snapshot.tablePos);
  if (!table || table.nodeSize !== snapshot.tableNodeSize || fingerprint(table) !== snapshot.tableFingerprint) {
    fail("Cannot apply a stale table snapshot");
  }
  const locked = isStructureLocked(snapshot);
  if (locked) {
    // 지문이 같은 표라 격자도 같아야 한다 — 다르면 스냅샷이 이 표에서 뽑힌 게 아니다.
    const grid = readTableGrid(table);
    if (
      !grid
      || JSON.stringify(grid.rows) !== JSON.stringify(snapshot.rows)
      || JSON.stringify(grid.opaque) !== JSON.stringify(snapshot.opaque ?? [])
    ) fail("Cannot apply a stale table snapshot");
  } else {
    assertSimpleTable(table);
  }
  const normalized = normalizeTableAiPlan(plan, snapshot);
  if (JSON.stringify(normalized) !== JSON.stringify(plan)) fail("Plan was not normalized");

  if (selectedIds) {
    const known = new Set(normalized.operations.map((op) => op.id));
    selectedIds.forEach((id) => { if (!known.has(id)) fail(`Unknown operation id: ${id}`); });
  }
  const chosen = selectedIds ? normalized.operations.filter((op) => selectedIds.has(op.id)) : normalized.operations;
  if (!chosen.length) return false;
  // Revalidation is intentional: unchecking a prerequisite structural edit may invalidate a
  // later coordinate. Operations are interpreted sequentially, in the displayed order.
  validateOperations(chosen, snapshot);

  if (locked) {
    applyLockedCellOperations(editor, table, snapshot.tablePos, chosen);
    return true;
  }

  const nodeState: NodeState = {
    rows: Array.from({ length: table.childCount }, (_, row) => {
      const rowNode = table.child(row);
      return Array.from({ length: rowNode.childCount }, (_, col) => rowNode.child(col));
    }),
    headerRow: snapshot.headerRow,
  };
  chosen.forEach((operation) => applyNodeOperation(nodeState, operation, editor.schema));
  const replacement = rebuildTable(table, nodeState, editor.schema);
  const tr = editor.state.tr.replaceWith(snapshot.tablePos, snapshot.tablePos + table.nodeSize, replacement);
  tr.setSelection(TextSelection.near(tr.doc.resolve(snapshot.tablePos + 3), 1));
  editor.view.dispatch(tr);
  return true;
}
