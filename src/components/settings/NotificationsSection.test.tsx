import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

  it("달력 및 일정: 달력 카드 · 공휴일·기념일 표 · 반복 일정 표 · 알림 카드 순으로 선다 (2026-09-19)", () => {
    const { container } = render(<NotificationsSection />);

    const cards = container.querySelectorAll(".card");
    expect(Array.from(cards).map((c) => c.getAttribute("data-testid"))).toEqual([
      "settings-calendar-card",
      "settings-notifications-card",
    ]);

    // R1: 표 둘은 박스에 넣지 않는다 — 두 카드 사이에, 카드의 형제로.
    const [calendar, notifications] = Array.from(cards);
    const dayMarks = screen.getByTestId("stub-day-marks");
    const routines = screen.getByTestId("stub-routines");
    for (const card of [calendar, notifications]) {
      expect(card.contains(dayMarks)).toBe(false);
      expect(card.contains(routines)).toBe(false);
    }
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(calendar, dayMarks)).toBe(true);
    expect(follows(dayMarks, routines)).toBe(true);
    expect(follows(routines, notifications)).toBe(true);
  });

  it("달력 카드가 지역 및 날씨에서 옮겨 왔다 — 주 시작일·공휴일 두 행이 이 카드 안에 있다", () => {
    useSettingsStore.setState({ weekStart: "sunday", holidayRegion: "none" } as any);
    const { container } = render(<NotificationsSection />);
    const calendarCard = container.querySelector("[data-testid='settings-calendar-card']")!;
    expect(calendarCard.contains(screen.getByLabelText("주 시작일"))).toBe(true);
    expect(calendarCard.contains(screen.getByLabelText("공휴일"))).toBe(true);
  });

  it("브라우저 모드에서는 루틴 표(http:false 커맨드)만 빠지고 카드 둘과 표시일 표(읽기 전용)는 남는다", () => {
    mockBrowser = true;
    const { container } = render(<NotificationsSection />);
    expect(container.querySelectorAll(".card")).toHaveLength(2);
    expect(screen.queryByTestId("stub-routines")).toBeNull();
    expect(screen.getByTestId("stub-day-marks")).toBeTruthy();
    expect(screen.getByTestId("settings-switch-notifications")).toBeTruthy();
  });

  // ── 일반 페이지에서 이사 온 알림 행들 (GeneralSection.test 에서 인수) ──
  it("알림 마스터는 기본 OFF 이고 켜면 notifications_enabled 를 저장한다", async () => {
    render(<NotificationsSection />);
    const toggle = screen.getByTestId("settings-switch-notifications");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { notifications_enabled: true } }),
    );
  });

  it("종일 노트 알림 시각은 00:00 에서 시작해 reminder_all_day_at 로 저장된다", async () => {
    render(<NotificationsSection />);
    const input = screen.getByTestId("settings-notifications-all-day-at") as HTMLInputElement;
    expect(input.value).toBe("00:00");

    // fireEvent (not userEvent.type) — native <input type="time"> needs a single onChange with
    // the full value. 저장은 입력마다가 아니라 포커스 이탈(또는 Enter)에서 한 번(TimeField).
    expect(input.getAttribute("aria-label")).toBe("종일 노트 알림 시각");
    fireEvent.change(input, { target: { value: "09:00" } });
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    fireEvent.blur(input);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { reminder_all_day_at: "09:00" } }),
    );
  });

  it("트레이 경고는 close_to_tray 가 꺼지고 알림이 켜졌을 때만, 데스크톱에서만 뜬다", () => {
    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: true });
    });
    const { rerender } = render(<NotificationsSection />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();

    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: false });
    });
    rerender(<NotificationsSection />);
    expect(screen.getByTestId("settings-notifications-needs-tray")).toBeTruthy();

    act(() => {
      useSettingsStore.setState({ notificationsEnabled: false, closeToTray: false });
    });
    rerender(<NotificationsSection />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
  });

  // W2-ⓓ 회귀(GeneralSection 시절): 브라우저에는 트레이도, 원인을 고칠 토글도 없다 — 할 수 있는
  // 일이 없는 경고는 띄우지 않는다.
  it("브라우저 모드에서는 트레이 경고가 뜨지 않는다", () => {
    mockBrowser = true;
    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: false });
    });
    render(<NotificationsSection />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
  });

});
