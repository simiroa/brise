/**
 * 브리핑 머리줄 A — 날짜 · 시각 · 지금 날씨(최고/최저 · 몇 시부터 비) · 인사 한 줄. PLAN-2026-10-19 §3.1.
 * 옛 "지금" 카드(17가지 모양)를 이 한 줄로 줄였다. 위계는 크기로만(시계 숫자 --text-clock, 날짜 --text-title).
 *
 * 날씨는 지역 기능이 켜져 있고 기본 위치를 사용자가 직접 정했을 때만(useRegionReady) — 공장 기본 위치(서울)의
 * 예보를 "여기 날씨"처럼 보이면 거짓말이 된다. 그 밖엔 설정으로 가는 조용한 링크 하나.
 */
import { t } from "../i18n/t";
import { useSettingsStore } from "../stores/settings";
import { weatherCodeToVisual, weatherLabelKey, weatherTempColorVar } from "../lib/weather";
import { toIsoDateLocal } from "../components/home/dateFmt";
import { hhmm } from "./clockInfo";
import { useBriefingWeather, useNow } from "./hooks/useBriefingData";
import { useRegionReady } from "./hooks/useRegionReady";
import { useGreeting } from "./hooks/useGreeting";
import { openBriefingSettings } from "./openSettings";
import { rainOnset } from "./dayNav";

function WeatherNow() {
  const { status, data, reload } = useBriefingWeather();
  const now = useNow(60_000);
  if (status === "loading" && !data) return <span className="brf-head-weather brf-muted">{t("briefing.loading")}</span>;
  if (!data?.now) {
    return (
      <span className="brf-head-weather brf-muted" role="status">
        {t("briefing.weather_failed")}{" "}
        <button type="button" className="brf-link-btn" onClick={reload}>
          {t("briefing.retry")}
        </button>
      </span>
    );
  }
  const today = toIsoDateLocal(now);
  const i = data.daily?.time.indexOf(today) ?? -1;
  const max = i >= 0 ? data.daily!.tempMaxC[i] : undefined;
  const min = i >= 0 ? data.daily!.tempMinC[i] : undefined;
  const visual = weatherCodeToVisual(data.now.weatherCode, max);
  const rain = rainOnset(data.hourly, now.getHours());
  return (
    <span className="brf-head-weather" data-testid="brf-head-weather">
      <visual.Icon size={18} strokeWidth={1.8} style={{ color: visual.colorVar }} aria-hidden />
      <span>{t(weatherLabelKey(data.now.weatherCode))}</span>
      <span className="brf-head-temp">{Math.round(data.now.tempC)}°</span>
      {max !== undefined && min !== undefined && (
        <span className="brf-head-range" aria-label={t("briefing.weather_range_aria", { max: Math.round(max), min: Math.round(min) })}>
          <span style={{ color: weatherTempColorVar(max, min) }}>{Math.round(max)}°</span>
          <span className="brf-muted">/{Math.round(min)}°</span>
        </span>
      )}
      {rain && (
        <span className="brf-head-rain" data-testid="brf-head-rain">
          {t("briefing.weather_rain_from", { time: rain })}
        </span>
      )}
    </span>
  );
}

export function HeaderRow() {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const now = useNow(60_000);
  const regionReady = useRegionReady();
  const greeting = useGreeting();
  const date = new Intl.DateTimeFormat(uiLang || "en", { month: "long", day: "numeric", weekday: "long" }).format(now);
  return (
    <header className="brf-head" data-testid="brf-head">
      <span className="brf-head-date">{date}</span>
      <time className="brf-head-clock" dateTime={now.toISOString()}>
        {hhmm(now)}
      </time>
      {regionReady ? (
        <WeatherNow />
      ) : (
        <button type="button" className="brf-link-btn brf-head-weather brf-muted" onClick={() => void openBriefingSettings("weather")}>
          {t("briefing.weather_setup")}
        </button>
      )}
      <span className="brf-head-greeting" data-testid="brf-head-greeting">
        {greeting.text}
      </span>
    </header>
  );
}
