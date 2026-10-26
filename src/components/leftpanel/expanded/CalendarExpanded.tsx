import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import { noteRecordHistogram, useNoteQueryVersion } from "../../../lib/noteQuery";
import { call } from "../../../lib/invoke";
import type { CalendarItem, CalendarResult, NoteSummary } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { IconCaret } from "../../icons";
import { NoteIcon, NoteIconControl } from "../NoteIconControl";
import { splitByQuery, HighlightedText } from "../notetree/highlight";
import { TreeRowBadges } from "../notetree/TreeRowBadges";
import { RemindBadge } from "../../home/calendar/RemindBadge";
import { startNoteDrag } from "../../../lib/noteDrag";
import { usePendingDelay } from "../../../lib/usePendingDelay";
import { PendingIndicator } from "../../common/PendingIndicator";
import { buildCalendarGridCustom, dayFetchMonth, monthRange, shiftMonth, type CalendarCell } from "./calendarGrid";
import { buildMonthReminders } from "./monthReminders";
import { weekdayShortLabels, monthLongLabel, todayLocal } from "../../home/dateFmt";
import { useWeatherLocation } from "../../home/useWeatherLocation";
import { useMonthForecast } from "../../home/calendar/useMonthForecast";
import { weatherCodeToVisual, weatherLabelKey } from "../../../lib/weather";
import { useTodayIso, useDayMarkMaps, dayTone, headerTone, toneColor, recordTint } from "../../../lib/calendarDay";
import { DayDetailBody } from "../../home/calendar/DayDetailPanel";
import { collapseOccurrencesForDay, formatHhmm, clampStoredEndMin } from "../../home/calendarLayout";
import { createNoteForRange, patchDateRow } from "../../../lib/primaryDate";
import { usePendingRangeNote } from "../../home/calendar/usePendingRangeNote";
import { CreateRangePopover } from "../../home/calendar/CreateRangePopover";

/* ── Calendar (record axis) expanded view ──
   §2.2 HANDOFF-calendar-onboarding.md: calendar grids notes.created_at ∪ notes.updated_at, not
   notes.year (that's Timeline's event axis). Grid cells come from note_record_histogram with
   axis:"union" (server aggregate, per-note deduped — never a corpus scan, never a plain sum of
   the created/updated histograms). Selected day is local component state, not a search-store
   axis (§2.2: "날짜 클릭 = 아래 리스트만 갱신, 자동 열기 없음") — modeled on RegionExpanded's
   focusedCoord rather than a new global filter, so it doesn't need buildNoteQueryInput /
   isSearchFiltered / filtering.ts wiring the way the §2.8 dateRange chip did. The day-click list
   below splits into "created that day" / "updated that day" via note_query's independent
   created_from/created_to and updated_from/updated_to axes (see noteQuery.ts).

   PLAN-2026-09-11 사이드바 W2 — 미니 달력 아래가 **"오늘 할 일" / "월간 일정" 두 탭**이 된다
   (docs/PLAN-2026-09-11-sidebar-day-panel.md §0.1: 두 표면의 데이터 모델이 달라 탭으로 가른다).
   · D1 탭은 로컬 상태, 영속화 없음, 열 때마다 "오늘 할 일". 옛 "날짜 헤더 줄"(선택 날짜 + 개수
     뱃지 + ×)은 없앴다 — 날짜는 브리핑이 말하고, 선택 해제는 미니 달력에서 같은 날을 다시 누른다.
   · D2 오늘 할 일 = 대시보드 우측 패널의 본체 `DayDetailBody` 그대로(두 벌 만들지 않는다).
     날 = `selectedDay ?? todayIso`, 항상 문자열. 포커스 강조·검색 dim 은 넘기지 않는다 —
     미니 달력엔 강조할 칩이 없고 dim 은 대시보드 필터의 것이다.
   · D3 월간 일정 = 옛 "날짜 미선택" 목록(그 달 알림). `selectedDay` 를 **무시**한다 — 그 날의 것은
     옆 탭이 맡는다.
   · D6 보는 달의 `dashboard_calendar` 는 **항상**(두 탭이 같은 `items` 를 본다 — 탭 전환은 fetch 를
     부르지 않는다). 다른 달로 넘긴 뒤 날짜를 안 골라 오늘이 보는 달 밖이면 그 달을 **하나 더**
     부른다(`dayFetchMonth`, calendarGrid.ts).
   · 오너 요청(2026-09-16) — 옛 "이날 작성/수정" 활동 목록("이 날의 기록")은 사이드바에서 통째로
     없앴다. 좁은 칼럼에서 축(시간표)과 세로 공간을 다투기만 했다 — 대시보드 쪽(CalendarTab
     → DayDetailPanel)에는 없는 사이드바 전용 기능이었으니 여기서만 지운다. */
