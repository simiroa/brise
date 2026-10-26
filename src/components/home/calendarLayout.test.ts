import { describe, it, expect } from "vitest";
import type { CalendarItem, NoteDate } from "../../lib/commands.gen";
import {
  itemCoversDay,
  itemsForDay,
  spanRole,
  buildCellLines,
  parseIsoDay,
  orderIsoRange,
  assignWeekSpanTracks,
  assignTracks,
  planDayCell,
  planTimedDay,
  collapseOccurrencesForDay,
  spanTrackKey,
  buildMonthDayPlans,
  itemKey,
  MIN_SLOT_MIN,
  DAY_AXIS_H,
  STACK_GAP_PX,
  HOUR_ROW_H,
  PX_PER_MIN,
  SNAP_MIN,
  snapStartMin,
  keepDurationMin,
  formatHhmm,
  parseHhmm,
  chipDragMode,
  handleThicknessPx,
  dragTimes,
  planNewRange,
  planAllDayDrop,
  rowIsSameDay,
  planLinkedMove,
  planLinkedResize,
  nowLineTop,
  DRAG_THRESHOLD_PX,
  buildCalendarGridCustom,
  tickIntervalMinFor,
  layoutTimedEvents,
  MIN_HOUR_ROW_H,
  MAX_HOUR_ROW_H,
} from "./calendarLayout";

function item(partial: Partial<CalendarItem> & Pick<CalendarItem, "note_id" | "kind" | "span_start" | "span_end">): CalendarItem {
  // 행 트리플의 기본값은 span 에서 유도한다 — 서버가 주는 모양 그대로(잘리지 않은 항목은 시작
  // 트리플 = span_start, 여러 날이면 종료 트리플 = span_end). 축 판정(startsOnDay·rowIsSameDay)이
  // 이 트리플을 읽으므로, 엉뚱한 기본값이면 테스트가 실데이터에 없는 항목을 검사하게 된다.
  // 월 경계로 잘린 항목은 테스트가 트리플을 직접 넘긴다.
  const s = parseIsoDay(partial.span_start);
  const e = partial.span_end !== partial.span_start ? parseIsoDay(partial.span_end) : null;
  return {
    folder_id: partial.folder_id ?? "f1",
    title: partial.title ?? partial.note_id,
    year: s?.year ?? 2026,
    month: s?.month ?? 7,
    day: s?.day ?? 1,
    end_year: e?.year ?? null,
    end_month: e?.month ?? null,
    end_day: e?.day ?? null,
    start_time: partial.start_time ?? null,
    end_time: partial.end_time ?? null,
    is_occurrence: partial.is_occurrence ?? null,
    remind: partial.remind ?? false,
    // date_id 는 itemKey 의 축이므로 기본값이 항목마다 달라야 한다(§D4).
    date_id: partial.date_id ?? `d-${partial.note_id}`,
    position: partial.position ?? 0,
    remind_offset_min: partial.remind_offset_min ?? null,
    rrule: partial.rrule ?? null,
    ...partial,
  };
}

