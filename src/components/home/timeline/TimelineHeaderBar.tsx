/**
 * Timeline header bar: view readout, minimap brush, era filter, scale presets, today/fit jumps,
 * and search/filter indicators — all on ONE row.
 *
 * The readout is a CHIP: it only ever shows numbers (where the camera is), and clicking it opens
 * the 기간 선택 modal. It used to turn into a pair of `YYYY-MM-DD` text fields instead, which put
 * two range-looking widgets side by side (this one moved only the camera; the era dropdown moves
 * the camera *and* the note_query filter) with no way to tell them apart, and made typing a
 * parseable string the 5th — and least discoverable — way to move a viewport that the brush,
 * wheel zoom, 연/월/일, 오늘 and 맞춤 already cover. Now the row carries one chip, and every range
 * INPUT lives behind it in the modal.
 *
 * Extracted from TimelineTab.tsx.
 * Performance: Wrapped in React.memo to avoid re-renders on canvas gestures.
 */
import { memo, useCallback, useState, type CSSProperties, type RefObject } from "react";
import type { TimelineResult } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { EraChips } from "../../leftpanel/yearfilter/TimelineFilter";
import { formatYearRange } from "../dateFmt";
import {
  fractionalYearToDate,
  isYearFilterNarrowed,
  tripleToFraction,
  type YearRange,
} from "./layout";
import { TimelineBrush, type BrushHitTick } from "./Brush";
import { ModalShell } from "../../ModalShell";
import { useSearchStore } from "../../../stores/search";
import { useTaxonomyStore } from "../../../stores/taxonomy";

export interface TimelineHeaderBarProps {
  view: YearRange;
  fullRange: YearRange;
  tickStep: number;
  isZoomed: boolean;
  fitRange: YearRange | null;
  fitView: () => void;
  applyView: (from: number, to: number) => void;
  result: TimelineResult | null;
  loading: boolean;
  error: string | null;
  brushTrackRef: RefObject<HTMLDivElement | null>;
  brushW: number;
  minimapMarks: { left: number; width: number; key: string }[];
  searchTicks: BrushHitTick[];
  searchHitsCount?: number | null;
  yearFrom: number;
  yearTo: number;
  yearBounds: { min: number; max: number };
  setYearRange: (from: number, to: number) => void;
}

