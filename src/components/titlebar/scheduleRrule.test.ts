import { describe, it, expect, afterEach } from "vitest";
import {
  buildRrule,
  parseRruleForUi,
  offsetKeyFromMinutes,
  offsetMinutesFromKey,
  formatScheduleSummary,
  scheduleLabels,
  EMPTY_REPEAT,
  type ScheduleLike,
} from "./scheduleRrule";
import { useSettingsStore } from "../../stores/settings";

describe("buildRrule (docs/PLAN-schedule-system.md §3.1)", () => {
  it("'none' freq means no repeat", () => {
    expect(buildRrule({ ...EMPTY_REPEAT, freq: "none" })).toBeNull();
  });

  it("omits INTERVAL when it's 1 (grammar: omitted == 1)", () => {
    expect(buildRrule({ freq: "DAILY", interval: "1", byday: [], until: "" })).toBe("FREQ=DAILY");
  });

  it("includes INTERVAL when > 1", () => {
    expect(buildRrule({ freq: "DAILY", interval: "3", byday: [], until: "" })).toBe(
      "FREQ=DAILY;INTERVAL=3",
    );
  });

  it("BYDAY only appears for WEEKLY, in fixed SU..SA order regardless of selection order", () => {
    expect(
      buildRrule({ freq: "WEEKLY", interval: "1", byday: ["FR", "MO"], until: "" }),
    ).toBe("FREQ=WEEKLY;BYDAY=MO,FR");
    // MONTHLY ignores byday entirely (grammar forbids BYDAY outside WEEKLY).
    expect(
      buildRrule({ freq: "MONTHLY", interval: "1", byday: ["MO"], until: "" }),
    ).toBe("FREQ=MONTHLY");
  });

  it("UNTIL compresses YYYY-MM-DD to YYYYMMDD, inclusive semantics live server-side", () => {
    expect(buildRrule({ freq: "YEARLY", interval: "1", byday: [], until: "2026-12-31" })).toBe(
      "FREQ=YEARLY;UNTIL=20261231",
    );
  });

  it("round-trips a full combination", () => {
    const rrule = buildRrule({ freq: "WEEKLY", interval: "2", byday: ["TU", "TH"], until: "2026-12-25" });
    expect(rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261225");
  });
});

describe("parseRruleForUi", () => {
  it("null/undefined -> EMPTY_REPEAT", () => {
    expect(parseRruleForUi(null)).toEqual(EMPTY_REPEAT);
    expect(parseRruleForUi(undefined)).toEqual(EMPTY_REPEAT);
  });

  it("round-trips whatever buildRrule produces", () => {
    const draft = { freq: "WEEKLY" as const, interval: "2", byday: ["TU", "TH"], until: "2026-12-25" };
    const rrule = buildRrule(draft)!;
    expect(parseRruleForUi(rrule)).toEqual(draft);
  });

  it("defaults INTERVAL to '1' when omitted (grammar: omitted == 1)", () => {
    expect(parseRruleForUi("FREQ=DAILY")).toEqual({ freq: "DAILY", interval: "1", byday: [], until: "" });
  });

  it("ignores unknown/malformed parts rather than throwing", () => {
    expect(parseRruleForUi("FREQ=DAILY;COUNT=5;GARBAGE")).toEqual({
      freq: "DAILY",
      interval: "1",
      byday: [],
      until: "",
    });
  });
});

describe("offset preset round-trip (§7.3/§9-10 — 7 fixed presets, no free input)", () => {
  it("exact (정시) maps to null minutes and back", () => {
    expect(offsetMinutesFromKey("exact")).toBeNull();
    expect(offsetKeyFromMinutes(null)).toBe("exact");
    expect(offsetKeyFromMinutes(undefined)).toBe("exact");
  });

  it("every preset round-trips key -> minutes -> key", () => {
    for (const key of ["exact", "5m", "10m", "15m", "30m", "1h", "1d"]) {
      const minutes = offsetMinutesFromKey(key);
      expect(offsetKeyFromMinutes(minutes)).toBe(key);
    }
  });

  it("an unrecognized minute value (not one of the 7 presets) falls back to 'exact'", () => {
    expect(offsetKeyFromMinutes(7)).toBe("exact");
  });
});

/**
 * PLAN-2026-09-10-calendar-reminders.md D5 — 라벨은 여기 한 곳에서만 만들어진다. NoteDatesList 의
 * 칩 셋(scheduleLabels)과 달력 카드의 요약 한 줄(formatScheduleSummary)이 같은 값을 쓴다.
 */
describe("formatScheduleSummary", () => {
  const row = (p: Partial<ScheduleLike> = {}): ScheduleLike => ({
    start_time: null,
    end_time: null,
    remind: false,
    remind_offset_min: null,
    rrule: null,
    ...p,
  });

  afterEach(() => useSettingsStore.setState({ uiLang: "en" }));
  const setLang = (l: string) => useSettingsStore.setState({ uiLang: l });

  it("벨 on — 시각·알림시점·반복을 그 순서로 잇는다 (ko)", () => {
    setLang("ko");
    expect(
      formatScheduleSummary(
        row({ start_time: "09:00", end_time: "10:00", remind: true, remind_offset_min: 10, rrule: "FREQ=WEEKLY;BYDAY=TU" }),
        "ko",
      ),
    ).toBe("09:00–10:00 · 10분 전 · 매주 화");
  });

  it("same row in English", () => {
    setLang("en");
    expect(
      formatScheduleSummary(
        row({ start_time: "09:00", end_time: "10:00", remind: true, remind_offset_min: 10, rrule: "FREQ=WEEKLY;BYDAY=TU" }),
        "en",
      ),
    ).toBe("09:00–10:00 · 10 min before · Weekly Tue");
  });

  it("벨 off — 벨도 알림시점도 없이 시각·반복만", () => {
    setLang("ko");
    expect(formatScheduleSummary(row({ start_time: "14:30", rrule: "FREQ=DAILY" }), "ko")).toBe(
      "14:30 · 매일",
    );
  });

  it("정시(offset null)면 알림시점은 빠진다 — 벨이 켜져 있어도", () => {
    setLang("ko");
    expect(formatScheduleSummary(row({ start_time: "14:30", remind: true }), "ko")).toBe("14:30");
  });

  it("시각 없이 반복만, 종료 시각 없이 시작만", () => {
    setLang("en");
    expect(formatScheduleSummary(row({ remind: true, rrule: "FREQ=MONTHLY" }), "en")).toBe("Monthly");
    expect(formatScheduleSummary(row({ start_time: "08:00" }), "en")).toBe("08:00");
  });

  it("아무 일정도 없으면 빈 문자열 — 호출자가 날짜 표기로 되돌아갈 수 있어야 한다", () => {
    setLang("ko");
    expect(formatScheduleSummary(row(), "ko")).toBe("");
    // 벨만 켜진 행도 마찬가지 — 벨 하나만 남은 줄은 카드에서 날짜를 지워버린다.
    expect(formatScheduleSummary(row({ remind: true }), "ko")).toBe("");
  });

  it("scheduleLabels 는 칩용으로 셋을 따로 준다 (offset 은 항상 있다)", () => {
    setLang("ko");
    expect(scheduleLabels(row({ start_time: "09:00", rrule: "FREQ=WEEKLY;BYDAY=MO,FR" }), "ko")).toEqual({
      time: "09:00",
      repeat: "매주 월·금",
      offset: "정시",
    });
  });
});
