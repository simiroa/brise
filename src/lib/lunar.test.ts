import { describe, it, expect } from "vitest";
import { lunarToSolarDays, solarToLunar } from "./lunar";

// docs/PLAN-2026-09-19-calendar-schedule.md §3 — Intl dangi 달력으로 표 없이 음력 → 양력.
describe("lunarToSolarDays", () => {
  it("2026 음 1.1(설날) → 2026-02-17", () => {
    expect(lunarToSolarDays(2026, 1, 1)).toEqual(["2026-02-17"]);
  });

  it("그해 그 달이 29일로 끝나면 30일 기념일은 29일로 간다", () => {
    // 2026 음력 2월은 29일까지.
    const d29 = lunarToSolarDays(2026, 2, 29);
    expect(d29).toHaveLength(1);
    expect(lunarToSolarDays(2026, 2, 30)).toEqual(d29);
  });

  it("30일까지 있는 달의 30일은 그대로", () => {
    // 2026 음력 1월은 30일까지 — 29일과 다른 날.
    const d30 = lunarToSolarDays(2026, 1, 30);
    expect(d30).toHaveLength(1);
    expect(d30).not.toEqual(lunarToSolarDays(2026, 1, 29));
  });

  it("윤달의 날은 치지 않는다 — 2025 윤6월 1일(07-25)이 아니라 평달 6월 1일만", () => {
    expect(lunarToSolarDays(2025, 6, 1)).toEqual(["2025-06-25"]);
  });
});

describe("solarToLunar", () => {
  it("평달과 윤달을 구분한다", () => {
    expect(solarToLunar("2026-02-17")).toEqual({ month: 1, day: 1, leap: false });
    expect(solarToLunar("2025-07-25")).toEqual({ month: 6, day: 1, leap: true });
  });

  it("날짜가 아니면 null", () => {
    expect(solarToLunar("not-a-date")).toBeNull();
  });
});