export const TimelineHeaderBar = memo(function TimelineHeaderBar({
  view,
  fullRange,
  tickStep,
  isZoomed,
  fitRange,
  fitView,
  applyView,
  result,
  loading,
  error,
  brushTrackRef,
  brushW,
  minimapMarks,
  searchTicks,
  searchHitsCount,
  yearFrom,
  yearTo,
  yearBounds,
  setYearRange,
}: TimelineHeaderBarProps) {
  const jumpToToday = useCallback(() => {
    const now = new Date();
    const todayFrac = tripleToFraction({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    });
    const span = Math.max(0.2, view.to - view.from);
    applyView(todayFrac - span / 2, todayFrac + span / 2);
  }, [view.from, view.to, applyView]);

  const zoomToYear = useCallback(() => {
    const center = (view.from + view.to) / 2;
    applyView(center - 5, center + 5);
  }, [view.from, view.to, applyView]);

  const zoomToMonth = useCallback(() => {
    const center = (view.from + view.to) / 2;
    applyView(center - 0.5, center + 0.5);
  }, [view.from, view.to, applyView]);

  const zoomToDay = useCallback(() => {
    const center = (view.from + view.to) / 2;
    applyView(center - 1 / 12, center + 1 / 12);
  }, [view.from, view.to, applyView]);

  const isYearActive = tickStep >= 1 - 1e-9;
  const isMonthActive = !isYearActive && tickStep >= 1 / 12 - 1e-9;
  const isDayActive = !isYearActive && !isMonthActive;

  return (
    <>
      {/* 한 줄: [읽기 전용 보기 readout + 기간 필터] | 미니맵 브러시 | [배율 · 점프] */}
      <div
        className="timeline-header-wrap"
        data-testid="timeline-range"
        style={{
          flex: "none",
          display: "grid",
          gridTemplateColumns: "1fr minmax(260px, 520px) 1fr",
          alignItems: "center",
          gap: "var(--space-4)",
          padding: "var(--space-2) 0 var(--space-3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          <RangeControl
            view={view}
            step={tickStep}
            zoomed={isZoomed}
            canReset={isYearFilterNarrowed(yearFrom, yearTo, yearBounds)}
            onResetAll={() => {
              setYearRange(yearBounds.min, yearBounds.max);
              // 필터만 풀면 카메라는 좁은 채로 남아 "전체로"가 거짓말이 된다 — TimelineTab 의
              // period→view 효과는 좁아질 때만 따라오므로(넓힐 때 early return) 여기서 편다.
              applyView(fullRange.from, fullRange.to);
            }}
          />
          {result?.capped && (
            <span
              data-testid="timeline-capped-banner"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                padding: "var(--space-2xs) 7px",
                borderRadius: "var(--radius-pill)",
                background: "color-mix(in srgb, var(--surface) 60%, transparent)",
                border: "1px solid var(--line)",
                whiteSpace: "nowrap",
              }}
            >
              {t("home.timeline_capped", {
                n: String(result.total_matched),
                cap: String(result.cap),
              })}
            </span>
          )}
          {loading && (
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--faint)",
                padding: "var(--space-2xs) 6px",
                whiteSpace: "nowrap",
              }}
            >
              {t("home.timeline_loading")}
            </span>
          )}
          {error && (
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--danger)",
                padding: "var(--space-2xs) 6px",
                whiteSpace: "nowrap",
              }}
            >
              {error}
            </span>
          )}
          {searchHitsCount != null && searchHitsCount > 0 && (
            <span data-testid="timeline-search-count" className="badge" data-tone="accent">
              {searchHitsCount}
            </span>
          )}
        </div>

        <TimelineBrush
          trackRef={brushTrackRef}
          full={fullRange}
          view={view}
          width={brushW}
          marks={minimapMarks}
          hitTicks={searchTicks}
          onViewChange={applyView}
        />

        <div
          style={{
            justifySelf: "end",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            minWidth: 0,
          }}
        >
          {/* Scale preset buttons: Year / Month / Day — L1 responsive degradation (WORKORDER-2026-08-23 §3.3 ④) */}
          <div
            className="timeline-scale-presets"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2xs)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              padding: 0,
              height: 28,
              boxSizing: "border-box",
            }}
          >
            <button
              type="button"
              data-testid="timeline-scale-year"
              onClick={zoomToYear}
              title={t("search.timeline_zoom_year")}
              className="icon-glow"
              style={{
                ...scaleBtnStyle,
                background: "transparent",
                color: isYearActive ? "var(--accent)" : "var(--muted)",
                opacity: isYearActive ? 1 : 0.7,
                filter: isYearActive
                  ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))"
                  : "none",
                fontWeight: isYearActive ? 600 : 400,
              }}
            >
              {t("search.timeline_zoom_year")}
            </button>
            <button
              type="button"
              data-testid="timeline-scale-month"
              onClick={zoomToMonth}
              title={t("search.timeline_zoom_month")}
              className="icon-glow"
              style={{
                ...scaleBtnStyle,
                background: "transparent",
                color: isMonthActive ? "var(--accent)" : "var(--muted)",
                opacity: isMonthActive ? 1 : 0.7,
                filter: isMonthActive
                  ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))"
                  : "none",
                fontWeight: isMonthActive ? 600 : 400,
              }}
            >
              {t("search.timeline_zoom_month")}
            </button>
            <button
              type="button"
              data-testid="timeline-scale-day"
              onClick={zoomToDay}
              title={t("search.timeline_zoom_day")}
              className="icon-glow"
              style={{
                ...scaleBtnStyle,
                background: "transparent",
                color: isDayActive ? "var(--accent)" : "var(--muted)",
                opacity: isDayActive ? 1 : 0.7,
                filter: isDayActive
                  ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))"
                  : "none",
                fontWeight: isDayActive ? 600 : 400,
              }}
            >
              {t("search.timeline_zoom_day")}
            </button>
          </div>

          {/* 좁아지면 접히는 쪽은 오늘/맞춤이다 — 브러시가 대신할 수 있는 "점프"이기 때문.
              연/월/일은 남긴다: 배율은 그 밖에 휠 줌뿐이라 접으면 대체 수단이 사라진다. */}
          <div
            className="timeline-view-actions"
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
          >
            <button
              type="button"
              data-testid="timeline-today"
              onClick={jumpToToday}
              title={t("search.calendar_today")}
              className="icon-glow"
              style={zoomBtnStyle}
            >
              {t("search.calendar_today")}
            </button>

            <button
              type="button"
              data-testid="timeline-fit"
              onClick={fitView}
              disabled={!fitRange}
              title={t("home.timeline_fit")}
              className="icon-glow"
              style={{
                ...zoomBtnStyle,
                opacity: fitRange ? 0.7 : 0.35,
                cursor: fitRange ? "pointer" : "default",
              }}
            >
              {t("home.timeline_fit")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
});

