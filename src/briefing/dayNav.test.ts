import { describe, expect, it } from "vitest";
import {
  createWheelSwipe,
  defaultDraftRange,
  hourlyCells,
  isTypingTarget,
  nudgeDraft,
  rainOnset,
  SWIPE_IDLE_MS,
  SWIPE_WHEEL_THRESHOLD,
  touchSwipeStep,
} from "./dayNav";
import type { HourlyForecast } from "../lib/weather";

describe("createWheelSwipe — 가로 휠 한 번 = 하루", () => {
  const setup = () => {
    let t = 1000;
    const steps: number[] = [];
    const handle = createWheelSwipe((d) => steps.push(d), () => t);
    return { handle, steps, advance: (ms: number) => (t += ms) };
  };

  it("가로 성분이 임계를 넘으면 한 번만 넘기고, 같은 제스처의 나머지는 소비만 한다", () => {
    const { handle, steps, advance } = setup();
    for (let i = 0; i < 10; i++) {
      expect(handle({ deltaX: 30, deltaY: 2 })).toBe(true);
      advance(16);
    }
    expect(steps).toEqual([1]);
  });

  it("휠이 멈췄다가 다시 쓸면 다음 하루로 넘어간다(왼쪽 = 이전 날)", () => {
    const { handle, steps, advance } = setup();
    handle({ deltaX: SWIPE_WHEEL_THRESHOLD, deltaY: 0 });
    advance(SWIPE_IDLE_MS + 1);
    handle({ deltaX: -SWIPE_WHEEL_THRESHOLD, deltaY: 0 });
    expect(steps).toEqual([1, -1]);
  });

  it("세로가 큰 휠(축 스크롤)과 Ctrl/Cmd+휠(축 확대)은 건드리지 않는다", () => {
    const { handle, steps } = setup();
    expect(handle({ deltaX: 40, deltaY: 60 })).toBe(false);
    expect(handle({ deltaX: 200, deltaY: 0, ctrlKey: true })).toBe(false);
    expect(handle({ deltaX: 200, deltaY: 0, metaKey: true })).toBe(false);
    expect(steps).toEqual([]);
  });
});

describe("touchSwipeStep", () => {
  it("빠른 가로 스와이프만 — 왼쪽으로 밀면 다음 날", () => {
    expect(touchSwipeStep(-90, 10, 200)).toBe(1);
    expect(touchSwipeStep(90, -10, 200)).toBe(-1);
  });
  it("짧은 이동·세로 우세·길게 누르기(축 드래그)는 아니다", () => {
    expect(touchSwipeStep(-30, 0, 100)).toBeNull();
    expect(touchSwipeStep(-90, 80, 150)).toBeNull();
    expect(touchSwipeStep(-120, 0, 900)).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("입력칸·편집 영역은 글자 입력이다", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom 은 isContentEditable 을 계산하지 않는다 — 실제 브라우저의 값을 흉내 낸다.
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(div)).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("새 일정 초안", () => {
  it("오늘이면 지금 이후 첫 15분 경계, 다른 날이면 09:00 — 길이 30분", () => {
    expect(defaultDraftRange("2026-10-19", "2026-10-19", 8 * 60 + 7)).toEqual({ startMin: 8 * 60 + 15, endMin: 8 * 60 + 45 });
    expect(defaultDraftRange("2026-10-19", "2026-10-19", 8 * 60)).toEqual({ startMin: 8 * 60 + 15, endMin: 8 * 60 + 45 });
    expect(defaultDraftRange("2026-10-20", "2026-10-19", 23 * 60)).toEqual({ startMin: 9 * 60, endMin: 9 * 60 + 30 });
  });
  it("밤 늦게도 하루 밖으로 나가지 않는다", () => {
    const r = defaultDraftRange("2026-10-19", "2026-10-19", 23 * 60 + 50);
    expect(r.endMin).toBeLessThanOrEqual(24 * 60);
    expect(r.endMin - r.startMin).toBe(30);
  });
  it("↑/↓ 는 길이를 지키며 시작을, Shift 는 끝만 옮긴다", () => {
    const r = { startMin: 600, endMin: 660 };
    expect(nudgeDraft(r, "start", 1)).toEqual({ startMin: 615, endMin: 675 });
    expect(nudgeDraft(r, "start", -1)).toEqual({ startMin: 585, endMin: 645 });
    expect(nudgeDraft(r, "end", 1)).toEqual({ startMin: 600, endMin: 675 });
    expect(nudgeDraft({ startMin: 600, endMin: 630 }, "end", -1)).toEqual({ startMin: 600, endMin: 630 }); // 최소 30분
    expect(nudgeDraft({ startMin: 0, endMin: 30 }, "start", -1)).toEqual({ startMin: 0, endMin: 30 });
  });
});

const hourly = (codes: number[], fromHour = 0): HourlyForecast => ({
  time: codes.map((_, i) => `2026-10-19T${String(fromHour + i).padStart(2, "0")}:00`),
  tempC: codes.map((_, i) => 10 + i),
  weatherCode: codes,
  fetchedAt: 0,
});

describe("머리줄 날씨 조각", () => {
  it("rainOnset — 지금 이후 처음 비가 시작하는 시각", () => {
    expect(rainOnset(hourly([0, 1, 2, 61, 61, 3], 10), 10)).toBe("13:00");
    expect(rainOnset(hourly([0, 1, 2, 3], 10), 10)).toBeNull();
    expect(rainOnset(hourly([61, 61, 0], 10), 10)).toBeNull(); // 지금 이미 오고 있다 — 아이콘이 말한다
    expect(rainOnset(null, 10)).toBeNull();
  });
  it("hourlyCells — 지금부터 3시간 간격", () => {
    const cells = hourlyCells(hourly(Array.from({ length: 24 }, () => 0)), 8);
    expect(cells.map((c) => c.hour)).toEqual([8, 11, 14, 17, 20, 23]);
    expect(hourlyCells(null, 0)).toEqual([]);
  });
});
