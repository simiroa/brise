import { describe, it, expect, vi, beforeEach } from "vitest";
import { holidaysForYear } from "./holidays";
import { solarToLunar } from "./lunar";

// A(AUDIT-2026-09-26): a year outside the static table is now reported once per year.
const reportFallbackMock = vi.fn();
vi.mock("./diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

beforeEach(() => {
  reportFallbackMock.mockClear();
});

describe("holidaysForYear", () => {
  it("kr 2026: fixed, lunar-resolved and substitute holidays land on the right ISO days", () => {
    const h = holidaysForYear("kr", 2026);
    expect(h.get("2026-01-01")).toBe("신정");
    expect(h.get("2026-02-17")).toBe("설날");
    // 3/1 is a Sunday in 2026 → Monday is the 대체공휴일.
    expect(h.get("2026-03-01")).toBe("삼일절");
    expect(h.get("2026-03-02")).toBe("대체공휴일");
    // 추석 연휴 ends on a Saturday — §3 gives 설·추석 a substitute only for Sunday/holiday overlap.
    expect(h.get("2026-09-26")).toBe("추석 연휴");
    expect(h.has("2026-09-28")).toBe(false);
    for (const day of h.keys()) expect(day).toMatch(/^2026-\d\d-\d\d$/);
  });

  it("region none, or a year past the table, is empty (never throws)", () => {
    expect(holidaysForYear("none", 2026).size).toBe(0);
    expect(holidaysForYear("kr", 1999).size).toBe(0);
    expect(holidaysForYear("kr", 2099).size).toBe(0);
  });

  // A(AUDIT-2026-09-26): out-of-table years are now reported — once per distinct year, not once
  // per call (a calendar view calls this repeatedly for the same year while rendering).
  it("reports a fallback once per distinct out-of-table year, never for region 'none'", () => {
    holidaysForYear("none", 2050); // region gate short-circuits before the table lookup
    expect(reportFallbackMock).not.toHaveBeenCalled();

    holidaysForYear("kr", 2050);
    holidaysForYear("kr", 2050);
    holidaysForYear("kr", 2050);
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock).toHaveBeenCalledWith("holidays", "year_out_of_table", "year=2050");

    holidaysForYear("kr", 2051);
    expect(reportFallbackMock).toHaveBeenCalledTimes(2);
    expect(reportFallbackMock).toHaveBeenLastCalledWith("holidays", "year_out_of_table", "year=2051");

    // A year IN the table never reports.
    holidaysForYear("kr", 2026);
    expect(reportFallbackMock).toHaveBeenCalledTimes(2);
  });

  // 2027·2028 은 설날이 중국 춘절보다 하루 늦는 해다(합삭이 서울에선 자정을 넘긴다). 표가 춘절
  // 날짜로 들어가 있던 것을 2026-09-19 에 바로잡았다.
  it("kr 2027/2028: 설날 is the Korean date, one day after Chinese New Year, with the right substitute", () => {
    const h27 = holidaysForYear("kr", 2027);
    expect(h27.get("2027-02-06")).toBe("설날 연휴"); // 토
    expect(h27.get("2027-02-07")).toBe("설날"); // 일 → 대체공휴일 하나
    expect(h27.get("2027-02-08")).toBe("설날 연휴");
    expect(h27.get("2027-02-09")).toBe("대체공휴일");
    expect(h27.has("2027-02-05")).toBe(false);
    const h28 = holidaysForYear("kr", 2028);
    expect(h28.get("2028-01-26")).toBe("설날 연휴");
    expect(h28.get("2028-01-27")).toBe("설날");
    expect(h28.get("2028-01-28")).toBe("설날 연휴");
    expect(h28.has("2028-01-25")).toBe(false);
  });

  // 표의 음력 공휴일 **전부**를 음력 변환(lib/lunar.ts, ICU dangi = 한국 기준)과 대조한다. 표는 손으로
  // 적은 날짜라 위 같은 하루 어긋남이 조용히 들어올 수 있다 — 표를 늘릴 때 이 테스트가 잡는다.
  it("every lunar holiday in the table agrees with the lunar calendar (설날 1.1 · 부처님오신날 4.8 · 추석 8.15)", () => {
    const want: Array<[RegExp, number, number]> = [
      [/^설날$/, 1, 1],
      [/부처님오신날/, 4, 8],
      [/^추석(?! 연휴)/, 8, 15],
    ];
    let checked = 0;
    for (let year = 2024; year <= 2030; year += 1) {
      for (const [iso, name] of holidaysForYear("kr", year)) {
        for (const [re, month, day] of want) {
          if (!re.test(name)) continue;
          const lunar = solarToLunar(iso);
          expect(lunar, `${iso} ${name}`).toMatchObject({ month, day, leap: false });
          checked += 1;
        }
      }
    }
    // 7년 × 3종 — 이름이 합쳐진 해("어린이날 · 부처님오신날", "추석 · 개천절")도 정규식이 잡아야 한다.
    expect(checked).toBe(21);
  });
});
