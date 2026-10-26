import type { YearBounds } from "../../../stores/search";
import { formatYearRange } from "../../home/dateFmt";

/* ── 연도 축(notes.year) 순수 헬퍼 — 데스크톱 TimelineFilter 와 폰 MobileYearRangeSlider 가 같이 쓴다.
 * 축(min/max)은 search.ts::deriveYearBoundsFromCounts 가 padYearRange 로 데이터 양끝에 1년 이상
 * 여유를 둔 값이다(손잡이·눈금이 트랙 끝에 붙지 않게 하는 화면 틀). 그 여유 연도에는 노트가 없다. */

/**
 * 범위 표기 — 선택 구간을 **실제 노트 연도(dataMin~dataMax)로 잘라서** 읽는다.
 * 패딩은 축을 그리기 위한 틀일 뿐이라, 전체 범위일 때 "2025 – 2028"(데이터는 2026~2027)처럼
 * 노트가 하나도 없는 해를 이름에 넣으면 사용자가 그 해에 뭔가 있다고 읽는다(2026-10-10 오너 지적).
 * 데이터 연도가 없으면(빈 코퍼스 폴백) 선택값 그대로. 선택이 전부 패딩 안에 있으면(데이터 밖)
 * 잘라낼 수 없으니 선택값 그대로 둔다 — 그 구간은 비어 있다는 걸 목록이 보여 준다.
 */
export function yearRangeDisplay(
  from: number,
  to: number,
  bounds: YearBounds,
): { from: number; to: number } {
  const { dataMin, dataMax } = bounds;
  if (dataMin == null || dataMax == null) return { from, to };
  const f = Math.max(from, dataMin);
  const tt = Math.min(to, dataMax);
  if (f > tt) return { from, to };
  return { from: f, to: tt };
}

export function yearRangeLabel(from: number, to: number, bounds: YearBounds): string {
  const d = yearRangeDisplay(from, to, bounds);
  return formatYearRange(d.from, d.to);
}

/**
 * yearRangeDisplay 의 역 — 사람이 데이터 양끝 연도(또는 그 바깥)를 입력하면 축 끝(패딩 포함)으로
 * 넓힌다. 안 그러면 라벨 "2026 – 2027" 을 그대로 확인만 해도 2026–2027 이 저장돼, 걸러지는 노트는
 * 같은데 "필터 걸림"(전체로 버튼·accent 라벨)으로 보인다.
 */
export function expandToYearAxis(
  from: number,
  to: number,
  bounds: YearBounds,
): { from: number; to: number } {
  const { dataMin, dataMax } = bounds;
  return {
    from: dataMin != null && from <= dataMin ? Math.min(from, bounds.min) : from,
    to: dataMax != null && to >= dataMax ? Math.max(to, bounds.max) : to,
  };
}

/** 선택이 축 전체인가 — "필터 없음" 판정(라벨 흐림·전체로 버튼 숨김). */
export function isFullYearRange(from: number, to: number, bounds: YearBounds): boolean {
  return from <= bounds.min && to >= bounds.max;
}

/** 연도별 노트 수 → 축 위 위치(0..1). 축 밖·0건은 뺀다. 그리는 쪽이 px/% 로 바꾼다. */
export function yearDensity(
  yearCounts: Record<number, number>,
  axisMin: number,
  axisMax: number,
): { year: number; frac: number; count: number }[] {
  const span = axisMax - axisMin;
  if (!(span > 0)) return [];
  const out: { year: number; frac: number; count: number }[] = [];
  for (const [ys, count] of Object.entries(yearCounts)) {
    const year = Number(ys);
    if (!Number.isFinite(year) || year < axisMin || year > axisMax || !(count > 0)) continue;
    out.push({ year, frac: (year - axisMin) / span, count });
  }
  return out;
}

/** 눈금 폭 — 노트 수를 2px/건, 2~8px 로 인코딩(데스크톱 원래 식 그대로). */
export function densityMarkWidth(count: number): number {
  return Math.max(2, Math.min(8, count * 2));
}

/** 트랙 위 비율(0..1) → 정수 연도. */
export function yearAtFraction(frac: number, min: number, max: number): number {
  const f = Math.min(1, Math.max(0, frac));
  return Math.round(min + f * (max - min));
}

/**
 * 터치 한 번이 어느 손잡이를 잡는가 — 더 가까운 쪽. 같은 거리(손잡이 사이 정중앙)면 바깥쪽으로
 * 미는 방향을 따른다: 왼쪽 손잡이보다 왼쪽이면 from, 아니면 to. 손잡이마다 히트박스를 따로 두면
 * 구간이 좁을 때 44px 영역이 겹쳐 한쪽이 영영 안 잡힌다 — 트랙 전체가 한 히트존인 이유.
 */
export function nearestYearHandle(year: number, from: number, to: number): "from" | "to" {
  const df = Math.abs(year - from);
  const dt = Math.abs(year - to);
  if (df < dt) return "from";
  if (dt < df) return "to";
  return year < from ? "from" : "to";
}

/**
 * 손잡이 하나를 year 로 옮긴 새 구간. 축 안으로 자르고 from < to 를 지킨다 — setYearRange 는
 * 같거나 뒤집힌 구간을 전체로 되돌리므로(search.ts) 여기서 1년 간격을 보장해야 드래그가 튀지 않는다.
 */
export function moveYearHandle(
  range: { from: number; to: number },
  handle: "from" | "to",
  year: number,
  bounds: { min: number; max: number },
): { from: number; to: number } {
  if (handle === "from") {
    const from = Math.min(Math.max(year, bounds.min), range.to - 1);
    return { from: Math.max(from, bounds.min), to: range.to };
  }
  const to = Math.max(Math.min(year, bounds.max), range.from + 1);
  return { from: range.from, to: Math.min(to, bounds.max) };
}
