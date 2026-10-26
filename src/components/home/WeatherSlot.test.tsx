import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { WeatherSlot } from "./WeatherSlot";
import { skyStyle } from "../../lib/skyGradient";

// 위치는 해결된 상태로 고정 — 이 파일이 검증하는 건 "날씨가 있을 때 그려지는 하늘 박스"다.
// 같은 객체 참조를 매번 돌려준다(실제 useWeatherLocation은 useMemo로 참조를 고정한다) — 매
// 렌더마다 새 리터럴을 돌려주면 U4 재시도 effect의 `[resolved]` deps가 매번 "바뀐 걸로" 보여
// (setSnap/setSource로 인한 재렌더마다) effect가 통째로 재시작돼 재시도 타이밍 테스트가 무의미해진다.
const RESOLVED_LOCATION = { lat: 37.5665, lng: 126.978, source: "workspace" as const };
vi.mock("./useWeatherLocation", () => ({
  useWeatherLocation: () => RESOLVED_LOCATION,
}));

vi.mock("../../lib/weather", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/weather")>();
  return {
    ...actual,
    // 61 = rain → WeatherVignette 가 Meteocons 비 아이콘(자체 SMIL 낙하 애니메이션)을 그리는 씬.
    fetchWeather: vi.fn().mockResolvedValue({
      tempC: 7,
      weatherCode: 61,
      labelKey: "home.weather_rain",
      fetchedAt: Date.now(),
    }),
  };
});

// jsdom 에 matchMedia 가 없다 — usePrefersReducedMotion(WeatherVignette)이 마운트 때 읽는다.
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

const SKY = skyStyle({
  date: new Date("2026-08-04T12:00:00Z"),
  loc: { lat: 37.5665, lng: 126.978 },
  weatherCode: 61,
});

describe("WeatherSlot sky box (W7-c)", () => {
  // 그라데이션과 --on-sky* 재바인딩은 이제 **이 박스 안에서만** 일어난다. 헤더 밴드 전체로 다시
  // 번지면 HomeHeader.test.tsx 쪽이 잡고, 여기서는 반대로 "박스가 실제로 하늘을 갖는다"를 지킨다.
  it("wraps the chip in a rounded gradient box that scopes the on-sky tones", async () => {
    const { findByTestId } = render(<WeatherSlot sky={SKY} />);
    const box = (await findByTestId("home-weather-group")) as HTMLElement;
    expect(box.className).toContain("sky-box");
    expect(box.style.background).toContain("linear-gradient");
    expect(box.style.background).toContain("var(--sky-scrim)");
    expect(["light", "dark"]).toContain(box.dataset.skyTone);
    expect(box.style.borderRadius).toBe("var(--radius-lg)");
    expect(box.style.getPropertyValue("--on-sky")).toBeTruthy();
    expect(box.style.getPropertyValue("--text")).toBe("var(--on-sky)");
    expect(box.style.getPropertyValue("--muted")).toBe("var(--on-sky-muted)");
    expect(box.style.getPropertyValue("--faint")).toBe("var(--on-sky-faint)");
  });

  // 상하 패딩이 한 값이라 칩은 자동으로 수직 중앙(QA §4 "위아래 여백 동일"). 값을 좌우와
  // 따로 쓰기 시작하면 그 성질이 조용히 깨지므로 shorthand 자체를 고정한다.
  it("pads top/bottom equally so the chip sits vertically centered", async () => {
    const { findByTestId } = render(<WeatherSlot sky={SKY} />);
    const box = (await findByTestId("home-weather-group")) as HTMLElement;
    expect(box.style.padding).toBe("var(--space-4) var(--space-6)");
    expect(box.style.alignItems).toBe("center");
  });

  // overflow 를 자르지 않는다 — Meteocons 아이콘 자체의 SMIL 애니메이션이 잘리지 않게 한다.
  it("never clips the box", async () => {
    const { findByTestId, getByTestId } = render(<WeatherSlot sky={SKY} />);
    const box = (await findByTestId("home-weather-group")) as HTMLElement;
    expect(box.style.overflow).toBe("");
    expect(getByTestId("weather-vignette").querySelector("svg")).toBeTruthy();
  });

  it("renders nothing when the fetch yields no snapshot (offline)", async () => {
    const weather = await import("../../lib/weather");
    vi.mocked(weather.fetchWeather).mockResolvedValueOnce(null);
    const { queryByTestId } = render(<WeatherSlot sky={SKY} />);
    await waitFor(() => expect(queryByTestId("home-weather-group")).toBeNull());
  });
});

// U4(AUDIT-2026-09-26): a single failed fetch used to hide the slot for the rest of the session —
// no retry until `resolved` (the location) itself changed. Now it retries with a bounded backoff,
// and again as soon as the tab regains visibility.
describe("WeatherSlot bounded retry after a failed fetch (U4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries after the first backoff delay and recovers once the fetch succeeds", async () => {
    const weather = await import("../../lib/weather");
    const fetchMock = vi.mocked(weather.fetchWeather);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      tempC: 7,
      weatherCode: 61,
      labelKey: "home.weather_rain",
      fetchedAt: Date.now(),
    });

    const { queryByTestId } = render(<WeatherSlot sky={SKY} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(queryByTestId("home-weather-group")).toBeNull();

    // First backoff step is 30s — nothing should happen before that.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(queryByTestId("home-weather-group")).not.toBeNull());
  });

  it("gives up after the bounded number of retries (no infinite retry storm)", async () => {
    const weather = await import("../../lib/weather");
    const fetchMock = vi.mocked(weather.fetchWeather);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(null);

    render(<WeatherSlot sky={SKY} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 30s + 120s + 300s exhausts the 3 scheduled retries (4 calls total); advancing well past that
    // must not schedule a 5th.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries immediately when the tab regains visibility, without waiting for the backoff", async () => {
    const weather = await import("../../lib/weather");
    const fetchMock = vi.mocked(weather.fetchWeather);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(null);

    render(<WeatherSlot sky={SKY} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // 2026-09-26 리뷰: 가시성 복귀 갱신이 실패하면 멀쩡히 보이던 날씨가 지워졌다 — 마지막 값을 유지한다.
  it("keeps the last good weather when a visibility-triggered refresh fails", async () => {
    const weather = await import("../../lib/weather");
    const fetchMock = vi.mocked(weather.fetchWeather);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ tempC: 7, weatherCode: 61, labelKey: "home.weather_rain", fetchedAt: Date.now() })
      .mockResolvedValue(null);

    const { queryByTestId } = render(<WeatherSlot sky={SKY} />);
    await vi.waitFor(() => expect(queryByTestId("home-weather-group")).not.toBeNull());

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(queryByTestId("home-weather-group")).not.toBeNull();
    // 표시 중인 값이 있으면 백오프 재시도 타이머도 걸지 않는다.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
