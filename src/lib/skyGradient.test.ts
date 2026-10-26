import { describe, it, expect } from "vitest";
import {
  applyWeather,
  fallbackElevation,
  paletteForElevation,
  relativeLuminance,
  skyStyle,
  solarElevation,
  toneForPalette,
  type RGB,
  type SkyPalette,
} from "./skyGradient";

// 서울 시청 (weatherLocation 기본 좌표와 동일).
const SEOUL = { lat: 37.5665, lng: 126.978 };
// 시각은 전부 UTC로 못 박는다 — 테스트 러너의 로컬 TZ와 무관해야 한다(KST = UTC+9).
const SUMMER_NOON = new Date("2026-06-21T03:00:00Z"); // 하지 정오(KST)
const SUMMER_MIDNIGHT = new Date("2026-06-21T15:00:00Z"); // 하지 자정(KST)
const WINTER_NOON = new Date("2026-12-21T03:00:00Z"); // 동지 정오(KST)

function avgLum(p: SkyPalette): number {
  return p.reduce((s, c) => s + relativeLuminance(c), 0) / p.length;
}
/** 채도 대용 지표: 스톱 하나의 채널 최대-최소 폭. */
function spread([r, g, b]: RGB): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

describe("solarElevation", () => {
  it("서울 하지: 정오는 높고 자정은 한밤(음수)", () => {
    const noon = solarElevation(SEOUL.lat, SEOUL.lng, SUMMER_NOON);
    const midnight = solarElevation(SEOUL.lat, SEOUL.lng, SUMMER_MIDNIGHT);
    expect(noon).toBeGreaterThan(60);
    expect(noon).toBeLessThan(80); // 서울 하지 최대고도 ≈ 75.9°
    expect(midnight).toBeLessThan(-18); // 천문박명보다도 아래
    expect(noon).toBeGreaterThan(0);
    expect(0).toBeGreaterThan(midnight);
  });

  it("계절 반영: 동지 정오 고도 < 하지 정오 고도 (차이 ≈ 황도경사 2배)", () => {
    const summer = solarElevation(SEOUL.lat, SEOUL.lng, SUMMER_NOON);
    const winter = solarElevation(SEOUL.lat, SEOUL.lng, WINTER_NOON);
    expect(winter).toBeLessThan(summer);
    expect(summer - winter).toBeGreaterThan(40);
    expect(summer - winter).toBeLessThan(52);
  });

  it("위도 반영: 같은 순간 적도가 극지보다 높다", () => {
    const equator = solarElevation(0, 126.978, SUMMER_NOON);
    const polar = solarElevation(80, 126.978, SUMMER_NOON);
    expect(equator).toBeGreaterThan(polar);
  });
});

describe("fallbackElevation (위치 미설정)", () => {
  it("06시 0°, 12시 +60°, 18시 0°, 자정 -60°", () => {
    // 로컬 시각 기준 함수이므로 로컬 Date 생성자를 쓴다.
    expect(fallbackElevation(new Date(2026, 5, 21, 6, 0))).toBeCloseTo(0, 6);
    expect(fallbackElevation(new Date(2026, 5, 21, 12, 0))).toBeCloseTo(60, 6);
    expect(fallbackElevation(new Date(2026, 5, 21, 18, 0))).toBeCloseTo(0, 6);
    expect(fallbackElevation(new Date(2026, 5, 21, 0, 0))).toBeCloseTo(-60, 6);
  });
});

