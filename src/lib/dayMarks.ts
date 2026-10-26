/**
 * 달력 표시일 전개 — 한 해의 "빨간 날"과 "이름표"를 만든다(docs/PLAN-2026-09-19-calendar-schedule.md §3).
 *
 * 재료 셋: 기본 공휴일 표(lib/holidays.ts, 노트북 설정 holiday_region) · DB 의 표시일(내 기념일 + 불러온
 * 캘린더) · 숨긴 날. 결과 둘:
 *   - `off`    빨간 날(dayTone "sun", 반복 일정 skip_holidays) — 기존 useHolidayMap 의 뜻 그대로.
 *   - `labels` 빨간 날이 아닌 기념일 이름표(결혼기념일 등) — 칠하지 않고 이름만 붙인다.
 * 같은 날 여럿이면 " · " 로 합친다. 순수 함수 — 스토어·훅은 stores/dayMarks.ts, lib/calendarDay.ts.
 */
import type { CalendarMark, CalendarMarkHide, CalendarSource } from "./commands.gen";
import type { HolidayRegion } from "../stores/settings";
import { holidaysForYear } from "./holidays";
import { lunarToSolarDays } from "./lunar";
import { t } from "../i18n/t";

export const BUILTIN_SOURCE = "builtin";

export interface DayMarkInput {
  region: HolidayRegion;
  marks: readonly CalendarMark[];
  sources: readonly CalendarSource[];
  hides: readonly CalendarMarkHide[];
}

export interface DayMarkMaps {
  off: Map<string, string>;
  labels: Map<string, string>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 표시일 한 줄이 양력 `year` 에 떨어지는 날들(0개 이상). */
export function markDaysInYear(m: CalendarMark, year: number): string[] {
  if (m.repeat === "once") {
    return m.year === year ? [`${year}-${pad(m.month)}-${pad(m.day)}`] : [];
  }
  // 매년: 처음 해 이전엔 없다(첫해를 모르면 언제나).
  if (m.year != null && year < m.year) return [];
  if (m.lunar) return lunarToSolarDays(year, m.month, m.day);
  // 양력 2/29 매년 기념일은 평년에 2/28.
  const day = m.month === 2 && m.day === 29 && !isLeap(year) ? 28 : m.day;
  return [`${year}-${pad(m.month)}-${pad(day)}`];
}

/** "N주년/N번째" 표시에 쓰는 햇수 — 매년이고 첫해를 알 때만, 1 이상일 때만. */
export function markOrdinal(m: CalendarMark, year: number): number | null {
  if (m.repeat !== "yearly" || m.year == null) return null;
  const n = year - m.year;
  return n >= 1 ? n : null;
}

function add(map: Map<string, string>, iso: string, label: string) {
  const prev = map.get(iso);
  map.set(iso, prev ? `${prev} · ${label}` : label);
}

export function expandDayMarks(year: number, input: DayMarkInput): DayMarkMaps {
  const hidden = new Set(input.hides.map((h) => `${h.source}|${h.iso_day}`));
  const disabled = new Set(input.sources.filter((s) => !s.enabled).map((s) => s.id));
  const off = new Map<string, string>();
  const labels = new Map<string, string>();

  for (const [iso, name] of holidaysForYear(input.region, year)) {
    if (!hidden.has(`${BUILTIN_SOURCE}|${iso}`)) add(off, iso, name);
  }
  for (const m of input.marks) {
    if (m.source_id && disabled.has(m.source_id)) continue;
    const n = markOrdinal(m, year);
    const label = n ? t("dayMarks.ordinal", { title: m.title, n }) : m.title;
    for (const iso of markDaysInYear(m, year)) {
      if (m.source_id && hidden.has(`${m.source_id}|${iso}`)) continue;
      add(m.day_off ? off : labels, iso, label);
    }
  }
  return { off, labels };
}
