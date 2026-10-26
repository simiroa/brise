/**
 * 예보 16일 창 게이트 특성화 — 미니 달력(CalendarExpanded)과 달력 탭(CalendarTab)이 글자 그대로
 * 같은 effect 를 두 벌 들고 있던 것을 useMonthForecast 로 합치기 **전에** 못 박은 동작이다
 * (PLAN-2026-09-13-separation-of-concerns 트랙 D1 ②).
 *
 * 게이트 규칙: 위치가 있어야 하고, 보는 달이 [오늘, 오늘+16일] 창과 겹쳐야만 fetch 한다.
 * 겹치지 않으면 **아무것도 하지 않는다** — setForecast(null) 도 하지 않아 이전 달의 예보가
 * 그대로 남는다(호출자는 그 달 칸을 그리지 않으므로 화면에는 안 보인다).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { CalendarExpanded } from "../../leftpanel/expanded/CalendarExpanded";
import { forecastDayMap, useMonthForecast } from "./useMonthForecast";

const callMock = vi.fn();
const fetchDailyForecastMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: vi.fn(),
}));

vi.mock("../../../lib/noteQuery", () => ({
  noteQueryCollect: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
  noteRecordHistogram: vi.fn().mockResolvedValue({}),
  useNoteQueryVersion: () => 0,
  bumpNoteQueryVersion: vi.fn(),
}));

// 위치는 해결된 상태로 고정 — 이 파일이 검증하는 건 위치 해석이 아니라 **창 게이트**다.
// 진짜 훅처럼 **같은 객체**를 돌려준다(useMemo) — 매번 새 리터럴이면 effect 가 렌더마다 다시 돈다.
vi.mock("../useWeatherLocation", () => {
  const loc = { lat: 37.5665, lng: 126.978, source: "workspace" as const };
  return { useWeatherLocation: () => loc };
});

vi.mock("../../../lib/weather", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/weather")>();
  return { ...actual, fetchDailyForecast: (...args: unknown[]) => fetchDailyForecastMock(...args) };
});

const FIXED_NOW = new Date(2026, 7, 15, 20, 0, 0); // 2026-08-15 → 창 끝 = 2026-08-31

const FORECAST = {
  time: ["2026-08-15", "2026-08-16"],
  weatherCode: [0, 61],
  tempMaxC: [30, 24],
  tempMinC: [21, 19],
  fetchedAt: 0,
};

describe("예보 창 게이트 (미니 달력 배선)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    callMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "dashboard_calendar") return { year: 2026, month: 8, items: [] };
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "folder_list") return { folders: [], notes_by_folder: {} };
      if (cmd === "settings_get_all") return { settings: {} };
      return {};
    });
    fetchDailyForecastMock.mockReset().mockResolvedValue(FORECAST);
    useSettingsStore.setState({ activeWorkspaceId: "ws1" });
    useNotesStore.setState({ activeNote: null, inboxId: "inbox1", folders: [], noteIndex: new Map() } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("오늘이 든 달은 예보를 한 번 부르고 날씨 아이콘을 그린다", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(fetchDailyForecastMock).toHaveBeenCalledTimes(1));
    expect(fetchDailyForecastMock).toHaveBeenCalledWith({ lat: 37.5665, lng: 126.978, source: "workspace" });
    // forecast.time → Map 변환이 살아 있어야 그 날 칸에 title 이 붙는다.
    await waitFor(() =>
      expect(screen.getByTestId("calendar-day-2026-08-16").getAttribute("title")).toContain("24°/19°")
    );
  });

  it("창보다 뒤의 달(다음 달)로 넘기면 부르지 않는다", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(fetchDailyForecastMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await userEvent.click(screen.getByLabelText("Next month"));
    });
    await waitFor(() => expect(screen.getByTestId("calendar-day-2026-09-01")).toBeTruthy());
    expect(fetchDailyForecastMock).toHaveBeenCalledTimes(1);
  });

  it("창보다 앞의 달(지난 달)로 넘겨도 부르지 않는다", async () => {
    render(<CalendarExpanded />);
    await waitFor(() => expect(fetchDailyForecastMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await userEvent.click(screen.getByLabelText("Previous month"));
    });
    await waitFor(() => expect(screen.getByTestId("calendar-day-2026-07-01")).toBeTruthy());
    expect(fetchDailyForecastMock).toHaveBeenCalledTimes(1);
  });
});

const LOC = { lat: 37.5665, lng: 126.978, source: "workspace" as const };

describe("useMonthForecast", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    fetchDailyForecastMock.mockReset().mockResolvedValue(FORECAST);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("위치가 없으면 부르지 않고 예보를 비운다", async () => {
    const { result } = renderHook(() => useMonthForecast(null, 2026, 7));
    await act(async () => {});
    expect(fetchDailyForecastMock).not.toHaveBeenCalled();
    expect(result.current.forecast).toBeNull();
    expect(result.current.forecastByDay).toBeNull();
  });

  it("창 안의 달이면 예보와 조회 맵을 준다", async () => {
    const { result } = renderHook(() => useMonthForecast(LOC, 2026, 7));
    await waitFor(() => expect(result.current.forecast).toEqual(FORECAST));
    expect(result.current.forecastByDay?.get("2026-08-16")).toEqual({ code: 61, max: 24, min: 19 });
  });

  it("enabled:false(달력 탭의 연 보기)면 부르지 않고, 이미 받은 예보도 비운다", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMonthForecast(LOC, 2026, 7, { enabled }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(result.current.forecast).toEqual(FORECAST));

    fetchDailyForecastMock.mockClear();
    await act(async () => {
      rerender({ enabled: false });
    });
    expect(fetchDailyForecastMock).not.toHaveBeenCalled();
    expect(result.current.forecast).toBeNull();
    expect(result.current.forecastByDay).toBeNull();
  });
});

describe("forecastDayMap", () => {
  it("평행 배열을 날짜 키 맵으로 뒤집는다", () => {
    const map = forecastDayMap(FORECAST);
    expect(map?.size).toBe(2);
    expect(map?.get("2026-08-15")).toEqual({ code: 0, max: 30, min: 21 });
    expect(map?.get("2026-08-16")).toEqual({ code: 61, max: 24, min: 19 });
    expect(map?.get("2026-08-17")).toBeUndefined();
  });

  it("예보가 없거나 time 배열이 없으면 null", () => {
    expect(forecastDayMap(null)).toBeNull();
    expect(forecastDayMap({ ...FORECAST, time: undefined as unknown as string[] })).toBeNull();
  });
});
