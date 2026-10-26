/**
 * met.no weather (Wave 8 header + home calendar forecast icons; met.no swap 2026-08-29). No API
 * key, but met.no's ToS requires an identifying User-Agent — the Rust side (repo/weather.rs)
 * sends one, so all fetching happens through the `weather_forecast` command, never straight
 * `fetch()` from the webview (also why there's no CSP entry for it — Rust makes the request).
 * Attribution (CC BY 4.0) is shown in Settings→Weather (WeatherSection.tsx).
 *
 * - Geocode once when the user sets a city in Settings; store coords (via geocode_search, the
 *   same Nominatim-backed command the map picker uses).
 * - One network call per location per hour: `weather_forecast` returns met.no's raw timeseries,
 *   cached here; current/daily/hourly are all derived (pure, no I/O) from that single cache.
 * - Offline / failure: return null (header/calendar quietly omit weather — decoration, never
 *   blocks or errors).
 * - °C only (no unit toggle — no over-design).
 */
import type { ComponentType } from "react";
import type { IconProps } from "../components/icons";
import { callSilent } from "./invoke";
import { reportFallback } from "./diag";
import { useSettingsStore } from "../stores/settings";
import type { GeocodeSearchOutput, WeatherEntry, WeatherForecastOutput } from "./commands.gen";
import {
  IconWeatherSun,
  IconWeatherCloudSun,
  IconWeatherCloud,
  IconWeatherFog,
  IconWeatherRain,
  IconWeatherSnow,
  IconWeatherShowers,
  IconWeatherThunder,
} from "../components/icons";

