import type { NoteSummary } from "../../../lib/commands.gen";

/* ── Timeline expanded view: 행 타입 및 평탄화 (SCALABILITY.md 준수) ── */

/** Content box for a year header (label + tick + rule), bottom-aligned.
 * 22px: 헤더는 월 선택/접기 영역이므로 약간 여유 있게. 노트(22px)와 동일 행 높이로
 * 위계 차이 없이 균일한 리스트 리듬. */
export const TIMELINE_HEADER_HEIGHT = 28;
export const TIMELINE_HEADER_LEADING_GAP = 0;
export const TIMELINE_NOTE_HEIGHT = 28;
export const TIMELINE_EMPTY_HEIGHT = 72;

/**
 * Max DOM ticks on the search-hit strip. The strip is a few hundred px tall;
 * more marks than that wastes work and paint. Hard bound so 10k+ hits stay O(1) nodes.
 */
export const SEARCH_HIT_TICK_BUCKETS = 128;

/**
 * §2.3 HANDOFF-calendar-onboarding.md: header granularity. "year" is the original/default
 * behaviour (one header per year, unchanged). "month"/"day" nest finer headers under each year
 * header — a "month unknown" bucket always sorts first within its year (precision loss is shown,
 * not hidden), followed by the months actually present. "day" additionally splits each *known*
 * month into day buckets ("day unknown" first, then days present); a month-unknown bucket is
 * never split further by day — day requires month (repo::notes::set_event_precision enforces
 * this), so every note in "month unknown" also has day unknown.
 */
export type TimelineZoomLevel = "year" | "month" | "day";

export type TimelineHeaderRow = {
  type: "header";
  /** 0 = year, 1 = month (nested under a year), 2 = day (nested under a month). */
  depth: 0 | 1 | 2;
  year: number;
  /** Set at depth 1/2. null at depth 1 means "month unknown" for this year. */
  month: number | null;
  /** Set at depth 2. null means "day unknown" for this (known) month. */
  day: number | null;
  count: number;
  leadingGap: boolean;
  collapsed?: boolean;
};

export type TimelineRow =
  | { type: "empty" }
  | TimelineHeaderRow
  | { type: "note"; note: NoteSummary; depth: 0 | 1 | 2 };

export interface FlattenTimelineRowsInput {
  /** note_query year_asc window — 연도 오름차순으로 이미 정렬돼 있어야 한다(연도 안의 순서는
   * 서버의 created_at 순이어도 된다 — flattenTimelineRows 가 사건 날짜순으로 다시 정렬한다). */
  sortedNotes: NoteSummary[];
  yearFrom: number;
  yearTo: number;
  /** Header granularity (§2.3). Defaults to "year" — the original single-level behaviour. */
  zoomLevel?: TimelineZoomLevel;
  collapsedKeys?: Set<string>;
}

/**
 * 노트 행의 사건 날짜 배지 — 머리글이 이미 말한 단위는 빼고 나머지만:
 * 월 머리글 아래(depth 1) = 일("17일"/"17"), 연 머리글 바로 아래(depth 0) = 월·일("9월 17일"/"Sep 17").
 * 모르는 단위는 지어내지 않는다(일 미상이면 배지 없음 / 월만 알면 월만). 데스크톱 TimelineExpandedRow
 * 와 폰 MobileTimelineView 가 같이 쓴다 — 폰이 여기 대신 updated_at 을 찍어 "2026.05" 머리글 밑에
 * "9월 17일"이 나오던 어긋남(2026-10-10)의 해법. 로케일 문자열은 Intl 에 맡긴다(예전 "일"/"월" 하드코딩은
 * en/fr 에서도 한국어로 나왔다). 연도는 고정 윤년(2000)을 써서 2/29 도 안전하다 — 표시엔 연도가 없다.
 */
export function timelineNoteDateBadge(
  note: Pick<NoteSummary, "month" | "day">,
  depth: 0 | 1 | 2,
  uiLang: string,
): string | null {
  const { month, day } = note;
  if (depth >= 2 || month == null) return null;
  if (depth === 1) {
    if (day == null) return null;
    return new Intl.DateTimeFormat(uiLang, { day: "numeric" }).format(new Date(2000, month - 1, day));
  }
  const opts: Intl.DateTimeFormatOptions = day == null ? { month: "short" } : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(uiLang, opts).format(new Date(2000, month - 1, day ?? 1));
}

