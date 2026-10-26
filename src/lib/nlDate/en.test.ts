/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — case catalog for the English wrapper (en.ts), mirroring
 * the shape of ko.test.ts's cases (owner's example, a same-day time range, a meridiem-ambiguous
 * hour, a pure date match, and an absolute date/time). Reference date fixed at 2026-09-18 09:00
 * (a Friday) — same reference ko.test.ts uses, so the two catalogs are directly comparable.
 */
import { describe, expect, it } from "vitest";
import { parseEnglish } from "./en";

const REF = new Date(2026, 8, 18, 9, 0, 0); // 2026-09-18

describe("parseEnglish", () => {
  it('en analogue of the owner\'s example: "tomorrow 2pm to 10pm visit palace"', () => {
    const result = parseEnglish("tomorrow 2pm to 10pm visit palace", REF);
    expect(result).not.toBeNull();
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBe("14:00");
    expect(result!.end).toEqual({ end_year: null, end_month: null, end_day: null });
    expect(result!.endTime).toBe("22:00");
    expect(result!.rrule).toBeNull();
    expect(result!.title).toBe("visit palace");
    expect(result!.confidence).toBe("high");
  });

  it('ambiguous meridiem ("at 2", no am/pm) is left null rather than guessed', () => {
    const result = parseEnglish("tomorrow at 2 visit museum", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.title).toBe("visit museum");
  });

  it("named weekday + explicit time, both certain", () => {
    const result = parseEnglish("next Friday 3pm team meeting", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 25 });
    expect(result!.startTime).toBe("15:00");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("team meeting");
  });

  it("pure date match (no time expression in the text at all) stays high confidence with a null startTime", () => {
    const result = parseEnglish("next Friday team meeting", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 25 });
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("team meeting");
  });

  it("absolute date + time", () => {
    const result = parseEnglish("2026.9.20 15:30 dentist appointment", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 20 });
    expect(result!.startTime).toBe("15:30");
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("dentist appointment");
  });

  it("returns null rather than fabricating a date", () => {
    expect(parseEnglish("just a random sentence with no dates", REF)).toBeNull();
  });
});
