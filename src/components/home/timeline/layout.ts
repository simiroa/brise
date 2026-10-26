/**
 * Home timeline layout — pure geometry (no DOM / no chart libs).
 *
 * Spec: docs/DASHBOARD.md §3.4.
 *
 * ── 2026-08-09 (owner decision): SINGLE CANVAS — folder swimlanes REVERSED ──────────────────────
 * The "primary axis is FOLDER, one lane per folder" model (Wave "folder swimlanes", 2026-08-01,
 * kept below as history) is reversed. All items now pack into ONE row's sub-rows — no per-folder
 * lane, no MAX_LANES cap, no "기타" overflow lane, no lane label gutter (ItemsLayer's LaneGutter
 * is deleted). Folders are still visually distinguished, but by PAINT COLOR (bar fill/border,
 * point dot — see TimelineTab.tsx's `folderColor` and ItemsLayer.tsx), not by vertical position.
 * Rationale: a lane stack that grows with folder count (and picks a somewhat arbitrary cutoff for
 * which folders "earn" a lane vs. get merged into 기타) is a worse fit than one timeline where
 * color alone answers "which folder is this."
 *
 * What survives unchanged: `assignItemLanes`'s greedy sub-row packer (point 2 below) — it already
 * took a `lane` index to place items into, so the single-canvas caller now just assigns every item
 * lane 0; the overlap-avoidance math inside it is untouched, no new packer was written.
 * `assignFolderLanes` / `resolveLaneIndex` / `LaneMeta` / `OTHER_LANE_KEY` / `MAX_LANES` /
 * `laneIndexAtY` (the folder-ranking / lane-lookup plumbing) are deleted outright — nothing
 * downstream needs to resolve "which lane does this folder get" anymore, and `laneGeometry` no
 * longer takes a `laneCount` (it is always exactly one row).
 *
 * Historical numbered list (2026-08-01 → 2026-08-09) — point 1 is superseded, points 2-6 are
 * still current as written (only "folder lane" reads as "the row" now):
 *
 * 1. ~~MAX_LANES caps vertical growth. `assignFolderLanes` shows the top (MAX_LANES-1) folders by
 *    note count and merges the rest into one "기타" lane — never more than MAX_LANES rows.
 *    Display order (2026-08-07, owner: "폴더 표시방식이 비합리적 … 폴더단위로 정리"): which
 *    folders EARN a lane is still decided by count, but the shown lanes are ordered like the
 *    sidebar folder tree.~~ SUPERSEDED 2026-08-09 — there is exactly one row now; no cap, no
 *    ranking, no display order to keep in sync with the sidebar tree.
 * 2. Sub-lane packing (W8-h, owner: "기간이 겹치는 경우 라인구분"). Inside the (now single) row,
 *    *bars* are greedily packed into sub-rows so two overlapping periods never sit on top of each
 *    other. *Points*: never share a sub-row with a bar that covers the point's startYear
 *    (2026-08-09 owner reversal — a point painted on top of a bar's label was an accepted
 *    tradeoff, no longer is); a point's sub-lane search skips any bar-occupied row first.
 *    Same-START points (and nearby points whose labels would collide within LABEL_MIN_GAP_PX, QA 4 C-3)
 *    stack downward into the next *available* (bar-free) sub-rows (2026-08-07, owner: "같은날 일정끼리
 *    더 붙어서 아래로 나열").
 *    (2026-08-14 owner decision, QA 4 C-2): The earlier MAX_SUB_LANES=4 hard cap (which forced overflow items
 *    to pile onto the 4th row and overlap) is removed. Items now continuously stack downward into new
 *    sub-rows. The row height grows dynamically via `laneGeometry()` and the canvas scrolls via
 *    `overflow: auto`. The canvas-wide mini-histogram (LANE_DENSE_THRESHOLD in TimelineTab.tsx)
 *    remains the escape valve for genuine large-corpus density.
 * 3. Viewport culling (itemIntersectsView) is half-open in year space: end < viewFrom or
 *    start > viewTo → culled. Bars that straddle the edge stay (clipped in paint).
 * 4. Axis/grid tick density (tickStepForView) floors out at the widest step in TICK_STEPS (500y)
 *    — beyond that span, labels may crowd rather than grow a 7th step. Ceiling: extend
 *    TICK_STEPS if multi-millennial corpora become common.
 * 5. tickStepForSpan and tickStepForView MUST pick from the same TICK_STEPS ladder (year down
 *    through month/week/day) so the width-independent heuristic and the px-spacing rule never
 *    drift apart. yearTicks calendar-aligns sub-year steps; do not invent a second ladder.
 * 5b. W8-h two-tier ticks (owner: "스크린샷 정도의 확대배율에도 월 단위로 촘촘해보여야"). The
 *    LABEL step (tickStepForView, AXIS_TICK_MIN_PX) only says how coarse the *text* may be; the
 *    next finer rung of the same ladder is drawn as unlabeled MINOR gridlines whenever it still
 *    clears MINOR_TICK_MIN_PX (minorTickStepForView). So a ~2.5y window shows year labels with
 *    month gridlines between them instead of a bare year-only axis.
 * 6. W8-e: the tick step is also the SNAP granularity for every canvas gesture (see
 *    snapYearToStep / startDateAtBoundary / endDateBeforeBoundary near the bottom of this file).
 *    Boundary↔date conversion round-trips exactly through precisionRange, which is what makes a
 *    committed note repaint where its ghost was drawn — if you change one side, change both and
 *    keep the round-trip test in layout.test.ts green. W8-h: the gesture snap step is the MINOR
 *    step when one exists (else the label step) — you snap to what you can see.
 *
 * Sub-year domain (Wave 5 L5-2): the axis is a CONTINUOUS fractional year
 * (year + dayOfYear/daysInYear). yearToX/xToYear stay the same. Precision semantics:
 *   - month/day null ⇒ covers the WHOLE year (bar from year start → next year start)
 *   - year+month, day null ⇒ covers the whole month
 *   - full day precision ⇒ point at that day (or bar when end_* expands it)
 * Capped mode stays year-granular (server buckets by year only) — callers force step ≥ 1.
 *
 * VERTICAL ANCHOR RULE (dashboard QA fix — "items all looked stuck to the floor"):
 * Both render modes anchor to the SAME top edge (`LANE_TOP_PAD`), never to the bottom of the
 * canvas (the axis itself also moved to the top — see AXIS_HEIGHT — so "the floor" isn't even
 * where the axis lives anymore).
 *   - Normal mode: the one row starts at `LANE_TOP_PAD` from the canvas top. Since it has a
 *     variable height (sub-lane packing, rule #2), the row top comes from `laneGeometry().tops[0]`
 *     and an item sits at `top + subLane * SUB_LANE_PITCH` (see ItemsLayer.tsx). Points/bars/labels
 *     all key off that same `top`, never `bottom`.
 *   - Capped/demoted mode (year-bucket histogram): the density mark per bucket used to grow UP
 *     from the bottom axis (`bottom: AXIS_HEIGHT + …`), which is what produced the "everything
 *     hugs the floor" look once a real item row wasn't there to contrast it against.
 *     `BucketMark` now hangs its bar from the row's `top` instead, growing DOWNWARD with
 *     height/opacity ∝ count — same top reference as normal mode, so switching between the two
 *     capped/uncapped views doesn't jump the vertical baseline.
 * Do not reintroduce `bottom`-anchored item/bucket positioning — pin new geometry to
 * `LANE_TOP_PAD` (see the render-side assertion in TimelineTab.test.tsx that checks the row's
 * computed `top`).
 */