describe("paletteForElevation", () => {
  it("양 끝은 클램프 (첫/마지막 키프레임 그대로)", () => {
    expect(paletteForElevation(-90)).toEqual(paletteForElevation(-18));
    expect(paletteForElevation(90)).toEqual(paletteForElevation(20));
  });

  it("키프레임 경계에서 점프가 없다 (연속 보간)", () => {
    // 0.1° 간격으로 훑으며 인접 샘플 간 최대 채널 변화량을 본다. 경계에서 팔레트가 갈아끼워지면
    // 여기서 큰 스파이크로 잡힌다.
    let maxStep = 0;
    let prev = paletteForElevation(-30);
    for (let e = -29.9; e <= 40; e += 0.1) {
      const cur = paletteForElevation(e);
      for (let s = 0; s < 3; s++) {
        for (let c = 0; c < 3; c++) {
          maxStep = Math.max(maxStep, Math.abs(cur[s][c] - prev[s][c]));
        }
      }
      prev = cur;
    }
    // 가장 가파른 구간(-6→0, 6° 동안 최대 ~104 변화)조차 0.1°당 2 미만이어야 한다.
    expect(maxStep).toBeLessThan(2);
  });

  it("고도가 오를수록 하늘이 밝아진다 (단조 증가)", () => {
    const samples = [-30, -18, -12, -6, 0, 6, 20, 45].map((e) =>
      avgLum(paletteForElevation(e)),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });
});

describe("applyWeather", () => {
  const day = paletteForElevation(20);

  it("null / 맑음(0)은 그대로 통과", () => {
    expect(applyWeather(day, null)).toEqual(day);
    expect(applyWeather(day, 0)).toEqual(day);
  });

  it("비(61)·뇌우(95)는 어둡게, 뇌우가 더 어둡다", () => {
    const rain = avgLum(applyWeather(day, 61));
    const storm = avgLum(applyWeather(day, 95));
    expect(rain).toBeLessThan(avgLum(day));
    expect(storm).toBeLessThan(rain);
  });

  it("눈(71)은 밝게/하얗게", () => {
    const snow = applyWeather(day, 71);
    expect(avgLum(snow)).toBeGreaterThan(avgLum(day));
    expect(spread(snow[0])).toBeLessThan(spread(day[0])); // 하얘진다 = 채널 폭 감소
  });

  it("흐림(3)은 채도를 떨어뜨린다", () => {
    const overcast = applyWeather(day, 3);
    for (let s = 0; s < 3; s++) {
      expect(spread(overcast[s])).toBeLessThan(spread(day[s]));
    }
  });

  it("보정 후에도 채널이 0~255를 벗어나지 않는다", () => {
    for (const code of [0, 3, 45, 61, 71, 82, 95]) {
      for (const elev of [-30, -6, 0, 6, 30]) {
        for (const stop of applyWeather(paletteForElevation(elev), code)) {
          for (const c of stop) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });
});

describe("toneForPalette", () => {
  it("밤 하늘은 밝은 글씨, 낮 하늘은 어두운 글씨", () => {
    expect(toneForPalette(paletteForElevation(-30))).toBe("light");
    expect(toneForPalette(paletteForElevation(45))).toBe("dark");
  });
});

describe("skyStyle", () => {
  it("위치가 있으면 태양고도 경로, 없으면 시계 폴백", () => {
    const withLoc = skyStyle({ date: SUMMER_NOON, loc: SEOUL, weatherCode: null });
    expect(withLoc.elevation).toBeCloseTo(
      solarElevation(SEOUL.lat, SEOUL.lng, SUMMER_NOON),
      6,
    );
    const noLoc = skyStyle({ date: SUMMER_NOON, loc: null, weatherCode: null });
    expect(noLoc.elevation).toBeCloseTo(fallbackElevation(SUMMER_NOON), 6);
  });

  it("배경은 스크림 레이어 + 3스톱 그라데이션, on-gradient 변수를 함께 준다", () => {
    const s = skyStyle({ date: SUMMER_MIDNIGHT, loc: SEOUL, weatherCode: null });
    expect(s.background).toContain("var(--sky-scrim)");
    expect(s.background.match(/rgb\(/g)?.length).toBe(3);
    expect(s.tone).toBe("light");
    expect(s.vars["--on-sky"]).toBeTruthy();
    expect(s.vars["--sky-scrim"]).toBeTruthy();
  });

  it("날씨 코드가 팔레트에 실제로 반영된다", () => {
    const clear = skyStyle({ date: SUMMER_NOON, loc: SEOUL, weatherCode: 0 });
    const storm = skyStyle({ date: SUMMER_NOON, loc: SEOUL, weatherCode: 95 });
    expect(storm.background).not.toBe(clear.background);
    expect(avgLum(storm.palette)).toBeLessThan(avgLum(clear.palette));
  });
});