export interface WeatherLocation {
  city: string;
  lat: number;
  lng: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Which link of the location priority chain resolved the header's weather. */
export type WeatherSourceKind = "workspace" | "notes";

export interface ResolvedWeatherLocation extends LatLng {
  source: WeatherSourceKind;
}

export interface WeatherSnapshot {
  /** Rounded °C */
  tempC: number;
  /** WMO weather interpretation code (mapped from met.no's symbol_code — see symbolCodeToWmo) */
  weatherCode: number;
  /** i18n key under home.weather_* */
  labelKey: string;
  fetchedAt: number;
}

/** Daily forecast (met.no gives ~9 days, not Open-Meteo's 16 — consumers match by string
 *  equality so a short forecast just leaves later calendar days blank, nothing more).  Arrays
 *  parallel-indexed by `time[i]`. `time` entries are **device-local** dates ("YYYY-MM-DD",
 *  grouped from met.no's UTC timestamps via the JS Date getters) — match against calendar grid
 *  days by string equality, never by re-deriving through a Date object. `timezone` is no longer
 *  populated (met.no doesn't report one, unlike Open-Meteo's timezone=auto) — left `undefined`;
 *  consumers already treat it as optional. */
export interface DailyForecast {
  time: string[];
  weatherCode: number[];
  tempMaxC: number[];
  tempMinC: number[];
  timezone?: string;
  fetchedAt: number;
}

/** Hourly forecast for today (canvas daily tracker's per-hour weather strip), arrays
 *  parallel-indexed by `time[i]`. Same string-equality rule as DailyForecast: entries are
 *  device-local wall-clock "YYYY-MM-DDTHH:00" — never re-derive them through Date. */
export interface HourlyForecast {
  time: string[];
  tempC: number[];
  weatherCode: number[];
  fetchedAt: number;
}

const CACHE_MS = 60 * 60 * 1000; // 1 hour

/** Single shared cache of met.no's raw (flattened) timeseries per location — fetchWeather/
 *  fetchDailyForecast/fetchHourlyForecast/cachedWeather all derive from this instead of each
 *  keeping their own copy, so a location only costs one `weather_forecast` round trip per hour
 *  no matter how many of the four are called. */
let rawCache: { key: string; entries: WeatherEntry[]; fetchedAt: number } | null = null;

/** Map WMO codes to coarse i18n keys (home.weather_*). Unchanged by the met.no swap — every
 *  downstream consumer (icon/color/label) stays on the WMO vocabulary; only the fetch layer
 *  below translates met.no's own symbol_code into these numbers (symbolCodeToWmo). */
export function weatherLabelKey(code: number): string {
  // https://open-meteo.com/en/docs — WMO Weather interpretation codes
  if (code === 0) return "home.weather_clear";
  if (code === 1 || code === 2) return "home.weather_partly_cloudy";
  if (code === 3) return "home.weather_overcast";
  if (code === 45 || code === 48) return "home.weather_fog";
  if (code >= 51 && code <= 67) return "home.weather_rain";
  if (code >= 71 && code <= 77) return "home.weather_snow";
  if (code >= 80 && code <= 82) return "home.weather_showers";
  if (code >= 85 && code <= 86) return "home.weather_snow";
  if (code >= 95 && code <= 99) return "home.weather_thunder";
  return "home.weather_unknown";
}

// Derived FROM weatherLabelKey (not a parallel range check) so the two can never disagree on a
// bucket boundary — that agreement is the whole point of this indirection.
const LABEL_KEY_TO_ICON: Record<string, ComponentType<IconProps>> = {
  "home.weather_clear": IconWeatherSun,
  "home.weather_partly_cloudy": IconWeatherCloudSun,
  "home.weather_overcast": IconWeatherCloud,
  "home.weather_fog": IconWeatherFog,
  "home.weather_rain": IconWeatherRain,
  "home.weather_snow": IconWeatherSnow,
  "home.weather_showers": IconWeatherShowers,
  "home.weather_thunder": IconWeatherThunder,
  "home.weather_unknown": IconWeatherCloud,
};

// Base color per weatherLabelKey bucket (tokens.css — Home calendar day-cell forecast icon
// colors). "Showers" is already the heavy-rain bucket (WMO 80-82), so its base tone IS the
// "strong" rain tone — see HEAVY_CODES below for the escalation within the shared rain/snow
// buckets that weatherLabelKey does NOT split (heavy rain/snow keep the same label text as their
// light counterparts, only the icon color escalates).
const LABEL_KEY_TO_COLOR_VAR: Record<string, string> = {
  "home.weather_clear": "var(--weather-warm)",
  "home.weather_partly_cloudy": "var(--weather-partly)",
  "home.weather_overcast": "var(--muted)",
  "home.weather_fog": "var(--faint)",
  "home.weather_rain": "var(--weather-rain)",
  "home.weather_snow": "var(--weather-snow)",
  "home.weather_showers": "var(--weather-rain-strong)",
  "home.weather_thunder": "var(--weather-thunder)",
  "home.weather_unknown": "var(--faint)",
};

// WMO codes for the "heavy" tier within a bucket weatherLabelKey doesn't split further: 65/67 =
// heavy (freezing) rain, 75 = heavy snow fall, 86 = heavy snow showers. These escalate to the
// bucket's stronger color variant without changing the label text or the icon shape.
const HEAVY_CODES = new Set([65, 67, 75, 86]);

// 폭염주의보 (heatwave advisory) / 한파주의보 (cold-wave advisory) thresholds — Korea
// Meteorological Administration. Drive the calendar day-cell's extreme-weather color emphasis.
export const HEATWAVE_TEMP_MAX_C = 33;
export const COLDWAVE_TEMP_MIN_C = -12;

/** WMO code (+ optional day max °C) → { Icon, colorVar } for the home calendar's colored
 *  day-cell forecast icon. Icon selection is unchanged from the old weatherCodeToIcon (still
 *  derived from weatherLabelKey, so bucket boundaries never disagree with the label); colorVar
 *  layers condition color + heavy-tier/heatwave escalation on top. */
export function weatherCodeToVisual(
  code: number,
  tempMaxC?: number
): { Icon: ComponentType<IconProps>; colorVar: string } {
  const labelKey = weatherLabelKey(code);
  const Icon = LABEL_KEY_TO_ICON[labelKey] ?? IconWeatherCloud;
  let colorVar = LABEL_KEY_TO_COLOR_VAR[labelKey] ?? "var(--faint)";
  if (HEAVY_CODES.has(code)) {
    if (labelKey === "home.weather_rain") colorVar = "var(--weather-rain-strong)";
    else if (labelKey === "home.weather_snow") colorVar = "var(--weather-snow-strong)";
  } else if (
    labelKey === "home.weather_clear" &&
    typeof tempMaxC === "number" &&
    tempMaxC >= HEATWAVE_TEMP_MAX_C
  ) {
    // Heatwave: sun icon shifts to the hotter warning tone (reuses --danger-soft, the existing
    // amber/orange warning token, instead of adding a second amber hex).
    colorVar = "var(--danger-soft)";
  }
  return { Icon, colorVar };
}

/** Day-cell max-temp text color: muted by default, overridden to the warning/cold status tone at
 *  the heatwave/cold-wave thresholds above (reuses --danger/--info — no new tokens). */
export function weatherTempColorVar(tempMaxC?: number, tempMinC?: number): string {
  if (typeof tempMaxC === "number" && tempMaxC >= HEATWAVE_TEMP_MAX_C) return "var(--danger)";
  if (typeof tempMinC === "number" && tempMinC <= COLDWAVE_TEMP_MIN_C) return "var(--info)";
  return "var(--muted)";
}

// met.no symbol_code base forms (suffix `_day`/`_night`/`_polartwilight` stripped) → WMO code.
// https://api.met.no/weatherapi/weathericon/2.0/documentation — symbol vocabulary.
const SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightrainshowers: 80,
  rainshowers: 80,
  heavyrainshowers: 82,
  lightsleet: 67,
  sleet: 67,
  heavysleet: 67,
  lightsleetshowers: 67,
  sleetshowers: 67,
  heavysleetshowers: 67,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightsnowshowers: 85,
  snowshowers: 85,
  heavysnowshowers: 86,
};

