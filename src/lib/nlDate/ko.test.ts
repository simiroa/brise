/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — case catalog for the Korean grammar (ko.ts).
 * Reference date fixed at 2026-09-18 09:00 (a Friday) so every relative case below is
 * deterministic; the "이번주/다음주 X요일" expected dates were computed once against this exact
 * reference (see PLAN §W1 session notes) rather than re-derived by hand per case.
 */
import { describe, expect, it } from "vitest";
import { parseKorean } from "./ko";

const REF = new Date(2026, 8, 18, 9, 0, 0); // 2026-09-18 (금)

/** Pulls the substring the parser says it consumed, so test cases assert on readable text instead
 * of raw character offsets. */
function matched(text: string, range: [number, number]): string {
  return text.slice(range[0], range[1]);
}

describe("parseKorean — date-only phrases", () => {
  it.each([
    { text: "오늘 저녁 산책", date: { year: 2026, month: 9, day: 18 }, span: "오늘", title: "저녁 산책" },
    { text: "내일 소풍", date: { year: 2026, month: 9, day: 19 }, span: "내일", title: "소풍" },
    { text: "모레 병원 예약", date: { year: 2026, month: 9, day: 20 }, span: "모레", title: "병원 예약" },
    {
      text: "이번주 화요일 세미나",
      date: { year: 2026, month: 9, day: 15 },
      span: "이번주 화요일",
      title: "세미나",
    },
    {
      text: "다음주 금요일 워크숍",
      date: { year: 2026, month: 9, day: 25 },
      span: "다음주 금요일",
      title: "워크숍",
    },
    { text: "9월 25일 발표", date: { year: 2026, month: 9, day: 25 }, span: "9월 25일", title: "발표" },
    { text: "3일 뒤 마감", date: { year: 2026, month: 9, day: 21 }, span: "3일 뒤", title: "마감" },
    { text: "5일 후 정산", date: { year: 2026, month: 9, day: 23 }, span: "5일 후", title: "정산" },
  ])("$text", ({ text, date, span, title }) => {
    const result = parseKorean(text, REF);
    expect(result).not.toBeNull();
    expect(result!.start).toEqual(date);
    expect(result!.startTime).toBeNull();
    expect(result!.end).toEqual({ end_year: null, end_month: null, end_day: null });
    expect(result!.endTime).toBeNull();
    expect(result!.rrule).toBeNull();
    expect(result!.title).toBe(title);
    expect(result!.confidence).toBe("high");
    expect(matched(text, result!.matchRange)).toBe(span);
  });
});

