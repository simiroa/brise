import { describe, it, expect } from "vitest";
import {
  guardTimeTyping,
  formatEventDate,
  formatEventDateRange,
  parseEventDateInput,
  parseTimeInput,
  toDateInputValue,
  parseDateInputValue,
  formatEventBadge,
  formatDateBadgeLabel,
  formatNoteDateRow,
  isStartAfterEnd,
  isInvalidEventEnd,
  hasEventEnd,
} from "./eventDate";

describe("formatEventDate", () => {
  it("year only", () => {
    expect(formatEventDate(1592, null, null)).toBe("1592");
  });
  it("year.month, zero-padded", () => {
    expect(formatEventDate(1592, 5, null)).toBe("1592.05");
  });
  it("year.month.day, zero-padded", () => {
    expect(formatEventDate(1592, 5, 13)).toBe("1592.05.13");
  });
});

describe("formatEventDateRange", () => {
  it("same year, month unknown on either end → coarsest common precision (year only)", () => {
    expect(
      formatEventDateRange({ year: 1592, month: null, day: null }, { year: 1592, month: 7, day: 13 }),
    ).toBe("1592");
  });
  it("same year, same month on both ends → collapses to a single YYYY.MM", () => {
    expect(
      formatEventDateRange({ year: 1592, month: 7, day: 1 }, { year: 1592, month: 7, day: 20 }),
    ).toBe("1592.07");
  });
  it("same year, crosses months → YYYY.MM – YYYY.MM", () => {
    expect(
      formatEventDateRange({ year: 1592, month: 3, day: null }, { year: 1592, month: 7, day: null }),
    ).toBe("1592.03 – 1592.07");
  });
  it("multi-year, full day precision on both ends → YYYY.MM.DD – YYYY.MM.DD", () => {
    expect(
      formatEventDateRange({ year: 1592, month: 7, day: 13 }, { year: 1650, month: 3, day: 2 }),
    ).toBe("1592.07.13 – 1650.03.02");
  });
  it("multi-year, missing precision on a boundary → falls back to YYYY – YYYY", () => {
    expect(
      formatEventDateRange({ year: 1592, month: null, day: null }, { year: 1650, month: 3, day: 2 }),
    ).toBe("1592 – 1650");
  });
});

