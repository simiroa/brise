import { describe, expect, it } from "vitest";
import type { WeatherEntry } from "./commands.gen";
import { apparentTempC, detailFromEntries, upcomingFromEntries, weekFromDaily } from "./weather";

const e = (time: string, extra: Partial<WeatherEntry> = {}): WeatherEntry => ({
  time,
  temp_c: 20,
  symbol_1h: "clearsky_day",
  symbol_6h: null,
  temp_max_6h: null,
  temp_min_6h: null,
  ...extra,
});

describe("detailFromEntries", () => {
  it("응답에 있는 값만 채우고 나머지는 null(만들어내지 않는다)", () => {
    const d = detailFromEntries(
      [e("2026-09-30T00:00:00Z", { humidity_pct: 48.4, wind_ms: 2.14, pressure_hpa: 1013.6 })],
      Date.parse("2026-09-30T00:10:00Z"),
    )!;
    expect(d.humidityPct).toBe(48);
    expect(d.windMs).toBe(2.1);
    expect(d.pressureHpa).toBe(1014);
    expect(d.uvIndex).toBeNull();
    expect(d.precipPct).toBeNull();
    expect(d.precipMm).toBeNull();
    expect(d.feelsLikeC).not.toBeNull(); // 기온·풍속·습도가 모두 있어 계산됨
  });
  it("습도나 풍속이 없으면 체감온도도 null", () => {
    const d = detailFromEntries([e("2026-09-30T00:00:00Z", { wind_ms: 3 })], Date.parse("2026-09-30T00:00:00Z"))!;
    expect(d.feelsLikeC).toBeNull();
    expect(detailFromEntries([])).toBeNull();
  });
  it("가장 가까운 시각의 항목을 쓴다", () => {
    const d = detailFromEntries(
      [e("2026-09-30T00:00:00Z", { humidity_pct: 10 }), e("2026-09-30T06:00:00Z", { humidity_pct: 90 })],
      Date.parse("2026-09-30T05:00:00Z"),
    )!;
    expect(d.humidityPct).toBe(90);
  });
});

describe("apparentTempC", () => {
  it("바람은 낮추고 습기는 높인다", () => {
    expect(apparentTempC(20, 0, 50)!).toBeGreaterThan(apparentTempC(20, 8, 50)!);
    expect(apparentTempC(30, 1, 80)!).toBeGreaterThan(apparentTempC(30, 1, 20)!);
    expect(apparentTempC(20, null, 50)).toBeNull();
  });
});

describe("upcomingFromEntries", () => {
  const list = ["00", "01", "02", "03"].map((h) =>
    e(`2026-09-30T${h}:00:00Z`, { temp_c: Number(h), precip_prob_pct: h === "02" ? 30 : undefined }),
  );
  list.push(e("2026-09-30T04:00:00Z", { symbol_1h: null }));
  it("지금 시각의 항목부터 최대 n 개, symbol_1h 없는 항목은 건너뛴다", () => {
    const now = Date.parse("2026-09-30T01:20:00Z");
    const out = upcomingFromEntries(list, now, 2);
    expect(out.map((x) => x.tempC)).toEqual([1, 2]);
    expect(out[1].precipPct).toBe(30);
    expect(out[0].precipPct).toBeNull();
    expect(upcomingFromEntries(list, now, 9).map((x) => x.tempC)).toEqual([1, 2, 3]);
  });
});

describe("weekFromDaily", () => {
  const daily = {
    time: ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"],
    weatherCode: [0, 1, 2, 3],
    tempMaxC: [20, 21, 22, 23],
    tempMinC: [10, 11, 12, 13],
    fetchedAt: 0,
  };
  it("오늘부터 n 일, 지난 날은 뺀다", () => {
    expect(weekFromDaily(daily, "2026-09-30", 7).map((d) => d.date)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(weekFromDaily(daily, "2026-09-30", 2)).toHaveLength(2);
    expect(weekFromDaily(null, "2026-09-30")).toEqual([]);
  });
});