/**
 * View-bound label for the unified range control: "2026" / "2026-08" / "2026-08-15", chosen by
 * the axis granularity.
 */
export function formatViewBound(frac: number, step: number): string {
  const p = fractionalYearToDate(frac);
  const mm = String(p.month).padStart(2, "0");
  if (step >= 1 - 1e-9) return String(Math.round(frac));
  if (step >= 1 / 12 - 1e-9) return `${p.year}-${mm}`;
  return `${p.year}-${mm}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The view chip. Shows where the camera is ("2026" / "2026-08" / "2026-08-15", granularity from
 * the axis) and nothing else; clicking it opens the 기간 선택 modal, which is where every range
 * INPUT on this screen lives.
 *
 * Why a real modal and not an anchored popover: EraChips renders a `Select`, and `Select` portals
 * its listbox into `popoverRoot(trigger)` — the enclosing `.modal-scrim` when there is one, `body`
 * otherwise. Inside `.modal-scrim` the listbox lands above the card and stays clickable; a plain
 * popover would leave it at --z-dropdown(20) under --z-backdrop(70), and ModalShell's `inert`
 * sweep would kill it besides.
 */
export function RangeControl({
  view,
  step,
  zoomed,
  canReset,
  onResetAll,
}: {
  view: YearRange;
  step: number;
  zoomed: boolean;
  canReset: boolean;
  onResetAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 선택된 기간 프리셋의 이름을 숫자 뒤에 붙인다 — "2020 – 2023 성장기". 판정은 EraChips 의
  // Select 와 **같은 규칙**(필터가 그 기간과 정확히 일치)이라 두 표면이 어긋나지 않는다.
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const eras = useTaxonomyStore((s) => s.eras);
  const activeEra = eras.find((e) => yearFrom === e.from_year && yearTo === e.to_year);

  return (
    <>
      <button
        type="button"
        data-testid="timeline-range-readout"
        onClick={() => setOpen(true)}
        title={t("search.era_select")}
        aria-label={t("search.era_select")}
        aria-haspopup="dialog"
        style={{
          border: "1px solid color-mix(in srgb, var(--line) 80%, transparent)",
          borderRadius: "var(--radius-pill)",
          padding: "var(--space-2xs) 10px",
          background: "transparent",
          cursor: "pointer",
          font: "inherit",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          fontSize: "var(--text-sm)",
          color: zoomed ? "var(--accent)" : "var(--muted)",
          whiteSpace: "nowrap",
          height: 28,
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          transition: "color var(--dur-fast) ease, border-color var(--dur-fast) ease",
        }}
      >
        {formatYearRange(formatViewBound(view.from, step), formatViewBound(view.to, step))}
        {activeEra && (
          <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--muted)" }}>
            {activeEra.name}
          </span>
        )}
      </button>

      {open && (
        <ModalShell title={t("search.era_select")} width={340} onClose={() => setOpen(false)}>
          <EraChips />
          {canReset && (
            <button
              type="button"
              data-testid="timeline-era-reset"
              onClick={() => {
                onResetAll();
                setOpen(false);
              }}
              style={{
                marginTop: "var(--space-3)",
                border: "none",
                background: "none",
                padding: 0,
                font: "inherit",
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              {t("search.timeline_show_all")}
            </button>
          )}
        </ModalShell>
      )}
    </>
  );
}

const zoomBtnStyle: CSSProperties = {
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "0 10px",
  height: 28,
  boxSizing: "border-box",
  color: "var(--muted)",
  fontSize: "var(--text-xs)",
  fontWeight: 400,
  background: "transparent",
  boxShadow: "none",
  cursor: "pointer",
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "color var(--dur-fast) ease, filter var(--dur-fast) ease, opacity var(--dur-fast) ease",
};

const scaleBtnStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  borderRadius: "var(--radius-xs)",
  padding: "var(--space-2xs) 8px",
  height: 22,
  color: "var(--muted)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background var(--dur-fast) ease, color var(--dur-fast) ease",
};
