// 시트 문서 모델 (specs/features/sheet.md §body_md JSON 스키마 v1).
// body_md 에 이 JSON 한 덩어리가 들어간다. 계산값·에러는 저장하지 않는다.

import { lettersToCol } from './a1';

export type CellFmt = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'checkbox';

/** 셀 강조 — sheet 어시스트 hl_extremes 전용(PLAN-2026-09-21 §4 W3 2차). fmt 와 같은 규칙으로
 *  patch/applyPatch/invertPatch 를 지난다. */
export type CellHl = 'ok' | 'warn' | 'info';

export interface ColSpec {
  w?: number;
  fmt?: CellFmt;
  dp?: number;
  cur?: string;
}

export interface Cell {
  /** 사용자가 친 그대로. `=` 로 시작하면 수식. */
  raw: string;
  /** 열 서식 오버라이드 */
  fmt?: CellFmt;
  dp?: number;
  cur?: string;
  /** 셀 강조(hl_extremes). */
  hl?: CellHl;
}

/**
 * 차트 종류 id — 저장 포맷·검증·AI 프롬프트가 공유하는 목록(순서 = 레지스트리 lib/sheet/chartTypes.ts 와 같다,
 * chartTypes.test.ts 가 고정). 레지스트리와 따로 두는 이유: 레지스트리는 종류마다 recharts 렌더러를 끌고 와서,
 * id 만 필요한 AI 프롬프트(stores/aiPrompts)가 그걸 import 하면 부팅 번들에 차트 라이브러리 ~1MB 가 실렸다.
 */
export const CHART_TYPE_IDS = ['bar', 'line', 'area', 'stacked', 'pie', 'donut', 'scatter', 'kpi', 'total'] as const;

export interface ChartSpec {
  id: string;
  // PLAN-2026-09-20 D7/W6: area·donut·stacked·scatter·kpi 추가(레지스트리 = lib/sheet/chartTypes.ts).
  // 저장 포맷 v 는 그대로 1(필드 추가만) — 모르는 값은 SheetChart 가 bar 로 폴백해 옛 저장분도 열린다.
  type: (typeof CHART_TYPE_IDS)[number];
  title?: string;
  /** A1 범위 */
  x?: string;
  series: string[];
}

export interface SheetDoc {
  v: 1;
  /** 현재 확보된 행 수(자동 성장 반영). */
  rows: number;
  /** 길이 = 열 수. */
  cols: ColSpec[];
  /** 희소 — 빈 셀은 키 자체가 없다. 키는 정규 A1("B2", `$` 없음). */
  cells: Record<string, Cell>;
  charts: ChartSpec[];
  /** 위에서부터 고정할 행 수(PLAN-2026-09-21 W2). 0/undefined = 고정 없음(생략). 열 고정은 없다. */
  frozenRows?: number;
}

/**
 * 편집 1건 = 셀 패치 1개. undo · AI · `sheet_set_cells` 커맨드 공용.
 * `raw: null` = 그 셀 삭제. `fmt`/`dp`/`cur` 는 생략하면 기존 값 유지, `null` 이면 그 속성만 삭제
 * (invertPatch 가 "원래 fmt 가 없던 상태"를 되돌릴 때 필요하다 — Rust repo/sheet.rs 도 동일).
 */
export type CellPatch = Record<
  string,
  { raw: string | null; fmt?: CellFmt | null; dp?: number | null; cur?: string | null; hl?: CellHl | null }
>;

export const SHEET_LIMITS = {
  initRows: 100,
  initCols: 26,
  growRows: 50,
  growCols: 26,
  maxRows: 1000,
  maxCols: 52,
} as const;

export function emptySheet(): SheetDoc {
  return {
    v: 1,
    rows: SHEET_LIMITS.initRows,
    cols: Array.from({ length: SHEET_LIMITS.initCols }, () => ({}) as ColSpec),
    cells: {},
    charts: [],
  };
}

const VALID_CELL_FMTS = new Set<CellFmt>(['text', 'number', 'currency', 'percent', 'date', 'checkbox']);
const VALID_CHART_TYPES = new Set<ChartSpec['type']>(CHART_TYPE_IDS);