export function getTimelineHeaderKey(
  depth: number,
  year: number,
  month: number | null = null,
  day: number | null = null,
): string {
  if (depth === 0) return `y:${year}`;
  if (depth === 1) return `m:${year}-${month ?? "u"}`;
  return `d:${year}-${month ?? "u"}-${day ?? "u"}`;
}

function pushHeader(
  rows: TimelineRow[],
  depth: 0 | 1 | 2,
  year: number,
  month: number | null,
  day: number | null,
  count: number,
  collapsed = false,
): number {
  const idx = rows.length;
  // A collapsed header already terminates its group — the next header needs no extra gap above
  // it, otherwise a fully collapsed list reads as one oversized blank band per row.
  const prev = rows[idx - 1];
  const afterCollapsed = prev?.type === "header" && prev.collapsed === true;
  rows.push({
    type: "header",
    depth,
    year,
    month,
    day,
    count,
    leadingGap: rows.length > 0 && !afterCollapsed,
    collapsed,
  });
  return idx;
}

/** Stable bucket-by-key: preserves first-seen order among keys, and each bucket keeps the
 * input's relative note order. `unknownFirst` reorders so the `null`-key bucket (if present)
 * sorts before every other bucket, regardless of first-seen position. */
function bucketBy<T>(items: T[], keyOf: (item: T) => number | null): Map<number | null, T[]> {
  const map = new Map<number | null, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  if (map.has(null)) {
    const known = [...map.entries()].filter(([k]) => k !== null).sort((a, b) => (a[0] as number) - (b[0] as number));
    const reordered = new Map<number | null, T[]>();
    reordered.set(null, map.get(null)!);
    for (const [k, v] of known) reordered.set(k, v);
    return reordered;
  }
  return new Map([...map.entries()].sort((a, b) => (a[0] as number) - (b[0] as number)));
}

