import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { monthLongLabel } from "../../components/home/dateFmt";
import { buildCalendarGridCustom, shiftMonth } from "../../components/leftpanel/expanded/calendarGrid";
import { IconCaret } from "../../components/icons";
import { useMonthCalendar } from "../hooks/useMonthCalendar";
import { CardShell } from "./CardShell";

/** 첫 요일부터 7개 요일 머리글(UI 언어의 한 글자 이름). 2026-10-04 은 일요일. */
function weekdayHeads(uiLang: string, weekStart: "sunday" | "monday"): string[] {
  const fmt = new Intl.DateTimeFormat(uiLang || "en", { weekday: "narrow", timeZone: "UTC" });
  const base = weekStart === "monday" ? 5 : 4;
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 9, base + i))));
}

/**
 * 작은 월 달력(PLAN-2026-10-19 §12.1 Q3 — "달력은 작게라도 있는 게 좋다"). 일정 있는 날에 점, 날짜를
 * 누르면 왼쪽 축이 그날로 간다(Q2 의 '날짜 바꾸기 쉽게'와 같은 길). 점은 **노트 일정만** — 요일 반복
 * 루틴까지 세면 평일마다 점이 찍혀 아무 말도 안 하게 된다. 보는 달은 축의 날짜를 따라간다.
 */
export function MiniCalendar({ day, todayIso, onPick }: { day: string; todayIso: string; onPick: (day: string) => void }) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const weekStart = useSettingsStore((s) => s.weekStart);
  const axisYear = Number(day.slice(0, 4));
  const axisMonth = Number(day.slice(5, 7)) - 1;
  const [view, setView] = useState({ year: axisYear, month: axisMonth });
  useEffect(() => setView({ year: axisYear, month: axisMonth }), [axisYear, axisMonth]);

  const cells = useMemo(() => buildCalendarGridCustom(view.year, view.month, weekStart), [view, weekStart]);
  const days = useMemo(() => cells.flatMap((c) => (c.day ? [c.day] : [])), [cells]);
  const { byDay, holidays } = useMonthCalendar(days);
  const heads = useMemo(() => weekdayHeads(uiLang, weekStart), [uiLang, weekStart]);
  const label = monthLongLabel(uiLang, view.year, view.month);
  const fullDay = new Intl.DateTimeFormat(uiLang || "en", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });

  return (
    <CardShell
      testId="brf-mini-cal"
      title={t("briefing.calendar_title")}
      head={
        <div className="brf-card-head">
          <h2 className="brf-card-title">{label}</h2>
          <span className="brf-card-aside">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={t("briefing.cal_prev")}
              title={t("briefing.cal_prev")}
              onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
            >
              <IconCaret dir="left" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={t("briefing.cal_next")}
              title={t("briefing.cal_next")}
              onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
            >
              <IconCaret dir="right" size={14} />
            </button>
          </span>
        </div>
      }
    >
      <div className="brf-cal-grid" role="group" aria-label={label}>
        {heads.map((h, i) => (
          <span key={`h${i}`} className="brf-cal-head" aria-hidden>
            {h}
          </span>
        ))}
        {cells.map((c, i) => {
          if (!c.day) return <span key={`e${i}`} aria-hidden />;
          const has = (byDay[c.day] ?? []).some((e) => e.kind === "event");
          const name = holidays[c.day];
          const cls = [
            "brf-cal-day",
            c.day === todayIso ? "is-today" : "",
            c.day === day ? "is-selected" : "",
            name ? "is-holiday" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.day}
              type="button"
              className={cls}
              data-testid={`brf-cal-day-${c.day}`}
              aria-pressed={c.day === day}
              aria-current={c.day === todayIso ? "date" : undefined}
              aria-label={`${fullDay.format(new Date(`${c.day}T00:00:00Z`))}${has ? ` · ${t("briefing.cal_has_events")}` : ""}${name ? ` · ${name}` : ""}`}
              onClick={() => onPick(c.day!)}
            >
              {c.dayOfMonth}
              {has && <span className="brf-cal-dot" data-testid="brf-cal-dot" aria-hidden />}
            </button>
          );
        })}
      </div>
    </CardShell>
  );
}
