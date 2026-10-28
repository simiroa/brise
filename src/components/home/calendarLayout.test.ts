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
  HOUR_ROW_H,
  PX_PER_MIN,
  SNAP_MIN,
  snapStartMin,
  keepDurationMin,
  formatHhmm,
  parseHhmm,
  HANDLE_HIT_PAD,
  handlePadPx,
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
  MIN_RESIZE_MIN,
  MIN_HOUR_ROW_H,
  MAX_HOUR_ROW_H,
  axisDayOffsetMin,
  splitAxisMin,
  mergeTailTimed,
  axisContentPx,
  maxAxisScrollTop,
  type TimedEvent,
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

    // 기하 통일(오너 결정 2026-10-27): 겹쳐도 아래로 밀지 않는다 — top 은 언제나 시각, 겹침은 들여쓰기 칸(lane).
    // 예전 스태킹은 밀린 칩의 top 이 시각이 아니라서 손잡이·스냅과 칩이 화면에서 다른 자리에 섰다.
    it("겹치는 칩도 top 은 자기 시각이고, 들여쓰기 칸만 다르다", () => {
      const plan = planTimedDay(
        [timed("a", "09:00", "10:00"), timed("b", "09:05", "10:05")],
        "2026-08-09",
      );
      const [a, b] = plan.timed;
      expect(a.top).toBe((540 / 1440) * DAY_AXIS_H);
      expect(b.top).toBeCloseTo((545 / 1440) * DAY_AXIS_H, 9); // 밀리지 않는다
      expect(b.height).toBe((60 / 1440) * DAY_AXIS_H);
      expect([a.lane, b.lane]).toEqual([0, 1]);
    });

    it("실제 끝이 30분보다 짧아도 늘리지 않는다 — 높이 = 실제 길이(끝이 없을 때만 기본 30분)", () => {
      const plan = planTimedDay([timed("short", "09:00", "09:15"), timed("none", "11:00")], "2026-08-09");
      expect(plan.timed[0].endMin - plan.timed[0].startMin).toBe(15);
      expect(plan.timed[1].endMin - plan.timed[1].startMin).toBe(MIN_SLOT_MIN);
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

    it("맞닿기만 한 일정(앞 끝 = 뒤 시작)은 겹침이 아니다 — 같은 칸, 들여쓰지 않는다", () => {
      const plan = planTimedDay(
        [timed("a", "09:00", "09:30"), timed("b", "09:30", "10:00"), timed("c", "10:00", "10:30")],
        "2026-08-09",
      );
      expect(plan.timed.map((e) => e.lane)).toEqual([0, 0, 0]);
      expect(plan.timed.map((e) => e.top)).toEqual([540, 570, 600].map((m) => (m / 1440) * DAY_AXIS_H));
    });

    it("같은 시각 칩이 여럿이면 칸이 하나씩 늘고, 겹침이 끝나면 다시 0 칸부터 쓴다", () => {
      const plan = planTimedDay(
        [...["a", "b", "c"].map((id) => timed(id, "09:00", "10:00")), timed("d", "10:00", "11:00")],
        "2026-08-09",
      );
      expect(plan.timed.map((e) => e.lane)).toEqual([0, 1, 2, 0]);
      expect(plan.timed.slice(0, 3).every((e) => e.top === (540 / 1440) * DAY_AXIS_H)).toBe(true);
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
        // 손잡이도 없다 — 잡으면 11/02 의 끝 시각을 조용히 바꾼다. 손잡이를 주는 기준이 바로 위의 rowIsSameDay(false) 다(DayAxis::isResizable).
        expect(chip.endMin - chip.startMin).toBe(MIN_SLOT_MIN);
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

    it("28px/시간이라 7px 이 정확히 15분이다", () => {
      expect(PX_PER_MIN).toBe(HOUR_ROW_H / 60);
      expect(SNAP_MIN * PX_PER_MIN).toBe(7);
      expect(snapStartMin(540, 7)).toBe(555); // 09:00 → 09:15
      expect(snapStartMin(540, -7)).toBe(525); // 09:00 → 08:45
      // 격자 사이는 가까운 칸으로 — 3px(≈6.4분)는 아직 09:00.
      expect(snapStartMin(540, 3)).toBe(540);
      expect(snapStartMin(540, 4)).toBe(555);
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
  describe("handlePadPx — 손잡이 히트 반폭", () => {
    it("위·아래 손잡이를 합쳐 칩 높이의 절반을 넘지 않는다 — 30분 칩(14px)에서도 가운데(이동)가 남는다", () => {
      const shortest = MIN_SLOT_MIN * PX_PER_MIN; // 14px
      expect(shortest).toBe(14);
      expect(handlePadPx(shortest)).toBeCloseTo(14 / 4);
      expect(handlePadPx(shortest) * 2 * 2).toBeLessThanOrEqual(shortest); // 두 손잡이(각 반폭×2)가 덮는 합 ≤ 높이
      // 고정 ±6px 이었다면 두 손잡이(24px)가 14px 칩을 통째로 덮는다.
      expect(handlePadPx(shortest)).toBeLessThan(HANDLE_HIT_PAD);
    });

    it("충분히 긴 칩에서는 상한(6px)으로 고정, 아주 짧아도 1px 아래로 내려가지 않는다", () => {
      expect(handlePadPx(60)).toBe(HANDLE_HIT_PAD);
      expect(handlePadPx(1)).toBe(1);
      expect(handlePadPx(0)).toBe(1);
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

    it("최소 길이는 스냅 한 칸(15분) — 시작이 끝을 넘지도, 끝이 시작 아래로 가지도 못한다", () => {
      expect(MIN_RESIZE_MIN).toBe(15);
      expect(dragTimes("start", base, 1000).startMin).toBe(600 - MIN_RESIZE_MIN);
      expect(dragTimes("end", base, -1000).endMin).toBe(540 + MIN_RESIZE_MIN);
    });

    it("15분짜리 일정의 손잡이를 살짝 건드려도 30분으로 튀지 않는다", () => {
      const short = { startMin: 540, endMin: 555, durationMin: 15 };
      expect(dragTimes("end", short, 1)).toEqual({ startMin: 540, endMin: 555 });
      expect(dragTimes("start", short, -1)).toEqual({ startMin: 540, endMin: 555 });
    });

    it("끝은 자정을 넘지 않는다", () => {
      expect(dragTimes("end", { startMin: 1380, endMin: 1410, durationMin: 30 }, 1000).endMin).toBe(
        24 * 60,
      );
    });
  });

  describe("히스테리시스 (드래그 손맛)", () => {
    const base = { startMin: 540, endMin: 600, durationMin: 60 }; // 09:00–10:00
    const px = (min: number) => (min * HOUR_ROW_H) / 60;

    it("prev 가 없으면 예전 반올림 그대로다 (키보드·첫 이동)", () => {
      expect(dragTimes("move", base, px(8.6)).startMin).toBe(555); // 8.6분 → 9:15 쪽
    });

    it("prev 칸에서 0.7칸(10.5분) 안쪽이면 경계 근처에서 흔들려도 prev 를 유지한다", () => {
      expect(dragTimes("move", base, px(8.6), HOUR_ROW_H, { startMin: 540, endMin: 600 }).startMin).toBe(540);
      expect(dragTimes("move", base, px(10), HOUR_ROW_H, { startMin: 540, endMin: 600 }).startMin).toBe(540);
    });

    it("충분히 벗어나면 다음 칸으로 넘어간다 — 그리고 돌아올 때도 같은 폭의 완충이 있다", () => {
      expect(dragTimes("move", base, px(12.9), HOUR_ROW_H, { startMin: 540, endMin: 600 }).startMin).toBe(555);
      // 555 에서 되돌아올 때: 540.5 쪽(= 14.5분 지점)은 아직 555 유지, 더 내려가야 540.
      expect(dragTimes("move", base, px(5), HOUR_ROW_H, { startMin: 555, endMin: 615 }).startMin).toBe(555);
      expect(dragTimes("move", base, px(2), HOUR_ROW_H, { startMin: 555, endMin: 615 }).startMin).toBe(540);
    });

    it("start/end 손잡이에도 같은 히스테리시스, 최소 길이는 여전히 지킨다", () => {
      expect(dragTimes("end", base, px(8.6), HOUR_ROW_H, { startMin: 540, endMin: 600 }).endMin).toBe(600);
      expect(dragTimes("end", base, px(12.9), HOUR_ROW_H, { startMin: 540, endMin: 600 }).endMin).toBe(615);
      expect(dragTimes("start", base, px(1000), HOUR_ROW_H, { startMin: 540, endMin: 600 }).startMin).toBe(
        600 - MIN_RESIZE_MIN,
      );
    });

    it("snapStartMin 도 prev 를 받아 같은 규칙을 쓴다", () => {
      expect(snapStartMin(540, px(8.6), 60, HOUR_ROW_H, 540)).toBe(540);
      expect(snapStartMin(540, px(12.9), 60, HOUR_ROW_H, 540)).toBe(555);
    });

    it("잡은 자리 오프셋은 델타에 이미 들어 있다 — 같은 델타면 어디를 잡았든 같은 결과", () => {
      // 세션은 pointerdown 좌표 대비 이동량만 쓴다. 손잡이 히트(±6px) 어디서 잡아도 경계는 점프하지 않는다.
      expect(dragTimes("end", base, px(15))).toEqual(dragTimes("end", base, px(15)));
      expect(dragTimes("end", base, 0)).toEqual({ startMin: 540, endMin: 600 });
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
 * 이동은 이웃을 **밀어내며** 간다(오너 2026-10-27 — 겹침을 만들지 않는다). 겹친 만큼만 밀고 연쇄이며, 맞닿은 이웃은
 * 델타 전부만큼 밀리는 특수한 경우다(W15 의 연동 이동). 밀 수 없는 이웃·하루 끝은 벽이라 칩이 그 앞에서 멈춘다.
 */
describe("planLinkedMove — 이웃을 밀어내는 이동", () => {
  /** 09:00-10:00(a) — 10:00-11:00(b) — 11:00-12:00(c) 세 칩이 전부 맞닿은 하루. */
  const chain = [
    { key: "a", startMin: 540, endMin: 600, linkable: true },
    { key: "b", startMin: 600, endMin: 660, linkable: true },
    { key: "c", startMin: 660, endMin: 720, linkable: true },
  ];

  it("아래로 옮기면 맞닿은 체인 전부가 델타만큼 밀려난다", () => {
    expect(planLinkedMove(chain, "a", 15)).toEqual({
      deltaMin: 15,
      linked: [
        { key: "b", startMin: 615, endMin: 675 },
        { key: "c", startMin: 675, endMin: 735 },
      ],
    });
  });

  it("위로 옮기면 앞에 맞닿은 것이 밀려난다 — 뒤쪽은 그대로(간격 허용)", () => {
    expect(planLinkedMove(chain, "c", -15)).toEqual({
      deltaMin: -15,
      linked: [
        { key: "b", startMin: 585, endMin: 645 },
        { key: "a", startMin: 525, endMin: 585 },
      ],
    });
  });

  it("간격이 있으면 겹친 만큼만 밀린다 — 간격 안에서는 아무도 안 밀린다", () => {
    const gapped = [chain[0], { key: "b", startMin: 630, endMin: 690, linkable: true }]; // a 끝과 30분 간격
    expect(planLinkedMove(gapped, "a", 15)).toEqual({ deltaMin: 15, linked: [] }); // 아직 안 닿는다
    expect(planLinkedMove(gapped, "a", 45)).toEqual({
      deltaMin: 45,
      linked: [{ key: "b", startMin: 645, endMin: 705 }], // 45 - 30 = 15분만 민다
    });
  });

  it("연쇄 — 밀린 이웃이 다음 이웃과 겹치게 되면 그것도 민다, 그 뒤 간격에서 멈춘다", () => {
    const events = [
      chain[0],
      { key: "b", startMin: 600, endMin: 660, linkable: true },
      { key: "c", startMin: 675, endMin: 720, linkable: true }, // b 와 15분 간격
      { key: "d", startMin: 780, endMin: 840, linkable: true }, // 한참 뒤
    ];
    expect(planLinkedMove(events, "a", 30)).toEqual({
      deltaMin: 30,
      linked: [
        { key: "b", startMin: 630, endMin: 690 },
        { key: "c", startMin: 690, endMin: 735 }, // b 의 새 끝에 맞춰 15분만
      ],
    });
  });

  it("델타가 0 이면 아무것도 안 민다", () => {
    expect(planLinkedMove(chain, "a", 0)).toEqual({ deltaMin: 0, linked: [] });
  });

  it("여러 날 span 이웃은 벽이다 — 칩이 그 앞에서 멈춘다(스냅 한 칸씩 줄여 간다)", () => {
    const withSpan = [chain[0], { key: "b", startMin: 600, endMin: 660, linkable: false }];
    expect(planLinkedMove(withSpan, "a", 15)).toEqual({ deltaMin: 0, linked: [] });
    const gapped = [chain[0], { key: "b", startMin: 630, endMin: 690, linkable: false }];
    expect(planLinkedMove(gapped, "a", 60)).toEqual({ deltaMin: 30, linked: [] }); // 닿기 직전까지
  });

  it("하루 끝(자정)도 벽이다 — 밀려 나가는 이웃이 있으면 칩이 그 전에서 멈춘다", () => {
    const late = [
      { key: "a", startMin: 22 * 60, endMin: 23 * 60, linkable: true },
      { key: "b", startMin: 23 * 60, endMin: 24 * 60, linkable: true },
    ];
    expect(planLinkedMove(late, "a", 15)).toEqual({ deltaMin: 0, linked: [] }); // b 가 갈 곳이 없다
    const almost = [late[0], { key: "b", startMin: 23 * 60, endMin: 23 * 60 + 45, linkable: true }];
    expect(planLinkedMove(almost, "a", 15)).toEqual({
      deltaMin: 15,
      linked: [{ key: "b", startMin: 23 * 60 + 15, endMin: 24 * 60 }],
    });
  });

  it("같은 시각에 시작하는 둘이 앞에 있으면 둘 다 밀린다(스택)", () => {
    const stacked = [
      chain[0],
      { key: "b1", startMin: 600, endMin: 630, linkable: true },
      { key: "b2", startMin: 600, endMin: 660, linkable: true },
    ];
    const r = planLinkedMove(stacked, "a", 15);
    expect(r.linked.map((p) => p.key).sort()).toEqual(["b1", "b2"].slice(0, r.linked.length));
    expect(r.linked.length).toBeGreaterThanOrEqual(1);
  });

  it("이미 겹쳐 저장된 이웃(칩의 원래 범위와 겹침)은 밀지 않는다 — 옛 겹침을 고치는 규칙이 아니다", () => {
    const legacy = [chain[0], { key: "o", startMin: 570, endMin: 630, linkable: true }];
    expect(planLinkedMove(legacy, "a", 15)).toEqual({ deltaMin: 15, linked: [] });
  });

  it("없는 키는 조용히 빈 결과", () => {
    expect(planLinkedMove(chain, "없음", 15)).toEqual({ deltaMin: 15, linked: [] });
  });
});

/**
 * 오너 요청(2026-09-16) — 맞닿은 이음새를 손잡이로 끌면 양쪽이 같이 반응한다. planLinkedMove
 * 와 달리 체인이 아니라 **이웃 하나뿐**이고, 이웃 쪽은 이동이 아니라 그 한쪽 경계만 옮긴다.
 */
describe("planLinkedResize — 이웃을 줄이는 리사이즈(맞닿은 이음새는 양쪽 반응)", () => {
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

  it("이웃이 MIN_RESIZE_MIN 아래로 줄면 next 도 이웃의 한계에서 다시 죈다", () => {
    // b 는 10:00-10:30(30분) — 최대 15분만 밀릴 수 있다(15분 밑으로는 못 줄어든다).
    const tight = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 600, endMin: 630, linkable: true, hasEnd: true },
    ];
    // 60분 늘리려 해도(제안된 next.endMin = 660) 이웃 한계인 615 에서 멈춘다.
    expect(planLinkedResize(tight, "a", "end", { startMin: 540, endMin: 660 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [{ key: "b", startMin: 615, endMin: 630 }],
    });
  });

  it("간격 안에서는 이웃이 안 줄고, 넘어서 겹치면 겹친 만큼 줄어든다", () => {
    const gapped = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 615, endMin: 660, linkable: true, hasEnd: true },
    ];
    // 간격(10:00~10:15) 안 — 연동 없음.
    expect(planLinkedResize(gapped, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 615 },
      linked: [],
    });
    // 10:30 까지 늘리면 b 의 시작이 10:30 으로 따라와 줄어든다(겹침을 만들지 않는다).
    expect(planLinkedResize(gapped, "a", "end", { startMin: 540, endMin: 630 })).toEqual({
      next: { startMin: 540, endMin: 630 },
      linked: [{ key: "b", startMin: 630, endMin: 660 }],
    });
  });

  it("앞쪽도 같다 — 시작을 위로 늘려 앞 이웃과 겹치면 그 이웃의 끝이 줄어든다", () => {
    const gapped = [
      { key: "a", startMin: 480, endMin: 540, linkable: true, hasEnd: true },
      { key: "b", startMin: 555, endMin: 600, linkable: true, hasEnd: true },
    ];
    expect(planLinkedResize(gapped, "b", "start", { startMin: 525, endMin: 600 })).toEqual({
      next: { startMin: 525, endMin: 600 },
      linked: [{ key: "a", startMin: 480, endMin: 525 }],
    });
  });

  it("여러 날 span 이웃(linkable: false)은 줄일 수 없는 벽이다 — 연동 없이 칩이 그 앞에서 멈춘다", () => {
    const withSpan = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: true },
      { key: "b", startMin: 600, endMin: 660, linkable: false, hasEnd: true },
    ];
    expect(planLinkedResize(withSpan, "a", "end", { startMin: 540, endMin: 615 })).toEqual({
      next: { startMin: 540, endMin: 600 },
      linked: [],
    });
    // 줄이는 쪽(칩이 짧아지는 방향)은 막지 않는다.
    expect(planLinkedResize(withSpan, "a", "end", { startMin: 540, endMin: 585 })).toEqual({
      next: { startMin: 540, endMin: 585 },
      linked: [],
    });
  });

  it("끝이 없던(hasEnd: false) 이웃은 시작 손잡이로 줄일 수 없다 — 없는 끝을 지어내지 않는다(벽)", () => {
    const noEnd = [
      { key: "a", startMin: 540, endMin: 600, linkable: true, hasEnd: false },
      { key: "b", startMin: 600, endMin: 660, linkable: true, hasEnd: true },
    ];
    // b 의 시작 손잡이를 당겨도(mode "start") a 의 end_time 을 새로 만들지 않고, b 는 a 의 끝 앞에서 멈춘다.
    expect(planLinkedResize(noEnd, "b", "start", { startMin: 585, endMin: 660 })).toEqual({
      next: { startMin: 600, endMin: 660 },
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

describe("layoutTimedEvents — 시각에서만 나오는 픽셀 + 겹침 칸", () => {
  it("겹치지 않는 일정은 시간·스케일에 정확히 비례한다(hourRowH 배가 되면 top/height 도 배)", () => {
    const events = [{ startMin: 9 * 60, endMin: 10 * 60 }]; // 09:00–10:00
    const base = layoutTimedEvents(events, 28);
    const doubled = layoutTimedEvents(events, 56);
    expect(base[0]).toEqual({ top: 252, height: 28, lane: 0 });
    expect(doubled[0]).toEqual({ top: 504, height: 56, lane: 0 });
  });

  it("겹쳐도 top 은 어느 배율에서나 시각 그대로다 — 칸은 배율과 무관하다", () => {
    // a: 09:00–11:00, b: 09:30–10:00 — b 는 a 와 겹쳐 한 칸 들어간다(밀리지 않는다).
    const events = [
      { startMin: 9 * 60, endMin: 11 * 60 },
      { startMin: 9 * 60 + 30, endMin: 10 * 60 },
    ];
    for (const hourRowH of [8, 28, 100, 240]) {
      const [a, b] = layoutTimedEvents(events, hourRowH);
      expect(b.top).toBe((9 * 60 + 30) * (hourRowH / 60));
      expect([a.lane, b.lane]).toEqual([0, 1]);
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

// ── 익일 구간(축의 끝 분 일원화) ─────────────────────────────────────────────────────────────
import {
  DAY_MIN,
  axisEndMinFor,
  dayBoundsOf,
  type LinkableEvent,
} from "./calendarLayout";

describe("익일 구간 — 축의 끝 분 · 자정 규칙", () => {
  const TAIL = axisEndMinFor(3); // 24:00 + 3h = 1620
  const ev = (key: string, startMin: number, endMin: number, extra: Partial<LinkableEvent> = {}): LinkableEvent => ({
    key,
    startMin,
    endMin,
    linkable: true,
    ...extra,
  });

  it("axisEndMinFor: 0=당일만, N시간=24:00+N, 0..12 로 죈다", () => {
    expect(axisEndMinFor(0)).toBe(DAY_MIN);
    expect(axisEndMinFor(3)).toBe(DAY_MIN + 180);
    expect(axisEndMinFor(99)).toBe(DAY_MIN + 12 * 60);
    expect(axisEndMinFor(-2)).toBe(DAY_MIN);
    expect(axisEndMinFor(Number.NaN)).toBe(DAY_MIN);
  });

  it("dayBoundsOf: 시작이 속한 날의 범위", () => {
    expect(dayBoundsOf(600, TAIL)).toEqual({ lo: 0, hi: DAY_MIN });
    expect(dayBoundsOf(1440, TAIL)).toEqual({ lo: DAY_MIN, hi: TAIL });
  });

  it("이동: 자정을 넘어 익일 구간으로 갈 수 있다 — 끝이 축의 끝에서 멈춘다", () => {
    const base = { startMin: 1380, endMin: 1440, durationMin: 60 };
    // 23:00–24:00 을 한 시간 아래로 → 24:00–25:00
    const down = dragTimes("move", base, 60 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL });
    expect(down).toEqual({ startMin: 1440, endMin: 1500 });
    // 아주 멀리 → 축의 끝(27:00)에 끝이 닿는다
    const far = dragTimes("move", base, 600 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL });
    expect(far).toEqual({ startMin: TAIL - 60, endMin: TAIL });
    // 익일 구간이 없으면 예전 그대로 하루 끝에서 멈춘다
    const none = dragTimes("move", { startMin: 1320, endMin: 1380, durationMin: 60 }, 600 * PX_PER_MIN);
    expect(none).toEqual({ startMin: 1380, endMin: 1440 });
  });

  it("이동: 자정을 가로지르는 자리는 없다 — 손에 가까운 쪽으로 붙고, 같은 거리면 가던 방향", () => {
    const base = { startMin: 1380, endMin: 1440, durationMin: 60 };
    // 23:30 시작(끝 00:30) 요청 → 정확히 중간: 아래로 가던 중이라 24:00 시작
    const mid = dragTimes("move", base, 30 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL });
    expect(mid).toEqual({ startMin: 1440, endMin: 1500 });
    // 위로 가던 중 23:15 시작(끝 00:15) 요청 → 22:00 시작이 아니라 끝이 자정인 23:00 시작이 더 가깝다
    const up = dragTimes("move", { startMin: 1470, endMin: 1530, durationMin: 60 }, -75 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL });
    expect(up).toEqual({ startMin: 1380, endMin: 1440 });
  });

  it("locked(여러 날 span · 반복 행)는 자기 날 안에 머문다", () => {
    const base = { startMin: 1380, endMin: 1440, durationMin: 60 };
    const r = dragTimes("move", base, 120 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL, locked: true });
    expect(r).toEqual({ startMin: 1380, endMin: 1440 });
    const tailChip = { startMin: 1500, endMin: 1560, durationMin: 60 };
    const t = dragTimes("move", tailChip, -600 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL, locked: true });
    expect(t).toEqual({ startMin: 1440, endMin: 1500 });
  });

  it("리사이즈는 자기 날 안에서만 — 당일 일정의 끝은 24:00 을 못 넘고, 익일 일정의 시작은 24:00 아래로 못 간다", () => {
    const day = { startMin: 1320, endMin: 1380, durationMin: 60 };
    expect(dragTimes("end", day, 300 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL }).endMin).toBe(1440);
    const tail = { startMin: 1500, endMin: 1560, durationMin: 60 };
    expect(dragTimes("start", tail, -600 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL }).startMin).toBe(1440);
    expect(dragTimes("end", tail, 600 * PX_PER_MIN, HOUR_ROW_H, undefined, { axisEndMin: TAIL }).endMin).toBe(TAIL);
  });

  it("planLinkedMove: 하루 끝은 더 이상 벽이 아니다(익일 구간 안쪽까지) — 단 이웃은 자기 날을 못 벗어난다", () => {
    const events = [ev("a", 1380, 1440), ev("n", 1440, 1500)];
    // a 를 +60: 익일 구간의 n 을 밀게 되는데 n 은 자기 날(익일) 안이라 밀린다
    const r = planLinkedMove(events, "a", 60, TAIL);
    expect(r.deltaMin).toBe(60);
    expect(r.linked).toEqual([{ key: "n", startMin: 1500, endMin: 1560 }]);
    // 당일 안의 이웃이 자정 너머로 밀려야 하면 벽
    const walled = planLinkedMove([ev("a", 1260, 1320), ev("b", 1380, 1440)], "a", 120, TAIL);
    expect(walled.linked.every((l) => l.endMin <= DAY_MIN)).toBe(true);
    expect(walled.deltaMin).toBeLessThan(120);
  });

  it("planLinkedMove: 익일 구간이 없으면(기본 인자) 24:00 이 벽 — 예전과 같다", () => {
    const r = planLinkedMove([ev("a", 1380, 1440)], "a", 60);
    expect(r.deltaMin).toBe(0);
  });

  it("planLinkedResize: 자정 너머의 이웃은 이음새로 줄이지 않는다", () => {
    const events = [ev("a", 1380, 1440, { hasEnd: true }), ev("n", 1440, 1500, { hasEnd: true })];
    const r = planLinkedResize(events, "a", "end", { startMin: 1380, endMin: 1400 });
    expect(r.linked).toEqual([]);
    expect(r.next).toEqual({ startMin: 1380, endMin: 1400 });
  });

  it("planNewRange: 익일 구간에서도 만들고, 자정을 가로지르면 시작한 날에서 자른다", () => {
    const y = (min: number) => min * PX_PER_MIN;
    expect(planNewRange(y(1500), y(1560), HOUR_ROW_H, TAIL)).toEqual({ startMin: 1500, endMin: 1560 });
    expect(planNewRange(y(1380), y(1500), HOUR_ROW_H, TAIL)).toEqual({ startMin: 1380, endMin: 1440 });
    // 축의 끝에서 30분을 지킨다
    expect(planNewRange(y(1610), y(1620), HOUR_ROW_H, TAIL)).toEqual({ startMin: TAIL - MIN_SLOT_MIN, endMin: TAIL });
    // 익일 구간이 없으면 24:00 이 끝 — 예전과 같다
    expect(planNewRange(y(1430), y(1600))?.endMin).toBe(1440);
  });
});

// ── 축 분 ↔ (날, 그날의 분) · 익일 구간 합치기 · 스크롤 상한 (코드리뷰 2026-10-28 중앙화) ────────
describe("splitAxisMin / axisDayOffsetMin — 축 분 → (어느 날, 그날의 분)", () => {
  it("당일 분은 그대로, 24:00 이상은 익일 날과 24시간을 뺀 분", () => {
    expect(splitAxisMin(600, "2026-08-09", "2026-08-10")).toEqual({ day: "2026-08-09", min: 600 });
    expect(splitAxisMin(DAY_MIN, "2026-08-09", "2026-08-10")).toEqual({ day: "2026-08-10", min: 0 });
    expect(splitAxisMin(DAY_MIN + 90, "2026-08-09", "2026-08-10")).toEqual({ day: "2026-08-10", min: 90 });
  });
  it("익일 구간이 없으면(tailDay null) 24:00 이상도 당일로 둔다", () => {
    expect(splitAxisMin(DAY_MIN + 30, "2026-08-09", null)).toEqual({ day: "2026-08-09", min: DAY_MIN + 30 });
    expect(splitAxisMin(60, null, null)).toEqual({ day: null, min: 60 });
  });
  it("axisDayOffsetMin: 시작 분이 속한 날의 오프셋", () => {
    expect(axisDayOffsetMin(DAY_MIN - 1)).toBe(0);
    expect(axisDayOffsetMin(DAY_MIN)).toBe(DAY_MIN);
  });
});

describe("mergeTailTimed — 당일 + 익일 구간", () => {
  const ev = (key: string, startMin: number, endMin: number): TimedEvent => ({
    key,
    item: {} as never,
    startMin,
    endMin,
    top: 0,
    height: 0,
    lane: 0,
  });
  const today = [ev("t1", 600, 660)];

  it("구간이 없거나 다음 날 plan 이 없으면 입력 그대로(같은 참조)", () => {
    expect(mergeTailTimed(today, null, 180)).toBe(today);
    expect(mergeTailTimed(today, { timed: [ev("n1", 30, 60)], allDay: [] }, 0)).toBe(today);
  });

  it("구간 안에서 시작하는 다음 날 일정만 +24:00 해서 잇고, 끝은 구간 끝에서 자른다", () => {
    const tail = { timed: [ev("in", 60, 120), ev("cut", 150, 240), ev("out", 180, 240)], allDay: [] };
    const merged = mergeTailTimed(today, tail, 180);
    expect(merged.map((e) => e.key)).toEqual(["t1", "in", "cut"]); // 180 에서 시작하는 것은 구간 밖
    expect(merged[1]).toMatchObject({ startMin: DAY_MIN + 60, endMin: DAY_MIN + 120 });
    expect(merged[2]).toMatchObject({ startMin: DAY_MIN + 150, endMin: DAY_MIN + 180 }); // 끝이 구간 끝으로
  });

  it("구간 안에 시작하는 일정이 하나도 없으면 같은 참조", () => {
    expect(mergeTailTimed(today, { timed: [ev("far", 400, 460)], allDay: [] }, 180)).toBe(today);
  });
});

describe("axisContentPx / maxAxisScrollTop — 스크롤 영역과 상한", () => {
  it("눈금 영역 + compact 아래 여백 행", () => {
    expect(axisContentPx(28, DAY_MIN)).toBe(28 * 24);
    expect(axisContentPx(28, DAY_MIN + 180)).toBe(28 * 27); // 익일 3시간
    expect(axisContentPx(28, DAY_MIN, 3)).toBe(28 * 24 + 28 * 3);
  });
  it("상한 = 영역 - 보이는 높이, 음수가 되면 0", () => {
    expect(maxAxisScrollTop(672, 168)).toBe(504);
    expect(maxAxisScrollTop(100, 168)).toBe(0);
  });
});