describe("parseKorean — time of day", () => {
  it("오후 N시 (explicit meridiem, no minutes)", () => {
    const text = "내일 오후 2시 회의";
    const result = parseKorean(text, REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBe("14:00");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("회의");
  });

  it("오전 N시 반 (half hour)", () => {
    const text = "내일 오전 10시 반 병원";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBe("10:30");
    expect(result!.title).toBe("병원");
    expect(result!.confidence).toBe("high");
  });

  it("오후 N시 N분", () => {
    const text = "내일 오후 3시 45분 미팅";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBe("15:45");
    expect(result!.title).toBe("미팅");
  });

  it("오전 12시 = midnight (00:00), 오후 12시 = noon (12:00)", () => {
    expect(parseKorean("내일 오전 12시 기상", REF)!.startTime).toBe("00:00");
    expect(parseKorean("내일 오후 12시 점심", REF)!.startTime).toBe("12:00");
  });

  it("time phrase with no date phrase defaults start to the reference date", () => {
    const text = "오후 3시 점심 약속";
    const result = parseKorean(text, REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 18 });
    expect(result!.startTime).toBe("15:00");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("점심 약속");
  });

  it("13..23 without a meridiem marker is unambiguous 24h notation", () => {
    const result = parseKorean("내일 14시 제출", REF);
    expect(result!.startTime).toBe("14:00");
    expect(result!.confidence).toBe("high");
  });

  it("an explicit meridiem with an out-of-range hour (오후 14시) is malformed, not 26:00", () => {
    const result = parseKorean("내일 오후 14시 회의", REF);
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("low");
  });

  it("an out-of-range minute (75분) is rejected rather than emitted as-is", () => {
    const result = parseKorean("내일 오후 3시 75분 미팅", REF);
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("low");
  });

  it("an hour past 24h notation (25시) is rejected even with no meridiem marker", () => {
    const result = parseKorean("내일 25시 제출", REF);
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("low");
  });

  it("date and time phrases that aren't adjacent still both get removed from the title", () => {
    const result = parseKorean("내일 회의는 3시에", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    // 3시 alone has no meridiem — ambiguous, same as the owner's example.
    expect(result!.startTime).toBeNull();
    expect(result!.title).toBe("회의는");
  });
});

describe("parseKorean — ranges and ambiguity", () => {
  it('owner\'s example: "내일 2시부터 10시까지 경복궁방문" — bare hours with no 오전/오후 on either ' +
    "side must NOT be guessed", () => {
    const text = "내일 2시부터 10시까지 경복궁방문";
    const result = parseKorean(text, REF);
    expect(result).not.toBeNull();
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBeNull();
    expect(result!.end).toEqual({ end_year: null, end_month: null, end_day: null });
    expect(result!.endTime).toBeNull();
    expect(result!.rrule).toBeNull();
    expect(result!.title).toBe("경복궁방문");
    expect(result!.confidence).toBe("low");
    expect(matched(text, result!.matchRange)).toBe("내일 2시부터 10시까지");
  });

  it("both sides explicit → full range, high confidence", () => {
    const text = "내일 오후 2시부터 오후 10시까지 회의";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBe("14:00");
    expect(result!.endTime).toBe("22:00");
    expect(result!.end).toEqual({ end_year: null, end_month: null, end_day: null });
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("회의");
  });

  it("only the start side states a meridiem → start known, end left null, low confidence", () => {
    const text = "내일 오후 2시부터 10시까지 경복궁 방문";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBe("14:00");
    expect(result!.endTime).toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.title).toBe("경복궁 방문");
  });

  it('"~" (물결) works as a range separator too, with no trailing 까지', () => {
    const text = "내일 오후 2시~오후 10시 회의";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBe("14:00");
    expect(result!.endTime).toBe("22:00");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("회의");
  });

  it("end-only (까지, no 부터) with an unambiguous hour: endTime is still populated, but overall " +
    "confidence stays low because the start is unknown", () => {
    const text = "내일 14시까지 제출";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBeNull();
    expect(result!.endTime).toBe("14:00");
    expect(result!.confidence).toBe("low");
    expect(result!.title).toBe("제출");
  });

  it("end-only with an ambiguous hour: neither time is populated", () => {
    const text = "내일 10시까지 제출";
    const result = parseKorean(text, REF);
    expect(result!.startTime).toBeNull();
    expect(result!.endTime).toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.title).toBe("제출");
  });
});

describe("parseKorean — recurrence", () => {
  it("매주 X요일 → next-or-today occurrence + minimal RRULE", () => {
    // REF itself is a Friday, so "매주 금요일" resolves to today.
    const text = "매주 금요일 오전 9시 팀 회의";
    const result = parseKorean(text, REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 18 });
    expect(result!.startTime).toBe("09:00");
    expect(result!.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("팀 회의");
  });

  it("매주 X요일 rolls forward to the next occurrence when today isn't that weekday", () => {
    const result = parseKorean("매주 화요일 스크럼", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 22 });
    expect(result!.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
  });
});

describe("parseKorean — no recognizable date or time", () => {
  it("returns null rather than fabricating a date", () => {
    expect(parseKorean("그냥 아무 말이나 적어본다", REF)).toBeNull();
  });
});
