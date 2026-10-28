/**
 * Pure layout helpers for the home calendar tab (DASHBOARD.md §3.3).
 * Items come from dashboard_calendar — event/span layers only (no record axis). Dashboard
 * Wave 2 (2026-08-01): the old separate "due" layer is gone — due_at merged into the event
 * end triple. Dashboard Wave 3 (2026-08-01): the deadline/urgency display model (⏰/red on a
 * span's terminal day) is retired app-wide — the calendar renders every item neutrally. The
 * remind-flag pin/dot treatment lives only on the board (board/status.ts::isPinned), not here.
 */
import type { CalendarItem, NoteDate } from "../../lib/commands.gen";
import { toDateInputValue } from "../titlebar/eventDate";

/** Re-exported so CalendarTab.tsx's single "./calendarLayout" import doesn't need a second module
 *  — actual implementation lives in leftpanel/expanded/calendarGrid.ts (Wave R1-b dedup, this file
 *  used to hand-carry its own copy of both). */
export { buildCalendarGridCustom } from "../leftpanel/expanded/calendarGrid";

/** Max chips/bars shown inside a day cell before "+n" overflow. */
export const MAX_CELL_LINES = 3;

export type SpanRole = "st" | "mid" | "en" | "single";

/** True when item's clipped month slice covers the given ISO day. */
export function itemCoversDay(item: CalendarItem, day: string): boolean {
  return item.span_start <= day && day <= item.span_end;
}

/** Items that fall on a given day (any kind). */
export function itemsForDay(items: CalendarItem[], day: string): CalendarItem[] {
  return items.filter((it) => itemCoversDay(it, day));
}

/**
 * 항목이 나온 **행(또는 반복 회차)의 진짜 시작일** "YYYY-MM-DD" — 일 정밀도가 아니면 null.
 *
 * `span_start` 는 이 값이 아니다. 서버가 조회 달의 첫날로 **잘라 준** 표시용 조각이라
 * (repo/dashboard/calendar.rs::push_row 의 `start.max(ms)`), 지난달에 시작해 이어지는 항목은
 * 매달 1일에 `span_start` 가 그 1일이 된다. 회차 항목의 year/month/day 는 seed 가 아니라 그
 * 회차의 날짜다(calendar.rs::push_occurrences). 2026-10-18: 이 둘을 섞어 10월 1일에 9월에 시작한
 * 매일 반복 회차 28개가 전부 "23:22 시작 일정"으로 축에 올랐다.
 */
export function rawStartIso(item: Pick<CalendarItem, "year" | "month" | "day">): string | null {
  return toDateInputValue(item.year, item.month, item.day) || null;
}

/** 이 항목이 **그 날 시작하는가** — 시각을 축에 올리는 판정은 이것만 쓴다(잘린 span_start 금지). */
export function startsOnDay(item: Pick<CalendarItem, "year" | "month" | "day">, day: string): boolean {
  return rawStartIso(item) === day;
}

/**
 * 항목의 트랙 안정 키(date_id + rawStartIso) — 같은 날짜 행의 회차 구분용.
 */
export function spanTrackKey(item: CalendarItem): string {
  return `${item.date_id}|${rawStartIso(item) ?? ""}`;
}

/**
 * 같은 날짜 행(date_id)의 회차가 그 날 여럿 겹치면 하나만 남긴다.
 * 남기는 것은 **그 날 시작하는 회차**(startsOnDay)를 우선한다 (Q11).
 */
export function collapseOccurrencesForDay(items: CalendarItem[], day: string): CalendarItem[] {
  const byRow = new Map<string, CalendarItem>();
  for (const it of items) {
    if (!itemCoversDay(it, day)) continue;
    const kept = byRow.get(it.date_id);
    if (!kept || (!startsOnDay(kept, day) && startsOnDay(it, day))) {
      byRow.set(it.date_id, it);
    }
  }
  return Array.from(byRow.values());
}

/**
 * Span segment role within the month-clipped range — drives the bar's rounded/square ends only.
 * Whether the title is drawn is `showTitle` on the line (see buildMonthDayPlans), not this.
 */
export function spanRole(item: CalendarItem, day: string): SpanRole {
  if (item.span_start === item.span_end) return "single";
  if (day === item.span_start) return "st";
  if (day === item.span_end) return "en";
  return "mid";
}

export type CellLine =
  | {
      kind: "span";
      item: CalendarItem;
      role: SpanRole;
      /** Draw the title on this cell's piece of the bar. Defaults to the start day ("st"/"single");
       *  the month grid re-decides it per week row (buildMonthDayPlans). */
      showTitle: boolean;
    }
  | { kind: "event"; item: CalendarItem };

/** Build cell lines directly from already filtered/indexed day items. */
export function buildCellLinesFromDayItems(dayItems: CalendarItem[], day: string): CellLine[] {
  const spans: CellLine[] = [];
  const events: CellLine[] = [];
  for (const item of dayItems) {
    if (item.kind === "span") {
      const role = spanRole(item, day);
      spans.push({ kind: "span", item, role, showTitle: role === "st" || role === "single" });
    } else if (item.kind === "event") {
      // 2026-09-10 (§D4): a related date (position !== 0) is no longer its own kind — the server
      // gives every row the same event/span rule, so it lands in whichever branch its own shape
      // says, exactly like the note's own event axis.
      events.push({ kind: "event", item });
    }
  }
  // Stable secondary sort by title for deterministic render.
  const byTitle = (a: CellLine, b: CellLine) => a.item.title.localeCompare(b.item.title);
  spans.sort(byTitle);
  events.sort(byTitle);
  return [...spans, ...events];
}

/** Ordered lines for a day cell: spans first (continuous bars), then events. */
export function buildCellLines(items: CalendarItem[], day: string): CellLine[] {
  const dayItems = collapseOccurrencesForDay(items, day);
  return buildCellLinesFromDayItems(dayItems, day);
}

export type CellVisible = {
  lines: CellLine[];
  overflow: number;
};

export type DayCellPlan = {
  visibleSpans: Extract<CellLine, { kind: "span" }>[];
  visibleEvents: Extract<CellLine, { kind: "event" }>[];
  /** Hidden spans + hidden events, folded into one count (dashboard/5bc2be60 QA: the "green bar
   *  wall" — spans used to render uncapped, so a busy week could push the whole cell past its
   *  budget with no indication). */
  overflow: number;
};

/**
 * Per-day render plan: spans + events share one MAX_CELL_LINES budget instead of spans always
 * rendering in full. A span is visible iff its week-stable track (from assignWeekSpanTracks) is
 * within the budget — keyed off the same trackOf map every day of the week shares, so a bar
 * hidden on Monday is hidden on Tuesday too (no re-kinking as the visible set changes day to
 * day). The event budget is what's left over after the VISIBLE (post-cap) span rows, not the
 * raw max track index — a day whose only visible span sits on track 0 still gets 2 event slots
 * even if some other day this week reserves a much higher track.
 */
