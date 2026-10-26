/**
 * §W1 (docs/PLAN-2026-09-18-nl-dates.md) — Korean natural-language date/time parser.
 *
 * chrono-node has no Korean locale, so this is an independent regex-based grammar rather than a
 * Parser/Refiner plugged into chrono's Chrono class — the plan explicitly allows either and, for
 * the 1차 범위 listed below, integrating with chrono's internal component/refiner machinery would
 * be pure overhead (there is nothing to share with the en/fr wrappers; see chronoAdapter.ts).
 *
 * 1차 범위 (plan §W1):
 *  - 날짜: 오늘/내일/모레, 이번주·다음주 X요일, N월 N일, N일 뒤/후
 *  - 시각·구간: 오전/오후 N시(반, N분), "A부터 B까지", "~" 물결 구간
 *  - 반복: 매주 X요일 → 최소 RRULE(`FREQ=WEEKLY;BYDAY=..`)
 *  - 나머지 텍스트를 title 후보로
 *
 * Multi-day date *ranges* ("9월 19일부터 9월 21일까지") are out of scope here — the plan's 구간
 * bullet is under 시각 (time), not 날짜 (date); only one date phrase is recognized per input.
 */
import type { EventDate, EventEnd } from "../../components/titlebar/eventDate";
import type { NlDateConfidence, NlDateParseResult } from "./types";

const KO_WEEKDAY_ISO: Record<string, number> = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };
const KO_WEEKDAY_RRULE: Record<string, string> = {
  월: "MO",
  화: "TU",
  수: "WE",
  목: "TH",
  금: "FR",
  토: "SA",
  일: "SU",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** ISO weekday: Monday=1 .. Sunday=7 (JS's own getDay() is Sunday=0 .. Saturday=6). */
function isoWeekdayOf(date: Date): number {
  const g = date.getDay();
  return g === 0 ? 7 : g;
}

function mondayOfWeek(date: Date): Date {
  return addDays(date, -(isoWeekdayOf(date) - 1));
}

/** Next occurrence of `targetIso`, including today itself if today already is that weekday —
 * the natural reading of "매주 금요일" said on a Friday: the series' next occurrence is today. */
function nextOrTodayWeekday(date: Date, targetIso: number): Date {
  const diff = (targetIso - isoWeekdayOf(date) + 7) % 7;
  return addDays(date, diff);
}

function toEventDate(date: Date): EventDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

interface DateMatch {
  date: EventDate;
  range: [number, number];
  rrule: string | null;
}

/** Tries each date grammar rule in priority order, returns the first match. Only one date phrase
 * is extracted per input (matches the 1차 범위 case catalog — none of the required cases combine
 * two distinct date phrases). */
function findDate(text: string, referenceDate: Date): DateMatch | null {
  let m = /이번\s*주\s*([월화수목금토일])\s*요일/.exec(text);
  if (m) {
    const monday = mondayOfWeek(referenceDate);
    const date = addDays(monday, KO_WEEKDAY_ISO[m[1]] - 1);
    return { date: toEventDate(date), range: [m.index, m.index + m[0].length], rrule: null };
  }

  m = /다음\s*주\s*([월화수목금토일])\s*요일/.exec(text);
  if (m) {
    const nextMonday = addDays(mondayOfWeek(referenceDate), 7);
    const date = addDays(nextMonday, KO_WEEKDAY_ISO[m[1]] - 1);
    return { date: toEventDate(date), range: [m.index, m.index + m[0].length], rrule: null };
  }

  // 매주 X요일 — also the only source of a non-null rrule in this module (chrono-node's OSS build
  // has no recurrence parsing at all, so en.ts/fr.ts never produce one; see types.ts).
  m = /매주\s*([월화수목금토일])\s*요일/.exec(text);
  if (m) {
    const targetIso = KO_WEEKDAY_ISO[m[1]];
    const date = nextOrTodayWeekday(referenceDate, targetIso);
    return {
      date: toEventDate(date),
      range: [m.index, m.index + m[0].length],
      rrule: `FREQ=WEEKLY;BYDAY=${KO_WEEKDAY_RRULE[m[1]]}`,
    };
  }

  m = /오늘|내일|모레/.exec(text);
  if (m) {
    const offset = m[0] === "오늘" ? 0 : m[0] === "내일" ? 1 : 2;
    const date = addDays(referenceDate, offset);
    return { date: toEventDate(date), range: [m.index, m.index + m[0].length], rrule: null };
  }

  m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    // ponytail: always resolves against referenceDate's year — a month/day already in the past
    // this year is not rolled forward into next year. Upgrade path if this bites: compare against
    // referenceDate and add a year when the resulting date is earlier than it.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        date: { year: referenceDate.getFullYear(), month, day },
        range: [m.index, m.index + m[0].length],
        rrule: null,
      };
    }
  }

  m = /(\d{1,2})\s*일\s*(뒤|후)/.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    const date = addDays(referenceDate, n);
    return { date: toEventDate(date), range: [m.index, m.index + m[0].length], rrule: null };
  }

  return null;
}

