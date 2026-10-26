// 수식이 아닌 셀 값 읽기 — 수식 엔진(eval.ts, @formulajs ~350KB)과 따로 둔다. 정렬(ops.ts)·차트 데이터(chart.ts)는
// 이것만 필요한데 eval.ts 를 import 하면 AI 액션 스토어(runAiAction → ops)를 거쳐 부팅 번들에 수식 엔진이 실렸다.
import type { CellValue } from './eval';

/** 문자열이 숫자로 읽히는가 — Excel 의 "숫자처럼 생긴 문자열" 강제 변환 규칙. */
export function numericString(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 수식이 아닌 raw 의 값. 숫자·TRUE/FALSE 는 그 타입으로, 나머지는 문자열. */
export function literal(raw: string): CellValue {
  if (raw === '') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  const n = numericString(raw);
  return n === null ? raw : n;
}
