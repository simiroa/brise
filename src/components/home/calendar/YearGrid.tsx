/**
 * Calendar year view — a continuous vertical heatmap of months (2026-09-08). Read-only overview:
 * no chips, span bars, weather, drag-create or AI prompt (those live in MonthGrid); any click
 * drills down into the month view (onPickMonth / onPickDay), which is where creation happens.
 *
 * Continuity: the grid renders every month of `years` (CalendarTab keeps that at viewYear ± 1) as
 * one scrolling column of month blocks with a year heading before each January. Scrolling reports
 * the year under the viewport's vertical centre via onCenterYearChange; CalendarTab re-centres the
 * window on it, and the useLayoutEffect below restores the scroll offset against the same year
 * block so the shift is invisible. Result: scroll up forever into earlier years, down into later
 * ones, with only three years of DOM/data alive at a time.
 *
 * Each day is a square whose fill is one of three accent intensities — record axis only (faint,
 * `--hover` = 8%), one event/span (`--sel` = 20%), two or more (38%). Discrete on purpose: at this
 * cell size a continuous ramp is unreadable, so the year view quantises where the month view's
 * record tint (lib/calendarDay::recordTint) interpolates. Both ladders share the same 8%..38%
 * endpoints, so a day never looks lighter here than it does there. Folder colors are deliberately
 * NOT used for the fill:
 * years of mixed hues is confetti, not a heatmap — folders are the month view's job. The one
 * folder-coloured mark is the reminder dot (2026-09-08 owner): a day with a remind-flagged item
 * gets a small dot in the cell's corner in that item's folder colour — the dot is a "you asked to
 * be told" marker, not urgency, so the calendar's neutral principle (DASHBOARD.md §2) still holds.
 * Search hits and the dashboard folder filter dim a day when none of its items match (same
 * dim-not-remove rule as MonthGrid's data-search-dim).
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { CalendarItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { buildCalendarGridCustom, itemKey } from "../calendarLayout";
import { formatMonthShort, weekdayShortLabels } from "../dateFmt";
import { useNotesStore } from "../../../stores/notes";
import { folderColorCss } from "../../../lib/ui";
import { dayTone, headerTone } from "../../../lib/calendarDay";

/** remindFolder = folder of the first remind-flagged item that day (its colour paints the dot). */
type DayHeat = { count: number; dim: boolean; remindFolder: string | null };

/** Where CalendarTab wants the viewport: a month, aligned to the top or centred. `seq` makes a
 *  repeat request (same month twice) re-fire. */
export type YearScrollRequest = { year: number; month0: number; align: "top" | "center"; seq: number };

const DAY_MS = 24 * 60 * 60 * 1000;

// Fill per intensity level lives in the scoped <style> below (data-level 1 = record only,
// 2 = one item, 3 = two or more). Today is a ring, not a fill, so it never competes with the level.

