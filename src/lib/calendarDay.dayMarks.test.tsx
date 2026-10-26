import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const callSilentMock = vi.fn(async (..._args: unknown[]) => ({ marks: [], sources: [], hides: [] }));
vi.mock("./invoke", () => ({
  call: vi.fn(),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  registerFlush: () => () => {},
  flushAll: async () => {},
}));

import { useDayMarkMaps } from "./calendarDay";
import { useSettingsStore } from "../stores/settings";
import { useDayMarksStore } from "../stores/dayMarks";
import type { CalendarMark } from "./commands.gen";

const mark = (over: Partial<CalendarMark>): CalendarMark => ({
  id: "m",
  workspace_id: "w1",
  source_id: null,
  uid: null,
  title: "엄마 생일",
  year: null,
  month: 3,
  day: 15,
  repeat: "yearly",
  lunar: false,
  day_off: false,
  color_hue: null,
  created_at: "",
  updated_at: "",
  ...over,
});

// PLAN-2026-09-19-calendar-schedule §3 — 기본 공휴일 ⊕ 표시일 ⊖ 숨김, 노트북별.
describe("useDayMarkMaps", () => {
  beforeEach(() => {
    callSilentMock.mockClear();
    useSettingsStore.setState({ holidayRegion: "kr", activeWorkspaceId: "w1" });
    useDayMarksStore.setState({
      workspaceId: "w1",
      marks: [mark({}), mark({ id: "off", title: "우리집 휴일", month: 4, day: 2, day_off: true })],
      sources: [],
      hides: [{ source: "builtin", iso_day: "2026-03-01" }],
    });
  });

  it("merges the builtin table, own marks and hides, split into red days and labels", () => {
    const { result } = renderHook(() => useDayMarkMaps([2026]));
    expect(result.current.off.has("2026-03-01")).toBe(false); // 삼일절 숨김
    expect(result.current.off.get("2026-05-05")).toBe("어린이날");
    expect(result.current.off.get("2026-04-02")).toBe("우리집 휴일"); // 빨간 날 표시일
    expect(result.current.labels.get("2026-03-15")).toBe("엄마 생일"); // 이름표만
    expect(result.current.off.has("2026-03-15")).toBe(false);
  });

  it("never shows another notebook's marks and reloads for the active one", () => {
    useSettingsStore.setState({ activeWorkspaceId: "w2" });
    const { result } = renderHook(() => useDayMarkMaps([2026]));
    expect(result.current.labels.size).toBe(0);
    expect(result.current.off.has("2026-03-01")).toBe(true); // 다른 노트북의 숨김도 안 먹는다
    expect(callSilentMock).toHaveBeenCalledWith("calendar_marks_list", { workspace_id: "w2" });
  });
});
