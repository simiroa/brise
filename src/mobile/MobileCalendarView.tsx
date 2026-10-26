import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchStore } from "../stores/search";
import { useSettingsStore } from "../stores/settings";
import { useWorkspacesStore } from "../stores/workspaces";
import { EXPANDED_BOARD_MAX_NOTES, noteQueryCollect, noteRecordHistogram, useNoteQueryVersion } from "../lib/noteQuery";
import type { CalendarItem, CalendarResult, NoteSummary } from "../lib/commands.gen";
import { call } from "../lib/invoke";
import { displayTitle } from "../stores/notes";
import { noteIconComp } from "../lib/noteIcons";
import { t } from "../i18n/t";
import { IconCaret, IconNote } from "../components/icons";
import { buildCalendarGridCustom, monthRange, shiftMonth, type CalendarCell } from "../components/leftpanel/expanded/calendarGrid";
import { weekdayShortLabels, monthLongLabel, todayLocal } from "../components/home/dateFmt";
import { formatCompactDate } from "./compactDate";
import { useTodayIso, useHolidayMap, dayTone, headerTone, type DayTone } from "../lib/calendarDay";
import { collapseOccurrencesForDay } from "../components/home/calendarLayout";
import { preloadIntentProps } from "../lib/lazyPreload";
import { MobileNote } from "../lazySurfaces";

interface MobileCalendarViewProps {
  onOpenNote: (id: string) => void;
  initialDay?: string | null;
}

// Empty-state list length when no day is picked (created_at desc) — a UX choice (top-N), not a
// runaway-fetch guard, so it stays a small local constant rather than the shared
// EXPANDED_BOARD_MAX_NOTES ceiling (that one covers the day-click lists below, where an unbounded
// day of notes is the actual risk this workorder's §6 calls out).
const RECENT_MAX = 10;

/**
 * `calendar` mode — month grid + tap-a-day note list, mobile mirror of
 * leftpanel/expanded/CalendarExpanded.tsx trimmed to a single column (workorder W3 §5).
 * Wave PHONECAL (Q14): adds that day's schedule summary axis (timed + all-day) via dashboard_calendar
 * and CALRULE's collapseOccurrencesForDay helper; distinct loading, error, empty states;
 * day markers for scheduled days.
 */