import type { TimelineNoteItem, TimelineYearBucket } from "../../../lib/commands.gen";
import { daysInMonth, isLeapYear } from "../../../lib/dateUtils";
import { padYearRange } from "../../../lib/yearRangePad";

export { daysInMonth, isLeapYear };

/** Minimum row height for each lane (px). A lane with ≤1 sub-lane is exactly this tall. */
export const LANE_HEIGHT = 44;
/** Axis strip height (px) — the axis lives at the TOP of the canvas (dashboard QA fix: it used
 *  to sit at the bottom, invisible until a tall/scrolled canvas was scrolled all the way down —
 *  see Axis.tsx). */
export const AXIS_HEIGHT = 28;
/** Top inset for era name labels / the item row — AXIS_HEIGHT (room for the axis strip) plus the
 *  original 36px label band, so era names land in their own reserved strip right below the axis
 *  and never overlap the axis text. */
export const LANE_TOP_PAD = AXIS_HEIGHT + 36;
/** Minimum painted bar width (px) so short periods stay clickable. */
export const BAR_MIN_PX = 8;
/** Duration-bar pill height (px) — thicker than a point so bars read as the primary mark. */
export const BAR_HEIGHT = 22;
/** Point marker diameter (px). */
export const POINT_SIZE = 9;
/** Vertical pitch between two sub-lanes inside the row (px) — a bar plus its gap. */
export const SUB_LANE_PITCH = BAR_HEIGHT + 6;
/** Padding a lane keeps below its last sub-lane. Chosen so a 1-sub-lane row is exactly
 *  LANE_HEIGHT tall (the pre-W8-h geometry), which is what keeps every existing `top` assertion
 *  and the gutter/bucket chrome unchanged for non-overlapping folders. */
export const LANE_SUB_PAD = LANE_HEIGHT - SUB_LANE_PITCH;
/** Sub-lane runaway safeguard cap — see assignItemLanes (QA 4 C-2: earlier MAX_SUB_LANES=4 hard cap removed so items stack downward without overlap). */
export const MAX_SUB_LANES = 1000;
/**
 * Minimum view span in years. Spec §3.4 was "10y↔1y"; Wave 5 L5-2 rescales the floor so a
 * ~1-week window can show day ticks (owner: year-only axis was unreadable at that range).
 * Still enforced by clampView / brush / wheel — never delete the clamp (prior "-241 — 2075"
 * regression when zoom was unclamped).
 */
export const MIN_VIEW_SPAN = 1 / 365;
/** Hide item labels when average px-per-year drops below this (hover title still works). */
export const LABEL_MIN_PX_PER_YEAR = 6;
/** Hide a POINT label outright when its gap to the next item in the same (lane, subLane) row
 *  drops below this many px — same convention as LABEL_MIN_PX_PER_YEAR (hover title still
 *  carries the text). See pointLabelMaxWidth. */
export const LABEL_MIN_GAP_PX = 40;
/** Breathing room subtracted from a point label's clamped max width (px) — see pointLabelMaxWidth. */
export const LABEL_GAP_PAD_PX = 8;

export type PackedItem = {
  noteId: string;
  title: string;
  kind: "point" | "bar";
  /** Continuous fractional year (year + dayOfYear/daysInYear). */
  startYear: number;
  endYear: number;
  /** Still carried per item (paint color derives from it — see TimelineTab's `folderColor`), but
   *  no longer decides vertical position (2026-08-09, file header — single canvas). */
  folderId: string;
  /** Always 0 (single canvas, 2026-08-09) — kept as a field so laneGeometry/ItemsLayer's `top`
   *  math didn't need to change shape, not because more than one lane can exist. */
  lane: number;
  /** Row inside the canvas (0-based) — see assignItemLanes / laneGeometry. */
  subLane: number;
  /** Coarsest calendar unit the note actually stores (start ∪ end). Drag-to-move clamps its shift
   *  to this so moving a year-only note on a month axis can't silently invent a month. */
  precision: SnapUnit;
};

export type YearRange = { from: number; to: number };

// ── Fractional-year domain ────────────────────────────────────────────────────

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}
export function dayOfYear(year: number, month1: number, day: number): number {
  const m = Math.min(12, Math.max(1, Math.round(month1)));
  const dim = daysInMonth(year, m);
  const d = Math.min(dim, Math.max(1, Math.round(day)));
  let n = d;
  for (let i = 1; i < m; i++) n += daysInMonth(year, i);
  return n;
}

/**
 * Continuous axis coordinate for the start of a calendar day:
 *   year + (dayOfYear - 1) / daysInYear
 * Jan 1 → year + 0; Dec 31 non-leap → year + 364/365.
 */
export function dateToFractionalYear(year: number, month1: number, day: number): number {
  const y = Math.trunc(year);
  const diy = daysInYear(y);
  return y + (dayOfYear(y, month1, day) - 1) / diy;
}

/** Inverse of dateToFractionalYear (start-of-day). */
export function fractionalYearToDate(frac: number): { year: number; month: number; day: number } {
  const year = Math.floor(frac);
  const diy = daysInYear(year);
  // Map [0,1) → day index 0..diy-1; clamp so 1.0-ε still lands on Dec 31.
  const dayIndex = Math.min(diy - 1, Math.max(0, Math.floor((frac - year) * diy + 1e-9)));
  let remaining = dayIndex + 1; // 1-based day-of-year
  for (let m = 1; m <= 12; m++) {
    const dim = daysInMonth(year, m);
    if (remaining <= dim) return { year, month: m, day: remaining };
    remaining -= dim;
  }
  return { year, month: 12, day: 31 };
}