export function planDayCell(
  items: CalendarItem[],
  day: string,
  trackOf: Map<string, number>,
  max: number = MAX_CELL_LINES,
): DayCellPlan {
  const lines = buildCellLines(items, day);
  const spans = lines.filter((l): l is Extract<CellLine, { kind: "span" }> => l.kind === "span");
  const events = lines.filter((l): l is Extract<CellLine, { kind: "event" }> => l.kind === "event");

  const trackFor = (l: Extract<CellLine, { kind: "span" }>) =>
    trackOf.get(spanTrackKey(l.item)) ?? trackOf.get(l.item.date_id) ?? trackOf.get(l.item.note_id) ?? 0;
  const visibleSpans = spans.filter((l) => trackFor(l) < max);
  const hiddenSpans = spans.length - visibleSpans.length;
  const visibleSpanRows =
    visibleSpans.length === 0 ? 0 : Math.max(...visibleSpans.map(trackFor)) + 1;

  const eventBudget = Math.max(0, max - visibleSpanRows);
  const visibleEvents = events.slice(0, eventBudget);
  const hiddenEvents = events.length - visibleEvents.length;

  return { visibleSpans, visibleEvents, overflow: hiddenSpans + hiddenEvents };
}

/** Pre-index items by ISO day across a given list of days for fast O(1) lookups. */
export function indexItemsByDay(
  items: CalendarItem[],
  days: (string | null)[],
): Map<string, CalendarItem[]> {
  const validDays = days.filter((d): d is string => d !== null);
  const map = new Map<string, CalendarItem[]>();
  for (const d of validDays) map.set(d, []);

  for (const item of items) {
    for (const d of validDays) {
      if (item.span_start <= d && d <= item.span_end) {
        map.get(d)!.push(item);
      }
    }
  }
  return map;
}

/**
 * Pre-compute all day plans for a month grid efficiently using indexed day lookups.
 */
export function buildMonthDayPlans(
  cells: { day: string | null; dayOfMonth: number | null }[],
  items: CalendarItem[],
  max: number = MAX_CELL_LINES,
): Map<string, DayCellPlan & { trackOf: Map<string, number> }> {
  const plans = new Map<string, DayCellPlan & { trackOf: Map<string, number> }>();
  const dayIndex = indexItemsByDay(
    items,
    cells.map((c) => c.day),
  );

  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    const trackOf = assignWeekSpanTracks(
      items,
      week.map((c) => c.day),
    );
    // Bars whose title this week row already drew. Each cell renders its own clipped piece of a
    // bar, so the title must sit on the FIRST VISIBLE piece in every row — the standard month-view
    // rule. Keying it off the start day ("st") left every later row a nameless band, and when the
    // start week folded the bar into "+n" the name appeared nowhere that month (2026-10-19 screen
    // board). Days run left to right, so "not seen yet" is exactly "first visible in this row".
    const titled = new Set<string>();
    for (const cell of week) {
      if (cell.day === null) continue;
      const rawDayItems = dayIndex.get(cell.day) ?? items;
      const dayItems = collapseOccurrencesForDay(rawDayItems, cell.day);
      const lines = buildCellLinesFromDayItems(dayItems, cell.day);
      const spans = lines.filter((l): l is Extract<CellLine, { kind: "span" }> => l.kind === "span");
      const events = lines.filter((l): l is Extract<CellLine, { kind: "event" }> => l.kind === "event");

      const trackFor = (l: Extract<CellLine, { kind: "span" }>) =>
        trackOf.get(spanTrackKey(l.item)) ?? trackOf.get(l.item.date_id) ?? trackOf.get(l.item.note_id) ?? 0;
      const visibleSpans = spans
        .filter((l) => trackFor(l) < max)
        .map((l) => {
          const key = spanTrackKey(l.item);
          const showTitle = !titled.has(key);
          titled.add(key);
          return showTitle === l.showTitle ? l : { ...l, showTitle };
        });
      const hiddenSpans = spans.length - visibleSpans.length;
      const visibleSpanRows =
        visibleSpans.length === 0 ? 0 : Math.max(...visibleSpans.map(trackFor)) + 1;

      const eventBudget = Math.max(0, max - visibleSpanRows);
      const visibleEvents = events.slice(0, eventBudget);
      const hiddenEvents = events.length - visibleEvents.length;

      plans.set(cell.day, {
        trackOf,
        visibleSpans,
        visibleEvents,
        overflow: hiddenSpans + hiddenEvents,
      });
    }
  }
  return plans;
}

/**
 * Greedy per-week vertical track assignment for period-span items (dashboard/5bc2be60 QA: spans
 * must stack instead of colliding when they overlap, and the SAME item must land on the SAME
 * track on every day it covers within the week — the old per-cell behavior (each day sorting its
 * own spans alphabetically) let the bar's row jump as unrelated items entered/left the set,
 * which is what made a continuous period look chopped up. Track numbers are local to one week;
 * a note crossing a week boundary just gets a fresh greedy pass in the next row — its cap logic
 * (rounded vs square edge) is unaffected, that's still spanRole/item.span_start/span_end.
 */
export function assignWeekSpanTracks(
  items: CalendarItem[],
  weekDays: (string | null)[],
): Map<string, number> {
  const days = weekDays.filter((d): d is string => d !== null);
  if (days.length === 0) return new Map();
  const weekStart = days[0];
  const weekEnd = days[days.length - 1];

  const weekSpans = items.filter(
    (it) => it.kind === "span" && it.span_start <= weekEnd && it.span_end >= weekStart,
  );

  // 같은 날짜 행(date_id)의 회차들은 한 주 안에서 하나의 트랙을 공유하도록 행 단위로 인터벌을 묶는다.
  const byRow = new Map<string, CalendarItem[]>();
  for (const it of weekSpans) {
    const list = byRow.get(it.date_id);
    if (list) list.push(it);
    else byRow.set(it.date_id, [it]);
  }

  const rowIntervals: TrackInterval<string>[] = [];
  for (const [dateId, group] of byRow) {
    let start = weekEnd;
    let end = weekStart;
    for (const it of group) {
      const s = it.span_start > weekStart ? it.span_start : weekStart;
      const e = it.span_end < weekEnd ? it.span_end : weekEnd;
      if (s < start) start = s;
      if (e > end) end = e;
    }
    rowIntervals.push({ key: dateId, start, end });
  }

  const rowTracks = assignTracks(rowIntervals);

  const trackOf = new Map<string, number>();
  for (const [dateId, track] of rowTracks) {
    trackOf.set(dateId, track);
    const group = byRow.get(dateId);
    if (group) {
      for (const it of group) {
        trackOf.set(spanTrackKey(it), track);
        trackOf.set(it.note_id, track);
      }
    }
  }
  return trackOf;
}

export type TrackInterval<K extends string | number> = { key: string; start: K; end: K };

/**
 * Greedy interval packing → track index per key. The week-span bars (assignWeekSpanTracks, over
 * inclusive ISO day strings) and the day view's time axis (planTimedDay, over half-open minute
 * ranges) are the same algorithm on different coordinates — schedule W5-5 (§6.2 "알고리즘을 두 번
 * 쓰지 않는다") generalized it here rather than growing a second copy.
 *
 * `inclusiveEnd` is the only real difference between the two coordinate systems: a span ending on
 * day D still occupies D (so D is a collision), while an event ending at 10:00 frees 10:00 for the
 * next one.
 */
export function assignTracks<K extends string | number>(
  intervals: TrackInterval<K>[],
  opts?: { inclusiveEnd?: boolean },
): Map<string, number> {
  const inclusiveEnd = opts?.inclusiveEnd !== false;
  // Earlier start first; ties broken by key for a deterministic pack.
  const sorted = [...intervals].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.key.localeCompare(b.key),
  );
  const trackEnds: K[] = []; // trackEnds[t] = last occupied position on track t
  const result = new Map<string, number>();
  for (const iv of sorted) {
    let track = 0;
    while (
      track < trackEnds.length &&
      (inclusiveEnd ? trackEnds[track] >= iv.start : trackEnds[track] > iv.start)
    ) {
      track++;
    }
    trackEnds[track] = iv.end;
    result.set(iv.key, track);
  }
  return result;
}