describe("calendarLayout", () => {
  it("itemCoversDay uses inclusive span", () => {
    const span = item({
      note_id: "s1",
      kind: "span",
      span_start: "2026-07-12",
      span_end: "2026-07-15",
    });
    expect(itemCoversDay(span, "2026-07-11")).toBe(false);
    expect(itemCoversDay(span, "2026-07-12")).toBe(true);
    expect(itemCoversDay(span, "2026-07-14")).toBe(true);
    expect(itemCoversDay(span, "2026-07-15")).toBe(true);
    expect(itemCoversDay(span, "2026-07-16")).toBe(false);
  });

  it("spanRole marks start/mid/end/single", () => {
    const multi = item({
      note_id: "s1",
      kind: "span",
      span_start: "2026-07-12",
      span_end: "2026-07-15",
    });
    expect(spanRole(multi, "2026-07-12")).toBe("st");
    expect(spanRole(multi, "2026-07-13")).toBe("mid");
    expect(spanRole(multi, "2026-07-15")).toBe("en");
    const single = item({
      note_id: "s2",
      kind: "span",
      span_start: "2026-07-20",
      span_end: "2026-07-20",
    });
    expect(spanRole(single, "2026-07-20")).toBe("single");
  });

  it("buildCellLines orders spans → events (due_at retired 2026-08-01 — no separate 'due' kind)", () => {
    const items: CalendarItem[] = [
      item({ note_id: "e1", kind: "event", span_start: "2026-07-12", span_end: "2026-07-12", title: "Event" }),
      item({ note_id: "s1", kind: "span", span_start: "2026-07-12", span_end: "2026-07-15", title: "Span" }),
    ];
    const lines = buildCellLines(items, "2026-07-12");
    expect(lines.map((l) => l.kind)).toEqual(["span", "event"]);
  });

  // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): the deadline/urgency display model
  // (⏰/red on a span's terminal day) is retired app-wide — a span carries no per-line deadline
  // state at all anymore, regardless of how far in the past its end date is.
  it("a span segment carries no deadline/urgency state, however far past its end date", () => {
    const longExpired = item({
      note_id: "d4",
      kind: "span",
      span_start: "2026-05-01",
      span_end: "2026-06-01",
      end_year: 2026,
      end_month: 6,
      end_day: 1,
      title: "Long past",
    });
    const line = buildCellLines([longExpired], "2026-06-01").find((l) => l.item.note_id === "d4");
    expect(line).toMatchObject({ kind: "span", role: "en" });
    expect(line).not.toHaveProperty("deadline");
  });

  // dashboard/5bc2be60-integrate QA: overlapping period notes must stack onto distinct tracks
  // (greedy), and a note's track must stay the same on every day it covers within one week (or
  // the bar's vertical slot kinks as siblings enter/leave the day's set).
  describe("assignWeekSpanTracks", () => {
    const week = [
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
    ];

    it("gives non-overlapping spans the same track (0)", () => {
      const a = item({ note_id: "a", kind: "span", span_start: "2026-07-12", span_end: "2026-07-13" });
      const b = item({ note_id: "b", kind: "span", span_start: "2026-07-14", span_end: "2026-07-16" });
      const tracks = assignWeekSpanTracks([a, b], week);
      expect(tracks.get("a")).toBe(0);
      expect(tracks.get("b")).toBe(0);
    });

    it("bumps a later-overlapping span to the next free track (greedy stacking)", () => {
      // a: Sun-Tue, b: Mon-Thu (overlaps a on Mon/Tue) → b must not share a's track.
      const a = item({ note_id: "a", kind: "span", span_start: "2026-07-12", span_end: "2026-07-14" });
      const b = item({ note_id: "b", kind: "span", span_start: "2026-07-13", span_end: "2026-07-16" });
      // c starts after both end → free to reuse track 0.
      const c = item({ note_id: "c", kind: "span", span_start: "2026-07-17", span_end: "2026-07-18" });
      const tracks = assignWeekSpanTracks([a, b, c], week);
      expect(tracks.get("a")).toBe(0);
      expect(tracks.get("b")).toBe(1);
      expect(tracks.get("c")).toBe(0);
    });

    it("assigns a track for every day-slice a week-crossing span touches, independently per week", () => {
      // A single note spanning three weeks: only its first/last days differ per week's clip.
      const long = item({ note_id: "long", kind: "span", span_start: "2026-07-10", span_end: "2026-07-20" });
      const week1 = ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"];
      const week2 = week; // 2026-07-12..18, fully inside the span
      const week3 = ["2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"];
      // A second note only overlaps week2, forcing "long" off track 0 there (it sorts first by
      // clipped start day, ties broken by note_id — "aaa" < "long") — proving tracks are scoped
      // per week (no shared numbering requirement across the row boundary) while the item still
      // gets a valid, present track in every week it touches.
      const other = item({ note_id: "aaa", kind: "span", span_start: "2026-07-12", span_end: "2026-07-13" });
      expect(assignWeekSpanTracks([long], week1).get("long")).toBe(0);
      expect(assignWeekSpanTracks([long, other], week2).get("long")).toBe(1);
      expect(assignWeekSpanTracks([long, other], week2).get("aaa")).toBe(0);
      expect(assignWeekSpanTracks([long], week3).get("long")).toBe(0);
    });

    it("ignores items that don't overlap the week and event-kind items", () => {
      const outside = item({ note_id: "out", kind: "span", span_start: "2026-08-01", span_end: "2026-08-02" });
      const ev = item({ note_id: "ev", kind: "event", span_start: "2026-07-12", span_end: "2026-07-12" });
      const tracks = assignWeekSpanTracks([outside, ev], week);
      expect(tracks.size).toBe(0);
    });
  });

  // dashboard/5bc2be60-integrate QA follow-up: spans used to render uncapped ("the green bar
  // wall") — planDayCell caps spans + events under ONE MAX_CELL_LINES budget.
  describe("planDayCell", () => {
    it("hides spans past the week-stable track budget and counts them in overflow", () => {
      // 4 spans all overlapping the same day → greedy tracks 0,1,2,3. MAX_CELL_LINES=3 means
      // only tracks 0-2 are visible; track 3 is hidden.
      const items: CalendarItem[] = ["a", "b", "c", "d"].map((id) =>
        item({ note_id: id, kind: "span", span_start: "2026-07-12", span_end: "2026-07-12" }),
      );
      const week = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];
      const trackOf = assignWeekSpanTracks(items, week);
      expect(trackOf.get("d")).toBe(3); // sanity: 4th span pushed to track 3

      const plan = planDayCell(items, "2026-07-12", trackOf);
      expect(plan.visibleSpans.map((l) => l.item.note_id).sort()).toEqual(["a", "b", "c"]);
      expect(plan.overflow).toBe(1); // the hidden 4th span
    });

    it("folds hidden spans + hidden events into one combined overflow count", () => {
      const spans: CalendarItem[] = ["a", "b", "c", "d"].map((id) =>
        item({ note_id: id, kind: "span", span_start: "2026-07-12", span_end: "2026-07-12" }),
      );
      const events: CalendarItem[] = ["e1", "e2"].map((id) =>
        item({ note_id: id, kind: "event", span_start: "2026-07-12", span_end: "2026-07-12" }),
      );
      const items = [...spans, ...events];
      const week = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];
      const trackOf = assignWeekSpanTracks(items, week);

      const plan = planDayCell(items, "2026-07-12", trackOf);
      // 3 visible spans already fill the whole budget → 0 event slots left.
      expect(plan.visibleSpans.length).toBe(3);
      expect(plan.visibleEvents.length).toBe(0);
      // 1 hidden span + 2 hidden events = 3.
      expect(plan.overflow).toBe(3);
    });

    it("eventBudget is based on VISIBLE (post-cap) span rows, not the raw max track index", () => {
      // Single span sitting on track 2 (e.g. tracks 0/1 are occupied by items that don't cover
      // this particular day) — under the old "max track index" logic this would zero out the
      // event budget (2+1=3); the fix must reserve rows for what's actually rendered here.
      const span = item({ note_id: "s", kind: "span", span_start: "2026-07-12", span_end: "2026-07-12" });
      const events: CalendarItem[] = ["e1", "e2", "e3"].map((id) =>
        item({ note_id: id, kind: "event", span_start: "2026-07-12", span_end: "2026-07-12" }),
      );
      const trackOf = new Map([["s", 0]]);
      const plan = planDayCell([span, ...events], "2026-07-12", trackOf);
      expect(plan.visibleSpans.length).toBe(1); // 1 row reserved, not 3
      expect(plan.visibleEvents.length).toBe(2); // budget = 3 - 1 = 2
      expect(plan.overflow).toBe(1); // 1 hidden event
    });

    it("keeps spans/events under the budget fully visible with zero overflow", () => {
      const span = item({ note_id: "s", kind: "span", span_start: "2026-07-12", span_end: "2026-07-12" });
      const event = item({ note_id: "e", kind: "event", span_start: "2026-07-12", span_end: "2026-07-12" });
      const trackOf = new Map([["s", 0]]);
      const plan = planDayCell([span, event], "2026-07-12", trackOf);
      expect(plan.visibleSpans.length).toBe(1);
      expect(plan.visibleEvents.length).toBe(1);
      expect(plan.overflow).toBe(0);
    });
  });

  it("itemsForDay / parseIsoDay / orderIsoRange", () => {
    const items = [
      item({ note_id: "a", kind: "event", span_start: "2026-07-10", span_end: "2026-07-10" }),
      item({ note_id: "b", kind: "event", span_start: "2026-07-11", span_end: "2026-07-11" }),
    ];
    expect(itemsForDay(items, "2026-07-10").map((i) => i.note_id)).toEqual(["a"]);
    expect(parseIsoDay("2026-07-15")).toEqual({ year: 2026, month: 7, day: 15 });
    expect(parseIsoDay("bad")).toBeNull();
    expect(orderIsoRange("2026-07-20", "2026-07-12")).toEqual(["2026-07-12", "2026-07-20"]);
  });

  describe("buildCalendarGridCustom", () => {
    it("starts on Sunday when weekStart is sunday", () => {
      // August 2026: Aug 1 2026 is Saturday (UTC day 6).
      // Sunday start: padStart = 6 (Sun..Fri empty cells).
      const grid = buildCalendarGridCustom(2026, 7, "sunday");
      expect(grid[0]).toEqual({ day: null, dayOfMonth: null });
      expect(grid[5]).toEqual({ day: null, dayOfMonth: null });
      expect(grid[6]).toEqual({ day: "2026-08-01", dayOfMonth: 1 });
      expect(grid.length % 7).toBe(0);
    });

    it("starts on Monday when weekStart is monday", () => {
      // August 2026: Aug 1 2026 is Saturday (UTC day 6).
      // Monday start: padStart = (6 + 6) % 7 = 5 (Mon..Fri empty cells).
      const grid = buildCalendarGridCustom(2026, 7, "monday");
      expect(grid[0]).toEqual({ day: null, dayOfMonth: null });
      expect(grid[4]).toEqual({ day: null, dayOfMonth: null });
      expect(grid[5]).toEqual({ day: "2026-08-01", dayOfMonth: 1 });
      expect(grid.length % 7).toBe(0);
    });
  });

  // Schedule W5-5 (docs/PLAN-schedule-system.md §6.2). The week-span suite above is the safety net
  // for the generalization: assignWeekSpanTracks now delegates to assignTracks, so if the shared
  // packer regresses, those tests fail too.
  describe("assignTracks (shared packer)", () => {
    it("treats a span's end day as occupied but an event's end minute as free", () => {
      // Inclusive (day spans): 12..14 and 14..16 collide on the 14th.
      const days = assignTracks([
        { key: "a", start: "2026-07-12", end: "2026-07-14" },
        { key: "b", start: "2026-07-14", end: "2026-07-16" },
      ]);
      expect(days.get("b")).toBe(1);
      // Half-open (minutes): 09:00-10:00 then 10:00-11:00 share track 0.
      const mins = assignTracks(
        [
          { key: "a", start: 540, end: 600 },
          { key: "b", start: 600, end: 660 },
        ],
        { inclusiveEnd: false },
      );
      expect(mins.get("b")).toBe(0);
    });
  });

  describe("planTimedDay", () => {
    const timed = (id: string, start: string, end?: string, day = "2026-08-09") =>
      item({
        note_id: id,
        kind: "event",
        span_start: day,
        span_end: day,
        start_time: start,
        end_time: end ?? null,
      });

    it("splits on start_time and gives an end-less event the minimum slot", () => {
      const meeting = timed("m", "09:00", "10:30");
      const point = timed("p", "14:00");
      const allDay = item({
        note_id: "trip",
        kind: "span",
        span_start: "2026-08-01",
        span_end: "2026-08-12",
      });
      const plan = planTimedDay([meeting, point, allDay], "2026-08-09");
      expect(plan.timed.map((e) => e.item.note_id)).toEqual(["m", "p"]);
      expect(plan.allDay.map((i) => i.note_id)).toEqual(["trip"]);
      expect([plan.timed[0].startMin, plan.timed[0].endMin]).toEqual([540, 630]);
      expect(plan.timed[1].endMin - plan.timed[1].startMin).toBe(MIN_SLOT_MIN);
    });

    // Vertical stacking (owner revision 2026-08-09, §6.2 QA): a staircase offset let a near-time
    // chip (e.g. 09:00/09:05) fully cover the row below's title, failing "title always readable".
    // Overlapping chips now keep full width and stack: pushed straight under whatever is above.
    it("pushes a near-time overlapping chip below the one above it instead of narrowing it", () => {
      const plan = planTimedDay(
        [timed("a", "09:00", "10:00"), timed("b", "09:05", "10:05")],
        "2026-08-09",
      );
      const [a, b] = plan.timed;
      const topA = (540 / 1440) * DAY_AXIS_H;
      const heightA = (60 / 1440) * DAY_AXIS_H;
      expect(a.top).toBe(topA); // cluster's first chip sits exactly on its time coordinate
      expect(a.height).toBe(heightA);
      expect(b.top).toBe(a.top + a.height + STACK_GAP_PX); // pushed directly under a, not beside it
      expect(b.height).toBe((60 / 1440) * DAY_AXIS_H); // duration-true — a push moves it, never squeezes it
    });

    it("gives non-overlapping chips their exact time coordinate — no push", () => {
      const plan = planTimedDay(
        [timed("a", "09:00", "09:30"), timed("b", "11:00", "11:30")],
        "2026-08-09",
      );
      const [a, b] = plan.timed;
      expect(a.top).toBe((540 / 1440) * DAY_AXIS_H);
      expect(b.top).toBe((660 / 1440) * DAY_AXIS_H);
    });

    it("chains a push through an event whose OWN time doesn't overlap anything, when the pushed chip above it now covers its slot", () => {
      const plan = planTimedDay(
        [
          timed("a", "09:00", "10:00"), // 540-600
          timed("b", "09:30", "09:50"), // 570-590, overlaps a → pushed under a
          timed("c", "10:10", "10:30"), // 610-630, overlaps neither a's nor b's ORIGINAL time range
        ],
        "2026-08-09",
      );
      const [a, b, c] = plan.timed;
      const nativeTopC = (610 / 1440) * DAY_AXIS_H;
      expect(a.top).toBeLessThan(b.top); // sanity: b really did get pushed under a
      expect(c.top).toBeGreaterThan(nativeTopC); // c is pushed too, not left at its own time slot
      expect(c.top).toBe(b.top + b.height + STACK_GAP_PX); // ...chained straight off b's pushed bottom
    });

    it("stacks any number of same-time chips in sequence — no track cap or overflow anymore", () => {
      const plan = planTimedDay(
        ["a", "b", "c", "d", "e"].map((id) => timed(id, "09:00", "10:00")),
        "2026-08-09",
      );
      expect(plan.timed).toHaveLength(5);
      for (let i = 1; i < plan.timed.length; i++) {
        expect(plan.timed[i].top).toBe(
          plan.timed[i - 1].top + plan.timed[i - 1].height + STACK_GAP_PX,
        );
      }
      expect(plan.timed.every((e) => e.height === (60 / 1440) * DAY_AXIS_H)).toBe(true);
    });

    it("clamps a late event to the end of the day instead of overflowing the 24h axis", () => {
      const plan = planTimedDay([timed("late", "23:50")], "2026-08-09");
      expect(plan.timed[0].endMin).toBe(24 * 60);
    });

    // A timed multi-day span shows on the axis only on its own start day — end_time is the LAST
    // day's time (§1.3 I3), so "09:00" on a continuation day would be a plainly wrong label.
    it("puts a timed span's continuation days in the all-day strip", () => {
      const trip = item({
        note_id: "conf",
        kind: "span",
        span_start: "2026-08-09",
        span_end: "2026-08-11",
        start_time: "09:00",
        end_time: "17:00",
      });
      expect(planTimedDay([trip], "2026-08-09").timed.map((e) => e.item.note_id)).toEqual(["conf"]);
      // ...and its block is not stretched by the last day's end_time.
      expect(planTimedDay([trip], "2026-08-09").timed[0].endMin).toBe(540 + MIN_SLOT_MIN);
      const mid = planTimedDay([trip], "2026-08-10");
      expect(mid.timed).toEqual([]);
      expect(mid.allDay.map((i) => i.note_id)).toEqual(["conf"]);
    });

    // A repeating note contributes several items sharing one note_id — React keys and the track
    // map both need something unique per occurrence.
    it("keys occurrences of one repeating note apart", () => {
      const a = item({
        note_id: "n",
        kind: "event",
        span_start: "2026-08-09",
        span_end: "2026-08-09",
        start_time: "09:00",
        is_occurrence: true,
      });
      const b = item({
        note_id: "n",
        kind: "event",
        span_start: "2026-08-10",
        span_end: "2026-08-10",
        start_time: "09:00",
        is_occurrence: true,
      });
      expect(itemKey(a)).not.toBe(itemKey(b));
      expect(planTimedDay([a, b], "2026-08-09").timed).toHaveLength(1);
    });

    // 2026-10-18 회귀 — 매일 반복 + 회차 하나가 27일짜리(8/15~9/11, 23:22)인 행. 10월 조회에서
    // 9월에 시작한 회차는 전부 span_start 가 10/01 로 잘려 온다(calendar.rs::push_row). 잘린
    // span_start 를 "그 날 시작"으로 읽으면 10/01 축에 23:22 칩이 28개 쌓였다.
    describe("월 첫날로 잘린 항목 (span_start ≠ 행의 시작)", () => {
      const occ = (rawDay: string, spanEnd: string) => {
        const raw = parseIsoDay(rawDay)!;
        const end = parseIsoDay(spanEnd)!;
        return item({
          note_id: "daily",
          date_id: "row-daily",
          kind: "span",
          span_start: rawDay < "2026-10-01" ? "2026-10-01" : rawDay,
          span_end: spanEnd,
          year: raw.year,
          month: raw.month,
          day: raw.day,
          end_year: end.year,
          end_month: end.month,
          end_day: end.day,
          start_time: "23:22",
          is_occurrence: true,
          rrule: "FREQ=DAILY",
        });
      };

      it("ⓐ 지난달에 시작해 이어지는 회차는 1일 축에 오르지 않고, 1일에 시작한 회차만 오른다 (Q11: 하루 한 번)", () => {
        const continuing = occ("2026-09-28", "2026-10-25");
        const startsToday = occ("2026-10-01", "2026-10-28");
        const plan = planTimedDay([continuing, startsToday], "2026-10-01");
        expect(plan.timed.map((e) => e.item)).toEqual([startsToday]);
        expect(plan.timed[0].startMin).toBe(23 * 60 + 22);
        // Q11: 같은 행(date_id)의 회차 중 10-01에 시작하는 회차가 우선 선택되어 timed에 올랐으므로 allDay에는 남지 않는다.
        expect(plan.allDay).toEqual([]);
      });

      it("ⓐ 잘린 다일 시각 스팬(원래 9/28 09:00 시작)은 10/01 에 종일이다", () => {
        const trip = item({
          note_id: "trip",
          kind: "span",
          span_start: "2026-10-01",
          span_end: "2026-10-03",
          year: 2026,
          month: 9,
          day: 28,
          end_year: 2026,
          end_month: 10,
          end_day: 3,
          start_time: "09:00",
        });
        const plan = planTimedDay([trip], "2026-10-01");
        expect(plan.timed).toEqual([]);
        expect(plan.allDay).toEqual([trip]);
      });

      it("ⓑ 1일로 잘린 같은 행의 회차들도 itemKey 가 서로 다르다", () => {
        const keys = [
          occ("2026-09-27", "2026-10-24"),
          occ("2026-09-28", "2026-10-25"),
          occ("2026-10-01", "2026-10-28"),
        ].map(itemKey);
        expect(new Set(keys).size).toBe(3);
      });

      it("ⓑ 한 회차의 달별 조각은 키가 다르고(YearGrid 히트 유지), 같은 조각 두 번은 같다(중복 제거)", () => {
        const base = {
          note_id: "trip",
          date_id: "row-trip",
          kind: "span",
          year: 2026,
          month: 10,
          day: 25,
          end_year: 2026,
          end_month: 11,
          end_day: 3,
        } as const;
        const oct = item({ ...base, span_start: "2026-10-25", span_end: "2026-10-31" });
        const nov = item({ ...base, span_start: "2026-11-01", span_end: "2026-11-03" });
        expect(itemKey(oct)).not.toBe(itemKey(nov));
        expect(itemKey(oct)).toBe(itemKey({ ...oct }));
      });

      it("ⓒ 10/31→11/02 시각 스팬은 10월 조각이 [10/31,10/31] 이어도 하루짜리가 아니다 — 끝 시각을 길이로 쓰지 않는다", () => {
        const overnight = item({
          note_id: "ov",
          kind: "span",
          span_start: "2026-10-31",
          span_end: "2026-10-31", // 10월 조회에서 잘린 조각
          year: 2026,
          month: 10,
          day: 31,
          end_year: 2026,
          end_month: 11,
          end_day: 2,
          start_time: "09:00",
          end_time: "18:00", // 11/02 의 시각
        });
        expect(rowIsSameDay(overnight)).toBe(false);
        const [chip] = planTimedDay([overnight], "2026-10-31").timed;
        expect(chip.startMin).toBe(540);
        expect(chip.endMin).toBe(540 + MIN_SLOT_MIN);
        // 손잡이도 없다 — 잡으면 11/02 의 끝 시각을 조용히 바꾼다.
        expect(chipDragMode(chip.height, chip.height, rowIsSameDay(overnight))).toBe("move");
      });
    });

    it("ignores a malformed start_time rather than placing it at midnight", () => {
      const bad = timed("bad", "9:00");
      const plan = planTimedDay([bad], "2026-08-09");
      expect(plan.timed).toEqual([]);
      expect(plan.allDay.map((i) => i.note_id)).toEqual(["bad"]);
    });
  });

  // ── 칩 드래그 산수 (PLAN-2026-09-10 달력 W3) ───────────────────────────────────────────
  describe("snapStartMin / keepDurationMin / formatHhmm", () => {
    const timed = (id: string, start: string, end?: string, day = "2026-08-09") =>
      item({
        note_id: id,
        kind: "event",
        span_start: day,
        span_end: day,
        start_time: start,
        end_time: end ?? null,
      });

    it("28px/시간이라 7px 이 정확히 15분이다", () => {
      expect(PX_PER_MIN).toBe(HOUR_ROW_H / 60);
      expect(SNAP_MIN * PX_PER_MIN).toBe(7);
      expect(snapStartMin(540, 7)).toBe(555); // 09:00 → 09:15
      expect(snapStartMin(540, -7)).toBe(525); // 09:00 → 08:45
      // 격자 사이는 가까운 칸으로 — 3px(≈6.4분)는 아직 09:00.
      expect(snapStartMin(540, 3)).toBe(540);
      expect(snapStartMin(540, 4)).toBe(555);
    });

    it("스태킹으로 밀린 top 이 아니라 startMin 을 기준으로 센다(함정 ⓐ)", () => {
      // 09:00 시작인데 앞 칩에 밀려 top 이 09:30 자리(=+14px)에 있는 칩을 15분 아래로 끌면
      // 09:15 여야 한다. top 을 역산했다면 09:45 가 나왔을 자리다.
      const a = timed("a", "09:00", "11:00");
      const b = timed("b", "09:00");
      const plan = planTimedDay([a, b], "2026-08-09");
      const pushed = plan.timed[1];
      expect(pushed.top).toBeGreaterThan((pushed.startMin / 1440) * DAY_AXIS_H);
      expect(snapStartMin(pushed.startMin, 7)).toBe(555);
    });

    it("경계: 0 미만으로도, 자정 너머로도 못 간다", () => {
      expect(snapStartMin(30, -1000)).toBe(0);
      // 길이가 없으면 상한은 23:45 — 15분 격자에서 23:59 를 넘지 않는 마지막 칸.
      expect(snapStartMin(1380, 1000)).toBe(23 * 60 + 45);
      // 길이가 있으면 그 길이가 자정을 넘지 않도록 시작이 clamp 된다(2시간 → 22:00).
      expect(snapStartMin(1380, 1000, 120)).toBe(22 * 60);
    });

    it("길이 유지: 하루짜리에 end_time 이 있으면 그 분량, 없거나 역전이면 0(시작만 민다)", () => {
      expect(keepDurationMin("09:00", "10:30", true)).toBe(90);
      expect(keepDurationMin("09:00", null, true)).toBe(0);
      expect(keepDurationMin("09:00", "09:00", true)).toBe(0);
      expect(keepDurationMin("09:00", "08:00", true)).toBe(0);
      // 옮긴 뒤에도 길이는 그대로.
      const dur = keepDurationMin("09:00", "10:30", true);
      const start = snapStartMin(540, 7 * 4, dur); // +1시간
      expect(formatHhmm(start)).toBe("10:00");
      expect(formatHhmm(start + dur)).toBe("11:30");
    });

    // 회귀(2026-09-10): 여러 날 span 의 end_time 은 **마지막 날**의 시각이다. 예전엔 "역전이면
    // 0" 이라는 숫자 비교에 기대 이 경우를 막는다고 믿었는데, 09:00 → 18:00 처럼 정상 순서면
    // gap 이 +540 이라 첫날 칩을 옮기는 순간 마지막 날의 끝 시각이 같이 밀렸다. 날짜는 추측하지
    // 않는다 — 하루짜리가 아니면 무조건 0.
    it("여러 날 span 은 순서가 멀쩡해도 길이가 0 이다 — 마지막 날 끝 시각을 밀지 않는다", () => {
      expect(keepDurationMin("09:00", "18:00", false)).toBe(0);
      expect(keepDurationMin("09:00", "10:30", false)).toBe(0);
    });

    it("formatHhmm 은 parseHhmm 의 역함수다", () => {
      expect(formatHhmm(0)).toBe("00:00");
      expect(formatHhmm(9 * 60 + 5)).toBe("09:05");
      expect(formatHhmm(23 * 60 + 45)).toBe("23:45");
      expect(parseHhmm(formatHhmm(555))).toBe(555);
    });
  });

  // ── 손잡이 · 빈 곳 드래그 · 현재 시각 눈금 (W5) ────────────────────────────────────────
  describe("chipDragMode / handleThicknessPx", () => {
    it("손잡이는 높이의 1/3 을 넘지 않는다 — 30분 칩(14px)에서도 가운데가 남는다", () => {
      const shortest = MIN_SLOT_MIN * PX_PER_MIN; // 14px
      expect(shortest).toBe(14);
      expect(handleThicknessPx(shortest)).toBeCloseTo(14 / 3);
      // 고정 6px 이었다면 가운데가 2px 밖에 안 남는다.
      expect(handleThicknessPx(shortest)).toBeGreaterThan(6 - 2);
      // 충분히 긴 칩에서는 6px 로 고정.
      expect(handleThicknessPx(60)).toBe(6);
    });

    it("위 가장자리 = 시작, 아래 = 끝, 가운데 = 이동", () => {
      expect(chipDragMode(1, 60, true)).toBe("start");
      expect(chipDragMode(30, 60, true)).toBe("move");
      expect(chipDragMode(59, 60, true)).toBe("end");
    });

    it("여러 날 span(resizable=false)에는 손잡이가 아예 없다 — 어디를 잡아도 이동", () => {
      expect(chipDragMode(0, 60, false)).toBe("move");
      expect(chipDragMode(60, 60, false)).toBe("move");
    });

    it("높이가 0(레이아웃 전)이면 잡을 손잡이가 없다", () => {
      expect(chipDragMode(100, 0, true)).toBe("move");
    });
  });

  describe("dragTimes", () => {
    const base = { startMin: 540, endMin: 600, durationMin: 60 }; // 09:00–10:00

    it("move 는 길이를 유지한 채 민다", () => {
      expect(dragTimes("move", base, HOUR_ROW_H)).toEqual({ startMin: 600, endMin: 660 });
    });

    it("start 는 끝을 고정한 채 시작만 옮긴다", () => {
      expect(dragTimes("start", base, -7)).toEqual({ startMin: 525, endMin: 600 });
    });

    it("end 는 시작을 고정한 채 끝만 옮긴다", () => {
      expect(dragTimes("end", base, 7)).toEqual({ startMin: 540, endMin: 615 });
    });

    it("최소 길이 30분 — 시작이 끝을 넘지도, 끝이 시작 아래로 가지도 못한다", () => {
      expect(dragTimes("start", base, 1000).startMin).toBe(600 - MIN_SLOT_MIN);
      expect(dragTimes("end", base, -1000).endMin).toBe(540 + MIN_SLOT_MIN);
    });

    it("끝은 자정을 넘지 않는다", () => {
      expect(dragTimes("end", { startMin: 1380, endMin: 1410, durationMin: 30 }, 1000).endMin).toBe(
        24 * 60,
      );
    });
  });

  describe("planNewRange", () => {
    it("임계 미만은 null — 그냥 클릭이므로 아무것도 만들지 않는다", () => {
      expect(planNewRange(100, 100 + DRAG_THRESHOLD_PX - 1)).toBeNull();
    });

    it("끈 만큼을 15분 격자로 — 위/아래 어느 방향이든 같은 범위", () => {
      const down = planNewRange(9 * HOUR_ROW_H, 11 * HOUR_ROW_H);
      expect(down).toEqual({ startMin: 540, endMin: 660 });
      expect(planNewRange(11 * HOUR_ROW_H, 9 * HOUR_ROW_H)).toEqual(down);
    });

    it("최소 길이는 MIN_SLOT_MIN", () => {
      expect(planNewRange(9 * HOUR_ROW_H, 9 * HOUR_ROW_H + 4)).toEqual({
        startMin: 540,
        endMin: 540 + MIN_SLOT_MIN,
      });
    });

    it("자정을 넘지 않는다 — 바닥까지 끌면 23:30–24:00", () => {
      expect(planNewRange(DAY_AXIS_H - 2, DAY_AXIS_H + 200)).toEqual({
        startMin: 24 * 60 - MIN_SLOT_MIN,
        endMin: 24 * 60,
      });
    });
  });

  describe("nowLineTop", () => {
    it("오늘이 아니면 눈금이 없다", () => {
      expect(nowLineTop("2026-08-09", "2026-08-10", 540)).toBeNull();
    });

    it("오늘이면 분에 비례한 픽셀 — 09:00 은 9시간 자리", () => {
      expect(nowLineTop("2026-08-09", "2026-08-09", 540)).toBe(9 * HOUR_ROW_H);
      expect(nowLineTop("2026-08-09", "2026-08-09", 0)).toBe(0);
      expect(nowLineTop("2026-08-09", "2026-08-09", 24 * 60)).toBe(DAY_AXIS_H);
    });
  });

  // ── 종일 카드를 축으로 끌어다 놓기 (W7) ────────────────────────────────────────────────
  // 세 갈래는 **DB 행의 모양**이 갈라 준다 — 화면 항목의 날짜는 반복 회차·월 클리핑을 거친
  // 값이므로 판정에도 페이로드에도 쓰지 않는다(함정 ⓑ).
  describe("planAllDayDrop / rowIsSameDay", () => {
    function row(p: Partial<NoteDate> = {}): NoteDate {
      return {
        id: "d1",
        note_id: "n1",
        position: 0,
        year: 2026,
        month: 9,
        day: 3,
        end_year: null,
        end_month: null,
        end_day: null,
        remind: false,
        created_at: "2026-09-01T00:00:00Z",
        start_time: null,
        end_time: null,
        remind_offset_min: null,
        rrule: null,
        label: null,
        ...p,
      };
    }
    const DROP_DAY = "2026-09-10";

    it("rowIsSameDay: 종료 트리플이 비었거나 시작과 같으면 하루", () => {
      expect(rowIsSameDay(row())).toBe(true);
      expect(rowIsSameDay(row({ end_year: 2026, end_month: 9, end_day: 3 }))).toBe(true);
      expect(rowIsSameDay(row({ end_year: 2026, end_month: 9, end_day: 17 }))).toBe(false);
    });

    it("정밀도 낮음 → 놓은 날로 날짜를 확정하고 종료 트리플을 비운다", () => {
      // 연 정밀도 + 연 범위. 특정 날의 축에 놓았다는 제스처가 곧 "이 날 이 시각"이다.
      const write = planAllDayDrop(
        row({ year: 2026, month: null, day: null, end_year: 2027 }),
        DROP_DAY,
        600,
      );
      expect(write).toEqual({
        year: 2026,
        month: 9,
        day: 10,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "10:00",
        end_time: "10:30",
      });
    });

    it("month 만 있고 day 가 없어도 정밀도 낮음이다 (I1: 시각엔 day 정밀도가 필요)", () => {
      expect(planAllDayDrop(row({ month: 9, day: null }), DROP_DAY, 600)).toMatchObject({
        month: 9,
        day: 10,
        start_time: "10:00",
      });
    });

    it("날짜 있는 하루짜리 → 시각만 얹는다, 날짜 트리플은 그대로", () => {
      // 반복 씨앗(7/5)을 9/10 축에 놓아도 날짜는 씨앗 값이다 — 옮기는 게 아니라 시각을 얹는다.
      expect(planAllDayDrop(row({ year: 2026, month: 7, day: 5 }), DROP_DAY, 600)).toEqual({
        year: 2026,
        month: 7,
        day: 5,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "10:00",
        end_time: "10:30",
      });
    });

    it("여러 날 span → 시작 시각만. 범위도 end_time 도 건드리지 않는다", () => {
      // 접으면 사용자가 만든 기간이 조용히 사라지고, 이 행의 end_time 은 **마지막 날**(9/17)의
      // 시각이라 여기서 쓰면 남의 날짜를 망친다 — keepDurationMin 이 고쳐진 것과 같은 이유.
      expect(
        planAllDayDrop(
          row({ month: 9, day: 2, end_year: 2026, end_month: 9, end_day: 17, end_time: "18:00" }),
          DROP_DAY,
          600,
        ),
      ).toEqual({
        year: 2026,
        month: 9,
        day: 2,
        end_year: 2026,
        end_month: 9,
        end_day: 17,
        start_time: "10:00",
        end_time: "18:00",
      });
    });

    it("길이는 MIN_SLOT_MIN — 자정을 넘으면 23:59 로 눌린다 (I3: 같은 날이면 start <= end)", () => {
      expect(planAllDayDrop(row(), DROP_DAY, 540)?.end_time).toBe(
        formatHhmm(540 + MIN_SLOT_MIN),
      );
      // 축 바닥은 snapStartMin 이 23:30 으로 clamp 한다 — 거기서 +30 은 "00:00" 이 되어 거절당한다.
      expect(planAllDayDrop(row(), DROP_DAY, 24 * 60 - MIN_SLOT_MIN)?.end_time).toBe("23:59");
    });

    it("날짜 문자열이 망가졌으면 null — 아무것도 쓰지 않는다", () => {
      expect(planAllDayDrop(row({ month: null, day: null }), "2026-9-10", 600)).toBeNull();
    });
  });
});