/**
 * Half-open [start, end) fractional range for a year/month/day triple.
 * Null month ⇒ whole year; null day (with month) ⇒ whole month; full triple ⇒ that whole day.
 *
 * W8-e: the full-triple case used to return a ZERO-length interval (end === start), so a note
 * ending on 8/5 painted only through the start of 8/5 — a 5-day event drew 4 days wide and the
 * owner "couldn't judge how long a schedule was". All three precisions are now genuinely
 * half-open, which is what this function's contract always claimed, and it makes
 * endDateBeforeBoundary's "the unit before the boundary" rule uniform across year/month/day.
 * A *start-only* day note is still a point — that promotion lives in itemTimeRange, not here.
 */
export function precisionRange(
  year: number,
  month: number | null | undefined,
  day: number | null | undefined,
): { start: number; end: number } {
  if (month == null) {
    return { start: year, end: year + 1 };
  }
  if (day == null) {
    const start = dateToFractionalYear(year, month, 1);
    const nextMonth = month >= 12 ? 1 : month + 1;
    const nextYear = month >= 12 ? year + 1 : year;
    const end = dateToFractionalYear(nextYear, nextMonth, 1);
    return { start, end };
  }
  const start = dateToFractionalYear(year, month, day);
  const nx = addCalendarDays(year, month, day, 1);
  return { start, end: dateToFractionalYear(nx.y, nx.m, nx.d) };
}

/**
 * Item time range on the continuous axis. Incomplete start precision expands to cover the
 * ambiguous interval (year-only → full year bar; month-only → full month bar) so we never snap
 * a coarse date to Jan 1 as a false point. When end_* is set, the bar runs from the start of
 * the start-precision interval through the end of the end-precision interval.
 */
export function itemTimeRange(
  it: Pick<
    TimelineNoteItem,
    "year" | "month" | "day" | "end_year" | "end_month" | "end_day" | "kind"
  >,
): { start: number; end: number; kind: "point" | "bar" } {
  const startR = precisionRange(it.year, it.month, it.day);
  if (it.end_year != null) {
    const endR = precisionRange(it.end_year, it.end_month, it.end_day);
    const start = startR.start;
    const end = Math.max(endR.end, start);
    return { start, end, kind: end > start ? "bar" : "point" };
  }
  // No end_*: full day precision → point; coarser precision → bar covering the ambiguity.
  if (it.month != null && it.day != null) {
    return { start: startR.start, end: startR.start, kind: "point" };
  }
  return { start: startR.start, end: startR.end, kind: "bar" };
}

/** Bars whose ends touch (a.end === b.start) may share a sub-lane — float slack only. */
const SUB_LANE_EPS = 1e-9;

/** Coarsest calendar unit a note actually carries across start AND end (see PackedItem.precision). */
function itemPrecision(
  it: Pick<TimelineNoteItem, "month" | "day" | "end_year" | "end_month" | "end_day">,
): SnapUnit {
  const start: SnapUnit = it.month == null ? "year" : it.day == null ? "month" : "day";
  if (it.end_year == null) return start;
  const end: SnapUnit = it.end_month == null ? "year" : it.end_day == null ? "month" : "day";
  return coarserUnit(start, end);
}

/**
 * Position every item on the single canvas row (`lane: 0` — 2026-08-09, file header), then split
 * overlapping *bars* into sub-lanes (file header #2). Greedy first-fit over bars sorted by start:
 * a bar takes the first sub-lane whose last bar already ended. Points then search for a sub-lane
 * no bar occupies at their own startYear (2026-08-09 — a point must never paint over a covering
 * bar); points sharing the SAME start or nearby points whose labels would collide within
 * LABEL_MIN_GAP_PX (QA 4 C-3) stack downward into the next *available* sub-rows found that way
 * (2026-08-07 — same-day schedules read as a vertical cluster instead of one dot); points
 * on different days stay on sub-lane 0 unless a bar covers that day or a label collision occurs.
 *
 * ponytail (2026-08-14 owner decision, QA 4 C-2 — earlier decision reversed): The previous MAX_SUB_LANES=4
 * hard cap caused overlapping text on the 4th sub-lane. The hard cap is removed so items stack
 * continuously downward without piling on top of each other. The row has a variable height computed by
 * laneGeometry() and the canvas container scrolls via overflow: auto. The client-side escape valve for
 * density remains LANE_DENSE_THRESHOLD = 50 (TimelineTab.tsx) which demotes dense datasets to a
 * year histogram. A large runaway safeguard (MAX_SUB_LANES = 1000) is kept purely to prevent infinite loops.
 */
