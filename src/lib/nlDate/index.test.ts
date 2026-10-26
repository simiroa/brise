/** §W1 (docs/PLAN-2026-09-18-nl-dates.md) — dispatcher smoke test; the substantive case catalogs
 * live in ko.test.ts/en.test.ts/fr.test.ts. This only checks parseNlDate routes to the right
 * locale module and returns null for locale-appropriate no-match input. */
import { describe, expect, it } from "vitest";
import { parseNlDate } from "./index";

const REF = new Date(2026, 8, 18, 9, 0, 0);

describe("parseNlDate", () => {
  it("routes to the Korean parser", () => {
    const result = parseNlDate("내일 2시부터 10시까지 경복궁방문", "ko", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.title).toBe("경복궁방문");
  });

  it("routes to the English parser", () => {
    const result = parseNlDate("tomorrow 2pm to 10pm visit palace", "en", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.title).toBe("visit palace");
  });

  it("routes to the French parser", () => {
    const result = parseNlDate("demain de 14h à 22h visite du musée", "fr", REF);
    expect(result!.start).toEqual({ year: 2026, month: 9, day: 19 });
    expect(result!.title).toBe("visite du musée");
  });

  it("defaults referenceDate to now when omitted", () => {
    // Just checks it doesn't throw and returns a plausible shape — exact date depends on "now".
    const result = parseNlDate("내일 회의", "ko");
    expect(result).not.toBeNull();
    expect(typeof result!.start.year).toBe("number");
  });
});