/**
 * W15 — 붙어 있는(gap 0) 항목의 연동 이동. 이동 방향으로만 따라가고, 체인 전부를 모으고,
 * 시각을 함부로 못 바꾸는 이웃(여러 날 span)과 하루를 벗어나는 이웃에서 끊긴다.
 */
describe("planLinkedMove — 맞닿은 이웃의 연동 이동 (W15)", () => {
  /** 09:00-10:00(a) — 10:00-11:00(b) — 11:00-12:00(c) 세 칩이 전부 맞닿은 하루. */
  const chain = [
    { key: "a", startMin: 540, endMin: 600, linkable: true },
    { key: "b", startMin: 600, endMin: 660, linkable: true },
    { key: "c", startMin: 660, endMin: 720, linkable: true },
  ];

  it("아래로 옮기면 뒤에 붙은 체인 전부가 같은 델타만큼 따라온다", () => {
    expect(planLinkedMove(chain, "a", 15)).toEqual([
      { key: "b", startMin: 615, endMin: 675 },
      { key: "c", startMin: 675, endMin: 735 },
    ]);
  });

  it("위로 옮기면 앞에 붙은 것만 따라온다 — 뒤쪽은 간격이 생기는 것을 허용한다", () => {
    expect(planLinkedMove(chain, "c", -15)).toEqual([
      { key: "b", startMin: 585, endMin: 645 },
      { key: "a", startMin: 525, endMin: 585 },
    ]);
  });

  it("맞닿지 않았으면(1분이라도 벌어지면) 아무도 따라오지 않는다", () => {
    const gapped = [chain[0], { key: "b", startMin: 601, endMin: 660, linkable: true }];
    expect(planLinkedMove(gapped, "a", 15)).toEqual([]);
  });

  it("델타가 0 이면 연동도 없다 — 움직이지 않은 것에 이웃을 딸려 보내지 않는다", () => {
    expect(planLinkedMove(chain, "a", 0)).toEqual([]);
  });

  it("여러 날 span 이웃은 빠지고, 맞닿음이 그 자리에서 끊긴다", () => {
    const withSpan = [
      chain[0],
      { key: "b", startMin: 600, endMin: 660, linkable: false },
      chain[2],
    ];
    // b 는 시각을 함부로 못 바꾸고(그 end_time 은 마지막 날의 것), b 뒤의 c 도 따라오지 않는다.
    expect(planLinkedMove(withSpan, "a", 15)).toEqual([]);
  });

  it("델타를 얹어 자정을 넘는 이웃은 빠진다", () => {
    const late = [
      { key: "a", startMin: 22 * 60, endMin: 23 * 60, linkable: true },
      { key: "b", startMin: 23 * 60, endMin: 24 * 60, linkable: true },
    ];
    expect(planLinkedMove(late, "a", 15)).toEqual([]);
    // 정확히 자정에서 끝나는 자리까지는 허용한다(저장 쪽에서 23:59 로 눌린다).
    const almost = [late[0], { key: "b", startMin: 23 * 60, endMin: 23 * 60 + 45, linkable: true }];
    expect(planLinkedMove(almost, "a", 15)).toEqual([
      { key: "b", startMin: 23 * 60 + 15, endMin: 24 * 60 },
    ]);
  });

  it("같은 경계에 둘이 붙어 있으면(스택) 둘 다 따라온다", () => {
    const stacked = [
      chain[0],
      { key: "b1", startMin: 600, endMin: 630, linkable: true },
      { key: "b2", startMin: 600, endMin: 660, linkable: true },
    ];
    expect(planLinkedMove(stacked, "a", 15).map((p) => p.key).sort()).toEqual(["b1", "b2"]);
  });

  it("서로 맞닿은 고리(순환)라도 한 바퀴에 끝난다 — 방문한 키는 다시 보지 않는다", () => {
    // 30분짜리 둘이 서로의 시작=끝인 자리에 있는 병리적 입력(같은 시각 0 길이 취급).
    const loop = [
      { key: "a", startMin: 540, endMin: 540, linkable: true },
      { key: "b", startMin: 540, endMin: 540, linkable: true },
    ];
    expect(planLinkedMove(loop, "a", 15)).toEqual([{ key: "b", startMin: 555, endMin: 555 }]);
  });

  it("없는 키는 조용히 빈 목록", () => {
    expect(planLinkedMove(chain, "없음", 15)).toEqual([]);
  });
});

