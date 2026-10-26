/**
 * §2.3 HANDOFF-calendar-onboarding.md: event-axis precision (year / year.month / year.month.day).
 * Format matches the timeline zoom header notation the doc specifies (`1592` -> `1592.05` ->
 * `1592.05.13`) so the badge and the timeline headers read the same way everywhere in the app.
 */
export type EventDate = { year: number; month: number | null; day: number | null };

export function formatEventDate(year: number, month: number | null, day: number | null): string {
  if (month === null) return String(year);
  const m = String(month).padStart(2, "0");
  if (day === null) return `${year}.${m}`;
  return `${year}.${m}.${String(day).padStart(2, "0")}`;
}

/**
 * Formats a [min, max] event-date span (e.g. the timeline range readout) at whatever precision
 * both ends actually share — never fabricates precision a boundary note doesn't have:
 * - same year, both have a month, same month → single "YYYY.MM" (collapsed)
 * - same year, both have a month, different months → "YYYY.MM – YYYY.MM"
 * - same year, either month unknown → "YYYY" (coarsest common precision)
 * - different years, both boundaries have full day precision → "YYYY.MM.DD – YYYY.MM.DD"
 * - different years, either boundary missing month/day → "YYYY – YYYY" (fall back coarser)
 */
export function formatEventDateRange(min: EventDate, max: EventDate): string {
  if (min.year === max.year) {
    if (min.month !== null && max.month !== null) {
      if (min.month === max.month) return formatEventDate(min.year, min.month, null);
      return `${formatEventDate(min.year, min.month, null)} – ${formatEventDate(max.year, max.month, null)}`;
    }
    return String(min.year);
  }
  if (min.month !== null && min.day !== null && max.month !== null && max.day !== null) {
    return `${formatEventDate(min.year, min.month, min.day)} – ${formatEventDate(max.year, max.month, max.day)}`;
  }
  return `${min.year} – ${max.year}`;
}

/**
 * Parses "YYYY", "YYYY.MM", or "YYYY.MM.DD" (negative year allowed for BCE). Returns null for
 * anything else, or when month/day fall outside 1..12 / 1..31 — the caller should leave the
 * prior value in place rather than commit a partial/garbage parse.
 */