export function CalendarExpanded() {
  const selectNote = useNotesStore((s) => s.selectNote);
  const loadTree = useNotesStore((s) => s.loadTree);
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const activeId = useNotesStore((s) => s.activeNote?.note.id ?? null);
  const query = useSearchStore((s) => s.query);
  const openCtx = useUiStore((s) => s.openCtx);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const weekStart = useSettingsStore((s) => s.weekStart);
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);

  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const noteQueryVersion = useNoteQueryVersion();

  const today = useMemo(todayLocal, []);
  const todayIso = useTodayIso();
  const [viewYear, setViewYear] = useState(today.year);
  const [viewMonth, setViewMonth] = useState(today.month);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // D1 — 탭. 영속화 없음(계획 §4).
  const [tab, setTab] = useState<"today" | "month">("today");
  // D2 — 오늘 할 일 탭의 날. 미니 달력에서 고른 날, 없으면 오늘. 항상 문자열(월 모드 없음).
  const day = selectedDay ?? todayIso;
  const { off: holidays, labels: dayLabels } = useDayMarkMaps([viewYear]);

  const [counts, setCounts] = useState<Record<string, number>>({});
  // D6 — 보는 달의 dashboard_calendar 원본. 월간 일정 탭(remind 필터)과 오늘 할 일 탭(itemsForDay)
  // 이 같은 배열을 본다. dayItems 는 `day` 가 보는 달 밖일 때만 그 달의 것이고, 같은 달이면 null.
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [dayItems, setDayItems] = useState<CalendarItem[] | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(false);
  const showGridPending = usePendingDelay(gridLoading, 150);
  const showListPending = usePendingDelay(calLoading, 150);

  const { from: monthFrom, to: monthTo } = useMemo(
    () => monthRange(viewYear, viewMonth),
    [viewYear, viewMonth]
  );

  useEffect(() => {
    let cancelled = false;
    setGridLoading(true);
    void (async () => {
      try {
        const r = await noteRecordHistogram(monthFrom, monthTo, "union");
        if (!cancelled) setCounts(r);
      } catch {
        if (!cancelled) setCounts({});
      } finally {
        if (!cancelled) setGridLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monthFrom, monthTo, noteQueryVersion]);

  // D6 — 경계 판정은 순수 함수. deps 는 원시값 둘로 두어, 같은 달 안에서 날짜만 바꿀 때는
  // (extra 가 계속 null) 보는 달을 다시 부르지 않는다.
  const extra = dayFetchMonth(day, viewYear, viewMonth);
  const extraYear = extra?.year ?? null;
  const extraMonth = extra?.month ?? null;

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      setDayItems(null);
      return;
    }
    let cancelled = false;
    setCalLoading(true);
    const fetchMonth = (year: number, month: number) =>
      call<CalendarResult>("dashboard_calendar", { workspace_id: workspaceId, year, month: month + 1 });
    void (async () => {
      try {
        // 두 fetch 가 같은 cancelled 를 본다 — 경쟁으로 엉뚱한 달이 남지 않게.
        const [viewed, other] = await Promise.all([
          fetchMonth(viewYear, viewMonth),
          extraYear !== null && extraMonth !== null ? fetchMonth(extraYear, extraMonth) : null,
        ]);
        if (cancelled) return;
        setItems(viewed.items ?? []);
        setDayItems(other ? (other.items ?? []) : null);
      } catch {
        // call() 이 이미 토스트를 띄웠다.
        if (!cancelled) {
          setItems([]);
          setDayItems(null);
        }
      } finally {
        if (!cancelled) setCalLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewYear, viewMonth, extraYear, extraMonth, workspaceId, noteQueryVersion]);

  // 월간 일정 탭: 보는 달의 알림 있는 노트(dashboard-aligned). items 위에서 파생 — fetch 와 분리.
  // 조립 규칙 자체는 monthReminders.ts 의 순수 함수다(마운트 없이 검증된다).
  const monthReminders = useMemo(
    () => buildMonthReminders(items, noteIndex, { selectedTags, tagMode, statusFilter }),
    [items, noteIndex, selectedTags, tagMode, statusFilter]
  );

  // 오늘 할 일 탭의 그 날 항목 — `day` 가 보는 달 밖이면 경계 fetch 결과에서.
  const detailNotes = useMemo(() => collapseOccurrencesForDay(dayItems ?? items, day), [dayItems, items, day]);

  const cells = useMemo(
    () => buildCalendarGridCustom(viewYear, viewMonth, weekStart),
    [viewYear, viewMonth, weekStart]
  );
  const weekdayLabels = useMemo(() => weekdayShortLabels(uiLang, weekStart), [uiLang, weekStart]);

  const weatherLoc = useWeatherLocation();
  // 날씨 표시 토글은 없다(D11, 2026-09-12) — 위치만 있으면 항상 그린다. 16일 창 게이트와
  // time[] → Map 변환은 대시보드 달력 탭과 **같은 훅**이 쥔다(useMonthForecast).
  const { forecast, forecastByDay } = useMonthForecast(weatherLoc, viewYear, viewMonth);

  const maxCount = useMemo(() => Math.max(1, ...Object.values(counts)), [counts]);

  const goToday = useCallback(() => {
    setViewYear(today.year);
    setViewMonth(today.month);
  }, [today]);

  const navMonth = useCallback(
    (delta: number) => {
      const next = shiftMonth(viewYear, viewMonth, delta);
      setViewYear(next.year);
      setViewMonth(next.month);
    },
    [viewYear, viewMonth]
  );

  // 같은 날을 다시 누르면 해제(= 오늘로). 옛 × 버튼의 자리다.
  const onPickDay = useCallback((day: string) => {
    setSelectedDay((prev) => (prev === day ? null : day));
  }, []);

  // 미니 달력 드래그 → 여러 날에 걸친 노트 생성. 대시보드 월 그리드와 **같은 훅**
  // (usePendingRangeNote → useCalendarDrag) · **같은 팝오버**(CreateRangePopover, 2026-09-12
  // 분리 — 오너 피드백: 드래그-생성 팝오버가 DatesPanel 의 달력 그리드를 인라인으로 품어 이미
  // 화면에 떠 있는 달력과 중복이었다). 생성 경로도 CalendarTab 과 같은 것 하나
  // (createNoteForRange, lib/primaryDate) — 두 번째 경로를 만들지 않는다.
  const [creatingRange, setCreatingRange] = useState(false);
  const {
    popover,
    closePopover,
    isDragHighlighted,
    onCellPointerDown,
    onCellPointerEnter,
    pendingNoteId,
    confirm: onConfirmCreateRange,
  } = usePendingRangeNote({
    onPick: onPickDay,
    createNote: createNoteForRange,
    busy: creatingRange,
    setBusy: setCreatingRange,
  });

  const monthLabel = useMemo(
    () => monthLongLabel(uiLang, viewYear, viewMonth),
    [uiLang, viewYear, viewMonth]
  );

  const onOpenCtx = useCallback(
    (id: string, x: number, y: number) => openCtx(id, x, y),
    [openCtx]
  );

  const onOpenNote = useCallback((id: string) => {
    void useNotesStore.getState().selectNote(id);
  }, []);

  // 축의 빈 곳 드래그 → 그 자리에 노트. CalendarTab 의 onCreateTimedNote 와 같은 두 줄 —
  // 생성 경로는 lib/primaryDate 의 createNoteForRange 하나다(두 번째 경로를 만들지 않는다).
  const onCreateTimedNote = useCallback((d: string, startMin: number, endMin: number) => {
    void (async () => {
      try {
        const id = await createNoteForRange(d, d);
        if (!id) return;
        await patchDateRow(id, null, {
          start_time: formatHhmm(startMin),
          // 축 바닥까지 끌면 endMin 이 1440 — clamp 규칙은 drop 과 공유한다(calendarLayout).
          end_time: formatHhmm(clampStoredEndMin(endMin)),
        });
      } catch {
        // invoke already surfaced the failure. 노트는 남아 있고(시각만 못 얹었다) 다음 bump 가
        // 진실을 그린다.
      }
    })();
  }, []);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "var(--space-4) 0 var(--space-5) var(--sidebar-pad)",
        gap: "var(--space-3)",
        position: "relative",
      }}
      data-testid="view-calendar"
    >
      <PendingIndicator active={showGridPending} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", paddingRight: "var(--sidebar-pad)" }}>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          title={t("search.calendar_prev_month")}
          aria-label={t("search.calendar_prev_month")}
          onClick={() => navMonth(-1)}
        >
          <IconCaret dir="left" size={14} />
        </button>
        <span
          style={{
            flex: 1,
            textAlign: "center",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "var(--text-sm)",
          }}
        >
          {monthLabel}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          title={t("search.calendar_next_month")}
          aria-label={t("search.calendar_next_month")}
          onClick={() => navMonth(1)}
        >
          <IconCaret dir="right" size={14} />
        </button>
      </div>
      {(viewYear !== today.year || viewMonth !== today.month) && (
        <button
          type="button"
          onClick={goToday}
          style={{
            alignSelf: "center",
            border: "none",
            background: "none",
            padding: 0,
            paddingRight: "var(--sidebar-pad)",
            font: "inherit",
            fontSize: "var(--text-xs)",
            color: "var(--muted)",
            cursor: "pointer",
            textDecoration: "underline",
            textUnderlineOffset: 2,
            marginTop: "calc(-1 * var(--space-2))",
          }}
        >
          {t("search.calendar_today")}
        </button>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "var(--space-2xs)", paddingRight: "var(--sidebar-pad)" }}>
        {weekdayLabels.map((label, i) => (
          <div
            key={i}
            style={{
              textAlign: "center",
              fontSize: "var(--text-2xs)",
              color: toneColor(headerTone(i, weekStart), "var(--faint)"),
              fontWeight: 600,
            }}
          >
            {label}
          </div>
        ))}
        {cells.map((cell, i) => (
          <CalendarDayCell
            key={i}
            cell={cell}
            count={cell.day ? counts[cell.day] ?? 0 : 0}
            maxCount={maxCount}
            isToday={cell.day === todayIso}
            isSelected={cell.day !== null && cell.day === selectedDay}
            isDragHl={isDragHighlighted(cell.day)}
            onPick={onPickDay}
            onPointerDownDay={onCellPointerDown}
            onPointerEnterDay={onCellPointerEnter}
            forecastByDay={forecastByDay}
            holidays={holidays}
          />
        ))}
      </div>
      {/* D1 — 탭 스트립. AiHistoryPanel 의 tablist 관용구 그대로. */}
      <div
        role="tablist"
        data-testid="calendar-tabs"
        style={{
          display: "flex",
          borderBottom: "1px solid var(--divider)",
          flex: "none",
          marginRight: "var(--sidebar-pad)",
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "today"}
          data-testid="calendar-tab-today"
          onClick={() => setTab("today")}
          style={tabBtnStyle(tab === "today")}
        >
          {t("search.calendar_tab_today")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "month"}
          data-testid="calendar-tab-month"
          onClick={() => setTab("month")}
          style={tabBtnStyle(tab === "month")}
        >
          {t("search.calendar_tab_month")}
        </button>
      </div>
      {tab === "today" ? (
        // D2 — 오늘 할 일. 본체(DayDetailBody)는 폭을 안 정하니 이 칼럼이 준다. 오너 요청
        // (2026-09-16)으로 옛 "이 날의 기록" 형제 섹션은 없앴다 — 이 칼럼이 구르는 것은 본체 안의
        // 시간축 스크롤러 하나뿐이다.
        <div
          data-testid="calendar-today-pane"
          style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}
        >
          <PendingIndicator active={showListPending} />
          <div
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              paddingRight: "var(--sidebar-pad)",
            }}
          >
            <DayDetailBody
              selectedDay={day}
              monthLabel={monthLabel}
              holidayName={holidays.get(day) ?? null}
              markLabel={dayLabels.get(day) ?? null}
              forecast={forecast}
              detailNotes={detailNotes}
              onOpen={onOpenNote}
              onCreateTimedNote={onCreateTimedNote}
              // PLAN-2026-10-10 W-E (D5) — 날짜·날씨·현재 시각 한 줄 + 시간축이 높이를 거의 다
              // 갖는 압축 변형. 대시보드 우측 패널(DayDetailPanel)은 안 넘긴다.
              compact
            />
          </div>
        </div>
      ) : (
        // D3 — 월간 일정. selectedDay 무시 — 항상 보는 달의 알림 목록.
        <div
          className="scroll scroll--slim"
          data-testid="calendar-month-pane"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative" }}
        >
          <PendingIndicator active={showListPending} />
          {monthReminders.length === 0 && !calLoading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--faint)",
                fontSize: "var(--text-sm)",
                textAlign: "center",
                padding: "var(--space-4)",
              }}
            >
              {t("search.calendar_empty_reminders")}
            </div>
          ) : (
            <CalendarNoteGroup
              label={t("search.calendar_month_reminders")}
              notes={monthReminders}
              activeId={activeId}
              onSelectNote={onOpenNote}
              onOpenCtx={onOpenCtx}
              loadTree={loadTree}
              selectNote={selectNote}
              query={query}
              showDateBadge
            />
          )}
        </div>
      )}
      <CreateRangePopover
        popover={popover}
        createdNoteId={pendingNoteId}
        creating={creatingRange}
        onConfirmCreate={onConfirmCreateRange}
        onClosePopover={closePopover}
      />
    </div>
  );
}