/**
 * 오너 요청(2026-09-16) — 맞닿은 이음새를 손잡이로 끌면 양쪽이 같이 반응한다. planLinkedMove
 * 와 달리 체인이 아니라 **이웃 하나뿐**이고, 이웃 쪽은 이동이 아니라 그 한쪽 경계만 옮긴다.
 */
describe("planLinkedResize — 맞닿은 이음새의 리사이즈 연동", () => {
  /** 09:00-10:00(a) — 10:00-11:00(b), 정확히 맞닿은 하루짜리 둘. */
  const two = [
    { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
    { key: "b", startMin: 600, endMin: 660, linkable: true, hasEnd: true },
  ];

  it("끝 손잡이(mode end)로 늘리면 뒤에 맞닿은 이웃의 시작이 같은 자리로 밀린다", () => {
    expect(planLinkedResize(two, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [{ key: "b", startMin: 615, endMin: 660 }],
    });
  });

  it("시작 손잡이(mode start)로 당기면 앞에 맞닿은 이웃의 끝이 같은 자리로 밀린다", () => {
    expect(planLinkedResize(two, "b", "start", { startMin: 615, endMin: 660 })).toEqual({
      next: { startMin: 615, endMin: 660 },
      linked: [{ key: "a", startMin: 540, endMin: 615 }],
    });
  });

  it("이웃이 MIN_SLOT_MIN 아래로 줄면 next 도 이웃의 한계에서 다시 죈다", () => {
    // b 는 10:00-10:45(45분) — 최대 15분만 밀릴 수 있다(30분 밑으로는 못 줄어든다).
    const tight = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 600, endMin: 645, linkable: true, hasEnd: true },
    ];
    // 60분 늘리려 해도(제안된 next.endMin = 660) 이웃 한계인 615 에서 멈춘다.
    expect(planLinkedResize(tight, "a", "end", { startMin: 540, endMin: 660 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [{ key: "b", startMin: 615, endMin: 645 }],
    });
  });

  it("맞닿은 이웃이 없으면 next 그대로, 연동도 없다", () => {
    const gapped = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 615, endMin: 660, linkable: true, hasEnd: true },
    ];
    expect(planLinkedResize(gapped, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [],
    });
  });

  it("여러 날 span 이웃(linkable: false)은 연동에서 빠진다", () => {
    const withSpan = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 600, endMin: 660, linkable: false, hasEnd: true },
    ];
    expect(planLinkedResize(withSpan, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [],
    });
  });

  it("끝이 없던(hasEnd: false) 이웃은 시작 손잡이 연동에서 빠진다 — 없는 끝을 지어내지 않는다", () => {
    const noEnd = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: false },
      { key: "b", startMin: 600, endMin: 660, linkable: true, hasEnd: true },
    ];
    // b 의 시작 손잡이를 당겨도(mode "start") a 는 hasEnd:false 라 후보에서 빠진다.
    expect(planLinkedResize(noEnd, "b", "start", { startMin: 585, endMin: 660 })).toEqual({
      next: { startMin: 585, endMin: 660 },
      linked: [],
    });
  });

  it("hasEnd 가드는 끝 손잡이(mode end)엔 걸리지 않는다 — 이웃의 start_time 은 항상 있다", () => {
    // a 의 이웃(b)이 hasEnd:false 여도, a 를 끝 손잡이로 늘릴 때 b 의 start_time 을 미는
    // 것은 항상 안전하다(축의 모든 시각 있는 항목은 start_time 을 갖는다).
    const neighborNoEnd = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 600, endMin: 660, linkable: true, hasEnd: false },
    ];
    expect(planLinkedResize(neighborNoEnd, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [{ key: "b", startMin: 615, endMin: 660 }],
    });
  });

  it("없는 키는 조용히 next 그대로", () => {
    expect(planLinkedResize(two, "없음", "end", { startMin: 0, endMin: 30 })).toEqual({
      next: { startMin: 0, endMin: 30 },
      linked: [],
    });
  });
});

