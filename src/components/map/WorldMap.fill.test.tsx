import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { WorldMap } from "./WorldMap";

// jsdom has no ResizeObserver — same minimal stub as the other WorldMap tests.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/**
 * `filledPoints` 는 "글을 쓴 지역"처럼 **면을 칠하는** 입력이다. 마커(점)와 달리 지도가 이미
 * 그리고 있는 나라 지오메트리의 채움만 바꾼다 — 번들 topojson 을 그대로 태워서 실제로 그
 * 나라만 칠해지는지 본다(선언이 아니라 결과를 본다).
 *
 * 개수는 DOM 의 칠해진 path 수가 아니라 콜백으로 본다: 50m/10m 토폴로지는 한 나라를 여러
 * feature 로 쪼개 담기도 해서, 티어가 로드되는 타이밍에 따라 path 수가 흔들린다. 위젯이
 * 보여줄 숫자는 나라 단위여야 하고, 그건 티어와 무관하게 같아야 한다.
 */
describe("WorldMap filledPoints — 점이 들어 있는 나라 면이 칠해진다", () => {
  const SEOUL = { lat: 37.5665, lng: 126.978 };
  const BUSAN = { lat: 35.1796, lng: 129.0756 };
  const PARIS = { lat: 48.8566, lng: 2.3522 };
  // 10m 티어(k≥6)는 이 테스트에 필요 없고 파싱·bbox 로 수백 ms 를 쓴다 — 50m 까지만 태운다.
  const SEED = { lat: 20, lng: 60, zoom: 5 };

  it("점이 없으면 아무 면도 칠하지 않는다", async () => {
    const { container } = render(<WorldMap width={800} height={600} defaultLocation={SEED} />);
    await waitFor(() => expect(container.querySelectorAll("path").length).toBeGreaterThan(10));
    expect(container.querySelectorAll('path[data-filled="true"]').length).toBe(0);
  });

  it("서울 한 점은 나라 하나를 칠한다", async () => {
    const onCount = vi.fn();
    const { container } = render(
      <WorldMap width={800} height={600} defaultLocation={SEED} filledPoints={[SEOUL]} onFilledRegionCount={onCount} />,
    );

    // 실제로 칠해진 면이 DOM 에 있다(개수가 아니라 "칠해졌다"를 본다).
    await waitFor(() =>
      expect(container.querySelectorAll('path[data-filled="true"]').length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });

  it("서로 다른 나라의 두 점은 2를 센다", async () => {
    const onCount = vi.fn();
    render(
      <WorldMap width={800} height={600} defaultLocation={SEED} filledPoints={[SEOUL, PARIS]} onFilledRegionCount={onCount} />,
    );
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  });

  it("같은 나라 안의 두 점은 1을 센다 (feature 가 아니라 나라를 센다)", async () => {
    const onCount = vi.fn();
    render(
      <WorldMap width={800} height={600} defaultLocation={SEED} filledPoints={[SEOUL, BUSAN]} onFilledRegionCount={onCount} />,
    );
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });
});