export function MobileCalendarView({ onOpenNote, initialDay }: MobileCalendarViewProps) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const weekStart = useSettingsStore((s) => s.weekStart);
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const noteQueryVersion = useNoteQueryVersion();

  const today = useMemo(todayLocal, []);
  const todayIso = useTodayIso();
  const [viewYear, setViewYear] = useState(today.year);
  const [viewMonth, setViewMonth] = useState(today.month);
  const [selectedDay, setSelectedDay] = useState<string | null>(initialDay ?? null);
  const activeScheduleDay = selectedDay ?? todayIso;
  const holidays = useHolidayMap([viewYear]);

  const [scheduleItems, setScheduleItems] = useState<CalendarItem[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState(false);

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [createdNotes, setCreatedNotes] = useState<NoteSummary[]>([]);
  const [updatedNotes, setUpdatedNotes] = useState<NoteSummary[]>([]);
  const [recentNotes, setRecentNotes] = useState<NoteSummary[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState(false);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const { from: monthFrom, to: monthTo } = useMemo(() => monthRange(viewYear, viewMonth), [viewYear, viewMonth]);
  const cells = useMemo(() => buildCalendarGridCustom(viewYear, viewMonth, weekStart), [viewYear, viewMonth, weekStart]);

  // Schedule axis via dashboard_calendar over bridge
  useEffect(() => {
    if (!workspaceId) {
      setScheduleItems([]);
      setScheduleLoading(false);
      setScheduleError(false);
      return;
    }
    let cancelled = false;
    setScheduleLoading(true);
    setScheduleError(false);
    call<CalendarResult>("dashboard_calendar", {
      workspace_id: workspaceId,
      year: viewYear,
      month: viewMonth + 1,
    })
      .then((r) => {
        if (!cancelled) {
          setScheduleItems(r?.items ?? []);
          setScheduleLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScheduleItems([]);
          setScheduleError(true);
          setScheduleLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, viewYear, viewMonth, retryTrigger, noteQueryVersion]);

  // Grid cell counts — record axis (created ∪ updated), server-aggregated, never a corpus scan.
  useEffect(() => {
    let cancelled = false;
    noteRecordHistogram(monthFrom, monthTo, "union")
      .then((r) => { if (!cancelled) setCounts(r); })
      .catch(() => { if (!cancelled) setCounts({}); });
    return () => { cancelled = true; };
  }, [monthFrom, monthTo, retryTrigger, noteQueryVersion]);

  // Day-click list (or the no-selection "recently created" default)
  useEffect(() => {
    let cancelled = false;
    const baseAxes = { yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter };
    setNotesLoading(true);
    setNotesError(false);
    (async () => {
      if (!selectedDay) {
        const recent = await noteQueryCollect({ ...baseAxes, sort: "created_desc" as const }, { maxNotes: RECENT_MAX });
        if (cancelled) return;
        setRecentNotes(recent.notes);
        setCreatedNotes([]);
        setUpdatedNotes([]);
        setNotesLoading(false);
        return;
      }
      const [created, updated] = await Promise.all([
        noteQueryCollect(
          { ...baseAxes, createdFrom: selectedDay, createdTo: selectedDay, sort: "updated_desc" as const },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES },
        ),
        noteQueryCollect(
          { ...baseAxes, updatedFrom: selectedDay, updatedTo: selectedDay, sort: "updated_desc" as const },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES },
        ),
      ]);
      if (cancelled) return;
      setRecentNotes([]);
      setCreatedNotes(created.notes);
      setUpdatedNotes(updated.notes.filter((n) => n.created_at.slice(0, 10) !== selectedDay));
      setNotesLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setRecentNotes([]);
        setCreatedNotes([]);
        setUpdatedNotes([]);
        setNotesError(true);
        setNotesLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedDay, yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, retryTrigger, noteQueryVersion]);

  // Days with schedule get a marker
  const scheduleDays = useMemo(() => {
    const days = new Set<string>();
    for (const it of scheduleItems) {
      if (!it.span_start || !it.span_end) continue;
      const start = it.span_start < monthFrom ? monthFrom : it.span_start;
      const end = it.span_end > monthTo ? monthTo : it.span_end;
      for (const cell of cells) {
        if (cell.day && cell.day >= start && cell.day <= end) {
          days.add(cell.day);
        }
      }
    }
    return days;
  }, [scheduleItems, cells, monthFrom, monthTo]);

  // That day's schedule via CALRULE helper (collapsing repeat rows into one entry per day)
  const daySchedule = useMemo(
    () => collapseOccurrencesForDay(scheduleItems, activeScheduleDay),
    [scheduleItems, activeScheduleDay],
  );

  const timedSchedule = useMemo(
    () => daySchedule.filter((it) => it.start_time !== null).sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? "")),
    [daySchedule],
  );

  const allDaySchedule = useMemo(
    () => daySchedule.filter((it) => it.start_time === null).sort((a, b) => a.title.localeCompare(b.title)),
    [daySchedule],
  );

  const weekdayLabels = useMemo(() => weekdayShortLabels(uiLang, weekStart), [uiLang, weekStart]);
  const monthLabel = useMemo(() => monthLongLabel(uiLang, viewYear, viewMonth), [uiLang, viewYear, viewMonth]);

  const navMonth = useCallback((delta: number) => {
    const next = shiftMonth(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
  }, [viewYear, viewMonth]);

  const goToday = useCallback(() => {
    setViewYear(today.year);
    setViewMonth(today.month);
  }, [today]);

  const onPickDay = useCallback((day: string) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const handleRetry = useCallback(() => {
    setRetryTrigger((c) => c + 1);
  }, []);

  const isLoading = scheduleLoading || notesLoading;
  const isError = scheduleError || notesError;
  const hasNotes = selectedDay ? createdNotes.length + updatedNotes.length > 0 : recentNotes.length > 0;
  const hasSchedule = daySchedule.length > 0;
  const isEmpty = !isLoading && !isError && !hasNotes && !hasSchedule;

  return (
    <div className="mobile-list scroll" data-testid="mobile-calendar-view">
      <div className="mobile-calendar-nav">
        <button type="button" className="mobile-icon-btn" onClick={() => navMonth(-1)} aria-label={t("search.calendar_prev_month")} title={t("search.calendar_prev_month")}>
          <IconCaret dir="left" size={16} />
        </button>
        <span className="mobile-calendar-month-label">{monthLabel}</span>
        <button type="button" className="mobile-icon-btn" onClick={() => navMonth(1)} aria-label={t("search.calendar_next_month")} title={t("search.calendar_next_month")}>
          <IconCaret dir="right" size={16} />
        </button>
        {(viewYear !== today.year || viewMonth !== today.month) && (
          <button type="button" className="mobile-text-btn mobile-calendar-today-btn" onClick={goToday}>
            {t("search.calendar_today")}
          </button>
        )}
      </div>

      <div className="mobile-calendar-grid">
        {weekdayLabels.map((label, i) => (
          <div key={i} className="mobile-calendar-weekday" data-tone={headerTone(i, weekStart) ?? undefined}>{label}</div>
        ))}
        {cells.map((cell, i) => (
          <CalendarDayCell
            key={i}
            cell={cell}
            count={cell.day ? (counts[cell.day] ?? 0) : 0}
            hasSchedule={Boolean(cell.day && scheduleDays.has(cell.day))}
            tone={cell.day ? dayTone(cell.day, holidays) : null}
            holidayName={cell.day ? holidays.get(cell.day) : undefined}
            isToday={cell.day === todayIso}
            isSelected={cell.day !== null && cell.day === selectedDay}
            onPick={onPickDay}
          />
        ))}
      </div>

      {selectedDay && (
        <div className="mobile-calendar-selected-row">
          <span className="label-caps">{selectedDay}</span>
          <button type="button" className="mobile-text-btn" onClick={() => setSelectedDay(null)}>
            {t("search.calendar_clear_pick")}
          </button>
        </div>
      )}

      {/* Distinct 3 states: Loading / Error / Content (with empty) */}
      {isLoading && (
        <div className="mobile-empty mobile-empty--hint" data-testid="mobile-calendar-loading">
          {t("mobile.calendar_loading")}
        </div>
      )}

      {isError && (
        <div className="mobile-calendar-error" data-testid="mobile-calendar-error">
          <button type="button" className="mobile-calendar-retry-btn" onClick={handleRetry}>
            {t("mobile.calendar_load_failed")}
          </button>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          {hasSchedule && (
            <CalendarScheduleGroup
              label={t("mobile.calendar_schedule_group")}
              timedItems={timedSchedule}
              allDayItems={allDaySchedule}
              onOpenNote={onOpenNote}
            />
          )}

          {!selectedDay ? (
            <CalendarNoteGroup label={t("search.calendar_recent_created")} notes={recentNotes} uiLang={uiLang} onOpenNote={onOpenNote} />
          ) : (
            <>
              <CalendarNoteGroup label={t("search.calendar_created_group")} notes={createdNotes} uiLang={uiLang} onOpenNote={onOpenNote} />
              <CalendarNoteGroup label={t("search.calendar_updated_group")} notes={updatedNotes} uiLang={uiLang} onOpenNote={onOpenNote} />
            </>
          )}

          {isEmpty && (
            <div className="mobile-empty mobile-empty--hint" data-testid="mobile-calendar-empty">
              {t("search.expanded_empty")}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CalendarDayCell({
  cell,
  count,
  hasSchedule,
  tone,
  holidayName,
  isToday,
  isSelected,
  onPick,
}: {
  cell: CalendarCell;
  count: number;
  hasSchedule: boolean;
  tone: DayTone;
  holidayName: string | undefined;
  isToday: boolean;
  isSelected: boolean;
  onPick: (day: string) => void;
}) {
  if (cell.day === null) return <div />;
  const titleParts = [holidayName, count > 0 ? t("search.calendar_day_count", { count }) : undefined].filter(
    (p): p is string => Boolean(p),
  );
  return (
    <button
      type="button"
      className="mobile-calendar-day"
      data-today={isToday || undefined}
      data-selected={isSelected || undefined}
      data-tone={tone ?? undefined}
      data-has-schedule={hasSchedule || undefined}
      data-testid={`mobile-calendar-day-${cell.day}`}
      aria-pressed={isSelected}
      onClick={() => onPick(cell.day!)}
      title={titleParts.length > 0 ? titleParts.join(" · ") : undefined}
    >
      <span className="mobile-calendar-day-num">{cell.dayOfMonth}</span>
      {(count > 0 || hasSchedule) && (
        <div className="mobile-calendar-dots">
          {count > 0 && <span className="mobile-calendar-day-dot" aria-hidden />}
          {hasSchedule && (
            <span
              className="mobile-calendar-schedule-dot"
              data-testid={`mobile-calendar-schedule-dot-${cell.day}`}
              aria-hidden
            />
          )}
        </div>
      )}
    </button>
  );
}

function CalendarScheduleGroup({
  label,
  timedItems,
  allDayItems,
  onOpenNote,
}: {
  label: string;
  timedItems: CalendarItem[];
  allDayItems: CalendarItem[];
  onOpenNote: (id: string) => void;
}) {
  return (
    <div data-testid="mobile-calendar-schedule-group">
      <div className="mobile-calendar-group-label">{label}</div>
      {timedItems.map((item) => (
        <button
          type="button"
          key={`timed-${item.date_id}-${item.span_start}`}
          className="mobile-card mobile-calendar-schedule-card card"
          {...preloadIntentProps(MobileNote)}
          onClick={() => onOpenNote(item.note_id)}
          data-testid={`mobile-schedule-item-${item.note_id}`}
        >
          <span className="mobile-calendar-schedule-time">
            {item.start_time}{item.end_time ? ` – ${item.end_time}` : ""}
          </span>
          <span className="mobile-card-title" style={{ flex: 1, minWidth: 0 }}>
            {displayTitle(item.title)}
          </span>
        </button>
      ))}
      {allDayItems.map((item) => (
        <button
          type="button"
          key={`allday-${item.date_id}-${item.span_start}`}
          className="mobile-card mobile-calendar-schedule-card card"
          {...preloadIntentProps(MobileNote)}
          onClick={() => onOpenNote(item.note_id)}
          data-testid={`mobile-schedule-item-${item.note_id}`}
        >
          <span className="mobile-calendar-schedule-allday">
            {t("mobile.calendar_allday")}
          </span>
          <span className="mobile-card-title" style={{ flex: 1, minWidth: 0 }}>
            {displayTitle(item.title)}
          </span>
        </button>
      ))}
    </div>
  );
}

function CalendarNoteGroup({
  label,
  notes,
  uiLang,
  onOpenNote,
}: {
  label: string;
  notes: NoteSummary[];
  uiLang: string;
  onOpenNote: (id: string) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div>
      <div className="mobile-calendar-group-label">{label}</div>
      {notes.map((n) => {
        const Glyph = noteIconComp(n.icon, IconNote);
        return (
          <button type="button" key={n.id} className="mobile-card mobile-calendar-note card" {...preloadIntentProps(MobileNote)} onClick={() => onOpenNote(n.id)}>
            <Glyph size={16} strokeWidth={1.8} style={{ flex: "none" }} />
            <span className="mobile-card-title" style={{ flex: 1, minWidth: 0 }}>{displayTitle(n.title)}</span>
            <span className="mobile-row-date">{formatCompactDate(n.updated_at, uiLang)}</span>
          </button>
        );
      })}
    </div>
  );
}
