/**
 * 보는 달의 일별 예보 — 대시보드 달력 탭(CalendarTab)과 사이드바 미니 달력(CalendarExpanded)이
 * 글자 그대로 같은 effect 를 두 벌 들고 있던 것을 합쳤다(PLAN-2026-09-13-separation-of-concerns
 * 트랙 D1 ②, 동작 변경 0). 달력 W 시리즈가 두 표면을 늘 같이 고치던 자리라 어긋나면 한쪽만
 * 창 게이트를 잃는다.
 */
import { useEffect, useMemo, useState } from "react";
import { monthRange } from "../../leftpanel/expanded/calendarGrid";
import { toIsoDateLocal, todayLocal } from "../dateFmt";
import {
  fetchDailyForecast,
  type DailyForecast,
  type ResolvedWeatherLocation,
} from "../../../lib/weather";

export type ForecastDay = { code: number; max: number; min: number };

/** 평행 배열(`forecast.time[i]`) → 날짜 키 O(1) 조회 맵. 하루 칸을 그리는 표면이 전부 같은
 *  한 벌을 쓴다(MonthGrid · CalendarExpanded · useMonthForecast 자신). */
export function forecastDayMap(forecast: DailyForecast | null): Map<string, ForecastDay> | null {
  if (!forecast || !forecast.time) return null;
  const map = new Map<string, ForecastDay>();
  for (let i = 0; i < forecast.time.length; i++) {
    map.set(forecast.time[i], {
      code: forecast.weatherCode[i],
      max: forecast.tempMaxC[i],
      min: forecast.tempMinC[i],
    });
  }
  return map;
}

/**
 * Forecast icons (day cells): fetch only when the viewed month can actually show one — the
 * 16-day window starting today. fetchDailyForecast has its own 1h cache keyed by location, so
 * this is just avoiding a pointless first-ever fetch for a month that's nowhere near today;
 * once cached, re-navigating within the hour is free. Window/month-range comparison mixes
 * local "today" with the grid's UTC month boundaries — same day-boundary fuzz already accepted
 * elsewhere in the calendar, not worth reconciling for a decoration layer.
 * 날씨는 항상 그린다(D11, 2026-09-12) — 표시 토글은 없어졌고 남은 게이트는 "위치가 있는가"와
 * "이 뷰가 하루 칸을 그리는가"(`enabled`, 달력 탭의 연 보기)뿐이다.
 *
 * 창 밖의 달에서는 **아무것도 하지 않는다** — 이전 달의 예보가 그대로 남지만 그 달 칸을
 * 그리지 않으므로 화면에는 안 보인다(리팩터 전 두 벌이 똑같이 그랬다).
 */
export function useMonthForecast(
  weatherLoc: ResolvedWeatherLocation | null,
  viewYear: number,
  viewMonth: number,
  opts?: { enabled?: boolean },
): { forecast: DailyForecast | null; forecastByDay: Map<string, ForecastDay> | null } {
  const enabled = opts?.enabled ?? true;
  const [forecast, setForecast] = useState<DailyForecast | null>(null);
  // 호출자들과 같은 마운트 시점 스냅샷 — 살아있는 자정 넘김에 반응할 필요가 없는 값이다.
  const today = useMemo(todayLocal, []);

  useEffect(() => {
    if (!weatherLoc || !enabled) {
      setForecast(null);
      return;
    }
    const { from, to } = monthRange(viewYear, viewMonth);
    const windowEnd = toIsoDateLocal(new Date(Date.now() + 16 * 24 * 60 * 60 * 1000));
    if (to < today.day || from > windowEnd) return;
    let cancelled = false;
    void fetchDailyForecast(weatherLoc).then((f) => {
      if (!cancelled) setForecast(f);
    });
    return () => {
      cancelled = true;
    };
  }, [weatherLoc, viewYear, viewMonth, enabled, today.day]);

  const forecastByDay = useMemo(() => forecastDayMap(forecast), [forecast]);

  return { forecast, forecastByDay };
}
