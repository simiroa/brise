/**
 * 폰 입력 감지 칩을 눌렀을 때 문서를 바꾸는 조각 — docs/PLAN-2026-10-07-mobile-typing-nudges.md §3.
 * 감지(`lib/typingNudges.ts`)는 읽기 전용이고, 문서를 바꾸는 건 사용자가 칩을 누른 뒤뿐이다.
 * 오프셋은 감지 시점의 "문단 텍스트 기준"이라, 적용 직전에 그 자리의 글자가 아직 같은지 확인한다
 * (칩이 떠 있는 동안 사용자가 계속 쳤을 수 있다 — 다르면 아무것도 하지 않고 false).
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { findDateMarkRanges } from "../components/editor/dateMark";

/** 문단 텍스트와 문서 위치가 1:1 이 되도록 비텍스트 인라인 노드(이미지·하드브레이크)는 글자 한 칸으로 센다. */
export const LEAF_PLACEHOLDER = "￼";

export interface ParagraphSnapshot {
  /** 문단 시작의 문서 위치(= 문단 오프셋 0). */
  paraStart: number;
  paraText: string;
  /** 커서의 문단 오프셋. */
  caret: number;
  /** 이미 date 마크가 덮은 [from,to) 범위(문단 오프셋). */
  dateRanges: Array<[number, number]>;
}

/** 커서가 있는 텍스트 블록. 선택 범위가 있거나 텍스트 블록이 아니면 null. */
export function snapshotCaretParagraph(editor: Editor): ParagraphSnapshot | null {
  const sel = editor.state.selection;
  if (!sel.empty) return null;
  const { $from } = sel;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  // 코드 블록 안의 `#include`·URL·날짜는 감지 대상이 아니다 — 데스크톱 hashTag.tsx 의 spec.code 판정과 같다.
  if (parent.type.spec.code) return null;
  const paraStart = $from.start();
  const paraText = parent.textBetween(0, parent.content.size, undefined, LEAF_PLACEHOLDER);
  const dateRanges: Array<[number, number]> = [];
  parent.forEach((child, offset) => {
    if (child.isText && child.marks.some((m) => m.type.name === "date")) {
      const last = dateRanges[dateRanges.length - 1];
      if (last && last[1] === offset) last[1] = offset + child.nodeSize;
      else dateRanges.push([offset, offset + child.nodeSize]);
    }
  });
  return { paraStart, paraText, caret: $from.parentOffset, dateRanges };
}

function sameTextAt(editor: Editor, paraStart: number, paraText: string, from: number, to: number): boolean {
  const { doc } = editor.state;
  if (paraStart + to > doc.content.size) return false;
  return doc.textBetween(paraStart + from, paraStart + to, undefined, LEAF_PLACEHOLDER) === paraText.slice(from, to);
}

/** 매치 범위에 date 마크(id)를 건다. 글자가 달라졌으면 false. */
export function applyDateMark(
  editor: Editor,
  at: { paraStart: number; paraText: string; from: number; to: number },
  id: string,
): boolean {
  if (editor.isDestroyed) return false;
  const markType = editor.state.schema.marks.date;
  // IME 조합 중에는 조합 범위에 트랜잭션을 꽂지 않는다(안드로이드 Gboard 에서 글자가 겹치거나 깨진다).
  if (editor.view.composing) return false;
  if (!markType || !sameTextAt(editor, at.paraStart, at.paraText, at.from, at.to)) return false;
  const tr = editor.state.tr.addMark(at.paraStart + at.from, at.paraStart + at.to, markType.create({ id }));
  editor.view.dispatch(tr);
  return true;
}

/** 되돌리기 — 그 id 의 date 마크만 걷는다(글자는 그대로). */
export function stripDateMark(editor: Editor, id: string): void {
  if (editor.isDestroyed) return;
  const markType = editor.state.schema.marks.date;
  if (!markType) return;
  const ranges = findDateMarkRanges(editor.state.doc, id);
  if (ranges.length === 0) return;
  let tr = editor.state.tr;
  for (const r of ranges) tr = tr.removeMark(r.from, r.to, markType);
  editor.view.dispatch(tr);
}

/** `#질의` 토큰을 `#태그 ` 로 바꾸고 커서를 그 뒤에 둔다. 글자가 달라졌으면 false. */
export function replaceTagToken(
  editor: Editor,
  at: { paraStart: number; paraText: string; from: number; to: number },
  tagName: string,
): boolean {
  if (editor.isDestroyed || !tagName.trim()) return false;
  if (editor.view.composing) return false; // IME 조합 중 금지 — applyDateMark 와 같은 이유
  if (!sameTextAt(editor, at.paraStart, at.paraText, at.from, at.to)) return false;
  const insert = `#${tagName.trim()} `;
  const from = at.paraStart + at.from;
  const tr = editor.state.tr.insertText(insert, from, at.paraStart + at.to);
  tr.setSelection(TextSelection.create(tr.doc, from + insert.length));
  editor.view.dispatch(tr);
  return true;
}
