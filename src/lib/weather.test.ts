import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cachedWeather,
  clearWeatherCache,
  COLDWAVE_TEMP_MIN_C,
  fetchDailyForecast,
  fetchHourlyForecast,
  fetchWeather,
  geocodeCity,
  HEATWAVE_TEMP_MAX_C,
  resolveWeatherLocation,
  symbolCodeToWmo,
  weatherCodeToVisual,
  weatherLabelKey,
  weatherTempColorVar,
} from "./weather";
import {
  IconWeatherCloud,
  IconWeatherCloudSun,
  IconWeatherFog,
  IconWeatherRain,
  IconWeatherShowers,
  IconWeatherSnow,
  IconWeatherSun,
  IconWeatherThunder,
} from "../components/icons";

// Manual-wrapper mock (matches WeatherSection.test.tsx's proven pattern for this module) rather
// than vi.spyOn — weather.ts talks to the backend exclusively through callSilent now.
const callSilentMock = vi.fn();
vi.mock("./invoke", () => ({
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

// A(AUDIT-2026-09-26): weather fetch failure / unknown symbol_code are now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("./diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

/** Independent test oracle for "local calendar date from an ISO instant" — deliberately
 *  re-derived here (not imported from weather.ts) so the test doesn't just echo the
 *  implementation, but still timezone-safe (matches whatever TZ the test runner is in). */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("weatherLabelKey", () => {
  it("maps WMO codes to home.weather_* keys", () => {
    expect(weatherLabelKey(0)).toBe("home.weather_clear");
    expect(weatherLabelKey(3)).toBe("home.weather_overcast");
    expect(weatherLabelKey(61)).toBe("home.weather_rain");
    expect(weatherLabelKey(95)).toBe("home.weather_thunder");
  });
});

describe("weatherCodeToVisual", () => {
  // Every code here must agree with weatherLabelKey's bucket boundaries — the Icon half of
  // weatherCodeToVisual is derived from weatherLabelKey internally (unchanged from the old
  // weatherCodeToIcon), so this doubles as a regression test for that indirection staying intact.
  it("picks one icon per weatherLabelKey bucket, covering representative WMO codes", () => {
    expect(weatherCodeToVisual(0).Icon).toBe(IconWeatherSun); // clear
    expect(weatherCodeToVisual(1).Icon).toBe(IconWeatherCloudSun); // partly cloudy
    expect(weatherCodeToVisual(2).Icon).toBe(IconWeatherCloudSun);
    expect(weatherCodeToVisual(3).Icon).toBe(IconWeatherCloud); // overcast
    expect(weatherCodeToVisual(45).Icon).toBe(IconWeatherFog);
    expect(weatherCodeToVisual(48).Icon).toBe(IconWeatherFog);
    expect(weatherCodeToVisual(51).Icon).toBe(IconWeatherRain); // rain bucket: 51-67
    expect(weatherCodeToVisual(61).Icon).toBe(IconWeatherRain);
    expect(weatherCodeToVisual(67).Icon).toBe(IconWeatherRain);
    expect(weatherCodeToVisual(71).Icon).toBe(IconWeatherSnow); // snow: 71-77
    expect(weatherCodeToVisual(85).Icon).toBe(IconWeatherSnow); // snow: 85-86
    expect(weatherCodeToVisual(80).Icon).toBe(IconWeatherShowers); // showers: 80-82
    expect(weatherCodeToVisual(95).Icon).toBe(IconWeatherThunder);
    expect(weatherCodeToVisual(99).Icon).toBe(IconWeatherThunder);
    expect(weatherCodeToVisual(12345).Icon).toBe(IconWeatherCloud); // unknown fallback, same as weatherLabelKey
  });

  it("never disagrees with weatherLabelKey on ICON: same label key ⇒ same icon", () => {
    // Deliberately excludes the HEAVY_CODES sub-variant codes (65/67/75/86 mixed with their
    // light counterparts within one bucket) — those intentionally diverge on colorVar while
    // staying on the same Icon/label, covered by the heavy-tier test below instead.
    const codes = [0, 1, 2, 3, 45, 48, 51, 55, 61, 80, 82, 85, 95, 99, 2 ** 20];
    const byLabel = new Map<string, ReturnType<typeof weatherCodeToVisual>["Icon"]>();
    for (const code of codes) {
      const label = weatherLabelKey(code);
      const icon = weatherCodeToVisual(code).Icon;
      const seen = byLabel.get(label);
      if (seen) expect(icon).toBe(seen);
      else byLabel.set(label, icon);
    }
  });

  it("colors each condition bucket, calm/muted grays for overcast+fog", () => {
    expect(weatherCodeToVisual(0).colorVar).toBe("var(--weather-warm)"); // clear
    expect(weatherCodeToVisual(1).colorVar).toBe("var(--weather-partly)");
    expect(weatherCodeToVisual(3).colorVar).toBe("var(--muted)"); // overcast
    expect(weatherCodeToVisual(45).colorVar).toBe("var(--faint)"); // fog, softer than overcast
    expect(weatherCodeToVisual(51).colorVar).toBe("var(--weather-rain)");
    expect(weatherCodeToVisual(71).colorVar).toBe("var(--weather-snow)");
    expect(weatherCodeToVisual(95).colorVar).toBe("var(--weather-thunder)");
  });

  it("escalates heavy rain/snow codes to the bucket's stronger tone, same tone as showers", () => {
    // Showers (80-82) is already the "heavy rain" bucket per the owner's palette spec
    // ("heavy rain/showers=deeper blue") — its base tone equals the escalated heavy-rain tone.
    expect(weatherCodeToVisual(65).colorVar).toBe("var(--weather-rain-strong)"); // heavy rain
    expect(weatherCodeToVisual(67).colorVar).toBe("var(--weather-rain-strong)"); // heavy freezing rain
    expect(weatherCodeToVisual(80).colorVar).toBe("var(--weather-rain-strong)"); // showers bucket base
    expect(weatherCodeToVisual(51).colorVar).not.toBe("var(--weather-rain-strong)"); // light drizzle stays base

    expect(weatherCodeToVisual(75).colorVar).toBe("var(--weather-snow-strong)"); // heavy snow fall
    expect(weatherCodeToVisual(86).colorVar).toBe("var(--weather-snow-strong)"); // heavy snow showers
    expect(weatherCodeToVisual(71).colorVar).toBe("var(--weather-snow)"); // light snow stays base
    expect(weatherCodeToVisual(85).colorVar).toBe("var(--weather-snow)"); // light snow showers stays base

    // Heavy codes still share the SAME icon/label as their light counterparts (bucket boundary
    // intact) — only the color escalates.
    expect(weatherCodeToVisual(75).Icon).toBe(weatherCodeToVisual(71).Icon);
    expect(weatherLabelKey(75)).toBe(weatherLabelKey(71));
  });

  it("heatwave (tempMax >= 33) shifts the clear/sun icon to the hotter warning tone", () => {
    expect(weatherCodeToVisual(0, 33).colorVar).toBe("var(--danger-soft)"); // boundary, inclusive
    expect(weatherCodeToVisual(0, 32.9).colorVar).toBe("var(--weather-warm)"); // just under, unaffected
    expect(weatherCodeToVisual(0).colorVar).toBe("var(--weather-warm)"); // tempMax omitted, unaffected
    expect(weatherCodeToVisual(3, 40).colorVar).toBe("var(--muted)"); // heatwave escalation is sun-only
  });
});

describe("weatherTempColorVar", () => {
  it("uses the Korea Meteorological Administration heatwave/cold-wave advisory thresholds", () => {
    expect(HEATWAVE_TEMP_MAX_C).toBe(33);
    expect(COLDWAVE_TEMP_MIN_C).toBe(-12);
  });

  it("heatwave (tempMax >= 33) renders the temp in the warning tone, boundary inclusive", () => {
    expect(weatherTempColorVar(33, 20)).toBe("var(--danger)");
    expect(weatherTempColorVar(35, 20)).toBe("var(--danger)");
    expect(weatherTempColorVar(32.9, 20)).toBe("var(--muted)");
  });

  it("cold wave (tempMin <= -12) renders the temp in the cold tone, boundary inclusive", () => {
    expect(weatherTempColorVar(-5, -12)).toBe("var(--info)");
    expect(weatherTempColorVar(-5, -20)).toBe("var(--info)");
    expect(weatherTempColorVar(-5, -11.9)).toBe("var(--muted)");
  });

  it("defaults to muted for ordinary temps or missing data", () => {
    expect(weatherTempColorVar(20, 10)).toBe("var(--muted)");
    expect(weatherTempColorVar()).toBe("var(--muted)");
    expect(weatherTempColorVar(undefined, -20)).toBe("var(--info)");
  });
});

describe("symbolCodeToWmo (met.no symbol_code -> WMO code)", () => {
  it("maps representative base forms regardless of _day/_night/_polartwilight suffix", () => {
    expect(symbolCodeToWmo("clearsky_day")).toBe(0);
    expect(symbolCodeToWmo("fair_night")).toBe(1);
    expect(symbolCodeToWmo("partlycloudy_polartwilight")).toBe(2);
    expect(symbolCodeToWmo("cloudy")).toBe(3);
    expect(symbolCodeToWmo("fog")).toBe(45);
    expect(symbolCodeToWmo("lightrain")).toBe(61);
    expect(symbolCodeToWmo("rain")).toBe(63);
    expect(symbolCodeToWmo("heavyrain_day")).toBe(65);
    expect(symbolCodeToWmo("lightrainshowers_day")).toBe(80);
    expect(symbolCodeToWmo("rainshowers_night")).toBe(80);
    expect(symbolCodeToWmo("heavyrainshowers_day")).toBe(82);
    expect(symbolCodeToWmo("lightsleet")).toBe(67);
    expect(symbolCodeToWmo("sleetshowers_day")).toBe(67);
    expect(symbolCodeToWmo("lightsnow")).toBe(71);
    expect(symbolCodeToWmo("snow")).toBe(73);
    expect(symbolCodeToWmo("heavysnow_night")).toBe(75);
    expect(symbolCodeToWmo("snowshowers_day")).toBe(85);
    expect(symbolCodeToWmo("heavysnowshowers")).toBe(86);
  });

  it("maps every *thunder* base form to WMO 95 regardless of the rest of the name", () => {
    expect(symbolCodeToWmo("thunder")).toBe(95);
    expect(symbolCodeToWmo("rainandthunder_day")).toBe(95);
    expect(symbolCodeToWmo("heavysnowandthunder_polartwilight")).toBe(95);
  });

  it("falls back to WMO 3 (overcast) for a missing or unrecognized symbol", () => {
    expect(symbolCodeToWmo(null)).toBe(3);
    expect(symbolCodeToWmo(undefined)).toBe(3);
    expect(symbolCodeToWmo("")).toBe(3);
    expect(symbolCodeToWmo("some_unknown_symbol")).toBe(3);
  });

  // A(AUDIT-2026-09-26): an unrecognized symbol_code is reported (once, per call) — a missing/empty
  // symbol_code (met.no simply omitted it) is a different, non-corrupt case and must NOT report.
  it("reports a fallback only for a genuinely unrecognized symbol_code, not a missing one", () => {
    reportFallbackMock.mockClear();
    symbolCodeToWmo(null);
    symbolCodeToWmo(undefined);
    symbolCodeToWmo("");
    expect(reportFallbackMock).not.toHaveBeenCalled();

    symbolCodeToWmo("some_unknown_symbol_day");
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock).toHaveBeenCalledWith("weather", "unknown_symbol_code", "some_unknown_symbol");
  });
});

describe("geocodeCity (geocode_search backend)", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
  });

  it("returns null for an empty query without calling the backend", async () => {
    expect(await geocodeCity("  ")).toBeNull();
    expect(callSilentMock).not.toHaveBeenCalled();
  });

  it("returns null when geocode_search fails", async () => {
    callSilentMock.mockRejectedValue(new Error("offline"));
    expect(await geocodeCity("Seoul")).toBeNull();
  });

  it("returns null when there are no results", async () => {
    callSilentMock.mockResolvedValue({ results: [] });
    expect(await geocodeCity("Nowhere")).toBeNull();
  });

  it("maps the first geocode_search result as-is (label -> city)", async () => {
    callSilentMock.mockResolvedValue({
      results: [{ label: "Seoul, South Korea", lat: 37.5665, lng: 126.978 }],
    });
    const loc = await geocodeCity("Seoul");
    expect(loc).toEqual({ city: "Seoul, South Korea", lat: 37.5665, lng: 126.978 });
    expect(callSilentMock).toHaveBeenCalledWith("geocode_search", { query: "Seoul" });
  });
});