/** null-first ascending compare — "모름" 이 아는 값보다 앞선다(bucketBy 의 unknown-first 와 같은 규칙). */
function cmpNullFirst<T extends number | string>(a: T | null | undefined, b: T | null | undefined): number {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 같은 연도 안의 노트 순서: 월 → 일 → 시작 시각(HH:MM, 서버가 형식을 검증하므로 문자열 비교로
 * 충분), 모두 오름차순·모름 먼저. 셋이 같으면 0 — Array.prototype.sort 가 안정 정렬이므로 서버의
 * created_at → id 순서가 최종 타이브레이크로 남는다(로케일 없이 결정적; 제목 비교는 uiLang 이 없는
 * 순수 함수라 넣지 않았다).
 */
function compareWithinYear(a: NoteSummary, b: NoteSummary): number {
  return cmpNullFirst(a.month, b.month) || cmpNullFirst(a.day, b.day) || cmpNullFirst(a.start_time, b.start_time);
}

/**
 * 연도 범위 [yearFrom, yearTo] 를 잘라 헤더 행 + 노트 행의 단일 1차원 배열로 평탄화한다.
 * react-window List 가 이 배열의 뷰포트 구간만 마운트한다. 입력이 연도순으로 정렬돼 있으므로
 * 범위를 벗어나는 순간 순회를 끊는다 — 드래그 경로는 O(범위 내 노트 수) + 연도별 정렬.
 *
 * The incoming sort is year → created_at → id (note_query YearAsc), not year → month → day, so
 * each year's notes are re-sorted by event date (compareWithinYear) and, at zoomLevel > "year",
 * re-bucketed by month (then day) in memory. The dataset here is already the bounded client-side
 * window (EXPANDED_BOARD_MAX_NOTES), so this is a handful of small in-memory sorts/partitions, not
 * a rescan of the corpus.
 */
export function flattenTimelineRows(input: FlattenTimelineRowsInput): TimelineRow[] {
  const { sortedNotes, yearFrom, yearTo, zoomLevel = "year", collapsedKeys } = input;

  const matchedNotes: NoteSummary[] = [];
  for (const note of sortedNotes) {
    if (note.year > yearTo) break;
    if (note.year >= yearFrom) matchedNotes.push(note);
  }

  if (matchedNotes.length === 0) {
    return [{ type: "empty" }];
  }

  const rows: TimelineRow[] = [];

  // Year buckets, preserving the input's ascending-year order (stable — matches old behaviour).
  const yearOrder: number[] = [];
  const byYear = new Map<number, NoteSummary[]>();
  for (const note of matchedNotes) {
    let bucket = byYear.get(note.year);
    if (!bucket) {
      bucket = [];
      byYear.set(note.year, bucket);
      yearOrder.push(note.year);
    }
    bucket.push(note);
  }

  for (const year of yearOrder) {
    // 서버 순서(year → created_at → id)를 사건 날짜순으로 한 번 정렬 — 아래 bucketBy 는 버킷 안의
    // 상대 순서를 그대로 두므로 이 한 번으로 연·월·일 줌이 모두 날짜순이 된다(2026-10-18 버그:
    // "2026.07" 아래 29·30·29·29·30·28·31·20일 — 생성 순서가 그대로 보였다).
    // byYear 의 버킷은 이 함수가 만든 배열이라 제자리 정렬해도 호출자 배열은 안 바뀐다.
    const yearNotes = byYear.get(year)!.sort(compareWithinYear);
    const yearKey = getTimelineHeaderKey(0, year);
    const isYearCollapsed = collapsedKeys?.has(yearKey) ?? false;
    pushHeader(rows, 0, year, null, null, yearNotes.length, isYearCollapsed);
    if (isYearCollapsed) {
      continue;
    }
    if (zoomLevel === "year") {
      for (const note of yearNotes) rows.push({ type: "note", note, depth: 0 });
      continue;
    }

    const byMonth = bucketBy(yearNotes, (n) => n.month);
    for (const [month, monthNotes] of byMonth) {
      const monthKey = getTimelineHeaderKey(1, year, month);
      const isMonthCollapsed = collapsedKeys?.has(monthKey) ?? false;
      pushHeader(rows, 1, year, month, null, monthNotes.length, isMonthCollapsed);
      if (isMonthCollapsed) {
        continue;
      }
      if (zoomLevel === "month" || month === null) {
        // month === null (unknown) is never split by day — day requires month. Either way the
        // deepest header actually shown above these notes is the depth-1 month header, so notes
        // indent to depth 1 (not the nominal zoomLevel depth) — see TimelineExpandedRow.
        for (const note of monthNotes) rows.push({ type: "note", note, depth: 1 });
        continue;
      }
      const byDay = bucketBy(monthNotes, (n) => n.day);
      for (const [day, dayNotes] of byDay) {
        const dayKey = getTimelineHeaderKey(2, year, month, day);
        const isDayCollapsed = collapsedKeys?.has(dayKey) ?? false;
        pushHeader(rows, 2, year, month, day, dayNotes.length, isDayCollapsed);
        if (isDayCollapsed) {
          continue;
        }
        for (const note of dayNotes) rows.push({ type: "note", note, depth: 2 });
      }
    }
  }

  return rows;
}

/**
 * react-window rowHeight 계산 함수.
 * 각 행 타입별 고정 높이를 반환하여 동적 계산 부담을 최소화한다. 헤더 높이는 depth 와
 * 무관하게 균일하다(§2.3: "기존 균일 행높이 가상화 리스트 구조를 그대로 쓴다") — 깊이는
 * 들여쓰기로만 표현한다.
 */
export function timelineRowHeightOf(row: TimelineRow): number {
  if (!row) return TIMELINE_NOTE_HEIGHT;
  if (row.type === "empty") return TIMELINE_EMPTY_HEIGHT;
  if (row.type === "header") {
    return row.leadingGap
      ? TIMELINE_HEADER_HEIGHT + TIMELINE_HEADER_LEADING_GAP
      : TIMELINE_HEADER_HEIGHT;
  }
  return TIMELINE_NOTE_HEIGHT;
}

/** Pixel offset of the top of `rows[index]` from the top of the flattened list (sum of every
 * preceding row's height) — used to translate a row index into a `scrollTop` and back. */
export function timelineRowOffset(rows: TimelineRow[], index: number): number {
  const end = Math.max(0, Math.min(index, rows.length));
  let sum = 0;
  for (let i = 0; i < end; i++) sum += timelineRowHeightOf(rows[i]!);
  return sum;
}

/** Inverse of `timelineRowOffset`: which row sits at a given pixel offset, plus how far into
 * that row's own height the offset falls (for sub-row anchoring precision). */
export function timelineRowIndexAtOffset(
  rows: TimelineRow[],
  offset: number,
): { index: number; offsetInRow: number } {
  let acc = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = timelineRowHeightOf(rows[i]!);
    if (offset < acc + h) return { index: i, offsetInRow: offset - acc };
    acc += h;
  }
  return { index: Math.max(0, rows.length - 1), offsetInRow: 0 };
}

/**
 * Cursor-anchored zoom support: given the row under the cursor *before* a zoom-level change
 * (`oldRows`/`oldIndex`), find the row that best represents the same date bucket in the
 * rebuilt `newRows` array — the anchor point `scrollTop` gets recomputed against.
 *
 * - A note row anchors on the same note (matched by id) if it's still present.
 * - A header row anchors on the same (year, month, day) bucket if it still exists at that exact
 *   granularity, else falls back to the same (year, month) bucket, else the same year — this is
 *   what lets zooming out (day → month → year) land on the surviving ancestor header instead of
 *   snapping to the top of the list.
 */
