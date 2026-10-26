// 시트 작업 어시스트 — 수식·서식 프리셋 레지스트리 (PLAN-2026-09-21 W3, D5).
// Explore(recommendChartTypes)와 같은 동형 모델: SHEET_ASSISTS 를 순수 함수 recommendSheetAssists 가
// when() 으로 걸러 id 목록만 돌려주고, 실제 쓰기는 SheetAssist.tsx 가 클릭 시 apply() 로 부른다.
//
// ponytail: 열 종류 판정(colKindLocal)은 chart.ts::colKind 와 완전히 같은 규칙(수식이 아닌 raw 의
// literal() 이 문자열이면 텍스트, 첫 행 문자는 헤더로 뺀다)이지만 그대로 복사했다 — chart.ts 는 이
// 웨이브의 소유권 밖이라 export 를 늘릴 수 없다(지시서 deviations 항목). chart.ts 가 나중에 이 헬퍼를
// export 하면 이 사본은 지우고 그쪽을 재사용해도 된다.
import type { ComponentType } from "react";
import { refKey, formatRef } from "./a1";
import { literal } from "./eval";
import { t } from "../../i18n/t";
import type { SheetEngine } from "./engine";
import type { CellFmt, CellPatch, SheetDoc } from "./types";
import {
  IconFmtNumber,
  IconActivity,
  IconSort,
  IconHistory,
  IconFmtCurrency,
  IconFmtPercent,
  IconCalendar,
  IconCheck,
  IconSortAsc,
  IconSortDesc,
  IconRowDelete,
  IconArrowDown,
  IconHighlight,
  IconEraser,
  type IconProps,
} from "../../components/icons";

export type SheetAssistId =
  | "sum_row"
  | "avg_row"
  | "count_row"
  | "minmax_row"
  | "running_total"
  | "fmt_currency"
  | "fmt_percent"
  | "fmt_date"
  | "fmt_checkbox"
  | "sort_asc"
  | "sort_desc"
  | "dedupe_rows"
  | "fill_blank_down"
  | "hl_extremes"
  | "hl_extremes_clear";

/** chart.ts::recommendChartTypes 와 같은 형태 — CellRange(useSheetState)를 import 하지 않고 구조로만
 *  받는다(lib 이 components 쪽 타입에 얽히지 않도록, chart.ts 의 기존 관례 그대로). */
export interface SheetAssistRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** useSheetState 의 쓰기 함수 그대로 — 시트 쓰기는 그 훅만 지난다(CLAUDE.md 함정 3). */
export interface SheetAssistOps {
  setCells: (patch: CellPatch) => void;
  setColFormat: (colIdx: number, fmt: CellFmt, dp?: number, cur?: string) => void;
  sortRange: (colIdx: number, desc?: boolean) => void;
  insertRow: (atRow: number, after?: boolean) => void;
  insertCol: (atCol: number, after?: boolean) => void;
  /** 임의의(연속 아닐 수도 있는) 행 목록을 undo 1스텝으로 삭제 — dedupe_rows 전용. optional 인 이유는
   *  ops 필드 하나하나와 같다(주석 참고) — 이 필드를 모르는 기존 ops 리터럴의 tsc 를 깨지 않는다. */
  deleteRows?: (rows: number[]) => void;
}

export interface SheetAssistCtx {
  doc: SheetDoc;
  engine: SheetEngine;
  range: SheetAssistRange;
  ops: SheetAssistOps;
}

export interface SheetAssistDef {
  id: SheetAssistId;
  nameKey: string;
  Icon?: ComponentType<IconProps>;
  when: (ctx: SheetAssistCtx) => boolean;
  apply: (ctx: SheetAssistCtx) => void;
}

/** when() 은 순수 판정만 — apply 전용 ops 를 부르면 즉시 죽는다(recommendSheetAssists 가 넘기는 자리
 *  채우기 값이라 실제 쓰기 함수가 없다). */
