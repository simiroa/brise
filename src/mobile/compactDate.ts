const LOCALE_BY_LANG: Record<string, string> = { ko: "ko-KR", en: "en-US", fr: "fr-FR" };

function localeFor(uiLang: string): string {
  return LOCALE_BY_LANG[uiLang] ?? "en-US";
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local-calendar-day "is today" (not UTC — the phone lists are glance-at-your-phone views, "오늘"
 *  should mean the user's own today, unlike the record-histogram/date-range chips elsewhere in the
 *  app which are deliberately UTC-bucketed navigational aids, see lib/dateRange.ts's comment).
 *  A timestamp ahead of `now` (clock skew between devices) counts as today too, never as older. */
function isLocalToday(noted: Date, now: Date): boolean {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(noted)) / 86_400_000) <= 0;
}

/** Compact row date — time-of-day for today's notes, month/day (native Intl, locale-aware)
 *  otherwise; adds the year when it's not the current one. Native Intl instead of hand-rolled
 *  per-language strings — one implementation covers en/ko/fr. An unparsable timestamp renders as
 *  "" (never throws). */
export function formatCompactDate(updatedAtIso: string, uiLang: string, now: Date = new Date()): string {
  const d = new Date(updatedAtIso);
  if (Number.isNaN(d.getTime())) return "";
  const locale = localeFor(uiLang);
  if (isLocalToday(d, now)) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  }
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