export function assignItemLanes(
  items: TimelineNoteItem[],
  view: YearRange,
  width: number,
): PackedItem[] {
  const packed: PackedItem[] = items.map((it) => {
    const { start, end, kind } = itemTimeRange(it);
    return {
      noteId: it.note_id,
      title: it.title,
      kind,
      startYear: start,
      endYear: Math.max(end, start),
      folderId: it.folder_id,
      lane: 0,
      subLane: 0,
      precision: itemPrecision(it),
    };
  });

  // lane → per-sub-lane "last endYear so far". Mutating `packed`'s entries through this sorted
  // view is intentional: the returned array keeps the caller's original item order.
  const tails = new Map<number, number[]>();
  const bars = packed
    .filter((p) => p.kind === "bar")
    .sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  for (const bar of bars) {
    let ends = tails.get(bar.lane);
    if (!ends) {
      ends = [];
      tails.set(bar.lane, ends);
    }
    let slot = ends.findIndex((end) => end <= bar.startYear + SUB_LANE_EPS);
    if (slot < 0) {
      slot = ends.length < MAX_SUB_LANES ? ends.length : MAX_SUB_LANES - 1;
    }
    ends[slot] = Math.max(ends[slot] ?? -Infinity, bar.endYear);
    bar.subLane = slot;
  }

  // lane → every bar's [subLane, startYear, endYear), for the point placement pass below — a
  // point must skip any sub-lane a bar occupies at the point's own startYear (2026-08-09, owner
  // reversal of the earlier "point drawn over a bar" tradeoff). `tails`'s final state only keeps
  // the LAST bar assigned per slot, not the full history, so this is a separate index.
  const barsByLane = new Map<number, { subLane: number; startYear: number; endYear: number }[]>();
  for (const bar of bars) {
    let list = barsByLane.get(bar.lane);
    if (!list) {
      list = [];
      barsByLane.set(bar.lane, list);
    }
    list.push({ subLane: bar.subLane, startYear: bar.startYear, endYear: bar.endYear });
  }
  const subLaneCoveredByBar = (lane: number, subLane: number, startYear: number): boolean => {
    const list = barsByLane.get(lane);
    if (!list) return false;
    return list.some(
      (b) => b.subLane === subLane && startYear >= b.startYear && startYear < b.endYear,
    );
  };

  // Point sub-lanes (file header #2, 2026-08-09 owner reversal, 2026-08-14 QA 4 C-2 & C-3):
  // Points search upward from the lowest candidate slot, skipping any sub-lane a bar covers at
  // this point's startYear, and skipping any sub-lane where an existing point/bar would cause a label
  // collision (within LABEL_MIN_GAP_PX). This stacks nearby points downward into distinct sub-rows
  // so every point retains its own visible label right beside its dot instead of being hidden into
  // a bare dot.
  const pointsBySubLane = new Map<string, { startYear: number; left: number }[]>();
  const points = packed
    .filter((p) => p.kind === "point")
    .sort((a, b) => a.startYear - b.startYear);

  const slotHasCollision = (lane: number, slot: number, p: PackedItem): boolean => {
    if (subLaneCoveredByBar(lane, slot, p.startYear)) return true;

    const placed = pointsBySubLane.get(`${lane}:${slot}`);
    const pLeft = yearToX(p.startYear, view.from, view.to, width);

    // Bar collision to the right (within LABEL_MIN_GAP_PX)
    const list = barsByLane.get(lane);
    if (list) {
      for (const b of list) {
        if (b.subLane === slot && b.startYear >= p.startYear) {
          const barLeft = yearToX(b.startYear, view.from, view.to, width);
          if (barLeft - pLeft < LABEL_MIN_GAP_PX) {
            return true;
          }
        }
      }
    }

    // Point collision (within LABEL_MIN_GAP_PX)
    if (placed) {
      for (const pt of placed) {
        if (Math.abs(pLeft - pt.left) < LABEL_MIN_GAP_PX) {
          return true;
        }
      }
    }
    return false;
  };

  for (const p of points) {
    let slot = 0;
    while (slot < MAX_SUB_LANES - 1 && slotHasCollision(p.lane, slot, p)) {
      slot += 1;
    }
    p.subLane = slot;
    const key = `${p.lane}:${slot}`;
    let list = pointsBySubLane.get(key);
    if (!list) {
      list = [];
      pointsBySubLane.set(key, list);
    }
    const pLeft = yearToX(p.startYear, view.from, view.to, width);
    list.push({ startYear: p.startYear, left: pLeft });
  }

  return packed;
}

export type LaneGeometry = {
  /** Canvas-absolute top edge of the row (px) — a 1-element array, kept as an array so callers
   *  that used to index by lane (`geo.tops[lane]`, always 0 now) didn't need to change shape. */
  tops: number[];
  /** Height of the row (px) — grows with its sub-lane count. */
  heights: number[];
  /** Bottom edge of the row (px) — the canvas's minimum content height. */
  totalHeight: number;
};

/**
 * The single row's top/height (single canvas, 2026-08-09 — file header). The one source of
 * vertical truth for every absolutely-positioned thing on the canvas — the background, buckets,
 * items, the ghost and the resize chip (VERTICAL ANCHOR RULE in the file header).
 */
export function laneGeometry(packed: PackedItem[]): LaneGeometry {
  let subCount = 1;
  for (const it of packed) subCount = Math.max(subCount, it.subLane + 1);
  const h = Math.max(LANE_HEIGHT, LANE_SUB_PAD + subCount * SUB_LANE_PITCH);
  return { tops: [LANE_TOP_PAD], heights: [h], totalHeight: LANE_TOP_PAD + h };
}

/** Per-start-year counts for a set of items — the client-side equivalent of the backend's
 *  bucket_items_by_folder_year, used to render a mini-histogram (TimelineTab's
 *  LANE_DENSE_THRESHOLD fallback) instead of individually-overlapping item marks. */
export function bucketByYear(items: { year: number }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const it of items) {
    // Floor fractional starts so dense-lane histograms stay year-granular.
    const y = Math.floor(it.year);
    counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  return counts;
}

export type TimelineBucket = {
  year: number;
  endYear: number;
  count: number;
};

/**
 * 기하학적 밀도 기반 dense 모드 판정:
 * 1) 가로 축 픽셀 밀도: 보이는 축 픽셀당 아이템 수가 0.25 (4px당 1개) 초과 시
 * 2) 세로 레인 과밀: 겹치는 아이템이 많아 sub-lane 수가 25개 초과 시
 */
export function isTimelineDense(
  visibleItems: PackedItem[],
  canvasW: number,
  subCount: number,
): boolean {
  if (visibleItems.length === 0) return false;
  const width = Math.max(1, canvasW);
  const itemsPerPx = visibleItems.length / width;
  if (itemsPerPx > 0.25) return true;
  if (subCount > 25) return true;
  return false;
}

/**
 * 눈금 단위(tickStep)에 맞춰 아이템들을 구간별로 묶는 버킷팅 함수 (Q12).
 * 정수 연도(step >= 1) 및 서브 연도(step < 1: 월/주 단위)를 모두 지원한다.
 */
export function bucketByStep(
  items: { startYear: number }[],
  step: number,
): TimelineBucket[] {
  const safeStep = Math.max(MIN_VIEW_SPAN, step);
  const counts = new Map<number, number>();
  // 월 눈금이면 달력의 달 경계로 묶는다 — 1년을 12등분한 같은 폭 칸은 달 경계와 어긋나 5월 1일 노트가
  // '4월' 칸에 들어갔다(2026-10-19 보드 재촬영). 묶음 끝도 다음 달 1일이다.
  const monthly = Math.abs(safeStep - 1 / 12) < 1e-6;
  const monthEnds = new Map<number, number>();

  for (const it of items) {
    let bucketStart: number;
    if (monthly) {
      const d = fractionalYearToDate(it.startYear);
      bucketStart = dateToFractionalYear(d.year, d.month, 1);
      const nextY = d.month === 12 ? d.year + 1 : d.year;
      const nextM = d.month === 12 ? 1 : d.month + 1;
      monthEnds.set(Math.round(bucketStart * 1e8) / 1e8, dateToFractionalYear(nextY, nextM, 1));
    } else if (safeStep >= 1) {
      bucketStart = Math.floor(it.startYear / safeStep) * safeStep;
    } else {
      const baseYear = Math.floor(it.startYear);
      const frac = it.startYear - baseYear;
      bucketStart = baseYear + Math.floor(frac / safeStep) * safeStep;
    }
    const key = Math.round(bucketStart * 1e8) / 1e8;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([start, count]) => {
      const endYear = Math.round((monthEnds.get(start) ?? start + safeStep) * 1e8) / 1e8;
      return {
        year: start,
        endYear,
        count,
      };
    })
    .sort((a, b) => a.year - b.year);
}