/** met.no symbol_code (e.g. "partlycloudy_day", or absent) → WMO interpretation code, so every
 *  downstream consumer (icon/color/label, weatherLabelKey and friends above) keeps working on
 *  the WMO vocabulary unmodified. Missing or unrecognized → 3 (overcast) fallback. */
export function symbolCodeToWmo(symbolCode: string | null | undefined): number {
  if (!symbolCode) return 3;
  const base = symbolCode.replace(/_(day|night|polartwilight)$/, "");
  if (base.includes("thunder")) return 95;
  const wmo = SYMBOL_TO_WMO[base];
  if (wmo === undefined) {
    // A(AUDIT-2026-09-26): met.no가 이 표에 없는 symbol_code를 보내면 조용히 흐림(3)으로
    // 접는다 — 그 자체는 의도된 폴백이지만(met.no 심볼 사전이 늘어날 수 있다), 얼마나 자주
    // 접히는지는 지금까지 아무 데도 안 남았다.
    reportFallback("weather", "unknown_symbol_code", base);
    return 3;
  }
  return wmo;
}

export async function geocodeCity(city: string): Promise<WeatherLocation | null> {
  const q = city.trim();
  if (!q) return null;
  try {
    const res = await callSilent<GeocodeSearchOutput>("geocode_search", { query: q });
    const hit = res.results?.[0];
    if (!hit) return null;
    return { city: hit.label, lat: hit.lat, lng: hit.lng };
  } catch {
    return null;
  }
}

