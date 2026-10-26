// 차트 데이터 추출 엔진 (specs/features/sheet.md §시각화).
// 시트 문서 및 계산 엔진에서 ChartSpec에 지정된 범위를 읽어 차트용 2D 레코드 배열로 가공한다.

import { expandRange, parseRange, parseRef, refKey } from "./a1";
import { literal } from "./literal";
import type { ChartSpec, SheetDoc } from "./types";
import { SheetEngine } from "./engine";

export interface ChartDataPoint {
  name: string;
  [key: string]: number | string | null;
}

export interface ExtractedChartData {
  data: ChartDataPoint[];
  seriesKeys: string[];
  total: number;
}

/** 차트 편집기의 기본값 — 선택 영역 하나에서 나온다. */
export interface ChartRangeDefaults {
  /** 없으면 x 축은 행 번호로 떨어진다(extractChartData 의 폴백). */
  x?: string;
  series: string[];
}

function colRange(col: number, r1: number, r2: number): string {
  return `${refKey(col, r1)}:${refKey(col, r2)}`;
}

/**
 * 선택 영역 → 차트 기본 범위. 행 범위는 **선택한 행 그대로**(고정 추측 금지 — 라이브 QA
 * 2026-08-19: F1:F3 을 골라도 x 가 A2:A10 이라 레이블 9개에 값 3개가 붙었다).
 * - 두 열 이상 선택 = 첫 열이 레이블, 나머지가 각각 시리즈.
 * - 한 열 선택 = 그 열이 시리즈, 레이블은 **왼쪽에서 가장 가까운 텍스트 열**.
 * - 그런 열이 없으면 x 없음(행 번호 폴백).
 * ponytail: 레이블 열 판정은 "선택 행 안에 문자열 리터럴이 하나라도 있는가" — 수식 셀의 계산값은
 * 보지 않는다(순수 함수 유지). 헤더 행만 문자인 숫자 열은 레이블로 뽑히지 않는다.
 */
export function defaultChartRanges(
  doc: SheetDoc,
  sel: { r1: number; c1: number; r2: number; c2: number },
): ChartRangeDefaults {
  const r1 = Math.min(sel.r1, sel.r2);
  const r2 = Math.max(sel.r1, sel.r2);
  const c1 = Math.min(sel.c1, sel.c2);
  const c2 = Math.max(sel.c1, sel.c2);

  if (c2 > c1) {
    const series: string[] = [];
    for (let c = c1 + 1; c <= c2; c++) series.push(colRange(c, r1, r2));
    return { x: colRange(c1, r1, r2), series };
  }

  const series = [colRange(c1, r1, r2)];
  for (let c = c1 - 1; c >= 0; c--) {
    for (let r = r1; r <= r2; r++) {
      const raw = doc.cells[refKey(c, r)]?.raw ?? "";
      // 수식은 raw 가 문자열이라도 텍스트가 아니다 — 계산값은 여기서 보지 않는다.
      if (!raw.startsWith("=") && typeof literal(raw) === "string") {
        return { x: colRange(c, r1, r2), series };
      }
    }
  }
  return { series };
}

type ColKind = "num" | "text" | "empty";

/**
 * 열 판정 — defaultChartRanges 와 같은 규칙(수식이 아닌 raw 의 `literal()` 이 문자열이면 텍스트)에
 * 수식 셀만 `engine` 계산값으로 보탠다(없으면 수식 셀은 건너뛴다).
 * ponytail: 선택의 **첫 행**만 문자면 헤더로 보고 열 종류에서 뺀다 — 사용자는 대개 헤더부터
 * 끌어 고르는데, 그 한 칸 때문에 숫자 열 전부가 텍스트가 되면 추천이 항상 비어 버린다.
 */
function colKind(doc: SheetDoc, engine: SheetEngine | undefined, c: number, r1: number, r2: number): ColKind {
  let nums = 0;
  let texts = 0;
  let headerText = false;
  for (let r = r1; r <= r2; r++) {
    const key = refKey(c, r);
    const raw = doc.cells[key]?.raw ?? "";
    if (raw === "") continue;
    let v: unknown;
    if (raw.startsWith("=")) {
      if (!engine) continue;
      v = engine.getValue(key);
      if (typeof v === "object") continue; // 에러·날짜·null
    } else {
      v = literal(raw);
    }
    if (typeof v === "number") nums++;
    else if (typeof v === "string") {
      if (r === r1) headerText = true;
      else texts++;
    }
  }
  if (texts > 0) return "text";
  if (nums > 0) return "num";
  return headerText ? "text" : "empty";
}

