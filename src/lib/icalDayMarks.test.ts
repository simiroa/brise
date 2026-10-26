import { describe, it, expect, vi } from "vitest";
import { icsEventsToDayMarks, parseIcsToEvents, ICS_MARK_SPAN_MAX_DAYS, type ParsedIcsEvent } from "./ical";

vi.mock("./invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

const ev = (over: Partial<ParsedIcsEvent>): ParsedIcsEvent => ({
  title: "삼일절",
  year: 2026,
  month: 3,
  day: 1,
  start_time: null,
  rrule: null,
  ...over,
});

// docs/PLAN-2026-09-19-calendar-schedule.md §4 — ics → 표시일 변환 규칙.
describe("icsEventsToDayMarks", () => {
  it("종일 한 날 이벤트는 once 한 행, uid·day_off 를 실어 간다", () => {
    const r = icsEventsToDayMarks([ev({ uid: "u1" })], true);
    expect(r.marks).toEqual([
      { uid: "u1", title: "삼일절", year: 2026, month: 3, day: 1, repeat: "once", day_off: true },
    ]);
    expect(r.skippedTimed).toBe(0);
    expect(r.skippedRule).toBe(0);
  });

  it("시각 있는 이벤트는 건너뛰고 센다", () => {
    const r = icsEventsToDayMarks([ev({ start_time: "09:00" }), ev({})], false);
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0].day_off).toBe(false);
    expect(r.skippedTimed).toBe(1);
  });

  it("FREQ=YEARLY(대소문자·끝 ; 무시)는 yearly, 첫해 = 이벤트의 해", () => {
    const r = icsEventsToDayMarks(
      [ev({ rrule: "FREQ=YEARLY" }), ev({ rrule: "freq=yearly;" }), ev({ rrule: " FREQ=YEARLY ;" })],
      true,
    );
    // 셋째는 가운데 공백이 있어 규칙이 다르다 — trim 은 앞뒤만.
    expect(r.marks.filter((m) => m.repeat === "yearly")).toHaveLength(2);
    expect(r.marks[0]).toMatchObject({ year: 2026, month: 3, day: 1, repeat: "yearly" });
    expect(r.skippedRule).toBe(1);
  });

  it("그 밖의 RRULE 은 건너뛰고 센다", () => {
    const r = icsEventsToDayMarks(
      [ev({ rrule: "FREQ=YEARLY;BYMONTH=5;BYDAY=2SU" }), ev({ rrule: "FREQ=WEEKLY" })],
      true,
    );
    expect(r.marks).toHaveLength(0);
    expect(r.skippedRule).toBe(2);
  });

  it("기간 이벤트는 포함 끝날까지 날마다 once 한 행 — 달·해 경계를 넘는다", () => {
    const r = icsEventsToDayMarks(
      [ev({ title: "연휴", year: 2026, month: 12, day: 30, end_year: 2027, end_month: 1, end_day: 2 })],
      true,
    );
    expect(r.marks.map((m) => `${m.year}-${m.month}-${m.day}`)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-1-1",
      "2027-1-2",
    ]);
    expect(r.marks.every((m) => m.repeat === "once" && m.title === "연휴")).toBe(true);
  });

  // 회귀: 기간 이벤트에 RRULE:FREQ=YEARLY 가 같이 오면(매년 반복되는 사흘짜리 연휴) 첫날만 담고
  // 나머지를 아무 카운터도 없이 버렸다 — 서버 스키마는 "여러 날짜리 매년"을 못 담는 게 아니라 그냥
  // 하루씩 yearly 행으로 나눠 담으면 됐다(once 분기는 이미 그렇게 한다).
  it("기간 이벤트 + FREQ=YEARLY 는 날마다 yearly 한 행 — 며칠이든 그대로 남는다", () => {
    const r = icsEventsToDayMarks(
      [
        ev({
          title: "연말 연휴",
          year: 2026,
          month: 12,
          day: 31,
          end_year: 2027,
          end_month: 1,
          end_day: 2,
          rrule: "FREQ=YEARLY",
        }),
      ],
      true,
    );
    expect(r.marks.map((m) => `${m.year}|${m.month}-${m.day}|${m.repeat}`)).toEqual([
      "2026|12-31|yearly",
      "2026|1-1|yearly",
      "2026|1-2|yearly",
    ]);
    expect(r.skippedRule).toBe(0);
  });

  it("기간이 상한을 넘으면 상한까지만 펼친다", () => {
    const r = icsEventsToDayMarks(
      [ev({ year: 2026, month: 1, day: 1, end_year: 2029, end_month: 1, end_day: 1 })],
      false,
    );
    expect(r.marks).toHaveLength(ICS_MARK_SPAN_MAX_DAYS);
  });

  it("파서와 이어 붙이면 실제 공휴일 캘린더 모양이 그대로 들어온다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a@google.com",
      "DTSTART;VALUE=DATE:20260301",
      "DTEND;VALUE=DATE:20260302",
      "SUMMARY:삼일절",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b",
      "DTSTART;VALUE=DATE:20260216",
      "DTEND;VALUE=DATE:20260219",
      "SUMMARY:설날 연휴",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c",
      "DTSTART:20260305T090000",
      "SUMMARY:회의",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:d",
      "DTSTART;VALUE=DATE:20200512",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:엄마 생일",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = icsEventsToDayMarks(parseIcsToEvents(ics), true);
    expect(r.skippedTimed).toBe(1);
    expect(r.marks.map((m) => `${m.title}|${m.year}-${m.month}-${m.day}|${m.repeat}`)).toEqual([
      "삼일절|2026-3-1|once",
      "설날 연휴|2026-2-16|once",
      "설날 연휴|2026-2-17|once",
      "설날 연휴|2026-2-18|once",
      "엄마 생일|2020-5-12|yearly",
    ]);
    expect(r.marks[0].uid).toBe("a@google.com");
  });
});
