/**
 * Home calendar tab — DASHBOARD.md §3.3.
 * Layers: event chips + span bars (neutral — no urgency/deadline coloring; due_at was retired
 * 2026-08-01 into the event end triple, and the deadline/⏰ display model itself was retired
 * app-wide 2026-08-01, see calendarLayout.ts) + record axis (created/updated notes, faint dots —
 * see the record-axis note below).
 * Month grid math reuses leftpanel calendarGrid (Sunday-first UTC YMD — pure calendar dates).
 * Drag empty range → confirm → note_create (+ replacePrimaryDate for multi-day) → open tab.
 * Hovering an empty day cell also shows a quick "+" that skips the confirm step (see
 * createNoteForRange / onQuickCreate below) — same note_create path, no popover.
 * Right-click a day → AI schedule prompt → propose (ai_generate_from_prompt) → user confirms →
 * note_create (+ replacePrimaryDate). Bad model output surfaces as a notice, never a garbage note.
 *
 * Record axis (dashboard QA cleanup, replaces the removed header activity grass): reuses
 * note_record_histogram — the exact command + monthRange helper the sidebar's record-axis
 * calendar (leftpanel/expanded/CalendarExpanded.tsx) already calls — rather than teaching
 * dashboard_calendar a new field. Same UTC day-bucketing as the sidebar, so a day lights up
 * here iff it would there. Unlike the sidebar (global scope), this passes workspace_id so the
 * dots agree with every other dashboard chip's workspace scoping.
 *
 * Decomposed architecture:
 * - Header controls: calendar/CalendarControlHeader.tsx
 * - Event dialogs / AI popovers: calendar/CalendarEventDialog.tsx
 * - Drag/popover session: calendar/useCalendarDrag.ts
 * - Grid rendering: calendar/MonthGrid.tsx
 * - Day detail panel: calendar/DayDetailPanel.tsx
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call, emitNotice } from "../../lib/invoke";
import type { CalendarItem, CalendarResult } from "../../lib/commands.gen";
import { createNoteForRange as createNoteForRangeLib, patchDateRow } from "../../lib/primaryDate";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { ensureAiAskGate, useAiStore } from "../../stores/ai";
import { t } from "../../i18n/t";
import { noteRecordHistogram, useNoteQueryVersion } from "../../lib/noteQuery";
import { monthRange, shiftMonth } from "../leftpanel/expanded/calendarGrid";
import {
  parseIsoDay,
  collapseOccurrencesForDay,
  buildCalendarGridCustom,
  formatHhmm,
  clampStoredEndMin,
} from "./calendarLayout";
import { todayLocal, yearMonthPrefix, weekdayShortLabels, monthLongLabel } from "./dateFmt";
import { MonthGrid } from "./calendar/MonthGrid";
import { YearGrid, type YearScrollRequest } from "./calendar/YearGrid";
import { DayDetailPanel } from "./calendar/DayDetailPanel";
import { CalendarControlHeader, HeaderGroup, type CalendarViewMode } from "./calendar/CalendarControlHeader";
import { IconFileExport, IconFileImport } from "../icons";
import { useDayMarkMaps, useTodayIso } from "../../lib/calendarDay";
import {
  CalendarEventDialog,
  type CalendarScheduleProposal,
  addDaysIso,
  parseCalendarScheduleProposal,
  buildCalendarSchedulePrompt,
} from "./calendar/CalendarEventDialog";
import { usePendingRangeNote } from "./calendar/usePendingRangeNote";
import { useWeatherLocation } from "./useWeatherLocation";
import { useDashboardSearchHits } from "./useDashboardSearchHits";
import { useDashboardReveal } from "./useDashboardReveal";
import { useMonthForecast } from "./calendar/useMonthForecast";
import { exportCalendarIcs, importIcsToDatabase, pickAndReadIcsFile } from "../../lib/ical";

// Re-export AI scheduling helpers and types for external callers and tests
export type { CalendarScheduleProposal };
export { addDaysIso, parseCalendarScheduleProposal, buildCalendarSchedulePrompt };

export function CalendarTab() {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const weekStart = useSettingsStore((s) => s.weekStart);
  const selectNote = useNotesStore((s) => s.selectNote);

  // `today` is a mount-time snapshot, kept for the initial viewed month / goToday — those don't
  // need to react to a live rollover. The grid's *highlighted* day does: useTodayIso rides
  // HomeHeader's existing minute tick (dashboard audit P2 #4, now shared by every calendar).
  const today = useMemo(todayLocal, []);
  const todayIso = useTodayIso();
  const [viewYear, setViewYear] = useState(today.year);
  const [viewMonth, setViewMonth] = useState(today.month); // 0-11
  // Month ↔ year grid (2026-09-08). View-local, not a setting — the tab stays mounted (HomeTab),
  // so it survives tab switches within a session, and that's all the persistence it needs.
  const [viewMode, setViewMode] = useState<CalendarViewMode>("month");
  // Year view = continuous vertical scroll over a 3-year window centred on viewYear (YearGrid
  // reports the year under the viewport centre; the window follows it). yearScroll is how this
  // component moves the viewport (mount centring on the viewed month, prev/next, today).
  const yearWindow = useMemo(() => [viewYear - 1, viewYear, viewYear + 1], [viewYear]);
  const [yearScroll, setYearScroll] = useState<YearScrollRequest | null>(null);
  const yearScrollSeq = useRef(0);
  const requestYearScroll = useCallback((year: number, month0: number, align: "top" | "center") => {
    yearScrollSeq.current += 1;
    setYearScroll({ year, month0, align, seq: yearScrollSeq.current });
  }, []);
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [itemsMonth, setItemsMonth] = useState<{ year: number; month: number } | null>(null);
  const monthItems = useMemo(() => (itemsMonth ? { ...itemsMonth, items } : null), [itemsMonth, items]);
  const [recordCounts, setRecordCounts] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  // Dashboard audit P1 #3: a fetch failure used to fall into the same empty state as "genuinely
  // no records this month" (BoardPane.tsx error state + banner pattern, applied here).
  const [error, setError] = useState(false);
  // 열자마자 **오늘의 타임라인**이다(오너 결정 2026-09-10). 예전 기본값은 null = 그 달 노트
  // 목록이었는데, 브리핑 헤더(날짜·요일·날씨)도 시간축도 날짜 모드에만 있어서 정작 기본 화면에선
  // 둘 다 안 보였다. 달을 옮기면 아래 효과가 선택을 풀어 그 달 목록으로 돌아간다 — 월 목록이
  // 사라지는 게 아니라 기본이 바뀌는 것이고, 오늘을 한 번 더 누르면 그 자리에서도 토글된다.
  const [selectedDay, setSelectedDay] = useState<string | null>(todayIso);
  // Single-click focus (map view pattern, see HomeMapPane) — view-local, no store.
  // Double-click still opens (onOpenNote below). Cleared by picking a day (empty-cell click).
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Any note mutation elsewhere (delete/move/edit — e.g. the sidebar's Timeline row context menu)
  // bumps this via loadTree()'s bumpNoteQueryVersion(). This pane stays mounted once visited
  // (HomeTab.tsx) and otherwise only refetches on workspace/month/reloadToken changes, so without
  // this dep a note deleted while Calendar is the visible tab stays stuck on screen until the user
  // happens to navigate months (2026-09-03 owner repro).
  const noteQueryVersion = useNoteQueryVersion();
  const weatherLoc = useWeatherLocation();
  // 하루 칸이 있는 뷰(월)에서만 예보를 받는다 — 창 게이트와 fetch 는 사이드바 미니 달력과
  // **같은 훅**이 쥔다(useMonthForecast). 연 보기는 `enabled:false` 로 꺼서 예보를 비운다.
  const { forecast } = useMonthForecast(weatherLoc, viewYear, viewMonth, { enabled: viewMode !== "year" });

  // Right-click AI schedule: small prompt near cursor → propose → confirm → note_create.
  const [aiPrompt, setAiPrompt] = useState<{ day: string; x: number; y: number } | null>(null);
  const [aiProposing, setAiProposing] = useState(false);
  const [aiProposal, setAiProposal] = useState<
    (CalendarScheduleProposal & { x: number; y: number }) | null
  >(null);

  const promptPending = useAiStore((s) => s.promptPending);
  const searchHits = useDashboardSearchHits();
  // Dashboard-wide folder filter (nav row dot control, stores/ui.ts) — replaces the old local
  // useState + the cal-legend rail. Dim-not-remove semantics below (MonthGrid/DayDetailPanel's
  // data-search-dim) are unchanged from before the move.
  const folderFilter = useUiStore((s) => s.dashboardFolderFilter);

  // Toggling the filter used to also clear a stale focusedNoteId inline (same click handler).
  // The click now happens in a sibling component (FolderDotFilter, nav row), so replicate the
  // side effect declaratively: react only when folderFilter itself actually changes (prevFilterRef
  // guard — a same-value re-render, e.g. from items reloading, must not re-fire this).
  const prevFolderFilterRef = useRef(folderFilter);
  useEffect(() => {
    if (prevFolderFilterRef.current === folderFilter) return;
    prevFolderFilterRef.current = folderFilter;
    if (!folderFilter || !focusedNoteId) return;
    const item = items.find((i) => i.note_id === focusedNoteId);
    if (item && item.folder_id !== folderFilter) setFocusedNoteId(null);
  }, [folderFilter, items, focusedNoteId]);

  // Wave E reveal handler: move to note date + select day + focus note. Consumption/tab-guard
  // ordering lives in useDashboardReveal (see that file — fixes stale replay on tab switch).
  useDashboardReveal("calendar", (noteId: string) => {
    const summary = useNotesStore.getState().noteIndex.get(noteId);
    let targetYear = viewYear;
    let targetMonth = viewMonth;
    let targetDay: string | null = null;

    if (summary) {
      if (summary.year != null && summary.month != null) {
        targetYear = summary.year;
        targetMonth = summary.month - 1;
        const d = summary.day ?? 1;
        targetDay = `${summary.year}-${String(summary.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      } else if (summary.created_at) {
        const parsed = parseIsoDay(summary.created_at.slice(0, 10));
        if (parsed) {
          targetYear = parsed.year;
          targetMonth = parsed.month - 1;
          targetDay = `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
        }
      }
    } else {
      const item = items.find((i) => i.note_id === noteId);
      if (item) {
        const parsed = parseIsoDay(item.span_start);
        if (parsed) {
          targetYear = parsed.year;
          targetMonth = parsed.month - 1;
          targetDay = item.span_start;
        }
      }
    }

    setViewYear(targetYear);
    setViewMonth(targetMonth);
    setViewMode("month");
    if (targetDay) setSelectedDay(targetDay);
    setFocusedNoteId(noteId);
  });

  // dashboard_calendar uses 1-based month.
  const apiMonth = viewMonth + 1;

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      setRecordCounts(new Map());
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        // Year view = the same month query once per month of the 3-year window (36 calls —
        // ponytail: reuses month clipping, rrule expansion and the span_month index as-is; a range
        // command, or a per-year cache so a one-year shift refetches 12 not 36, is the upgrade if
        // the round-trips ever show). A span crossing months comes back once per month it touches —
        // monthNotes below dedupes by note_id for the detail list, YearGrid indexes by day.
        const months: { year: number; month: number }[] =
          viewMode === "year"
            ? yearWindow.flatMap((year) => Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 })))
            : [{ year: viewYear, month: apiMonth }];
        const { from, to } =
          viewMode === "year"
            ? { from: `${yearWindow[0]}-01-01`, to: `${yearWindow[yearWindow.length - 1]}-12-31` }
            : monthRange(viewYear, viewMonth);
        // One effect, one Promise.all: the event/due/span layer and the record-axis layer
        // settle together, so the empty-state check below never flashes before the record
        // dots land, and reloadToken (quick-create / drag-create) refreshes both for free.
        const [calResults, recordCounts] = await Promise.all([
          Promise.all(
            months.map(({ year, month }) =>
              call<CalendarResult>("dashboard_calendar", { workspace_id: workspaceId, year, month }),
            ),
          ),
          noteRecordHistogram(from, to, "union", workspaceId),
        ]);
        if (cancelled) return;
        setItems(calResults.flatMap((r) => r.items));
        // 이 items 가 **어느 달**의 것인지 함께 기억한다 — 시간축 익일 구간이 같은 달이면 이 데이터를 그대로 쓴다(DayDetailPanel.monthItems).
        setItemsMonth(viewMode === "month" ? { year: viewYear, month: apiMonth } : null);
        setRecordCounts(new Map(Object.entries(recordCounts)));
      } catch {
        if (!cancelled) {
          setError(true);
          setItems([]);
          setItemsMonth(null);
          setRecordCounts(new Map());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, viewYear, viewMonth, apiMonth, viewMode, yearWindow, reloadToken, noteQueryVersion]);

  // Clear selection when navigating away from the month that contains it.
  useEffect(() => {
    if (!selectedDay) return;
    const prefix = yearMonthPrefix(viewYear, apiMonth);
    if (!selectedDay.startsWith(prefix)) setSelectedDay(null);
  }, [viewYear, apiMonth, selectedDay]);

  const cells = useMemo(
    () => buildCalendarGridCustom(viewYear, viewMonth, weekStart),
    [viewYear, viewMonth, weekStart],
  );

  const weekdayLabels = useMemo(() => weekdayShortLabels(uiLang, weekStart), [uiLang, weekStart]);

  const monthLabel = useMemo(
    () => (viewMode === "year" ? String(viewYear) : monthLongLabel(uiLang, viewYear, viewMonth)),
    [uiLang, viewYear, viewMonth, viewMode],
  );

  // Year view scrolls across the whole window, so its holidays must cover every loaded year.
  const holidayYears = useMemo(
    () => (viewMode === "year" ? yearWindow : [viewYear]),
    [viewMode, yearWindow, viewYear],
  );
  // 빨간 날(공휴일 + 빨간 날 표시일)과 기념일 이름표 — 같은 전개를 한 번만(PLAN-2026-09-19-calendar-schedule §3).
  const { off: holidays, labels: dayLabels } = useDayMarkMaps(holidayYears);

  // 브리핑 헤더(달력 W4)는 조립된 한 줄이 아니라 연월/일/요일 **조각**이 필요해 패널이 직접
  // 만든다(같은 `T00:00:00Z` + UTC 규칙). 여기 있던 selectedDayLabel 은 그래서 사라졌다.
  // When no day is selected, show that month's notes as a list, most-recently-updated first
  // (deduplicated by note_id). In year view the list is the header year's notes — items are
  // month-clipped, so a piece's span_start year is the year it sits in.
  const monthNotes = useMemo(() => {
    const seen = new Set<string>();
    const unique: CalendarItem[] = [];
    const yearPrefix = viewMode === "year" ? `${viewYear}-` : null;
    for (const item of items) {
      if (yearPrefix && !item.span_start.startsWith(yearPrefix)) continue;
      if (!seen.has(item.note_id)) {
        seen.add(item.note_id);
        unique.push(item);
      }
    }
    return unique.sort(
      (a, b) =>
        b.span_end.localeCompare(a.span_end) ||
        b.span_start.localeCompare(a.span_start) ||
        b.note_id.localeCompare(a.note_id),
    );
  }, [items, viewMode, viewYear]);

  const detailNotes = useMemo(
    () => (selectedDay ? collapseOccurrencesForDay(items, selectedDay) : monthNotes),
    [items, selectedDay, monthNotes],
  );

  // In year view the same < > buttons step a whole year (header labels follow viewMode): the
  // window re-centres on the new year and the viewport scrolls to its January.
  const navMonth = useCallback(
    (delta: number) => {
      if (viewMode === "year") {
        setViewYear(viewYear + delta);
        requestYearScroll(viewYear + delta, 0, "top");
        return;
      }
      const next = shiftMonth(viewYear, viewMonth, delta);
      setViewYear(next.year);
      setViewMonth(next.month);
    },
    [viewYear, viewMonth, viewMode, requestYearScroll],
  );

  const onViewModeChange = useCallback(
    (mode: CalendarViewMode) => {
      setViewMode(mode);
      if (mode === "year") {
        setSelectedDay(null);
        setFocusedNoteId(null);
        // Land with the month you were looking at in the middle of the viewport.
        requestYearScroll(viewYear, viewMonth, "center");
      }
    },
    [viewYear, viewMonth, requestYearScroll],
  );

  // Scrolling moved another year under the viewport centre → header label + window follow.
  const onCenterYearChange = useCallback((year: number) => setViewYear(year), []);

  // Year grid drill-downs: a month title → that month; a day → that month with the day selected.
  const onPickYearMonth = useCallback((year: number, month0: number) => {
    setViewYear(year);
    setViewMonth(month0);
    setViewMode("month");
  }, []);
  const onPickYearDay = useCallback((day: string) => {
    const parsed = parseIsoDay(day);
    if (!parsed) return;
    setViewYear(parsed.year);
    setViewMonth(parsed.month - 1);
    setViewMode("month");
    setSelectedDay(day);
  }, []);

  const goToday = useCallback(() => {
    setViewYear(today.year);
    setViewMonth(today.month);
    if (viewMode === "year") requestYearScroll(today.year, today.month, "center");
  }, [today, viewMode, requestYearScroll]);

  const onPickDay = useCallback((day: string) => {
    // Picking a day is only reachable via a click on the day cell's own empty space (spans/
    // events stopPropagation before this fires) — the "빈 공간 클릭 시 해제" deselect point.
    setFocusedNoteId(null);
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  const onOpenNote = useCallback(
    (noteId: string) => {
      void selectNote(noteId);
    },
    [selectNote],
  );

  const onFocusNote = useCallback((noteId: string) => setFocusedNoteId(noteId), []);

  // Shared note_create path for drag-confirm, quick-create "+", AI schedule confirm and the
  // time-axis empty drag. PLAN-2026-09-11 사이드바 W1 D5 — 본체는 lib/primaryDate 의
  // createNoteForRange 로 올라갔다(사이드바가 두 번째 사용처). 여기는 이 탭의 `creating` 만
  // 토글하는 껍데기다. 실패는 lib 이 붙잡아 null 을 주고(call 이 이미 토스트), 재조회는 lib 의
  // bump 가 맡는다 — 이 탭의 fetch effect 가 noteQueryVersion 을 구독하므로 reloadToken 을
  // 여기서 올릴 이유가 없다.
  const createNoteForRange = useCallback(
    async (startIso: string, endIso: string, title?: string): Promise<string | null> => {
      setCreating(true);
      try {
        return await createNoteForRangeLib(startIso, endIso, { title });
      } finally {
        setCreating(false);
      }
    },
    [],
  );

  // 드래그-생성 세션(선생성 → 확정/취소 시 purge)은 사이드바 미니 달력과 **같은 훅**이 쥔다
  // (usePendingRangeNote — 그 안에서 useCalendarDrag 를 부른다). 이 탭만 다른 것은 purge/확정
  // 뒤에 reloadToken 을 한 칸 올린다는 것뿐이라 그것만 onSettled 로 넣는다.
  const bumpReload = useCallback(() => setReloadToken((n) => n + 1), []);

  const {
    popover,
    closePopover,
    isDragHighlighted,
    onCellPointerDown,
    onCellPointerEnter,
    pendingNoteId,
    confirm: onConfirmCreate,
  } = usePendingRangeNote({
    onPick: onPickDay,
    createNote: createNoteForRange,
    busy: creating,
    onSettled: bumpReload,
  });

  const closeAiPrompt = useCallback(() => {
    setAiPrompt(null);
    setAiProposing(false);
  }, []);

  const closeAiProposal = useCallback(() => {
    setAiProposal(null);
  }, []);

  // Right-click day → open a small AI prompt at the cursor (gate before showing).
  const onContextMenuDay = useCallback((day: string, e: React.MouseEvent) => {
    void (async () => {
      if (!(await ensureAiAskGate())) return;
      setAiProposal(null);
      setAiPrompt({ day, x: e.clientX, y: e.clientY });
    })();
  }, []);

  const submitAiPrompt = useCallback(
    async (anchor: { day: string; x: number; y: number }, userText: string) => {
      if (aiProposing || promptPending) return;
      setAiProposing(true);
      try {
        const raw = await useAiStore
          .getState()
          .generateFromPrompt(buildCalendarSchedulePrompt(anchor.day, userText), null);
        if (raw == null) {
          // Gate/backend already toasted or returned null — leave prompt open for retry.
          return;
        }
        const proposal = parseCalendarScheduleProposal(raw, anchor.day);
        if (!proposal) {
          emitNotice(t("home.cal_ai_propose_fail"));
          return;
        }
        setAiPrompt(null);
        setAiProposal({ ...proposal, x: anchor.x, y: anchor.y });
      } finally {
        setAiProposing(false);
      }
    },
    [aiProposing, promptPending],
  );

  const confirmAiProposal = useCallback(async () => {
    if (!aiProposal || creating) return;
    // 실패(null)면 제안을 열어 둔다 — 다시 시도하거나 닫을 수 있게. 토스트는 call 이 띄웠다.
    const id = await createNoteForRange(aiProposal.start, aiProposal.end, aiProposal.title);
    if (id) closeAiProposal();
  }, [aiProposal, creating, createNoteForRange, closeAiProposal]);

  // 시간축(DayDetailPanel)의 빈 곳 드래그 → 그 자리에 노트. **두 번째 생성 경로를 만들지
  // 않는다** — 그리드의 드래그·"+"·AI 확정이 쓰는 createNoteForRange 그대로 만들고, 시각만
  // 그 위에 얹는다(patchDateRow = "행 읽고 전량 교체" 한 지점, lib/primaryDate).
  const onCreateTimedNote = useCallback(
    (day: string, startMin: number, endMin: number) => {
      if (creating) return;
      void (async () => {
        try {
          const id = await createNoteForRange(day, day);
          if (!id) return;
          await patchDateRow(id, null, {
            start_time: formatHhmm(startMin),
            // 축 바닥까지 끌면 endMin 이 1440 이고 formatHhmm 은 그걸 "00:00" 으로 준다 —
            // I3 가 거절해 **시각 없는 노트**가 조용히 남았다. clamp 규칙은 drop 과 공유한다.
            end_time: formatHhmm(clampStoredEndMin(endMin)),
          });
          setReloadToken((n) => n + 1);
          setFocusedNoteId(id);
        } catch {
          // invoke already surfaced the failure. 노트는 남아 있고(시각만 못 얹었다) 위 reload 가
          // 없으므로 화면은 다음 갱신 때 진실을 그린다.
        }
      })();
    },
    [creating, createNoteForRange],
  );

  // Hover "+" on an empty day cell → straight to note_create for that date, no confirm popover
  // (reuses createNoteForRange's body — same command sequence the drag path uses).
  const onQuickCreate = useCallback(
    (day: string) => {
      if (creating) return;
      void createNoteForRange(day, day);
    },
    [creating, createNoteForRange],
  );

  return (
    <div
      data-testid="home-calendar"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "row",
        overflow: "hidden",
        gap: "var(--space-7)",
        padding: "0 var(--space-4) var(--space-4)",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <CalendarControlHeader
          monthLabel={monthLabel}
          onPrevMonth={() => navMonth(-1)}
          onNextMonth={() => navMonth(1)}
          showToday={viewYear !== today.year || (viewMode === "month" && viewMonth !== today.month)}
          onToday={goToday}
          loading={loading}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          rightSlot={
            <HeaderGroup testId="cal-ics-group">
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--glow"
                data-testid="cal-import-ics"
                title={t("settings.calendar_import_ics")}
                aria-label={t("settings.calendar_import_ics")}
                onClick={() => {
                  void (async () => {
                    try {
                      const ics = await pickAndReadIcsFile();
                      if (!ics) return;
                      await importIcsToDatabase(ics);
                      setReloadToken((k) => k + 1);
                    } catch {
                      // call()/callSilent already surfaced the failure; nothing to roll back —
                      // the reload token only advances on success.
                    }
                  })();
                }}
              >
                <IconFileImport size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--glow"
                data-testid="cal-export-ics"
                title={t("settings.calendar_export_ics")}
                aria-label={t("settings.calendar_export_ics")}
                onClick={() => {
                  void exportCalendarIcs().catch(() => {
                    // Already surfaced by the call() inside; this only stops the rejection leaking.
                  });
                }}
              >
                <IconFileExport size={14} />
              </button>
            </HeaderGroup>
          }
        />

        {/* Load-failure banner — BoardPane's error state + banner pattern (board-error), applied
            here so a failed fetch never masquerades as "no records this month" below. */}
        {error && (
          <div
            data-testid="cal-error"
            style={{
              paddingBottom: "var(--space-3)",
              color: "var(--danger)",
              fontSize: "var(--text-sm)",
              flex: "none",
            }}
          >
            {t("home.cal_load_failed")}
          </div>
        )}

        {/* Quiet empty-month notice — in flow (not an overlay) so it never blocks the grid's
            drag-to-create pointerdown, and only once the month has actually loaded empty.
            Suppressed when the record axis has dots — a month with no events/dues but with
            created/updated notes isn't actually empty. Suppressed on error — that state gets
            its own banner above, not the misleading "empty" copy. */}
        {workspaceId && !loading && !error && items.length === 0 && recordCounts.size === 0 && (
          <div
            data-testid="cal-month-empty"
            style={{
              paddingBottom: "var(--space-3)",
              color: "var(--faint)",
              fontSize: "var(--text-sm)",
              flex: "none",
            }}
          >
            {t(viewMode === "year" ? "home.cal_empty_year" : "home.cal_empty_month")}
          </div>
        )}

        {viewMode === "year" ? (
          <YearGrid
            years={yearWindow}
            items={items}
            recordCounts={recordCounts}
            todayIso={todayIso}
            weekStart={weekStart}
            uiLang={uiLang}
            holidays={holidays}
            dayLabels={dayLabels}
            searchHits={searchHits}
            folderFilter={folderFilter}
            scrollRequest={yearScroll}
            onCenterYearChange={onCenterYearChange}
            onPickDay={onPickYearDay}
            onPickMonth={onPickYearMonth}
          />
        ) : (
        <MonthGrid
          weekdayLabels={weekdayLabels}
          cells={cells}
          items={items}
          recordCounts={recordCounts}
          todayIso={todayIso}
          selectedDay={selectedDay}
          isDragHighlighted={isDragHighlighted}
          onCellPointerDown={onCellPointerDown}
          onCellPointerEnter={onCellPointerEnter}
          onPick={onPickDay}
          onQuickCreate={onQuickCreate}
          onOpenNote={onOpenNote}
          onContextMenuDay={onContextMenuDay}
          forecast={forecast}
          weekStart={weekStart}
          searchHits={searchHits}
          folderFilter={folderFilter}
          focusedNoteId={focusedNoteId}
          onFocusNote={onFocusNote}
          holidays={holidays}
          dayLabels={dayLabels}
        />
        )}
      </div>

      <DayDetailPanel
        selectedDay={selectedDay}
        monthLabel={monthLabel}
        holidayName={selectedDay ? (holidays.get(selectedDay) ?? null) : null}
        markLabel={selectedDay ? (dayLabels.get(selectedDay) ?? null) : null}
        forecast={forecast}
        detailNotes={detailNotes}
        monthItems={monthItems}
        onOpen={onOpenNote}
        onFocus={onFocusNote}
        onCreateTimedNote={onCreateTimedNote}
        focusedNoteId={focusedNoteId}
        searchHits={searchHits}
        folderFilter={folderFilter}
      />

      <CalendarEventDialog
        popover={popover}
        createdNoteId={pendingNoteId}
        creating={creating}
        onConfirmCreate={onConfirmCreate}
        onClosePopover={closePopover}
        aiPrompt={aiPrompt}
        aiProposing={aiProposing}
        promptPending={promptPending}
        onSubmitAiPrompt={submitAiPrompt}
        onCloseAiPrompt={closeAiPrompt}
        aiProposal={aiProposal}
        onConfirmAiProposal={confirmAiProposal}
        onCloseAiProposal={closeAiProposal}
      />
    </div>
  );
}
