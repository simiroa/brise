// 그리드가 편집 중이 **아닐 때** 받는 키 전부(PLAN-2026-09-13 A2b 로 SheetGrid.tsx 에서 옮김).
// 분기 우선순위는 옮기기 전과 글자 단위로 같다 — 특히 Shift/Ctrl 화살표가 일반 화살표보다 먼저,
// e.code 'Semicolon' 우선 판정, isMac 판정, preventDefault 호출 위치.
// 편집 중(`editing`)일 때의 조기 반환은 호출부(SheetGrid)가 들고 있다 — 그때 키는 CellEditor 가 받는다.
//
// 순수 선택 수학은 lib/sheet/navigation.ts 에 있다(리터럴 테스트도 거기). 여기는 "어떤 키가 그
// 함수를 어떤 값으로 부르는가"만 본다.

import { refKey } from "../../lib/sheet/a1";
import { fromTsv } from "../../lib/sheet/projection";
import { usedBounds } from "../../lib/sheet/ops";
import {
  type Dir,
  extendSelection,
  extendSelectionToJump,
  jumpTarget,
  selectAllRange,
} from "../../lib/sheet/navigation";
import type { SheetDoc } from "../../lib/sheet/types";
import type { CellRange, SheetSelection } from "./useSheetState";

/** 화살표 키 → jumpTarget 방향. Ctrl/Ctrl+Shift 화살표 처리에서 공용으로 쓴다. */
const ARROW_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** 오늘/지금 — Ctrl+; / Ctrl+Shift+;. 서식은 건드리지 않는다(plain 텍스트로 들어간다).
 *  편집 중 캐럿 삽입도 같은 값을 쓰므로 SheetGrid 의 CellEditor 가 이 둘을 그대로 가져다 쓴다. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