describe("parseTimeInput", () => {
  it("parses 4-digit compact and colon forms the same way", () => {
    expect(parseTimeInput("0003")).toBe("00:03");
    expect(parseTimeInput("00:03")).toBe("00:03");
    expect(parseTimeInput("1402")).toBe("14:02");
    expect(parseTimeInput("14:02")).toBe("14:02");
  });
  it("ignores internal whitespace", () => {
    expect(parseTimeInput(" 14 : 02 ")).toBe("14:02");
  });
  it("rejects an out-of-range hour or minute", () => {
    expect(parseTimeInput("2500")).toBeNull();
    expect(parseTimeInput("0099")).toBeNull();
  });
  it("rejects non-numeric garbage", () => {
    expect(parseTimeInput("abc")).toBeNull();
  });
  // 빈 문자열은 "시각 해제" 의미라 실패(null)와 뭉개면 오타가 조용히 시각을 지운다 — 이 함수는
  // 그 구분을 스스로 하지 않는다(호출자가 raw.trim() === "" 를 먼저 본다). 여기선 그 계약대로
  // 빈 문자열도 다른 파싱 실패와 마찬가지로 null 을 낸다는 것만 고정한다.
  // W1 날짜 시각 입력 고도화 — 허용/거부 표. 결과는 항상 HH:MM.
  it.each([
    ["9", "09:00"],
    ["09", "09:00"],
    ["0", "00:00"],
    ["23", "23:00"],
    ["930", "09:30"],
    ["1530", "15:30"],
    ["15:30", "15:30"],
    ["9:05", "09:05"],
    ["15.30", "15:30"],
    ["15-30", "15:30"],
    ["15 30", "15:30"],
    ["15시", "15:00"],
    ["15시30분", "15:30"],
    ["15시 30분", "15:30"],
    ["9시5분", "09:05"],
    ["15시30", "15:30"],
    ["3시 30", "03:30"],
    ["오전 9시", "09:00"],
    ["오후 3시", "15:00"],
    ["오후 3시30분", "15:30"],
    ["오전 12시", "00:00"],
    ["오후 12시", "12:00"],
    ["오후12:30", "12:30"],
    ["3pm", "15:00"],
    ["3 PM", "15:00"],
    ["pm 3:30", "15:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["9:30am", "09:30"],
    ["１５：３０", "15:30"],
    ["１５３０", "15:30"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
  ])("accepts %j as %s", (raw, want) => {
    const got = parseTimeInput(raw);
    expect(got).toBe(want);
    expect(got).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
  it.each([
    "24:00",
    "2400",
    "24",
    "15:3", // 모호: 15:03 인지 15:30 인지
    "9:5",
    "9시5",
    "15:60",
    "0099",
    "오후 13시",
    "오전 0시",
    "pm 0",
    "13pm",
    "오후",
    "pm",
    "15:",
    ":30",
    "12345",
    "1:2:3",
    "오전 오후 3시",
    "-1",
    "9.5.1",
  ])("rejects %j", (raw) => {
    expect(parseTimeInput(raw)).toBeNull();
  });
  it("also returns null for an empty string — callers must check blank *before* calling this", () => {
    expect(parseTimeInput("")).toBeNull();
  });
});

describe("parseEventDateInput", () => {
  it("parses a bare year, including negative (BCE)", () => {
    expect(parseEventDateInput("1592")).toEqual({ year: 1592, month: null, day: null });
    expect(parseEventDateInput("-350")).toEqual({ year: -350, month: null, day: null });
  });
  it("parses year.month", () => {
    expect(parseEventDateInput("1592.05")).toEqual({ year: 1592, month: 5, day: null });
    expect(parseEventDateInput("1592.5")).toEqual({ year: 1592, month: 5, day: null });
  });
  it("parses year.month.day", () => {
    expect(parseEventDateInput("1592.05.13")).toEqual({ year: 1592, month: 5, day: 13 });
  });
  it("rejects out-of-range month or day", () => {
    expect(parseEventDateInput("1592.13")).toBeNull();
    expect(parseEventDateInput("1592.05.32")).toBeNull();
    expect(parseEventDateInput("1592.00")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseEventDateInput("")).toBeNull();
    expect(parseEventDateInput("abc")).toBeNull();
    expect(parseEventDateInput("1592.05.13.01")).toBeNull();
  });
});

describe("toDateInputValue", () => {
  it("formats a full day-precision date for <input type=date>", () => {
    expect(toDateInputValue(1592, 5, 13)).toBe("1592-05-13");
    expect(toDateInputValue(2026, 7, 29)).toBe("2026-07-29");
  });
  it("returns empty for year-only or year.month precision — no fabricated day", () => {
    expect(toDateInputValue(1592, null, null)).toBe("");
    expect(toDateInputValue(1592, 5, null)).toBe("");
  });
  it("returns empty for BCE or year-0 — outside what the native picker supports", () => {
    expect(toDateInputValue(-350, 1, 1)).toBe("");
    expect(toDateInputValue(0, 1, 1)).toBe("");
  });
});

describe("parseDateInputValue", () => {
  it("parses the native picker's YYYY-MM-DD", () => {
    expect(parseDateInputValue("2026-07-29")).toEqual({ year: 2026, month: 7, day: 29 });
  });
  it("returns null for empty/malformed input", () => {
    expect(parseDateInputValue("")).toBeNull();
    expect(parseDateInputValue("not-a-date")).toBeNull();
  });
});

describe("event range (Dashboard Wave 1)", () => {
  it("hasEventEnd is true only when end_year is set", () => {
    expect(hasEventEnd({ end_year: null, end_month: null, end_day: null })).toBe(false);
    expect(hasEventEnd({ end_year: 1796, end_month: null, end_day: null })).toBe(true);
  });

  it("rejects start after end", () => {
    expect(
      isStartAfterEnd(
        { year: 1800, month: null, day: null },
        { end_year: 1796, end_month: null, end_day: null },
      ),
    ).toBe(true);
    expect(
      isStartAfterEnd(
        { year: 1794, month: 7, day: 13 },
        { end_year: 1796, end_month: 12, end_day: 31 },
      ),
    ).toBe(false);
  });

  it("coarse end precision does not falsely reverse against a finer start", () => {
    // start 1794.07.13 vs end 1794 (year only) — still valid (end treated as latest in year)
    expect(
      isStartAfterEnd(
        { year: 1794, month: 7, day: 13 },
        { end_year: 1794, end_month: null, end_day: null },
      ),
    ).toBe(false);
  });

  it("isInvalidEventEnd enforces end_day⇒end_month⇒end_year", () => {
    expect(isInvalidEventEnd({ end_year: null, end_month: 6, end_day: null })).toBe(true);
    expect(isInvalidEventEnd({ end_year: 1796, end_month: null, end_day: 1 })).toBe(true);
    expect(isInvalidEventEnd({ end_year: 1796, end_month: 12, end_day: 31 })).toBe(false);
  });

  it("formatEventBadge shows a range when end is set, else single point", () => {
    expect(
      formatEventBadge(1794, null, null, { end_year: null, end_month: null, end_day: null }),
    ).toBe("1794");
    expect(
      formatEventBadge(1794, null, null, { end_year: 1796, end_month: null, end_day: null }),
    ).toBe("1794 – 1796");
  });
});

// Range-calendar popover badge label (Dashboard §2 redesign, 2026-08-01) — see eventDate.ts
// header comment on formatDateBadgeLabel for how this differs from formatEventBadge above.
describe("formatDateBadgeLabel", () => {
  it("start only, full precision", () => {
    expect(formatDateBadgeLabel(2026, 7, 1, { end_year: null, end_month: null, end_day: null })).toBe(
      "2026.07.01",
    );
  });
  it("year-month, no end", () => {
    expect(formatDateBadgeLabel(2026, 7, null, { end_year: null, end_month: null, end_day: null })).toBe(
      "2026.07",
    );
  });
  it("year-only, no end", () => {
    expect(formatDateBadgeLabel(2026, null, null, { end_year: null, end_month: null, end_day: null })).toBe(
      "2026",
    );
  });
  it("start + end, full day precision on both — explicit range even within the same month", () => {
    expect(
      formatDateBadgeLabel(2026, 7, 1, { end_year: 2026, end_month: 7, end_day: 5 }),
    ).toBe("2026.07.01 – 2026.07.05");
  });
  it("start + end crossing months/years, full day precision — explicit range", () => {
    expect(
      formatDateBadgeLabel(2026, 7, 1, { end_year: 2027, end_month: 1, end_day: 3 }),
    ).toBe("2026.07.01 – 2027.01.03");
  });
  it("same-day range collapses to a single date", () => {
    expect(
      formatDateBadgeLabel(2026, 7, 1, { end_year: 2026, end_month: 7, end_day: 1 }),
    ).toBe("2026.07.01");
  });
  it("partial-precision end falls back to formatEventDateRange's coarsest-common-precision", () => {
    expect(
      formatDateBadgeLabel(1794, null, null, { end_year: 1796, end_month: null, end_day: null }),
    ).toBe("1794 – 1796");
  });
});

// 오너 피드백(2026-09-07, 스크린샷): note_dates 행이 "2026-10-06" 하이픈으로 그려져 대표 행의
// "2026.10.07 – 2026.11.20"과 표기가 섞였다. formatNoteDateRow는 같은 formatDateBadgeLabel을
// 타므로 세 자리(칩·대표 행·관련 행)가 같은 입력에 같은 출력을 낸다.
describe("formatNoteDateRow", () => {
  it("single day (no end) → yyyy.mm.dd only, not the raw hyphenated ISO string", () => {
    expect(formatNoteDateRow("2026-10-06", null)).toBe("2026.10.06");
  });
  it("range → yyyy.mm.dd – yyyy.mm.dd", () => {
    expect(formatNoteDateRow("2026-10-07", "2026-11-20")).toBe("2026.10.07 – 2026.11.20");
  });
  it("same-day range collapses to a single date, matching formatDateBadgeLabel", () => {
    expect(formatNoteDateRow("2026-10-07", "2026-10-07")).toBe("2026.10.07");
  });
  it("malformed input falls back to the raw string rather than throwing", () => {
    expect(formatNoteDateRow("not-a-date", null)).toBe("not-a-date");
  });
});

describe("guardTimeTyping", () => {
  const type = (s: string) => [...s].reduce((acc, ch) => guardTimeTyping(acc, acc + ch), "");
  it.each([
    ["1530", "15:30"],
    ["9", "09:"],
    ["930", "09:30"],
    ["0", "0"],
    ["12345", "12:34"], // 다섯째 자리는 무시
  ])("typing %j", (input, out) => {
    expect(type(input)).toBe(out);
  });
  it("ignores hour>23 and minute tens>5", () => {
    expect(type("24")).toBe("2");
    expect(type("156")).toBe("15:");
  });
  it("lets backspace through the auto colon", () => {
    expect(guardTimeTyping("15:", "15")).toBe("15");
  });
  it("leaves Korean/English forms to the parser", () => {
    expect(guardTimeTyping("", "오후 3시")).toBe("오후 3시");
    expect(guardTimeTyping("3", "3pm")).toBe("3pm");
  });
});