// ── PLAN-2026-09-13 축 확대 ─────────────────────────────────────────────────────────────────
describe("tickIntervalMinFor — 스케일에 맞는 눈금 세분화 레벨", () => {
  it("기본 배율(28px/h)에선 시(60분) 눈금뿐이다 — HourRuler 의 기존 화면과 100% 같다", () => {
    expect(tickIntervalMinFor(MIN_HOUR_ROW_H)).toBe(60);
    expect(tickIntervalMinFor(28)).toBe(60);
  });

  it("상한(240px/h)에선 5분까지 세분화된다 — 그 이상은 요구사항이 막는다", () => {
    expect(tickIntervalMinFor(MAX_HOUR_ROW_H)).toBe(5);
    expect(MAX_HOUR_ROW_H).toBe(240);
  });

  it("네 레벨의 전환 경계 — 그 레벨의 눈금 간격이 20px 미만이면 넘어가지 않는다", () => {
    // 30분: 간격 20px 은 hourRowH*30/60 >= 20 ⇔ hourRowH >= 40.
    expect(tickIntervalMinFor(39)).toBe(60);
    expect(tickIntervalMinFor(40)).toBe(30);
    // 15분: hourRowH >= 80.
    expect(tickIntervalMinFor(79)).toBe(30);
    expect(tickIntervalMinFor(80)).toBe(15);
    // 5분: hourRowH >= 240(=MAX_HOUR_ROW_H) — 상한 근처에서만 나온다.
    expect(tickIntervalMinFor(239)).toBe(15);
    expect(tickIntervalMinFor(240)).toBe(5);
  });

  it("레벨은 스케일이 커질수록만 촘촘해진다(단조) — 중간값도 어느 레벨이든 60/30/15/5 중 하나", () => {
    let prev = 0;
    for (let h = MIN_HOUR_ROW_H; h <= MAX_HOUR_ROW_H; h += 4) {
      const level = tickIntervalMinFor(h);
      expect([60, 30, 15, 5]).toContain(level);
      expect(level).toBeLessThanOrEqual(prev === 0 ? 60 : prev);
      prev = level;
    }
  });
});