/** Per-day event count across every loaded year — items are already month-clipped (≤31 days each). */
function indexHeat(
  items: CalendarItem[],
  searchHits: Set<string> | null,
  folderFilter: string | null,
): Map<string, DayHeat> {
  const map = new Map<string, DayHeat>();
  // Month queries can hand back the same clipped piece twice (e.g. a mocked or cached month) —
  // count each (note, occurrence start) once.
  const seen = new Set<string>();
  // 같은 날짜 행(date_id)의 겹치는 회차는 그 날 한 번만 카운트한다 (Q11).
  const seenDayDate = new Set<string>();
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const dim =
      (searchHits !== null && !searchHits.has(item.note_id)) ||
      (folderFilter !== null && item.folder_id !== folderFilter);
    const start = Date.parse(`${item.span_start}T00:00:00Z`);
    const end = Date.parse(`${item.span_end}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    for (let ts = start; ts <= end; ts += DAY_MS) {
      const day = new Date(ts).toISOString().slice(0, 10);
      const dayDateKey = `${day}|${item.date_id}`;
      if (seenDayDate.has(dayDateKey)) {
        const cur = map.get(day);
        if (cur) {
          cur.dim = cur.dim && dim;
          if (!cur.remindFolder && item.remind) cur.remindFolder = item.folder_id;
        }
        continue;
      }
      seenDayDate.add(dayDateKey);
      const cur = map.get(day);
      const remindFolder = item.remind ? item.folder_id : null;
      if (!cur) map.set(day, { count: 1, dim, remindFolder });
      else {
        cur.count++;
        // The day only dims when every item on it is dimmed.
        cur.dim = cur.dim && dim;
        if (!cur.remindFolder && remindFolder) cur.remindFolder = remindFolder;
      }
    }
  }
  return map;
}

export function YearGrid({
  years,
  items,
  recordCounts,
  todayIso,
  weekStart = "sunday",
  uiLang,
  holidays,
  dayLabels = null,
  searchHits = null,
  folderFilter = null,
  scrollRequest = null,
  onCenterYearChange,
  onPickDay,
  onPickMonth,
}: {
  /** Ascending, contiguous. CalendarTab keeps this at viewYear ± 1. */
  years: number[];
  items: CalendarItem[];
  /** ISO day → created/updated note count (note_record_histogram). */
  recordCounts: Map<string, number>;
  todayIso: string;
  weekStart?: "sunday" | "monday";
  uiLang: string;
  /** Merged over `years` — CalendarTab does the merge. */
  holidays: ReadonlyMap<string, string>;
  /** 기념일 이름표 — 칸 툴팁에만(연간 칸은 이름을 그릴 자리가 없다). */
  dayLabels?: ReadonlyMap<string, string> | null;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  scrollRequest?: YearScrollRequest | null;
  /** The year block under the viewport's vertical centre changed (fires from scrolling only). */
  onCenterYearChange: (year: number) => void;
  /** Drill into month view with this day selected. */
  onPickDay: (day: string) => void;
  /** Drill into month view for this month. */
  onPickMonth: (year: number, month0: number) => void;
}) {
  const heat = useMemo(() => indexHeat(items, searchHits, folderFilter), [items, searchHits, folderFilter]);
  const folders = useNotesStore((s) => s.folders);
  const folderColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.color_hue != null ? folderColorCss(f.color_hue) : "var(--accent)");
    return m;
  }, [folders]);
  const weekdayLetters = useMemo(
    () => weekdayShortLabels(uiLang, weekStart).map((l) => l.slice(0, 1)),
    [uiLang, weekStart],
  );
  const grids = useMemo(
    () =>
      years.map((year) => ({
        year,
        months: Array.from({ length: 12 }, (_, m) => buildCalendarGridCustom(year, m, weekStart)),
      })),
    [years, weekStart],
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastCenterYear = useRef<number | null>(null);
  // Captured right before onCenterYearChange so the window shift can be compensated (see the
  // layout effect below): the reported year's block top and the scroll offset at that moment.
  const pendingAnchor = useRef<{ year: number; offsetTop: number; scrollTop: number } | null>(null);

  const yearBlock = (year: number) =>
    scrollerRef.current?.querySelector<HTMLElement>(`[data-year-block="${year}"]`) ?? null;

  const onScroll = useCallback(() => {
    const c = scrollerRef.current;
    if (!c) return;
    const center = c.scrollTop + c.clientHeight / 2;
    for (const year of years) {
      const el = yearBlock(year);
      if (!el) continue;
      if (el.offsetTop <= center && center < el.offsetTop + el.offsetHeight) {
        if (lastCenterYear.current !== year) {
          lastCenterYear.current = year;
          pendingAnchor.current = { year, offsetTop: el.offsetTop, scrollTop: c.scrollTop };
          onCenterYearChange(year);
        }
        return;
      }
    }
  }, [years, onCenterYearChange]);

  // Window shifted (years prop changed): put the anchored year block back where the eye left it.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const c = scrollerRef.current;
    if (!anchor || !c) return;
    pendingAnchor.current = null;
    const el = yearBlock(anchor.year);
    if (el) c.scrollTop = el.offsetTop - (anchor.offsetTop - anchor.scrollTop);
  }, [years]);

  // Explicit navigation (mount centring, ‹ ›, today).
  useLayoutEffect(() => {
    const c = scrollerRef.current;
    if (!c || !scrollRequest) return;
    const el = c.querySelector<HTMLElement>(
      `[data-month-block="${scrollRequest.year}-${scrollRequest.month0}"]`,
    );
    if (!el) return;
    c.scrollTop =
      scrollRequest.align === "center"
        ? el.offsetTop - (c.clientHeight - el.offsetHeight) / 2
        : el.offsetTop - 4;
    lastCenterYear.current = scrollRequest.year;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seq is the request identity
  }, [scrollRequest?.seq]);

  return (
    <div
      ref={scrollerRef}
      data-testid="cal-year-grid"
      onScroll={onScroll}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        position: "relative",
        userSelect: "none",
      }}
    >
      <style>{`
        .home-cal-ydow{text-align:center;font-size:var(--text-2xs);color:var(--faint);text-transform:uppercase}
        .home-cal-ydow[data-tone="sun"]{color:var(--danger)}
        .home-cal-ydow[data-tone="sat"]{color:var(--info)}
        .home-cal-yday{border:none;padding:0;font:inherit;font-size:var(--text-2xs);font-variant-numeric:tabular-nums;
          aspect-ratio:1;min-width:0;display:flex;align-items:center;justify-content:center;
          border-radius:var(--radius-xs);background:transparent;color:var(--muted);cursor:pointer;position:relative}
        .home-cal-yremind{position:absolute;top:1px;right:1px;width:4px;height:4px;border-radius:50%;pointer-events:none}
        .home-cal-yday[data-level="1"]{background:var(--hover)}
        .home-cal-yday[data-level="2"]{background:var(--sel)}
        .home-cal-yday[data-level="3"]{background:color-mix(in srgb, var(--accent) 38%, transparent);color:var(--ink)}
        .home-cal-yday[data-today="true"]{box-shadow:inset 0 0 0 1px var(--accent);color:var(--ink)}
        .home-cal-yday[data-tone="sat"]{color:var(--info)}
        .home-cal-yday[data-tone="sun"]{color:var(--danger)}
        .home-cal-yday[data-search-dim="true"]{opacity:.35}
      `}</style>
      {grids.map(({ year, months }) => (
        <section key={year} data-year-block={year} data-testid={`home-cal-year-${year}`}>
          <h3
            style={{
              margin: 0,
              padding: "var(--space-4) 0 var(--space-3)",
              fontSize: "var(--text-md)",
              fontWeight: 600,
              fontFamily: "var(--font-heading)",
              color: "var(--ink)",
            }}
          >
            {year}
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "var(--space-7) var(--space-6)",
              alignContent: "start",
            }}
          >
            {months.map((cells, m) => (
              <MiniMonth
                key={m}
                year={year}
                month0={m}
                label={formatMonthShort(m + 1, uiLang)}
                cells={cells}
                weekdayLetters={weekdayLetters}
                weekStart={weekStart}
                heat={heat}
                folderColor={folderColor}
                recordCounts={recordCounts}
                todayIso={todayIso}
                holidays={holidays}
                dayLabels={dayLabels}
                onPickDay={onPickDay}
                onPickMonth={onPickMonth}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const MiniMonth = memo(function MiniMonth({
  year,
  month0,
  label,
  cells,
  weekdayLetters,
  weekStart,
  heat,
  folderColor,
  recordCounts,
  todayIso,
  holidays,
  dayLabels = null,
  onPickDay,
  onPickMonth,
}: {
  year: number;
  month0: number;
  label: string;
  cells: ReturnType<typeof buildCalendarGridCustom>;
  weekdayLetters: string[];
  weekStart: "sunday" | "monday";
  heat: Map<string, DayHeat>;
  folderColor: Map<string, string>;
  recordCounts: Map<string, number>;
  todayIso: string;
  holidays: ReadonlyMap<string, string>;
  /** 기념일 이름표 — 칸 툴팁에만(연간 칸은 이름을 그릴 자리가 없다). */
  dayLabels?: ReadonlyMap<string, string> | null;
  onPickDay: (day: string) => void;
  onPickMonth: (year: number, month0: number) => void;
}) {
  return (
    <section
      data-month-block={`${year}-${month0}`}
      data-testid={`home-cal-year-month-${year}-${month0 + 1}`}
      style={{ minWidth: 0 }}
    >
      <button
        type="button"
        data-testid={`home-cal-year-month-btn-${year}-${month0 + 1}`}
        onClick={() => onPickMonth(year, month0)}
        style={{
          border: "none",
          background: "none",
          padding: "0 0 var(--space-2)",
          font: "inherit",
          fontSize: "var(--text-sm)",
          fontWeight: 600,
          fontFamily: "var(--font-heading)",
          color: "var(--ink)",
          cursor: "pointer",
        }}
      >
        {label}
      </button>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "var(--space-2xs)" }}>
        {weekdayLetters.map((l, i) => (
          <span
            key={`dow-${i}`}
            aria-hidden
            className="home-cal-ydow"
            data-tone={headerTone(i, weekStart) ?? undefined}
          >
            {l}
          </span>
        ))}
        {cells.map((cell, i) => {
          if (cell.day === null) return <span key={i} aria-hidden />;
          const day = cell.day;
          const holiday = holidays.get(day) ?? null;
          const h = heat.get(day) ?? null;
          const level = h ? (h.count >= 2 ? 3 : 2) : (recordCounts.get(day) ?? 0) > 0 ? 1 : 0;
          const isToday = day === todayIso;
          // Holidays read like Sundays (red) — dayTone already applies that rule.
          const tone = dayTone(day, holidays) ?? undefined;
          const title = [holiday, dayLabels?.get(day) ?? null, h ? t("home.cal_day_notes", { count: h.count }) : null]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={day}
              type="button"
              className="home-cal-yday"
              data-testid={`home-cal-yday-${day}`}
              data-level={level}
              data-tone={tone}
              data-today={isToday ? "true" : undefined}
              data-holiday={holiday ? "true" : undefined}
              data-search-dim={h?.dim ? "true" : undefined}
              title={title || undefined}
              onClick={() => onPickDay(day)}
            >
              {cell.dayOfMonth}
              {h?.remindFolder && (
                <i
                  aria-hidden
                  className="home-cal-yremind"
                  data-testid={`home-cal-yremind-${day}`}
                  data-folder={h.remindFolder}
                  style={{ background: folderColor.get(h.remindFolder) ?? "var(--accent)" }}
                />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
});
