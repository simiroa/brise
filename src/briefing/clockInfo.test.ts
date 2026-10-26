import { describe, expect, it } from "vitest";
import { dayOfYear, handAngles, hhmm, isoWeek } from "./clockInfo";

describe("clockInfo", () => {
  it("dayOfYear: 1/1=1, 9/30=273(평년), 12/31=365/366", () => {
    expect(dayOfYear(new Date(2026, 0, 1))).toBe(1);
    expect(dayOfYear(new Date(2026, 8, 30))).toBe(273);
    expect(dayOfYear(new Date(2026, 11, 31))).toBe(365);
    expect(dayOfYear(new Date(2028, 11, 31))).toBe(366);
  });
  it("isoWeek: 경계(연초·연말) 와 9/30", () => {
    expect(isoWeek(new Date(2026, 8, 30))).toBe(40);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1); // 목요일
    expect(isoWeek(new Date(2021, 0, 1))).toBe(53); // 금요일 → 전년 53주
    expect(isoWeek(new Date(2024, 11, 30))).toBe(1); // 월요일 → 2025 1주
  });
  it("handAngles", () => {
    expect(handAngles(new Date(2026, 0, 1, 8, 42))).toEqual({ hour: 261, minute: 252 });
    expect(handAngles(new Date(2026, 0, 1, 0, 0))).toEqual({ hour: 0, minute: 0 });
  });
});

describe("hhmm", () => {
  it("로컬 시각을 0 채워 HH:MM 으로", () => {
    expect(hhmm(new Date(2026, 0, 2, 3, 4))).toBe("03:04");
    expect(hhmm(new Date(2026, 0, 2, 23, 59))).toBe("23:59");
  });
});
