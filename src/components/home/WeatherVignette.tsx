/**
 * Header weather vignette — small ambient scene (icon + gentle motion) beside the header's
 * weather text (WeatherSlot.tsx). Icon + color come from lib/weather.ts::weatherCodeToVisual (the
 * same function the calendar's day cells use), so the two surfaces never disagree on a condition's
 * look. `scene` is still exposed (data-scene attribute, `sceneFor()`) for anything keying off the
 * bucket, but no longer drives a decoration layer here — see below.
 *
 * tempC doubles as weatherCodeToVisual's optional tempMaxC (that param is normally the forecast
 * day's max, used to tint the sun icon for a heatwave) — reused here against the header's current
 * reading for the same "is it hot right now" intent, instead of adding a second color rule.
 *
 * Meteocons swap (see assets/weather/icons.tsx): every icon now carries its own motion baked in
 * as SMIL (sun rays turning, clouds drifting, rain/snow actually falling), so the wx-* CSS classes
 * that used to drift/pulse/bolt-flash the plain lucide icon, and the separate falling-streak/dot
 * decoration layer that simulated precipitation beside it, are both gone — the icon *is* the
 * animation now. prefers-reduced-motion is handled inside those icon components (they render the
 * static SVG variant instead), so this component doesn't need its own reduced-motion branch either.
 */
import { weatherCodeToVisual, weatherLabelKey } from "../../lib/weather";

export type WeatherScene =
  | "clear"
  | "partly_cloudy"
  | "overcast"
  | "fog"
  | "rain"
  | "showers"
  | "snow"
  | "thunder"
  | "unknown";

export function sceneFor(code: number): WeatherScene {
  switch (weatherLabelKey(code)) {
    case "home.weather_clear":
      return "clear";
    case "home.weather_partly_cloudy":
      return "partly_cloudy";
    case "home.weather_overcast":
      return "overcast";
    case "home.weather_fog":
      return "fog";
    case "home.weather_rain":
      return "rain";
    case "home.weather_snow":
      return "snow";
    case "home.weather_showers":
      return "showers";
    case "home.weather_thunder":
      return "thunder";
    default:
      return "unknown";
  }
}

export function WeatherVignette({ weatherCode, tempC }: { weatherCode: number; tempC: number }) {
  const { Icon, colorVar } = weatherCodeToVisual(weatherCode, tempC);
  const scene = sceneFor(weatherCode);

  return (
    <div
      data-testid="weather-vignette"
      data-scene={scene}
      style={{
        width: 56,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flex: "none",
      }}
    >
      <Icon size={24} style={{ color: colorVar }} />
    </div>
  );
}
