/**
 * 대시보드 헤더의 하늘 그라데이션 엔진 (W6-c).
 *
 * 태양고도(위치+시각) → 하늘 키프레임 팔레트 연속 보간 → 날씨 보정 → 텍스트 대비 톤.
 * 전부 순수 함수다(React·DOM·네트워크 의존 0) — 호출부는 HomeHeader 하나뿐이고 테스트가 곧 사양.
 *
 * 위치는 기존 `weatherLocation` 체인(useWeatherLocation)을 그대로 받는다. 위치가 없으면
 * `fallbackElevation`이 시계 시각만으로 유사 고도를 만들어 **같은 키프레임 테이블**을 통과시킨다
 * (별도 24h 팔레트 테이블을 두지 않는 이유 — 두 벌이 되면 반드시 어긋난다).
 *
 * 날씨는 새 API 호출을 하지 않는다: weather.ts의 1시간 캐시를 `cachedWeather`로 읽기만 한다
 * (헤더 날씨 슬롯이 이미 채워둔 값). 날씨 표시를 끄면 보정도 없다 = 맑은 하늘 기준.
 */
import { clamp } from "./ui";
import { weatherLabelKey, type LatLng } from "./weather";

export type RGB = [number, number, number];
export type SkyTone = "light" | "dark";

/** 위→아래 3스톱 팔레트. */
export type SkyPalette = [RGB, RGB, RGB];

export interface SkyStyle {
  /** 태양고도(도). 폴백 경로면 시계 기반 유사값. */
  elevation: number;
  /** header의 `background` 값(스크림 레이어 + 그라데이션). */
  background: string;
  /** 배경 휘도로 정해진 on-gradient 텍스트 톤. */
  tone: SkyTone;
  /** header에 스프레드할 CSS 커스텀 프로퍼티. */
  vars: Record<string, string>;
  palette: SkyPalette;
}

// ── 태양고도 ──────────────────────────────────────────────────────────────────
// 저정밀 태양좌표 근사식 (US Naval Observatory, *Astronomical Almanac* — "Approximate Solar
// Coordinates", 1950~2050 구간에서 오차 ~0.01°). 계절·위도가 자동으로 반영되므로 위도별/월별
// 보정 테이블이 필요 없다.
const DEG = Math.PI / 180;
/** Unix epoch(JD 2440587.5) → J2000(JD 2451545.0) 오프셋(일). */
const J2000_OFFSET_DAYS = 10957.5;