/** AiHistoryPanel.tsx 의 tabBtnStyle 과 같은 모양(그 파일은 export 하지 않는다).
 *  ponytail: 두 사본 — 세 번째 사용처가 생기면 공용 파일로 올린다. 패딩만 사이드바 폭에 맞춰 한 단 작다. */
function tabBtnStyle(on: boolean): CSSProperties {
  return {
    flex: "none",
    padding: "var(--space-2) var(--space-4)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    background: on ? "var(--sel)" : "transparent",
    color: on ? "var(--accent)" : "var(--muted)",
    border: "none",
    boxShadow: on ? "inset 0 -2px 0 var(--accent)" : undefined,
  };
}

/* Vertically-stacked group under a day pick: "created that day" then "updated that day" (the
   latter already excludes anything in the former — see the dedupe in the fetch effect above).
   Renders nothing when empty rather than an empty labeled section. */
function CalendarNoteGroup({
  label,
  notes,
  activeId,
  onSelectNote,
  onOpenCtx,
  loadTree,
  selectNote,
  query,
  showDateBadge,
}: {
  label: string;
  notes: NoteSummary[];
  activeId: string | null;
  onSelectNote: (id: string) => void;
  onOpenCtx: (id: string, x: number, y: number) => void;
  loadTree?: () => Promise<void>;
  selectNote?: (id: string) => Promise<void>;
  query?: string;
  showDateBadge?: boolean;
}) {
  if (notes.length === 0) return null;
  return (
    <div style={{ marginBottom: "var(--space-2)" }}>
      <div
        style={{
          padding: "var(--space-2) var(--sidebar-pad) var(--space-1) var(--space-3)",
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          color: "var(--faint)",
          textTransform: "uppercase",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
          {notes.length}
        </span>
      </div>
      {notes.map((n) => (
        <CalendarNoteRow
          key={n.id}
          note={n}
          isSelected={n.id === activeId}
          onSelectNote={onSelectNote}
          onOpenCtx={onOpenCtx}
          loadTree={loadTree}
          selectNote={selectNote}
          query={query}
          showDateBadge={showDateBadge}
        />
      ))}
    </div>
  );
}

function CalendarDayCell({
  cell,
  count,
  maxCount,
  isToday,
  isSelected,
  isDragHl,
  onPick,
  onPointerDownDay,
  onPointerEnterDay,
  forecastByDay,
  holidays,
}: {
  cell: CalendarCell;
  count: number;
  maxCount: number;
  isToday: boolean;
  isSelected: boolean;
  /** 대시보드 월 그리드와 같은 드래그 하이라이트(§ MonthGrid.tsx DayCell) — 클릭/드래그 판정은
   *  onPointerDownDay 가 쥔 useCalendarDrag 세션이 한다. */
  isDragHl: boolean;
  /** 키보드 활성화(Enter/Space)만 여기로 온다 — 포인터 클릭/드래그는 onPointerDownDay 가 이미
   *  판정해 순수 클릭이면 이 함수를 직접 부른다(useCalendarDrag.onCellPointerDown). */
  onPick: (day: string) => void;
  onPointerDownDay: (day: string, e: React.PointerEvent) => void;
  onPointerEnterDay: (day: string) => void;
  forecastByDay: Map<string, { code: number; max: number; min: number }> | null;
  holidays: ReadonlyMap<string, string>;
}) {
  if (cell.day === null) return <div />;
  const tone = dayTone(cell.day, holidays);
  const holidayName = holidays.get(cell.day);
  const dayForecast = cell.day && forecastByDay ? (forecastByDay.get(cell.day) ?? null) : null;
  const visual = dayForecast ? weatherCodeToVisual(dayForecast.code, dayForecast.max) : null;
  const weatherTitle = dayForecast
    ? `${t(weatherLabelKey(dayForecast.code))} ${Math.round(dayForecast.max)}°/${Math.round(dayForecast.min)}°`
    : undefined;
  // Compose title parts in existing precedence (weather · count), holiday name leads since it's
  // the most identifying fact about the day.
  const titleParts = [
    holidayName,
    weatherTitle,
    count > 0 ? t("search.calendar_day_count", { count }) : undefined,
  ].filter((p): p is string => Boolean(p));

  return (
    <button
      type="button"
      data-testid={`calendar-day-${cell.day}`}
      aria-pressed={isSelected}
      onPointerDown={(e) => cell.day && onPointerDownDay(cell.day, e)}
      onPointerEnter={() => cell.day && onPointerEnterDay(cell.day)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && cell.day) {
          e.preventDefault();
          onPick(cell.day);
        }
      }}
      title={titleParts.length > 0 ? titleParts.join(" · ") : undefined}
      style={{
        aspectRatio: "1",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        border: isSelected ? "1px solid var(--accent)" : "1px solid transparent",
        borderRadius: "var(--radius-sm)",
        background:
          isDragHl || isSelected
            ? "color-mix(in srgb,var(--accent) 18%,transparent)"
            : (recordTint(count, maxCount) ?? "transparent"),
        fontSize: "var(--text-xs)",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "relative",
          zIndex: 1,
          color: toneColor(tone, "var(--text)"),
          fontWeight: isToday ? 600 : 400,
          ...(isToday
            ? {
                background: "var(--sel)",
                boxShadow: "inset 0 0 0 1px var(--accent)",
                borderRadius: "var(--radius-pill)",
                padding: "0 var(--space-1)",
              }
            : null),
        }}
      >
        {cell.dayOfMonth}
      </span>
      {visual && (
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            pointerEvents: "none",
            lineHeight: 0,
            opacity: 0.9,
          }}
        >
          <visual.Icon size={11} strokeWidth={1.8} style={{ color: visual.colorVar }} />
        </span>
      )}
    </button>
  );
}

