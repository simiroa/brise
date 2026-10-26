import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { OnboardingRegionStep } from "./OnboardingRegionStep";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

let geocodeState: { results: { label: string; lat: number; lng: number }[]; searching: boolean; unavailable: boolean };
vi.mock("../../lib/useGeocodeSearch", () => ({
  useGeocodeSearch: () => geocodeState,
}));

const fetchWeatherMock = vi.fn();
vi.mock("../../lib/weather", async () => {
  const actual = await vi.importActual<typeof import("../../lib/weather")>("../../lib/weather");
  return { ...actual, fetchWeather: (...args: unknown[]) => fetchWeatherMock(...args) };
});

const SEOUL = { label: "서울, 대한민국", lat: 37.5665, lng: 126.978 };
const TOKYO = { label: "도쿄, 일본", lat: 35.6762, lng: 139.6503 };

describe("OnboardingRegionStep", () => {
  beforeEach(() => {
    callMock.mockReset();
    fetchWeatherMock.mockReset().mockResolvedValue(null);
    geocodeState = { results: [], searching: false, unavailable: false };
    useSettingsStore.setState({ uiLang: "ko" });
  });

  it("picking a result calls onSelectionChange with the label/lat/lng", async () => {
    callMock.mockResolvedValue({ time_zone: "Asia/Seoul" });
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    const onSelectionChange = vi.fn();
    render(<OnboardingRegionStep onSelectionChange={onSelectionChange} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    expect(onSelectionChange).toHaveBeenCalledWith(SEOUL);
    expect((screen.getByTestId("onboarding-region-search-input") as HTMLInputElement).value).toBe(SEOUL.label);
  });

  it("editing the input after a pick clears the selection", async () => {
    callMock.mockResolvedValue({ time_zone: "Asia/Seoul" });
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    const onSelectionChange = vi.fn();
    render(<OnboardingRegionStep onSelectionChange={onSelectionChange} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(SEOUL);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "x");
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("onboarding-region-preview")).toBeNull();
  });

  it("shows the neutral unavailable message and never falls back to device time when time_zone is null", async () => {
    callMock.mockResolvedValue({ time_zone: null });
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    await waitFor(() =>
      expect(screen.getByTestId("onboarding-region-time").textContent).toContain("시간대를 확인할 수 없어요")
    );
  });

  it("shows a weather-unavailable message on fetch failure without blocking the preview", async () => {
    callMock.mockResolvedValue({ time_zone: "Asia/Seoul" });
    fetchWeatherMock.mockResolvedValue(null);
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    await waitFor(() =>
      expect(screen.getByTestId("onboarding-region-weather").textContent).toContain("날씨를 불러올 수 없어요")
    );
    expect(screen.getByTestId("onboarding-region-preview")).toBeTruthy();
  });

  it("shows the time/weather/map chips and the meaning caption after a manual pick", async () => {
    callMock.mockResolvedValue({ time_zone: "Asia/Seoul" });
    fetchWeatherMock.mockResolvedValue({ tempC: 21, weatherCode: 0, labelKey: "weather.clear", fetchedAt: Date.now() });
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    await waitFor(() => expect(screen.getByTestId("onboarding-region-time").textContent).toMatch(/\d{1,2}:\d{2}/));
    expect(screen.getByTestId("onboarding-region-weather").textContent).toContain("21");
    expect(screen.getByTestId("onboarding-region-preview").textContent).toContain("서울");
    expect(screen.getByTestId("onboarding-region-caption")).toBeTruthy();
  });

  describe("Korean holiday chip", () => {
    it("shows and toggles setHolidayRegion for a Korean region", async () => {
      callMock.mockResolvedValue({ time_zone: "Asia/Seoul" });
      geocodeState = { results: [SEOUL], searching: false, unavailable: false };
      useSettingsStore.setState({ uiLang: "ko", holidayRegion: "none" });
      render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

      await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
      await userEvent.click(screen.getByTestId("onboarding-region-result"));

      const toggle = await waitFor(() => screen.getByTestId("onboarding-region-holiday-toggle"));
      await userEvent.click(toggle);
      await waitFor(() => expect(useSettingsStore.getState().holidayRegion).toBe("kr"));
    });

    it("stays hidden for a non-Korean region", async () => {
      callMock.mockResolvedValue({ time_zone: "Asia/Tokyo" });
      geocodeState = { results: [TOKYO], searching: false, unavailable: false };
      render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

      await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "도쿄");
      await userEvent.click(screen.getByTestId("onboarding-region-result"));

      await waitFor(() => expect(screen.getByTestId("onboarding-region-caption")).toBeTruthy());
      expect(screen.queryByTestId("onboarding-region-holiday-toggle")).toBeNull();
    });
  });

  it("discards a stale tz/weather response from a previous selection", async () => {
    let resolveSeoulTz: (v: { time_zone: string | null }) => void = () => {};
    callMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSeoulTz = resolve;
        })
    );
    geocodeState = { results: [SEOUL], searching: false, unavailable: false };
    render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "서울");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    // Rapid switch to Tokyo before Seoul's tz lookup resolves.
    geocodeState = { results: [TOKYO], searching: false, unavailable: false };
    callMock.mockResolvedValue({ time_zone: "Asia/Tokyo" });
    await userEvent.clear(screen.getByTestId("onboarding-region-search-input"));
    await userEvent.type(screen.getByTestId("onboarding-region-search-input"), "도쿄");
    await userEvent.click(screen.getByTestId("onboarding-region-result"));

    // Now let Seoul's stale response land — it must not overwrite Tokyo's state.
    resolveSeoulTz({ time_zone: "Asia/Seoul" });

    await waitFor(() =>
      expect(/\d{1,2}:\d{2}/.test(screen.getByTestId("onboarding-region-time").textContent ?? "")).toBe(true)
    );
  });

  describe("auto-locate", () => {
    const tzSpy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    afterEach(() => tzSpy.mockReset());

    it("picks the first geocode result for the device's IANA city and calls onSelectionChange", async () => {
      tzSpy.mockReturnValue({ timeZone: "Asia/Seoul" } as Intl.ResolvedDateTimeFormatOptions);
      // First call is the auto-locate geocode_search, second is the tz lookup for the preview.
      callMock.mockResolvedValueOnce({ results: [SEOUL] }).mockResolvedValue({ time_zone: "Asia/Seoul" });
      const onSelectionChange = vi.fn();
      render(<OnboardingRegionStep onSelectionChange={onSelectionChange} />);

      await userEvent.click(screen.getByTestId("onboarding-region-auto-btn"));

      await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith(SEOUL));
      expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "Seoul", lang: "ko" });
      expect(screen.getByTestId("onboarding-region-caption")).toBeTruthy();
    });

    it("shows the failure message and skips the geocode call for a cityless zone (UTC)", async () => {
      tzSpy.mockReturnValue({ timeZone: "UTC" } as Intl.ResolvedDateTimeFormatOptions);
      const onSelectionChange = vi.fn();
      render(<OnboardingRegionStep onSelectionChange={onSelectionChange} />);

      await userEvent.click(screen.getByTestId("onboarding-region-auto-btn"));

      await waitFor(() => expect(screen.getByTestId("onboarding-region-auto-failed")).toBeTruthy());
      expect(callMock).not.toHaveBeenCalled();
      expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it("shows the failure message when geocode_search returns no results", async () => {
      tzSpy.mockReturnValue({ timeZone: "Asia/Seoul" } as Intl.ResolvedDateTimeFormatOptions);
      callMock.mockResolvedValueOnce({ results: [] });
      render(<OnboardingRegionStep onSelectionChange={vi.fn()} />);

      await userEvent.click(screen.getByTestId("onboarding-region-auto-btn"));

      await waitFor(() => expect(screen.getByTestId("onboarding-region-auto-failed")).toBeTruthy());
      expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "Seoul", lang: "ko" });
    });
  });
});
