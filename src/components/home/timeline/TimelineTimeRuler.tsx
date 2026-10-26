/**
 * Top timeline tick marks and date labels (Time Ruler) — extracted from TimelineTab / Axis.
 *
 * Renders the top axis strip with major/minor tick marks, date labels, and cursor guide.
 *
 * Performance: Wrapped in React.memo to prevent re-renders when other canvas state changes.
 */
import { memo } from "react";
import { formatTimelineTick } from "../dateFmt";
import {
  AXIS_HEIGHT,
  fractionalYearToDate,
  yearToX,
  type YearRange,
} from "./layout";

const TICK_EPS = 1e-6;

export interface TimelineTimeRulerProps {
  ticks: number[];
  /** Second-tier boundaries (layout.ts header #5b) — a short unlabeled notch on the axis strip,
   *  matching the fainter gridline GridLines draws for the same coordinate. */
  minorTicks: number[];
  view: YearRange;
  width: number;
  /** Active LABEL tick step (years) — drives label format. */
  step: number;
  uiLang: string;
  /** Tick the canvas cursor is nearest to, or null — highlighted alongside CSS :hover. */
  hoverTick?: number | null;
}

export const TimelineTimeRuler = memo(function TimelineTimeRuler({
  ticks,
  minorTicks,
  view,
  width,
  step,
  uiLang,
  hoverTick,
}: TimelineTimeRulerProps) {
  const subYear = step < 1 - TICK_EPS;
  return (
    <div
      data-testid="timeline-axis"
      data-tl-axis="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: AXIS_HEIGHT,
        borderBottom: "1px solid var(--line)",
        pointerEvents: "none",
      }}
    >
      <style>{`
        .tl-tick{
          color:var(--muted);
          border-radius:var(--radius-sm);
          transition:color var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .tl-tick[data-major="true"]{color:var(--text)}
        .tl-tick:hover,
        .tl-tick[data-hover="true"]{color:var(--text);background:var(--hover)}
      `}</style>
      {minorTicks.map((y) => (
        <span
          key={`minor-${y}`}
          aria-hidden
          data-testid="timeline-axis-minor-tick"
          data-tick-year={y}
          style={{
            position: "absolute",
            left: yearToX(y, view.from, view.to, width),
            bottom: 0,
            width: 1,
            height: 5,
            background:
              hoverTick != null && Math.abs(hoverTick - y) < TICK_EPS
                ? "var(--accent)"
                : "var(--line)",
            pointerEvents: "none",
          }}
        />
      ))}
      {ticks.map((y) => {
        const left = yearToX(y, view.from, view.to, width);
        const parts = fractionalYearToDate(y);
        const label = formatTimelineTick(y, step, uiLang, parts);
        // On a sub-year axis the year boundaries stay the anchors; on a year axis every tick is
        // already a year, so nothing needs promoting above the (now legible) base.
        const major = subYear && Math.abs(y - Math.round(y)) < TICK_EPS;
        return (
          <span
            key={`${y}:${label}`}
            className="tl-tick"
            data-testid="timeline-axis-tick"
            data-tick-year={y}
            data-major={major ? "true" : undefined}
            data-hover={hoverTick != null && Math.abs(hoverTick - y) < TICK_EPS ? "true" : undefined}
            style={{
              position: "absolute",
              left,
              top: 0,
              height: AXIS_HEIGHT,
              padding: "0 5px",
              fontSize: "var(--text-xs)",
              fontWeight: major ? 600 : 600,
              lineHeight: `${AXIS_HEIGHT}px`,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              pointerEvents: "auto",
              cursor: "default",
            }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
});

export const TimelineAxis = TimelineTimeRuler;

export interface HoverGuideProps {
  tick: number;
  view: YearRange;
  width: number;
  step: number;
  uiLang: string;
}

/** Cursor guide — full-height hairline snapped to the nearest tick, labelled as a date. */
export const HoverGuide = memo(function HoverGuide({
  tick,
  view,
  width,
  step,
  uiLang,
}: HoverGuideProps) {
  const left = yearToX(tick, view.from, view.to, width);
  return (
    <div
      aria-hidden
      data-testid="timeline-hover-guide"
      data-tick={tick}
      style={{
        position: "absolute",
        // Below the (top-anchored) axis strip, runs to the true bottom.
        top: AXIS_HEIGHT,
        bottom: 0,
        left,
        width: 1,
        background: "color-mix(in srgb, var(--accent) 40%, transparent)",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: 4,
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          color: "var(--muted)",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {formatTimelineTick(tick, step, uiLang, fractionalYearToDate(tick))}
      </span>
    </div>
  );
});