/**
 * 버킷 툴팁 표시용 라벨 포맷터
 */
export function formatBucketLabel(startYear: number, endYear: number): string {
  if (Number.isInteger(startYear) && Math.round((endYear - startYear) * 1e4) / 1e4 === 1) {
    return `${startYear}`;
  }
  // 칸 안의 첫날·마지막 날로 읽는다 — 경계값(다음 달 1일)을 그대로 바꾸면 반올림으로 전날이 되거나
  // 다음 칸의 달이 섞여 '2026-03 ~ 2026-04' 처럼 한 달짜리 칸이 두 달로 적혔다.
  const s = fractionalYearToDate(startYear + 1e-7);
  const e = fractionalYearToDate(endYear - 1e-7);
  if (s.year === e.year && s.month === e.month) {
    return `${s.year}-${String(s.month).padStart(2, "0")}`;
  }
  return `${s.year}-${String(s.month).padStart(2, "0")} ~ ${e.year}-${String(e.month).padStart(2, "0")}`;
}

/** True if [start, end] intersects [viewFrom, viewTo] (inclusive years). */
export function itemIntersectsView(
  startYear: number,
  endYear: number,
  viewFrom: number,
  viewTo: number,
): boolean {
  return endYear >= viewFrom && startYear <= viewTo;
}

export function yearToX(
  year: number,
  viewFrom: number,
  viewTo: number,
  width: number,
): number {
  const span = viewTo - viewFrom;
  if (!(span > 0) || !(width > 0)) return 0;
  return ((year - viewFrom) / span) * width;
}

export function xToYear(
  x: number,
  viewFrom: number,
  viewTo: number,
  width: number,
): number {
  const span = viewTo - viewFrom;
  if (!(span > 0) || !(width > 0)) return viewFrom;
  return viewFrom + (x / width) * span;
}

/** Sub-year + year tick steps, smallest → largest. tickStepForSpan and tickStepForView share
 *  this ladder (file header #5). Named aliases keep calendar-aligned yearTicks readable. */
export const TICK_STEP_DAY = 1 / 365;
export const TICK_STEP_WEEK = 7 / 365;
export const TICK_STEP_MONTH = 1 / 12;
export const TICK_STEPS = [
  TICK_STEP_DAY,
  TICK_STEP_WEEK,
  TICK_STEP_MONTH,
  1,
  5,
  10,
  50,
  100,
  500,
] as const;

/** Minimum pixel gap between adjacent axis tick LABELS before we widen the step. */
export const AXIS_TICK_MIN_PX = 60;
/** Minimum pixel gap between adjacent MINOR (unlabeled) gridlines before we drop them entirely.
 *  Far smaller than AXIS_TICK_MIN_PX because a hairline needs no room for text — it only has to
 *  stay readable as a grid rather than smearing into a solid fill. */
export const MINOR_TICK_MIN_PX = 7;

/** Nice tick step for a year span (axis + brush labels), independent of viewport width. */
export function tickStepForSpan(span: number): number {
  if (!(span > 0)) return TICK_STEPS[0];
  if (span > 2000) return 500;
  if (span > 400) return 100;
  if (span > 150) return 50;
  if (span > 60) return 10;
  if (span > 8) return 5;
  if (span > 1.5) return 1;
  if (span > 0.25) return TICK_STEP_MONTH;
  if (span > 14 / 365) return TICK_STEP_WEEK;
  return TICK_STEP_DAY;
}

/**
 * Zoom-adaptive tick step: the smallest step in TICK_STEPS whose resulting label spacing
 * (step × px-per-year) clears AXIS_TICK_MIN_PX, so axis/grid labels never overlap regardless of
 * viewport width. Falls back to the span-only heuristic when width is unusable (e.g. pre-layout).
 *
 * Tick density is deliberately WIDTH-dependent (owner: "해상도에 따라 다른가?" — yes, and on
 * purpose). The input is the canvas's CSS pixel width, not device pixels, so a HiDPI screen at the
 * same window size gets exactly the same ticks; a *wider window* legitimately earns finer ticks
 * because there is more room for them. Nothing here reads devicePixelRatio.
 */
