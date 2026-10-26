/**
 * Calendar month grid (weekday header + day cells) — extracted from CalendarTab (pure move,
 * same behavior). Month grid math reuses leftpanel calendarGrid (Sunday-first UTC YMD).
 *
 * Record axis dots + hover quick-create "+" (dashboard QA cleanup — see CalendarTab.tsx header
 * comment for the record-axis data source). The "+" reveal uses a scoped <style> (one instance
 * for the whole grid, not per cell) mirroring PhraseRow's hover-reveal pattern rather than a
 * per-cell hover state — plain CSS, no re-renders.
 */
import { memo, useMemo } from "react";
import type { CalendarItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { IconPlus } from "../../icons";
import type { CalendarCell } from "../../leftpanel/expanded/calendarGrid";
import {
  buildMonthDayPlans,
  itemKey,
  spanTrackKey,
  type CellLine,
  type DayCellPlan,
} from "../calendarLayout";
import { weatherCodeToVisual, weatherLabelKey, weatherTempColorVar, type DailyForecast } from "../../../lib/weather";
import { forecastDayMap } from "./useMonthForecast";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { folderColorCss } from "../../../lib/ui";
import { RemindBadge } from "./RemindBadge";
import { dayTone, headerTone, toneColor, recordTint } from "../../../lib/calendarDay";

/** Per-day precomputed span tracks + visible-line plan — see the dayPlans useMemo below. */
type DayPlan = DayCellPlan & { trackOf: Map<string, number> };

export function MonthGrid({
  weekdayLabels,
  cells,
  items,
  recordCounts,
  todayIso,
  selectedDay,
  isDragHighlighted,
  onCellPointerDown,
  onCellPointerEnter,
  onPick,
  onQuickCreate,
  onOpenNote,
  onContextMenuDay,
  forecast,
  weekStart = "sunday",
  searchHits = null,
  folderFilter = null,
  focusedNoteId = null,
  onFocusNote = () => {},
  holidays = null,
  dayLabels = null,
}: {
  weekdayLabels: string[];
  cells: CalendarCell[];
  items: CalendarItem[];
  /** ISO day → created/updated note count (note_record_histogram). Drives the record dot and,
   *  on days with no visible items, a faint density tint (2026-09-08 heatmap pass). */
  recordCounts: Map<string, number>;
  todayIso: string;
  selectedDay: string | null;
  isDragHighlighted: (day: string | null) => boolean;
  onCellPointerDown: (day: string, e: React.PointerEvent) => void;
  onCellPointerEnter: (day: string) => void;
  onPick: (day: string) => void;
  onQuickCreate: (day: string) => void;
  onOpenNote: (noteId: string) => void;
  /** Right-click a day → AI schedule prompt (Wave 3 L2). Optional so tests can omit it. */
  onContextMenuDay?: (day: string, e: React.MouseEvent) => void;
  /** Single-click focus (map view pattern) — id of the currently focused note, or null. Optional
   *  (defaults to no-op) so tests that only exercise open/select don't need to wire it up. */
  focusedNoteId?: string | null;
  onFocusNote?: (noteId: string) => void;
  /** 16-day forecast for the resolved weather location, or null when unavailable/not fetched
   *  (offline, no location, or the viewed month doesn't intersect the forecast window). */
  forecast: DailyForecast | null;
  weekStart?: "sunday" | "monday";
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  /** ISO day → holiday name (lib/holidays.ts, per the holiday_region setting). Null = off. */
  holidays?: ReadonlyMap<string, string> | null;
  /** 빨간 날이 아닌 기념일 이름표(결혼기념일 등) — lib/calendarDay::useDayMarkMaps().labels. */
  dayLabels?: ReadonlyMap<string, string> | null;
}) {
  const folders = useNotesStore((s) => s.folders);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  // Chunk into weeks (buildCalendarGrid always pads to a multiple of 7) so span tracks can be
  // assigned once per week (calendarLayout.assignWeekSpanTracks) — a note's track must stay the
  // same across every day it covers within a week, or the bar visually kinks (see MonthGrid
  // header comment / dashboard/5bc2be60-integrate QA).
  const weeks = useMemo(() => {
    const list: CalendarCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) list.push(cells.slice(i, i + 7));
    return list;
  }, [cells]);

  // Dashboard audit P2 #5: track assignment + per-day line plans used to be recomputed on every
  // MonthGrid render — including a drag's per-cell highlight flips, which re-render this
  // component on every pointer move. Neither items nor cells change during a drag, so precompute
  // once here using buildMonthDayPlans with indexed day lookups (only re-runs when the month's
  // data actually changes).
  const dayPlans = useMemo(() => buildMonthDayPlans(cells, items), [items, cells]);

  // Record density is relative to the busiest day of the viewed month (same normalisation the
  // sidebar CalendarExpanded uses), so a quiet month still shows its own contour.
  const maxRecordCount = useMemo(() => {
    let max = 0;
    for (const cell of cells) if (cell.day !== null) max = Math.max(max, recordCounts.get(cell.day) ?? 0);
    return max;
  }, [cells, recordCounts]);

  // Fast O(1) indexed map for forecast lookups across day cells (useMonthForecast 의 같은 한 벌).
  const forecastByDay = useMemo(() => forecastDayMap(forecast), [forecast]);

  return (
    <div
      data-testid="cal-grid"
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        // Explicit row 1 (the weekday header) sizes to its own content; every row after that is
        // auto-generated (the week rows) and shares the remaining height via gridAutoRows — was
        // missing before, so the header row stretched to the same 1fr as a week row.
        gridTemplateRows: "auto",
        gridAutoRows: "minmax(0, 1fr)",
        borderTop: "1px solid var(--line)",
        borderLeft: "1px solid var(--line)",
        userSelect: "none",
      }}
    >
      <style>{`
        .home-cal-add{opacity:0;transition:opacity var(--dur-fast) ease}
        .home-cal-day:hover .home-cal-add{opacity:1}
        .home-cal-weather{opacity:1;transition:opacity var(--dur-fast) ease}
        .home-cal-day:hover .home-cal-weather{opacity:0}
        /* Today: a whole-cell tint well below the event chip's --hover (8% accent) so chips
           still read against it, plus a small filled pill around the day number (--sel, 20%
           accent — the same token used for selection) ringed with a hairline for definition.
           Neither reuses solid --accent, so "today" stays distinct from the span bars. */
        .home-cal-day[data-today="true"]{background:color-mix(in srgb, var(--accent) 4%, transparent)}
        .home-cal-day[data-today="true"] .home-cal-daynum{
          background:var(--sel);
          box-shadow:inset 0 0 0 1px var(--accent);
          border-radius:999px;
          padding:0 5px;
        }
        .home-cal-event:hover{background:var(--sel)}
      `}</style>
      {weekdayLabels.map((label, i) => {
        const headerColor = toneColor(headerTone(i, weekStart), "var(--faint)");
        return (
          <div
            key={`dow-${i}`}
            style={{
              // W16: 오너 실기 지적("달력 테이블 글자가 과하다") — 타입 스케일 정확히 두 칸
              // 상향(label→sm). 다른 자리와 똑같이 +2 만큼만 옮겨야 산수만으로 원래 위계가
              // 그대로 보존된다(md 로 가면 이 자리만 +3 이 돼 위계 계산이 어긋난다).
              fontSize: "var(--text-sm)",
              color: headerColor,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              padding: "var(--space-2) var(--space-3)",
              borderRight: "1px solid var(--line)",
              borderBottom: "1px solid var(--line)",
              fontWeight: 600,
            }}
          >
            {label}
          </div>
        );
      })}
      {weeks.map((week, wi) =>
        week.map((cell, di) => (
          <DayCell
            key={wi * 7 + di}
            cell={cell}
            plan={cell.day !== null ? (dayPlans.get(cell.day) ?? null) : null}
            recordCount={cell.day !== null ? (recordCounts.get(cell.day) ?? 0) : 0}
            maxRecordCount={maxRecordCount}
            isToday={cell.day === todayIso}
            isSelected={cell.day !== null && cell.day === selectedDay}
            isDragHl={isDragHighlighted(cell.day)}
            onPointerDownDay={onCellPointerDown}
            onPointerEnterDay={onCellPointerEnter}
            onPick={onPick}
            onQuickCreate={onQuickCreate}
            onOpenNote={onOpenNote}
            onContextMenuDay={onContextMenuDay}
            forecastByDay={forecastByDay}
            searchHits={searchHits}
            folderFilter={folderFilter}
            folderById={folderById}
            focusedNoteId={focusedNoteId}
            onFocusNote={onFocusNote}
            holidayName={cell.day !== null ? (holidays?.get(cell.day) ?? null) : null}
            markLabel={cell.day !== null ? (dayLabels?.get(cell.day) ?? null) : null}
          />
        )),
      )}
    </div>
  );
}

