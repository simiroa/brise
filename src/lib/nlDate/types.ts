/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — shared result shape for every locale parser in this
 * directory (ko.ts / en.ts / fr.ts) plus the dispatcher (index.ts). Pure data, no parsing logic.
 *
 * Reuses `EventDate`/`EventEnd` from the titlebar's event-axis module instead of redefining a
 * third date-triple type — same precision ladder (year → month → day) and the same end-triple
 * shape (`end_year`/`end_month`/`end_day`, all-null meaning "no distinct end date") that
 * `note_dates` and the rest of the calendar code already use (src-tauri/src/repo/notes/dates.rs).
 */
import type { EventDate, EventEnd } from "../../components/titlebar/eventDate";

export type NlDateLocale = "ko" | "en" | "fr";

/**
 * "high" only when every date/time component that ended up in the result was stated (or, for the
 * date itself, unambiguously implied — e.g. "tomorrow") rather than guessed. "low" means at least
 * one field was deliberately left `null` because the input didn't disambiguate it enough to commit
 * to a value (see each locale module's own comments for what triggers this) — this module never
 * fabricates a value to avoid returning "low" (§W1 plan: "무리하게 추정하지 않는다").
 */
export type NlDateConfidence = "high" | "low";

export interface NlDateParseResult {
  /** Event start date. Defaults to the reference date's own year/month/day when the input carries
   * a time but no recognizable date phrase (same default every locale here uses, matching
   * chrono-node's own behavior of filling in unstated date components from the reference date). */
  start: EventDate;
  /** "HH:MM" (24h, zero-padded), or null when no time was found, or the hour was found but its
   * AM/PM (or, for ko, its 오전/오후) was ambiguous and this module chose not to guess it. */
  startTime: string | null;
  /** Event end date triple. All-null (the default) means "no distinct end date" — this is also
   * what a same-day time-only range (e.g. "2pm to 10pm tomorrow") produces: the day doesn't change,
   * only `endTime` carries information, exactly mirroring how note_dates itself keeps end_year/
   * end_month/end_day independent of end_time. */
  end: EventEnd;
  /** "HH:MM" (24h, zero-padded), or null — same rules as `startTime`. */
  endTime: string | null;
  /** Minimal RRULE string (e.g. "FREQ=WEEKLY;BYDAY=FR"), or null when no recurrence was detected.
   * Only ko.ts currently derives this (§W1 1차 범위: "매주 X요일" only) — chrono-node's open-source
   * build has no recurrence parsing, so en.ts/fr.ts always return null here. */
  rrule: string | null;
  /** Best-effort event title: the input with the matched date/time span (`matchRange`) removed and
   * the remainder trimmed/collapsed. Null when nothing is left over. */
  title: string | null;
  /** [start, end) character offsets into the original input string spanned by the recognized
   * date/time expression(s) — the union from the earliest matched character to the latest, so a
   * caller can highlight or strip exactly what this module consumed. */
  matchRange: [number, number];
  confidence: NlDateConfidence;
}