export function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function nowHM(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** End 키 — 그 행에서 값이 있는 마지막 열(없으면 -1). */
function lastFilledColInRow(doc: SheetDoc, row: number): number {
  let col = -1;
  for (let c = 0; c < doc.cols.length; c++) {
    if (doc.cells[refKey(c, row)]?.raw) col = c;
  }
  return col;
}

/** PageUp/PageDown — 누적 오프셋에서 y 좌표가 속한 행 인덱스(마지막 유효 행으로 클램프, 이진 탐색).
 * 행 높이가 균일하지 않아 "n행 이동" 대신 "픽셀 y 만큼 이동"으로 다음 행을 찾는다. */
function rowAtY(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2; // offsets.length - 1 은 마지막 오프셋(총합), 유효 행 인덱스는 그 앞까지.
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= y) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** 키다운에서 실제로 읽는 것만. React 합성 이벤트가 구조적으로 그대로 들어맞고,
 *  테스트는 평범한 객체로 부를 수 있다. */
export interface SheetKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

/** 키맵이 그리드에 대해 알아야 하는 전부. 호출부가 **매 렌더 새로** 만든다(stale 클로저 방지). */
export interface SheetKeymapCtx {
  doc: SheetDoc;
  selection: SheetSelection;
  /** `selection.activeCell` 을 파싱한 좌표 — 호출부가 이미 메모해 두고 있어 그대로 받는다. */
  activeRef: { row: number; col: number };
  /** 그리드가 실제로 그리는 크기(문서보다 클 수 있다 — 최소 50행×26열). */
  numRows: number;
  numCols: number;
  /** 가변 행 높이 누적 오프셋(길이 numRows+1). PageUp/PageDown 이 픽셀로 행을 찾는다. */
  rowOffsets: number[];
  /** 한 화면 높이(px). 뷰포트 **실측 전이면 null** — 그때는 10행 고정 폴백(기존 계약 유지). */
  pageHeight: number | null;
  /** 선택 범위 TSV(복사/잘라내기). */
  getSelectedTsv: () => string;
  onSetSelection: (activeCell: string, range?: CellRange | null) => void;
  onStartEditing: (cell: string, initialValue?: string) => void;
  onSetCell: (a1: string, raw: string) => void;
  onClearRange: (range: CellRange) => void;
  onApplyFillHandle: (sourceRange: CellRange, targetRange: CellRange) => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function handleSheetKeyDown(e: SheetKeyEvent, ctx: SheetKeymapCtx): void {
  const {
    doc, selection, activeRef, numRows, numCols, rowOffsets, pageHeight, getSelectedTsv,
    onSetSelection, onStartEditing, onSetCell, onClearRange, onApplyFillHandle, onUndo, onRedo,
  } = ctx;

  const { row, col } = activeRef;
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

  if (cmdOrCtrl && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) onRedo();
    else onUndo();
    return;
  }
  if (cmdOrCtrl && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    onRedo();
    return;
  }

  // 전체 선택 (Ctrl+A) — 활성 셀은 그대로, 범위만 문서 전체로.
  if (cmdOrCtrl && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    onSetSelection(selection.activeCell, selectAllRange(doc));
    return;
  }

  // 아래로/오른쪽으로 채우기 (Ctrl+D / Ctrl+R, PLAN-2026-09-21 W2) — 편집 중 아님. 선택 범위 첫
  // 행/열을 나머지에 복제한다. sourceRange 를 첫 행(또는 첫 열) 한 줄로 좁혀 onApplyFillHandle 에
  // 넘기면, 그 함수의 수열 감지가 데이터 2개 미만이라 걸리지 않고 "첫 줄을 나머지로" 규칙과
  // 정확히 같아진다(lib/sheet/editing.ts 의 fillDownPatch/fillRightPatch 가 그 규칙의 순수 버전 —
  // 리터럴 테스트는 거기서, 여기는 그 순수 함수를 다시 부르지 않고 이미 있는 setCells 왕복 경로를
  // 그대로 쓴다).
  if (cmdOrCtrl && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    const range = selection.range ?? { r1: row, c1: col, r2: row, c2: col };
    if (range.r2 > range.r1) {
      onApplyFillHandle({ ...range, r2: range.r1 }, range);
    }
    return;
  }
  if (cmdOrCtrl && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    const range = selection.range ?? { r1: row, c1: col, r2: row, c2: col };
    if (range.c2 > range.c1) {
      onApplyFillHandle({ ...range, c2: range.c1 }, range);
    }
    return;
  }

  // 오늘 날짜 / 지금 시각 (Ctrl+; / Ctrl+Shift+;) — 편집 중 아님. 편집 중 삽입은 CellEditor 가 캐럿에.
  // Shift 를 누르면 세미콜론 키의 e.key 가 ":" 로 바뀌므로(표준 US 배열) e.code 를 우선 본다.
  if (cmdOrCtrl && (e.code === "Semicolon" || e.key === ";" || e.key === ":")) {
    e.preventDefault();
    onSetCell(selection.activeCell, e.shiftKey ? nowHM() : todayYMD());
    return;
  }

  // Shift/Ctrl 화살표 — 일반 화살표(아래 이동 키 블록)보다 먼저 가로챈다.
  const dir = ARROW_DIR[e.key];
  if (dir && (cmdOrCtrl || e.shiftKey)) {
    e.preventDefault();
    const selRange = selection.range ?? { r1: row, c1: col, r2: row, c2: col };
    if (cmdOrCtrl && e.shiftKey) {
      // Ctrl+Shift+화살표 — 활성 셀 고정, 반대 모서리를 jumpTarget 로 점프시켜 확장.
      onSetSelection(selection.activeCell, extendSelectionToJump(doc, selRange, activeRef, dir));
    } else if (cmdOrCtrl) {
      // Ctrl+화살표 — 활성 셀 자체가 데이터 끝으로 점프, 선택은 한 칸으로 접힌다.
      const jumped = jumpTarget(doc, { row, col }, dir);
      onSetSelection(refKey(jumped.col, jumped.row));
    } else {
      // Shift+화살표 — 활성 셀 고정, 반대 모서리 확장(기존 Shift+클릭의 min/max 계산 재사용).
      onSetSelection(selection.activeCell, extendSelection(selRange, activeRef, dir, numRows, numCols));
    }
    return;
  }

  // 복사 (Ctrl+C)
  if (cmdOrCtrl && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    const tsv = getSelectedTsv();
    void navigator.clipboard.writeText(tsv);
    return;
  }

  // 잘라내기 (Ctrl+X)
  if (cmdOrCtrl && (e.key === "x" || e.key === "X")) {
    e.preventDefault();
    const range = selection.range ?? { r1: row, c1: col, r2: row, c2: col };
    const tsv = getSelectedTsv();
    void navigator.clipboard.writeText(tsv);
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        onSetCell(refKey(c, r), "");
      }
    }
    return;
  }

  // 붙여넣기 (Ctrl+V)
  if (cmdOrCtrl && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    void navigator.clipboard.readText().then((clip) => {
      if (!clip) return;
      const patch = fromTsv(clip, refKey(col, row));
      for (const [k, v] of Object.entries(patch)) {
        if (v.raw !== null && v.raw !== undefined) {
          onSetCell(k, v.raw);
        }
      }
    });
    return;
  }

  // 이동 키
  if (e.key === "ArrowUp") {
    e.preventDefault();
    const nextR = Math.max(0, row - 1);
    onSetSelection(refKey(col, nextR));
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    const nextR = Math.min(numRows - 1, row + 1);
    onSetSelection(refKey(col, nextR));
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    const nextC = Math.max(0, col - 1);
    onSetSelection(refKey(nextC, row));
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    const nextC = Math.min(numCols - 1, col + 1);
    onSetSelection(refKey(nextC, row));
  } else if (e.key === "Tab") {
    e.preventDefault();
    const nextC = e.shiftKey ? Math.max(0, col - 1) : Math.min(numCols - 1, col + 1);
    onSetSelection(refKey(nextC, row));
  } else if (e.key === "Enter") {
    e.preventDefault();
    onStartEditing(selection.activeCell);
  } else if (e.key === "F2") {
    e.preventDefault();
    onStartEditing(selection.activeCell);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    // 툴바 "선택 영역 지우기"와 같은 경로 — 범위 전체가 undo 한 번에 돌아온다.
    onClearRange(selection.range ?? { r1: row, c1: col, r2: row, c2: col });
  } else if (e.key === "Home") {
    e.preventDefault();
    if (cmdOrCtrl) onSetSelection(refKey(0, 0));
    else onSetSelection(refKey(0, row));
  } else if (e.key === "End") {
    e.preventDefault();
    if (cmdOrCtrl) {
      const bounds = usedBounds(doc);
      onSetSelection(refKey(Math.max(bounds.col, 0), Math.max(bounds.row, 0)));
    } else {
      onSetSelection(refKey(Math.max(lastFilledColInRow(doc, row), 0), row));
    }
  } else if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    // 행 높이가 균일하지 않아 "n행" 대신 오프셋으로 "한 화면(pageHeight)만큼 픽셀 이동" 한 행을 찾는다.
    // 아직 실측 전(pageHeight == null)이면 10행 고정 폴백(ponytail: jsdom 등 폭 미측정, 기존 계약 유지).
    let nextR: number;
    if (pageHeight !== null) {
      const targetY = e.key === "PageDown" ? rowOffsets[row] + pageHeight : rowOffsets[row] - pageHeight;
      nextR = Math.min(numRows - 1, Math.max(0, rowAtY(rowOffsets, targetY)));
    } else {
      const delta = e.key === "PageDown" ? 10 : -10;
      nextR = Math.min(numRows - 1, Math.max(0, row + delta));
    }
    onSetSelection(refKey(col, nextR));
  } else if (e.key.length === 1 && !cmdOrCtrl && !e.altKey) {
    // 일반 문자 입력 시 바로 편집 시작. preventDefault 가 없으면 이 키가 **두 번** 들어간다 —
    // 여기서 초깃값으로 한 번, 그리고 다음 렌더에 뜬 오버레이 input 에 네이티브 입력으로 또 한 번
    // ("z" → "zz", "=SUM(...)" → "==SUM(...)" 으로 수식이 깨진다).
    e.preventDefault();
    onStartEditing(selection.activeCell, e.key);
  }
}
