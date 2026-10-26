import { describe, expect, it } from "vitest";
import { pickNearest, type FluidRect } from "./FluidHover";

/** 32px 행 5개를 4px 간격으로 세로로 쌓은 목록 — 행 사이에 실제 빈 틈이 있다. */
const rows: FluidRect[] = Array.from({ length: 5 }, (_, i) => ({
  x: 0,
  y: i * 36,
  w: 200,
  h: 32,
  group: i < 3 ? 0 : 1,
  radius: "6px",
}));

describe("pickNearest", () => {
  it("행 위에서는 그 행을 고른다", () => {
    expect(pickNearest(rows, 100, 16, "y")).toBe(0);
    expect(pickNearest(rows, 100, 16 + 36 * 3, "y")).toBe(3);
  });

  it("행 사이 빈 틈에서도 항상 하나가 켜진다 — dead zone 이 없다", () => {
    // 0번(중심 16)과 1번(중심 52) 사이의 틈: 32~36
    expect(pickNearest(rows, 100, 33, "y")).toBe(0);
    expect(pickNearest(rows, 100, 35, "y")).toBe(1);
  });

  it("목록 밖으로 나가도 가장 가까운 끝 행을 유지한다", () => {
    expect(pickNearest(rows, 100, -500, "y")).toBe(0);
    expect(pickNearest(rows, 100, 5000, "y")).toBe(4);
  });

  it("axis=y 는 x 를 무시한다 — 세로 목록은 좌우로 벗어나도 같은 행", () => {
    expect(pickNearest(rows, 9999, 16, "y")).toBe(0);
  });

  it("axis=x 는 가로 스트립을 고른다", () => {
    const tabs: FluidRect[] = Array.from({ length: 4 }, (_, i) => ({
      x: i * 80,
      y: 0,
      w: 72,
      h: 28,
      group: 0,
      radius: "0px",
    }));
    expect(pickNearest(tabs, 5, 14, "x")).toBe(0);
    expect(pickNearest(tabs, 170, 14, "x")).toBe(2);
    // 탭 사이 틈(72~80)에서도 하나가 켜진다
    expect(pickNearest(tabs, 76, 14, "x")).toBe(0);
  });

  it("axis=xy 는 두 축 모두 본다 — 격자에서 가장 가까운 카드", () => {
    const grid: FluidRect[] = [
      { x: 0, y: 0, w: 100, h: 100, group: 0, radius: "8px" },
      { x: 120, y: 0, w: 100, h: 100, group: 0, radius: "8px" },
      { x: 0, y: 120, w: 100, h: 100, group: 0, radius: "8px" },
      { x: 120, y: 120, w: 100, h: 100, group: 0, radius: "8px" },
    ];
    expect(pickNearest(grid, 110, 10, "xy")).toBe(0);
    expect(pickNearest(grid, 130, 200, "xy")).toBe(3);
  });

  it("항목이 없으면 아무것도 고르지 않는다", () => {
    expect(pickNearest([], 10, 10, "y")).toBeNull();
  });
});
