/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — public entry point for the natural-language date/time
 * parser. Pure library, no UI/editor wiring (that's W2/W3, out of this wave's scope) — a caller
 * picks a locale and gets a single best-effort parse of the whole input string back.
 */
import type { NlDateLocale, NlDateParseResult } from "./types";
import { parseKorean } from "./ko";
import { parseEnglish } from "./en";
import { parseFrench } from "./fr";

export type { NlDateLocale, NlDateParseResult, NlDateConfidence } from "./types";

/**
 * Parses `text` as a natural-language date/time expression in `locale`, relative to
 * `referenceDate` (defaults to now). Returns null when nothing recognizable was found; otherwise a
 * result that may still carry `confidence: "low"` and null time fields when the input itself was
 * ambiguous (see types.ts and each locale module for what that covers).
 */
export function parseNlDate(
  text: string,
  locale: NlDateLocale,
  referenceDate: Date = new Date(),
): NlDateParseResult | null {
  switch (locale) {
    case "ko":
      return parseKorean(text, referenceDate);
    case "en":
      return parseEnglish(text, referenceDate);
    case "fr":
      return parseFrench(text, referenceDate);
  }
}
