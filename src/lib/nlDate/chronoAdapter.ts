/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — shared wrapper around a chrono-node locale module
 * (`chrono-node`'s `en` or `fr` export), used by en.ts and fr.ts. Both locale modules expose the
 * same `{ parse(text, ref?) }` shape, so there is exactly one adapter instead of two near-copies.
 *
 * Empirically verified against chrono-node@2.10.1 (2026-09-18, see docs/PLAN-2026-09-18-nl-dates.md
 * §W1 session notes) before writing this — two things are NOT what they look like at first glance:
 *  - `ParsedComponents.get("hour")` is never null, even for a pure date match with no time in the
 *    text at all ("next Friday team meeting" still reports hour=12) — chrono always fills in an
 *    implied value. The only reliable "was there actually a time expression here" signal is
 *    `isCertain("hour")`.
 *  - `isCertain("meridiem")` is false whenever the source text didn't disambiguate AM/PM (English
 *    "at 2", French "à 2h") — that's the ambiguity signal this module needs, and it's true even
 *    when `isCertain("hour")` is true (the digit "2" itself was stated, just not which half of the
 *    day). We never use `get("hour")`'s own guessed value in the uncertain case.
 */
import type { ParsedComponents, ParsedResult } from "chrono-node";
import type { EventDate, EventEnd } from "../../components/titlebar/eventDate";
import type { NlDateConfidence, NlDateParseResult } from "./types";

export interface ChronoLocale {
  parse(text: string, ref?: Date): ParsedResult[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** chrono can return several disjoint matches (e.g. two separate mentions in one sentence); this
 * module represents a single event, so it keeps whichever match consumed the most of the input —
 * in practice that is always the one that captured both ends of a range, when there is one. */
function pickBestResult(results: ParsedResult[]): ParsedResult | null {
  if (results.length === 0) return null;
  return results.reduce((best, r) => (r.text.length > best.text.length ? r : best), results[0]);
}

function extractTime(component: ParsedComponents | undefined): {
  time: string | null;
  hasHour: boolean;
} {
  if (!component || !component.isCertain("hour")) return { time: null, hasHour: false };
  const certainMeridiem = component.isCertain("meridiem");
  if (!certainMeridiem) return { time: null, hasHour: true };
  const hour = component.get("hour") as number;
  const minute = (component.get("minute") as number | null) ?? 0;
  return { time: `${pad2(hour)}:${pad2(minute)}`, hasHour: true };
}

export function parseWithChrono(
  locale: ChronoLocale,
  text: string,
  referenceDate: Date,
): NlDateParseResult | null {
  const best = pickBestResult(locale.parse(text, referenceDate));
  if (!best) return null;

  const startY = best.start.get("year") as number;
  const startM = best.start.get("month") as number;
  const startD = best.start.get("day") as number;
  const start: EventDate = { year: startY, month: startM, day: startD };

  const startInfo = extractTime(best.start);
  let confidence: NlDateConfidence = startInfo.hasHour && startInfo.time === null ? "low" : "high";

  let end: EventEnd = { end_year: null, end_month: null, end_day: null };
  let endTime: string | null = null;
  if (best.end) {
    const endY = best.end.get("year") as number;
    const endM = best.end.get("month") as number;
    const endD = best.end.get("day") as number;
    // Only a genuinely different calendar day becomes a distinct end date — a same-day range
    // ("2pm to 10pm tomorrow") carries its information entirely in endTime, matching how
    // note_dates itself keeps end_year/month/day independent of end_time (see types.ts).
    if (endY !== startY || endM !== startM || endD !== startD) {
      end = { end_year: endY, end_month: endM, end_day: endD };
    }
    const endInfo = extractTime(best.end);
    endTime = endInfo.time;
    if (endInfo.hasHour && endInfo.time === null) confidence = "low";
  }

  const matchStart = best.index;
  const matchEnd = best.index + best.text.length;
  const removed = `${text.slice(0, matchStart)} ${text.slice(matchEnd)}`;
  const title = removed.replace(/\s+/g, " ").trim() || null;

  return {
    start,
    startTime: startInfo.time,
    end,
    endTime,
    // chrono-node's open-source build has no recurrence parsing (see types.ts) — only ko.ts
    // derives an rrule.
    rrule: null,
    title,
    matchRange: [matchStart, matchEnd],
    confidence,
  };
}
