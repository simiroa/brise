/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — case catalog for the French wrapper (fr.ts), same
 * shape as en.test.ts/ko.test.ts. Reference date fixed at 2026-09-18 09:00 (a Friday).
 */
import { describe, expect, it } from "vitest";
import { parseFrench } from "./fr";

const REF = new Date(2026, 8, 18, 9, 0, 0); // 2026-09-18

describe("parseFrench", () => {
  it('fr analogue of the owner\'s example: "demain de 14h à 22h visite du musée"', () => {
    const result = parseFrench("demain de 14h à 22h visite du musée", REF);
    expect(result).not.toBeNull();
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBe("14:00");
    expect(result!.end).toEqual({ end_year: null, end_month: null, end_day: null });
    expect(result!.endTime).toBe("22:00");
    expect(result!.rrule).toBeNull();
    expect(result!.title).toBe("visite du musée");
    expect(result!.confidence).toBe("high");
  });

  it('ambiguous meridiem ("à 2h", French has no inherent am/pm marker here) is left null', () => {
    const result = parseFrench("demain à 2h visite du musée", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.title).toBe("visite du musée");
  });

  it("pure date match (no time in the text) stays high confidence", () => {
    const result = parseFrench("mardi prochain réunion budget", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 22 });
    expect(result!.startTime).toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.title).toBe("réunion budget");
  });

  it("returns null rather than fabricating a date", () => {
    expect(parseFrench("juste une phrase sans aucune date", REF)).toBeNull();
  });
});
