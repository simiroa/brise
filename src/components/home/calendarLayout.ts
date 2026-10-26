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
// title. Owner revision (2026-08-09): overlapping chips keep FULL width and stack vertically
// instead — pushed straight down under whatever chip is directly above them.

/** Time label column: 2-digit hour + breathing room. */
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
/** Vertical gap between two stacked (pushed-down) chips — owner's "0~2px" tolerance, picked once. */
export const STACK_GAP_PX = 2;
/** Shortest visible block: an event with no end (or a sub-30m one) still needs a readable title. */
export const MIN_SLOT_MIN = 30;
/** Scroll target when the day has no timed item to scroll to. */
export const DEFAULT_SCROLL_HOUR = 8;

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
  /** Half-open end, already clamped to >= startMin + MIN_SLOT_MIN and to end of day. */
  endMin: number;
  /** Pixel top within the axis. Equal to the time-derived position unless a near-time chip above
   *  it pushed it down (vertical stacking sweep in planTimedDay). */
  top: number;
  /** Pixel height, always duration-true (endMin - startMin) — a pushed chip is moved, never
   *  squeezed. */
  height: number;
};

export type TimedDayPlan = {
  /** start_time-bearing items that actually start on this day, time-ordered and vertically packed
   *  so no two ever overlap on screen (no cap/"+n" anymore — nothing is hidden, see §6.2). */
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
 * 겹치는 칩을 아래로 미는 스태킹 스윕 — planTimedDay 가 하던 것을 뽑아냈다(2026-09-13 축 확대).
 * **`hourRowH` 별로 다시 돌 수 있어야** 한다: TimeAxis 가 로컬 확대 상태를 가지므로, 부모
 * (DayDetailBody)는 기본 스케일로 한 번 `planTimedDay`를 부르고, 축은 사용자가 휠로 스케일을
 * 바꿀 때마다 이미 시각순으로 정렬된 `plan.timed`를 이 함수에 다시 넣어 그 스케일의 top/height
 * 만 다시 얻는다(정렬은 다시 하지 않는다 — 매 렌더 다시 돌 비용을 아낀다). 전역 싱글턴 스케일을
 * 두지 않기 위한 구조: 스케일은 오직 이 함수의 인자로만 들어온다.
 *
 * 입력은 **이미 시각순으로 정렬돼 있다고 믿는다** — planTimedDay 의 정렬 순서 그대로다.
 */
export function layoutTimedEvents(
  sortedEvents: readonly { startMin: number; endMin: number }[],
  hourRowH: number = HOUR_ROW_H,
): { top: number; height: number }[] {
  const dayAxisH = hourRowH * 24;
  let floor = -Infinity;
  const out: { top: number; height: number }[] = [];
  for (const e of sortedEvents) {
    const nativeTop = (e.startMin / (24 * 60)) * dayAxisH;
    const height = ((e.endMin - e.startMin) / (24 * 60)) * dayAxisH;
    const top = Math.max(nativeTop, floor);
    floor = top + height + STACK_GAP_PX;
    out.push({ top, height });
  }
  return out;
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
    const rawEnd = rowIsSameDay(item) ? parseHhmm(item.end_time) : null;
    const endMin = Math.min(
      24 * 60,
      Math.max(rawEnd ?? 0, startMin + MIN_SLOT_MIN),
    );
    timed.push({ key: itemKey(item), item, startMin, endMin, top: 0, height: 0 });
  }

  timed.sort((a, b) => a.startMin - b.startMin || a.key.localeCompare(b.key));

  const layout = layoutTimedEvents(timed, hourRowH);
  timed.forEach((e, i) => {
    e.top = layout[i].top;
    e.height = layout[i].height;
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
 * **함정 ⓐ: 화면 `top` 은 시간이 아니다.** planTimedDay 의 스태킹 스윕은 겹치는 칩을 아래로
 * 밀어서 배치한다(`e.top = Math.max(nativeTop, floor)`). 그래서 top 에서 시각을 역산하면 밀린
 * 픽셀만큼 시각이 틀어진다 — 이 함수는 **`startMin` + 픽셀델타**만 본다. 호출자도 top 을
 * 넘기지 마라("화면 top 쓰면 되잖아"로 되돌리기 딱 좋은 자리다).
 *
 * `durationMin` 이 있으면 **길이를 유지**한 채 자정을 넘지 않도록 시작을 clamp 한다. 길이가
 * 없으면 상한은 23:45 — 15분 격자에서 23:59 를 넘지 않는 마지막 칸이다.
 */
export function snapStartMin(
  startMin: number,
  deltaPx: number,
  durationMin = 0,
  hourRowH: number = HOUR_ROW_H,
): number {
  const pxPerMin = hourRowH / 60;
  const snapped = Math.round((startMin + deltaPx / pxPerMin) / SNAP_MIN) * SNAP_MIN;
  const maxStart = 24 * 60 - Math.max(durationMin, SNAP_MIN);
  return Math.max(0, Math.min(maxStart, snapped));
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

/** 손잡이 두께(px). 고정 6px 이면 가장 짧은 칩(MIN_SLOT_MIN = 30분 → 14px)에서 가운데(이동)가
 *  거의 사라진다 — 그래서 높이의 1/3 이 상한이다. */
export function handleThicknessPx(height: number): number {
  return Math.min(6, height / 3);
}

/**
 * 포인터가 칩의 어디를 잡았나 — 위 가장자리 = 시작, 아래 가장자리 = 끝, 나머지 = 이동.
 *
 * `resizable` 은 **그 날 안에서 끝나는 행**(rowIsSameDay — 월 경계로 잘린 span_start === span_end
 * 가 아니다. 10/31→11/2 는 10월 조회에서 [10/31, 10/31] 로 잘려 하루처럼 보인다)만 true 다. 여러 날 span 의
 * `end_time` 은 마지막 날의 시각이라(§1.3 I3) 이 날의 끝이 아니고 — keepDurationMin 이 이미 같은
 * 이유로 0 을 돌려준다 — 여기서 끌게 하면 **다른 날의 시각**을 조용히 바꾼다. 높이가 0 이면
 * (레이아웃 전 · jsdom) 잡을 손잡이 자체가 없으니 이동이다.
 */
export function chipDragMode(offsetY: number, height: number, resizable: boolean): ChipDragMode {
  if (!resizable || height <= 0) return "move";
  const h = handleThicknessPx(height);
  if (offsetY <= h) return "start";
  if (offsetY >= height - h) return "end";
  return "move";
}

/** 15분 격자 반올림 + 하루 안으로 clamp. */
function snapMin(min: number): number {
  return Math.max(0, Math.min(24 * 60, Math.round(min / SNAP_MIN) * SNAP_MIN));
}

/**
 * 드래그 한 번의 결과 시각. 무엇이 고정인지가 mode 마다 다르다 —
 * move 는 길이 유지(함정 ⓐ 그대로 `startMin` + 픽셀델타), start 는 끝 고정, end 는 시작 고정.
 * 어느 쪽도 **MIN_SLOT_MIN 보다 짧아지지 않는다**(시작이 끝을 넘지도, 끝이 시작 아래로 가지도).
 */
export function dragTimes(
  mode: ChipDragMode,
  base: { startMin: number; endMin: number; durationMin: number },
  deltaPx: number,
  hourRowH: number = HOUR_ROW_H,
): { startMin: number; endMin: number } {
  const pxPerMin = hourRowH / 60;
  const deltaMin = deltaPx / pxPerMin;
  if (mode === "start") {
    return {
      startMin: Math.min(base.endMin - MIN_SLOT_MIN, snapMin(base.startMin + deltaMin)),
      endMin: base.endMin,
    };
  }
  if (mode === "end") {
    return {
      startMin: base.startMin,
      endMin: Math.max(base.startMin + MIN_SLOT_MIN, snapMin(base.endMin + deltaMin)),
    };
  }
  const startMin = snapStartMin(base.startMin, deltaPx, base.durationMin, hourRowH);
  return { startMin, endMin: startMin + (base.endMin - base.startMin) };
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
};

/**
 * 옮기는 칩(`key`)과 **정확히 맞닿은**(gap 0) 이웃들의 새 자리 — 같은 델타만큼 따라 움직인다.
 * 반환에 자신은 없다(호출자가 이미 갖고 있다).
 *
 * **이동 방향으로만** 따라간다(아래로 끌면 내 끝에 붙은 것들, 위로 끌면 내 시작에 붙은 것들) —
 * 뒤쪽에 간격이 생기는 것은 허용한다. 양방향으로 모으면 하루가 촘촘한 날에 칩 하나를 건드리는
 * 순간 그 날 전체가 딸려 온다.
 *
 * 탐색은 너비 우선 한 벌이다(체인 A-B-C 전부). 같은 경계에 둘이 붙어 있으면(스택된 항목) 둘 다
 * 모은다. **방문한 키는 다시 보지 않는다** — 무한 루프 방지이자, 연동에서 빠진 이웃(아래 둘)을
 * 두 번 판정하지 않는 자리다.
 *
 * 이웃이 빠지는 두 경우 — 그 자리에서 맞닿음이 끊기고(그 뒤의 체인도 따라오지 않는다) 간격이
 * 생기는 것을 허용한다:
 *  ⓐ `linkable` 이 false (여러 날 span)
 *  ⓑ 델타를 얹으면 하루를 벗어난다(자정 넘기기)
 */
export function planLinkedMove(
  events: readonly LinkableEvent[],
  key: string,
  deltaMin: number,
): { key: string; startMin: number; endMin: number }[] {
  if (deltaMin === 0) return [];
  const head = events.find((e) => e.key === key);
  if (!head) return [];
  const down = deltaMin > 0;
  const seen = new Set([key]);
  const moved: { key: string; startMin: number; endMin: number }[] = [];
  const queue: LinkableEvent[] = [head];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of events) {
      if (seen.has(nb.key)) continue;
      if (down ? nb.startMin !== cur.endMin : nb.endMin !== cur.startMin) continue;
      seen.add(nb.key);
      if (!nb.linkable) continue; // ⓐ
      const startMin = nb.startMin + deltaMin;
      const endMin = nb.endMin + deltaMin;
      if (startMin < 0 || endMin > 24 * 60) continue; // ⓑ
      moved.push({ key: nb.key, startMin, endMin });
      queue.push(nb);
    }
  }
  return moved;
}

/**
 * 오너 요청(2026-09-16) — 맞닿은 이음새를 손잡이로 끌면 **양쪽 다** 반응한다: 끝을 늘리면
 * 뒤에 붙은 이웃의 시작이 같이 밀리고, 시작을 당기면 앞에 붙은 이웃의 끝이 같이 밀린다. 이웃은
 * **하나뿐**이다 — planLinkedMove 처럼 체인을 잇지 않는다(이음새는 두 칩이 만나는 한 점이지,
 * 이동처럼 여러 칩이 줄줄이 따라올 이유가 없다). `next` 는 dragTimes 가 이미 자기 자신의
 * MIN_SLOT_MIN 으로 clamp 한 값 — 여기서는 **이웃이 그 이하로 줄지 않게** 한 번 더 죈다.
 *
 * 이웃을 못 찾으면(맞닿은 게 없거나, 있어도 조건에 안 맞으면) `next` 그대로 돌려주고 연동은
 * 빈 배열이다.
 *
 * mode "start"(위 손잡이) — 이웃은 **앞쪽**(그 `endMin` 이 이 칩의 원래 `startMin` 과 같다).
 * 이웃의 `end_time` 을 쓰게 되므로 `hasEnd` 가 false 인 이웃은 아예 후보에서 뺀다 — 안 그러면
 * 끝이 없던 행에 없던 끝을 지어내게 된다(commitDateRow 의 patch 콜백이 이 값을 그대로 쓴다).
 *
 * mode "end"(아래 손잡이) — 이웃은 **뒤쪽**(그 `startMin` 이 이 칩의 원래 `endMin` 과 같다).
 * 이웃의 `start_time` 을 쓰는데, 축에 그려진 시각 있는 항목은 전부 `start_time` 이 있으므로
 * (planTimedDay) 여기는 hasEnd 류 가드가 필요 없다.
 */
export function planLinkedResize(
  events: readonly LinkableEvent[],
  key: string,
  mode: "start" | "end",
  next: { startMin: number; endMin: number },
): { next: { startMin: number; endMin: number }; linked: { key: string; startMin: number; endMin: number }[] } {
  const head = events.find((e) => e.key === key);
  if (!head) return { next, linked: [] };
  if (mode === "start") {
    const neighbor = events.find(
      (e) => e.key !== key && e.linkable && e.hasEnd !== false && e.endMin === head.startMin,
    );
    if (!neighbor) return { next, linked: [] };
    const startMin = Math.max(next.startMin, neighbor.startMin + MIN_SLOT_MIN);
    return {
      next: { startMin, endMin: next.endMin },
      linked: [{ key: neighbor.key, startMin: neighbor.startMin, endMin: startMin }],
    };
  }
  const neighbor = events.find((e) => e.key !== key && e.linkable && e.startMin === head.endMin);
  if (!neighbor) return { next, linked: [] };
  const endMin = Math.min(next.endMin, neighbor.endMin - MIN_SLOT_MIN);
  return {
    next: { startMin: next.startMin, endMin },
    linked: [{ key: neighbor.key, startMin: endMin, endMin: neighbor.endMin }],
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
): { startMin: number; endMin: number } | null {
  if (Math.abs(y1 - y0) < DRAG_THRESHOLD_PX) return null;
  const pxPerMin = hourRowH / 60;
  const lo = snapMin(Math.min(y0, y1) / pxPerMin);
  const hi = snapMin(Math.max(y0, y1) / pxPerMin);
  const startMin = Math.min(lo, 24 * 60 - MIN_SLOT_MIN);
  return { startMin, endMin: Math.max(hi, startMin + MIN_SLOT_MIN) };
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
  return Math.max(0, Math.min(24 * 60, minutesNow)) * pxPerMin;
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
  return Math.min(min, 24 * 60 - 1);
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