/**
 * 선택 범위에서 어울리는 차트 종류를 우선순위 순으로(PLAN-2026-09-20 W5, 리터럴 테스트 chart.test.ts).
 * - 텍스트 열 1 + 숫자 열 1 → bar · line · pie
 * - 숫자 열 2+ → stacked · line · bar
 * - 숫자 열만 1개(라벨 열 없음) → kpi · bar
 * - 행 ≤ 6 이면 pie 를 맨 앞으로(있을 때만)
 * - 숫자 열 0개 → []  — 진입점(Explore 그룹·퀵 칩)이 **부재**한다(비활성이 아니다).
 */
export function recommendChartTypes(
  doc: SheetDoc,
  range: { r1: number; c1: number; r2: number; c2: number },
  engine?: SheetEngine,
): ChartSpec["type"][] {
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  const c1 = Math.min(range.c1, range.c2);
  const c2 = Math.max(range.c1, range.c2);
  let nums = 0;
  let texts = 0;
  for (let c = c1; c <= c2; c++) {
    const k = colKind(doc, engine, c, r1, r2);
    if (k === "num") nums++;
    else if (k === "text") texts++;
  }
  if (nums === 0) return [];
  let out: ChartSpec["type"][];
  if (nums >= 2) out = ["stacked", "line", "bar"];
  else if (texts >= 1) out = ["bar", "line", "pie"];
  else out = ["kpi", "bar"];
  const rows = r2 - r1 + 1;
  if (rows <= 6 && out.includes("pie")) out = ["pie", ...out.filter((t) => t !== "pie")];
  return out;
}

function parseNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function getCellValue(doc: SheetDoc, engine: SheetEngine | undefined, a1: string): unknown {
  if (engine) {
    const val = engine.getValue(a1);
    if (val !== null && val !== undefined) {
      if (typeof val === "object" && "error" in val) return null;
      return val;
    }
  }
  return doc.cells[a1]?.raw ?? null;
}

/**
 * ChartSpec과 SheetDoc(선택적으로 SheetEngine)에서 차트 렌더링에 필요한 데이터셋을 뽑아낸다.
 */
export function extractChartData(
  doc: SheetDoc,
  spec: ChartSpec,
  engine?: SheetEngine
): ExtractedChartData {
  const eng = engine ?? new SheetEngine(doc);

  // 1. X축 레이블 셀 목록
  let xKeys: string[] = [];
  if (spec.x) {
    const range = parseRange(spec.x);
    if (range) {
      xKeys = expandRange(range);
    } else {
      const single = parseRef(spec.x);
      if (single) xKeys = [refKey(single.col, single.row)];
    }
  }

  // 2. 시리즈별 셀 목록
  const seriesMap: Record<string, string[]> = {};
  spec.series.forEach((sRangeStr, sIdx) => {
    const sName = `series_${sIdx + 1}`;
    const range = parseRange(sRangeStr);
    if (range) {
      seriesMap[sName] = expandRange(range);
    } else {
      const single = parseRef(sRangeStr);
      if (single) seriesMap[sName] = [refKey(single.col, single.row)];
      else seriesMap[sName] = [];
    }
  });

  const seriesKeys = Object.keys(seriesMap);
  const maxLen = Math.max(
    xKeys.length,
    ...seriesKeys.map((k) => seriesMap[k].length),
    0
  );

  const data: ChartDataPoint[] = [];
  let grandTotal = 0;

  for (let i = 0; i < maxLen; i++) {
    const xKey = xKeys[i];
    const xVal = xKey ? getCellValue(doc, eng, xKey) : null;
    const name = xVal !== null && xVal !== undefined ? String(xVal) : String(i + 1);

    const point: ChartDataPoint = { name };

    seriesKeys.forEach((sKey) => {
      const cellKey = seriesMap[sKey][i];
      if (cellKey) {
        const rawVal = getCellValue(doc, eng, cellKey);
        const numVal = parseNumber(rawVal);
        point[sKey] = numVal;
        grandTotal += numVal;
      } else {
        point[sKey] = 0;
      }
    });

    data.push(point);
  }

  return {
    data,
    seriesKeys,
    total: grandTotal,
  };
}