function opsMustNotBeCalledFromWhen(): never {
  throw new Error("sheet assist: when() 안에서 ops 를 부르면 안 된다 — 순수 판정만.");
}
const NOOP_OPS: SheetAssistOps = {
  setCells: opsMustNotBeCalledFromWhen,
  setColFormat: opsMustNotBeCalledFromWhen,
  sortRange: opsMustNotBeCalledFromWhen,
  insertRow: opsMustNotBeCalledFromWhen,
  insertCol: opsMustNotBeCalledFromWhen,
  deleteRows: opsMustNotBeCalledFromWhen,
};

function norm(range: SheetAssistRange): SheetAssistRange {
  return {
    r1: Math.min(range.r1, range.r2),
    r2: Math.max(range.r1, range.r2),
    c1: Math.min(range.c1, range.c2),
    c2: Math.max(range.c1, range.c2),
  };
}

type ColKind = "num" | "text" | "empty";

/** chart.ts::colKind 와 동일 — 파일 상단 ponytail 주석 참고. */
function colKindLocal(doc: SheetDoc, engine: SheetEngine | undefined, c: number, r1: number, r2: number): ColKind {
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

/** 범위 첫 행에 문자 리터럴이 하나라도 있으면 헤더로 본다(defaultChartRanges 의 라벨열 판정과 같은
 *  규칙을 행에 적용). 집계 행 수식은 헤더를 뺀 데이터 행만 합산한다. */
function hasHeaderRow(doc: SheetDoc, r1: number, c1: number, c2: number): boolean {
  for (let c = c1; c <= c2; c++) {
    const raw = doc.cells[refKey(c, r1)]?.raw ?? "";
    if (raw && !raw.startsWith("=") && typeof literal(raw) === "string") return true;
  }
  return false;
}
function dataR1(doc: SheetDoc, r1: number, c1: number, c2: number): number {
  return hasHeaderRow(doc, r1, c1, c2) ? r1 + 1 : r1;
}

function hasNumericCol(doc: SheetDoc, engine: SheetEngine, c1: number, c2: number, r1: number, r2: number): boolean {
  for (let c = c1; c <= c2; c++) if (colKindLocal(doc, engine, c, r1, r2) === "num") return true;
  return false;
}

function countNumericCols(doc: SheetDoc, engine: SheetEngine, c1: number, c2: number, r1: number, r2: number): number {
  let n = 0;
  for (let c = c1; c <= c2; c++) if (colKindLocal(doc, engine, c, r1, r2) === "num") n++;
  return n;
}

/** 범위 열 구간에서 지정한 행이 전부 비어 있는가 — 합계류 행을 기존 데이터 위에 덮어쓰지 않는다. */
function rowEmpty(doc: SheetDoc, row: number, c1: number, c2: number): boolean {
  for (let c = c1; c <= c2; c++) {
    if ((doc.cells[refKey(c, row)]?.raw ?? "") !== "") return false;
  }
  return true;
}
/** 열 하나에서 지정한 행 구간이 전부 비어 있는가 — running_total 이 오른쪽 열을 덮지 않는다. */
function colEmpty(doc: SheetDoc, col: number, r1: number, r2: number): boolean {
  for (let r = r1; r <= r2; r++) {
    if ((doc.cells[refKey(col, r)]?.raw ?? "") !== "") return false;
  }
  return true;
}

/** 합계/평균/개수 행 — 같은 모양(범위 첫 열에 라벨, 숫자 열마다 수식)을 함수만 바꿔 만든다. */
function aggregateRowAssist(
  id: SheetAssistId,
  nameKey: string,
  labelKey: string,
  fn: "SUM" | "AVERAGE" | "COUNT",
  Icon: ComponentType<IconProps>,
): SheetAssistDef {
  return {
    id,
    nameKey,
    Icon,
    when(ctx) {
      const { doc, engine, range } = ctx;
      const { r1, r2, c1, c2 } = norm(range);
      if (!hasNumericCol(doc, engine, c1, c2, r1, r2)) return false;
      return rowEmpty(doc, r2 + 1, c1, c2);
    },
    apply(ctx) {
      const { doc, engine, range, ops } = ctx;
      const { r1, r2, c1, c2 } = norm(range);
      const dr1 = dataR1(doc, r1, c1, c2);
      const labelRow = r2 + 1;
      const patch: CellPatch = {};
      const c1IsNum = colKindLocal(doc, engine, c1, r1, r2) === "num";
      if (!c1IsNum) patch[refKey(c1, labelRow)] = { raw: t(labelKey) };
      for (let c = c1; c <= c2; c++) {
        if (colKindLocal(doc, engine, c, r1, r2) !== "num") continue;
        patch[refKey(c, labelRow)] = { raw: `=${fn}(${refKey(c, dr1)}:${refKey(c, r2)})` };
      }
      ops.setCells(patch);
    },
  };
}

/** 최소·최대 행 — 한 번의 클릭이 두 행(최소 다음 최대)을 한 setCells 로 채운다(undo 1스텝). */
const minmaxRowAssist: SheetAssistDef = {
  id: "minmax_row",
  nameKey: "presets.sheet_assist_minmax_row",
  Icon: IconSort,
  when(ctx) {
    const { doc, engine, range } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    if (!hasNumericCol(doc, engine, c1, c2, r1, r2)) return false;
    return rowEmpty(doc, r2 + 1, c1, c2) && rowEmpty(doc, r2 + 2, c1, c2);
  },
  apply(ctx) {
    const { doc, engine, range, ops } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    const dr1 = dataR1(doc, r1, c1, c2);
    const minRow = r2 + 1;
    const maxRow = r2 + 2;
    const patch: CellPatch = {};
    const c1IsNum = colKindLocal(doc, engine, c1, r1, r2) === "num";
    if (!c1IsNum) {
      patch[refKey(c1, minRow)] = { raw: t("presets.sheet_assist_label_min") };
      patch[refKey(c1, maxRow)] = { raw: t("presets.sheet_assist_label_max") };
    }
    for (let c = c1; c <= c2; c++) {
      if (colKindLocal(doc, engine, c, r1, r2) !== "num") continue;
      const colRange = `${refKey(c, dr1)}:${refKey(c, r2)}`;
      patch[refKey(c, minRow)] = { raw: `=MIN(${colRange})` };
      patch[refKey(c, maxRow)] = { raw: `=MAX(${colRange})` };
    }
    ops.setCells(patch);
  },
};

/** 누계 열 — 숫자 열이 정확히 하나일 때만(여러 열이면 어느 열을 누계할지 모호하다). 오른쪽 열을
 *  밀어내지 않고(insertCol 은 별도 undo 스텝이라 "1클릭 = 1 undo" 가 깨진다) 비어 있을 때만 채운다.
 *  ponytail: 계획 원문은 "오른쪽 새 열에"(insertCol)였지만, 기존 열 삽입 경로를 더하면 undo 가
 *  두 스텝으로 쪼개진다(CLAUDE.md 시트 함정 3 은 "훅의 함수만" 이지 "여러 함수 합성"은 보장 안 함) —
 *  setCells 하나로 접는 대신 조건을 "오른쪽 열이 비어 있을 때만"으로 좁혔다. 열 삽입이 꼭 필요해지면
 *  그때 useSheetState 에 "삽입+채우기"를 한 undo 스텝으로 묶는 함수를 추가한다. */
const runningTotalAssist: SheetAssistDef = {
  id: "running_total",
  nameKey: "presets.sheet_assist_running_total",
  Icon: IconHistory,
  when(ctx) {
    const { doc, engine, range } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    if (countNumericCols(doc, engine, c1, c2, r1, r2) !== 1) return false;
    return colEmpty(doc, c2 + 1, r1, r2 + 1);
  },
  apply(ctx) {
    const { doc, engine, range, ops } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    let numCol = c1;
    for (let c = c1; c <= c2; c++) if (colKindLocal(doc, engine, c, r1, r2) === "num") numCol = c;
    const dr1 = dataR1(doc, r1, c1, c2);
    const targetCol = c2 + 1;
    const anchor = formatRef({ col: numCol, row: dr1, absCol: true, absRow: true });
    const patch: CellPatch = {};
    for (let r = dr1; r <= r2; r++) {
      patch[refKey(targetCol, r)] = { raw: `=SUM(${anchor}:${refKey(numCol, r)})` };
    }
    ops.setCells(patch);
  },
};

const DATE_SHAPE_RES = [
  /^\d{4}-\d{1,2}-\d{1,2}$/,
  /^\d{4}[./]\d{1,2}[./]\d{1,2}$/,
  /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일$/,
];
function isDateShapeCol(doc: SheetDoc, c: number, r1: number, r2: number): boolean {
  const dr1 = dataR1(doc, r1, c, c);
  let count = 0;
  for (let r = dr1; r <= r2; r++) {
    const raw = (doc.cells[refKey(c, r)]?.raw ?? "").trim();
    if (!raw || raw.startsWith("=")) continue;
    if (!DATE_SHAPE_RES.some((re) => re.test(raw))) return false;
    count++;
  }
  return count > 0;
}

const CHECKBOX_SHAPE_VALUES = new Set(["예", "아니오", "true", "false"]);
function isCheckboxShapeCol(doc: SheetDoc, c: number, r1: number, r2: number): boolean {
  const dr1 = dataR1(doc, r1, c, c);
  let count = 0;
  for (let r = dr1; r <= r2; r++) {
    const raw = (doc.cells[refKey(c, r)]?.raw ?? "").trim();
    if (!raw || raw.startsWith("=")) continue;
    if (!CHECKBOX_SHAPE_VALUES.has(raw.toLowerCase())) return false;
    count++;
  }
  return count > 0;
}

/** 서식 프리셋 — 범위 첫 열 하나에 setColFormat. 이미 그 서식이면 다시 권하지 않는다. */
function fmtAssist(
  id: SheetAssistId,
  nameKey: string,
  fmt: CellFmt,
  Icon: ComponentType<IconProps>,
  shapeOf: (doc: SheetDoc, engine: SheetEngine, c: number, r1: number, r2: number) => boolean,
): SheetAssistDef {
  return {
    id,
    nameKey,
    Icon,
    when(ctx) {
      const { doc, engine, range } = ctx;
      const { r1, r2, c1 } = norm(range);
      if (doc.cols[c1]?.fmt === fmt) return false;
      return shapeOf(doc, engine, c1, r1, r2);
    },
    apply(ctx) {
      const { c1 } = norm(ctx.range);
      ctx.ops.setColFormat(c1, fmt);
    },
  };
}

/** 범위 안에서 완전히 같은 내용의 행을 찾는다(첫 등장은 남기고, 그 뒤 중복만 삭제 대상). 전부 빈
 *  칸인 행은 "중복"으로 치지 않는다(둘 다 빈 걸 지우자는 요청이 아니다). */
function findDuplicateRows(doc: SheetDoc, r1: number, r2: number, c1: number, c2: number): number[] {
  const seen = new Set<string>();
  const dupes: number[] = [];
  for (let r = r1; r <= r2; r++) {
    const parts: string[] = [];
    for (let c = c1; c <= c2; c++) parts.push(doc.cells[refKey(c, r)]?.raw ?? "");
    if (parts.every((p) => p === "")) continue;
    const sig = parts.join(" ");
    if (seen.has(sig)) dupes.push(r);
    else seen.add(sig);
  }
  return dupes;
}

const dedupeRowsAssist: SheetAssistDef = {
  id: "dedupe_rows",
  nameKey: "presets.sheet_assist_dedupe_rows",
  Icon: IconRowDelete,
  when(ctx) {
    const { doc, range } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    return findDuplicateRows(doc, r1, r2, c1, c2).length > 0;
  },
  apply(ctx) {
    const { doc, range, ops } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    ops.deleteRows?.(findDuplicateRows(doc, r1, r2, c1, c2));
  },
};

/** 첫 열(라벨 열)에서 "빈 칸인데 그 위 어딘가에 값이 있는" 후보 — 가장 가까운 위 값을 그대로
 *  당겨 채운다(그룹 라벨을 첫 행에만 적어 두는 흔한 표 모양). */
function blankFillCandidates(doc: SheetDoc, r1: number, r2: number, col: number): Array<{ row: number; value: string }> {
  const out: Array<{ row: number; value: string }> = [];
  let last: string | null = null;
  for (let r = r1; r <= r2; r++) {
    const raw = doc.cells[refKey(col, r)]?.raw ?? "";
    if (raw !== "") {
      last = raw;
      continue;
    }
    if (last !== null) out.push({ row: r, value: last });
  }
  return out;
}

const fillBlankDownAssist: SheetAssistDef = {
  id: "fill_blank_down",
  nameKey: "presets.sheet_assist_fill_blank_down",
  Icon: IconArrowDown,
  when(ctx) {
    const { doc, range } = ctx;
    const { r1, r2, c1 } = norm(range);
    return blankFillCandidates(doc, r1, r2, c1).length > 0;
  },
  apply(ctx) {
    const { doc, range, ops } = ctx;
    const { r1, r2, c1 } = norm(range);
    const patch: CellPatch = {};
    for (const { row, value } of blankFillCandidates(doc, r1, r2, c1)) {
      patch[refKey(c1, row)] = { raw: value };
    }
    ops.setCells(patch);
  },
};

/** 수식 셀은 계산값을, 리터럴 셀은 literal() 값을 — colKindLocal 과 같은 판정 기준(숫자만). */
function numericCellValue(doc: SheetDoc, engine: SheetEngine, key: string): number | null {
  const raw = doc.cells[key]?.raw ?? "";
  if (raw === "") return null;
  const v = raw.startsWith("=") ? engine.getValue(key) : literal(raw);
  return typeof v === "number" ? v : null;
}

function anyHighlighted(doc: SheetDoc, r1: number, r2: number, c1: number, c2: number): boolean {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (doc.cells[refKey(c, r)]?.hl) return true;
    }
  }
  return false;
}

