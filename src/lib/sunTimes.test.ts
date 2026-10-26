import { describe, expect, it } from "vitest";
import { sunTimes } from "./sunTimes";

const utcMin = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

describe("sunTimes", () => {
  it("서울 9/30: 일출 ≈ 06:1x KST, 일몰 ≈ 18:0x KST (±15분)", () => {
    const r = sunTimes(new Date(2026, 8, 30, 12), 37.5665, 126.978)!;
    // 06:12 KST = 21:12 UTC, 18:07 KST = 09:07 UTC
    expect(Math.abs(utcMin(r.sunrise) - (21 * 60 + 12))).toBeLessThanOrEqual(15);
    expect(Math.abs(utcMin(r.sunset) - (9 * 60 + 7))).toBeLessThanOrEqual(15);
    expect(r.sunset.getTime()).toBeGreaterThan(r.sunrise.getTime());
  });
  it("적도 낮 길이 ≈ 12시간", () => {
    const r = sunTimes(new Date(2026, 2, 20, 12), 0, 0)!;
    expect(Math.abs((r.sunset.getTime() - r.sunrise.getTime()) / 3_600_000 - 12)).toBeLessThan(0.3);
  });
  it("백야·극야·잘못된 좌표는 null", () => {
    expect(sunTimes(new Date(2026, 5, 21, 12), 80, 0)).toBeNull();
    expect(sunTimes(new Date(2026, 11, 21, 12), 80, 0)).toBeNull();
    expect(sunTimes(new Date(2026, 5, 21, 12), NaN, 0)).toBeNull();
  });
});
