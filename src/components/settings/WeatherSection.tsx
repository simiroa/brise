import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { t } from "../../i18n/t";
import { reportFallback } from "../../lib/diag";
import { useSettingsStore } from "../../stores/settings";
import { useWeatherLocation } from "../home/useWeatherLocation";
import {
  fetchDailyForecast,
  weatherCodeToVisual,
  type DailyForecast,
  type ResolvedWeatherLocation,
} from "../../lib/weather";

/** 예보 판독 상태 — null 하나로는 "아직 오는 중"과 "못 받았다"를 가를 수 없어서 따로 든다. */
export type ForecastStatus = "off" | "loading" | "ready" | "failed";

/**
 * 기준 지역의 판독값 — 현지 시간·7일 예보·좌표 출처. 페이지(ViewSection)가 한 번 부르고 스트립과
 * 아래 `WeatherSection` 예보 띠에 나눠 준다(lib/weather 의 캐시는 1h 지만 **동시** 두 호출은 막지
 * 못하므로 호출을 하나로 올렸다).
 *
 * 현지 시간은 예보가 알려 준 시간대(`forecast.timezone`)로 만들고, 시간대를 모르면 이 PC 의 시각으로
 * 그린다 — 화면은 `timezone` 이 null 인 것을 보고 "이 PC 기준" 이라고 밝힌다.
 * ponytail: met.no 는 시간대를 돌려주지 않아 지금은 늘 PC 시각이다. 좌표→시간대 조회(오프라인 표나
 * Rust 커맨드)가 생기면 그것을 `timezone` 에 넣으면 된다.
 */
export function useWeatherReadout(): {
  resolved: ResolvedWeatherLocation | null;
  forecast: DailyForecast | null;
  status: ForecastStatus;
  localTimeStr: string | null;
  timezone: string | null;
} {
  const resolved = useWeatherLocation();
  const uiLang = useSettingsStore((s) => s.uiLang);

  const [forecast, setForecast] = useState<DailyForecast | null>(null);
  const [status, setStatus] = useState<ForecastStatus>(resolved ? "loading" : "off");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 위치 없음(= 기준 지역 마스터 off, R3) 이면 met.no 요청 자체를 하지 않는다.
    if (!resolved) {
      setForecast(null);
      setStatus("off");
      return;
    }
    let active = true;
    setStatus("loading");
    // fetchDailyForecast 는 실패를 스스로 진단에 남기고 null 을 돌려준다 — 여기서는 화면 상태만 정한다.
    fetchDailyForecast(resolved)
      .then((res) => {
        if (!active) return;
        setForecast(res);
        setStatus(res && res.time.length > 0 ? "ready" : "failed");
      })
      .catch((e: unknown) => {
        reportFallback("weather", "settings_forecast_failed", String(e));
        if (!active) return;
        setForecast(null);
        setStatus("failed");
      });
    return () => {
      active = false;
    };
  }, [resolved?.lat, resolved?.lng]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const timezone = resolved ? forecast?.timezone || null : null;
  const localTimeStr = useMemo(() => {
    // 현지 시간도 기준 지역이 만들어내는 것이다(R3) — 위치가 없으면 표시할 것이 없다.
    if (!resolved) return null;
    try {
      return new Intl.DateTimeFormat(uiLang || undefined, {
        timeZone: timezone || undefined,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(now));
    } catch (e) {
      reportFallback("weather", "bad_timezone", `${timezone}: ${String(e)}`);
      return null;
    }
  }, [resolved, timezone, now, uiLang]);

  return { resolved, forecast, status, localTimeStr, timezone };
}

/**
 * 설정 > 지역 및 날씨의 **7일 예보 띠**.
 *
 * 컨트롤이 아니라 결과다: 위치는 아래 지역 카드의 지도가 정하고, 예보는 `useWeatherReadout`
 * 을 부른 호출자(ViewSection)가 넘긴다. 2026-09-15 R4 로 이 띠는 카드 밖 **페이지 상단
 * 3:7 스트립의 우측 아래 줄**로 올라갔다 — 마크업은 그대로 옮겼을 뿐 다시 쓰지 않았다.
 * 스트립·제목은 호출자가 소유한다.
 *
 * 날씨 표시 토글(`header_weather_visible`)은 2026-09-12 오너 결정 D11 로 사라졌다 — 날씨는
 * 항상 표시다.
 */
export function WeatherSection({
  forecast,
  status = "ready",
}: {
  forecast: DailyForecast | null;
  /** "failed" 면 띠 자리에 "예보를 불러오지 못했습니다" 한 줄을 세운다(출처 줄만 남기지 않는다). */
  status?: ForecastStatus;
}) {
  return (
    <div data-testid="settings-weather">
      {status === "failed" && (
        <div data-testid="settings-weather-unavailable" style={unavailableLine}>
          {t("settings.weather_unavailable")}
        </div>
      )}
      {forecast && forecast.time.length > 0 && (
        <div data-testid="settings-weather-7day" style={forecastStrip}>
          {forecast.time.slice(0, 7).map((dateStr, i) => {
            const code = forecast.weatherCode[i] ?? 0;
            const max = forecast.tempMaxC[i];
            const min = forecast.tempMinC[i];
            const { Icon, colorVar } = weatherCodeToVisual(code, max);

            const parts = dateStr.split("-");
            const displayDate = parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : dateStr;

            return (
              <div
                key={dateStr}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  flex: "1 1 0",
                  minWidth: 40,
                }}
              >
                <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {displayDate}
                </span>
                <div style={{ color: colorVar, display: "grid", placeItems: "center" }}>
                  <Icon size={18} />
                </div>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 400, color: "var(--text)", whiteSpace: "nowrap" }}>
                  {max !== undefined ? `${Math.round(max)}°` : "-"}
                </span>
                <span style={{ fontSize: "var(--text-label)", color: "var(--faint)", whiteSpace: "nowrap" }}>
                  {min !== undefined ? `${Math.round(min)}°` : "-"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: "var(--space-3)", fontSize: "var(--text-label)", color: "var(--faint)" }}>
        {t("settings.weather_attribution")}
      </div>
    </div>
  );
}

const unavailableLine: CSSProperties = {
  padding: "var(--space-3) 0",
  fontSize: "var(--text-sm)",
  color: "var(--muted)",
};

const forecastStrip: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  overflowX: "auto",
  padding: "var(--space-3) 0",
};