/** body_md → SheetDoc. 파싱 실패/모양 불일치 → null (호출부는 ErrorBoundary + raw 보기). */
export function parseSheet(body: string): SheetDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (!d.cells || typeof d.cells !== 'object' || Array.isArray(d.cells)) return null;

  const cells: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(d.cells as Record<string, unknown>)) {
    // Validate A1 key format and ranges
    const m = /^([A-Z]{1,2})([1-9][0-9]*)$/.exec(key);
    if (!m) continue;
    const col = lettersToCol(m[1]);
    const row = Number(m[2]);
    if (col < 0 || col >= SHEET_LIMITS.maxCols || row > SHEET_LIMITS.maxRows) continue;

    if (!value || typeof value !== 'object') continue;
    const c = value as Record<string, unknown>;
    if (typeof c.raw !== 'string') continue;

    const cell: Cell = { raw: c.raw };
    if (typeof c.fmt === 'string' && VALID_CELL_FMTS.has(c.fmt as CellFmt)) {
      cell.fmt = c.fmt as CellFmt;
    }
    if (typeof c.dp === 'number' && Number.isInteger(c.dp) && c.dp >= 0) {
      cell.dp = c.dp;
    }
    if (typeof c.cur === 'string') {
      cell.cur = c.cur;
    }
    if (c.hl === 'ok' || c.hl === 'warn' || c.hl === 'info') {
      cell.hl = c.hl;
    }
    cells[key] = cell;
  }

  const rawRows = typeof d.rows === 'number' && Number.isInteger(d.rows) ? d.rows : SHEET_LIMITS.initRows;
  const clampedRows = Math.min(Math.max(rawRows, 1), SHEET_LIMITS.maxRows);

  let cols: ColSpec[];
  if (Array.isArray(d.cols)) {
    cols = d.cols.slice(0, SHEET_LIMITS.maxCols).map((col) => {
      if (!col || typeof col !== 'object') return {};
      const c = col as Record<string, unknown>;
      const spec: ColSpec = {};
      if (typeof c.w === 'number' && c.w > 0) spec.w = c.w;
      if (typeof c.fmt === 'string' && VALID_CELL_FMTS.has(c.fmt as CellFmt)) spec.fmt = c.fmt as CellFmt;
      if (typeof c.dp === 'number' && Number.isInteger(c.dp) && c.dp >= 0) spec.dp = c.dp;
      if (typeof c.cur === 'string') spec.cur = c.cur;
      return spec;
    });
  } else {
    cols = emptySheet().cols;
  }

  const charts: ChartSpec[] = [];
  if (Array.isArray(d.charts)) {
    for (const item of d.charts) {
      if (!item || typeof item !== 'object') continue;
      const ch = item as Record<string, unknown>;
      if (typeof ch.id !== 'string' || !ch.id.trim()) continue;
      if (typeof ch.type !== 'string' || !VALID_CHART_TYPES.has(ch.type as ChartSpec['type'])) continue;
      if (!Array.isArray(ch.series)) continue;
      const series = ch.series.filter((s): s is string => typeof s === 'string');
      const spec: ChartSpec = {
        id: ch.id,
        type: ch.type as ChartSpec['type'],
        series,
      };
      if (typeof ch.title === 'string') spec.title = ch.title;
      if (typeof ch.x === 'string') spec.x = ch.x;
      charts.push(spec);
    }
  }

  const doc: SheetDoc = {
    v: 1,
    rows: clampedRows,
    cols,
    cells,
    charts,
  };
  if (typeof d.frozenRows === 'number' && d.frozenRows > 0) {
    doc.frozenRows = Math.min(Math.floor(d.frozenRows), doc.rows);
  }
  return doc;
}

/** 0/undefined 은 저장에서 생략(관계도 layout 이 dagre 를 생략하는 것과 같은 규칙). */
export function serializeSheet(doc: SheetDoc): string {
  if (!doc.frozenRows) {
    const { frozenRows: _drop, ...rest } = doc;
    return JSON.stringify(rest);
  }
  return JSON.stringify(doc);
}

/** 패치를 적용한 **새** 문서. 원본은 건드리지 않는다. */
export function applyPatch(doc: SheetDoc, patch: CellPatch): SheetDoc {
  const cells = { ...doc.cells };
  for (const [key, entry] of Object.entries(patch)) {
    if (entry.raw === null || entry.raw === undefined) {
      delete cells[key];
      continue;
    }
    const next: Cell = { ...cells[key], raw: entry.raw };
    for (const attr of ['fmt', 'dp', 'cur', 'hl'] as const) {
      if (!(attr in entry)) continue;
      const v = entry[attr];
      if (v === null || v === undefined) delete next[attr];
      else (next as unknown as Record<string, unknown>)[attr] = v;
    }
    cells[key] = next;
  }
  return { ...doc, cells };
}

/** `applyPatch(doc, patch)` 를 doc 으로 되돌리는 패치 (undo 용). */
export function invertPatch(doc: SheetDoc, patch: CellPatch): CellPatch {
  const out: CellPatch = {};
  for (const key of Object.keys(patch)) {
    const before = doc.cells[key];
    // 속성을 전부 명시한다 — 부분 패치가 남긴 fmt/dp/cur 까지 원상복구해야 하므로
    // "없던 것"은 null 로 적어 삭제를 지시한다.
    out[key] = before
      ? { raw: before.raw, fmt: before.fmt ?? null, dp: before.dp ?? null, cur: before.cur ?? null, hl: before.hl ?? null }
      : { raw: null };
  }
  return out;
}
