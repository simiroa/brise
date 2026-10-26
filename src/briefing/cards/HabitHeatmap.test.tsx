import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HabitHistory } from "../../lib/commands.gen";
import { dayAfter, heatmapRange } from "../hooks/useBriefingData";
import { buildHeatGrid, HabitHeatmap, heatLevel } from "./HabitHeatmap";

// 2026-10-21 = 수요일
const TODAY = "2026-10-21";

function history(weekStart: "monday" | "sunday", fill: (day: string) => { scheduled: number; done: number }): HabitHistory {
  const { from, to } = heatmapRange(TODAY, weekStart);
  const days = [];
  for (let d = from; d <= to; d = dayAfter(d, 1)) days.push({ day: d, ...fill(d) });
  return { from, to, days };
}

describe("heatLevel — 5단계 + 빈칸", () => {
  it("scheduled 0 은 빈칸, 0 은 옅은 바탕, 비율 3등분, 전부는 4", () => {
    expect(heatLevel(0, 0)).toBe("off");
    expect(heatLevel(3, 0)).toBe(0);
    expect(heatLevel(3, 1)).toBe(1); // 1/3 경계는 아래 단
    expect(heatLevel(4, 1)).toBe(1);
    expect(heatLevel(2, 1)).toBe(2);
    expect(heatLevel(3, 2)).toBe(2); // 2/3 경계는 아래 단
    expect(heatLevel(4, 3)).toBe(3);
    expect(heatLevel(3, 3)).toBe(4);
    expect(heatLevel(2, 5)).toBe(4); // done > scheduled 는 1 로 자른다
  });
});

describe("heatmapRange — 주 시작 정렬", () => {
  it("월요일 시작: 이번 주 월요일의 11주 전 월요일 ~ 오늘", () => {
    const { from, to } = heatmapRange(TODAY, "monday");
    expect(to).toBe(TODAY);
    expect(from).toBe(dayAfter("2026-10-19", -77));
    expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(1);
  });
  it("일요일 시작: 이번 주 일요일 기준", () => {
    const { from } = heatmapRange(TODAY, "sunday");
    expect(from).toBe(dayAfter("2026-10-18", -77));
    expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(0);
  });
  it("오늘이 주 첫날이면 그 날이 마지막 열의 첫 칸", () => {
    expect(heatmapRange("2026-10-19", "monday").from).toBe(dayAfter("2026-10-19", -77));
  });
});

describe("buildHeatGrid", () => {
  it("84칸 = 7행 × 12열, 첫 행은 주 시작 요일, 오늘 이후는 future", () => {
    const h = history("monday", () => ({ scheduled: 2, done: 1 }));
    const cells = buildHeatGrid(h, TODAY);
    expect(cells).toHaveLength(84);
    expect(cells[0].row).toBe(0);
    expect(cells[83].col).toBe(11);
    expect(new Date(`${cells[7].day}T00:00:00Z`).getUTCDay()).toBe(1); // 두 번째 열 첫 칸도 월요일
    const todayCell = cells.find((c) => c.day === TODAY)!;
    expect(todayCell.col).toBe(11);
    expect(todayCell.row).toBe(2); // 월·화·수
    expect(cells.filter((c) => c.future)).toHaveLength(4); // 목~일
  });
  it("응답에 없는 날은 빈칸(off)", () => {
    const h = { ...history("monday", () => ({ scheduled: 1, done: 1 })), days: [] };
    expect(buildHeatGrid(h, TODAY).filter((c) => !c.future).every((c) => c.level === "off")).toBe(true);
  });
});

describe("HabitHeatmap", () => {
  it("칸 수·오늘 윤곽·빈칸·라벨 문구", () => {
    const h = history("monday", (d) => (d === TODAY ? { scheduled: 3, done: 2 } : d === "2026-10-20" ? { scheduled: 0, done: 0 } : { scheduled: 1, done: 1 }));
    render(<HabitHeatmap history={h} today={TODAY} uiLang="ko" />);
    const cells = screen.getAllByTestId("brf-heat-cell");
    expect(cells).toHaveLength(84);
    expect(cells.filter((c) => c.dataset.future === "1")).toHaveLength(4);
    const today = cells.find((c) => c.dataset.day === TODAY)!;
    expect(today.className).toContain("is-today");
    expect(today.dataset.level).toBe("2");
    expect(today.getAttribute("aria-label")).toContain("2/3");
    const off = cells.find((c) => c.dataset.day === "2026-10-20")!;
    expect(off.dataset.level).toBe("off");
    expect(off.className).toContain("is-loff");
    // 오늘 아닌 칸은 윤곽선이 없다
    expect(cells.filter((c) => c.className.includes("is-today"))).toHaveLength(1);
  });
});
