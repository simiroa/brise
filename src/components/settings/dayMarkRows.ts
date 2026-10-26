/**
 * 설정 "공휴일·기념일" 표의 행 — 한 해의 기본 공휴일 · 불러온 캘린더 · 내 기념일을 날짜순 한 목록으로
 * (docs/PLAN-2026-09-19-calendar-schedule.md §5.2). 순수 함수.
 *
 * **`lib/dayMarks.ts::expandDayMarks` 와 합치지 마라.** 그쪽은 달력 표면용 전개라 같은 날을 `" · "` 한
 * 문자열로 뭉치고, 숨긴 날·꺼진 출처를 **버리고**, 출처와 반복 모양을 잊는다 — 표가 보여야 하는 것
 * (숨긴 행을 흐리게, 출처 칩, 편집·숨기기·복사의 대상 행)이 전부 거기서 사라진다. 재료(holidaysForYear,
 * markDaysInYear, markOrdinal)만 같이 쓰고, 이 표는 같은 입력 위의 두 번째, 더 자세한 보기다.
 */
import type { CalendarMark, CalendarMarkHide, CalendarSource } from "../../lib/commands.gen";
import type { HolidayRegion } from "../../stores/settings";
import { holidaysForYear } from "../../lib/holidays";
import { BUILTIN_SOURCE, markDaysInYear, markOrdinal } from "../../lib/dayMarks";
import { daysInMonth } from "../../lib/dateUtils";

export type DayMarkRowKind = "builtin" | "imported" | "own";

export interface DayMarkRow {
  key: string;
  iso: string;
  title: string;
  /** 매년 + 첫해를 알 때의 햇수(1 이상) — "N주년". */
  ordinal: number | null;
  dayOff: boolean;
  kind: DayMarkRowKind;
  /** 숨김을 매다는 출처 키 — 기본 공휴일은 "builtin", 불러온 캘린더는 그 출처 id, 내 기념일은 없음(지운다). */
  hideSource: string | null;
  /** 불러온 캘린더의 이름(그 밖엔 null). */
  sourceName: string | null;
  hidden: boolean;
  /** 출처가 꺼져 있다(불러온 캘린더만). */
  sourceDisabled: boolean;
  /** DB 행(기본 공휴일은 null). */
  mark: CalendarMark | null;
}

const KIND_ORDER: Record<DayMarkRowKind, number> = { builtin: 0, imported: 1, own: 2 };

export function buildDayMarkRows(
  year: number,
  region: HolidayRegion,
  marks: readonly CalendarMark[],
  sources: readonly CalendarSource[],
  hides: readonly CalendarMarkHide[],
): DayMarkRow[] {
  const hidden = new Set(hides.map((h) => `${h.source}|${h.iso_day}`));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const rows: DayMarkRow[] = [];

  for (const [iso, name] of holidaysForYear(region, year)) {
    rows.push({
      key: `builtin|${iso}`,
      iso,
      title: name,
      ordinal: null,
      dayOff: true,
      kind: "builtin",
      hideSource: BUILTIN_SOURCE,
      sourceName: null,
      hidden: hidden.has(`${BUILTIN_SOURCE}|${iso}`),
      sourceDisabled: false,
      mark: null,
    });
  }

  for (const m of marks) {
    const src = m.source_id ? byId.get(m.source_id) : undefined;
    const kind: DayMarkRowKind = m.source_id ? "imported" : "own";
    for (const iso of markDaysInYear(m, year)) {
      rows.push({
        key: `${m.id}|${iso}`,
        iso,
        title: m.title,
        ordinal: markOrdinal(m, year),
        dayOff: m.day_off,
        kind,
        hideSource: m.source_id,
        sourceName: kind === "imported" ? (src?.name ?? "") : null,
        hidden: m.source_id ? hidden.has(`${m.source_id}|${iso}`) : false,
        sourceDisabled: kind === "imported" && src ? !src.enabled : false,
        mark: m,
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.iso.localeCompare(b.iso) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title),
  );
  return rows;
}

export type DayMarkFilter = "all" | "own" | "holidays";

export function filterDayMarkRows(rows: readonly DayMarkRow[], filter: DayMarkFilter): DayMarkRow[] {
  if (filter === "own") return rows.filter((r) => r.kind === "own");
  if (filter === "holidays") return rows.filter((r) => r.kind !== "own");
  return [...rows];
}

/**
 * "내 기념일로 복사" 가 만들 행(D3 — 기본 공휴일은 이름을 못 바꾸니 복사본에서 고친다).
 * 기본 공휴일·한 번짜리 → 그해 한 번. 불러온 매년 → 매년(첫해 그대로). 음력 매년이 불러와질 일은 없지만
 * (ics 는 양력) 오면 그대로 싣는다.
 */
export function copyPayload(row: DayMarkRow): {
  title: string;
  year?: number;
  month: number;
  day: number;
  repeat: "once" | "yearly";
  lunar: boolean;
  day_off: boolean;
} {
  const m = row.mark;
  if (m && m.repeat === "yearly") {
    return {
      title: m.title,
      ...(m.year != null ? { year: m.year } : {}),
      month: m.month,
      day: m.day,
      repeat: "yearly",
      lunar: m.lunar,
      day_off: m.day_off,
    };
  }
  const [y, mo, d] = row.iso.split("-").map(Number);
  return { title: row.title, year: y, month: mo, day: d, repeat: "once", lunar: false, day_off: row.dayOff };
}

/** 양력 표시일이 가질 수 있는 마지막 날 — `repo/calendar_marks.rs::days_in_month` 와 같은 규칙: 해를 모르면
 *  (매년) 2/29 를 허용한다(평년엔 2/28 로 그린다). 셈은 dateUtils 의 것 하나 — 윤년인 2000 으로 물어본다. */
export function maxSolarMarkDay(year: number | null, month: number): number {
  return daysInMonth(year ?? 2000, month);
}