// ── Day view time axis (schedule W5-5, docs/PLAN-schedule-system.md §6.2) ────────────────────
// Every number here is derived from the 280px aside the owner fixed on 2026-08-09: the month grid
// must not get narrower, so the event area is ~230px and overlaps CANNOT split width (3 columns of
// 76px make titles unreadable). Overlaps used to offset left by track × 8px (a staircase) + z-index,
// but QA found that near-time chips (09:00/09:05) let the top chip fully cover the row below's
// title. Owner revision (2026-08-09): overlapping chips kept FULL width and stacked vertically —
// pushed straight down under whatever chip was directly above them.
// 2026-10-27 기하 통일(오너 결정)이 이것을 다시 뒤집었다: 밀어내기는 칩 top 이 시각이 아니게 만들어 손잡이·스냅과
// 칩이 화면에서 어긋났다. 지금은 top = 시각이고, 겹침은 **만들지 않는다** — 끌거나 늘릴 때 이웃이 자연스럽게 밀리거나
// 줄어든다(오너 2026-10-27 "윗 블록 시간을 늘리면 아래 것이 줄어들거나 밀려난다"). 이미 겹쳐 저장된 일정만 lane 들여쓰기로 그린다.

/** Time label column: 2-digit hour + breathing room. timeChip.css 의 `.cal-hour-wx { width: 24px }` 와 같은 값이다(CSS 가 이 상수를 못 읽어 둘을 맞춰 둔다). */
export const TIME_LABEL_W = 24;
/** One hour row. 24 of them = DAY_AXIS_H, which scrolls INSIDE the aside. This is the axis's
 *  DEFAULT/initial scale only — 2026-09-13 축 확대: the axis now owns its own zoomed scale as
 *  local component state (TimeAxis's `hourRowH`), so every function below that used to close over
 *  this constant directly now takes a `hourRowH` parameter instead (defaulting to this constant,
 *  so every existing caller/test that doesn't pass one keeps the old behavior byte-for-byte). This
 *  file does NOT hold a global mutable scale — that was explicitly ruled out (an axis instance's
 *  zoom must not leak into another instance, and there is no natural single owner for one). */
export const HOUR_ROW_H = 28;
export const DAY_AXIS_H = HOUR_ROW_H * 24;
/** 확대 하한(=이 기본값, 더 축소 안 된다) · 상한. 상한은 아래 tickIntervalMinFor 의 임계와
 *  맞물린다 — 240 은 5분 간격이 정확히 TICK_MIN_GAP_PX(20px)에 닿는 값이라, 그 근방에서만 가장
 *  촘촘한 눈금이 자연스럽게 나온다(요구사항: 5분 미만으로는 절대 세분화하지 않는다). */
export const MIN_HOUR_ROW_H = HOUR_ROW_H;
export const MAX_HOUR_ROW_H = 240;
/** 끝이 없는 일정이 축에서 차지하는 기본 길이이자, 빈 곳 끌기·종일 카드 드롭으로 새로 만드는 일정의 길이. */
export const MIN_SLOT_MIN = 30;
/** Scroll target when the day has no timed item to scroll to. */
export const DEFAULT_SCROLL_HOUR = 8;

/** 하루의 분 — 축에서 "당일"과 "익일 구간"의 경계(자정). */
export const DAY_MIN = 24 * 60;
/** 익일 구간 상한(시). 설정(calendar_axis_tail_hours)과 Rust 검증이 같은 값을 쓴다. */
export const MAX_TAIL_HOURS = 12;

/** 축의 끝 분(좌표는 당일 00:00 기준) — 당일만이면 24:00, 익일 N시까지면 24:00 + N시간. **하루 끝에 기대던 모든
 *  clamp 가 이 한 값에서 나온다**(DayAxis 가 `tailHours` 에서 한 번 계산해 아래 함수들에 넘긴다). */
export function axisEndMinFor(tailHours: number): number {
  const h = Number.isFinite(tailHours) ? Math.round(tailHours) : 0;
  return DAY_MIN + Math.max(0, Math.min(MAX_TAIL_HOURS, h)) * 60;
}

/** 이 시작 분이 속한 날의 [lo, hi] — 당일이면 [0, 24:00], 익일 구간이면 [24:00, 축의 끝]. 한 일정은 자정을 가로지르지
 *  않는다(저장 형식이 하루짜리 행 — 끝 시각이 시작보다 앞설 수 없다, I3) — 그래서 리사이즈와 이웃 이동은 이 안에 머문다. */
export function dayBoundsOf(startMin: number, axisEndMin: number = DAY_MIN): { lo: number; hi: number } {
  return startMin >= DAY_MIN ? { lo: DAY_MIN, hi: axisEndMin } : { lo: 0, hi: DAY_MIN };
}

/** 축 분(당일 00:00 기준, 익일 구간은 +24:00)이 속한 날의 시작 오프셋 — 당일 0, 익일 구간 `DAY_MIN`. 한 일정은 자정을 가로지르지 않으므로
 *  **시작 분 하나**가 어느 날인지를 정한다. */
export function axisDayOffsetMin(min: number): 0 | typeof DAY_MIN {
  return min >= DAY_MIN ? DAY_MIN : 0;
}

/** 축 분 → (그 분이 속한 날, 그 날의 분). 익일 구간이 없으면(`tailDay` null) 24:00 이상이어도 당일로 둔다. 축이 만드는 쓰기·확인 요청이
 *  "어느 날의 몇 분인가"를 말할 때 거치는 **한 길**이다(예전엔 다섯 곳이 `>= DAY_MIN ? … : …` 를 손으로 썼다). */
export function splitAxisMin(min: number, day: string | null, tailDay: string | null): { day: string | null; min: number } {
  return min >= DAY_MIN && tailDay ? { day: tailDay, min: min - DAY_MIN } : { day, min };
}

/** 당일 일정에 익일 구간 안에서 시작하는 다음 날 일정을 이어 붙인다 — 좌표는 당일 00:00 기준이라 익일 것은 +24:00, 끝은 구간 끝에서 자른다.
 *  구간이 없거나(`tailMinutes` 0) 다음 날 plan 이 없으면 입력을 그대로 돌려준다(참조 유지 — 메모 키가 흔들리지 않는다). */
export function mergeTailTimed(timed: TimedEvent[], tailPlan: TimedDayPlan | null, tailMinutes: number): TimedEvent[] {
  if (tailMinutes === 0 || !tailPlan) return timed;
  const next = tailPlan.timed
    .filter((e) => e.startMin < tailMinutes)
    .map((e) => ({
      ...e,
      startMin: e.startMin + DAY_MIN,
      endMin: Math.min(e.endMin, tailMinutes) + DAY_MIN,
    }));
  return next.length > 0 ? [...timed, ...next] : timed;
}

/** 축 스크롤 영역의 전체 높이(px) — 눈금 영역(`hourRowH` × 축 끝 분 / 60) + compact 사이드바의 아래 여백 `paddingRows` 행. */
export function axisContentPx(hourRowH: number, axisEndMin: number, paddingRows: number = 0): number {
  return (hourRowH * axisEndMin) / 60 + paddingRows * hourRowH;
}

