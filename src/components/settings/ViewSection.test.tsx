import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useSettingsStore, normalizeFilterRoster } from "../../stores/settings";
import { ViewSection } from "./ViewSection";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

// MapSection pulls in map-render machinery already covered by its own test file. ViewSection's own
// job here is composition (strip + region card + calendar-moved note), so stub the heavy child.
vi.mock("./MapSection", () => ({
  MapSection: () => <div data-testid="stub-map" />,
}));
vi.mock("../home/usePlaceName", () => ({
  usePlaceName: (loc: unknown) => (loc ? "서울" : null),
}));

const FORECAST = {
  time: [
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-19",
    "2026-09-20",
    "2026-09-21",
  ],
  weatherCode: [0, 1, 2, 3, 0, 1, 2],
  tempMaxC: [27.4, 26, 25, 24, 23, 22, 21],
  tempMinC: [18.6, 18, 17, 16, 15, 14, 13],
  timezone: "Asia/Seoul",
  fetchedAt: Date.now(),
};

describe("ViewSection (PLAN-2026-09-15 지역 및 날씨 R1~R6)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ entries: [] });
    sessionStorage.removeItem("brise_sync_token");
    useSettingsStore.setState({
      filterRoster: normalizeFilterRoster([]),
      statusAddLocked: false,
      weekStart: "sunday",
      holidayRegion: "none",
      uiLang: "ko",
      regionEnabled: true,
      defaultMapLocationCustomized: true,
      defaultMapLocation: { lat: 37.5, lng: 127, zoom: 120 },
    } as never);
  });

  const withForecast = async () => {
    const weather = await import("../../lib/weather");
    // spyOn 은 이미 스파이가 걸린 export 에 **같은 mock** 을 돌려주므로(파일 전역으로 호출
    // 기록이 누적된다) 매번 비운다 — "호출 0회" 단언이 앞 테스트의 호출을 보지 않게.
    vi.spyOn(weather, "fetchDailyForecast").mockClear().mockResolvedValue(FORECAST);
  };

  it("renders the 3:7 strip outside the cards, a master row card and one region card (R4·R5)", async () => {
    await withForecast();
    const { container } = render(<ViewSection />);

    const strip = screen.getByTestId("settings-region-strip");
    const cards = container.querySelectorAll(".card");
    expect(cards).toHaveLength(2); // 마스터 행 카드 + 지역 카드
    // R1: 통계 띠는 박스에 넣지 않는다 — 스트립은 어떤 카드 안에도 없다.
    for (const card of Array.from(cards)) expect(card.contains(strip)).toBe(false);
    expect(strip.style.gridTemplateColumns).toBe("minmax(0, 3fr) minmax(0, 7fr)");

    // 흡수되어 사라진 통계 타일 2개.
    expect(screen.queryByTestId("settings-region-tiles")).toBeNull();
    expect(screen.queryByTestId("metric-tile-local-time")).toBeNull();
    expect(screen.queryByTestId("metric-tile-today-temp")).toBeNull();
  });

  it("R4: 예보 머리는 지역 이름이고, 시계는 예보가 준 시간대로만 그린다", async () => {
    await withForecast();
    render(<ViewSection />);
    expect(screen.getByTestId("settings-region-place").textContent).toBe("서울");
    await waitFor(() => expect(screen.getByTestId("settings-region-timezone").textContent).toBe("Asia/Seoul"));
    expect(screen.getByTestId("settings-region-clock").textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it("시간대가 없으면 이 PC 의 시각을 그리고 '이 PC 기준 시각' 이라고 밝힌다", async () => {
    const weather = await import("../../lib/weather");
    vi.spyOn(weather, "fetchDailyForecast").mockClear().mockResolvedValue({ ...FORECAST, timezone: undefined });
    render(<ViewSection />);
    await screen.findByTestId("settings-weather-7day");
    expect(screen.getByTestId("settings-region-clock").textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByTestId("settings-region-timezone").textContent).toBe("이 PC 기준 시각");
  });

  it("예보를 못 받으면 출처 줄만 남기지 않고 '불러오지 못했습니다' 한 줄을 세운다", async () => {
    const weather = await import("../../lib/weather");
    vi.spyOn(weather, "fetchDailyForecast").mockClear().mockResolvedValue(null);
    render(<ViewSection />);
    expect(await screen.findByTestId("settings-weather-unavailable")).toBeTruthy();
  });

  it("첫 줄 토글은 무엇을 끄는지 이름과 힌트로 말한다", () => {
    render(<ViewSection />);
    const control = screen.getByTestId("settings-region-enabled-control");
    expect(control.textContent).toContain("기준 지역 활용");
    expect(within(control).getByLabelText(/현지 시간/)).toBeTruthy();
    expect(control.contains(screen.getByTestId("settings-switch-region-enabled"))).toBe(true);
  });

  // 2026-09-19 오너 재번복(PLAN-2026-09-19-calendar-schedule §0): 달력 카드는 "달력 및 일정" 으로 갔다.
  it("R6 재번복: 달력 카드는 없고 찾아갈 곳을 말하는 한 줄만 남는다", () => {
    render(<ViewSection />);
    expect(screen.queryByTestId("settings-calendar-card")).toBeNull();
    expect(screen.queryByLabelText("주 시작일")).toBeNull();
    expect(screen.queryByLabelText("공휴일")).toBeNull();
    expect(screen.getByTestId("settings-region-calendar-moved").textContent).toContain("달력 및 일정");
  });

  it("R4: 주간 예보가 7일치로 선다", async () => {
    await withForecast();
    render(<ViewSection />);
    const strip = await screen.findByTestId("settings-weather-7day");
    expect(strip.children).toHaveLength(7);
    expect(screen.getByTestId("settings-region-strip").contains(strip)).toBe(true);
  });

  // R3 게이트의 관측 가능한 결과 두 가지를 한 번에 본다: met.no 왕복 0회, 그리고 "꺼짐" 한 줄.
  it("R3: region_enabled 가 꺼져 있으면 met.no 호출이 0회이고 스트립은 꺼짐 한 줄이다", async () => {
    await withForecast();
    useSettingsStore.setState({ regionEnabled: false } as never);
    render(<ViewSection />);

    expect(screen.getByTestId("settings-region-off")).toBeTruthy();
    expect(screen.queryByTestId("settings-region-clock")).toBeNull();
    expect(screen.queryByTestId("settings-weather-7day")).toBeNull();
    const weather = await import("../../lib/weather");
    expect(weather.fetchDailyForecast).not.toHaveBeenCalled();
    expect(callMock.mock.calls.some((c) => c[0] === "weather_forecast")).toBe(false);
  });

  it("R2: 히어로의 마스터 토글이 region_enabled 를 저장한다", async () => {
    render(<ViewSection />);
    const toggle = screen.getByTestId("settings-switch-region-enabled");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { region_enabled: "0" } }),
    );
  });

  it("states the causal chain on screen, not behind an info badge", () => {
    render(<ViewSection />);
    const lede = screen.getByTestId("settings-region-lede");
    expect(lede.textContent?.trim()).toBeTruthy();
    // One line, never a paragraph (docs/DESIGN.md 3): no hard break inside the lede.
    expect(lede.textContent).not.toContain(String.fromCharCode(10));
  });

  // R5: 지도와 지역 이름·검색은 RegionPickerFields 가 이미 가진 6:4 퍼센트 flex 2단이다 —
  // ViewSection 이 두 번째 격자를 덧대지 않는다(고정 px 열은 여전히 없다, D12).
  it("lays the region card out with one fluid two-column picker — no fixed px column", () => {
    const { container } = render(<ViewSection />);
    expect(screen.getByTestId("stub-map")).toBeTruthy();
    expect(container.querySelector("[data-testid='settings-region-grid']")).toBeNull();
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
      expect(el.getAttribute("style") ?? "").not.toMatch(/gridTemplateColumns:\s*\d+px/);
    }
  });

  it("no longer owns the status add-lock toggle — it moved to the dashboard page (D10)", () => {
    render(<ViewSection />);
    expect(screen.queryByTestId("settings-status-add-locked")).toBeNull();
  });

  // Title is pinned to the covered_by literal in specs/features/settings.yaml (check:features, not this
  // slice's file). Since R5 the only sub-group left has no divider, so the count is now zero.
  it("draws no row hairlines — only the one sub-group boundary carries a divider (D2)", () => {
    const { container } = render(<ViewSection />);
    // `border: 0` (HintBadge's screen-reader span) is not a hairline — match drawn ones only.
    // 스트립은 카드 밖의 **상자**라 4변 `border` 를 갖는다(행 규칙이 아니다).
    const bordered = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
      /border-(top|bottom):\s*1px/.test(el.getAttribute("style") ?? ""),
    );
    expect(bordered).toHaveLength(0);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
      expect(el.getAttribute("style") ?? "").not.toContain("var(--line)");
    }
  });
});
