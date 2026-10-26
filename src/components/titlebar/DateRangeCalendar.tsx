/**
 * Month calendar grid for the date-badge popover — airline-booking-style range picker
 * (docs/DASHBOARD.md §2 redesign, 2026-08-01 owner decision). Click/drag semantics live in the
 * pure dateRangePicker.ts state machine; this component is just grid layout + pointer plumbing,
 * controlled by DateBadge (which owns the draft start/end/phase and the view month).
 *
 * Grid math is its own (not leftpanel/expanded/calendarGrid's buildCalendarGrid) because that
 * module keys days as "YYYY-MM-DD" strings ordered lexically — fine for the UTC record-histogram
 * calendar it serves, but wrong for this app's actual date domain, where a note's year can be
 * negative (BCE, notes.sql CHECK year BETWEEN -9999 AND 9999) and lexical string order breaks for
 * negative years. Cells here stay plain {year, month, day} number triples throughout. daysInMonth
 * is still reused from that module — pure leap-year-aware Date math, no string keying involved.
 */
import { useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { IconCaret } from "../icons";
import { daysInMonth } from "../../lib/dateUtils";
import { weekdayShortLabels } from "../home/dateFmt";
import { useTodayIso, useHolidayMap, dayTone, toneColor } from "../../lib/calendarDay";
import type { EventDate, EventEnd } from "./eventDate";
import { type ConcreteDate, type PickResult, type RangePhase, cellHighlight, dragRange, isSameDate, pickDay } from "./dateRangePicker";
import { weatherCodeToVisual, type DailyForecast } from "../../lib/weather";

/** ISO "YYYY-MM-DD" for a grid cell, or null when the year isn't one dayTone/useTodayIso can ever
 * match — a note's year can be BCE (see file header), and lexical zero-padding a negative number
 * doesn't produce a valid ISO date, so those cells simply get no weekend/holiday/today tone. */
function cellIso(cell: ConcreteDate): string | null {
  if (cell.year < 1) return null;
  return `${String(cell.year).padStart(4, "0")}-${String(cell.month).padStart(2, "0")}-${String(cell.day).padStart(2, "0")}`;
}

type DragSession = { start: ConcreteDate; current: ConcreteDate; moved: boolean };

export function DateRangeCalendar({
  viewYear,
  viewMonth,
  onNavMonth,
  start,
  end,
  phase,
  onChange,
  relatedDates,
  forecast = null,
}: {
  viewYear: number;
  viewMonth: number; // 1-12
  onNavMonth: (delta: number) => void;
  start: EventDate;
  end: EventEnd;
  phase: RangePhase;
  /** Unused inside this component — isToday is derived live from useTodayIso() instead (a
   * mount/render snapshot passed down would go stale if the popover sits open past midnight).
   * Kept in the prop contract because DateBadge already threads it through. */
  onChange: (next: PickResult) => void;
  /** ISO "YYYY-MM-DD" dates to mark with a small dot (GRILL-2026-09-07 follow-up: related dates,
   * shown distinct from the start/end accent circle so the two selections never look the same). */
  relatedDates?: string[];
  /** Part C (2026-09-07 owner: "날씨도 다른 달력들처럼"): same DailyForecast shape/fetch path as
   * the home calendar (MonthGrid.tsx) — a per-day icon, drawn only for days the forecast actually
   * covers (no blank placeholder / "?" for the rest). null when weather is off or unavailable. */
  forecast?: DailyForecast | null;
}) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const weekStart = useSettingsStore((s) => s.weekStart);
  const dragRef = useRef<DragSession | null>(null);
  const [dragLive, setDragLive] = useState<DragSession | null>(null);

  const todayIso = useTodayIso();
  const holidays = useHolidayMap([viewYear]);
  const weekdayLabels = useMemo(() => weekdayShortLabels(uiLang, weekStart), [uiLang, weekStart]);
  const cells = buildGrid(viewYear, viewMonth, weekStart);

  const forecastByDay = useMemo(() => {
    if (!forecast?.time?.length) return null;
    const map = new Map<string, { code: number; max: number }>();
    for (let i = 0; i < forecast.time.length; i++) {
      map.set(forecast.time[i], { code: forecast.weatherCode[i], max: forecast.tempMaxC[i] });
    }
    return map;
  }, [forecast]);

  const onCellPointerDown = (day: ConcreteDate, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const session: DragSession = { start: day, current: day, moved: false };
    dragRef.current = session;
    setDragLive(session);
    const onUp = () => {
      window.removeEventListener("pointerup", onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDragLive(null);
      if (!cur) return;
      onChange(cur.moved ? dragRange(cur.start, cur.current) : pickDay(cur.start, start, phase));
    };
    window.addEventListener("pointerup", onUp);
  };

  const onCellPointerEnter = (day: ConcreteDate) => {
    const cur = dragRef.current;
    if (!cur) return;
    const moved = cur.moved || !isSameDate(day, cur.start);
    if (isSameDate(day, cur.current) && moved === cur.moved) return;
    const next: DragSession = { start: cur.start, current: day, moved };
    dragRef.current = next;
    setDragLive(next);
  };

  // While actively dragging past the start cell, highlight uses the live (uncommitted) drag span
  // instead of the committed start/end — same split MonthGrid/useCalendarDrag already use for the
  // full-page calendar's drag-to-create.
  const liveRange =
    dragLive && dragLive.moved
      ? dragRange(dragLive.start, dragLive.current)
      : null;
  const highlightStart = liveRange ? liveRange.start : start;
  const highlightEnd = liveRange ? liveRange.end : end;

  const relatedSet = useMemo(() => new Set(relatedDates ?? []), [relatedDates]);

  return (
    <div data-testid="date-range-calendar">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", paddingBottom: "var(--space-3)" }}>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="range-cal-prev"
          title={t("search.calendar_prev_month")}
          aria-label={t("search.calendar_prev_month")}
          onClick={() => onNavMonth(-1)}
        >
          <IconCaret dir="left" size={14} />
        </button>
        <span
          data-testid="range-cal-month-label"
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            fontFamily: "var(--font-heading)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {String(viewYear).padStart(4, "0")}.{String(viewMonth).padStart(2, "0")}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="range-cal-next"
          title={t("search.calendar_next_month")}
          aria-label={t("search.calendar_next_month")}
          onClick={() => onNavMonth(1)}
        >
          <IconCaret dir="right" size={14} />
        </button>
      </div>
      {/* Part B (2026-09-07 owner: "기간 선택 시 쫀쫀한 애니메이션"): background-color is a paint,
          not a compositor-only property, but it's the same lightweight transition every other
          hover/selection state in this codebase already uses (tokens.css's var(--dur-fast) idiom) —
          cheap at this scale (max 42 cells). The one real perf risk is re-triggering it on EVERY
          cell a live drag passes through, so [data-dragging] suppresses both the transition and the
          endpoint "pop" while a drag is in flight; the drag's own live highlight (already instant,
          see dragLive above) is the only feedback during the gesture. prefers-reduced-motion follows
          the existing .ai-toast/.overlay idiom (tokens.css) — same media query, drop to none. */}
      <style>{`
        .date-range-cell{transition:background var(--dur-fast) cubic-bezier(0.16,1,0.3,1)}
        .date-range-cell:hover{background:var(--hover)}
        .date-range-cell[data-highlight="start"],.date-range-cell[data-highlight="end"]{
          animation:date-cell-pop var(--dur-fast) cubic-bezier(0.16,1,0.3,1);
        }
        @keyframes date-cell-pop{from{transform:scale(.85)}to{transform:scale(1)}}
        [data-dragging="true"] .date-range-cell{transition:none}
        [data-dragging="true"] .date-range-cell[data-highlight]{animation:none}
        @media (prefers-reduced-motion: reduce){
          .date-range-cell{transition:none}
          .date-range-cell[data-highlight]{animation:none}
        }
      `}</style>
      <div
        data-dragging={dragLive ? "true" : undefined}
        style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", userSelect: "none" }}
      >
        {weekdayLabels.map((label, i) => (
          <div
            key={`dow-${i}`}
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--faint)",
              textAlign: "center",
              padding: "var(--space-2) 0",
              fontWeight: 600,
            }}
          >
            {label}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />;
          const isoKey = cellIso(cell);
          const isToday = isoKey === todayIso;
          const hl = cellHighlight(cell, highlightStart, highlightEnd);
          // Weekend/holiday tone loses to any selection highlight (start/end/in-range) — the
          // range picker's own accent is the point of this calendar, tone is just ambient color
          // for otherwise-plain days (2026-09-08 spec).
          const tone = hl === "none" && isoKey ? dayTone(isoKey, holidays) : null;
          const holidayName = isoKey ? holidays.get(isoKey) : undefined;
          const isRelated = isoKey != null && relatedSet.has(isoKey);
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              className="date-range-cell"
              data-testid={`range-day-${cell.year}-${cell.month}-${cell.day}`}
              data-highlight={hl}
              data-related={isRelated || undefined}
              aria-label={`${cell.year}.${String(cell.month).padStart(2, "0")}.${String(cell.day).padStart(2, "0")}`}
              title={holidayName}
              onPointerDown={(e) => onCellPointerDown(cell, e)}
              onPointerEnter={() => onCellPointerEnter(cell)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onChange(pickDay(cell, start, phase));
                }
              }}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 28,
                margin: "2px 0",
                cursor: "pointer",
                // 셀은 열 폭을 다 쓴다(범위 띠가 끊기지 않으려면 그래야 한다). 그래서 여기에
                // border-radius:50% 를 주면 폭>높이인 셀에서 **타원**이 된다(2026-09-08 오너:
                // "원이 찌그러졌다") — 팝오버가 넓어지며 더 드러났다. 시작/끝의 동그라미는 아래
                // 고정 28×28 레이어가 그리고, 셀 자신은 범위 띠만 담당한다.
                borderRadius: "var(--radius-sm)",
                // Owner feedback (2026-09-07, "범위 선택이 너무 무겁다"): the in-range fill used to
                // be var(--sel) end to end, reading as one solid pill that buried the related-date
                // dots under it. Only the two endpoints stay a strong accent circle now; everything
                // between is var(--hover) — the same light accent-tint token AttachmentTile/menu
                // rows already use for a barely-there wash, reused rather than inventing a new one.
                background: hl === "in-range" ? "var(--hover)" : "transparent",
                color:
                  hl === "start" || hl === "end"
                    ? "var(--on-accent)"
                    : isToday
                    ? "var(--accent)"
                    : tone
                    ? toneColor(tone)
                    : "var(--text)",
                fontWeight: hl === "start" || hl === "end" ? 600 : isToday ? 600 : 400,
                fontSize: "var(--text-xs)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {(hl === "start" || hl === "end") && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    pointerEvents: "none",
                  }}
                />
              )}
              <span style={{ position: "relative" }}>{cell.day}</span>
              {/* Part C: weather icon, corner-placed so it never fights the centered day number or
                  the related-date dot (bottom:-3, below the cell). Suppressed on the start/end
                  accent circle itself — that fill is opaque and the icon's own color wouldn't read
                  against it, and the highlighted day is the one being actively edited, not browsed
                  for weather. No icon at all when the forecast doesn't cover this day (met.no's
                  window is short — never a blank placeholder/"?"). */}
              {hl !== "start" && hl !== "end" && isoKey != null && forecastByDay?.has(isoKey) && (
                <span
                  aria-hidden="true"
                  data-testid={`range-day-weather-${cell.year}-${cell.month}-${cell.day}`}
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
                    lineHeight: 0,
                    pointerEvents: "none",
                  }}
                >
                  {(() => {
                    const wx = forecastByDay.get(isoKey!)!;
                    const visual = weatherCodeToVisual(wx.code, wx.max);
                    return <visual.Icon size={9} strokeWidth={2} style={{ color: visual.colorVar }} />;
                  })()}
                </span>
              )}
              {isRelated && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    // Owner feedback (2026-09-07, "표식이 대표 표시와 겹친다"): a related-date dot
                    // used to sit at bottom:2 *inside* the cell, right where the start/end accent
                    // circle's edge passes through the bottom-center point — the two fought for the
                    // same pixel. Placing it just below the cell's own box (in the row's margin gap,
                    // widened above to 2px to fit it) keeps it clear of that circle entirely, so it
                    // no longer needs a hl-dependent color swap either.
                    bottom: -3,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "var(--info)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Weeks for (year, month 1-12), starting per the `weekStart` setting and padded with nulls to
 * full weeks — plain number triples throughout (see file header for why this isn't the shared
 * ISO-string grid builder). getUTCDay() is Sunday=0..Saturday=6; a Monday-first grid just rotates
 * that by 6 (mod 7) to get the leading blank-cell count. */
function buildGrid(year: number, month: number, weekStart: "sunday" | "monday"): (ConcreteDate | null)[] {
  const total = daysInMonth(year, month);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const pad = weekStart === "monday" ? (firstWeekday + 6) % 7 : firstWeekday;
  const cells: (ConcreteDate | null)[] = [];
  for (let i = 0; i < pad; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push({ year, month, day: d });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