describe("fetchWeather / cachedWeather / fetchDailyForecast / fetchHourlyForecast (shared met.no cache)", () => {
  // Pinned local noon, far from any midnight rollover, so hour/day offsets below land on
  // predictable local calendar days regardless of the test runner's timezone.
  const NOON = new Date(2026, 7, 29, 12, 0, 0);

  function isoAt(hoursFromNoon: number): string {
    return new Date(NOON.getTime() + hoursFromNoon * 3600_000).toISOString();
  }

  // yesterday(local) / today(local, 3 points straddling "now") / tomorrow(local, no symbol at all)
  const entries = [
    { time: isoAt(-24), temp_c: 18, symbol_1h: "cloudy", symbol_6h: null, temp_max_6h: 19, temp_min_6h: 15 },
    { time: isoAt(-1), temp_c: 22, symbol_1h: "partlycloudy_day", symbol_6h: "rain", temp_max_6h: 25, temp_min_6h: 20 },
    { time: isoAt(0.25), temp_c: 23, symbol_1h: "rain", symbol_6h: "rain", temp_max_6h: 26, temp_min_6h: 20 },
    { time: isoAt(2), temp_c: 24, symbol_1h: "heavyrain", symbol_6h: null, temp_max_6h: 27, temp_min_6h: 21 },
    { time: isoAt(30), temp_c: 15, symbol_1h: null, symbol_6h: null, temp_max_6h: null, temp_min_6h: null },
  ];

  beforeEach(() => {
    clearWeatherCache();
    callSilentMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchWeather picks the entry nearest to now and maps its symbol to a WMO code", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const snap = await fetchWeather({ lat: 37.57, lng: 126.98 });
    expect(snap?.tempC).toBe(23); // isoAt(0.25) is 15min away, nearer than isoAt(-1)'s 1h
    expect(snap?.weatherCode).toBe(symbolCodeToWmo("rain"));
    expect(snap?.labelKey).toBe(weatherLabelKey(symbolCodeToWmo("rain")));
  });

  it("calls weather_forecast at most once per location within the 1h cache window", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const loc = { lat: 37.57, lng: 126.98 };
    await fetchWeather(loc);
    await fetchDailyForecast(loc);
    await fetchHourlyForecast(loc);
    expect(callSilentMock).toHaveBeenCalledTimes(1);
    expect(callSilentMock).toHaveBeenCalledWith("weather_forecast", { lat: 37.57, lng: 126.98 });
  });

  it("cachedWeather reads the shared cache synchronously, without calling the backend again", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const loc = { lat: 37.57, lng: 126.98 };
    await fetchWeather(loc);
    callSilentMock.mockClear();
    expect(cachedWeather(loc)?.tempC).toBe(23);
    expect(callSilentMock).not.toHaveBeenCalled();
  });

  it("cachedWeather returns null when nothing has been fetched yet for that location", () => {
    expect(cachedWeather({ lat: 1, lng: 1 })).toBeNull();
  });

  it("fetchDailyForecast groups by device-local date, aggregating max/min °C and the day's worst WMO code", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const daily = await fetchDailyForecast({ lat: 37.57, lng: 126.98 });
    expect(daily?.time).toHaveLength(3); // yesterday, today, tomorrow (local)
    expect(daily?.timezone).toBeUndefined(); // met.no doesn't report one (unlike Open-Meteo's timezone=auto)

    const todayIdx = daily!.time.indexOf(localDay(isoAt(0)));
    expect(daily!.tempMaxC[todayIdx]).toBe(27); // max(25, 26, 27) across today's 3 entries
    expect(daily!.tempMinC[todayIdx]).toBe(20); // min(20, 20, 21)
    // worst WMO among {partlycloudy_day=2, rain=63, heavyrain=65} -> 65
    expect(daily!.weatherCode[todayIdx]).toBe(65);

    const tomorrowIdx = daily!.time.indexOf(localDay(isoAt(30)));
    expect(daily!.tempMaxC[tomorrowIdx]).toBe(15); // no temp_max_6h that day -> falls back to temp_c
    expect(daily!.tempMinC[tomorrowIdx]).toBe(15);
    expect(daily!.weatherCode[tomorrowIdx]).toBe(3); // no symbol at all that day -> fallback
  });

  it("fetchHourlyForecast keeps only today's (local) symbol_1h entries as YYYY-MM-DDTHH:00", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const hourly = await fetchHourlyForecast({ lat: 37.57, lng: 126.98 });
    expect(hourly?.time).toHaveLength(3); // today's 3 entries all carry symbol_1h
    const todayPrefix = `${localDay(isoAt(0))}T`;
    expect(hourly?.time.every((t) => t.startsWith(todayPrefix))).toBe(true);
    expect(hourly?.tempC).toEqual([22, 23, 24]);
    expect(hourly?.weatherCode).toEqual([
      symbolCodeToWmo("partlycloudy_day"),
      symbolCodeToWmo("rain"),
      symbolCodeToWmo("heavyrain"),
    ]);
  });

  it("returns null from all three on backend failure", async () => {
    callSilentMock.mockRejectedValue(new Error("offline"));
    expect(await fetchWeather({ lat: 0, lng: 0 })).toBeNull();
    expect(await fetchDailyForecast({ lat: 0, lng: 0 })).toBeNull();
    expect(await fetchHourlyForecast({ lat: 0, lng: 0 })).toBeNull();
  });

  // A(AUDIT-2026-09-26): a weather_forecast failure used to vanish into a quiet `null` with no
  // trace anywhere — now it reports once per failing fetchRaw call.
  it("reports a fallback when weather_forecast fails", async () => {
    reportFallbackMock.mockClear();
    callSilentMock.mockRejectedValue(new Error("offline"));
    await fetchWeather({ lat: 0, lng: 0 });
    expect(reportFallbackMock).toHaveBeenCalledWith("weather", "fetch_failed", "offline");
  });

  // Regression: an unmocked callSilent in some unrelated test previously resolved to a value
  // without an `entries` array (e.g. undefined), and dailyFromEntries/snapshotFromEntries's
  // `for...of` threw "entries is not iterable" as an unhandled rejection instead of the usual
  // quiet-omit null — caught by the full `npx vitest run` (not this file alone, since it needs an
  // unmocked caller) as 15 unhandled-rejection failures across unrelated suites.
  it("returns null (not a throw) when the backend resolves with a malformed/missing entries shape", async () => {
    callSilentMock.mockResolvedValue({});
    await expect(fetchWeather({ lat: 0, lng: 0 })).resolves.toBeNull();
    await expect(fetchDailyForecast({ lat: 0, lng: 0 })).resolves.toBeNull();
    await expect(fetchHourlyForecast({ lat: 0, lng: 0 })).resolves.toBeNull();

    callSilentMock.mockResolvedValue(undefined);
    await expect(fetchWeather({ lat: 0, lng: 0 })).resolves.toBeNull();
  });

  it("clearWeatherCache forces a re-fetch even within the 1h window", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const loc = { lat: 10, lng: 20 };
    await fetchWeather(loc);
    clearWeatherCache();
    await fetchWeather(loc);
    expect(callSilentMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent current/daily/hourly calls share one in-flight request", async () => {
    callSilentMock.mockResolvedValue({ entries });
    const loc = { lat: 11, lng: 22 };
    await Promise.all([fetchWeather(loc), fetchDailyForecast(loc), fetchHourlyForecast(loc)]);
    expect(callSilentMock).toHaveBeenCalledTimes(1);
  });

  it("a failed in-flight request is not cached — the next call retries", async () => {
    callSilentMock.mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce({ entries });
    const loc = { lat: 12, lng: 23 };
    expect(await fetchWeather(loc)).toBeNull();
    expect(await fetchWeather(loc)).not.toBeNull();
    expect(callSilentMock).toHaveBeenCalledTimes(2);
  });

  it("a cached entry from an earlier coordinate does not leak across cache keys", async () => {
    callSilentMock.mockResolvedValueOnce({ entries }).mockResolvedValueOnce({
      entries: [{ time: isoAt(0), temp_c: 5, symbol_1h: "snow", symbol_6h: null, temp_max_6h: null, temp_min_6h: null }],
    });
    expect((await fetchWeather({ lat: 10, lng: 20 }))?.tempC).toBe(23);
    expect((await fetchWeather({ lat: 50, lng: 60 }))?.tempC).toBe(5);
    expect(callSilentMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveWeatherLocation (priority chain)", () => {
  const workspace = { lat: 35.68, lng: 139.76 };
  const noteCoords = [
    { lat: 40.71, lng: -74.0 },
    { lat: 40.72, lng: -74.01 },
    { lat: 51.5, lng: -0.12 },
  ];

  it("prefers workspace default over note locations", () => {
    expect(resolveWeatherLocation(workspace, noteCoords)).toEqual({
      lat: workspace.lat,
      lng: workspace.lng,
      source: "workspace",
    });
  });

  it("falls back to the most-common note location when workspace is unset", () => {
    const r = resolveWeatherLocation(null, noteCoords);
    expect(r?.source).toBe("notes");
    // The NYC pair (2 notes) outnumbers the lone London note.
    expect(r?.lat).toBeCloseTo(40.715, 2);
    expect(r?.lng).toBeCloseTo(-74.005, 2);
  });

  it("returns null when nothing is available", () => {
    expect(resolveWeatherLocation(null, [])).toBeNull();
  });
});