describe("layoutTimedEvents — planTimedDay 의 스태킹 스윕을 다른 hourRowH 로 다시 돌리기", () => {
  it("겹치지 않는 일정은 시간·스케일에 정확히 비례한다(hourRowH 배가 되면 top/height 도 배)", () => {
    const events = [{ startMin: 9 * 60, endMin: 10 * 60 }]; // 09:00–10:00
    const base = layoutTimedEvents(events, 28);
    const doubled = layoutTimedEvents(events, 56);
    expect(base[0]).toEqual({ top: 252, height: 28 });
    expect(doubled[0]).toEqual({ top: 504, height: 56 });
  });

  it("스택 간격(STACK_GAP_PX=2px)은 스케일과 무관하게 고정이다", () => {
    // a: 09:00–11:00, b: 09:30–10:00 — b 는 a 와 겹쳐 a 바로 아래로 밀린다(planTimedDay 와 같은 룰).
    const events = [
      { startMin: 9 * 60, endMin: 11 * 60 },
      { startMin: 9 * 60 + 30, endMin: 10 * 60 },
    ];
    for (const hourRowH of [28, 100, 240]) {
      const [a, b] = layoutTimedEvents(events, hourRowH);
      expect(b.top).toBe(a.top + a.height + STACK_GAP_PX);
    }
  });

  it("hourRowH 를 생략하면 HOUR_ROW_H(기본 28) 로 계산한다", () => {
    const events = [{ startMin: 0, endMin: 60 }];
    expect(layoutTimedEvents(events)).toEqual(layoutTimedEvents(events, HOUR_ROW_H));
  });
});