/** 축 스크롤러가 갈 수 있는 맨 아래 scrollTop. `scrollHeight - clientHeight` 가 정공법이지만 jsdom 에는 레이아웃이 없어 둘 다 0 이고,
 *  캔버스 높이는 우리가 픽셀로 정한 값이라 같은 수가 나온다 — 확대 보정·기본 스크롤·가장자리 자동 스크롤이 이 한 식을 쓴다. */
export function maxAxisScrollTop(contentPx: number, viewPx: number): number {
  return Math.max(0, contentPx - viewPx);
}

/** "HH:MM" → minutes past midnight. Null on anything else (incl. null/undefined). */
export function parseHhmm(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export type TimedEvent = {
  /** Unique within the day — a repeating note can contribute several items with one note_id. */
  key: string;
  item: CalendarItem;
  startMin: number;
  /** Half-open end. 실제 끝이 있으면 그대로(짧아도 늘리지 않는다), 없으면 startMin + MIN_SLOT_MIN. 하루 끝에서 자른다. */
  endMin: number;
  /** 축 안의 픽셀 top — **항상 시작 시각 그대로**다(겹쳐도 밀지 않는다, layoutTimedEvents). */
  top: number;
  /** 픽셀 높이 = 실제 길이(endMin - startMin). */
  height: number;
  /** 겹침 들여쓰기 칸(0부터). 이미 겹쳐 저장된 일정(다른 곳에서 만든 것 등)이 있을 때만 0 이 아니다 — 새 조작은
   *  이웃을 밀거나 줄여 겹침을 만들지 않는다(planLinkedMove/Resize). */
  lane: number;
};

export type TimedDayPlan = {
  /** start_time-bearing items that actually start on this day, time-ordered (no cap/"+n" anymore — nothing is
   *  hidden, see §6.2). 겹침은 밀어내지 않고 `lane` 들여쓰기로만 표현한다(layoutTimedEvents) — top 은 항상 시각이다. */
  timed: TimedEvent[];
  /** Everything else — no time, or a timed span's continuation day. */
  allDay: CalendarItem[];
};

/** Stable per-day render key — note_id alone collides across occurrences of a repeating note, and
 *  note_id+kind collides across two related dates of the SAME note landing on the same day (which
 *  became possible once related dates started carrying their own event/span shape, 2026-09-10 §D4).
 *  date_id is the row that produced the item, so it's unique per row; the occurrence's own start
 *  (rawStartIso) separates the occurrences one repeating row expands into — span_start alone can't:
 *  every occurrence that began last month is clipped to the same 1st (2026-10-18, 28 colliding keys
 *  on Oct 1). span_start stays in the key too: YearGrid dedups 36 months of pieces by this key, and
 *  one multi-month span legitimately yields one piece per month with the same raw start. */
export function itemKey(item: CalendarItem): string {
  return `${item.date_id}|${rawStartIso(item) ?? ""}|${item.span_start}`;
}

/**
 * 시간축 칩의 픽셀 자리 — **기하가 하나다**(2026-10-27 오너 결정 "칩 top=시각, 높이=실제 길이, 겹침은 들여쓰기").
 *
 * 예전엔 겹치는 칩을 아래로 밀어 쌓았는데(스태킹 스윕) 그러면 칩의 top 이 시각이 아니게 되어, 시각 좌표를 쓰는
 * 손잡이·스냅·라벨과 칩이 화면에서 서로 다른 자리에 섰다(밀림이 연쇄로 누적돼 세 번째 칩은 54분 아래). 이제
 * top·height 는 분에서만 나오고, 겹침은 `lane`(들여쓰기 칸)으로만 표현한다 — assignTracks 를 반열린 구간으로
 * 써서 09:00–09:30 과 09:30–10:00 처럼 맞닿은 것은 겹침이 아니다(같은 칸).
 *
 * 스케일은 인자로만 들어온다(TimeAxis 의 로컬 확대 상태). 입력 순서는 상관없다 — 칸 배정은 시각순으로 한다.
 */
export function layoutTimedEvents(
  events: readonly { startMin: number; endMin: number }[],
  hourRowH: number = HOUR_ROW_H,
): { top: number; height: number; lane: number }[] {
  const pxPerMin = hourRowH / 60;
  const lanes = assignTracks(
    events.map((e, i) => ({ key: String(i).padStart(6, "0"), start: e.startMin, end: e.endMin })),
    { inclusiveEnd: false },
  );
  const laneOf = (i: number) => lanes.get(String(i).padStart(6, "0")) ?? 0;
  return events.map((e, i) => ({
    top: e.startMin * pxPerMin,
    height: (e.endMin - e.startMin) * pxPerMin,
    lane: laneOf(i),
  }));
}

/**
 * Split one day's items into the all-day strip and the time axis, and pack the overlaps.
 *
 * The §6.2 rule is "start_time == null → all-day". This adds one condition: a timed MULTI-DAY span
 * only enters the axis on its own start day — drawing "09:00" on day 3 of a trip would be a plainly
 * wrong label, and end_time is the LAST day's time (§1.3 I3), so it isn't this day's length either.
 * Continuation days fall to the all-day strip, which is where §6.2's own sketch puts a span middle.
 * Both judgements read the ROW's shape (startsOnDay / rowIsSameDay), never the month-clipped
 * span_start/span_end — on the 1st of a month those clipped values lie (see rawStartIso).
 *
 * `hourRowH` (2026-09-13 축 확대) only affects the returned `top`/`height` pixels (via
 * layoutTimedEvents) — which items land in `timed` vs `allDay`, and their startMin/endMin, are pure
 * time-of-day facts independent of pixel scale.
 */
export function planTimedDay(
  items: CalendarItem[],
  day: string,
  hourRowH: number = HOUR_ROW_H,
): TimedDayPlan {
  const dayItems = collapseOccurrencesForDay(items, day);
  const timed: TimedEvent[] = [];
  const allDay: CalendarItem[] = [];

  for (const item of dayItems) {
    const startMin = startsOnDay(item, day) ? parseHhmm(item.start_time) : null;
    if (startMin === null) {
      allDay.push(item);
      continue;
    }
    // end_time belongs to the row's last day; only a same-day row can use it as this block's length.
    // 실제 끝이 있으면 짧아도 그대로 그린다(높이 = 실제 길이) — 끝이 없을 때만 기본 길이를 준다.
    const rawEnd = rowIsSameDay(item) ? parseHhmm(item.end_time) : null;
    const endMin = Math.min(
      DAY_MIN,
      rawEnd !== null && rawEnd > startMin ? rawEnd : startMin + MIN_SLOT_MIN,
    );
    timed.push({ key: itemKey(item), item, startMin, endMin, top: 0, height: 0, lane: 0 });
  }

  timed.sort((a, b) => a.startMin - b.startMin || a.key.localeCompare(b.key));

  const layout = layoutTimedEvents(timed, hourRowH);
  timed.forEach((e, i) => {
    e.top = layout[i].top;
    e.height = layout[i].height;
    e.lane = layout[i].lane;
  });

  allDay.sort((a, b) => a.title.localeCompare(b.title));
  return { timed, allDay };
}

// ── 시간축 칩을 위아래로 끌어 시각 바꾸기 (PLAN-2026-09-10 달력 W3) ──────────────────────────
// 픽셀↔분 산수는 전부 여기 있다 — DayDetailPanel 안에 흩뿌리지 않는다(이 파일이 이미 그 역할).

/** 스냅 격자. 축이 28px/시간이므로 15분 = 정확히 7px. */
export const SNAP_MIN = 15;
/** 축의 픽셀↔분 환산. */
export const PX_PER_MIN = HOUR_ROW_H / 60;

/**
 * 드래그·키보드로 옮긴 새 시작 분 — 15분 스냅 + 0~23:59 clamp.
 *
 * **시각은 `startMin` + 픽셀델타로 센다.** 예전엔 스태킹 스윕이 겹치는 칩을 아래로 밀어 화면 `top` 이 시간이 아니었다
 * (함정 ⓐ). 2026-10-27 기하 통일로 top = 시각이 됐지만, 이 함수는 여전히 **`startMin` + 픽셀델타**만 본다 — 호출자는 top 에서
 * 시각을 역산하지 마라(렌더 스케일·미리보기와 얽히는 되돌리기 딱 좋은 자리다).
 *
 * `durationMin` 이 있으면 **길이를 유지**한 채 자정을 넘지 않도록 시작을 clamp 한다. 길이가
 * 없으면 상한은 23:45 — 15분 격자에서 23:59 를 넘지 않는 마지막 칸이다.
 */
export function snapStartMin(
  startMin: number,
  deltaPx: number,
  durationMin = 0,
  hourRowH: number = HOUR_ROW_H,
  prevStartMin?: number,
  /** 시작이 머물 수 있는 범위 — 기본은 당일 [0, 24:00]. 익일 구간이 있으면 축 전체 또는 그 일정이 속한 날이다. */
  bounds: { lo: number; hi: number } = { lo: 0, hi: DAY_MIN },
): number {
  const pxPerMin = hourRowH / 60;
  const snapped = snapWithHysteresis(startMin + deltaPx / pxPerMin, prevStartMin);
  const maxStart = bounds.hi - Math.max(durationMin, SNAP_MIN);
  return Math.max(bounds.lo, Math.min(maxStart, snapped));
}

/** 스냅 경계의 히스테리시스(칸 단위). 반올림 경계(±0.5칸)에서 손이 떨리면 값이 칸 사이를 오가며 진동하던 것을,
 *  직전에 보인 칸에서 **0.5+0.2칸 넘게** 벗어나야 다음 칸으로 넘어가게 해 막는다. */
export const SNAP_HYSTERESIS = 0.2;

/** 15분 격자로 반올림하되 `prev`(직전에 보인 칸)가 있으면 그 칸에서 충분히 벗어나기 전엔 prev 를 유지한다. */
function snapWithHysteresis(min: number, prev?: number): number {
  const snapped = Math.round(min / SNAP_MIN) * SNAP_MIN;
  if (prev === undefined || snapped === prev) return snapped;
  return Math.abs(min - prev) < SNAP_MIN * (0.5 + SNAP_HYSTERESIS) ? prev : snapped;
}

/**
 * 이동 시 유지해야 할 길이(분). end_time 이 없거나 시작보다 이르면 0 = "시작만 민다".
 *
 * **`sameDay` 는 선택 인자가 아니다.** 여러 날 span 의 `end_time` 은 **마지막 날**의 시각이라
 * (§1.3 I3) 이 날의 길이가 아니다. W3 은 "그 경우 gap 이 음수라 자연히 0 이 된다"에 기댔는데
 * 그게 틀렸다 — `9/2 09:00 → 9/17 18:00` 은 gap 이 +540 이라, 9/2 의 칩을 한 칸 옮기면 **9/17 의
 * 끝 시각이 같이 밀렸다**(오너 실기 뒤 발견, 2026-09-10). 숫자 비교로 날짜를 추측하지 말고
 * 호출자가 "이 행이 하루짜리인가"를 명시한다. 하루가 아니면 길이는 0 — 끝은 건드리지 않는다.
 */
export function keepDurationMin(
  startTime: string | null,
  endTime: string | null,
  sameDay: boolean,
): number {
  if (!sameDay) return 0;
  const s = parseHhmm(startTime);
  const e = parseHhmm(endTime);
  if (s === null || e === null || e <= s) return 0;
  return e - s;
}

/** 분 → "HH:MM" — parseHhmm 의 역함수. */
export function formatHhmm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ── 손잡이로 시작·끝 따로 조정 · 빈 곳 드래그로 추가 · 현재 시각 눈금 (W5) ────────────────────

/** 클릭과 드래그를 가르는 이동량(px). DayDetailPanel 의 지역 상수였는데, 칩 드래그(①)와 빈 곳
 *  드래그(②)가 **같은 값**을 써야 하고 아래 planNewRange 가 그 판정을 직접 해서 여기로 올렸다. */
export const DRAG_THRESHOLD_PX = 3;

export type ChipDragMode = "move" | "start" | "end";

/** 손잡이로 줄일 수 있는 가장 짧은 길이 — 스냅 한 칸. 높이가 실제 길이라 15분 일정도 그대로 그려지므로,
 *  최소를 30분으로 두면 15분 일정의 손잡이를 잡는 순간 30분으로 튄다. */
export const MIN_RESIZE_MIN = SNAP_MIN;

/** 리사이즈 손잡이 히트 반폭의 상한(px). */
export const HANDLE_HIT_PAD = 6;
/** 칩 높이에 맞춘 손잡이 히트 반폭 — **손잡이 규칙의 단일 출처**. 위·아래 손잡이를 합쳐 칩 높이의 절반까지만 덮어(반폭 ≤ 높이/4) 가운데(이동)를
 *  남긴다. 고정 ±6px 이면 두 손잡이(24px)가 14px(30분) 칩을 통째로 덮어 짧은 칩을 옮길 수 없게 된다. 어느 손잡이를 잡았는지는 이제 요소가 정하므로
 *  (AxisResizeHandle 이 mode 를 안다) 좌표로 되짚던 `chipDragMode`/`handleThicknessPx`(높이/3 규칙 — 실제 손잡이와 달랐다)는 지웠다.
 *  손잡이를 줄 수 있는 행은 `rowIsSameDay` 가 가른다(여러 날 span 의 end_time 은 마지막 날의 시각이라 끌게 하면 남의 날짜를 조용히 바꾼다). */
export function handlePadPx(chipHeightPx: number): number {
  return Math.max(1, Math.min(HANDLE_HIT_PAD, chipHeightPx / 4));
}

/** 15분 격자 반올림 + 범위(기본 하루) 안으로 clamp. */
function snapMin(min: number, prev?: number, bounds: { lo: number; hi: number } = { lo: 0, hi: DAY_MIN }): number {
  return Math.max(bounds.lo, Math.min(bounds.hi, snapWithHysteresis(min, prev)));
}

/** 시작~끝이 자정(24:00)을 가로지르나. */
function straddlesMidnight(startMin: number, endMin: number): boolean {
  return startMin < DAY_MIN && endMin > DAY_MIN;
}

/**
 * 드래그 한 번의 결과 시각. 무엇이 고정인지가 mode 마다 다르다 —
 * move 는 길이 유지(함정 ⓐ 그대로 `startMin` + 픽셀델타), start 는 끝 고정, end 는 시작 고정.
 * 어느 쪽도 **MIN_RESIZE_MIN 보다 짧아지지 않는다**(시작이 끝을 넘지도, 끝이 시작 아래로 가지도).
 */
export function dragTimes(
  mode: ChipDragMode,
  base: { startMin: number; endMin: number; durationMin: number },
  deltaPx: number,
  hourRowH: number = HOUR_ROW_H,
  /** 직전에 보인 스냅 결과 — 있으면 칸 경계에 히스테리시스를 건다(드래그 중 진동 방지). 키보드는 안 준다. */
  prev?: { startMin: number; endMin: number },
  /** 익일 구간이 있는 축 — `axisEndMin` 이 24:00 보다 크면 이동은 자정을 넘을 수 있다(`locked` 가 아닐 때).
   *  `locked`(여러 날 span · 반복 행처럼 날짜를 못 바꾸는 일정)와 리사이즈는 자기 날 안에 머문다. */
  axis: { axisEndMin: number; locked?: boolean } = { axisEndMin: DAY_MIN },
): { startMin: number; endMin: number } {
  const pxPerMin = hourRowH / 60;
  const deltaMin = deltaPx / pxPerMin;
  const own = dayBoundsOf(base.startMin, axis.axisEndMin);
  if (mode === "start") {
    return {
      startMin: Math.min(base.endMin - MIN_RESIZE_MIN, snapMin(base.startMin + deltaMin, prev?.startMin, own)),
      endMin: base.endMin,
    };
  }
  if (mode === "end") {
    return {
      startMin: base.startMin,
      endMin: Math.max(base.startMin + MIN_RESIZE_MIN, snapMin(base.endMin + deltaMin, prev?.endMin, own)),
    };
  }
  const free = !axis.locked && axis.axisEndMin > DAY_MIN;
  const bounds = free ? { lo: 0, hi: axis.axisEndMin } : own;
  const durationMin = base.endMin - base.startMin;
  let startMin = snapStartMin(base.startMin, deltaPx, base.durationMin, hourRowH, prev?.startMin, bounds);
  if (free && straddlesMidnight(startMin, startMin + durationMin)) {
    // 자정을 가로지르는 자리는 없다 — "끝이 자정에 닿는 자리"(위)와 "시작이 자정인 자리"(아래) 중 손에 가까운 쪽으로.
    // 같은 거리면 가던 방향으로(키보드 15분 한 칸으로도 자정을 넘을 수 있게).
    const up = DAY_MIN - durationMin;
    const down = DAY_MIN + durationMin <= axis.axisEndMin ? DAY_MIN : up;
    const raw = base.startMin + deltaMin;
    const dUp = Math.abs(raw - up);
    const dDown = Math.abs(raw - down);
    startMin = dUp < dDown ? up : dDown < dUp ? down : deltaMin >= 0 ? down : up;
  }
  return { startMin, endMin: startMin + durationMin };
}

// ── 붙어 있는 항목의 연동 이동 (PLAN-2026-09-10 달력 W15) ────────────────────────────────────

/** 연동 판정이 보는 칩 하나 — 시각 두 개와 "이 항목의 시각을 함부로 바꿔도 되나"뿐이다.
 *  `linkable` 은 그 날 안에서 끝나는 하루짜리 행만 true(= isResizable) — 여러 날 span 의
 *  `end_time` 은 마지막 날의 시각이라(§1.3 I3) 같이 밀면 남의 날짜를 조용히 바꾼다.
 *  `hasEnd` 는 planLinkedResize 만 본다(옵셔널 — planLinkedMove 는 shiftRowTimes 로 끝이 없는
 *  행도 안전하게 옮기므로 이 필드가 필요 없다, 그 함수 주석 참고). 없으면(undefined) true 로
 *  취급하지 않는다 — 이 필드를 실제로 채우는 프로덕션 호출부(DayDetailPanel.chipPositions)만
 *  planLinkedResize 를 부르고, 기존 planLinkedMove 테스트 픽스처는 그대로 컴파일된다. */
export type LinkableEvent = {
  key: string;
  startMin: number;
  endMin: number;
  linkable: boolean;
  hasEnd?: boolean;
  /** 날짜를 못 바꾸는 일정(여러 날 span · 반복 행) — 익일 구간이 있어도 자기 날 안에서만 움직인다. 주 칩일 때만 본다. */
  locked?: boolean;
};

/**
 * 옮기는 칩(`key`)이 이웃을 **밀어내며** 움직인 결과 — 겹침을 만들지 않는다(오너 2026-10-27 "윗 블록을 옮기면 아래 것이
 * 자연스레 밀려난다"). 반환은 칩이 실제로 갈 수 있는 델타(`deltaMin`)와, 밀린 이웃들의 새 자리(`linked`)다.
 *
 * 이동 방향의 이웃이 칩의 새 범위와 겹치면 그 이웃은 **딱 겹치는 만큼만**(= 칩의 새 가장자리까지) 밀리고, 그 이웃이
 * 다음 이웃과 겹치게 되면 연쇄로 민다(뒤쪽 간격은 그대로 둔다 — 간격이 있으면 거기까지는 안 밀린다). 예전의 "정확히
 * 맞닿은 이웃이 같은 델타만큼 따라온다"(W15)는 이 규칙의 특수한 경우다: 맞닿아 있으면 델타 전부만큼 밀린다.
 *
 * 벽: 밀 수 없는 이웃(`linkable` false — 여러 날 span)이나 하루의 끝(0:00·24:00)에 닿으면 칩이 그 앞에서 멈춘다 —
 * 델타를 스냅 한 칸씩 0 쪽으로 줄여 가장 가까이 갈 수 있는 값을 고른다. 칩 자신의 길이는 그대로다.
 * 이미 겹쳐 저장된 일정(칩의 원래 범위와 겹치는 것)은 밀지 않는다 — 새 겹침을 만들지 않는 규칙이지 옛 겹침을 고치는
 * 규칙이 아니다.
 */
export function planLinkedMove(
  events: readonly LinkableEvent[],
  key: string,
  deltaMin: number,
  /** 축의 끝 분 — 익일 구간이 있으면 24:00 보다 크다. 기본은 하루(예전 동작). */
  axisEndMin: number = DAY_MIN,
): { deltaMin: number; linked: { key: string; startMin: number; endMin: number }[] } {
  const head = events.find((e) => e.key === key);
  if (!head || deltaMin === 0) return { deltaMin, linked: [] };
  const down = deltaMin > 0;
  const others = events.filter((e) => e.key !== key);

  // 한 델타를 시뮬레이션한다 — 벽에 걸리면 null.
  const simulate = (d: number): { key: string; startMin: number; endMin: number }[] | null => {
    const hs = head.startMin + d;
    const he = head.endMin + d;
    const free = !head.locked && axisEndMin > DAY_MIN;
    const hb = free ? { lo: 0, hi: axisEndMin } : dayBoundsOf(head.startMin, axisEndMin);
    if (hs < hb.lo || he > hb.hi || (free && straddlesMidnight(hs, he))) return null;
    // 밀려나는 이웃은 자기 날을 벗어나지 못한다 — 날짜를 바꾸는 쓰기는 주 칩 하나만 한다(자정을 넘으려면 이웃 앞을 지나야 한다).
    const stays = (nb: LinkableEvent, s: number, e: number) => {
      const b = dayBoundsOf(nb.startMin, axisEndMin);
      return s >= b.lo && e <= b.hi;
    };
    const moved: { key: string; startMin: number; endMin: number }[] = [];
    if (down) {
      // 칩의 원래 끝 이후에 시작하는 이웃을 시작순으로 — 앞 가장자리가 닿으면 밀고, 간격이 남으면 거기서 끝.
      let frontier = he;
      const ahead = others.filter((e) => e.startMin >= head.endMin).sort((a, b) => a.startMin - b.startMin);
      for (const nb of ahead) {
        if (nb.startMin >= frontier) break;
        if (!nb.linkable) return null;
        const shift = frontier - nb.startMin;
        if (!stays(nb, nb.startMin + shift, nb.endMin + shift)) return null;
        moved.push({ key: nb.key, startMin: nb.startMin + shift, endMin: nb.endMin + shift });
        frontier = nb.endMin + shift;
      }
    } else {
      let frontier = hs;
      const behind = others.filter((e) => e.endMin <= head.startMin).sort((a, b) => b.endMin - a.endMin);
      for (const nb of behind) {
        if (nb.endMin <= frontier) break;
        if (!nb.linkable) return null;
        const shift = frontier - nb.endMin; // 음수
        if (!stays(nb, nb.startMin + shift, nb.endMin + shift)) return null;
        moved.push({ key: nb.key, startMin: nb.startMin + shift, endMin: nb.endMin + shift });
        frontier = nb.startMin + shift;
      }
    }
    return moved;
  };

  for (let d = deltaMin; down ? d > 0 : d < 0; d += down ? -SNAP_MIN : SNAP_MIN) {
    const moved = simulate(d);
    if (moved) return { deltaMin: d, linked: moved };
  }
  return { deltaMin: 0, linked: [] };
}

/**
 * 손잡이 리사이즈가 이웃에 미치는 영향 — 겹침을 만들지 않는다(오너 2026-10-27 "윗 블록 시간을 늘리면 아래 것이 줄어든다").
 * 끝 손잡이를 늘려 뒤 이웃의 시작과 겹치면 그 이웃의 **시작이 칩의 끝으로 따라오며 줄어든다**(시작 손잡이는 앞 이웃의
 * 끝이 반대로). 이웃은 `MIN_RESIZE_MIN` 아래로는 안 줄고, 거기서 칩의 가장자리가 멈춘다. 줄일 수 없는 이웃(여러 날
 * span, 끝 시각이 없는 행)은 벽이라 칩이 그 앞에서 멈춘다.
 *
 * 오너 요청(2026-09-16) 그대로 — **정확히 맞닿은 이음새**는 양쪽 다 반응한다: 칩이 줄어드는 방향이어도 이웃의 맞닿은
 * 면이 같이 따라와 이웃이 **늘어난다**(간격이 생기지 않는다). 이웃은 항상 하나뿐이다(이음새는 한 점).
 *
 * 이웃을 못 찾으면 `next` 그대로, 연동은 빈 배열이다.
 *
 * mode "start"(위 손잡이) — 이웃은 **앞쪽**(그 `endMin` 이 칩의 원래 `startMin` 이하인 것 중 가장 가까운 것).
 * 이웃의 `end_time` 을 쓰게 되므로 `hasEnd` 가 false 인 이웃은 줄일 수 없다 — 안 그러면 끝이 없던 행에 없던 끝을
 * 지어내게 된다(commitDateRow 의 patch 콜백이 이 값을 그대로 쓴다).
 *
 * mode "end"(아래 손잡이) — 이웃은 **뒤쪽**(그 `startMin` 이 칩의 원래 `endMin` 이상인 것 중 가장 가까운 것).
 * 이웃의 `start_time` 을 쓰는데, 축에 그려진 시각 있는 항목은 전부 `start_time` 이 있으므로 hasEnd 가드가 필요 없다.
 */
export function planLinkedResize(
  events: readonly LinkableEvent[],
  key: string,
  mode: "start" | "end",
  next: { startMin: number; endMin: number },
): { next: { startMin: number; endMin: number }; linked: { key: string; startMin: number; endMin: number }[] } {
  const head = events.find((e) => e.key === key);
  if (!head) return { next, linked: [] };
  // 이웃은 같은 날 안에서만 — 자정 너머의 일정은 이음새를 따라 줄이거나 늘리지 않는다(그러면 일정이 자정을 가로지른다).
  const sameDay = (m: number) => (m >= DAY_MIN) === (head.startMin >= DAY_MIN);
  const others = events.filter((e) => e.key !== key && sameDay(e.startMin));
  if (mode === "start") {
    const nb = others.filter((e) => e.endMin <= head.startMin).sort((a, b) => b.endMin - a.endMin)[0];
    if (!nb) return { next, linked: [] };
    const touching = nb.endMin === head.startMin;
    if (!touching && next.startMin >= nb.endMin) return { next, linked: [] }; // 겹치지 않는다
    const shrinkable = nb.linkable && nb.hasEnd !== false;
    if (!shrinkable) {
      // 벽 — 맞닿아 있던 이음새는 연동 없이 그대로 두되(옛 동작), 넘어서 겹치지는 못한다.
      return { next: { startMin: Math.max(next.startMin, nb.endMin), endMin: next.endMin }, linked: [] };
    }
    const startMin = Math.max(next.startMin, nb.startMin + MIN_RESIZE_MIN);
    return {
      next: { startMin, endMin: next.endMin },
      linked: [{ key: nb.key, startMin: nb.startMin, endMin: startMin }],
    };
  }
  const nb = others.filter((e) => e.startMin >= head.endMin).sort((a, b) => a.startMin - b.startMin)[0];
  if (!nb) return { next, linked: [] };
  const touching = nb.startMin === head.endMin;
  if (!touching && next.endMin <= nb.startMin) return { next, linked: [] };
  if (!nb.linkable) {
    return { next: { startMin: next.startMin, endMin: Math.min(next.endMin, nb.startMin) }, linked: [] };
  }
  const endMin = Math.min(next.endMin, nb.endMin - MIN_RESIZE_MIN);
  return {
    next: { startMin: next.startMin, endMin },
    linked: [{ key: nb.key, startMin: endMin, endMin: nb.endMin }],
  };
}

/**
 * 축의 빈 곳을 세로로 끈 결과 범위(②). 두 Y 는 축 컨테이너 기준 픽셀. 임계 미만이면 null —
 * 그냥 클릭이므로 **아무것도 만들지 않는다**. 최소 길이는 MIN_SLOT_MIN.
 */
export function planNewRange(
  y0: number,
  y1: number,
  hourRowH: number = HOUR_ROW_H,
  /** 축의 끝 분 — 익일 구간이 있으면 24:00 보다 크다. */
  axisEndMin: number = DAY_MIN,
): { startMin: number; endMin: number } | null {
  if (Math.abs(y1 - y0) < DRAG_THRESHOLD_PX) return null;
  const pxPerMin = hourRowH / 60;
  const bounds = { lo: 0, hi: axisEndMin };
  const lo = snapMin(Math.min(y0, y1) / pxPerMin, undefined, bounds);
  const hi = snapMin(Math.max(y0, y1) / pxPerMin, undefined, bounds);
  let startMin = Math.min(lo, axisEndMin - MIN_SLOT_MIN);
  let endMin = Math.max(hi, startMin + MIN_SLOT_MIN);
  if (straddlesMidnight(startMin, endMin)) {
    // 새 일정은 시작한 날 안에서 끝난다 — 자정에서 자른다(시작이 너무 늦으면 앞으로 당겨 30분을 지킨다).
    startMin = Math.min(startMin, DAY_MIN - MIN_SLOT_MIN);
    endMin = DAY_MIN;
  }
  return { startMin, endMin };
}

/** 현재 시각 눈금의 픽셀 위치(③) — 보고 있는 날이 **오늘**일 때만. 다른 날이면 null(눈금 없음). */
export function nowLineTop(
  day: string,
  todayIso: string,
  minutesNow: number,
  hourRowH: number = HOUR_ROW_H,
): number | null {
  if (day !== todayIso) return null;
  const pxPerMin = hourRowH / 60;
  return Math.max(0, Math.min(DAY_MIN, minutesNow)) * pxPerMin;
}

// ── 축 확대 (PLAN-2026-09-13 달력 확대) ──────────────────────────────────────────────────────
// TimeAxis 가 가진 로컬 스케일(hourRowH, 기본 HOUR_ROW_H)에 맞춰 시간 라벨을 몇 분 단위로
// 그릴지 정하는 순수 함수. 축의 wheel 핸들러(Ctrl/Cmd+wheel 로 hourRowH 를 바꾸는 것)와 커서
// 중심 재조정(스크롤 유지)은 DOM(scrollTop)을 직접 다루므로 DayDetailPanel.tsx 의 TimeAxis 안에
// 산다 — 이 파일은 순수 산수만 갖는다(같은 원칙, calendarLayout.ts 상단 주석).

/** 그 레벨의 눈금 간 실제 픽셀 간격이 이 미만이면 라벨이 겹치므로 그 레벨로 넘어가지 않는다. */
const TICK_MIN_GAP_PX = 20;

/**
 * 스케일(시간당 px)에 맞는 시간 라벨 세분화 레벨 — 60→30→15→5분 4단.
 * 그 레벨의 눈금 간격(`hourRowH * level / 60`)이 TICK_MIN_GAP_PX 미만이면 그 레벨로 넘어가지
 * 않는다(라벨 겹침 방지). 5분보다 촘촘한 레벨은 없다(요구사항 상한) — MAX_HOUR_ROW_H(240)에서
 * 정확히 20px(240*5/60)이 되도록 골랐으므로 그 근방에서만 5분 단위가 나온다.
 */
export function tickIntervalMinFor(hourRowH: number): 60 | 30 | 15 | 5 {
  const levels: readonly (60 | 30 | 15 | 5)[] = [60, 30, 15, 5];
  let level: 60 | 30 | 15 | 5 = 60;
  for (const l of levels) {
    const gapPx = (hourRowH * l) / 60;
    if (gapPx < TICK_MIN_GAP_PX) break;
    level = l;
  }
  return level;
}

// ── 종일 카드를 축으로 끌어다 놓아 시각을 얹기 (PLAN-2026-09-10 달력 W7) ─────────────────────

/**
 * 이 **행**이 하루짜리인가 — 종료 트리플이 비었거나 시작 트리플과 같으면 하루다.
 *
 * 화면 항목의 `span_start`/`span_end` 로는 이 판정을 할 수 없다(월 경계로 클리핑된 값이다).
 * 여러 날 span 의 `end_time` 은 **마지막 날**의 시각이라(§1.3 I3) 하루짜리가 아닌 행의 끝 시각을
 * 이 날의 값으로 쓰면 남의 날짜를 망친다 — keepDurationMin 의 `sameDay` 가 이 함수의 결과다.
 */
export function rowIsSameDay(
  row: Pick<NoteDate, "year" | "month" | "day" | "end_year" | "end_month" | "end_day">,
): boolean {
  return (
    (row.end_year === null && row.end_month === null && row.end_day === null) ||
    (row.end_year === row.year && row.end_month === row.month && row.end_day === row.day)
  );
}

/** 드롭이 갈아끼우는 필드. `note_date_update` 는 전량 교체라 호출자가 나머지 필드(remind·
 *  offset·rrule)는 행 값 그대로 얹어 보낸다. */
export type DroppedTimes = Pick<
  NoteDate,
  "year" | "month" | "day" | "end_year" | "end_month" | "end_day" | "start_time" | "end_time"
>;

/**
 * 종일 목록의 카드를 축의 `startMin` 자리에 놓았을 때 그 **행**에 무엇을 쓰는가.
 * 판정 기준은 화면 항목이 아니라 `note_dates_list` 로 읽은 진짜 행이다(함정 ⓑ).
 * 행의 모양에 따라 셋으로 갈린다(오너 결정 2026-09-10):
 *
 *  ⓐ **정밀도 낮음**(month 또는 day 가 null) → 놓은 날로 **날짜를 확정**하고 종료 트리플을 비운다.
 *     특정 날의 축에 놓았다는 제스처 자체가 "이 날 이 시각"이라는 뜻이므로 정밀도는 거부의 사유가
 *     아니라 이 제스처가 만들어 주는 것이다. (I1 도 시각에 day 정밀도를 요구한다.)
 *  ⓑ **날짜 있는 하루짜리** → 시각만 얹는다. 날짜 트리플은 손대지 않는다.
 *  ⓒ **여러 날 span** → **시작 시각만**. 범위를 하루로 접으면 사용자가 만든 기간이 조용히
 *     사라지고, 그 행의 `end_time` 은 마지막 날의 시각이라 여기서 쓰면 남의 날짜를 망친다.
 *     ponytail: span 의 **중간 날** 축에 놓아도 고쳐지는 것은 (행이 하나뿐이므로) 첫날의 시작
 *     시각이다 — "이 날만의 시각"을 담을 자리가 스키마에 없다. 그 구분이 필요해지면 그때
 *     그 날짜의 관련 행을 따로 만드는 쪽으로 올린다(행을 쪼개는 결정이라 여기서 못 한다).
 *
 * 길이는 축의 기존 규칙대로 MIN_SLOT_MIN — 다만 끝이 자정을 넘으면 "00:00" 이 되어 I3
 * (같은 날이면 start <= end)에 걸리므로 23:59 로 눌러 둔다.
 */
/**
 * 저장할 끝 시각(분)의 상한. `formatHhmm(1440)` 은 `"00:00"` 이라 같은 날 행에서 start 보다
 * 앞서게 되고, I3(같은 날이면 start ≤ end, `repo/notes/dates.rs`)가 그 쓰기를 거절한다 —
 * 거절은 토스트도 없이 "시각만 안 붙은 노트"로 보였다. 자정은 23:59 로 눌러 저장한다.
 * 축 바닥에서 만드는 경로(CalendarTab::onCreateTimedNote)와 드롭이 **같은 규칙**을 쓴다.
 */
export function clampStoredEndMin(min: number): number {
  return Math.min(min, DAY_MIN - 1);
}

export function planAllDayDrop(row: NoteDate, dayIso: string, startMin: number): DroppedTimes | null {
  const dropped = parseIsoDay(dayIso);
  if (!dropped) return null;
  const startTime = formatHhmm(startMin);
  const endTime = formatHhmm(clampStoredEndMin(startMin + MIN_SLOT_MIN));

  if (row.month === null || row.day === null) {
    return {
      year: dropped.year,
      month: dropped.month,
      day: dropped.day,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: startTime,
      end_time: endTime,
    };
  }
  const dates = {
    year: row.year,
    month: row.month,
    day: row.day,
    end_year: row.end_year,
    end_month: row.end_month,
    end_day: row.end_day,
  };
  return rowIsSameDay(row)
    ? { ...dates, start_time: startTime, end_time: endTime }
    : { ...dates, start_time: startTime, end_time: row.end_time };
}

/** Parse YYYY-MM-DD → { year, month (1-12), day }. Null if malformed. */
export function parseIsoDay(iso: string): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}

/** Inclusive ISO day range as ordered [start, end]. */
export function orderIsoRange(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