/**
 * Memoized: during a drag, only the 1–2 cells whose isDragHl/isSelected actually flip need to
 * re-render — `plan` is the same Map entry (stable reference, see the dayPlans useMemo above)
 * across every render until the month's items/cells actually change, so every other cell bails
 * out of the shallow-prop comparison for free (dashboard audit P2 #5).
 */
const DayCell = memo(function DayCell({
  cell,
  plan,
  recordCount,
  maxRecordCount,
  isToday,
  isSelected,
  isDragHl,
  onPointerDownDay,
  onPointerEnterDay,
  onPick,
  onQuickCreate,
  onOpenNote,
  onContextMenuDay,
  forecastByDay,
  searchHits = null,
  folderFilter = null,
  folderById,
  focusedNoteId = null,
  onFocusNote,
  holidayName = null,
  markLabel = null,
}: {
  cell: CalendarCell;
  plan: DayPlan | null;
  recordCount: number;
  maxRecordCount: number;
  isToday: boolean;
  isSelected: boolean;
  isDragHl: boolean;
  onPointerDownDay: (day: string, e: React.PointerEvent) => void;
  onPointerEnterDay: (day: string) => void;
  onPick: (day: string) => void;
  onQuickCreate: (day: string) => void;
  onOpenNote: (noteId: string) => void;
  onContextMenuDay?: (day: string, e: React.MouseEvent) => void;
  forecastByDay: Map<string, { code: number; max: number; min: number }> | null;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  folderById: Map<string, { color_hue: number | null }>;
  focusedNoteId?: string | null;
  onFocusNote: (noteId: string) => void;
  holidayName?: string | null;
  markLabel?: string | null;
}) {
  if (cell.day === null || plan === null) {
    return (
      <div
        style={{
          borderRight: "1px solid var(--line)",
          borderBottom: "1px solid var(--line)",
          background: "transparent",
          opacity: 0.35,
        }}
        aria-hidden
      />
    );
  }

  // Spans render in a CSS grid keyed by their week track (gridRow) rather than count of items —
  // an unoccupied lower track still reserves its row (see the spans-area grid below), so a bar's
  // vertical slot never shifts as siblings enter/leave the day. Spans + events share ONE
  // MAX_CELL_LINES budget (planDayCell) — a span past the budget is hidden (keyed by the
  // week-stable trackOf map, so it's hidden consistently across every day it covers), and hidden
  // spans + hidden events fold into a single "+n" overflow count.
  const day = cell.day;
  const { visibleSpans, visibleEvents, overflow, trackOf } = plan;
  const hasRecord = recordCount > 0;
  // Density tint (2026-09-08, ladder shared via lib/calendarDay's recordTint — same 8-38% accent
  // range the sidebar CalendarExpanded uses): only on days that show no chips — a tint under
  // chips is noise, and the dot already marks the axis. Wins over the CSS today-tint (a lighter
  // 4% floor) — today keeps its day-number pill, so nothing is lost.
  const tint = visibleSpans.length === 0 && visibleEvents.length === 0 ? recordTint(recordCount, maxRecordCount) : null;

  // Fast O(1) Map lookup against daily forecast (already indexed)
  const dayForecast = forecastByDay ? (forecastByDay.get(day) ?? null) : null;
  const visual = dayForecast ? weatherCodeToVisual(dayForecast.code, dayForecast.max) : null;
  const weatherTitle = dayForecast
    ? `${t(weatherLabelKey(dayForecast.code))} ${Math.round(dayForecast.max)}°/${Math.round(dayForecast.min)}°`
    : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      className="home-cal-day"
      data-testid={`home-cal-day-${day}`}
      data-day={day}
      data-today={isToday ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      data-drag-hl={isDragHl ? "true" : undefined}
      data-holiday={holidayName ? "true" : undefined}
      data-record-density={tint ?? undefined}
      // The icon itself is pointer-events:none (must not block the "+" quick-create hit area or
      // the cell's own drag-create), so its title can never fire a native tooltip — put it here
      // instead. Span bars / event chips below still win their own title when hovered directly
      // (nearest ancestor-or-self title wins), this is just the fallback for the cell's blank
      // space.
      title={weatherTitle}
      onPointerDown={(e) => onPointerDownDay(day, e)}
      onPointerEnter={() => onPointerEnterDay(day)}
      onContextMenu={(e) => {
        if (!onContextMenuDay) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenuDay(day, e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(day);
        }
      }}
      style={{
        borderRight: "1px solid var(--line)",
        borderBottom: "1px solid var(--line)",
        // No horizontal padding here — the spans area below needs to bleed to the cell's true
        // left/right edges for a period bar to look continuous across day cells (only the day
        // number row and the events area re-add it, see their own wrappers).
        // ponytail: trimmed from space-2 to space-1 (dashboard/5bc2be60 QA item 7) — a full 3
        // visible spans + the "+n" overflow chip is tight in a 6-week month; this buys back a
        // few px without touching the cap logic. Not independently visually verified against the
        // running app (no screenshot tool for the Tauri webview in this session) — if the "+n"
        // chip still clips in a busy 6-week month, that's the next thing to check.
        padding: "var(--space-1) 0",
        position: "relative",
        overflow: "hidden",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2xs)",
        minHeight: 0,
        // Selected/drag-highlight win when set (opaque --sel fill). Otherwise leave background
        // undefined — NOT "transparent" — so the CSS [data-today="true"] rule above (a much
        // lighter 4% tint, see the scoped <style>) can paint through on today's cell.
        background: isDragHl || isSelected ? "var(--sel)" : (tint ?? undefined),
      }}
    >
      {visual && (
        <span
          className="home-cal-weather"
          data-testid={`home-cal-weather-${day}`}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: "var(--space-2xs)",
            pointerEvents: "none",
            lineHeight: 0,
          }}
        >
          <visual.Icon size={14} strokeWidth={1.8} style={{ color: visual.colorVar }} />
          {dayForecast && typeof dayForecast.max === "number" && (
            <span
              style={{
                // W16: 2xs→xs (두 칸 상향). 절대배치 오버레이(top/right)라 셀 플로우 높이엔 영향 없음.
                fontSize: "var(--text-xs)",
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                color: weatherTempColorVar(dayForecast.max, dayForecast.min),
              }}
            >
              {Math.round(dayForecast.max)}°
            </span>
          )}
        </span>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flex: "none",
          padding: "0 var(--space-3)",
        }}
      >
        {(() => {
          // A public holiday reads like a Sunday (red number) — the name follows as a small label.
          const tone = holidayName ? "sun" : dayTone(day);
          const daynumColor = toneColor(tone, isToday ? "var(--ink)" : "var(--faint)");
          return (
            <span
              className="home-cal-daynum"
              style={{
                // W16: 날짜 숫자 — xs→md, 정확히 두 칸 상향. 다른 여섯 자리가 전부 +2 만큼만
                // 옮겨졌으므로 이 자리도 +2 여야 원래 위계(날짜 숫자가 나머지보다 크다)가
                // 산수만으로 그대로 유지된다 — 임의로 더 키우면 그 전제가 깨진다.
                fontSize: "var(--text-md)",
                color: daynumColor,
                fontWeight: isToday ? 600 : 400,
              }}
            >
              {cell.dayOfMonth}
            </span>
          );
        })()}
        {holidayName && (
          <span
            data-testid={`home-cal-holiday-${day}`}
            style={{
              // W16: 공휴일명도 "테이블 글자" — 2xs→xs (두 칸 상향).
              fontSize: "var(--text-xs)",
              color: "var(--danger)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {holidayName}
          </span>
        )}
        {markLabel && (
          <span
            data-testid={`home-cal-mark-${day}`}
            style={{
              // 기념일 이름표(PLAN-2026-09-19-calendar-schedule) — 빨간 날이 아니라 칠하지 않고 강조색 글자만.
              fontSize: "var(--text-xs)",
              color: "var(--accent)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {markLabel}
          </span>
        )}
        {hasRecord && (
          <span
            aria-hidden="true"
            data-testid={`home-cal-record-${day}`}
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--faint)",
            }}
          />
        )}
        <button
          type="button"
          className="home-cal-add"
          data-testid={`home-cal-add-${day}`}
          title={t("home.cal_quick_create")}
          aria-label={t("home.cal_quick_create")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onQuickCreate(day);
          }}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            border: "none",
            background: "transparent",
            color: "var(--muted)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <IconPlus size={12} strokeWidth={2} />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2xs)",
          overflow: "hidden",
        }}
      >
        {visibleSpans.length > 0 && (
          <div
            data-testid={`home-cal-spans-${day}`}
            style={{
              flex: "none",
              display: "grid",
              gridTemplateColumns: "1fr",
              gridAutoRows: 14,
              rowGap: "var(--space-2xs)",
            }}
          >
            {visibleSpans.map((line) => (
              <SpanBarView
                // itemKey, not note_id: a repeating note can put several occurrences on one day
                // (a multi-day occurrence overlapping the next one), and those share a note_id.
                key={itemKey(line.item)}
                line={line}
                day={day}
                track={
                  trackOf.get(spanTrackKey(line.item)) ??
                  trackOf.get(line.item.date_id) ??
                  trackOf.get(line.item.note_id) ??
                  0
                }
                onFocus={onFocusNote}
                onOpen={onOpenNote}
                focusedNoteId={focusedNoteId}
                searchHits={searchHits}
                folderFilter={folderFilter}
                folderById={folderById}
              />
            ))}
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2xs)",
            minHeight: 0,
            overflow: "hidden",
            padding: "0 var(--space-3)",
          }}
        >
          {visibleEvents.map((line) => (
            <CellLineView
              key={itemKey(line.item)}
              line={line}
              onFocus={onFocusNote}
              onOpen={onOpenNote}
              focusedNoteId={focusedNoteId}
              searchHits={searchHits}
              folderFilter={folderFilter}
              folderById={folderById}
            />
          ))}
          {overflow > 0 && (
            <span
              data-testid={`home-cal-overflow-${day}`}
              style={{
                // W16: "+n" 오버플로우 뱃지 — 2xs→xs (두 칸 상향).
                fontSize: "var(--text-xs)",
                color: "var(--faint)",
                fontWeight: 600,
              }}
            >
              {t("home.cal_overflow", { n: overflow })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * One period-span bar. Placed at `gridRow: track+1` in the spans-area grid above so its
 * vertical slot is stable across the day cells it spans — an unoccupied lower track still
 * reserves its row height, CSS Grid implicit-row sizing does that for free, no placeholder DOM
 * nodes needed. Click opens the note (same onOpen path DayDetailPanel uses); it stops
 * propagation so the day cell underneath doesn't also see the pointerdown and start a
 * drag-create / toggle its own detail-panel selection — the span wins over the cell.
 */
function SpanBarView({
  line,
  day,
  track,
  onFocus,
  onOpen,
  focusedNoteId = null,
  searchHits,
  folderFilter = null,
  folderById,
}: {
  line: Extract<CellLine, { kind: "span" }>;
  day: string;
  track: number;
  /** Single-click focus (map view pattern) — box-shadow underline in place, never opens. */
  onFocus: (noteId: string) => void;
  /** Double-click — opens the note tab. */
  onOpen: (noteId: string) => void;
  /** id of the currently focused note (or null) — needed (not just "is this one focused") to
   *  tell "nothing focused" apart from "something else is focused" for the opacity ladder below. */
  focusedNoteId?: string | null;
  // Always supplied by DayCell (from MonthGrid's own searchHits prop) — dashboard audit P2 #5:
  // this used to fall back to its own useDashboardSearchHits() subscription when the prop was
  // null, which is every render with no active search, i.e. almost always a wasted subscription.
  searchHits: Set<string> | null;
  folderFilter?: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
}) {
  const dim =
    (searchHits !== null && !searchHits.has(line.item.note_id)) ||
    (folderFilter !== null && line.item.folder_id !== folderFilter);
  const focused = focusedNoteId === line.item.note_id;
  const folder = folderById?.get(line.item.folder_id);
  const color = folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--accent)";
  const showTitle = line.showTitle;
  const radius =
    line.role === "single"
      ? "7px"
      : line.role === "st"
        ? "7px 0 0 7px"
        : line.role === "en"
          ? "0 7px 7px 0"
          : "0";
  return (
    <div
      data-kind="span"
      data-role={line.role}
      data-testid={`home-cal-span-${line.item.note_id}-${day}`}
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      title={displayTitle(line.item.title)}
      onPointerDown={(e) => e.stopPropagation()}
      // Single click focuses; double click opens (map view pattern). Both stop propagation so
      // the day cell underneath doesn't also see them (span wins — same rule as the pointerdown
      // stop above).
      onClick={(e) => {
        e.stopPropagation();
        onFocus(line.item.note_id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen(line.item.note_id);
      }}
      style={{
        gridRow: track + 1,
        // W16: 바 높이(14px)/lineHeight(14px)는 고정값 그대로 둔다 — 11px 폰트(xs)는 14px
        // 라인박스 안에 여유 있게 들어간다(글리프 높이 < 라인박스). 2xs→xs (두 칸 상향).
        height: 14,
        fontSize: "var(--text-xs)",
        color: "var(--on-accent)",
        background: color,
        // 필터링(dim)이 포커스보다 우선한다 — "이건 결과가 아니다"라는 배제는 "지금 이걸 본다"는
        // 강조보다 세야 한다. 포커스 없음/남의 포커스/내 포커스 세 단은 그다음 우선순위.
        opacity: dim ? 0.35 : focused ? 1 : focusedNoteId ? 0.5 : 0.82,
        padding: showTitle ? "0 6px" : 0,
        lineHeight: "14px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        borderRadius: radius,
        marginLeft: line.role === "st" || line.role === "single" ? 2 : 0,
        marginRight: line.role === "en" || line.role === "single" ? 2 : 0,
        cursor: "pointer",
        // outline 대신 밑줄: outline은 셀 잘림(overflow:hidden)에 걸리고, 폴더색으로 이미 꽉 찬
        // 칩 위에 다른 색 테두리를 두르면 이중 테두리로 읽힌다. inset box-shadow는 상자 안에
        // 그려져 잘리지 않고 borderRadius를 따라간다.
        boxShadow: focused ? "inset 0 -2px 0 var(--accent)" : undefined,
      }}
    >
      {showTitle ? (
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2xs)", minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {displayTitle(line.item.title)}
          </span>
          {line.item.remind && <RemindBadge size={9} noteId={line.item.note_id} />}
        </span>
      ) : (
        " "
      )}
    </div>
  );
}

function CellLineView({
  line,
  onFocus,
  onOpen,
  focusedNoteId = null,
  searchHits,
  folderFilter = null,
  folderById,
}: {
  line: Extract<CellLine, { kind: "event" }>;
  /** Single-click focus (map view pattern) — box-shadow underline in place, never opens. */
  onFocus: (noteId: string) => void;
  /** Double-click — opens the note tab. */
  onOpen: (noteId: string) => void;
  /** See SpanBarView's focusedNoteId comment. */
  focusedNoteId?: string | null;
  // See SpanBarView's searchHits comment — always supplied by DayCell now.
  searchHits: Set<string> | null;
  folderFilter?: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
}) {
  const dim =
    (searchHits !== null && !searchHits.has(line.item.note_id)) ||
    (folderFilter !== null && line.item.folder_id !== folderFilter);
  const focused = focusedNoteId === line.item.note_id;
  const folder = folderById?.get(line.item.folder_id);
  const color = folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--muted)";
  const text = displayTitle(line.item.title);
  // 2026-09-10 (§D4): 관련 날짜인지는 kind 가 아니라 position 이 말한다("extra" 은퇴).
  const isRelated = line.item.position !== 0;
  return (
    <div
      className="home-cal-event"
      data-kind={line.item.kind}
      data-testid={`home-cal-event-${line.item.note_id}`}
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      title={text}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(line.item.note_id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen(line.item.note_id);
      }}
      style={{
        // W16: 이벤트 칩 텍스트 — 2xs→xs (두 칸 상향). 이 줄은 고정 높이가 없어 자연스레
        // 늘어난다(패딩 1px 5px + 기본 line-height) — 셀은 flex/overflow:hidden 기반이라
        // 하드코딩 px 셀 높이는 없음(보고 참조).
        fontSize: "var(--text-xs)",
        color: "var(--muted)",
        background: "var(--hover)",
        // Related dates get a dashed outline instead of the solid pill so they read as a lighter,
        // secondary mark next to the note's own event/span chip — no new inline surface color.
        border: isRelated ? "1px dashed var(--divider)" : undefined,
        borderRadius: "var(--radius-xs)",
        padding: "1px 5px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 4,
        // SpanBarView와 같은 우선순위(필터 dim > 내 포커스 > 남의 포커스 > 기본).
        opacity: dim ? 0.35 : focused ? 1 : focusedNoteId ? 0.5 : 1,
        boxShadow: focused ? "inset 0 -2px 0 var(--accent)" : undefined,
      }}
    >
      <i
        style={{
          width: 6,
          height: 6,
          borderRadius: isRelated ? 1 : "50%",
          background: isRelated ? "transparent" : color,
          border: isRelated ? `1px solid ${color}` : undefined,
          flex: "none",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {text}
      </span>
      {line.item.remind && <RemindBadge size={9} noteId={line.item.note_id} />}
    </div>
  );
}
