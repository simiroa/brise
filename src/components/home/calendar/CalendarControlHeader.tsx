/**
 * Calendar control header bar — extracted from CalendarTab.
 *
 * One control grammar (2026-09-08 restyle): every multi-part control is a HeaderGroup — a
 * hairline `--divider` pill at `--ctrl-h-sm` whose children are separated by a vertical hairline.
 * Left = "move" cluster (‹ › group · title · today), right = "tools" cluster (month/year toggle ·
 * optional new-event · caller's rightSlot, e.g. the .ics import/export icon group). Only the right
 * cluster carries `marginLeft: auto`; nothing else floats on its own.
 */
import { memo } from "react";
import { t } from "../../../i18n/t";
import { IconCaret, IconPlus } from "../../icons";

export type CalendarViewMode = "month" | "year";

export interface CalendarControlHeaderProps {
  monthLabel: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onPrevYear?: () => void;
  onNextYear?: () => void;
  showToday?: boolean;
  onToday: () => void;
  loading?: boolean;
  onNewEvent?: () => void;
  /** Month ↔ year grid toggle. Also flips the prev/next button labels, since in year mode
   *  onPrevMonth/onNextMonth step a whole year (CalendarTab wires them that way). */
  viewMode?: CalendarViewMode;
  onViewModeChange?: (mode: CalendarViewMode) => void;
  rightSlot?: React.ReactNode;
}

/** Pill grouping sibling controls without square borders — uses line glow. Exported for CalendarTab's rightSlot. */
export function HeaderGroup({
  children,
  role,
  ariaLabel,
  testId,
}: {
  children: React.ReactNode;
  role?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div
      className="home-cal-hgroup"
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        boxSizing: "border-box",
        flex: "none",
      }}
    >
      {children}
    </div>
  );
}

/** Text item inside a HeaderGroup (segment). Line glow styling: transparent bg, glow accent when active. */
const segStyle = (on: boolean): React.CSSProperties => ({
  border: "none",
  background: "transparent",
  color: on ? "var(--accent)" : "var(--muted)",
  filter: on ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))" : "none",
  // check:type-scale ⓒ — `fontWeight:` 뒤엔 리터럴만. 삼항은 스크립트가 값을 못 읽어 거부한다.
  ...(on ? { fontWeight: 600 } : { fontWeight: 400 }),
  fontFamily: "inherit",
  fontSize: "var(--text-xs)",
  padding: "0 var(--space-2)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  transition: "color var(--dur-fast), filter var(--dur-fast)",
});

export const CalendarControlHeader = memo(function CalendarControlHeader({
  monthLabel,
  onPrevMonth,
  onNextMonth,
  onPrevYear,
  onNextYear,
  showToday = false,
  onToday,
  loading = false,
  onNewEvent,
  viewMode,
  onViewModeChange,
  rightSlot,
}: CalendarControlHeaderProps) {
  const yearly = viewMode === "year";
  const prevLabel = yearly ? t("home.cal_prev_year") : t("search.calendar_prev_month");
  const nextLabel = yearly ? t("home.cal_next_year") : t("search.calendar_next_month");
  return (
    <div
      data-testid="cal-control-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        paddingBottom: "var(--space-5)",
        flex: "none",
      }}
    >
      <style>{`
        .home-cal-hgroup > .icon-btn { height: var(--ctrl-h-sm); }
      `}</style>

      <HeaderGroup testId="cal-nav-group">
        {onPrevYear && (
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-testid="cal-prev-year"
            title={t("home.cal_prev_year")}
            aria-label={t("home.cal_prev_year")}
            onClick={onPrevYear}
          >
            <IconCaret dir="left" size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="cal-prev-month"
          title={prevLabel}
          aria-label={prevLabel}
          onClick={onPrevMonth}
        >
          <IconCaret dir="left" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="cal-next-month"
          title={nextLabel}
          aria-label={nextLabel}
          onClick={onNextMonth}
        >
          <IconCaret dir="right" size={14} />
        </button>
        {onNextYear && (
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-testid="cal-next-year"
            title={t("home.cal_next_year")}
            aria-label={t("home.cal_next_year")}
            onClick={onNextYear}
          >
            <IconCaret dir="right" size={14} />
          </button>
        )}
      </HeaderGroup>

      <span
        data-testid="cal-month-label"
        style={{
          fontSize: "var(--text-xl)",
          fontWeight: 600,
          fontFamily: "var(--font-heading)",
          marginLeft: "var(--space-2)",
        }}
      >
        {monthLabel}
      </span>

      {showToday && (
        <button
          type="button"
          data-testid="cal-today"
          onClick={onToday}
          style={{
            border: "none",
            background: "none",
            padding: "0 var(--space-2)",
            font: "inherit",
            fontSize: "var(--text-xs)",
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          {t("search.calendar_today")}
        </button>
      )}

      {loading && (
        <span
          data-testid="cal-loading-indicator"
          style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}
        >
          …
        </span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginLeft: "auto" }}>
        {viewMode && onViewModeChange && (
          <HeaderGroup role="radiogroup" testId="cal-view-toggle">
            {(["month", "year"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={viewMode === mode}
                data-testid={`cal-view-${mode}`}
                onClick={() => onViewModeChange(mode)}
                style={segStyle(viewMode === mode)}
              >
                {t(mode === "month" ? "home.cal_view_month" : "home.cal_view_year")}
              </button>
            ))}
          </HeaderGroup>
        )}

        {onNewEvent && (
          <button
            type="button"
            data-testid="cal-new-event-btn"
            className="icon-btn icon-btn--sm icon-btn--glow"
            title={t("home.cal_quick_create")}
            aria-label={t("home.cal_quick_create")}
            onClick={onNewEvent}
          >
            <IconPlus size={14} strokeWidth={2} />
          </button>
        )}

        {rightSlot}
      </div>
    </div>
  );
});