export function solarElevation(lat: number, lon: number, date: Date): number {
  const n = date.getTime() / 86_400_000 - J2000_OFFSET_DAYS; // J2000 기준 경과일
  const meanLon = 280.46 + 0.9856474 * n; // 평균황경(도)
  const meanAnom = (357.528 + 0.9856003 * n) * DEG; // 평균근점이각
  const eclLon =
    (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG; // 황경
  const obliq = (23.439 - 0.0000004 * n) * DEG; // 황도경사
  const decl = Math.asin(Math.sin(obliq) * Math.sin(eclLon)); // 적위
  const ra = Math.atan2(Math.cos(obliq) * Math.sin(eclLon), Math.cos(eclLon)); // 적경
  const gmstHours = 18.697374558 + 24.06570982441908 * n; // 그리니치 항성시(시)
  const hourAngle = (gmstHours * 15 + lon - ra / DEG) * DEG; // 시간각
  const sinEl =
    Math.sin(lat * DEG) * Math.sin(decl) +
    Math.cos(lat * DEG) * Math.cos(decl) * Math.cos(hourAngle);
  return Math.asin(clamp(sinEl, -1, 1)) / DEG;
}

/**
 * 위치 미설정 폴백 — 시계 시각만으로 만드는 유사 고도. 06시 0°, 12시 +60°, 18시 0°, 자정 -60°.
 * ponytail: 계절·위도 없는 사인 곡선. 정확도가 아니라 "같은 팔레트 테이블을 자연스럽게 훑는 값"이
 * 목적이다 — 진짜 하늘을 원하면 설정에서 도시를 넣으면 된다(그러면 위 실제 계산식 경로).
 */
export function fallbackElevation(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  return 60 * Math.sin((Math.PI * (h - 6)) / 12);
}

// ── 키프레임 팔레트 ───────────────────────────────────────────────────────────
// 고도(도) → 하늘색. 아래/위 끝은 클램프(첫·마지막 키프레임 그대로).
const KEYFRAMES: { elev: number; hex: [string, string, string] }[] = [
  { elev: -18, hex: ["#070b12", "#0f1620", "#18222d"] }, // 밤 (천문박명 이전)
  { elev: -12, hex: ["#0d1626", "#172338", "#26314c"] }, // 천문박명
  { elev: -6, hex: ["#1b2a4a", "#3c3f65", "#6d5670"] }, // 항해→시민박명
  { elev: 0, hex: ["#2f4a76", "#7c6382", "#d18a63"] }, // 일출·일몰(지평선)
  { elev: 6, hex: ["#4f7ba8", "#9aa3ad", "#e3b184"] }, // 골든아워
  { elev: 20, hex: ["#6f9fc8", "#a6c5d6", "#dfe3d8"] }, // 낮 (한지 톤 지평선)
];

function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const PALETTES: { elev: number; stops: SkyPalette }[] = KEYFRAMES.map((k) => ({
  elev: k.elev,
  stops: k.hex.map(hexToRgb) as SkyPalette,
}));

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 고도 → 두 키프레임 사이 선형 보간. 경계에서 값이 정확히 일치하므로 점프가 없다. */
export function paletteForElevation(elev: number): SkyPalette {
  const first = PALETTES[0];
  const last = PALETTES[PALETTES.length - 1];
  if (elev <= first.elev) return first.stops;
  if (elev >= last.elev) return last.stops;
  let i = 0;
  while (i < PALETTES.length - 2 && elev > PALETTES[i + 1].elev) i++;
  const a = PALETTES[i];
  const b = PALETTES[i + 1];
  const t = (elev - a.elev) / (b.elev - a.elev);
  return a.stops.map((stop, s) =>
    stop.map((c, ch) => lerp(c, b.stops[s][ch], t)),
  ) as SkyPalette;
}

// ── 날씨 보정 ─────────────────────────────────────────────────────────────────
// 그룹핑은 weather.ts의 weatherLabelKey를 그대로 재사용한다(WMO 코드 범위를 두 번 적지 않는다).
// sat: 채도 배율(1 미만이면 회색쪽), light: 명도 배율(1 미만 어둡게, 초과분은 흰색으로 믹스).
const WEATHER_MOD: Record<string, { sat: number; light: number }> = {
  "home.weather_clear": { sat: 1, light: 1 },
  "home.weather_partly_cloudy": { sat: 0.85, light: 0.97 },
  "home.weather_overcast": { sat: 0.55, light: 0.9 },
  "home.weather_fog": { sat: 0.3, light: 1.06 },
  "home.weather_rain": { sat: 0.6, light: 0.78 },
  "home.weather_showers": { sat: 0.55, light: 0.72 },
  "home.weather_thunder": { sat: 0.5, light: 0.62 },
  "home.weather_snow": { sat: 0.45, light: 1.14 },
  "home.weather_unknown": { sat: 1, light: 1 },
};

/** WMO 코드 → 팔레트 보정. code가 null(날씨 미표시/오프라인)이면 그대로 통과. */
export function applyWeather(palette: SkyPalette, code: number | null): SkyPalette {
  if (code === null) return palette;
  const m = WEATHER_MOD[weatherLabelKey(code)] ?? WEATHER_MOD["home.weather_unknown"];
  if (m.sat === 1 && m.light === 1) return palette;
  return palette.map((stop) => {
    const grey = 0.2126 * stop[0] + 0.7152 * stop[1] + 0.0722 * stop[2];
    return stop.map((c) => {
      const desat = grey + (c - grey) * m.sat;
      const lit = m.light <= 1 ? desat * m.light : desat + (255 - desat) * (m.light - 1);
      return clamp(lit, 0, 255);
    }) as RGB;
  }) as SkyPalette;
}

// ── 대비 ──────────────────────────────────────────────────────────────────────
/** WCAG 상대휘도(0~1). */
export function relativeLuminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 세 스톱 평균 휘도로 on-gradient 톤을 고른다. 0.45는 밝은 낮 하늘(≈0.53)과 골든아워(≈0.34) 사이. */
export function toneForPalette(palette: SkyPalette): SkyTone {
  const avg = palette.reduce((s, c) => s + relativeLuminance(c), 0) / palette.length;
  return avg > 0.45 ? "dark" : "light";
}

// 절대 검정/절대 흰색을 쓰지 않는다(DESIGN.md — NO Absolute Black).
const TONE_VARS: Record<SkyTone, Record<string, string>> = {
  light: {
    "--on-sky": "#f4f6f7",
    "--on-sky-muted": "rgba(244,246,247,0.76)",
    "--on-sky-faint": "rgba(244,246,247,0.55)",
    "--on-sky-line": "rgba(244,246,247,0.18)",
    "--sky-scrim": "rgba(8,12,18,0.20)",
  },
  dark: {
    "--on-sky": "#22282c",
    "--on-sky-muted": "rgba(34,40,44,0.72)",
    "--on-sky-faint": "rgba(34,40,44,0.5)",
    "--on-sky-line": "rgba(34,40,44,0.14)",
    "--sky-scrim": "rgba(255,255,255,0.22)",
  },
};

function css([r, g, b]: RGB): string {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/**
 * 헤더 한 줄에 필요한 모든 것. loc이 null이면 시계 폴백, weatherCode가 null이면 보정 없음.
 *
 * ponytail: 스크림은 배경 스택의 균일 워시 한 겹이다(그라데이션 위 rgba 단색). 텍스트 뒤에만
 * 국소적으로 깔고 싶어지면 그때 별도 레이어 엘리먼트를 두면 된다 — 지금은 한 줄로 충분하다.
 */
export function skyStyle(opts: {
  date: Date;
  loc: LatLng | null;
  weatherCode: number | null;
}): SkyStyle {
  const elevation = opts.loc
    ? solarElevation(opts.loc.lat, opts.loc.lng, opts.date)
    : fallbackElevation(opts.date);
  const palette = applyWeather(paletteForElevation(elevation), opts.weatherCode);
  const tone = toneForPalette(palette);
  const vars = { ...TONE_VARS[tone] };
  const gradient = `linear-gradient(180deg, ${css(palette[0])} 0%, ${css(palette[1])} 58%, ${css(palette[2])} 100%)`;
  const background = `linear-gradient(var(--sky-scrim), var(--sky-scrim)), ${gradient}`;
  return { elevation, background, tone, vars, palette };
}