describe("확대 스케일을 받는 픽셀↔분 함수들 — hourRowH 인자가 실제로 스케일을 바꾼다", () => {
  it("snapStartMin: 같은 픽셀 이동도 배율이 높을수록 더 적은 분으로 환산된다", () => {
    // 28px/h 에서 28px 이동 = 60분(1시간). 56px/h(배)에서 같은 28px = 30분.
    expect(snapStartMin(0, 28, 0, 28)).toBe(60);
    expect(snapStartMin(0, 28, 0, 56)).toBe(30);
  });

  it("dragTimes(move): hourRowH 를 생략하면 기존 기본 스케일 그대로다", () => {
    const base = { startMin: 9 * 60, endMin: 10 * 60, durationMin: 60 };
    const withDefault = dragTimes("move", base, HOUR_ROW_H); // 28px 이동
    const withExplicitDefault = dragTimes("move", base, HOUR_ROW_H, HOUR_ROW_H);
    expect(withDefault).toEqual(withExplicitDefault);
    expect(withDefault.startMin).toBe(9 * 60 + 60); // 28px/h 에서 28px = 60분
  });

  it("planNewRange: 배율이 높을수록 같은 픽셀 폭이 더 짧은 시간 구간이 된다", () => {
    const narrow = planNewRange(0, 56, 28); // 28px/h — 56px = 120분
    const wide = planNewRange(0, 56, 56); // 56px/h — 56px = 60분
    expect(narrow).toEqual({ startMin: 0, endMin: 120 });
    expect(wide).toEqual({ startMin: 0, endMin: 60 });
  });

  it("nowLineTop: 배율이 두 배면 같은 시각의 픽셀도 두 배다", () => {
    const day = "2026-08-09";
    expect(nowLineTop(day, day, 9 * 60, 28)).toBe(252);
    expect(nowLineTop(day, day, 9 * 60, 56)).toBe(504);
  });
});

