// 증분 재계산 엔진 — 의존성 그래프 + 위상 순서 (specs/features/sheet.md 수식 엔진).
//
// 편집 1회의 비용은 "바뀐 셀의 후행 의존 셀 수"에 비례한다. 전체 재계산은 load() 때만.
// 26k 셀에서 셀 하나를 고칠 때 26k 번 다시 계산하지 않는 것이 이 파일의 존재 이유다.

import { ERR, parseFormula } from './parser';
import { evaluateRaw, literal, precedentsOf, type CellValue } from './eval';
import type { CellPatch, SheetDoc } from './types';

export class SheetEngine {
  private raws = new Map<string, string>();
  private values = new Map<string, CellValue>();
  /** ref → 그 셀의 수식이 읽는 셀들 */
  private precedents = new Map<string, Set<string>>();
  /** ref → 그 셀을 읽는 셀들 (역방향, 증분 전파용) */
  private dependents = new Map<string, Set<string>>();

  constructor(doc?: SheetDoc) {
    if (doc) this.load(doc);
  }

  /**
   * 문서 전체를 다시 싣는다 — 그래프를 새로 만들고 전체 위상 재계산.
   * ponytail: 휘발성 함수(NOW/TODAY/RAND)는 여기서만 다시 계산된다. 시계처럼 살아 움직이게
   * 하려면 타이머로 volatile 셀만 dirty 로 밀어넣는 경로를 추가하면 된다.
   */
  load(doc: SheetDoc): void {
    this.raws.clear();
    this.values.clear();
    this.precedents.clear();
    this.dependents.clear();
    for (const [key, cell] of Object.entries(doc.cells)) {
      if (cell && typeof cell.raw === 'string') this.raws.set(key, cell.raw);
    }
    for (const key of this.raws.keys()) this.link(key);
    this.recompute(new Set(this.raws.keys()));
  }

  getValue(ref: string): CellValue {
    return this.values.get(ref) ?? null;
  }

  getRaw(ref: string): string | undefined {
    return this.raws.get(ref);
  }

  /** 현재 계산값 스냅샷(빈 셀 제외). */
  snapshot(): Map<string, CellValue> {
    return new Map(this.values);
  }

  /**
   * 셀 패치를 반영하고 **값이 실제로 바뀐 셀들**을 돌려준다(UI 는 이것만 다시 그리면 된다).
   * 재계산 대상은 바뀐 셀 + 그 후행 의존 셀들의 폐포뿐이다.
   */
  setCells(patch: CellPatch): Set<string> {
    const touched = new Set<string>();
    for (const [key, entry] of Object.entries(patch)) {
      if (entry.raw === null || entry.raw === undefined) this.raws.delete(key);
      else this.raws.set(key, entry.raw);
      this.link(key);
      touched.add(key);
    }
    return this.recompute(touched);
  }

  /** 한 셀의 precedents/dependents 를 현재 raw 기준으로 다시 건다. */
  private link(key: string): void {
    const old = this.precedents.get(key);
    if (old) {
      for (const p of old) this.dependents.get(p)?.delete(key);
      this.precedents.delete(key);
    }
    const raw = this.raws.get(key);
    if (!raw || !raw.startsWith('=')) return;
    const deps = precedentsOf(parseFormula(raw));
    if (!deps.size) return;
    this.precedents.set(key, deps);
    for (const p of deps) {
      let set = this.dependents.get(p);
      if (!set) this.dependents.set(p, (set = new Set()));
      set.add(key);
    }
  }

  /** seeds + 그 후행 의존 폐포를 위상 순서로 다시 계산. 반환 = 값이 바뀐 셀. */
  private recompute(seeds: Set<string>): Set<string> {
    const dirty = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const cur = queue.pop()!;
      const deps = this.dependents.get(cur);
      if (!deps) continue;
      for (const d of deps) {
        if (dirty.has(d)) continue;
        dirty.add(d);
        queue.push(d);
      }
    }

    // dirty 부분그래프에 대한 Kahn 위상 정렬.
    const indeg = new Map<string, number>();
    for (const key of dirty) {
      let n = 0;
      const pre = this.precedents.get(key);
      if (pre) for (const p of pre) if (dirty.has(p)) n++;
      indeg.set(key, n);
    }
    const ready = [...dirty].filter((k) => indeg.get(k) === 0);
    const order: string[] = [];
    while (ready.length) {
      const key = ready.pop()!;
      order.push(key);
      const deps = this.dependents.get(key);
      if (!deps) continue;
      for (const d of deps) {
        if (!dirty.has(d)) continue;
        const n = indeg.get(d)! - 1;
        indeg.set(d, n);
        if (n === 0) ready.push(d);
      }
    }

    const changed = new Set<string>();
    const ctx = { get: (ref: string) => this.values.get(ref) ?? null };
    const commit = (key: string, next: CellValue) => {
      const had = this.values.has(key);
      const before = this.values.get(key);
      if (next === null || next === undefined) {
        if (had) {
          this.values.delete(key);
          changed.add(key);
        }
        return;
      }
      if (!had || !sameValue(before, next)) changed.add(key);
      this.values.set(key, next);
    };

    const settled = new Set<string>();
    for (const key of order) {
      const raw = this.raws.get(key);
      commit(key, raw === undefined ? null : evaluateRaw(raw, ctx));
      settled.add(key);
    }
    // 위상 정렬이 소진하지 못한 나머지 = 순환에 속했거나 순환의 하류.
    // ponytail: Excel 처럼 "순환 참여 셀만" 표시하지 않고 하류까지 #CYCLE! 로 둔다 —
    // 어차피 에러 전파로 같은 값이 되고, 참여 셀만 골라내려면 SCC 계산이 필요하다.
    for (const key of dirty) {
      if (settled.has(key)) continue;
      commit(key, { error: ERR.CYCLE });
    }
    return changed;
  }
}

function sameValue(a: CellValue | undefined, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** 수식이 아닌 raw 의 표시값 — 엔진 없이 한 칸만 읽어야 할 때(프리뷰 등). */
export { literal };
