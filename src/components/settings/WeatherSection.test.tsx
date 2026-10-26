import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import { WeatherSection, useWeatherReadout } from "./WeatherSection";
import * as weatherLib from "../../lib/weather";
import type { DailyForecast } from "../../lib/weather";
import { useSettingsStore } from "../../stores/settings";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

const FORECAST: DailyForecast = {
  time: ["2026-08-21", "2026-08-22", "2026-08-23"],
  weatherCode: [0, 1, 2],
  tempMaxC: [28, 30, 27],
  tempMinC: [20, 21, 19],
  timezone: "Asia/Seoul",
  fetchedAt: Date.now(),
};

describe("WeatherSection (W7 §7.4, PLAN-2026-09-12 D11, PLAN-2026-09-15 §4 지역)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    useSettingsStore.setState({ regionEnabled: true } as never);
    vi.spyOn(weatherLib, "fetchDailyForecast").mockClear().mockResolvedValue(FORECAST);
  });

  it("has no visibility toggle — weather is always shown (D11)", () => {
    render(<WeatherSection forecast={FORECAST} />);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    // 판독 전용이라 **어떤** 설정도 쓰지 않는다. 예전엔 `header_weather_visible` 이라는 키 하나를
    // 이름으로 집어 막았는데, 그 키는 W3 에서 통째로 사라졌다(레포 어디에도 없다) — 죽은 이름을
    // 테스트가 되살려 두면 check:settings 가 "백엔드 allowlist 에 없는 키"로 잡는다.
    expect(callMock.mock.calls.some((c) => c[0] === "settings_set")).toBe(false);
  });

  it("draws no title of its own — the card that hosts it owns the heading", () => {
    const { container } = render(<WeatherSection forecast={null} />);
    expect(container.querySelector("[data-testid='settings-weather']")).toBeTruthy();
    expect(container.querySelector(".card")).toBeNull();
    expect(screen.queryByTestId("settings-weather-7day")).toBeNull();
  });

  it("renders the 7-day forecast strip from the forecast it is handed", () => {
    render(<WeatherSection forecast={FORECAST} />);
    expect(screen.getByTestId("settings-weather-7day")).toBeTruthy();
    expect(screen.getByText("8/21")).toBeTruthy();
    expect(screen.getByText("28°")).toBeTruthy();
  });

  it("useWeatherReadout fetches once and derives the local time with the forecast timezone", async () => {
    const { result } = renderHook(() => useWeatherReadout());
    await waitFor(() => expect(result.current.forecast).toEqual(FORECAST));
    expect(weatherLib.fetchDailyForecast).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.timezone).toBe("Asia/Seoul");
    expect(result.current.localTimeStr).toMatch(/^\d{2}:\d{2}$/);
    expect(result.current.resolved?.source).toBeTruthy();
  });

  // met.no 는 시간대를 주지 않는다 — 그때는 이 PC 의 시각을 그리고 timezone 은 null 로 둔다(화면이 밝힌다).
  it("without a forecast timezone the clock falls back to this PC's time and timezone stays null", async () => {
    vi.spyOn(weatherLib, "fetchDailyForecast").mockResolvedValue({ ...FORECAST, timezone: undefined });
    const { result } = renderHook(() => useWeatherReadout());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.timezone).toBeNull();
    expect(result.current.localTimeStr).toMatch(/^\d{2}:\d{2}$/);
  });

  it("a failed forecast is reported as failed, not as still loading", async () => {
    vi.spyOn(weatherLib, "fetchDailyForecast").mockResolvedValue(null);
    const { result } = renderHook(() => useWeatherReadout());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.forecast).toBeNull();
  });

  it("a thrown forecast fetch is caught and reported as failed", async () => {
    vi.spyOn(weatherLib, "fetchDailyForecast").mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useWeatherReadout());
    await waitFor(() => expect(result.current.status).toBe("failed"));
  });

  it("shows an explicit unavailable line when the forecast failed", () => {
    render(<WeatherSection forecast={null} status="failed" />);
    expect(screen.getByTestId("settings-weather-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("settings-weather-7day")).toBeNull();
  });

  // PLAN-2026-09-15 R3 — 게이트는 useWeatherLocation 한 지점이고, 여기서는 그 결과(위치 없음)가
  // met.no 왕복을 **아예 만들지 않는다**는 것만 본다.
  it("region_enabled 가 꺼지면 예보를 한 번도 가져오지 않는다 (R3)", async () => {
    useSettingsStore.setState({ regionEnabled: false } as never);
    const { result } = renderHook(() => useWeatherReadout());
    await waitFor(() => expect(result.current.resolved).toBeNull());
    expect(weatherLib.fetchDailyForecast).not.toHaveBeenCalled();
    expect(result.current.forecast).toBeNull();
    expect(result.current.localTimeStr).toBeNull();
    expect(result.current.status).toBe("off");
  });
});