/** 최대·최소 강조 — 숫자 열마다 최댓값 셀에 hl:"ok", 최솟값 셀에 hl:"warn"(같은 셀이면 ok 만).
 *  이미 강조된 셀이 있으면(anyHighlighted) 같은 id 대신 해제 짝(hl_extremes_clear)이 추천된다 —
 *  두 def 의 when() 이 서로 배타적이라 항상 하나만(또는 둘 다 아님) 뜬다. */
const hlExtremesAssist: SheetAssistDef = {
  id: "hl_extremes",
  nameKey: "presets.sheet_assist_hl_extremes",
  Icon: IconHighlight,
  when(ctx) {
    const { doc, engine, range } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    if (r2 - r1 + 1 < 3) return false;
    if (anyHighlighted(doc, r1, r2, c1, c2)) return false;
    return hasNumericCol(doc, engine, c1, c2, r1, r2);
  },
  apply(ctx) {
    const { doc, engine, range, ops } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    const dr1 = dataR1(doc, r1, c1, c2);
    const patch: CellPatch = {};
    for (let c = c1; c <= c2; c++) {
      if (colKindLocal(doc, engine, c, r1, r2) !== "num") continue;
      let maxRow = -1;
      let minRow = -1;
      let maxV = -Infinity;
      let minV = Infinity;
      for (let r = dr1; r <= r2; r++) {
        const v = numericCellValue(doc, engine, refKey(c, r));
        if (v === null) continue;
        if (v > maxV) { maxV = v; maxRow = r; }
        if (v < minV) { minV = v; minRow = r; }
      }
      if (maxRow < 0) continue;
      patch[refKey(c, maxRow)] = { raw: doc.cells[refKey(c, maxRow)].raw, hl: "ok" };
      if (minRow >= 0 && minRow !== maxRow) {
        patch[refKey(c, minRow)] = { raw: doc.cells[refKey(c, minRow)].raw, hl: "warn" };
      }
    }
    ops.setCells(patch);
  },
};

