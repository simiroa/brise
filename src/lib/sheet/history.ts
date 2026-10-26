// Undo/Redo — 편집 1건 = 셀 패치 1개(+ rows/cols), 스택 100단계.
// AI 편집도 패치 1개로 들어오므로 한 번에 되돌아간다(specs/features/sheet.md 상호작용 결정).

import { applyPatch, invertPatch, type SheetDoc } from './types';
import type { UndoStep } from './ops';

export const HISTORY_CAP = 100;

/**
 * 되돌리기 1단계를 적용하고, 그 반대(= 다시하기 1단계)를 함께 돌려준다.
 * `rows`/`cols`/`charts`/`frozenRows` 는 **스텝이 들고 있을 때만** 복원한다 — 그 편집이 바꾸지 않은 것은
 * 현재 문서 값을 그대로 둔다. 역스텝도 같은 칸만 채워 왕복이 대칭이 된다.
 */
export function applyStep(doc: SheetDoc, step: UndoStep): { doc: SheetDoc; inverse: UndoStep } {
  const inverse: UndoStep = { patch: invertPatch(doc, step.patch) };
  const next: SheetDoc = applyPatch(doc, step.patch);
  if (step.rows !== undefined) {
    inverse.rows = doc.rows;
    next.rows = step.rows;
  }
  if (step.cols !== undefined) {
    inverse.cols = doc.cols;
    next.cols = step.cols;
  }
  if (step.charts !== undefined) {
    inverse.charts = doc.charts;
    next.charts = step.charts;
  }
  if (step.frozenRows !== undefined) {
    inverse.frozenRows = doc.frozenRows ?? 0;
    if (step.frozenRows > 0) next.frozenRows = step.frozenRows;
    else delete next.frozenRows;
  }
  return { doc: next, inverse };
}

export class SheetHistory {
  private undoStack: UndoStep[] = [];
  private redoStack: UndoStep[] = [];

  /** 새 편집 — `step` 은 그 편집을 되돌리는 패치다. redo 스택은 비워진다. */
  push(step: UndoStep): void {
    this.undoStack.push(step);
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(doc: SheetDoc): SheetDoc | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    const { doc: next, inverse } = applyStep(doc, step);
    this.redoStack.push(inverse);
    return next;
  }

  redo(doc: SheetDoc): SheetDoc | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    const { doc: next, inverse } = applyStep(doc, step);
    this.undoStack.push(inverse);
    return next;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
