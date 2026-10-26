import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { MapPlaceSearch } from "./MapPlaceSearch";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../stores/settings", () => {
  const state = { uiLang: "en" };
  const useSettingsStore = (sel: (s: typeof state) => unknown) => sel(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

describe("MapPlaceSearch", () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces geocode_search and reports pick with coords", async () => {
    callMock.mockResolvedValue({
      results: [{ label: "Seoul, KR", lat: 37.57, lng: 126.98 }],
    });
    const onPick = vi.fn();
    const { getByTestId } = render(<MapPlaceSearch onPick={onPick} />);

    fireEvent.change(getByTestId("home-map-search-input"), {
      target: { value: "Seoul" },
    });

    expect(callMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Flush the resolved geocode promise
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(callMock).toHaveBeenCalledWith("geocode_search", {
      query: "Seoul",
      lang: "en",
    });

    const resultBtn = getByTestId("home-map-search-result-0");
    fireEvent.click(resultBtn);
    expect(onPick).toHaveBeenCalledWith(
      { label: "Seoul, KR", lat: 37.57, lng: 126.98 },
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("ignores stale geocode_search response when query changes before response resolves", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    let resolveSecond: (v: unknown) => void = () => {};

    callMock.mockImplementation((_cmd: string, args: { query: string }) => {
      if (args.query === "Paris") {
        return new Promise((r) => {
          resolveFirst = r;
        });
      }
      if (args.query === "Berlin") {
        return new Promise((r) => {
          resolveSecond = r;
        });
      }
      return Promise.resolve({ results: [] });
    });

    const onPick = vi.fn();
    const { getByTestId, queryByText } = render(<MapPlaceSearch onPick={onPick} />);

    fireEvent.change(getByTestId("home-map-search-input"), { target: { value: "Paris" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    fireEvent.change(getByTestId("home-map-search-input"), { target: { value: "Berlin" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Resolve Berlin first (newer)
    await act(async () => {
      resolveSecond({ results: [{ label: "Berlin, DE", lat: 52.52, lng: 13.40 }] });
      await Promise.resolve();
    });

    expect(queryByText("Berlin, DE")).not.toBeNull();

    // Now resolve Paris late (older)
    await act(async () => {
      resolveFirst({ results: [{ label: "Paris, FR", lat: 48.85, lng: 2.35 }] });
      await Promise.resolve();
    });

    // Paris should NOT overwrite Berlin!
    expect(queryByText("Paris, FR")).toBeNull();
    expect(queryByText("Berlin, DE")).not.toBeNull();
  });

  it("U-11: 고른 뒤 입력란이 라벨 앞부분으로 바뀌어도 다시 검색하지도, 목록을 다시 열지도 않는다", async () => {
    callMock.mockResolvedValue({
      results: [{ label: "서울특별시, 대한민국", lat: 37.57, lng: 126.98 }],
    });
    const { getByTestId, queryByTestId } = render(<MapPlaceSearch onPick={vi.fn()} />);
    fireEvent.change(getByTestId("home-map-search-input"), { target: { value: "서울" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(callMock).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("home-map-search-result-0"));
    expect((getByTestId("home-map-search-input") as HTMLInputElement).value).toBe("서울특별시");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(queryByTestId("home-map-search-results")).toBeNull();
  });

  it("U-11: 검색 중에는 드롭다운이 열려 '불러오는 중'이 보인다", async () => {
    callMock.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<MapPlaceSearch onPick={vi.fn()} />);
    fireEvent.change(getByTestId("home-map-search-input"), { target: { value: "서울" } });
    expect(getByTestId("home-map-search-results")).toBeTruthy();
  });
});