export function tickStepForView(from: number, to: number, width: number): number {
  const span = to - from;
  if (!(span > 0) || !(width > 0)) return tickStepForSpan(span);
  const pxPerYear = width / span;
  for (const step of TICK_STEPS) {
    if (step * pxPerYear >= AXIS_TICK_MIN_PX) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * The unlabeled second tier (file header #5b): the rung of TICK_STEPS just below the label step,
 * or null when even that would smear (< MINOR_TICK_MIN_PX) or the label step is already the
 * finest rung. Calendar alignment is `yearTicks`' job, same as for labeled ticks.
 */
export function minorTickStepForView(from: number, to: number, width: number): number | null {
  const span = to - from;
  if (!(span > 0) || !(width > 0)) return null;
  const label = tickStepForView(from, to, width);
  const i = TICK_STEPS.indexOf(label);
  if (i <= 0) return null;
  const finer = TICK_STEPS[i - 1]!;
  return finer * (width / span) >= MINOR_TICK_MIN_PX ? finer : null;
}

const STEP_EPS = 1e-9;

/** Inclusive ticks from first boundary ≥ from through ≤ to. Sub-year steps are calendar-aligned
 *  (month starts / day starts); year steps keep the classic step-multiple alignment. */
export function yearTicks(from: number, to: number, step?: number): number[] {
  const s = step ?? tickStepForSpan(to - from);
  if (!(s > 0) || !(to >= from)) return [];

  if (s < TICK_STEP_MONTH - STEP_EPS) {
    // Day or week: walk calendar days (week = every 7th day from the first in-range day).
    const dayStride = s <= TICK_STEP_DAY + STEP_EPS ? 1 : 7;
    return calendarDayTicks(from, to, dayStride);
  }
  if (s < 1 - STEP_EPS) {
    return calendarMonthTicks(from, to);
  }

  // Integer-year steps (1, 5, 10, …).
  const start = Math.ceil(from / s) * s;
  const out: number[] = [];
  // Guard against float drift on large ranges.
  for (let y = start; y <= to + STEP_EPS; y = Math.round((y + s) * 1e9) / 1e9) {
    out.push(y);
    if (out.length > 20_000) break;
  }
  return out;
}

function calendarMonthTicks(from: number, to: number): number[] {
  let y = Math.floor(from);
  let m = 1;
  // Advance to first month-start ≥ from.
  while (dateToFractionalYear(y, m, 1) < from - STEP_EPS) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const out: number[] = [];
  while (true) {
    const t = dateToFractionalYear(y, m, 1);
    if (t > to + STEP_EPS) break;
    out.push(t);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 20_000) break;
  }
  return out;
}

function calendarDayTicks(from: number, to: number, dayStride: number): number[] {
  const startParts = fractionalYearToDate(from);
  // If `from` is mid-day, start at that calendar day; if exact next-day boundary, fractional
  // inverse already floors into the previous day — advance when the day-start is still < from.
  let y = startParts.year;
  let m = startParts.month;
  let d = startParts.day;
  let t = dateToFractionalYear(y, m, d);
  if (t < from - STEP_EPS) {
    ({ y, m, d } = addCalendarDays(y, m, d, 1));
    t = dateToFractionalYear(y, m, d);
  }
  const out: number[] = [];
  let strideLeft = 0; // emit first day, then every dayStride
  while (t <= to + STEP_EPS) {
    if (strideLeft === 0) {
      out.push(t);
      strideLeft = dayStride;
      if (out.length > 20_000) break;
    }
    ({ y, m, d } = addCalendarDays(y, m, d, 1));
    t = dateToFractionalYear(y, m, d);
    strideLeft -= 1;
  }
  return out;
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { y: number; m: number; d: number } {
  // UTC noon avoids DST edge cases; we only need civil Y-M-D arithmetic.
  const dt = new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// ── Snapping + boundary↔date conversion (W8-e: drag-create ghost, bar-edge resize, hover) ────
//
// One rule for every gesture on this canvas: a pointer x maps to the nearest *calendar boundary*
// at the axis's current granularity (year / month start / day start), and that boundary is what
// the ghost, the resize preview, the hover guide and the committed note all use. Keeping the
// snap in one pure function is what stops those four from drifting apart — the old code snapped
// with a bare Math.round() (year-only), which is why sub-year drags "couldn't be judged" and why
// hover feedback only ever appeared on year ticks.

/** Calendar unit implied by an axis tick step. */
export type SnapUnit = "year" | "month" | "day";

export function snapUnitForStep(step: number): SnapUnit {
  if (step >= 1 - STEP_EPS) return "year";
  if (step >= TICK_STEP_MONTH - STEP_EPS) return "month";
  return "day";
}

/** Nearer of two candidates to `frac`. */
function nearer(frac: number, a: number, b: number): number {
  return Math.abs(frac - a) <= Math.abs(b - frac) ? a : b;
}

/**
 * Snap a fractional year to the nearest calendar boundary at the step's granularity.
 * Note this snaps to the *unit* (year / month / day), not to a multiple of the step: a 5y axis
 * still lets you land on 1593, because the step only says how coarse the labels are, not how
 * coarse a date may be.
 */
export function snapYearToStep(frac: number, step: number): number {
  const unit = snapUnitForStep(step);
  if (unit === "year") return Math.round(frac);
  const p = fractionalYearToDate(frac);
  if (unit === "month") {
    const lo = dateToFractionalYear(p.year, p.month, 1);
    const nextM = p.month >= 12 ? 1 : p.month + 1;
    const nextY = p.month >= 12 ? p.year + 1 : p.year;
    return nearer(frac, lo, dateToFractionalYear(nextY, nextM, 1));
  }
  const lo = dateToFractionalYear(p.year, p.month, p.day);
  const nx = addCalendarDays(p.year, p.month, p.day, 1);
  return nearer(frac, lo, dateToFractionalYear(nx.y, nx.m, nx.d));
}

/** Nearest rendered tick to `frac` (hover feedback), or null when there are no ticks. */
export function nearestTick(ticks: number[], frac: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const t of ticks) {
    const d = Math.abs(t - frac);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** year / year+month / year+month+day, i.e. the three precisions the note commands accept. */
export type DateTriple = { year: number; month: number | null; day: number | null };

/**
 * Start-side date for a snapped boundary: the triple whose `precisionRange().start` IS that
 * boundary. Round-trips exactly, so a committed note repaints where its ghost was.
 */
export function startDateAtBoundary(frac: number, step: number): DateTriple {
  const b = snapYearToStep(frac, step);
  const unit = snapUnitForStep(step);
  if (unit === "year") return { year: Math.round(b), month: null, day: null };
  const p = fractionalYearToDate(b);
  return unit === "month"
    ? { year: p.year, month: p.month, day: null }
    : { year: p.year, month: p.month, day: p.day };
}

/**
 * End-side date for a snapped boundary: the triple whose `precisionRange().end` IS that boundary
 * — i.e. the last unit *inside* the range (the year / month / day just before it). Same
 * round-trip guarantee as startDateAtBoundary, so a bar repaints exactly where its ghost was and
 * the range chip shows the dates the note actually carries.
 */
export function endDateBeforeBoundary(frac: number, step: number): DateTriple {
  const b = snapYearToStep(frac, step);
  const unit = snapUnitForStep(step);
  if (unit === "year") return { year: Math.round(b) - 1, month: null, day: null };
  const p = fractionalYearToDate(b);
  if (unit === "month") {
    const prevM = p.month <= 1 ? 12 : p.month - 1;
    const prevY = p.month <= 1 ? p.year - 1 : p.year;
    return { year: prevY, month: prevM, day: null };
  }
  const pv = addCalendarDays(p.year, p.month, p.day, -1);
  return { year: pv.y, month: pv.m, day: pv.d };
}

/** Axis coordinate of a triple's interval start — inverse of startDateAtBoundary. */
export function tripleToFraction(tri: DateTriple): number {
  return precisionRange(tri.year, tri.month, tri.day).start;
}

// ── Drag-to-move (W8-h, owner: "드래그로 일정 조정도 편하게") ───────────────────────────────
//
// Moving a note is a *whole number of calendar units* shift applied identically to its start and
// its end, which is what preserves the duration exactly (a 3-month period stays 3 months, not
// 91.31 fractional-year days). The unit is the axis snap unit, clamped to the note's own stored
// precision so dragging a year-only note on a month axis moves it by whole years instead of
// inventing a February it never had.

const UNIT_RANK: Record<SnapUnit, number> = { year: 0, month: 1, day: 2 };

/** The coarser of two calendar units (year ≺ month ≺ day). */
export function coarserUnit(a: SnapUnit, b: SnapUnit): SnapUnit {
  return UNIT_RANK[a] <= UNIT_RANK[b] ? a : b;
}

/** Mean Gregorian month/year lengths — only used to re-express a shift at a coarser unit. */
const DAYS_PER_YEAR_AVG = 365.2425;
const DAYS_PER_MONTH_AVG = DAYS_PER_YEAR_AVG / 12;

function convertUnits(n: number, from: SnapUnit, to: SnapUnit): number {
  if (from === to) return n;
  if (from === "day") return Math.round(n / (to === "month" ? DAYS_PER_MONTH_AVG : DAYS_PER_YEAR_AVG));
  return Math.round(n / 12); // month → year
}

/**
 * Shift a stored date triple by `n` units, PRESERVING its precision. If `unit` is finer than the
 * triple carries, the shift is re-expressed at the triple's own coarsest unit (rounded) rather
 * than promoting a year-only note to a month/day one. Month arithmetic clamps the day into the
 * target month (Jan 31 + 1 month → Feb 28/29), the same rule a calendar app uses.
 */
export function shiftTriple(tri: DateTriple, unit: SnapUnit, n: number): DateTriple {
  if (!n) return tri;
  const own: SnapUnit = tri.month == null ? "year" : tri.day == null ? "month" : "day";
  const eff = coarserUnit(unit, own);
  const k = convertUnits(n, unit, eff);
  if (!k) return tri;
  if (eff === "year") return { ...tri, year: tri.year + k };
  if (eff === "month") {
    const total = tri.year * 12 + (tri.month! - 1) + k;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    return { year, month, day: tri.day == null ? null : Math.min(tri.day, daysInMonth(year, month)) };
  }
  const nx = addCalendarDays(tri.year, tri.month!, tri.day!, k);
  return { year: nx.y, month: nx.m, day: nx.d };
}

/** Whole calendar units from one axis coordinate to another (both expected already snapped).
 *  ponytail: the day branch reuses Date.UTC's civil arithmetic and therefore inherits its
 *  two-digit-year quirk (years 0–99 read as 1900+y) — harmless for a *difference* unless the two
 *  ends straddle year 100. Swap in setUTCFullYear if an ancient corpus ever drags at day scale. */
export function unitsBetween(from: number, to: number, unit: SnapUnit): number {
  if (unit === "year") return Math.round(to) - Math.round(from);
  const a = fractionalYearToDate(from);
  const b = fractionalYearToDate(to);
  if (unit === "month") return (b.year - a.year) * 12 + (b.month - a.month);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** Same shift, expressed on the continuous axis — what the move preview paints. */
export function shiftFraction(frac: number, unit: SnapUnit, n: number): number {
  if (!n) return frac;
  const p = fractionalYearToDate(frac);
  return tripleToFraction(shiftTriple({ year: p.year, month: p.month, day: p.day }, unit, n));
}

// ── Fit-to-content viewport (W8-e item 3) ────────────────────────────────────────────────────

/** Fraction of the fitted span added as breathing room on each side. */
export const FIT_PAD = 0.12;
/**
 * Floor on a fitted span (years). Owner's calibration: "a note holding about a week should land
 * in a view showing about 2 months" — 1/6 y ≈ 2 months. Without this a single short note would
 * fit to a few days and every neighbouring note would be off-screen.
 */
export const FIT_MIN_SPAN = 1 / 6;

/**
 * Frame the notes that actually exist instead of the whole corpus axis.
 * Returns null for an empty payload so the caller can fall back to defaultTimelineView.
 *
 * ponytail: plain bbox of every item. One 3rd-century outlier in an otherwise-2026 notebook
 * still blows the window open. Upgrade path when that shows up in a real notebook: fit to an
 * inter-percentile range (e.g. p5–p95 of item midpoints) instead of min/max — same signature,
 * the callers and tests do not move.
 */
export function fitViewToItems(
  ranges: { startYear: number; endYear: number }[],
  full: YearRange,
): YearRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const r of ranges) {
    if (!Number.isFinite(r.startYear) || !Number.isFinite(r.endYear)) continue;
    min = Math.min(min, r.startYear);
    max = Math.max(max, r.endYear);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const center = (min + max) / 2;
  const span = Math.max(FIT_MIN_SPAN, (max - min) * (1 + 2 * FIT_PAD));
  return clampView(center - span / 2, center + span / 2, full.from, full.to);
}

/**
 * Timeline tab's own default *view window* (not the sidebar year filter).
 * System clock year ± 1 — intentionally independent of `useSearchStore.yearFrom/yearTo`,
 * which remain the full corpus bounds for note-tree filtering and search_notes until the
 * user narrows them elsewhere. Callers must clamp into the corpus full range via clampView.
 */
export function defaultTimelineView(nowYear: number = new Date().getFullYear()): YearRange {
  return { from: nowYear - 1, to: nowYear + 1 };
}

/** True when the global/sidebar year filter is narrower than its corpus bounds. */
export function isYearFilterNarrowed(
  yearFrom: number,
  yearTo: number,
  yearBounds: { min: number; max: number },
): boolean {
  return yearFrom > yearBounds.min || yearTo < yearBounds.max;
}

/**
 * Resolve the Timeline tab view window, in priority order:
 *   1. an already-narrowed sidebar/global period (the user chose a range elsewhere)
 *   2. `fit` — the range framing the notes that actually exist (W8-e: the default is fit, NOT
 *      the whole corpus axis; owner: "전체보기로 하니까 너무 범위가 넓어져서")
 *   3. system year ±1 (empty notebook — nothing to fit)
 * Always clamped into `full`. Pure — same rule for initial seed (pre-fetch) and post-fetch.
 *
 * A store period that clamps to the entire `full` axis is treated as open: that happens when
 * yearFrom/yearTo track the corpus while still counting as "narrowed" relative to a slightly
 * wider yearBounds (axis padding), and must not pin the view to the full axis.
 */
export function resolveTimelineView(
  period: { yearFrom: number; yearTo: number; yearBounds: { min: number; max: number } },
  full: YearRange,
  nowYear?: number,
  fit?: YearRange | null,
): YearRange {
  if (isYearFilterNarrowed(period.yearFrom, period.yearTo, period.yearBounds)) {
    const narrowed = clampView(period.yearFrom, period.yearTo, full.from, full.to);
    if (narrowed.from > full.from || narrowed.to < full.to) {
      return narrowed;
    }
  }
  if (fit) return clampView(fit.from, fit.to, full.from, full.to);
  const def = defaultTimelineView(nowYear);
  return clampView(def.from, def.to, full.from, full.to);
}

/**
 * Clamp / normalise a view range inside [fullFrom, fullTo], enforcing MIN_VIEW_SPAN.
 * Preserves span when translating off an edge (pan clamp). Fractional years are kept
 * (sub-year zoom); do not reintroduce Math.round — that forced year-only zoom and the
 * unreadable ~1-week window the owner reported.
 */
export function clampView(
  from: number,
  to: number,
  fullFrom: number,
  fullTo: number,
): YearRange {
  const fullSpan = fullTo - fullFrom;
  if (!(fullSpan > 0)) return { from: fullFrom, to: fullTo };

  let lo = Math.min(from, to);
  let hi = Math.max(from, to);
  let span = hi - lo;

  const minSpan = Math.min(MIN_VIEW_SPAN, fullSpan);
  if (span < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
    span = minSpan;
  }
  if (span > fullSpan) {
    return { from: fullFrom, to: fullTo };
  }
  if (lo < fullFrom) {
    lo = fullFrom;
    hi = lo + span;
  }
  if (hi > fullTo) {
    hi = fullTo;
    lo = hi - span;
  }
  return { from: lo, to: hi };
}

/** Zoom around a focus year (defaults to midpoint). factor > 1 zooms out. */
export function zoomView(
  view: YearRange,
  factor: number,
  fullFrom: number,
  fullTo: number,
  focusYear?: number,
): YearRange {
  const span = view.to - view.from;
  const nextSpan = span * factor;
  const focus = focusYear ?? (view.from + view.to) / 2;
  const t = span > 0 ? (focus - view.from) / span : 0.5;
  const from = focus - nextSpan * t;
  const to = focus + nextSpan * (1 - t);
  return clampView(from, to, fullFrom, fullTo);
}

/**
 * Derive a sensible full axis range from items / buckets / eras.
 * Falls back to corpus yearBounds when the payload is empty.
 */
export function deriveFullRange(
  items: TimelineNoteItem[],
  buckets: TimelineYearBucket[],
  eras: { from_year: number; to_year: number }[],
  fallback: YearRange,
  responseFrom: number,
  responseTo: number,
): YearRange {
  let min = Infinity;
  let max = -Infinity;
  for (const it of items) {
    const r = itemTimeRange(it);
    min = Math.min(min, r.start);
    max = Math.max(max, r.end);
  }
  for (const b of buckets) {
    min = Math.min(min, b.year);
    max = Math.max(max, b.year);
  }
  for (const e of eras) {
    min = Math.min(min, e.from_year);
    max = Math.max(max, e.to_year);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    // Empty payload — use the request window if it looks real, else fallback.
    if (responseTo > responseFrom) return { from: responseFrom, to: responseTo };
    return fallback;
  }
  // Pad a little so edge items aren't flush against the frame (shared with sidebar year axis).
  return padYearRange(min, max);
}

/** Whether item labels should paint at this zoom density. */
export function shouldShowLabels(viewFrom: number, viewTo: number, width: number): boolean {
  const span = viewTo - viewFrom;
  if (!(span > 0) || !(width > 0)) return false;
  return width / span >= LABEL_MIN_PX_PER_YEAR;
}

/** An item's painted left edge (canvas px) as ItemsLayer actually renders it — bars start flush
 *  with their startYear, points are centered on their POINT_SIZE marker (see TimelineItem). */
function itemPaintedLeft(it: PackedItem, view: YearRange, width: number): number {
  const x = yearToX(it.startYear, view.from, view.to, width);
  return it.kind === "point" ? x - POINT_SIZE / 2 : x;
}

/**
 * Max px width for a POINT's label before it runs into the next item painted in the same
 * (lane, subLane) row (dashboard QA fix — point labels at nearby x positions ran over each
 * other). Bars keep their existing behavior: the pill's own width already clips the title with
 * ellipsis, so this only clamps point labels.
 *
 * Returns:
 *  - a px number — the label's clamped maxWidth;
 *  - null — the gap is under LABEL_MIN_GAP_PX; hide the label outright (the native `title`
 *    tooltip still carries the text, same convention as LABEL_MIN_PX_PER_YEAR);
 *  - undefined — no neighbor in this row; caller keeps its current unclamped behavior.
 *
 * ponytail (2026-08-14, QA 4 C-3): assignItemLanes now pushes points down to the next available
 * sub-lane when within LABEL_MIN_GAP_PX, so under normal layout, points avoid label collisions
 * and retain both dot and label. The `null` return path here remains as a defensive guard for cases
 * where assignItemLanes runs without view/width (e.g. headless tests) or during in-flight drag gestures.
 *
 * Pure over the packed/visible item list so it's testable without touching ItemsLayer's DOM.
 */
export function pointLabelMaxWidth(
  point: PackedItem,
  items: PackedItem[],
  view: YearRange,
  width: number,
): number | null | undefined {
  const ownLeft = itemPaintedLeft(point, view, width);
  let nextLeft = Infinity;
  for (const it of items) {
    if (it === point || it.lane !== point.lane || it.subLane !== point.subLane) continue;
    const left = itemPaintedLeft(it, view, width);
    if (left > ownLeft && left < nextLeft) nextLeft = left;
  }
  if (!Number.isFinite(nextLeft)) return undefined;
  const gap = nextLeft - ownLeft;
  if (gap < LABEL_MIN_GAP_PX) return null;
  return gap - LABEL_GAP_PAD_PX;
}

// PLAN-2026-09-08-dates-rebuild.md W4: timelineOps.ts (QA 4 C-1's date-write ordering module) was
// deleted — replacePrimaryDate (lib/primaryDate.ts) writes a row's final target values in one
// shot, so there's no transient invalid intermediate state left to order around (see
// TimelineTab.tsx::commitResize/commitMove).

