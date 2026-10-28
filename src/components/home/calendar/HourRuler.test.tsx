import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HourRuler } from "./DayAxis";

describe("HourRuler — 라벨은 시(時)만, 날씨는 시 라벨 아래", () => {
  it("확대해서 30분 눈금이 생겨도 선만 그리고 분 라벨은 없다", () => {
    const { queryByTestId, container } = render(<HourRuler hourRowH={120} endMin={180} />);
    expect(queryByTestId("cal-hour-label-1")).not.toBeNull();
    expect(container.querySelector('[data-testid^="cal-tick-label-"]')).toBeNull();
    // 선은 그대로 — 30분 간격이면 3시간 동안 6줄.
    expect(container.querySelectorAll("div[style*='border-top']").length).toBeGreaterThan(3);
  });

  it("시간별 날씨는 해당 시 눈금에만 붙고, 한 시간이 낮으면 온도 글자는 빠진다", () => {
    const wx = new Map([[1, { code: 0, tempC: 12 }]]);
    const tall = render(<HourRuler hourRowH={80} endMin={180} hourWeather={wx} />);
    expect(tall.getByTestId("cal-hour-wx-1").textContent).toContain("12°");
    expect(tall.queryByTestId("cal-hour-wx-2")).toBeNull();
    tall.unmount();
    const short = render(<HourRuler hourRowH={28} endMin={180} hourWeather={wx} />);
    expect(short.getByTestId("cal-hour-wx-1").textContent).not.toContain("12°");
  });
});
