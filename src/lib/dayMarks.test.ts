import { describe, it, expect, beforeEach } from "vitest";
import { expandDayMarks, markDaysInYear, markOrdinal, BUILTIN_SOURCE } from "./dayMarks";
import { useSettingsStore } from "../stores/settings";
import type { CalendarMark, CalendarSource } from "./commands.gen";

const mark = (over: Partial<CalendarMark>): CalendarMark => ({
  id: "m",
  workspace_id: "ws",
  source_id: null,
  uid: null,
  title: "엄마 생일",
  year: null,
  month: 5,
  day: 12,
  repeat: "yearly",
  lunar: false,
  day_off: false,
  color_hue: null,
  created_at: "",
  updated_at: "",
  ...over,
});

const source = (over: Partial<CalendarSource>): CalendarSource => ({
  id: "s1",
  workspace_id: "ws",
  name: "공휴일",
  url: null,
  enabled: true,
  color_hue: null,
  fetched_at: null,
  position: 0,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("markDaysInYear", () => {
  it("한 번짜리는 그해에만", () => {
    const m = mark({ repeat: "once", year: 2026 });
    expect(markDaysInYear(m, 2026)).toEqual(["2026-05-12"]);
    expect(markDaysInYear(m, 2027)).toEqual([]);
  });

  it("매년은 첫해를 모르면 언제나, 알면 첫해부터", () => {
    expect(markDaysInYear(mark({}), 1990)).toEqual(["1990-05-12"]);
    const m = mark({ year: 2020 });
    expect(markDaysInYear(m, 2019)).toEqual([]);
    expect(markDaysInYear(m, 2020)).toEqual(["2020-05-12"]);
    expect(markDaysInYear(m, 2031)).toEqual(["2031-05-12"]);
  });

  it("양력 2/29 매년 기념일은 평년에 2/28", () => {
    const m = mark({ month: 2, day: 29 });
    expect(markDaysInYear(m, 2028)).toEqual(["2028-02-29"]);
    expect(markDaysInYear(m, 2026)).toEqual(["2026-02-28"]);
  });

  it("음력 매년은 그해 양력 날짜로 떨어진다", () => {
    expect(markDaysInYear(mark({ lunar: true, month: 1, day: 1 }), 2026)).toEqual(["2026-02-17"]);
  });
});

describe("markOrdinal", () => {
  it("매년 + 첫해를 알 때만, 1 이상일 때만", () => {
    expect(markOrdinal(mark({ year: 2020 }), 2026)).toBe(6);
    expect(markOrdinal(mark({ year: 2026 }), 2026)).toBeNull();
    expect(markOrdinal(mark({}), 2026)).toBeNull();
    expect(markOrdinal(mark({ repeat: "once", year: 2020 }), 2026)).toBeNull();
  });
});

describe("expandDayMarks", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" } as never);
  });

  it("빨간 날(day_off)과 이름표가 갈린다 — 기본 공휴일은 빨간 날", () => {
    const r = expandDayMarks(2026, {
      region: "kr",
      marks: [mark({ id: "a", title: "결혼기념일" }), mark({ id: "b", title: "휴가", month: 7, day: 1, day_off: true })],
      sources: [],
      hides: [],
    });
    expect(r.off.get("2026-03-01")).toBe("삼일절");
    expect(r.off.get("2026-07-01")).toBe("휴가");
    expect(r.labels.get("2026-05-12")).toBe("결혼기념일");
    expect(r.off.has("2026-05-12")).toBe(false);
  });

  it("같은 날 여럿은 ' · ' 로 합친다 + 햇수는 ordinal 문구로", () => {
    const r = expandDayMarks(2026, {
      region: "kr",
      marks: [mark({ title: "창립일", month: 3, day: 1, day_off: true, year: 2021 })],
      sources: [],
      hides: [],
    });
    expect(r.off.get("2026-03-01")).toBe("삼일절 · 창립일 · 5주년");
  });

  it("숨긴 날: 기본 공휴일은 builtin 출처로, 불러온 표시일은 그 출처 id 로 빠진다", () => {
    const r = expandDayMarks(2026, {
      region: "kr",
      marks: [mark({ source_id: "s1", title: "식목일", month: 4, day: 5, repeat: "once", year: 2026, day_off: true })],
      sources: [source({})],
      hides: [
        { source: BUILTIN_SOURCE, iso_day: "2026-03-01" },
        { source: "s1", iso_day: "2026-04-05" },
      ],
    });
    expect(r.off.has("2026-03-01")).toBe(false);
    expect(r.off.has("2026-04-05")).toBe(false);
    expect(r.off.get("2026-05-05")).toBe("어린이날");
  });

  it("꺼진 출처의 표시일은 통째로 빠진다", () => {
    const r = expandDayMarks(2026, {
      region: "none",
      marks: [mark({ source_id: "s1", title: "식목일", month: 4, day: 5, day_off: true })],
      sources: [source({ enabled: false })],
      hides: [],
    });
    expect(r.off.size).toBe(0);
    expect(r.labels.size).toBe(0);
  });
});
