import { useMemo } from "react";
import { t } from "../../i18n/t";
import type { HabitHistory } from "../../lib/commands.gen";
import { dayAfter, HEATMAP_WEEKS } from "../hooks/useBriefingData";

/** 칸 진하기 — "off" = 그날 해당 요일 습관 없음(빈칸), 0 = 해당은 있는데 하나도 안 함, 1~3 = 비율 3등분, 4 = 전부. */
export type HeatLevel = "off" | 0 | 1 | 2 | 3 | 4;

export function heatLevel(scheduled: number, done: number): HeatLevel {
  if (scheduled <= 0) return "off";
  const r = Math.min(1, Math.max(0, done / scheduled));
  if (r === 0) return 0;
  if (r >= 1) return 4;
  if (r <= 1 / 3) return 1;
  if (r <= 2 / 3) return 2;
  return 3;
}

export interface HeatCell {
  day: string;
  /** 0=주 시작 요일 행. */
  row: number;
  col: number;
  future: boolean;
  scheduled: number;
  done: number;
  level: HeatLevel;
}

/**
 * 7행(주 시작 요일부터) × 12열(주) — from 은 heatmapRange 가 주 첫날로 맞춘 날이다. 응답 배열 위치에 기대지 않고
 * 날짜로 찾는다(없는 날은 빈칸). 오늘 이후 칸은 future — 자리만 지키고 그리지 않는다(열 정렬 유지).
 */
export function buildHeatGrid(history: HabitHistory, today: string): HeatCell[] {
  const byDay = new Map(history.days.map((d) => [d.day, d]));
  const cells: HeatCell[] = [];
  for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
    const day = dayAfter(history.from, i);
    const future = day > today;
    const d = future ? undefined : byDay.get(day);
    const scheduled = d?.scheduled ?? 0;
    const done = d?.done ?? 0;
    cells.push({ day, row: i % 7, col: Math.floor(i / 7), future, scheduled, done, level: heatLevel(scheduled, done) });
  }
  return cells;
}

const LEGEND: HeatLevel[] = [0, 1, 2, 3, 4];

/** 오늘의 습관 12주 히트맵 — 칸 진하기 = 그날 끝낸 비율. 식별은 색만이 아니라 각 칸의 aria-label·title 로도 읽힌다. */
export function HabitHeatmap({ history, today, uiLang }: { history: HabitHistory; today: string; uiLang: string }) {
  const cells = useMemo(() => buildHeatGrid(history, today), [history, today]);
  const fmt = useMemo(() => {
    const md = new Intl.DateTimeFormat(uiLang || "en", { month: "numeric", day: "numeric", timeZone: "UTC" });
    const wd = new Intl.DateTimeFormat(uiLang || "en", { weekday: "short", timeZone: "UTC" });
    return (day: string) => {
      const d = new Date(`${day}T00:00:00Z`);
      return { date: md.format(d), weekday: wd.format(d) };
    };
  }, [uiLang]);
  // 요일 라벨은 1·3·5번째 행(주 시작 요일부터 센다)만 — 첫 열의 날짜가 곧 그 행의 요일이다.
  const rowLabels = cells.slice(0, 7).map((c) => (c.row % 2 === 0 && c.row < 5 ? fmt(c.day).weekday : ""));
  return (
    <div className="brf-heat" data-testid="brf-heatmap">
      <div className="brf-heat-body">
        <div className="brf-heat-rows" aria-hidden>
          {rowLabels.map((l, i) => (
            <span key={i} className="brf-heat-rowlabel">
              {l}
            </span>
          ))}
        </div>
        <div className="brf-heat-grid" role="group" aria-label={t("briefing.habit_heat_label")}>
          {cells.map((c) => {
            if (c.future) return <span key={c.day} className="brf-heat-cell is-future" aria-hidden data-testid="brf-heat-cell" data-future="1" />;
            const { date, weekday } = fmt(c.day);
            const label =
              c.level === "off"
                ? t("briefing.habit_heat_cell_off", { date, weekday })
                : t("briefing.habit_heat_cell", { date, weekday, done: c.done, total: c.scheduled });
            return (
              <span
                key={c.day}
                role="img"
                className={`brf-heat-cell is-l${c.level}${c.day === today ? " is-today" : ""}`}
                data-testid="brf-heat-cell"
                data-day={c.day}
                data-level={String(c.level)}
                aria-label={label}
                title={label}
              />
            );
          })}
        </div>
      </div>
      <div className="brf-heat-legend" aria-hidden>
        <span>{t("briefing.habit_heat_less")}</span>
        {LEGEND.map((l) => (
          <span key={l} className={`brf-heat-cell is-l${l}`} />
        ))}
        <span>{t("briefing.habit_heat_more")}</span>
      </div>
    </div>
  );
}