function cacheKey(loc: LatLng): string {
  return `${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
}

/** Local calendar-date key ("YYYY-MM-DD") from a Date's own local getters — never through
 *  toISOString (that's UTC and would misfile entries near local midnight). */
function localDateKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDateKey(isoUtc: string): string | null {
  const d = new Date(isoUtc);
  return Number.isNaN(d.getTime()) ? null : localDateKeyFromDate(d);
}

/** Fetch (or serve from the 1h cache) met.no's raw flattened timeseries for a location. Every
 *  exported fetch* function below derives its shape from this — the only thing that ever calls
 *  the `weather_forecast` command. */
type RawResult = { entries: WeatherEntry[]; fetchedAt: number } | null;
/** 진행 중 요청 공유 — Promise.all 로 current/daily/hourly 가 동시에 부르면 캐시가 아직 비어 3번 나가던 것을 1번으로. */
let inflight: { key: string; p: Promise<RawResult> } | null = null;

function fetchRaw(loc: LatLng): Promise<RawResult> {
  const key = cacheKey(loc);
  if (rawCache && rawCache.key === key && Date.now() - rawCache.fetchedAt < CACHE_MS) {
    return Promise.resolve(rawCache);
  }
  if (inflight && inflight.key === key) return inflight.p;
  const p = fetchRawUncached(loc, key).finally(() => {
    if (inflight?.p === p) inflight = null;
  });
  inflight = { key, p };
  return p;
}

async function fetchRawUncached(loc: LatLng, key: string): Promise<RawResult> {
  const now = Date.now();
  try {
    const res = await callSilent<WeatherForecastOutput>("weather_forecast", {
      lat: loc.lat,
      lng: loc.lng,
    });
    // Shape-validate like the old per-endpoint Array.isArray checks did — a malformed/unexpected
    // response (e.g. an unmocked call() in an unrelated test, or a future backend drift) must
    // fail the same quiet way as a network error, not throw out of dailyFromEntries's `for...of`.
    if (!Array.isArray(res?.entries)) return null;
    rawCache = { key, entries: res.entries, fetchedAt: now };
    return rawCache;
  } catch (e) {
    // Offline / IO — quiet omit (decoration, never blocks). A(AUDIT-2026-09-26): now at least
    // leaves a diag trail so "weather never shows up" is diagnosable after the fact.
    reportFallback("weather", "fetch_failed", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Nearest-to-now entry (past or future, whichever |Δt| is smaller). */
function nearestEntry(entries: WeatherEntry[], nowMs: number): WeatherEntry | null {
  let best: WeatherEntry | null = null;
  let bestDelta = Infinity;
  for (const e of entries) {
    const t = Date.parse(e.time);
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - nowMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = e;
    }
  }
  return best;
}

/** Nearest-to-now entry → current WeatherSnapshot. */
function snapshotFromEntries(entries: WeatherEntry[], fetchedAt: number): WeatherSnapshot | null {
  const best = nearestEntry(entries, Date.now());
  if (!best) return null;
  const code = symbolCodeToWmo(best.symbol_1h ?? best.symbol_6h);
  return { tempC: Math.round(best.temp_c), weatherCode: code, labelKey: weatherLabelKey(code), fetchedAt };
}

/** Group entries by device-local date; per day, max/min from the next_6_hours envelope (falling
 *  back to the instant temp when a day has no 6h envelope reading), weatherCode = the day's
 *  *worst* mapped WMO code. */
function dailyFromEntries(entries: WeatherEntry[], fetchedAt: number): DailyForecast {
  const byDay = new Map<string, WeatherEntry[]>();
  for (const e of entries) {
    const key = localDateKey(e.time);
    if (!key) continue;
    const list = byDay.get(key);
    if (list) list.push(e);
    else byDay.set(key, [e]);
  }

  const time: string[] = [];
  const weatherCode: number[] = [];
  const tempMaxC: number[] = [];
  const tempMinC: number[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayEntries = byDay.get(day)!;
    const maxima = dayEntries.map((e) => e.temp_max_6h).filter((v): v is number => v != null);
    const minima = dayEntries.map((e) => e.temp_min_6h).filter((v): v is number => v != null);
    const temps = dayEntries.map((e) => e.temp_c);
    const codes = dayEntries.map((e) => symbolCodeToWmo(e.symbol_1h ?? e.symbol_6h));
    time.push(day);
    tempMaxC.push(maxima.length ? Math.max(...maxima) : Math.max(...temps));
    tempMinC.push(minima.length ? Math.min(...minima) : Math.min(...temps));
    // ponytail: "worst code wins" is a severity approximation (higher WMO number ≠ strictly
    // worse in general), not a real multi-condition weather rule — good enough for a calendar
    // day-cell icon, upgrade to a real priority table if that ever matters.
    weatherCode.push(codes.length ? Math.max(...codes) : 3);
  }
  return { time, weatherCode, tempMaxC, tempMinC, fetchedAt };
}

/** Today's (device-local) entries that carry a symbol_1h, one point per met.no timeseries hour. */
function hourlyFromEntries(entries: WeatherEntry[], fetchedAt: number): HourlyForecast {
  const todayKey = localDateKeyFromDate(new Date());
  const time: string[] = [];
  const tempC: number[] = [];
  const weatherCode: number[] = [];
  for (const e of entries) {
    if (!e.symbol_1h) continue;
    const d = new Date(e.time);
    if (Number.isNaN(d.getTime()) || localDateKeyFromDate(d) !== todayKey) continue;
    time.push(`${todayKey}T${String(d.getHours()).padStart(2, "0")}:00`);
    tempC.push(e.temp_c);
    weatherCode.push(symbolCodeToWmo(e.symbol_1h));
  }
  return { time, tempC, weatherCode, fetchedAt };
}

/** Fetch current weather; uses the shared 1h cache. Returns null on any failure. */
export async function fetchWeather(loc: LatLng): Promise<WeatherSnapshot | null> {
  const raw = await fetchRaw(loc);
  return raw ? snapshotFromEntries(raw.entries, raw.fetchedAt) : null;
}

/** 캐시된 현재 날씨를 **fetch 없이** 읽는다(없으면 null). 헤더 하늘 그라데이션(lib/skyGradient)의
 *  날씨 보정 입력 경로 — WeatherSlot이 이미 채워둔 1시간 캐시를 그대로 재사용하므로 새 API 호출도,
 *  같은 좌표를 두 번 긁는 레이스도 없다. 아직 캐시가 비었으면(첫 렌더) null → 다음 분 틱에서 잡힌다. */
export function cachedWeather(loc: LatLng): WeatherSnapshot | null {
  const key = cacheKey(loc);
  if (rawCache && rawCache.key === key && Date.now() - rawCache.fetchedAt < CACHE_MS) {
    return snapshotFromEntries(rawCache.entries, rawCache.fetchedAt);
  }
  return null;
}

/** Fetch a daily forecast (weather code + max/min °C, ~9 days from met.no); uses the shared 1h
 *  cache. Null on failure — weather is decoration for the calendar's day cells, never a
 *  blocking/error state. */
export async function fetchDailyForecast(loc: LatLng): Promise<DailyForecast | null> {
  const raw = await fetchRaw(loc);
  return raw ? dailyFromEntries(raw.entries, raw.fetchedAt) : null;
}

/** Fetch today's hourly forecast (temp + weather code per local hour); shares the same cache as
 *  fetchDailyForecast/fetchWeather. Null on failure — decoration for the daily tracker's weather
 *  strip, never a blocking/error state. */
export async function fetchHourlyForecast(loc: LatLng): Promise<HourlyForecast | null> {
  const raw = await fetchRaw(loc);
  return raw ? hourlyFromEntries(raw.entries, raw.fetchedAt) : null;
}

/** 현재 상세 지표 — met.no 응답에 **실제로 있는 값만**(없으면 null, 만들어내지 않는다). 체감온도만 기온·풍속·습도로 계산. */
export interface WeatherDetail {
  feelsLikeC: number | null;
  humidityPct: number | null;
  windMs: number | null;
  /** 강수 확률(%) — 응답에 없으면 null(강수량 precipMm 만 있을 수 있다). */
  precipPct: number | null;
  precipMm: number | null;
  pressureHpa: number | null;
  uvIndex: number | null;
}

/** 앞으로의 한 시간 — 시간별 스타일용. `time` 은 device-local "YYYY-MM-DDTHH:00". */
export interface UpcomingHour {
  time: string;
  tempC: number;
  weatherCode: number;
  precipPct: number | null;
}

export interface WeatherExtras {
  detail: WeatherDetail;
  upcoming: UpcomingHour[];
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** 체감온도(Steadman apparent temperature, 실내 복사 무시형) — 습도·풍속 중 하나라도 없으면 null. */
export function apparentTempC(tempC: number, windMs: number | null, humidityPct: number | null): number | null {
  if (windMs === null || humidityPct === null) return null;
  const e = (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  return Math.round(tempC + 0.33 * e - 0.7 * windMs - 4);
}

export function detailFromEntries(entries: WeatherEntry[], nowMs: number = Date.now()): WeatherDetail | null {
  const e = nearestEntry(entries, nowMs);
  if (!e) return null;
  const humidity = num(e.humidity_pct);
  const wind = num(e.wind_ms);
  const uv = num(e.uv_index);
  return {
    feelsLikeC: apparentTempC(e.temp_c, wind, humidity),
    humidityPct: humidity === null ? null : Math.round(humidity),
    windMs: round1(wind),
    precipPct: num(e.precip_prob_pct) === null ? null : Math.round(num(e.precip_prob_pct)!),
    precipMm: round1(num(e.precip_mm)),
    pressureHpa: num(e.pressure_hpa) === null ? null : Math.round(num(e.pressure_hpa)!),
    uvIndex: round1(uv),
  };
}

/** 지금 시간(이미 시작된 시각 포함)부터 최대 n 개 — 자정을 넘겨도 이어진다. */
export function upcomingFromEntries(entries: WeatherEntry[], nowMs: number, n: number): UpcomingHour[] {
  const out: UpcomingHour[] = [];
  for (const e of entries) {
    if (out.length >= n) break;
    if (!e.symbol_1h) continue;
    const t = Date.parse(e.time);
    if (Number.isNaN(t) || t <= nowMs - 60 * 60 * 1000) continue;
    const d = new Date(t);
    out.push({
      time: `${localDateKeyFromDate(d)}T${String(d.getHours()).padStart(2, "0")}:00`,
      tempC: e.temp_c,
      weatherCode: symbolCodeToWmo(e.symbol_1h),
      precipPct: num(e.precip_prob_pct),
    });
  }
  return out;
}

/** 상세 지표 + 앞으로의 시간별 — 같은 1시간 캐시에서 파생(추가 네트워크 없음). 실패는 null(fetchRaw 가 이미 기록). */
export async function fetchWeatherExtras(loc: LatLng, maxHours = 9): Promise<WeatherExtras | null> {
  const raw = await fetchRaw(loc);
  if (!raw) return null;
  const now = Date.now();
  const detail = detailFromEntries(raw.entries, now);
  return detail ? { detail, upcoming: upcomingFromEntries(raw.entries, now, maxHours) } : null;
}

export interface WeekDay {
  date: string;
  weatherCode: number;
  tempMaxC: number;
  tempMinC: number;
}

/** 일별 예보에서 오늘부터 최대 n 일(met.no 는 ~9일 — 짧으면 있는 만큼). 지난 날짜는 뺀다. */
export function weekFromDaily(daily: DailyForecast | null, todayKey: string, n = 7): WeekDay[] {
  if (!daily) return [];
  const out: WeekDay[] = [];
  for (let i = 0; i < daily.time.length && out.length < n; i++) {
    if (daily.time[i] < todayKey) continue;
    out.push({ date: daily.time[i], weatherCode: daily.weatherCode[i], tempMaxC: daily.tempMaxC[i], tempMinC: daily.tempMinC[i] });
  }
  return out;
}

/**
 * "사용자가 저장해 둔 위치" 한 지점 — 훅이 아닌 곳(AI 컨텍스트의 `weather` 참조)이 쓴다.
 * 판정 규칙은 useWeatherLocation 의 첫 고리와 같다(명시적으로 커스터마이즈한 지도 기본 위치만).
 * 노트 좌표 클러스터·공장 기본값 폴백은 **일부러 뺐다** — 홈 화면의 장식은 아무 위치나 보여도
 * 되지만, 프롬프트에 붙는 날씨는 사용자가 고른 곳이 아니면 거짓말이 된다.
 */
export function savedWeatherLocation(): LatLng | null {
  const s = useSettingsStore.getState();
  // PLAN-2026-09-15 R3: 기준 지역 마스터가 꺼져 있으면 위치가 없다 — useWeatherLocation 의
  // 게이트와 같은 판정이고, 이 함수를 지나는 AI 컨텍스트의 지역/날씨 줄이 통째로 빠진다.
  if (!s.regionEnabled) return null;
  return s.defaultMapLocationCustomized ? s.defaultMapLocation : null;
}

/** Test helper — clear the module cache. */
export function clearWeatherCache(): void {
  rawCache = null;
  inflight = null;
}

/**
 * Location priority chain for the header weather (single input: unified onto the one
 * Map-settings location — 2026-08-05 removed the separate Settings→Weather city field):
 *   1. workspace default location (Settings→Map / onboarding's "where do you live" step —
 *      settings.defaultMapLocation; `null` here means "not customized", see caller)
 *   2. most-common location among the notes already loaded client-side
 * Returns null (quiet omit) when nothing is available.
 */
export function resolveWeatherLocation(
  workspaceDefault: LatLng | null,
  noteCoords: LatLng[]
): ResolvedWeatherLocation | null {
  if (workspaceDefault) return { ...workspaceDefault, source: "workspace" };
  const cluster = mostCommonLocation(noteCoords);
  return cluster ? { ...cluster, source: "notes" } : null;
}

// ponytail: 1°-bucket mode (~111km cells), not real geo-clustering — good enough to pick "the
// region most of your notes are near"; upgrade to a real clustering pass if that ever matters.
function mostCommonLocation(coords: LatLng[]): LatLng | null {
  if (coords.length === 0) return null;
  const buckets = new Map<string, LatLng[]>();
  for (const c of coords) {
    const key = `${Math.round(c.lat)},${Math.round(c.lng)}`;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  let best: LatLng[] = [];
  for (const list of buckets.values()) {
    if (list.length > best.length) best = list;
  }
  return {
    lat: best.reduce((s, c) => s + c.lat, 0) / best.length,
    lng: best.reduce((s, c) => s + c.lng, 0) / best.length,
  };
}