/**
 * Resolves a 12-hour "N시" reading given an optional 오전/오후 marker.
 *  - explicit marker, hour 1..12 → certain (0시=자정=오전12시, 12시=정오=오후12시 handled
 *    correctly). Explicit marker with hour outside 1..12 ("오후 14시") is malformed, not a valid
 *    12-hour reading — treated as uncertain rather than silently doing `14 + 12 = 26`.
 *  - no marker, hour 13..23 → certain: unambiguous 24h-clock notation ("14시" can only mean
 *    14:00, no one says "오후 14시").
 *  - no marker, hour 0 → certain: "0시" only ever means midnight.
 *  - no marker, hour 1..12 → genuinely ambiguous (could be either half of the day) — this is
 *    exactly the plan's own ambiguity example ("2시"만 있고 오전/오후 미지정) — return uncertain
 *    rather than guess.
 *  - hour outside 0..23 entirely (e.g. "25시") is always uncertain, marker or not.
 */
function resolveHour(hour: number, meridiem: "오전" | "오후" | null): { value: number | null; certain: boolean } {
  if (meridiem === "오전" || meridiem === "오후") {
    if (hour < 1 || hour > 12) return { value: null, certain: false };
    if (meridiem === "오전") return { value: hour === 12 ? 0 : hour, certain: true };
    return { value: hour === 12 ? 12 : hour + 12, certain: true };
  }
  if (hour === 0 || (hour >= 13 && hour <= 23)) return { value: hour, certain: true };
  return { value: null, certain: false };
}

/**
 * 시간대 낱말 → 오전/오후. 2026-10-07: 음성 전사문("내일 아침 8시")이 오전/오후 없이 말해서 날짜 후보가
 * 통째로 low 로 떨어지던 결함(S2 QA) — 구어에서 오전/오후 대신 쓰는 낱말을 같은 확정 읽기로 받는다.
 *  - 새벽·아침 → 오전, 점심·낮·저녁 → 오후. "아침 12시" 처럼 말이 안 되는 조합은 미확정으로 둔다.
 *  - 밤: 6~11시는 오후, 12시는 자정(00:00), 1~5시는 새벽(오전) — "밤 12시/밤 1시" 는 날짜가 넘어가는 시각이라
 *    구어 의미를 따른다(날짜 자체는 건드리지 않는다 — ponytail: "밤 12시" 가 다음날 0시인지는 사용자 의도에 달렸다).
 */
function meridiemOf(word: string | undefined, hour: number): "오전" | "오후" | "midnight" | null {
  switch (word) {
    case "오전":
    case "새벽":
      return "오전";
    case "오후":
    case "점심":
    case "낮":
    case "저녁":
      return "오후";
    case "아침":
      return hour >= 1 && hour <= 11 ? "오전" : null;
    case "밤":
      if (hour === 12) return "midnight";
      return hour >= 1 && hour <= 5 ? "오전" : hour >= 6 && hour <= 11 ? "오후" : null;
    default:
      return null;
  }
}

function resolveAtom(
  meridiem: string | undefined,
  hourStr: string,
  half: string | undefined,
  minuteStr: string | undefined,
): { time: string | null; ambiguous: boolean } {
  const hour = parseInt(hourStr, 10);
  const minute = half ? 30 : minuteStr !== undefined ? parseInt(minuteStr, 10) : 0;
  if (minute < 0 || minute > 59) return { time: null, ambiguous: true };
  const mer = meridiemOf(meridiem, hour);
  if (mer === "midnight") return { time: `00:${pad2(minute)}`, ambiguous: false };
  const resolved = resolveHour(hour, mer);
  if (!resolved.certain || resolved.value === null) return { time: null, ambiguous: true };
  return { time: `${pad2(resolved.value)}:${pad2(minute)}`, ambiguous: false };
}

// Each "atom" is one 12-hour time reading: optional 오전/오후(또는 아침·저녁 등 시간대 낱말), "N시", optional "반" or "N분".
const TIME_ATOM = "(오전|오후|새벽|아침|점심|낮|저녁|밤)?\\s*(\\d{1,2})\\s*시(?!간)(?:\\s*(반)|\\s*(\\d{1,2})\\s*분)?";
const TIME_RANGE_RE = new RegExp(`${TIME_ATOM}\\s*(?:부터|~|～|-|–)\\s*${TIME_ATOM}(?:\\s*까지)?`);
const TIME_END_ONLY_RE = new RegExp(`${TIME_ATOM}\\s*까지`);
const TIME_SINGLE_RE = new RegExp(TIME_ATOM);