describe("Q11: 겹치는 반복 회차는 하루 한 번(그날 시작 우선) — 달력 +30 해소", () => {
  it("collapseOccurrencesForDay: 같은 date_id의 겹치는 회차 중 그날 시작하는 회차를 우선하여 하나만 남긴다", () => {
    const rowId = "row-daily";
    const occ1 = item({
      note_id: "daily",
      date_id: rowId,
      kind: "span",
      span_start: "2026-10-01",
      span_end: "2026-10-28",
      year: 2026,
      month: 9,
      day: 20, // 9월 20일 시작
    });
    const occ2 = item({
      note_id: "daily",
      date_id: rowId,
      kind: "span",
      span_start: "2026-10-01",
      span_end: "2026-10-28",
      year: 2026,
      month: 10,
      day: 1, // 10월 1일 시작
    });
    const other = item({
      note_id: "other",
      date_id: "row-other",
      kind: "event",
      span_start: "2026-10-01",
      span_end: "2026-10-01",
    });

    expect(spanTrackKey(occ1)).toBe("row-daily|2026-09-20");
    expect(spanTrackKey(occ2)).toBe("row-daily|2026-10-01");
    const collapsed = collapseOccurrencesForDay([occ1, occ2, other], "2026-10-01");
    expect(collapsed).toHaveLength(2);
    expect(collapsed).toContain(occ2);
    expect(collapsed).toContain(other);
    expect(collapsed).not.toContain(occ1);
  });

  it("실물 형태(27일 DAILY 회차 28개 + 롱스팬 3개): 10월 각 셀에 row 1회 표시, +30 오버플로우 없음, 10-18에 23:22 칩 시작", () => {
    // 2026-08-15 시작, 매일 반복, 각 회차는 27일 지속 (span 2026-08-15 ~ 2026-09-11 등)
    // 10월 한 달 동안 28개의 회차가 10월에 걸쳐 있음 (span_start 는 10-01로 잘린 것 포함)
    const dailyRowId = "row-daily-2322";
    const dailyItems: CalendarItem[] = [];

    // 9월 10일부터 10월 20일까지 매일 시작하는 회차 생성
    // 9월에 시작한 것들은 10월에 span_start="2026-10-01" 로 클립됨
    for (let dayOffset = 10; dayOffset <= 30; dayOffset++) {
      dailyItems.push(
        item({
          note_id: "daily-note",
          date_id: dailyRowId,
          kind: "span",
          span_start: "2026-10-01",
          span_end: "2026-10-15",
          year: 2026,
          month: 9,
          day: dayOffset,
          start_time: "23:22",
          is_occurrence: true,
          rrule: "FREQ=DAILY",
        }),
      );
    }
    for (let d = 1; d <= 25; d++) {
      const dayStr = `2026-10-${String(d).padStart(2, "0")}`;
      const endDay = d + 27 <= 31 ? `2026-10-${String(d + 27).padStart(2, "0")}` : "2026-10-31";
      dailyItems.push(
        item({
          note_id: "daily-note",
          date_id: dailyRowId,
          kind: "span",
          span_start: dayStr,
          span_end: endDay,
          year: 2026,
          month: 10,
          day: d,
          start_time: "23:22",
          is_occurrence: true,
          rrule: "FREQ=DAILY",
        }),
      );
    }

    // 롱스팬 3개 추가 (10월 전반/중반에 걸침)
    const long1 = item({
      note_id: "long1",
      date_id: "row-long1",
      kind: "span",
      span_start: "2026-10-05",
      span_end: "2026-10-20",
    });
    const long2 = item({
      note_id: "long2",
      date_id: "row-long2",
      kind: "span",
      span_start: "2026-10-10",
      span_end: "2026-10-25",
    });
    const long3 = item({
      note_id: "long3",
      date_id: "row-long3",
      kind: "span",
      span_start: "2026-10-12",
      span_end: "2026-10-22",
    });

    const allItems = [...dailyItems, long1, long2, long3];

    // 10월 그리드 생성
    const cells = buildCalendarGridCustom(2026, 9, "sunday"); // month 9 = October
    const monthPlans = buildMonthDayPlans(cells, allItems);

    // 10월 18일 검증
    const planOct18 = monthPlans.get("2026-10-18");
    expect(planOct18).toBeDefined();
    // 4개의 행(daily + long1 + long2 + long3) 중 MAX_CELL_LINES=3에 의해 3개 표시, overflow는 1 (+30 아님!)
    expect(planOct18!.overflow).toBe(1);
    expect(planOct18!.visibleSpans.length).toBe(3);

    // 10월 18일 시간축(planTimedDay) 검증: 10-18 23:22에 시작하는 회차 1개만 timed에 존재
    const timedPlan = planTimedDay(allItems, "2026-10-18");
    expect(timedPlan.timed).toHaveLength(1);
    expect(timedPlan.timed[0].startMin).toBe(23 * 60 + 22);
    expect(timedPlan.timed[0].item.year).toBe(2026);
    expect(timedPlan.timed[0].item.month).toBe(10);
    expect(timedPlan.timed[0].item.day).toBe(18);
    // allDay에는 dailyItem들이 수십 개 쌓이지 않고 0개
    expect(timedPlan.allDay.filter((it) => it.date_id === dailyRowId)).toHaveLength(0);
  });
});


// 2026-10-19 화면 보드: 여러 주에 걸친 기간 막대가 둘째 주 행부터 이름 없는 띠였고, 시작 주에서
// "+n" 으로 접히면 그 달 어디에도 이름이 없었다(10-13 시작 항목). 표준 동작 = 주 행마다 보이는 첫 조각.
describe("buildMonthDayPlans — span title on the first visible piece of every week row", () => {
  // 2026-10, Sunday-first: rows 10-04..10-10, 10-11..10-17, 10-18..10-24.
  const cells = buildCalendarGridCustom(2026, 9, "sunday");
  const titledDays = (plans: ReturnType<typeof buildMonthDayPlans>, noteId: string) =>
    [...plans]
      .filter(([, p]) => p.visibleSpans.some((l) => l.item.note_id === noteId && l.showTitle))
      .map(([day]) => day)
      .sort();

  it("a span crossing week rows is titled at its start and at the start of each later row only", () => {
    const span = item({ note_id: "trip", kind: "span", span_start: "2026-10-08", span_end: "2026-10-20" });
    const plans = buildMonthDayPlans(cells, [span]);
    expect(titledDays(plans, "trip")).toEqual(["2026-10-08", "2026-10-11", "2026-10-18"]);
    // Corners still follow the real start/end — a continuation row starts square, not rounded.
    const row2 = plans.get("2026-10-11")!.visibleSpans[0]!;
    expect(row2.role).toBe("mid");
    expect(row2.showTitle).toBe(true);
  });

  it("when the start week folds the span into +n, the next row's first piece carries the name", () => {
    // Three week-long spans take tracks 0..2 of the 10-11 row, so one starting 10-13 lands on
    // track 3 — past MAX_CELL_LINES, hidden for that whole row.
    const fillers = ["a", "b", "c"].map((id) =>
      item({ note_id: id, kind: "span", span_start: "2026-10-11", span_end: "2026-10-17" }),
    );
    const late = item({ note_id: "late", kind: "span", span_start: "2026-10-13", span_end: "2026-10-20" });
    const plans = buildMonthDayPlans(cells, [...fillers, late]);

    const startPlan = plans.get("2026-10-13")!;
    expect(startPlan.visibleSpans.some((l) => l.item.note_id === "late")).toBe(false);
    expect(startPlan.overflow).toBe(1);
    expect(titledDays(plans, "late")).toEqual(["2026-10-18"]);
  });

  it("a span clipped to the month's first day is titled on the 1st", () => {
    const carried = item({
      note_id: "carry",
      kind: "span",
      span_start: "2026-10-01",
      span_end: "2026-10-05",
      year: 2026,
      month: 9,
      day: 25,
    });
    const plans = buildMonthDayPlans(cells, [carried]);
    expect(titledDays(plans, "carry")).toEqual(["2026-10-01", "2026-10-04"]);
  });
});