/** 위 강조의 해제 짝 — 범위 안 hl 이 있는 셀을 전부 지운다. */
const hlExtremesClearAssist: SheetAssistDef = {
  id: "hl_extremes_clear",
  nameKey: "presets.sheet_assist_hl_extremes_clear",
  Icon: IconEraser,
  when(ctx) {
    const { doc, range } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    return anyHighlighted(doc, r1, r2, c1, c2);
  },
  apply(ctx) {
    const { doc, range, ops } = ctx;
    const { r1, r2, c1, c2 } = norm(range);
    const patch: CellPatch = {};
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const key = refKey(c, r);
        const cell = doc.cells[key];
        if (cell?.hl) patch[key] = { raw: cell.raw, hl: null };
      }
    }
    ops.setCells(patch);
  },
};

export const SHEET_ASSISTS: readonly SheetAssistDef[] = [
  aggregateRowAssist("sum_row", "presets.sheet_assist_sum_row", "presets.sheet_assist_label_sum", "SUM", IconFmtNumber),
  aggregateRowAssist("avg_row", "presets.sheet_assist_avg_row", "presets.sheet_assist_label_avg", "AVERAGE", IconActivity),
  aggregateRowAssist("count_row", "presets.sheet_assist_count_row", "presets.sheet_assist_label_count", "COUNT", IconFmtNumber),
  minmaxRowAssist,
  runningTotalAssist,
  fmtAssist("fmt_currency", "presets.sheet_assist_fmt_currency", "currency", IconFmtCurrency, (doc, engine, c, r1, r2) => colKindLocal(doc, engine, c, r1, r2) === "num"),
  fmtAssist("fmt_percent", "presets.sheet_assist_fmt_percent", "percent", IconFmtPercent, (doc, engine, c, r1, r2) => colKindLocal(doc, engine, c, r1, r2) === "num"),
  fmtAssist("fmt_date", "presets.sheet_assist_fmt_date", "date", IconCalendar, (doc, _engine, c, r1, r2) => isDateShapeCol(doc, c, r1, r2)),
  fmtAssist("fmt_checkbox", "presets.sheet_assist_fmt_checkbox", "checkbox", IconCheck, (doc, _engine, c, r1, r2) => isCheckboxShapeCol(doc, c, r1, r2)),
  {
    id: "sort_asc",
    nameKey: "presets.sheet_assist_sort_asc",
    Icon: IconSortAsc,
    when(ctx) {
      const { r1, r2 } = norm(ctx.range);
      return r2 - r1 + 1 >= 3;
    },
    apply(ctx) {
      const { c1 } = norm(ctx.range);
      ctx.ops.sortRange(c1, false);
    },
  },
  {
    id: "sort_desc",
    nameKey: "presets.sheet_assist_sort_desc",
    Icon: IconSortDesc,
    when(ctx) {
      const { r1, r2 } = norm(ctx.range);
      return r2 - r1 + 1 >= 3;
    },
    apply(ctx) {
      const { c1 } = norm(ctx.range);
      ctx.ops.sortRange(c1, true);
    },
  },
  dedupeRowsAssist,
  fillBlankDownAssist,
  hlExtremesAssist,
  hlExtremesClearAssist,
];

/** Explore(recommendChartTypes)와 동형 — 순수 함수, id 목록만. 추천이 비면 그룹 자체가 부재. */
export function recommendSheetAssists(doc: SheetDoc, range: SheetAssistRange, engine: SheetEngine): SheetAssistId[] {
  const ctx: SheetAssistCtx = { doc, engine, range, ops: NOOP_OPS };
  return SHEET_ASSISTS.filter((def) => def.when(ctx)).map((def) => def.id);
}