export function parseEventDateInput(raw: string): EventDate | null {
  const m = raw.trim().match(/^(-?\d{1,4})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  if (!Number.isFinite(year)) return null;
  const month = m[2] !== undefined ? parseInt(m[2], 10) : null;
  if (month !== null && !(month >= 1 && month <= 12)) return null;
  const day = m[3] !== undefined ? parseInt(m[3], 10) : null;
  if (day !== null && !(day >= 1 && day <= 31)) return null;
  return { year, month, day };
}

/**
 * Parses a typed 24h clock time — "0003", "00:03", "1402", "14:02" — into "HH:MM", zero-padded.
 * Sibling of parseEventDateInput above, same idiom: garbage in → null out, caller reverts to the
 * last-committed value instead of writing it.
 *
 * NoteDatesList's reminder time chips replaced native `<input type="time">` with this (2026-09-10
 * owner-approved proposal 2) — the native picker renders locale-formatted ("오전 12:03" in ko) next
 * to a 24h chip summary ("00:03"), two notations for one value, and its clock icon opens a second,
 * OS-level picker on top of this app's own calendar popover (same reason RepeatInlineEditor's UNTIL
 * input was dropped, see NoteDatesList.tsx).
 *
 * Deliberately does NOT treat "" as valid-and-clearing here — an empty raw and a garbage raw both
 * parse to null, which would make a typo silently clear a saved time. The caller must check
 * `raw.trim() === ""` *before* calling this and treat that case as "clear the time" on its own
 * (mirrors DatesPanel.tsx's commitStartText: parse first, blank/invalid handled by the caller).
 */
export function parseTimeInput(raw: string): string | null {
  // NFKC: 전각 숫자·콜론("１５：３０")을 반각으로.
  let s = raw.normalize("NFKC").toLowerCase().trim();
  // 오전/오후/am/pm — 앞이나 뒤에 한 번.
  let meridiem: "am" | "pm" | null = null;
  const pre = s.match(/^(오전|오후|a\.?m\.?|p\.?m\.?)\s*(.*)$/);
  const post = pre ? null : s.match(/^(.*?)\s*(오전|오후|a\.?m\.?|p\.?m\.?)$/);
  const m = pre ?? post;
  if (m) {
    const tok = pre ? m[1] : m[2];
    meridiem = tok === "오전" || tok.startsWith("a") ? "am" : "pm";
    s = (pre ? m[2] : m[1]).trim();
  }
  // 구분자 둘레의 공백은 지운다(" 14 : 02 ").
  s = s.replace(/\s*([:.\-])\s*/g, "$1").replace(/\s+/g, " ");

  let hourStr: string;
  let minStr = "0";
  let g: RegExpMatchArray | null;
  if ((g = s.match(/^(\d{1,2})$/))) {
    hourStr = g[1]; // 시만 — "9" → 09:00
  } else if ((g = s.match(/^(\d{1,2})\s?시$/))) {
    hourStr = g[1];
  } else if ((g = s.match(/^(\d{1,2})\s?시\s?(\d{1,2})\s?분$/))) {
    hourStr = g[1];
    minStr = g[2];
  } else if ((g = s.match(/^(\d{1,2})\s?시\s?(\d{2})$/))) {
    hourStr = g[1]; // "15시30" — 분 한 자리는 "분"이 있을 때만(위 갈래)
    minStr = g[2];
  } else if ((g = s.match(/^(\d{1,2})[:.\- ](\d{2})$/))) {
    // 분은 반드시 두 자리 — "15:3" 은 15:03 인지 15:30 인지 모호하므로 거부한다.
    hourStr = g[1];
    minStr = g[2];
  } else if ((g = s.match(/^(\d{3,4})$/))) {
    hourStr = s.slice(0, s.length - 2);
    minStr = s.slice(-2);
  } else {
    return null;
  }
  let hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);
  if (meridiem) {
    if (!(hour >= 1 && hour <= 12)) return null;
    hour = meridiem === "am" ? hour % 12 : (hour % 12) + 12;
  }
  if (!(hour >= 0 && hour <= 23)) return null;
  if (!(min >= 0 && min <= 59)) return null;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * "YYYY-MM-DD" for `<input type="date">` — only when day precision is already set *and* the year
 * falls inside the range the native picker actually supports (0001..9999; it has no BCE concept).
 * Empty string otherwise, so the picker opens blank rather than showing a fabricated day for a
 * year-only/year.month record, or silently clamping a BCE year into a wrong CE one.
 */
export function toDateInputValue(year: number | null, month: number | null, day: number | null): string {
  if (year === null || month === null || day === null || year < 1 || year > 9999) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** Parses `<input type="date">`'s onChange value ("YYYY-MM-DD"). Null for empty/malformed. */
export function parseDateInputValue(raw: string): EventDate | null {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
}

/**
 * Dashboard Wave 1: event end triple. null end_year means no range (single-point note).
 * Invariants match repo::notes::validate_end_triple — end_day ⇒ end_month ⇒ end_year.
 */
export type EventEnd = {
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
};

export function hasEventEnd(end: EventEnd): boolean {
  return end.end_year != null;
}

/**
 * Start > end reversal check (mirrors repo::notes::assert_start_not_after_end).
 * Missing start precision = earliest (0); missing end precision = latest (99).
 */
export function isStartAfterEnd(
  start: EventDate,
  end: EventEnd,
): boolean {
  if (end.end_year == null) return false;
  const s = [start.year, start.month ?? 0, start.day ?? 0] as const;
  const e = [end.end_year, end.end_month ?? 99, end.end_day ?? 99] as const;
  if (s[0] !== e[0]) return s[0] > e[0];
  if (s[1] !== e[1]) return s[1] > e[1];
  return s[2] > e[2];
}

/** True when the end triple violates end_day⇒end_month⇒end_year or out-of-range. */
export function isInvalidEventEnd(end: EventEnd): boolean {
  if (end.end_day != null && end.end_month == null) return true;
  if (end.end_month != null && end.end_year == null) return true;
  if (end.end_year != null && (end.end_year < -9999 || end.end_year > 9999)) return true;
  if (end.end_month != null && (end.end_month < 1 || end.end_month > 12)) return true;
  if (end.end_day != null && (end.end_day < 1 || end.end_day > 31)) return true;
  return false;
}

/**
 * Badge label: single-point → formatEventDate; with end → formatEventDateRange.
 * Coerces partial end into EventDate (end_year required for hasEventEnd).
 */
export function formatEventBadge(
  year: number,
  month: number | null,
  day: number | null,
  end: EventEnd,
): string {
  if (end.end_year == null) return formatEventDate(year, month, day);
  return formatEventDateRange(
    { year, month, day },
    { year: end.end_year, month: end.end_month, day: end.end_day },
  );
}

/**
 * Formats a note_dates row ("YYYY-MM-DD" + optional end, always full day precision —
 * note_date_add enforces this) through the same formatDateBadgeLabel the chip and the primary
 * list row use, instead of printing the raw ISO string. Owner feedback (2026-09-07 screenshot):
 * the related-date rows showed a hyphenated "2026-10-06" next to the dot-formatted representative
 * row ("2026.10.07 – 2026.11.20") — two notations in one list. Single source of truth for all
 * three call sites (closed chip, representative row, related row).
 */
export function formatNoteDateRow(date: string, endDate: string | null): string {
  const start = parseDateInputValue(date);
  if (!start) return date;
  const end = endDate ? parseDateInputValue(endDate) : null;
  return formatDateBadgeLabel(start.year, start.month, start.day, {
    end_year: end?.year ?? null,
    end_month: end?.month ?? null,
    end_day: end?.day ?? null,
  });
}

/**
 * Badge label for the range-calendar popover (Dashboard §2 redesign, 2026-08-01). Differs from
 * formatEventBadge/formatEventDateRange above in one respect: when both boundaries carry full
 * day precision, this always shows the explicit day range instead of collapsing a same-month/
 * same-year span down to "YYYY.MM" — a 2026.07.01–2026.07.05 note shouldn't read as a bare whole
 * -month "2026.07" on its own badge (formatEventDateRange's collapse is deliberate for its own
 * caller, the timeline filter's *coarsest-common-precision* range readout over many notes — a
 * different question ("what precision do these two arbitrary boundaries agree on") from "what are
 * this one note's exact start/end"). A same-day range (start === end exactly) still collapses to
 * a single date. Partial-precision ends (year-only/year-month, still reachable via the popover's
 * compact fallback input) fall back to formatEventDateRange's coarsest-common-precision behavior
 * unchanged.
 */
export function formatDateBadgeLabel(
  year: number,
  month: number | null,
  day: number | null,
  end: EventEnd,
): string {
  if (end.end_year == null) return formatEventDate(year, month, day);
  if (year === end.end_year && month === end.end_month && day === end.end_day) {
    return formatEventDate(year, month, day);
  }
  if (month != null && day != null && end.end_month != null && end.end_day != null) {
    return `${formatEventDate(year, month, day)} – ${formatEventDate(end.end_year, end.end_month, end.end_day)}`;
  }
  return formatEventDateRange(
    { year, month, day },
    { year: end.end_year, month: end.end_month, day: end.end_day },
  );
}

/** 시각 입력창 **타이핑 가드** — 잘못된 키 입력을 알림 대신 입력 단계에서 막는다.
 *  숫자/구분자만 쓰는 입력("9", "1530", "15:30")에는 즉시 적용: 4자리 초과·시 24 이상·분 십의 자리 6 이상은
 *  그 키 입력을 무시(= `prev` 유지), 첫 자리가 3~9 면 앞에 0 을 붙이고, 두 자리가 차면 콜론을 자동 삽입한다
 *  (지우는 중에는 콜론을 다시 붙이지 않아 백스페이스가 막히지 않는다).
 *  한글·영문이 섞인 입력("오후 3시", "3pm")은 건드리지 않고 `parseTimeInput` 의 관대한 경로에 맡긴다. */
export function guardTimeTyping(prev: string, next: string): string {
  const half = next.normalize("NFKC");
  if (/[^0-9:.\-\s]/.test(half)) return next;
  const digits = half.replace(/\D/g, "");
  if (digits === "") return "";
  const growing = half.length > prev.normalize("NFKC").length;
  let d = digits;
  if (d.length > 4) return prev;
  if (growing && d.length === 1 && d[0] >= "3") d = `0${d}`;
  if (d.length >= 2 && Number(d.slice(0, 2)) > 23) return prev;
  if (d.length >= 3 && d[2] > "5") return prev;
  if (d.length <= 2) return d.length === 2 && growing ? `${d}:` : d;
  return `${d.slice(0, 2)}:${d.slice(2)}`;
}
