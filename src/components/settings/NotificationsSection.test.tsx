import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { NotificationsSection } from "./NotificationsSection";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({
  isBrowser: () => mockBrowser,
}));

// The routine table's own behavior is covered by TimelineRoutineSection.test.tsx — here only
// its presence (desktop) / absence (browser) matters.
vi.mock("./TimelineRoutineSection", () => ({
  TimelineRoutineSection: () => <div data-testid="stub-routines" />,
}));
// 공휴일·기념일 표는 DayMarksSection.test.tsx 가 본다 — 여기선 자리(순서)만.
vi.mock("./DayMarksSection", () => ({
  DayMarksSection: () => <div data-testid="stub-day-marks" />,
}));

describe("NotificationsSection — 달력 및 일정 (오너 QA 2026-09-15 R1·R2·R5, 2026-09-19 재번복)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    callMock.mockResolvedValue({});
    useSettingsStore.setState({
      uiLang: "ko",
      closeToTray: true,
      notificationsEnabled: false,
      reminderAllDayAt: "00:00",
    } as any);
  });

  it("달력 및 일정: 달력 카드 · 공휴일·기념일 표 · 반복 일정 표 순으로 선다 (2026-09-19)", () => {
    const { container } = render(<NotificationsSection />);

    const cards = container.querySelectorAll(".card");
    expect(Array.from(cards).map((c) => c.getAttribute("data-testid"))).toEqual(["settings-calendar-card"]);

    // R1: 표 둘은 박스에 넣지 않는다 — 카드의 형제로.
    const [calendar] = Array.from(cards);
    const dayMarks = screen.getByTestId("stub-day-marks");
    const routines = screen.getByTestId("stub-routines");
    expect(calendar.contains(dayMarks)).toBe(false);
    expect(calendar.contains(routines)).toBe(false);
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(calendar, dayMarks)).toBe(true);
    expect(follows(dayMarks, routines)).toBe(true);
  });

  it("달력 카드가 지역 및 날씨에서 옮겨 왔다 — 주 시작일·공휴일 두 행이 이 카드 안에 있다", () => {
    useSettingsStore.setState({ weekStart: "sunday", holidayRegion: "none" } as any);
    const { container } = render(<NotificationsSection />);
    const calendarCard = container.querySelector("[data-testid='settings-calendar-card']")!;
    expect(calendarCard.contains(screen.getByLabelText("주 시작일"))).toBe(true);
    expect(calendarCard.contains(screen.getByLabelText("공휴일"))).toBe(true);
  });

  it("브라우저 모드에서는 루틴 표(http:false 커맨드)만 빠지고 달력 카드와 표시일 표(읽기 전용)는 남는다", () => {
    mockBrowser = true;
    const { container } = render(<NotificationsSection />);
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    expect(screen.queryByTestId("stub-routines")).toBeNull();
    expect(screen.getByTestId("stub-day-marks")).toBeTruthy();
  });
});