interface TimeMatch {
  range: [number, number];
  startTime: string | null;
  endTime: string | null;
  ambiguous: boolean;
}

/** Tries range → end-only → single, in that order (a range match is also a valid end-only/single
 * match, so it must be tried first or it would never be reached). */
function findTime(text: string): TimeMatch | null {
  let m = TIME_RANGE_RE.exec(text);
  if (m) {
    const start = resolveAtom(m[1], m[2], m[3], m[4]);
    const end = resolveAtom(m[5], m[6], m[7], m[8]);
    return {
      range: [m.index, m.index + m[0].length],
      startTime: start.time,
      endTime: end.time,
      ambiguous: start.ambiguous || end.ambiguous,
    };
  }

  m = TIME_END_ONLY_RE.exec(text);
  if (m) {
    const end = resolveAtom(m[1], m[2], m[3], m[4]);
    return {
      range: [m.index, m.index + m[0].length],
      startTime: null,
      // An end time with no stated start is inherently under-specified (plan's own ambiguity
      // example: "종료시각만 있고 시작 없음") — always low-confidence, even when the hour itself
      // (e.g. "14시까지") is unambiguous, because the *event's start* is still unknown.
      endTime: end.time,
      ambiguous: true,
    };
  }

  m = TIME_SINGLE_RE.exec(text);
  if (m) {
    const start = resolveAtom(m[1], m[2], m[3], m[4]);
    return {
      range: [m.index, m.index + m[0].length],
      startTime: start.time,
      endTime: null,
      ambiguous: start.ambiguous,
    };
  }

  return null;
}

/** Removes each span in `ranges` from `text`, replacing it with a single space. Ranges must not
 * overlap; processes right-to-left so an earlier removal never shifts a later span's indices —
 * each range's start/end are indices into the *original* `text`, valid throughout. */
function removeRanges(text: string, ranges: Array<[number, number]>): string {
  const rightToLeft = [...ranges].sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [start, end] of rightToLeft) {
    result = `${result.slice(0, start)} ${result.slice(end)}`;
  }
  return result;
}

/** Removes the date span and the time span *individually* (not just the [min,max] union used for
 * the public `matchRange`) — a date and time that aren't adjacent in the sentence ("내일 회의는
 * 3시에") would otherwise take the event name out with them. */
function extractTitle(text: string, ranges: Array<[number, number]>): string | null {
  const removed = removeRanges(text, ranges);
  const cleaned = removed
    .replace(/\s+/g, " ")
    .trim()
    // best-effort: drop a bare leading/trailing particle left stranded by the removal (e.g. a
    // stray "에" where "3시에" had its "3시" removed) — not exhaustive, just the common ones.
    .replace(/^(에|은|는|이|가)(\s+|$)/, "")
    .replace(/\s(에|은|는|이|가)$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function noEnd(): EventEnd {
  return { end_year: null, end_month: null, end_day: null };
}

/**
 * Parses one Korean sentence. Returns null only when neither a date nor a time expression was
 * recognized at all — when at least one was found, always returns a result (possibly with
 * `confidence: "low"` and some fields left null; see resolveHour/findTime above for what counts
 * as ambiguous).
 */
export function parseKorean(text: string, referenceDate: Date = new Date()): NlDateParseResult | null {
  const dateMatch = findDate(text, referenceDate);
  const timeMatch = findTime(text);
  if (!dateMatch && !timeMatch) return null;

  const start: EventDate = dateMatch ? dateMatch.date : toEventDate(referenceDate);
  const confidence: NlDateConfidence = timeMatch?.ambiguous ? "low" : "high";

  const ranges: Array<[number, number]> = [];
  if (dateMatch) ranges.push(dateMatch.range);
  if (timeMatch) ranges.push(timeMatch.range);
  const matchStart = Math.min(...ranges.map((r) => r[0]));
  const matchEnd = Math.max(...ranges.map((r) => r[1]));

  return {
    start,
    startTime: timeMatch ? timeMatch.startTime : null,
    end: noEnd(),
    endTime: timeMatch ? timeMatch.endTime : null,
    rrule: dateMatch ? dateMatch.rrule : null,
    title: extractTitle(text, ranges),
    matchRange: [matchStart, matchEnd],
    confidence,
  };
}