function CalendarNoteRow({
  note,
  isSelected,
  onSelectNote,
  onOpenCtx,
  loadTree,
  selectNote,
  query,
  showDateBadge,
}: {
  note: NoteSummary;
  isSelected: boolean;
  onSelectNote: (id: string) => void;
  onOpenCtx: (id: string, x: number, y: number) => void;
  loadTree?: () => Promise<void>;
  selectNote?: (id: string) => Promise<void>;
  query?: string;
  showDateBadge?: boolean;
}) {
  const titleText = displayTitle(note.title);
  const titleSegments = splitByQuery(titleText, query ?? "");

  let dateBadgeText: string | null = null;
  if (showDateBadge && note.day !== null && note.day !== undefined) {
    dateBadgeText = `${note.day}일`;
    if (note.start_time) {
      dateBadgeText += ` ${note.start_time}`;
    }
  }

  return (
    <button
      type="button"
      className="treerow menu-row menu-item"
      data-selected={isSelected}
      data-note-id={note.id}
      onPointerDown={(e) => startNoteDrag(e, note.id, titleText, { pin: true })}
      onClick={() => onSelectNote(note.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenCtx(note.id, e.clientX, e.clientY);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        minHeight: 32,
        boxSizing: "border-box",
        position: "relative",
        padding: "var(--space-1) var(--sidebar-pad) var(--space-1) var(--space-3)",
        boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : undefined,
        background: isSelected ? "var(--sel)" : undefined,
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        borderRadius: "var(--radius-sm)",
      }}
    >
      {/* 인터랙티브 노트 아이콘 */}
      {loadTree && selectNote ? (
        <NoteIconControl
          noteId={note.id}
          icon={note.icon}
          size={15}
          loadTree={loadTree}
          selectNote={selectNote}
          activeNoteId={isSelected ? note.id : null}
        />
      ) : (
        <NoteIcon icon={note.icon} size={15} />
      )}

      {/* 노트 제목: 트리/타임라인과 동일한 스타일 */}
      <span
        style={{
          fontSize: "var(--text-sm)",
          fontWeight: 400,
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: isSelected ? "var(--accent)" : "var(--text)",
        }}
      >
        <HighlightedText segments={titleSegments} />
      </span>

      {/* 알림 배지 (remind 플래그 활성 시 벨 아이콘) */}
      {note.remind && <RemindBadge size={11} noteId={note.id} />}

      {/* 날짜/시간 배지 (미선택 상태에서 해당 월 알림 목록일 때) */}
      {dateBadgeText && (
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--muted)",
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {dateBadgeText}
        </span>
      )}

      {/* 트리 행 배지: 상태 점, 즐겨찾기 별, 내보내기 아이콘 */}
      <TreeRowBadges
        exportedAt={note.exported_at}
        isFavorite={note.is_favorite}
        status={note.status}
        hasImage={note.has_image}
        tagNames={note.tag_names}
      />
    </button>
  );
}