export function findTimelineAnchorRowIndex(
  oldRows: TimelineRow[],
  oldIndex: number,
  newRows: TimelineRow[],
): number {
  const oldRow = oldRows[oldIndex];
  if (!oldRow || newRows.length === 0) return 0;

  if (oldRow.type === "note") {
    const idx = newRows.findIndex((r) => r.type === "note" && r.note.id === oldRow.note.id);
    return idx !== -1 ? idx : 0;
  }

  if (oldRow.type === "header") {
    const { year, month, day } = oldRow;
    let idx = newRows.findIndex(
      (r) => r.type === "header" && r.year === year && r.month === month && r.day === day,
    );
    if (idx !== -1) return idx;
    if (month !== null) {
      idx = newRows.findIndex((r) => r.type === "header" && r.year === year && r.month === month);
      if (idx !== -1) return idx;
    }
    idx = newRows.findIndex((r) => r.type === "header" && r.year === year);
    if (idx !== -1) return idx;
  }

  return 0;
}

/**
 * Row indices of note rows whose id is in `hitIds`.
 *
 * Callers pass the server FTS result set (`useSearchStore.searchResults` ids) — same source
 * the dashboard brush uses. No title-substring path: body matches that FTS finds are included,
 * and title-only client mismatches against FTS are gone.
 *
 * Cap: `search_notes` returns at most 500 hits server-side (stores/search.ts::recomputeKeyword);
 * ticks under-mark past that ceiling. Acceptable for a jump rail, not a hard filter.
 */
export function collectTimelineHitRowIndices(
  rows: TimelineRow[],
  hitIds: ReadonlySet<string>,
): number[] {
  if (hitIds.size === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.type !== "note") continue;
    if (hitIds.has(row.note.id)) out.push(i);
  }
  return out;
}

export type SearchHitTick = {
  /** Bucket index in `[0, bucketCount)`. */
  bucket: number;
  /** First matching row/offset index that landed in this bucket (scroll / year target). */
  rowIndex: number;
  /** True when exactly one hit landed in this bucket (sidebar can select that note). */
  unique: boolean;
};

/**
 * Collapse hit row indices into at most `bucketCount` ticks for a fixed-height strip.
 * Positions are proportional to index / (rowCount - 1) so they track the list scroll range.
 * Also used by the dashboard brush: year-offsets + fullSpan as the linear domain.
 */
export function bucketSearchHitTicks(
  hitIndices: number[],
  rowCount: number,
  bucketCount: number = SEARCH_HIT_TICK_BUCKETS,
): SearchHitTick[] {
  if (hitIndices.length === 0 || rowCount <= 0 || bucketCount <= 0) return [];

  const firstInBucket = new Map<number, number>();
  const countInBucket = new Map<number, number>();
  const denom = Math.max(1, rowCount - 1);

  for (const idx of hitIndices) {
    if (idx < 0 || idx >= rowCount) continue;
    // Proportional slot, then clamp into [0, bucketCount).
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((idx / denom) * bucketCount)),
    );
    if (!firstInBucket.has(bucket)) {
      firstInBucket.set(bucket, idx);
    }
    countInBucket.set(bucket, (countInBucket.get(bucket) ?? 0) + 1);
  }

  return Array.from(firstInBucket.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, rowIndex]) => ({
      bucket,
      rowIndex,
      unique: (countInBucket.get(bucket) ?? 0) === 1,
    }));
}

/**
 * Year range covered by a search-hit tick bucket along `[fullFrom, fullTo]`.
 * Brush click zooms/brackets the view to this range (not open-note — a tick compresses
 * up to many notes into one of ≤128 buckets).
 */
export function hitTickBucketYearRange(
  bucket: number,
  fullFrom: number,
  fullTo: number,
  bucketCount: number = SEARCH_HIT_TICK_BUCKETS,
): { from: number; to: number } {
  const fullSpan = fullTo - fullFrom;
  if (!(fullSpan > 0) || bucketCount <= 0) return { from: fullFrom, to: fullTo };
  const b = Math.min(bucketCount - 1, Math.max(0, bucket));
  const from = fullFrom + (b / bucketCount) * fullSpan;
  const to = fullFrom + ((b + 1) / bucketCount) * fullSpan;
  return { from, to };
}
